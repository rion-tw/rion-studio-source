use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::ErrorKind,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded, unbounded};
use fs2::FileExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    database::{
        DatabasePaths, LogDatabaseWorker, OperationJournalRecord, SCHEMA_VERSION,
        StateDatabaseWorker, StateMutation, bootstrap_databases, preflight_supported_data,
    },
    domain::{
        default_runtime_restore_session, normalize_game_browser_settings, normalize_macro_settings,
        normalize_runtime_restore_session, validate_game_browser_settings,
        validate_legal_acceptance, validate_macro_settings,
    },
    error::{CoreError, CoreResult},
    layout,
    macro_runtime::{MacroRuntime, ManagedShortcutPhaseDispatch},
    model::{
        AppCoreOptions, AppKitRuntimeHostIdentityRecord, ApplicationDiagnosticsSnapshotRecord,
        BrowserActionResult, BrowserOperationRequest, BrowserRuntimeCommand,
        BrowserRuntimeFailureReason, BrowserRuntimeRegistrationRecord,
        ChromeProfileImportAuthStateRecord, ChromeProfileImportItemResultRecord,
        ChromeProfileImportProgressRecord, ChromeProfileImportResolutionRecord,
        ChromeProfileImportResultRecord, ChromeProfileImportUnsupportedCountsRecord, CoreCommand,
        CoreEffectAction, CoreEffectDispatchReport, CoreEffectResult, CoreEffectTarget,
        CoreEffectTargetKind, CoreEvent, CoreStateSnapshotRecord, DiagnosticExportResultRecord,
        EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
        EmbeddedRoleSlotEffectRecord, EmbeddedRoleViewEffectRecord, EmbeddedTabEffectRecord,
        GameBrowserSettingsPatchRecord, GameBrowserSettingsRecord, GameWindowRoleSlotRecord,
        GameWindowRuntimeSnapshotBatchCommitInputRecord,
        GameWindowRuntimeSnapshotCommitInputRecord, GameWindowSaveRuntimeInputRecord,
        GameWindowUpdateInputRecord, LegalAcceptanceRecord, LogCaptureRecord, LogLevel,
        MacroInputDiagnosticsRecord, MacroInputEpochRecord, MacroOverlayRequestRecord,
        MacroOverlayStartSummaryRecord, MacroOverlayViewModelRecord, MacroPressRequest,
        MacroReleaseRequest, MacroSettingsRecord, MacroStartRequest, OperationCancelResultRecord,
        RolePathsRecord, RuntimeRestoreSessionRecord, RuntimeRoleSlotInputRecord,
        RuntimeWindowPersistenceBatchReceiptRecord, RuntimeWindowPersistenceReceiptRecord,
        RuntimeWindowPreferencesRecord, RuntimeWindowStopRequestRecord, StateCollection,
        StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord, StateMacroRecord,
        StateNormalizedRectRecord, StateRoleRecord, SystemWebViewRuntimeRegistrationRecord,
    },
    scheduler::MonotonicScheduler,
};

const EVENT_QUEUE_CAPACITY: usize = 64;
const LAUNCH_COMPLETION_QUEUE_CAPACITY: usize = 64;
const LAUNCH_COMPLETION_CONCURRENCY: usize = 4;
const INSTANCE_LOCK_FILE_NAME: &str = "rion-studio.instance.lock";
const STABLE_SYSTEM_WEBVIEW_RUNTIME_CONTRACT_VERSION: u32 = 22;
pub const CHROMIUM_RUNTIME_CONTRACT_VERSION: u32 = 23;
// Native System WebView session effects may spend up to 40 seconds waiting for
// one navigation. Keep the core deadline above that bound so the shell can
// close its hidden surface and return an authoritative result.
const CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT: Duration = Duration::from_secs(60);
// A persistent login cookie can be committed before a newly-created native
// WebView has rehydrated it into the site's active session. Give the post-apply
// verifier a short, bounded stabilization window before requiring login.
const CHROME_PROFILE_IMPORT_AUTH_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_millis(250), Duration::from_millis(750)];

fn acquire_instance_lock(user_data_dir: &std::path::Path) -> CoreResult<File> {
    fs::create_dir_all(user_data_dir).map_err(|error| {
        CoreError::StateDatabase(format!(
            "could not create the user data directory before locking: {error}"
        ))
    })?;
    let lock_path = user_data_dir.join(INSTANCE_LOCK_FILE_NAME);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            CoreError::StateDatabase(format!(
                "could not open the application instance lock {}: {error}",
                lock_path.display()
            ))
        })?;
    file.try_lock_exclusive().map_err(|error| {
        // fs2 exposes the platform-specific contention error so callers do not
        // have to guess how each native file-lock API maps its OS status into
        // std::io::ErrorKind (Windows LockFileEx is not stable across toolchains).
        if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
            || error.kind() == ErrorKind::WouldBlock
        {
            CoreError::Domain {
                code: "APP_INSTANCE_LOCKED",
                message: "Rion Studio data is already in use by another application shell."
                    .to_owned(),
            }
        } else {
            CoreError::StateDatabase(format!(
                "could not lock the application data directory {}: {error}",
                lock_path.display()
            ))
        }
    })?;
    Ok(file)
}

struct Runtime {
    state: StateDatabaseWorker,
    logs: LogDatabaseWorker,
    scheduler: MonotonicScheduler,
}

#[derive(Clone)]
pub struct BrowserLaunchCompletionRecord {
    pub accepted_at: Instant,
    pub error: Option<crate::error::CoreErrorPayload>,
    pub launch_preview_id: Option<String>,
    pub operation_id: String,
    pub source_id: String,
    pub tab_id: String,
    pub tab_type: String,
    pub target: EmbeddedLaunchTargetRecord,
    pub title: String,
    pub window_id: String,
    pub zoom_factor: Option<f64>,
}

type BrowserLaunchCompletionSink = Arc<dyn Fn(BrowserLaunchCompletionRecord) + Send + Sync>;

type LaunchCompletionFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

struct LaunchCompletionCoordinator {
    sender: tokio::sync::mpsc::Sender<LaunchCompletionFuture>,
    shutdown_sender: tokio::sync::watch::Sender<bool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl LaunchCompletionCoordinator {
    fn start() -> CoreResult<Self> {
        let (sender, mut receiver) =
            tokio::sync::mpsc::channel::<LaunchCompletionFuture>(LAUNCH_COMPLETION_QUEUE_CAPACITY);
        let (shutdown_sender, mut shutdown_receiver) = tokio::sync::watch::channel(false);
        let worker = thread::Builder::new()
            .name("rion-launch-completion".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("Could not start launch completion runtime: {error}");
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut active = tokio::task::JoinSet::new();
                    loop {
                        tokio::select! {
                            changed = shutdown_receiver.changed() => {
                                if changed.is_err() || *shutdown_receiver.borrow() {
                                    active.abort_all();
                                    while active.join_next().await.is_some() {}
                                    break;
                                }
                            }
                            task = receiver.recv(), if active.len() < LAUNCH_COMPLETION_CONCURRENCY => {
                                match task {
                                    Some(task) => {
                                        active.spawn(task);
                                    }
                                    None => {
                                        while active.join_next().await.is_some() {}
                                        break;
                                    }
                                }
                            }
                            result = active.join_next(), if !active.is_empty() => {
                                if let Some(Err(error)) = result {
                                    eprintln!("Background launch completion task failed: {error}");
                                }
                            }
                        }
                    }
                });
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(Self {
            sender,
            shutdown_sender,
            worker: Mutex::new(Some(worker)),
        })
    }

    fn try_reserve(&self) -> CoreResult<tokio::sync::mpsc::OwnedPermit<LaunchCompletionFuture>> {
        self.sender.clone().try_reserve_owned().map_err(|error| {
            let message = match error {
                tokio::sync::mpsc::error::TrySendError::Full(_) => {
                    "The background launch completion queue is full."
                }
                tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                    "The background launch completion coordinator is unavailable."
                }
            };
            CoreError::Domain {
                code: "LAUNCH_COMPLETION_UNAVAILABLE",
                message: message.to_owned(),
            }
        })
    }

    fn shutdown(&self) {
        let _ = self.shutdown_sender.send(true);
        if let Ok(mut worker) = self.worker.lock()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

struct BrowserOperationGuard<'a> {
    coordinator: &'a crate::browser_operations::BrowserOperationCoordinator,
    lease_id: String,
    finished: bool,
}

struct ChromeImportRollbackContext {
    operation_id: String,
    transaction_id: String,
    role_id: String,
    launch_url: String,
    replace_existing: bool,
    webview2_user_data_dir: String,
    chromium_user_data_dir: String,
    webkit_data_store_identifier: String,
    v23_chromium: bool,
    staging: PathBuf,
}

struct PendingEmbeddedRoleLaunch {
    handle: crate::operation_actor::OperationHandle,
    lease_id: String,
    presentation_intent: EmbeddedLaunchPresentationIntent,
    role: StateRoleRecord,
    tab_id: String,
    target: EmbeddedLaunchTargetRecord,
    window_id: String,
}

struct PendingEmbeddedWorkspaceLaunch {
    handle: crate::operation_actor::OperationHandle,
    lease_id: String,
    presentation_intent: EmbeddedLaunchPresentationIntent,
    role_ids: Vec<String>,
    roles: Vec<StateRoleRecord>,
    tab_id: String,
    target: EmbeddedLaunchTargetRecord,
    title: String,
    window_id: String,
    workspace_id: String,
}

enum EmbeddedRoleLaunchStart {
    Completed(Vec<EmbeddedLaunchResultRecord>),
    Pending(Box<PendingEmbeddedRoleLaunch>),
}

enum EmbeddedWorkspaceLaunchStart {
    Completed(Vec<EmbeddedLaunchResultRecord>),
    Pending(Box<PendingEmbeddedWorkspaceLaunch>),
}

#[derive(Clone, Copy)]
struct ChromeImportAuthProbe {
    verification_url: &'static str,
    authenticated_path: &'static str,
    login_path: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChromeImportAuthProbeResult {
    auth_state: ChromeProfileImportAuthStateRecord,
}

impl<'a> BrowserOperationGuard<'a> {
    fn new(
        coordinator: &'a crate::browser_operations::BrowserOperationCoordinator,
        lease_id: String,
    ) -> Self {
        Self {
            coordinator,
            lease_id,
            finished: false,
        }
    }

    fn complete(mut self) -> CoreResult<()> {
        self.coordinator.complete(&self.lease_id)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for BrowserOperationGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.coordinator.abort(&self.lease_id);
        }
    }
}

pub struct AppCore {
    app_version: String,
    app_snapshot_sequence: AtomicU64,
    appkit_event_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    appkit_event_sequences: Mutex<std::collections::HashMap<AppKitRuntimeHostIdentityRecord, u64>>,
    appkit_window_visibility_replay:
        crate::runtime_window_visibility_replay::RuntimeWindowVisibilityReplay<
            crate::model::AppKitRuntimeEventReceiptRecord,
        >,
    runtime_authority_barrier: Arc<RwLock<()>>,
    browser_action_effects: crate::browser_action_effects::BrowserActionEffectRuntime,
    browser_launch_completion_sink: RwLock<Option<BrowserLaunchCompletionSink>>,
    browser_operations: crate::browser_operations::BrowserOperationCoordinator,
    browser_runtime: Arc<crate::runtime_kernel::RuntimeKernel>,
    browser_status_emit_guard: Mutex<()>,
    chrome_profile_import: Mutex<crate::chrome_profile_import::ChromeProfileImportRuntime>,
    chrome_profile_import_contract:
        Mutex<crate::chrome_profile_import_contract::ChromeProfileImportContractRuntime>,
    database_paths: DatabasePaths,
    embedded_input: Mutex<crate::embedded_input::EmbeddedInputRuntime>,
    browser_runtime_issues: RwLock<std::collections::HashMap<String, BrowserRuntimeFailureReason>>,
    browser_runtime_ready_roles: RwLock<std::collections::HashSet<String>>,
    embedded_closing_tabs: Mutex<std::collections::HashSet<String>>,
    embedded_operations: Mutex<std::collections::HashMap<String, String>>,
    runtime_window_persistence_revisions: Mutex<std::collections::HashMap<String, (u64, u64)>>,
    runtime_ui_action_receipts: Mutex<RuntimeUiActionReceiptLedger>,
    runtime_ui_window_visibility_replay:
        crate::runtime_window_visibility_replay::RuntimeWindowVisibilityReplay<
            crate::model::SystemRuntimeOperationSummaryRecord,
        >,
    runtime_window_zoom_receipts: Mutex<RuntimeWindowZoomReceiptLedger>,
    controlled_role_reload_admission: Mutex<()>,
    controlled_role_reloads: ControlledRoleReloadCoordinator,
    application_lifecycle_epoch: AtomicU64,
    application_suspended: AtomicBool,
    #[cfg(test)]
    controlled_role_reload_fault_stage: Mutex<Option<String>>,
    #[cfg(test)]
    controlled_role_reload_mutation_admitted_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    controlled_role_reload_after_prepare_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    controlled_role_reload_after_final_admission_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    controlled_role_reload_before_final_admission_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    workspace_divider_runtime: Mutex<WorkspaceDividerRuntime>,
    runtime_window_provision_receipts: Mutex<RuntimeWindowProvisionReceiptLedger>,
    instance_lock: Mutex<Option<File>>,
    #[cfg(test)]
    retain_failed_shutdown_instance_lock_for_test: AtomicBool,
    macro_runtime: Arc<MacroRuntime>,
    macro_input_recovery_guard: Mutex<()>,
    managed_shortcut_runtime: Mutex<ManagedShortcutRuntime>,
    #[cfg(test)]
    macro_input_recovery_after_resume_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    system_surface_failure_after_owner_fence_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    log_capture: Mutex<crate::log_capture::LogCaptureRuntime>,
    launch_completion: LaunchCompletionCoordinator,
    operation_actor: Arc<crate::operation_actor::OperationActor>,
    overlay_language: Mutex<Option<String>>,
    overlay_refresh: crate::overlay::OverlayRefreshRuntime,
    resolved_theme: Mutex<String>,
    platform: rion_platform::Platform,
    runtime_contract_version: u32,
    portable: Mutex<crate::portable::PortableRuntime>,
    popup_lifecycle: Mutex<crate::popup_lifecycle::ChromiumPopupLifecycleRuntime>,
    role_browser_data_clear_commands: Arc<RoleBrowserDataClearCommandCoordinator>,
    #[cfg(test)]
    role_browser_data_clear_before_domain_terminal_hook:
        Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    runtime: RwLock<Option<Runtime>>,
    runtime_restore_session_mutations: RuntimeRestoreSessionMutationCoordinator,
    shutdown_started: AtomicBool,
    embedded_runtime_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    embedded_window_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    event_sender: Sender<Vec<CoreEvent>>,
    state_mutation_guard: Mutex<()>,
    session_transfer_vault_guard: Mutex<()>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<CoreEvent>>>>>,
    system_fonts: Mutex<Option<Vec<crate::model::SystemFontFamilyRecord>>>,
    browser_runtime_registration: RwLock<BrowserRuntimeRegistrationRecord>,
    user_data_dir: PathBuf,
}

impl AppCore {
    pub fn create(options: AppCoreOptions) -> CoreResult<Self> {
        Self::create_internal(options, None)
    }

    pub fn create_with_startup_backup(
        options: AppCoreOptions,
        backup_label: &str,
    ) -> CoreResult<Self> {
        Self::create_internal(options, Some(backup_label))
    }

    fn create_internal(options: AppCoreOptions, backup_label: Option<&str>) -> CoreResult<Self> {
        let user_data_dir = PathBuf::from(options.user_data_dir.trim());
        if options.user_data_dir.trim().is_empty() || !user_data_dir.is_absolute() {
            return Err(CoreError::InvalidInput(
                "userDataDir must be an absolute path".to_owned(),
            ));
        }
        let platform = rion_platform::Platform::parse(&options.platform)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        let runtime_contract_version = options
            .runtime_contract_version
            .unwrap_or(STABLE_SYSTEM_WEBVIEW_RUNTIME_CONTRACT_VERSION);
        preflight_supported_data(&user_data_dir)?;
        let instance_lock = acquire_instance_lock(&user_data_dir)?;
        if let Some(backup_label) = backup_label {
            crate::database::create_online_startup_backup(
                &user_data_dir,
                backup_label,
                &options.app_version,
            )?;
        }
        let database_paths = bootstrap_databases(&user_data_dir)?;
        let state = StateDatabaseWorker::start(database_paths.state.clone())?;
        state.recover_portable_import(user_data_dir.clone())?;
        recover_operation_journals(&state, &user_data_dir)?;
        let retired_local_storage_replay_warnings =
            crate::role_browser_data::retire_local_storage_replay_artifacts(&user_data_dir);
        let log_level = state
            .read_scalar("logLevel".to_owned())?
            .and_then(|value| serde_json::from_value::<LogLevel>(value).ok())
            .unwrap_or(LogLevel::Debug);
        let logs = LogDatabaseWorker::start(database_paths.logs.clone())?;
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        let event_sender = start_event_dispatcher(Arc::clone(&subscribers))?;
        let effect_event_sender = event_sender.clone();
        let effect_cancellation_event_sender = event_sender.clone();
        let operation_actor = Arc::new(
            crate::operation_actor::OperationActor::new_with_cancellation_emitter(
                Arc::new(move |effects| {
                    publish_events(
                        &effect_event_sender,
                        vec![CoreEvent::CoreEffects { effects }],
                    );
                }),
                Arc::new(move |cancellations| {
                    publish_events(
                        &effect_cancellation_event_sender,
                        vec![CoreEvent::CoreEffectCancellations { cancellations }],
                    );
                }),
            ),
        );
        let scheduler = MonotonicScheduler::start()?;
        let launch_completion = LaunchCompletionCoordinator::start()?;
        let (browser_action_sender, browser_action_receiver) =
            crate::browser_action_effects::action_queue();
        let macro_event_sender = event_sender.clone();
        let macro_browser_action_sender = browser_action_sender.clone();
        let macro_runtime = Arc::new(MacroRuntime::new(Arc::new(move |events| {
            route_browser_action_events(events, &macro_browser_action_sender, &macro_event_sender);
        })));
        let browser_runtime = Arc::new(crate::runtime_kernel::RuntimeKernel::default());
        let browser_action_event_sender = event_sender.clone();
        let browser_action_effects =
            crate::browser_action_effects::BrowserActionEffectRuntime::start(
                browser_action_receiver,
                Arc::new(move |events| publish_events(&browser_action_event_sender, events)),
            )?;
        let (overlay_event_sender, overlay_event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        subscribers
            .lock()
            .map_err(|_| CoreError::Internal("subscriber lock poisoned".to_owned()))?
            .push(overlay_event_sender);
        let overlay_event_dispatcher = event_sender.clone();
        let overlay_refresh = crate::overlay::OverlayRefreshRuntime::start(
            overlay_event_receiver,
            Arc::new(move |events| publish_events(&overlay_event_dispatcher, events)),
        )?;
        let log_session_metadata = crate::log_capture::LogSessionMetadata {
            application_version: Some(options.app_version.clone()),
            build_commit: options.build_commit.clone(),
            packaged: Some(options.packaged),
            runtime_contract_version: options.runtime_contract_version,
        };
        let core = Self {
            app_version: options.app_version,
            app_snapshot_sequence: AtomicU64::new(0),
            appkit_event_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            appkit_event_sequences: Mutex::new(std::collections::HashMap::new()),
            appkit_window_visibility_replay:
                crate::runtime_window_visibility_replay::RuntimeWindowVisibilityReplay::default(),
            runtime_authority_barrier: Arc::new(RwLock::new(())),
            browser_action_effects,
            browser_launch_completion_sink: RwLock::new(None),
            browser_operations: crate::browser_operations::BrowserOperationCoordinator::default(),
            browser_runtime,
            browser_status_emit_guard: Mutex::new(()),
            chrome_profile_import: Mutex::new(
                crate::chrome_profile_import::ChromeProfileImportRuntime::default(),
            ),
            chrome_profile_import_contract: Mutex::new(
                crate::chrome_profile_import_contract::ChromeProfileImportContractRuntime::default(
                ),
            ),
            database_paths,
            embedded_input: Mutex::new(crate::embedded_input::EmbeddedInputRuntime::default()),
            browser_runtime_issues: RwLock::new(std::collections::HashMap::new()),
            browser_runtime_ready_roles: RwLock::new(std::collections::HashSet::new()),
            embedded_closing_tabs: Mutex::new(std::collections::HashSet::new()),
            embedded_operations: Mutex::new(std::collections::HashMap::new()),
            runtime_window_persistence_revisions: Mutex::new(std::collections::HashMap::new()),
            runtime_ui_action_receipts: Mutex::new(RuntimeUiActionReceiptLedger::default()),
            runtime_ui_window_visibility_replay:
                crate::runtime_window_visibility_replay::RuntimeWindowVisibilityReplay::default(),
            runtime_window_zoom_receipts: Mutex::new(RuntimeWindowZoomReceiptLedger::default()),
            controlled_role_reload_admission: Mutex::new(()),
            controlled_role_reloads: ControlledRoleReloadCoordinator::default(),
            application_lifecycle_epoch: AtomicU64::new(1),
            application_suspended: AtomicBool::new(false),
            #[cfg(test)]
            controlled_role_reload_fault_stage: Mutex::new(None),
            #[cfg(test)]
            controlled_role_reload_mutation_admitted_hook: Mutex::new(None),
            #[cfg(test)]
            controlled_role_reload_after_prepare_hook: Mutex::new(None),
            #[cfg(test)]
            controlled_role_reload_after_final_admission_hook: Mutex::new(None),
            #[cfg(test)]
            controlled_role_reload_before_final_admission_hook: Mutex::new(None),
            workspace_divider_runtime: Mutex::new(WorkspaceDividerRuntime::default()),
            runtime_window_provision_receipts: Mutex::new(
                RuntimeWindowProvisionReceiptLedger::default(),
            ),
            instance_lock: Mutex::new(Some(instance_lock)),
            #[cfg(test)]
            retain_failed_shutdown_instance_lock_for_test: AtomicBool::new(false),
            macro_input_recovery_guard: Mutex::new(()),
            managed_shortcut_runtime: Mutex::new(ManagedShortcutRuntime::default()),
            #[cfg(test)]
            macro_input_recovery_after_resume_hook: Mutex::new(None),
            #[cfg(test)]
            system_surface_failure_after_owner_fence_hook: Mutex::new(None),
            log_capture: Mutex::new(crate::log_capture::LogCaptureRuntime::new_with_metadata(
                user_data_dir.clone(),
                log_level,
                log_session_metadata,
            )),
            launch_completion,
            macro_runtime,
            operation_actor,
            overlay_language: Mutex::new(None),
            overlay_refresh,
            resolved_theme: Mutex::new("light".to_owned()),
            platform,
            runtime_contract_version,
            portable: Mutex::new(crate::portable::PortableRuntime::default()),
            popup_lifecycle: Mutex::new(
                crate::popup_lifecycle::ChromiumPopupLifecycleRuntime::default(),
            ),
            role_browser_data_clear_commands: Arc::new(
                RoleBrowserDataClearCommandCoordinator::default(),
            ),
            #[cfg(test)]
            role_browser_data_clear_before_domain_terminal_hook: Mutex::new(None),
            runtime: RwLock::new(Some(Runtime {
                state,
                logs,
                scheduler,
            })),
            runtime_restore_session_mutations:
                RuntimeRestoreSessionMutationCoordinator::default(),
            shutdown_started: AtomicBool::new(false),
            embedded_runtime_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            embedded_window_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            event_sender,
            state_mutation_guard: Mutex::new(()),
            session_transfer_vault_guard: Mutex::new(()),
            subscribers,
            system_fonts: Mutex::new(None),
            browser_runtime_registration: RwLock::new(unavailable_browser_runtime_registration(
                platform,
                runtime_contract_version,
            )),
            user_data_dir,
        };
        if !retired_local_storage_replay_warnings.is_empty() {
            let _ = core.capture_logs(vec![LogCaptureRecord {
                level: LogLevel::Warn,
                source: crate::model::LogSource::Main,
                event: "storage.retired-local-storage-replay-cleanup-failed".to_owned(),
                message: "Retired role LocalStorage replay cleanup will retry on the next startup."
                    .to_owned(),
                context_raw_json: serde_json::to_string(&json!({
                    "errors": retired_local_storage_replay_warnings,
                }))
                .ok(),
                error: None,
            }]);
        }
        core.emit(vec![CoreEvent::Ready {
            schema_version: SCHEMA_VERSION,
        }]);
        Ok(core)
    }

    pub fn user_data_dir(&self) -> &std::path::Path {
        &self.user_data_dir
    }

    pub fn set_browser_launch_completion_sink(
        &self,
        sink: Arc<dyn Fn(BrowserLaunchCompletionRecord) + Send + Sync>,
    ) -> CoreResult<()> {
        *self.browser_launch_completion_sink.write().map_err(|_| {
            CoreError::Internal("browser launch completion sink lock poisoned".to_owned())
        })? = Some(sink);
        Ok(())
    }

    fn notify_browser_launch_completion(&self, record: BrowserLaunchCompletionRecord) {
        self.emit(vec![CoreEvent::BrowserLaunchCompleted {
            operation_id: record.operation_id.clone(),
            source_id: record.source_id.clone(),
            source_type: record.tab_type.clone(),
            tab_id: record.tab_id.clone(),
            ok: record.error.is_none(),
            error_code: record.error.as_ref().map(|error| error.code.clone()),
        }]);
        let sink = self
            .browser_launch_completion_sink
            .read()
            .ok()
            .and_then(|sink| sink.clone());
        if let Some(sink) = sink {
            sink(record);
        }
    }
}
