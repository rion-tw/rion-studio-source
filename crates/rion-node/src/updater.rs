use std::{path::PathBuf, sync::Arc, thread};

use napi::{Status, bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode};
use napi_derive::napi;
use rion_updater::{
    ChromiumUpdateManager, ChromiumUpdateManagerConfig, ReqwestUpdateTransport, UpdateManagerError,
    UpdatePlatform, production_platform_installer, run_macos_relaunch_helper,
    verify_macos_relaunch_target,
};
use semver::Version;

use crate::EventBridgeTerminalGate;

const UPDATE_EVENT_QUEUE_CAPACITY: usize = 64;
const DEVELOPMENT_UPDATER_ENDPOINT: &str = "https://updates.invalid/development/latest.json";

#[derive(serde::Serialize)]
struct UpdateEventStreamFailure {
    code: &'static str,
    message: &'static str,
}

#[napi(object)]
pub struct ChromiumUpdaterOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub current_version: String,
    pub packaged: bool,
}

#[napi(object)]
pub struct MacosUpdateRelaunchHelperOptions {
    pub user_data_dir: String,
    pub attempt_id: String,
    pub current_version: String,
    pub parent_process_id: u32,
}

#[napi(object)]
pub struct MacosUpdateRecoveryLocatorOptions {
    pub user_data_dir: String,
    pub attempt_id: String,
    pub current_version: String,
}

#[napi]
pub struct NativeChromiumUpdater {
    inner: Arc<ChromiumUpdateManager>,
}

#[napi]
impl NativeChromiumUpdater {
    #[napi(js_name = "getUpdateStatusInternal")]
    pub fn get_update_status_internal(&self) -> Result<String> {
        serialize(self.inner.status().map_err(updater_error)?)
    }

    #[napi(js_name = "checkForUpdatesInternal")]
    pub async fn check_for_updates_internal(&self) -> Result<String> {
        let manager = Arc::clone(&self.inner);
        let status = napi::tokio::task::spawn_blocking(move || manager.check_for_updates())
            .await
            .map_err(join_error)?
            .map_err(updater_error)?;
        serialize(status)
    }

    #[napi(js_name = "setAutoUpdateEnabledInternal")]
    pub async fn set_auto_update_enabled_internal(&self, enabled: bool) -> Result<String> {
        let manager = Arc::clone(&self.inner);
        let status =
            napi::tokio::task::spawn_blocking(move || manager.set_auto_update_enabled(enabled))
                .await
                .map_err(join_error)?
                .map_err(updater_error)?;
        serialize(status)
    }

    #[napi(js_name = "acceptUpdateInstallInternal")]
    pub async fn accept_update_install_internal(&self) -> Result<String> {
        let manager = Arc::clone(&self.inner);
        let acceptance = napi::tokio::task::spawn_blocking(move || manager.accept_install())
            .await
            .map_err(join_error)?
            .map_err(updater_error)?;
        serialize(acceptance)
    }

    #[napi(js_name = "prepareUpdateInstallInternal")]
    pub async fn prepare_update_install_internal(&self, attempt_id: String) -> Result<String> {
        let manager = Arc::clone(&self.inner);
        let receipt =
            napi::tokio::task::spawn_blocking(move || manager.prepare_install(&attempt_id))
                .await
                .map_err(join_error)?
                .map_err(updater_error)?;
        serialize(receipt)
    }

    #[napi(js_name = "beginUpdateInstallDrainInternal")]
    pub async fn begin_update_install_drain_internal(&self, attempt_id: String) -> Result<String> {
        let manager = Arc::clone(&self.inner);
        let receipt =
            napi::tokio::task::spawn_blocking(move || manager.begin_install_drain(&attempt_id))
                .await
                .map_err(join_error)?
                .map_err(updater_error)?;
        serialize(receipt)
    }

    #[napi(js_name = "failUpdateInstallAfterDrainInternal")]
    pub async fn fail_update_install_after_drain_internal(
        &self,
        attempt_id: String,
        failure_code: String,
    ) -> Result<String> {
        let failure_code = validated_drain_failure_code(&failure_code)?;
        let manager = Arc::clone(&self.inner);
        let receipt = napi::tokio::task::spawn_blocking(move || {
            manager.fail_install_after_drain(&attempt_id, failure_code)
        })
        .await
        .map_err(join_error)?
        .map_err(updater_error)?;
        serialize(receipt)
    }

    #[napi(js_name = "handoffUpdateInstallAfterDrainInternal")]
    pub async fn handoff_update_install_after_drain_internal(
        &self,
        attempt_id: String,
        parent_process_id: u32,
    ) -> Result<String> {
        if parent_process_id != std::process::id() {
            return Err(Error::new(
                Status::InvalidArg,
                "UPDATE_INSTALL_PARENT_IDENTITY_INVALID".to_owned(),
            ));
        }
        let manager = Arc::clone(&self.inner);
        let receipt = napi::tokio::task::spawn_blocking(move || {
            manager.handoff_install_after_drain(&attempt_id, parent_process_id)
        })
        .await
        .map_err(join_error)?
        .map_err(updater_error)?;
        serialize(receipt)
    }

    #[napi(js_name = "subscribeUpdateStatusInternal")]
    pub fn subscribe_update_status_internal(
        &self,
        callback: Function<'_, (String,), ()>,
        failure_callback: Function<'_, (String,), ()>,
    ) -> Result<()> {
        let receiver = self.inner.subscribe().map_err(updater_error)?;
        let threadsafe = callback
            .build_threadsafe_function::<String>()
            .max_queue_size::<UPDATE_EVENT_QUEUE_CAPACITY>()
            // The updater observer cannot own process lifetime; Electron owns
            // shutdown and N-API Closing is therefore a normal terminal.
            .weak::<true>()
            .build_callback(|context| Ok((context.value,)))?;
        let failure_threadsafe = Arc::new(
            failure_callback
                .build_threadsafe_function::<String>()
                .max_queue_size::<1>()
                .weak::<true>()
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
                let status = failure_threadsafe.call(
                    update_event_stream_failure_json(code, message),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                if status != Status::Ok && status != Status::Closing {
                    eprintln!(
                        "Rion Studio updater event failure callback closed with status {status}"
                    );
                }
            })
        };
        thread::Builder::new()
            .name("rion-updater-node-events".to_owned())
            .spawn(move || {
                loop {
                    let event = match receiver.recv() {
                        Ok(event) => event,
                        Err(_) => {
                            report_failure(
                                "UPDATE_EVENT_STREAM_CLOSED",
                                "The authoritative updater event receiver closed unexpectedly.",
                            );
                            break;
                        }
                    };
                    if terminal_gate.failed() {
                        break;
                    }
                    let serialized = match serde_json::to_string(&event) {
                        Ok(serialized) => serialized,
                        Err(error) => {
                            eprintln!("Rion Studio updater event serialization failed: {error}");
                            report_failure(
                                "UPDATE_EVENT_SERIALIZATION_FAILED",
                                "The authoritative updater event could not be serialized.",
                            );
                            break;
                        }
                    };
                    let callback_failure = Arc::clone(&report_failure);
                    match threadsafe.call_with_return_value(
                        serialized,
                        ThreadsafeFunctionCallMode::Blocking,
                        move |callback_result, _env| {
                            if callback_result.is_err() {
                                eprintln!("Rion Studio updater event callback failed");
                                callback_failure(
                                    "UPDATE_EVENT_CALLBACK_FAILED",
                                    "The JavaScript updater event callback failed.",
                                );
                            }
                            Ok(())
                        },
                    ) {
                        Status::Ok => {}
                        // Node teardown owns this terminal. A disposed TypeScript
                        // consumer also ignores any already-admitted callback.
                        Status::Closing => break,
                        status => {
                            eprintln!("Rion Studio updater event bridge closed with {status}");
                            report_failure(
                                "UPDATE_EVENT_BRIDGE_FAILED",
                                "The native updater event bridge rejected an authoritative event.",
                            );
                            break;
                        }
                    }
                }
            })
            .map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "UPDATE_EVENT_BRIDGE_START_FAILED".to_owned(),
                )
            })?;
        Ok(())
    }
}

fn update_event_stream_failure_json(code: &'static str, message: &'static str) -> String {
    serde_json::to_string(&UpdateEventStreamFailure { code, message })
        .expect("static updater event failure must serialize")
}

#[napi(js_name = "createChromiumUpdater")]
pub async fn create_chromium_updater(
    options: ChromiumUpdaterOptions,
) -> Result<NativeChromiumUpdater> {
    let config = decode_options(options)?;
    let manager = napi::tokio::task::spawn_blocking(move || {
        let transport = ReqwestUpdateTransport::new().map_err(UpdateManagerError::Transport)?;
        ChromiumUpdateManager::new(config, Arc::new(transport), production_platform_installer())
    })
    .await
    .map_err(join_error)?
    .map_err(updater_error)?;
    Ok(NativeChromiumUpdater {
        inner: Arc::new(manager),
    })
}

#[napi(js_name = "runMacosUpdateRelaunchHelperInternal")]
pub async fn run_macos_update_relaunch_helper_internal(
    options: MacosUpdateRelaunchHelperOptions,
) -> Result<u32> {
    if !PathBuf::from(&options.user_data_dir).is_absolute()
        || options.attempt_id.is_empty()
        || Version::parse(&options.current_version).is_err()
        || options.parent_process_id == 0
    {
        return Err(Error::new(
            Status::InvalidArg,
            "UPDATE_RELAUNCH_HELPER_INPUT_INVALID".to_owned(),
        ));
    }
    napi::tokio::task::spawn_blocking(move || {
        run_macos_relaunch_helper(
            PathBuf::from(options.user_data_dir),
            options.attempt_id,
            options.current_version,
            options.parent_process_id,
        )
    })
    .await
    .map_err(join_error)?
    .map_err(|error| updater_error(UpdateManagerError::PlatformInstall(error)))
}

#[napi(js_name = "verifyMacosUpdateRecoveryLocatorInternal")]
pub fn verify_macos_update_recovery_locator_internal(
    options: MacosUpdateRecoveryLocatorOptions,
) -> Result<()> {
    if !PathBuf::from(&options.user_data_dir).is_absolute()
        || options.attempt_id.is_empty()
        || Version::parse(&options.current_version).is_err()
    {
        return Err(Error::new(
            Status::InvalidArg,
            "UPDATE_RELAUNCH_TARGET_INPUT_INVALID".to_owned(),
        ));
    }
    verify_macos_relaunch_target(
        PathBuf::from(options.user_data_dir),
        options.attempt_id,
        options.current_version,
    )
    .map_err(|error| updater_error(UpdateManagerError::PlatformInstall(error)))
}

fn decode_options(options: ChromiumUpdaterOptions) -> Result<ChromiumUpdateManagerConfig> {
    let user_data_dir = PathBuf::from(options.user_data_dir);
    let current_version = Version::parse(&options.current_version).map_err(|_| {
        Error::new(
            Status::InvalidArg,
            "UPDATE_CURRENT_VERSION_INVALID".to_owned(),
        )
    })?;
    let platform = match options.platform.as_str() {
        "darwin" if cfg!(all(target_os = "macos", target_arch = "aarch64")) => {
            UpdatePlatform::MacosAarch64
        }
        "win32" if cfg!(all(windows, target_arch = "x86_64")) => UpdatePlatform::WindowsX86_64,
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                "UPDATE_PLATFORM_BUILD_MISMATCH".to_owned(),
            ));
        }
    };
    let endpoint = embedded_updater_endpoint(options.packaged)?;
    Ok(ChromiumUpdateManagerConfig {
        user_data_dir,
        current_version,
        platform,
        packaged: options.packaged,
        endpoint,
        public_key_base64: embedded_updater_public_key().unwrap_or_default().to_owned(),
    })
}

fn embedded_updater_public_key() -> Option<&'static str> {
    option_env!("RION_STUDIO_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn embedded_updater_endpoint(packaged: bool) -> Result<url::Url> {
    configured_updater_endpoint(option_env!("RION_STUDIO_UPDATER_ENDPOINT"), packaged)
}

fn configured_updater_endpoint(configured: Option<&str>, packaged: bool) -> Result<url::Url> {
    let configured = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let endpoint = match configured {
        Some(endpoint) => endpoint,
        None if packaged => {
            return Err(Error::new(
                Status::GenericFailure,
                "UPDATE_ENDPOINT_MISSING".to_owned(),
            ));
        }
        None => DEVELOPMENT_UPDATER_ENDPOINT.to_owned(),
    };
    rion_updater::validate_update_endpoint(&endpoint)
        .map_err(|_| Error::new(Status::GenericFailure, "UPDATE_ENDPOINT_INVALID".to_owned()))
}

fn validated_drain_failure_code(value: &str) -> Result<&'static str> {
    match value {
        "UPDATE_INSTALL_DRAIN_FAILED" => Ok("UPDATE_INSTALL_DRAIN_FAILED"),
        "UPDATE_INSTALL_SHELL_DRAIN_FAILED" => Ok("UPDATE_INSTALL_SHELL_DRAIN_FAILED"),
        _ => Err(Error::new(
            Status::InvalidArg,
            "UPDATE_INSTALL_FAILURE_CODE_INVALID".to_owned(),
        )),
    }
}

fn serialize(value: impl serde::Serialize) -> Result<String> {
    serde_json::to_string(&value).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            "UPDATE_RESPONSE_SERIALIZATION_FAILED".to_owned(),
        )
    })
}

fn updater_error(error: UpdateManagerError) -> Error {
    let code = error.code();
    let message = serde_json::json!({
        "code": code,
        "message": code
    })
    .to_string();
    Error::new(Status::GenericFailure, message)
}

fn join_error(_error: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        "UPDATE_NATIVE_WORKER_FAILED".to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_endpoint_is_https_and_immutable() {
        let endpoint =
            configured_updater_endpoint(Some("https://updates.example.test/v23/latest.json"), true)
                .unwrap();
        assert_eq!(endpoint.scheme(), "https");
        assert!(endpoint.query().is_none());
        assert!(endpoint.fragment().is_none());
    }

    #[test]
    fn packaged_endpoint_has_no_redirecting_or_implicit_default() {
        let error = configured_updater_endpoint(None, true).unwrap_err();
        assert_eq!(error.reason, "UPDATE_ENDPOINT_MISSING");

        let development = configured_updater_endpoint(None, false).unwrap();
        assert_eq!(development.as_str(), DEVELOPMENT_UPDATER_ENDPOINT);
    }

    #[test]
    fn drain_failure_codes_are_a_closed_native_contract() {
        assert_eq!(
            validated_drain_failure_code("UPDATE_INSTALL_DRAIN_FAILED").unwrap(),
            "UPDATE_INSTALL_DRAIN_FAILED"
        );
        assert!(validated_drain_failure_code("user-controlled").is_err());
    }

    #[test]
    fn updater_errors_never_serialize_transport_or_filesystem_details() {
        let error = updater_error(UpdateManagerError::NoPendingUpdate);
        assert!(error.reason.contains("UPDATE_NOT_READY"));
        assert!(!error.reason.contains('/'));
    }

    #[test]
    fn updater_event_stream_failures_have_one_closed_stable_schema() {
        let payload = update_event_stream_failure_json(
            "UPDATE_EVENT_STREAM_CLOSED",
            "The authoritative updater event receiver closed unexpectedly.",
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            serde_json::json!({
                "code": "UPDATE_EVENT_STREAM_CLOSED",
                "message": "The authoritative updater event receiver closed unexpectedly."
            })
        );
    }
}
