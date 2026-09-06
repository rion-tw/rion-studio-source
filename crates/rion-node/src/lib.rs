use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
        mpsc::Receiver,
    },
    thread,
    time::{Duration, Instant},
};

use napi::{Status, bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode};
use napi_derive::napi;
use rion_core::{
    AppCore, AppCoreOptions as CoreOptions, CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES,
    CHROMIUM_RUNTIME_CONTRACT_VERSION, CoreCommand, CoreEffectResult, CoreError, CoreEvent,
};

mod appkit_runtime_host;
mod chrome_profile_import_helper_launcher;
mod updater;
pub mod windows_chromium_input_attachment;
pub mod windows_chromium_input_probe;
pub mod windows_chromium_input_submission;
pub mod windows_runtime_shortcut_owner;

pub use updater::*;

const EVENT_BRIDGE_QUEUE_CAPACITY: usize = 64;
const EVENT_BRIDGE_OPEN: u8 = 0;
const EVENT_BRIDGE_SHUTDOWN: u8 = 1;
const EVENT_BRIDGE_FAILED: u8 = 2;
#[cfg(feature = "desktop-e2e")]
const DESKTOP_E2E_STABLE_RUNTIME_CONTRACT_VERSION: u32 = 22;

#[derive(Default)]
struct EventBridgeTerminalGate {
    state: AtomicU8,
}

impl EventBridgeTerminalGate {
    fn observe_shutdown(&self) {
        let _ = self.state.compare_exchange(
            EVENT_BRIDGE_OPEN,
            EVENT_BRIDGE_SHUTDOWN,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn begin_failure(&self) -> bool {
        self.state
            .compare_exchange(
                EVENT_BRIDGE_OPEN,
                EVENT_BRIDGE_FAILED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn failed(&self) -> bool {
        self.state.load(Ordering::Acquire) == EVENT_BRIDGE_FAILED
    }
}

struct EventBridgeBackpressure {
    completions: Receiver<()>,
    in_flight: usize,
}

impl EventBridgeBackpressure {
    fn new(completions: Receiver<()>) -> Self {
        Self {
            completions,
            in_flight: 0,
        }
    }

    fn has_best_effort_capacity(&mut self) -> bool {
        self.drain_completions();
        self.in_flight < EVENT_BRIDGE_QUEUE_CAPACITY
    }

    fn record_submission(&mut self) {
        self.in_flight = self.in_flight.saturating_add(1);
    }

    fn drain_completions(&mut self) {
        for () in self.completions.try_iter() {
            self.in_flight = self.in_flight.saturating_sub(1);
        }
    }
}

/// Options claimed by the Electron main process when it creates the Rust core.
///
/// The production boundary attests `platform` and `runtimeContractVersion`
/// against the compiled native target before Core touches the data directory.
/// Optional build metadata defaults exactly as it does at the serde boundary in
/// `rion-core`. `startupBackupLabel` lets a shell cutover request the same
/// validated online backup that the current Tauri shell creates before startup.
#[napi(object)]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
    pub build_commit: Option<String>,
    pub packaged: Option<bool>,
    pub runtime_contract_version: Option<u32>,
    pub startup_backup_label: Option<String>,
}

impl AppCoreOptions {
    fn into_attested_core_options(
        self,
        host_platform: rion_platform::Platform,
        runtime_contract_version: u32,
    ) -> rion_core::CoreResult<(CoreOptions, Option<String>)> {
        let claimed_platform = rion_platform::Platform::parse(&self.platform)
            .map_err(|_| host_platform_mismatch_error())?;
        if claimed_platform != host_platform {
            return Err(host_platform_mismatch_error());
        }
        if self.runtime_contract_version != Some(runtime_contract_version) {
            return Err(runtime_contract_mismatch_error());
        }
        Ok((
            CoreOptions {
                user_data_dir: self.user_data_dir,
                platform: canonical_platform_name(host_platform).to_owned(),
                app_version: self.app_version,
                build_commit: self.build_commit,
                packaged: self.packaged.unwrap_or(false),
                runtime_contract_version: Some(runtime_contract_version),
            },
            self.startup_backup_label,
        ))
    }
}

fn canonical_platform_name(platform: rion_platform::Platform) -> &'static str {
    match platform {
        rion_platform::Platform::Macos => "darwin",
        rion_platform::Platform::Windows => "win32",
    }
}

#[cfg(target_os = "macos")]
fn compiled_host_platform() -> rion_core::CoreResult<rion_platform::Platform> {
    Ok(rion_platform::Platform::Macos)
}

#[cfg(windows)]
fn compiled_host_platform() -> rion_core::CoreResult<rion_platform::Platform> {
    Ok(rion_platform::Platform::Windows)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn compiled_host_platform() -> rion_core::CoreResult<rion_platform::Platform> {
    Err(CoreError::Domain {
        code: "CORE_HOST_PLATFORM_UNSUPPORTED",
        message: "The native Core addon supports only compiled macOS and Windows hosts.".to_owned(),
    })
}

fn host_platform_mismatch_error() -> CoreError {
    CoreError::Domain {
        code: "CORE_HOST_PLATFORM_MISMATCH",
        message: "The requested Core platform does not match the compiled native host.".to_owned(),
    }
}

fn runtime_contract_mismatch_error() -> CoreError {
    CoreError::Domain {
        code: "CORE_RUNTIME_CONTRACT_MISMATCH",
        message: "The requested Core runtime contract does not match this native factory."
            .to_owned(),
    }
}

#[napi]
pub struct NativeAppCore {
    inner: Arc<AppCore>,
    helper_processes: Arc<chrome_profile_import_helper_launcher::HelperProcessRegistry>,
}

#[napi(object)]
pub struct ChromeProfileImportHelperProcessResult {
    pub outcome: String,
    pub metadata_bytes: Buffer,
    pub secret_bytes: Buffer,
    pub exit_evidence_sha256: String,
}

#[napi]
impl NativeAppCore {
    /// Dispatches every command away from the JavaScript callback stack. This
    /// also keeps an effect callback from synchronously re-entering AppCore.
    #[napi(js_name = "invoke")]
    pub async fn invoke(&self, command_json: String) -> Result<String> {
        let command = decode_command(&command_json).map_err(to_napi_error)?;
        let core = Arc::clone(&self.inner);
        let value = if command.requires_async_dispatch() {
            core.invoke_async(command).await.map_err(to_napi_error)?
        } else {
            napi::tokio::task::spawn_blocking(move || core.invoke(command))
                .await
                .map_err(join_error)?
                .map_err(to_napi_error)?
        };
        serde_json::to_string(&value).map_err(serialization_error)
    }

    /// Bridges the Core event stream onto the Node event loop. The dedicated
    /// receiver thread only enqueues a threadsafe-function call; it never runs
    /// JavaScript or dispatches an effect result itself. `failure_callback` is
    /// a separate, exactly-once terminal channel: ordinary Core Shutdown never
    /// invokes it, while every unexpected receiver, serialization, callback,
    /// or N-API queue closure attempts one stable failure notification.
    #[napi(js_name = "subscribeCoreEvents")]
    pub fn subscribe_core_events(
        &self,
        callback: Function<'_, (String,), ()>,
        failure_callback: Function<'_, (String,), ()>,
    ) -> Result<()> {
        let receiver = self.inner.subscribe().map_err(to_napi_error)?;
        let threadsafe = callback
            .build_threadsafe_function::<String>()
            .max_queue_size::<EVENT_BRIDGE_QUEUE_CAPACITY>()
            .build_callback(|context| Ok((context.value,)))?;
        let failure_threadsafe = Arc::new(
            failure_callback
                .build_threadsafe_function::<String>()
                .max_queue_size::<1>()
                .build_callback(|context| Ok((context.value,)))?,
        );
        let terminal_gate = Arc::new(EventBridgeTerminalGate::default());
        let report_failure: Arc<dyn Fn(&'static str, &'static str) + Send + Sync> = {
            let terminal_gate = Arc::clone(&terminal_gate);
            let failure_threadsafe = Arc::clone(&failure_threadsafe);
            Arc::new(move |code, message| {
                if !terminal_gate.begin_failure() {
                    return;
                }
                let payload = serde_json::json!({
                    "code": code,
                    "message": message,
                })
                .to_string();
                let status = failure_threadsafe.call(payload, ThreadsafeFunctionCallMode::Blocking);
                if status != Status::Ok && status != Status::Closing {
                    eprintln!(
                        "Rion Studio core event failure callback closed with status {status}"
                    );
                }
            })
        };
        let (completion_sender, completion_receiver) = std::sync::mpsc::channel();

        thread::Builder::new()
            .name("rion-core-node-events".to_owned())
            .spawn(move || {
                let mut backpressure = EventBridgeBackpressure::new(completion_receiver);
                loop {
                    let events = match receiver.recv() {
                        Ok(events) => events,
                        Err(_) => {
                            report_failure(
                                "CORE_EVENT_STREAM_CLOSED",
                                "The authoritative Core event receiver closed before Shutdown.",
                            );
                            break;
                        }
                    };
                    if terminal_gate.failed() {
                        break;
                    }
                    let shutdown = events
                        .iter()
                        .any(|event| matches!(event, CoreEvent::Shutdown));
                    let critical = event_batch_is_critical(&events);
                    let serialized = match serde_json::to_string(&events) {
                        Ok(serialized) => serialized,
                        Err(error) => {
                            // CoreEvent is a closed, serializable contract. If that
                            // invariant fails, dropping more events would conceal it.
                            eprintln!("Rion Studio core event serialization failed: {error}");
                            report_failure(
                                "CORE_EVENT_SERIALIZATION_FAILED",
                                "The authoritative Core event batch could not be serialized.",
                            );
                            break;
                        }
                    };
                    let mode = if critical {
                        ThreadsafeFunctionCallMode::Blocking
                    } else {
                        // N-API does not take ownership of a non-blocking call's
                        // payload when its queue is full. Track JavaScript callback
                        // completion so best-effort events are dropped before that
                        // call, while critical events retain blocking backpressure.
                        if !backpressure.has_best_effort_capacity() {
                            continue;
                        }
                        ThreadsafeFunctionCallMode::NonBlocking
                    };
                    let event_completion_sender = completion_sender.clone();
                    let callback_failure = Arc::clone(&report_failure);
                    match threadsafe.call_with_return_value(
                        serialized,
                        mode,
                        move |callback_result, _env| {
                            if callback_result.is_err() {
                                eprintln!("Rion Studio core event callback failed");
                                callback_failure(
                                    "CORE_EVENT_CALLBACK_FAILED",
                                    "The JavaScript Core event callback failed.",
                                );
                            }
                            let _ = event_completion_sender.send(());
                            Ok(())
                        },
                    ) {
                        Status::Ok => backpressure.record_submission(),
                        Status::Closing => {
                            report_failure(
                                "CORE_EVENT_CALLBACK_CLOSED",
                                "The JavaScript Core event callback closed unexpectedly.",
                            );
                            break;
                        }
                        status => {
                            eprintln!("Rion Studio core event bridge closed with status {status}");
                            report_failure(
                                "CORE_EVENT_BRIDGE_FAILED",
                                "The native Core event bridge rejected an authoritative batch.",
                            );
                            break;
                        }
                    }
                    if shutdown {
                        terminal_gate.observe_shutdown();
                        break;
                    }
                }
            })
            .map_err(|error| {
                to_napi_error(CoreError::Internal(format!(
                    "could not start the Node core event bridge: {error}"
                )))
            })?;
        Ok(())
    }

    /// Returns effect acknowledgements on a blocking worker instead of calling
    /// AppCore from the JavaScript event callback stack.
    #[napi(js_name = "dispatchCoreEffectResults")]
    pub async fn dispatch_core_effect_results(&self, results_json: String) -> Result<String> {
        let results = decode_effect_results(&results_json).map_err(to_napi_error)?;
        let core = Arc::clone(&self.inner);
        let report =
            napi::tokio::task::spawn_blocking(move || core.dispatch_core_effect_results(results))
                .await
                .map_err(join_error)?
                .map_err(to_napi_error)?;
        serde_json::to_string(&report).map_err(serialization_error)
    }

    /// Narrow Electron-main-only target migration boundary. Rust copies all
    /// inventory evidence and revisions from its journal; this input can only
    /// report a canonical target verification or terminal non-success.
    #[napi(js_name = "transitionRoleSessionMigrationTargetInternal")]
    pub async fn transition_role_session_migration_target_internal(
        &self,
        input_json: String,
    ) -> Result<String> {
        let input = decode_role_session_migration_target_transition(&input_json)?;
        let core = Arc::clone(&self.inner);
        let record = napi::tokio::task::spawn_blocking(move || {
            core.transition_role_session_migration_target_internal(input)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&record).map_err(serialization_error)
    }

    /// Rust-owned admission from one exact exported v22 journal into the first
    /// Chromium target revision. This boundary is intentionally unavailable to
    /// generic renderer commands.
    #[napi(js_name = "beginRoleSessionMigrationImportInternal")]
    pub async fn begin_role_session_migration_import_internal(
        &self,
        input_json: String,
    ) -> Result<String> {
        let input = decode_role_session_migration_import_begin(&input_json)?;
        let core = Arc::clone(&self.inner);
        let record = napi::tokio::task::spawn_blocking(move || {
            core.begin_role_session_migration_import_internal(input)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&record).map_err(serialization_error)
    }

    /// Privileged Electron-main-only vault read. Core returns plaintext only
    /// after the encrypted envelope and durable journal evidence match exactly.
    #[napi(js_name = "readRoleSessionTransferVaultInternal")]
    pub async fn read_role_session_transfer_vault_internal(
        &self,
        role_id: String,
        transfer_id: String,
    ) -> Result<Buffer> {
        let core = Arc::clone(&self.inner);
        let bytes = napi::tokio::task::spawn_blocking(move || {
            core.read_role_session_transfer_vault_internal(role_id, transfer_id)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(bytes.into())
    }

    #[napi(js_name = "acquireChromeProfileImportTransactionInternal")]
    pub async fn acquire_chrome_profile_import_transaction_internal(
        &self,
        request_json: String,
    ) -> Result<String> {
        let input = serde_json::from_str::<rion_core::ChromeProfileImportTransactionAcquireInput>(
            &request_json,
        )
        .map_err(|_| invalid_chrome_import_contract_json())?;
        let core = Arc::clone(&self.inner);
        let descriptor = napi::tokio::task::spawn_blocking(move || {
            core.acquire_chrome_profile_import_transaction_internal(input)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&descriptor).map_err(serialization_error)
    }

    #[napi(js_name = "refreshChromeProfileImportTransactionInternal")]
    pub async fn refresh_chrome_profile_import_transaction_internal(
        &self,
        fence_json: String,
    ) -> Result<String> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let descriptor = napi::tokio::task::spawn_blocking(move || {
            core.refresh_chrome_profile_import_transaction_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&descriptor).map_err(serialization_error)
    }

    /// The returned Buffer is bounded plaintext owned by Electron main. Its
    /// caller must overwrite it immediately after parsing/applying it.
    #[napi(js_name = "readChromeProfileImportPayloadInternal")]
    pub async fn read_chrome_profile_import_payload_internal(
        &self,
        fence_json: String,
    ) -> Result<Buffer> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let bytes = napi::tokio::task::spawn_blocking(move || {
            core.read_chrome_profile_import_payload_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(bytes.into())
    }

    #[napi(js_name = "writeChromeProfileImportBackupInternal")]
    pub async fn write_chrome_profile_import_backup_internal(
        &self,
        fence_json: String,
        mut plaintext_bytes: Buffer,
    ) -> Result<String> {
        if plaintext_bytes.is_empty()
            || plaintext_bytes.len() > CHROME_PROFILE_IMPORT_MAX_PLAINTEXT_BYTES
        {
            plaintext_bytes.as_mut().fill(0);
            return Err(chrome_import_payload_limit_error());
        }
        let fence = match decode_chrome_import_fence(&fence_json) {
            Ok(fence) => fence,
            Err(error) => {
                plaintext_bytes.as_mut().fill(0);
                return Err(error);
            }
        };
        let owned_plaintext = plaintext_bytes.to_vec();
        plaintext_bytes.as_mut().fill(0);
        let core = Arc::clone(&self.inner);
        let evidence = napi::tokio::task::spawn_blocking(move || {
            core.write_chrome_profile_import_backup_internal(fence, owned_plaintext)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&evidence).map_err(serialization_error)
    }

    /// The returned Buffer is bounded plaintext owned by Electron main. Its
    /// caller must overwrite it immediately after rollback.
    #[napi(js_name = "readChromeProfileImportBackupInternal")]
    pub async fn read_chrome_profile_import_backup_internal(
        &self,
        fence_json: String,
    ) -> Result<Buffer> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let bytes = napi::tokio::task::spawn_blocking(move || {
            core.read_chrome_profile_import_backup_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(bytes.into())
    }

    /// Returns a one-time 256-bit capability. The caller must transfer it only
    /// over the inherited anonymous verifier pipe and then overwrite it.
    #[napi(js_name = "prepareChromeProfileImportFreshVerificationInternal")]
    pub async fn prepare_chrome_profile_import_fresh_verification_internal(
        &self,
        fence_json: String,
    ) -> Result<Buffer> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let capability = napi::tokio::task::spawn_blocking(move || {
            core.prepare_chrome_profile_import_fresh_verification_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(capability.into())
    }

    #[napi(js_name = "completeChromeProfileImportFreshVerificationInternal")]
    pub async fn complete_chrome_profile_import_fresh_verification_internal(
        &self,
        fence_json: String,
        mut capability_bytes: Buffer,
        receipt_json: String,
    ) -> Result<String> {
        if capability_bytes.len() != 32 {
            capability_bytes.as_mut().fill(0);
            return Err(to_napi_error(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_CAPABILITY_INVALID",
                message: "The fresh-process verification capability is invalid.".to_owned(),
            }));
        }
        let fence = match decode_chrome_import_fence(&fence_json) {
            Ok(fence) => fence,
            Err(error) => {
                capability_bytes.as_mut().fill(0);
                return Err(error);
            }
        };
        let receipt = match serde_json::from_str::<
            rion_core::ChromeProfileImportFreshVerificationReceipt,
        >(&receipt_json)
        {
            Ok(receipt) => receipt,
            Err(_) => {
                capability_bytes.as_mut().fill(0);
                return Err(invalid_chrome_import_contract_json());
            }
        };
        let capability = capability_bytes.to_vec();
        capability_bytes.as_mut().fill(0);
        let core = Arc::clone(&self.inner);
        let descriptor = napi::tokio::task::spawn_blocking(move || {
            core.complete_chrome_profile_import_fresh_verification_internal(
                fence, capability, receipt,
            )
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&descriptor).map_err(serialization_error)
    }

    #[napi(js_name = "commitChromeProfileImportInternal")]
    pub async fn commit_chrome_profile_import_internal(
        &self,
        fence_json: String,
    ) -> Result<String> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let evidence = napi::tokio::task::spawn_blocking(move || {
            core.commit_chrome_profile_import_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&evidence).map_err(serialization_error)
    }

    #[napi(js_name = "verifyChromeProfileImportCommitMarkerInternal")]
    pub async fn verify_chrome_profile_import_commit_marker_internal(
        &self,
        fence_json: String,
    ) -> Result<String> {
        let fence = decode_chrome_import_fence(&fence_json)?;
        let core = Arc::clone(&self.inner);
        let evidence = napi::tokio::task::spawn_blocking(move || {
            core.verify_chrome_profile_import_commit_marker_internal(fence)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&evidence).map_err(serialization_error)
    }

    #[napi(js_name = "releaseChromeProfileImportTransactionInternal")]
    pub async fn release_chrome_profile_import_transaction_internal(
        &self,
        request_json: String,
    ) -> Result<()> {
        let input = serde_json::from_str::<rion_core::ChromeProfileImportTransactionReleaseInput>(
            &request_json,
        )
        .map_err(|_| invalid_chrome_import_contract_json())?;
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || {
            core.release_chrome_profile_import_transaction_internal(input)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)
    }

    /// Recovers every durable Chrome-profile import journal after the local
    /// main-process effect consumer and raw Core event bridge are ready. This
    /// remains a private production bootstrap boundary and is never exposed to
    /// the renderer command contract.
    #[napi(js_name = "recoverPendingChromeProfileImportsInternal")]
    pub async fn recover_pending_chrome_profile_imports_internal(&self) -> Result<String> {
        let core = Arc::clone(&self.inner);
        let result = core
            .recover_pending_chrome_profile_imports()
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(serialization_error)
    }

    /// Starts the packaged fresh Chromium helper with a fixed, non-secret mode
    /// switch. Transaction identity, paths, plaintext inventory, and the
    /// one-time verifier capability travel only through bounded anonymous
    /// stdin/stdout pipes. A result is returned only after the child exited
    /// cleanly and both pipe endpoints reached EOF.
    #[napi(js_name = "launchChromeProfileImportHelperInternal")]
    pub async fn launch_chrome_profile_import_helper_internal(
        &self,
        mut metadata_bytes: Buffer,
        mut secret_bytes: Buffer,
        cancellation_id: Option<String>,
        helper_application_path: Option<String>,
    ) -> Result<ChromeProfileImportHelperProcessResult> {
        let mut metadata = metadata_bytes.to_vec();
        let mut secret = secret_bytes.to_vec();
        metadata_bytes.as_mut().fill(0);
        secret_bytes.as_mut().fill(0);
        let cancellation_id = match cancellation_id {
            Some(cancellation_id)
                if uuid::Uuid::parse_str(&cancellation_id)
                    .is_ok_and(|parsed| parsed.to_string() == cancellation_id) =>
            {
                cancellation_id
            }
            Some(_) => {
                metadata.fill(0);
                secret.fill(0);
                return Err(to_napi_error(CoreError::InvalidInput(
                    "invalid helper cancellation identity".to_owned(),
                )));
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let registration = match self.helper_processes.register(cancellation_id) {
            Ok(registration) => registration,
            Err(error) => {
                metadata.fill(0);
                secret.fill(0);
                return Err(to_napi_error(error));
            }
        };
        let result = napi::tokio::task::spawn_blocking(move || {
            chrome_profile_import_helper_launcher::launch(
                metadata,
                secret,
                registration,
                helper_application_path,
            )
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(ChromeProfileImportHelperProcessResult {
            outcome: result.outcome,
            metadata_bytes: result.metadata.into(),
            secret_bytes: result.secret.into(),
            exit_evidence_sha256: result.exit_evidence_sha256,
        })
    }

    /// Marks one exact helper launch cancelled and terminates its child if it
    /// has already spawned. The launch promise remains the exit/EOF fence.
    #[napi(js_name = "cancelChromeProfileImportHelperInternal")]
    pub fn cancel_chrome_profile_import_helper_internal(
        &self,
        cancellation_id: String,
    ) -> Result<bool> {
        if !uuid::Uuid::parse_str(&cancellation_id)
            .is_ok_and(|parsed| parsed.to_string() == cancellation_id)
        {
            return Err(to_napi_error(CoreError::InvalidInput(
                "invalid helper cancellation identity".to_owned(),
            )));
        }
        self.helper_processes
            .cancel(&cancellation_id)
            .map_err(to_napi_error)
    }

    /// Main-process-only Windows hidden-role held-key continuity admission.
    /// Core owns the exact runtime fence and every BrowserAction deadline; the
    /// renderer/preload cannot invoke this boundary directly.
    #[napi(js_name = "restoreWindowsChromiumHeldKeysInternal")]
    pub async fn restore_windows_chromium_held_keys_internal(
        &self,
        input_json: String,
    ) -> Result<String> {
        let input =
            serde_json::from_str::<rion_core::WindowsChromiumHeldKeyContinuityInput>(&input_json)
                .map_err(|_| {
                to_napi_error(CoreError::InvalidInput(
                    "invalid Windows Chromium held-key continuity JSON".to_owned(),
                ))
            })?;
        let core = Arc::clone(&self.inner);
        let receipt = napi::tokio::task::spawn_blocking(move || {
            core.restore_windows_chromium_held_keys_internal(input)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        serde_json::to_string(&receipt).map_err(serialization_error)
    }

    /// Fatal-owner cleanup lane for a clean restore marker that was already
    /// acknowledged. This remains callable after general command admission is
    /// closed and resolves only after Core durably restores `cleanExit=false`.
    #[napi(js_name = "invalidateRuntimeRestoreSessionCleanExitInternal")]
    pub async fn invalidate_runtime_restore_session_clean_exit_internal(&self) -> Result<()> {
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || {
            core.invalidate_runtime_restore_session_clean_exit_internal()
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)
    }

    /// Synchronously fences new destructive clear commands before JavaScript
    /// starts draining Chromium effects and helpers.
    #[napi(js_name = "beginRoleBrowserDataClearCommandDrain")]
    pub fn begin_role_browser_data_clear_command_drain(&self) -> Result<()> {
        self.inner
            .begin_role_browser_data_clear_command_drain()
            .map_err(to_napi_error)
    }

    /// Waits only up to the caller's remaining external shutdown budget. A
    /// `false` result is indeterminate and must never be converted into clean
    /// process exit by the JavaScript owner.
    #[napi(js_name = "waitForRoleBrowserDataClearCommandDrain")]
    pub async fn wait_for_role_browser_data_clear_command_drain(
        &self,
        timeout_ms: u32,
    ) -> Result<bool> {
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || {
            let deadline = Instant::now() + Duration::from_millis(u64::from(timeout_ms));
            core.wait_for_role_browser_data_clear_command_drain(deadline)
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)
    }

    #[napi(js_name = "shutdown")]
    pub async fn shutdown(&self) -> Result<()> {
        let core = Arc::clone(&self.inner);
        let helper_processes = Arc::clone(&self.helper_processes);
        napi::tokio::task::spawn_blocking(move || {
            helper_processes.cancel_all_and_wait()?;
            core.shutdown_checked()?;
            rion_core::CoreResult::Ok(())
        })
        .await
        .map_err(join_error)?
        .map_err(to_napi_error)?;
        Ok(())
    }
}

#[napi(js_name = "createAppCore")]
pub async fn create_app_core(options: AppCoreOptions) -> Result<NativeAppCore> {
    create_attested_app_core(options, CHROMIUM_RUNTIME_CONTRACT_VERSION).await
}

/// Desktop-E2E-only source fixture for retained v22 role coverage. Production
/// addons never export this boundary, and even this fixture cannot spoof the
/// compiled host platform.
#[cfg(feature = "desktop-e2e")]
#[napi(js_name = "createAppCoreForDesktopE2e")]
pub async fn create_app_core_for_desktop_e2e(options: AppCoreOptions) -> Result<NativeAppCore> {
    create_attested_app_core(options, DESKTOP_E2E_STABLE_RUNTIME_CONTRACT_VERSION).await
}

async fn create_attested_app_core(
    options: AppCoreOptions,
    runtime_contract_version: u32,
) -> Result<NativeAppCore> {
    let host_platform = compiled_host_platform().map_err(to_napi_error)?;
    let (options, startup_backup_label) = options
        .into_attested_core_options(host_platform, runtime_contract_version)
        .map_err(to_napi_error)?;
    let core = napi::tokio::task::spawn_blocking(move || match startup_backup_label {
        Some(label) => AppCore::create_with_startup_backup(options, &label),
        None => AppCore::create(options),
    })
    .await
    .map_err(join_error)?
    .map_err(to_napi_error)?;
    Ok(NativeAppCore {
        inner: Arc::new(core),
        helper_processes: Arc::new(
            chrome_profile_import_helper_launcher::HelperProcessRegistry::default(),
        ),
    })
}

#[napi(js_name = "coreVersion")]
pub fn core_version() -> &'static str {
    rion_core::CORE_VERSION
}

/// Reports whether this addon contains the shared AppKit runtime-tab archive.
/// Windows returns zero because it uses the Electron native host instead.
#[napi(js_name = "appKitRuntimeAbiVersion")]
pub fn appkit_runtime_abi_version() -> u32 {
    rion_appkit::runtime_tabs_abi_version()
}

/// Exposes the current Core-owned browser startup arguments without duplicating
/// their policy in Electron main. The current Core intentionally returns an
/// empty list on macOS; the Chromium contract migration can evolve that policy
/// behind this stable Node boundary.
#[napi(js_name = "additionalBrowserArguments")]
pub fn additional_browser_arguments(
    platform: String,
    current_disable_features: String,
) -> Result<Vec<String>> {
    let platform = rion_platform::Platform::parse(&platform)
        .map_err(|error| to_napi_error(CoreError::Platform(error.to_string())))?;
    Ok(rion_core::additional_browser_arguments(
        platform,
        &current_disable_features,
    ))
}

fn decode_command(command_json: &str) -> rion_core::CoreResult<CoreCommand> {
    serde_json::from_str(command_json)
        .map_err(|error| CoreError::InvalidInput(format!("invalid Core command JSON: {error}")))
}

fn decode_effect_results(results_json: &str) -> rion_core::CoreResult<Vec<CoreEffectResult>> {
    serde_json::from_str(results_json).map_err(|error| {
        CoreError::InvalidInput(format!("invalid Core effect result JSON: {error}"))
    })
}

fn decode_role_session_migration_target_transition(
    value: &str,
) -> Result<rion_core::RoleSessionMigrationTargetTransitionInput> {
    serde_json::from_str(value).map_err(|_| invalid_session_migration_contract_json())
}

fn decode_role_session_migration_import_begin(
    value: &str,
) -> Result<rion_core::RoleSessionMigrationImportBeginInput> {
    serde_json::from_str(value).map_err(|_| invalid_session_migration_contract_json())
}

fn invalid_session_migration_contract_json() -> Error {
    to_napi_error(CoreError::InvalidInput(
        "invalid privileged role session migration contract JSON".to_owned(),
    ))
}

fn decode_chrome_import_fence(
    value: &str,
) -> Result<rion_core::ChromeProfileImportTransactionFence> {
    serde_json::from_str(value).map_err(|_| invalid_chrome_import_contract_json())
}

fn invalid_chrome_import_contract_json() -> Error {
    to_napi_error(CoreError::InvalidInput(
        "invalid privileged Chrome profile import contract JSON".to_owned(),
    ))
}

fn chrome_import_payload_limit_error() -> Error {
    to_napi_error(CoreError::Domain {
        code: "CHROME_PROFILE_IMPORT_PAYLOAD_LIMIT_EXCEEDED",
        message: "The Chrome profile import payload exceeds its bounded native limit.".to_owned(),
    })
}

fn event_batch_is_critical(events: &[CoreEvent]) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Ready { .. }
                | CoreEvent::StateChanged { .. }
                | CoreEvent::CoreEffects { .. }
                | CoreEvent::CoreEffectCancellations { .. }
                | CoreEvent::BrowserStatuses { .. }
                | CoreEvent::BrowserLaunchCompleted { .. }
                | CoreEvent::MacroStatuses { reliable: true, .. }
                | CoreEvent::Shutdown
        )
    })
}

fn serialization_error(error: serde_json::Error) -> Error {
    to_napi_error(CoreError::Internal(format!(
        "could not encode the Node Core response: {error}"
    )))
}

fn join_error(error: tokio::task::JoinError) -> Error {
    to_napi_error(CoreError::Internal(format!(
        "Node Core worker failed: {error}"
    )))
}

fn to_napi_error(error: CoreError) -> Error {
    let payload = serde_json::to_string(&error.payload()).unwrap_or_else(|_| error.to_string());
    Error::new(Status::GenericFailure, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn napi_split_clear_drain_precedes_verified_shutdown() {
        let directory = std::env::temp_dir().join(format!(
            "rion-node-checked-shutdown-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let host = compiled_host_platform().unwrap();
        let core = Arc::new(
            AppCore::create(CoreOptions {
                app_version: "0.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: canonical_platform_name(host).to_owned(),
                runtime_contract_version: Some(CHROMIUM_RUNTIME_CONTRACT_VERSION),
                user_data_dir: directory.to_string_lossy().into_owned(),
            })
            .unwrap(),
        );
        let native = NativeAppCore {
            inner: core,
            helper_processes: Arc::new(
                chrome_profile_import_helper_launcher::HelperProcessRegistry::default(),
            ),
        };

        native
            .begin_role_browser_data_clear_command_drain()
            .unwrap();
        assert!(
            native
                .wait_for_role_browser_data_clear_command_drain(100)
                .await
                .unwrap()
        );
        native.shutdown().await.unwrap();

        drop(native);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(any(target_os = "macos", windows))]
    #[tokio::test]
    async fn napi_fatal_cleanup_replay_after_clean_promise_settles_is_idempotent() {
        let directory = std::env::temp_dir().join(format!(
            "rion-node-restore-invalidation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let host = compiled_host_platform().unwrap();
        let core = Arc::new(
            AppCore::create(CoreOptions {
                app_version: "0.1.0-test".to_owned(),
                build_commit: None,
                packaged: false,
                platform: canonical_platform_name(host).to_owned(),
                runtime_contract_version: Some(CHROMIUM_RUNTIME_CONTRACT_VERSION),
                user_data_dir: directory.to_string_lossy().into_owned(),
            })
            .unwrap(),
        );
        let native = NativeAppCore {
            inner: core,
            helper_processes: Arc::new(
                chrome_profile_import_helper_launcher::HelperProcessRegistry::default(),
            ),
        };

        native
            .invoke(
                serde_json::json!({
                    "type": "runtimeRestoreSessionReplace",
                    "session": {
                        "schemaVersion": 2,
                        "sessionGeneration": 8,
                        "updatedAt": "2026-09-01T00:00:00Z",
                        "cleanExit": true,
                        "lastFocusedWindowId": "window-b",
                        "restoreInProgressWindowIds": ["window-a"],
                        "liveWindowIds": ["window-a", "window-b"],
                        "windows": []
                    }
                })
                .to_string(),
            )
            .await
            .unwrap();
        native
            .invalidate_runtime_restore_session_clean_exit_internal()
            .await
            .unwrap();
        native
            .invalidate_runtime_restore_session_clean_exit_internal()
            .await
            .unwrap();
        let raw = native
            .invoke(serde_json::json!({ "type": "runtimeRestoreSessionGet" }).to_string())
            .await
            .unwrap();
        let session = serde_json::from_str::<rion_core::RuntimeRestoreSessionRecord>(&raw).unwrap();
        assert!(!session.clean_exit);
        assert_eq!(session.session_generation, 9);
        assert_eq!(session.last_focused_window_id.as_deref(), Some("window-b"));
        assert_eq!(session.restore_in_progress_window_ids, vec!["window-a"]);
        assert_eq!(
            session.live_window_ids,
            Some(vec!["window-a".to_owned(), "window-b".to_owned()])
        );
        native.shutdown().await.unwrap();

        drop(native);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn attested_options_preserve_metadata_and_use_rust_owned_runtime_context() {
        let (options, backup_label) = AppCoreOptions {
            user_data_dir: "/tmp/rion-node-options".to_owned(),
            platform: "macos".to_owned(),
            app_version: "1.2.3".to_owned(),
            build_commit: Some("abcdef".to_owned()),
            packaged: None,
            runtime_contract_version: Some(CHROMIUM_RUNTIME_CONTRACT_VERSION),
            startup_backup_label: Some("electron-chromium".to_owned()),
        }
        .into_attested_core_options(
            rion_platform::Platform::Macos,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
        )
        .unwrap();

        assert_eq!(options.build_commit.as_deref(), Some("abcdef"));
        assert!(!options.packaged);
        assert_eq!(options.platform, "darwin");
        assert_eq!(
            options.runtime_contract_version,
            Some(CHROMIUM_RUNTIME_CONTRACT_VERSION)
        );
        assert_eq!(backup_label.as_deref(), Some("electron-chromium"));
    }

    #[test]
    fn attested_options_reject_opposite_hosts_and_nonexact_runtime_contracts() {
        fn options(platform: &str, runtime_contract_version: Option<u32>) -> AppCoreOptions {
            AppCoreOptions {
                user_data_dir: "/tmp/rion-node-attestation".to_owned(),
                platform: platform.to_owned(),
                app_version: "1.2.3".to_owned(),
                build_commit: None,
                packaged: None,
                runtime_contract_version,
                startup_backup_label: None,
            }
        }

        for (host, claimed) in [
            (rion_platform::Platform::Macos, "win32"),
            (rion_platform::Platform::Windows, "darwin"),
            (rion_platform::Platform::Macos, "unsupported"),
        ] {
            assert_eq!(
                options(claimed, Some(CHROMIUM_RUNTIME_CONTRACT_VERSION))
                    .into_attested_core_options(host, CHROMIUM_RUNTIME_CONTRACT_VERSION)
                    .unwrap_err()
                    .code(),
                "CORE_HOST_PLATFORM_MISMATCH"
            );
        }

        for claimed in [None, Some(22), Some(24)] {
            assert_eq!(
                options("darwin", claimed)
                    .into_attested_core_options(
                        rion_platform::Platform::Macos,
                        CHROMIUM_RUNTIME_CONTRACT_VERSION,
                    )
                    .unwrap_err()
                    .code(),
                "CORE_RUNTIME_CONTRACT_MISMATCH"
            );
        }
    }

    #[test]
    fn malformed_json_is_a_structured_core_input_error() {
        let error = decode_command("{not-json").unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");

        let error = decode_effect_results("{}").unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");
    }

    #[test]
    fn migration_import_admission_rejects_caller_owned_runtime_context() {
        let admission = serde_json::json!({
            "roleId": "11111111-1111-4111-8111-111111111111",
            "transferId": "22222222-2222-4222-8222-222222222222",
            "expectedJournalRevision": 1
        });
        assert!(decode_role_session_migration_import_begin(&admission.to_string()).is_ok());

        for (field, value) in [
            ("platform", serde_json::json!("darwin")),
            ("runtimeContractVersion", serde_json::json!(23)),
        ] {
            let mut injected = admission.clone();
            injected
                .as_object_mut()
                .unwrap()
                .insert(field.to_owned(), value);

            let error =
                decode_role_session_migration_import_begin(&injected.to_string()).unwrap_err();
            let payload: serde_json::Value = serde_json::from_str(&error.reason).unwrap();
            assert_eq!(payload["code"], "CORE_INPUT_INVALID", "{field}");
        }
    }

    #[test]
    fn migration_mutation_is_privileged_and_absent_from_generic_invoke() {
        let transition = rion_core::RoleSessionMigrationTargetTransitionInput {
            role_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            transfer_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            transition_id: "33333333-3333-4333-8333-333333333333".to_owned(),
            expected_phase: rion_core::RoleSessionMigrationPhase::Importing,
            expected_journal_revision: 4,
            next_phase: rion_core::RoleSessionMigrationPhase::Verifying,
            stable_error_code: None,
            outcome: None,
            clean_flush_receipt_id: Some(
                "chromium-cookie-flush:22222222-2222-4222-8222-222222222222:5".to_owned(),
            ),
            occurred_at: "2026-08-30T00:00:00Z".to_owned(),
        };
        let input_json = serde_json::to_string(&transition).unwrap();
        assert!(decode_role_session_migration_target_transition(&input_json).is_ok());
        let mut injected = serde_json::to_value(&transition).unwrap();
        injected
            .as_object_mut()
            .unwrap()
            .insert("targetRevision".to_owned(), serde_json::json!(5));
        assert!(decode_role_session_migration_target_transition(&injected.to_string()).is_err());
        assert!(
            decode_command(
                &serde_json::json!({
                    "type": "roleSessionMigrationTransition",
                    "input": transition
                })
                .to_string()
            )
            .is_err()
        );
    }

    #[test]
    fn generic_napi_invoke_decodes_global_web_profile_resolve_and_clear_commands() {
        let command = decode_command(r#"{"type":"globalWebProfilePathsResolve"}"#).unwrap();
        assert!(matches!(
            &command,
            CoreCommand::GlobalWebProfilePathsResolve
        ));
        assert!(!command.requires_async_dispatch());

        let clear = decode_command(r#"{"type":"globalWebProfileClear"}"#).unwrap();
        assert!(matches!(&clear, CoreCommand::GlobalWebProfileClear));
        assert!(clear.requires_async_dispatch());
    }

    #[test]
    fn authoritative_event_batches_are_never_best_effort() {
        assert!(event_batch_is_critical(&[CoreEvent::Ready {
            schema_version: 1,
        }]));
        assert!(event_batch_is_critical(&[CoreEvent::StateChanged {
            revision: 1,
            changed_collections: Vec::new(),
        }]));
        assert!(event_batch_is_critical(&[CoreEvent::BrowserStatuses {
            statuses: Vec::new(),
        }]));
        assert!(event_batch_is_critical(&[CoreEvent::CoreEffects {
            effects: Vec::new(),
        }]));
        let cancellation_event = CoreEvent::CoreEffectCancellations {
            cancellations: vec![rion_core::CoreEffectCancellationRecord {
                effect_id: "effect-1".to_owned(),
                operation_id: "operation-1".to_owned(),
                reason: rion_core::CoreEffectCancellationReason::OperationCancelled,
            }],
        };
        assert_eq!(
            serde_json::to_value(&cancellation_event).unwrap(),
            serde_json::json!({
                "type": "coreEffectCancellations",
                "cancellations": [{
                    "effectId": "effect-1",
                    "operationId": "operation-1",
                    "reason": "operationCancelled"
                }]
            })
        );
        assert_eq!(
            serde_json::to_value(rion_core::CoreEffectCancellationReason::ActorStopped).unwrap(),
            serde_json::json!("actorStopped")
        );
        assert_eq!(
            serde_json::to_value(rion_core::CoreEffectCancellationReason::DeadlineElapsed).unwrap(),
            serde_json::json!("deadlineElapsed")
        );
        assert!(event_batch_is_critical(&[cancellation_event]));
        assert!(event_batch_is_critical(&[
            CoreEvent::BrowserLaunchCompleted {
                operation_id: "operation-1".to_owned(),
                source_id: "role-1".to_owned(),
                source_type: "role".to_owned(),
                tab_id: "tab-1".to_owned(),
                ok: true,
                error_code: None,
            }
        ]));
        assert!(event_batch_is_critical(&[CoreEvent::MacroStatuses {
            reliable: true,
            statuses: Vec::new(),
        }]));
        assert!(event_batch_is_critical(&[CoreEvent::Shutdown]));
        assert!(!event_batch_is_critical(&[CoreEvent::LogsChanged]));
        assert!(!event_batch_is_critical(&[CoreEvent::MacroStatuses {
            reliable: false,
            statuses: Vec::new(),
        }]));
    }

    #[test]
    fn event_bridge_terminal_gate_reports_one_failure_and_suppresses_normal_shutdown() {
        let failed = EventBridgeTerminalGate::default();
        assert!(failed.begin_failure());
        assert!(failed.failed());
        assert!(!failed.begin_failure());
        failed.observe_shutdown();
        assert!(failed.failed());

        let shutdown = EventBridgeTerminalGate::default();
        shutdown.observe_shutdown();
        assert!(!shutdown.failed());
        assert!(!shutdown.begin_failure());
        shutdown.observe_shutdown();
        assert!(!shutdown.failed());
    }

    #[test]
    fn best_effort_admission_is_bounded_by_completed_javascript_callbacks() {
        let (completion_sender, completion_receiver) = std::sync::mpsc::channel();
        let mut backpressure = EventBridgeBackpressure::new(completion_receiver);

        for _ in 0..EVENT_BRIDGE_QUEUE_CAPACITY {
            assert!(backpressure.has_best_effort_capacity());
            backpressure.record_submission();
        }
        assert!(!backpressure.has_best_effort_capacity());

        completion_sender.send(()).unwrap();
        assert!(backpressure.has_best_effort_capacity());
        backpressure.record_submission();
        assert!(!backpressure.has_best_effort_capacity());
    }

    #[test]
    fn bootstrap_arguments_remain_owned_by_rion_core() {
        let windows =
            additional_browser_arguments("win32".to_owned(), "ExistingDisabled".to_owned())
                .unwrap();
        assert!(
            windows
                .iter()
                .any(|argument| argument.contains("ExistingDisabled"))
        );
        assert!(
            additional_browser_arguments("darwin".to_owned(), String::new())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn exported_core_version_tracks_the_linked_core() {
        assert_eq!(core_version(), rion_core::CORE_VERSION);
    }
}
