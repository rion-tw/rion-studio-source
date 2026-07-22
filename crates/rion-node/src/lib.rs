use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use napi::{Status, bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode};
use napi_derive::napi;
use rion_core::{
    AppCore, AppCoreOptions as CoreOptions, BrowserActionResult, CdnRule, CoreCommand, CoreError,
    CoreEvent, ExternalChromeCdpSession, ResourcePolicyInput, WorkspaceLayoutInput,
};
use rion_platform::ExternalProcessSupervisor;

#[napi(object)]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
}

#[napi(object)]
pub struct NativePixelBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[napi]
pub struct NativeAppCore {
    inner: Arc<AppCore>,
}

#[napi]
pub struct NativeExternalChromeProcess {
    inner: Arc<Mutex<ExternalProcessSupervisor>>,
}

#[napi]
impl NativeExternalChromeProcess {
    #[napi]
    pub fn pid(&self) -> Result<u32> {
        self.inner
            .lock()
            .map(|supervisor| supervisor.pid())
            .map_err(|_| Error::new(Status::GenericFailure, "process supervisor lock poisoned"))
    }

    #[napi]
    pub fn subscribe_exit(&self, callback: Function<'_, (String,), ()>) -> Result<()> {
        let receiver = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "process supervisor lock poisoned"))?
            .take_events()
            .ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    "process exit may only be subscribed once",
                )
            })?;
        let threadsafe = callback
            .build_threadsafe_function::<String>()
            .max_queue_size::<1>()
            .build_callback(|context| Ok((context.value,)))?;
        thread::Builder::new()
            .name("rion-external-process-events".to_owned())
            .spawn(move || {
                if let Ok(event) = receiver.recv()
                    && let Ok(serialized) = serde_json::to_string(&event)
                {
                    let _ = threadsafe.call(serialized, ThreadsafeFunctionCallMode::NonBlocking);
                }
            })
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(())
    }

    #[napi]
    pub fn terminate(&self) -> Result<()> {
        self.inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "process supervisor lock poisoned"))?
            .terminate();
        Ok(())
    }
}

#[napi]
pub struct NativeExternalChromeCdpClient {
    inner: Arc<ExternalChromeCdpSession>,
}

#[napi]
impl NativeExternalChromeCdpClient {
    #[napi]
    pub async fn send(
        &self,
        method: String,
        params_json: Option<String>,
        timeout_ms: Option<u32>,
        session_id: Option<String>,
    ) -> Result<String> {
        let params = params_json
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let value = self
            .inner
            .send(
                method,
                params,
                timeout_ms.map(|value| Duration::from_millis(u64::from(value))),
                session_id,
            )
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&value)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn subscribe_events(&self, callback: Function<'_, (String,), ()>) -> Result<()> {
        let receiver = self.inner.take_events().map_err(to_napi_error)?;
        let threadsafe = callback
            .build_threadsafe_function::<String>()
            .max_queue_size::<256>()
            .build_callback(|context| Ok((context.value,)))?;
        thread::Builder::new()
            .name("rion-external-cdp-events".to_owned())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    let disconnected = matches!(event, rion_core::CdpEvent::Disconnected { .. });
                    if let Ok(serialized) = serde_json::to_string(&event) {
                        let _ = threadsafe.call(
                            serialized,
                            if disconnected {
                                ThreadsafeFunctionCallMode::Blocking
                            } else {
                                ThreadsafeFunctionCallMode::NonBlocking
                            },
                        );
                    }
                    if disconnected {
                        break;
                    }
                }
            })
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(())
    }

    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
}

#[napi]
impl NativeAppCore {
    #[napi]
    pub fn find_system_chrome_executable(&self) -> Result<String> {
        self.inner
            .find_chrome_executable()
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(to_napi_error)
    }

    #[napi]
    pub async fn prepare_external_chrome_profile(&self, path: String) -> Result<()> {
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || {
            core.prepare_external_chrome_profile(PathBuf::from(path))
        })
        .await
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
        .map_err(to_napi_error)
    }

    #[napi]
    pub fn launch_external_chrome(
        &self,
        executable_path: String,
        arguments: Vec<String>,
    ) -> Result<NativeExternalChromeProcess> {
        let supervisor =
            ExternalProcessSupervisor::start(PathBuf::from(executable_path).as_path(), &arguments)
                .map_err(|error| to_napi_error(CoreError::Platform(error.to_string())))?;
        Ok(NativeExternalChromeProcess {
            inner: Arc::new(Mutex::new(supervisor)),
        })
    }

    #[napi]
    pub async fn connect_external_chrome_cdp(
        &self,
        browser_user_data_dir: String,
        launch_url: String,
        timeout_ms: Option<u32>,
    ) -> Result<NativeExternalChromeCdpClient> {
        let session = ExternalChromeCdpSession::connect(
            PathBuf::from(browser_user_data_dir),
            launch_url,
            timeout_ms.map(|value| Duration::from_millis(u64::from(value))),
        )
        .await
        .map_err(to_napi_error)?;
        Ok(NativeExternalChromeCdpClient {
            inner: Arc::new(session),
        })
    }

    #[napi]
    pub async fn invoke(&self, command_json: String) -> Result<String> {
        let command = serde_json::from_str::<CoreCommand>(&command_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || core.invoke(command))
            .await
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
            .and_then(|value| {
                serde_json::to_string(&value)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            })
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn subscribe_core_events(&self, callback: Function<'_, (String,), ()>) -> Result<()> {
        let receiver = self.inner.subscribe().map_err(to_napi_error)?;
        let threadsafe = callback
            .build_threadsafe_function::<String>()
            .max_queue_size::<64>()
            .build_callback(|context| Ok((context.value,)))?;
        thread::Builder::new()
            .name("rion-core-events".to_owned())
            .spawn(move || {
                while let Ok(events) = receiver.recv() {
                    let is_shutdown = events
                        .iter()
                        .any(|event| matches!(event, CoreEvent::Shutdown));
                    let Ok(serialized) = serde_json::to_string(&events) else {
                        continue;
                    };
                    let _ = threadsafe.call(serialized, ThreadsafeFunctionCallMode::NonBlocking);
                    if is_shutdown {
                        break;
                    }
                }
            })
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(())
    }

    #[napi]
    pub async fn dispatch_browser_results(&self, results_json: String) -> Result<()> {
        let results = serde_json::from_str::<Vec<BrowserActionResult>>(&results_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || core.dispatch_browser_results(results))
            .await
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn replace_cdn_rules(&self, rules_json: String) -> Result<Vec<String>> {
        let rules = serde_json::from_str::<Vec<CdnRule>>(&rules_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        self.inner.replace_cdn_rules(rules).map_err(to_napi_error)
    }

    #[napi]
    pub fn rewrite_cdn_url(&self, url: String) -> Result<Option<String>> {
        self.inner.rewrite_cdn_url(&url).map_err(to_napi_error)
    }

    #[napi]
    pub fn resolve_resource_policy(&self, input_json: String) -> Result<String> {
        let input = serde_json::from_str::<ResourcePolicyInput>(&input_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        serde_json::to_string(&self.inner.resolve_resource_policy(&input))
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn resolve_workspace_layout(&self, input_json: String) -> Result<String> {
        let input = serde_json::from_str::<WorkspaceLayoutInput>(&input_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        serde_json::to_string(&self.inner.resolve_workspace_layout(&input))
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn update_system_pressure_signals(
        &self,
        speed_limit: Option<f64>,
        thermal_state: Option<String>,
    ) -> Result<()> {
        self.inner
            .update_system_pressure_signals(speed_limit, thermal_state)
            .map_err(to_napi_error)
    }

    #[napi]
    pub async fn schedule_wait(&self, id: String, duration_ms: u32) -> Result<()> {
        self.inner
            .schedule_wait(id, duration_ms)
            .map_err(to_napi_error)?
            .await
            .map_err(|_| Error::new(Status::GenericFailure, "scheduler stopped"))?
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn cancel_wait(&self, id: String) -> Result<()> {
        self.inner.cancel_wait(id).map_err(to_napi_error)
    }

    #[napi]
    pub async fn align_external_chrome_window(
        &self,
        process_id: u32,
        target: NativePixelBounds,
    ) -> Result<NativePixelBounds> {
        let core = Arc::clone(&self.inner);
        let target = rion_platform::PixelBounds {
            x: target.x,
            y: target.y,
            width: target.width,
            height: target.height,
        };
        let aligned = napi::tokio::task::spawn_blocking(move || {
            core.align_external_chrome_window(process_id, target)
        })
        .await
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
        .map_err(to_napi_error)?;
        Ok(NativePixelBounds {
            x: aligned.x,
            y: aligned.y,
            width: aligned.width,
            height: aligned.height,
        })
    }

    #[napi]
    pub async fn shutdown(&self) -> Result<()> {
        let core = Arc::clone(&self.inner);
        napi::tokio::task::spawn_blocking(move || core.shutdown())
            .await
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(())
    }
}

#[napi(js_name = "createAppCore")]
pub async fn create_app_core(options: AppCoreOptions) -> Result<NativeAppCore> {
    let options = CoreOptions {
        user_data_dir: options.user_data_dir,
        platform: options.platform,
        app_version: options.app_version,
    };
    let core = napi::tokio::task::spawn_blocking(move || AppCore::create(options))
        .await
        .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
        .map_err(to_napi_error)?;
    Ok(NativeAppCore {
        inner: Arc::new(core),
    })
}

#[napi(js_name = "coreVersion")]
pub fn core_version() -> &'static str {
    rion_core::CORE_VERSION
}

fn to_napi_error(error: CoreError) -> Error {
    let payload = serde_json::to_string(&error.payload()).unwrap_or_else(|_| error.to_string());
    Error::new(Status::GenericFailure, payload)
}
