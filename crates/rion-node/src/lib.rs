use std::{path::PathBuf, sync::Arc, thread, time::Duration};

use napi::{Status, bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode};
use napi_derive::napi;
use rion_core::{
    AppCore, AppCoreOptions as CoreOptions, BrowserActionRequest, BrowserActionResult,
    BrowserOperationRequest, BrowserRuntimeCommand, CdnRule, CoreCommand, CoreError, CoreEvent,
    EmbeddedKeyTransitionRecord, ExternalChromeCdpSession, ExternalSessionCommand, LayoutRect,
    LayoutRoleInput, ResourcePolicyInput, ResourceRuntimeCommand, StatePixelBoundsRecord,
    WorkspaceDividerResizeInput, WorkspaceLayoutInput,
};

#[napi]
pub fn read_bootstrap_graphics_mode(user_data_dir: String) -> String {
    rion_core::read_bootstrap_graphics_mode(PathBuf::from(user_data_dir).as_path())
}

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
    pub fn invoke_external_session(&self, command_json: String) -> Result<String> {
        let command = serde_json::from_str::<ExternalSessionCommand>(&command_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let result = self
            .inner
            .invoke_external_session(command)
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub async fn acquire_browser_operation(&self, request_json: String) -> Result<String> {
        let request = serde_json::from_str::<BrowserOperationRequest>(&request_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let core = Arc::clone(&self.inner);
        let lease =
            napi::tokio::task::spawn_blocking(move || core.acquire_browser_operation(request))
                .await
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
                .map_err(to_napi_error)?;
        serde_json::to_string(&lease)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn complete_browser_operation(&self, id: String) -> Result<()> {
        self.inner
            .complete_browser_operation(&id)
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn invoke_browser_runtime(&self, command_json: String) -> Result<String> {
        let command = serde_json::from_str::<BrowserRuntimeCommand>(&command_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let result = self
            .inner
            .invoke_browser_runtime(command)
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn resolve_role_paths(&self, role_id: String) -> Result<String> {
        let paths = self
            .inner
            .resolve_role_paths(&role_id)
            .map_err(to_napi_error)?;
        serde_json::to_string(&paths)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn prepare_embedded_key_transition(
        &self,
        role_id: String,
        phase: String,
        code: String,
        modifier_codes_json: String,
        owner_id: String,
    ) -> Result<String> {
        let modifier_codes = serde_json::from_str::<Vec<String>>(&modifier_codes_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let transition: EmbeddedKeyTransitionRecord = self
            .inner
            .prepare_embedded_key_transition(&role_id, &phase, &code, &modifier_codes, &owner_id)
            .map_err(to_napi_error)?;
        serde_json::to_string(&transition)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn complete_embedded_key_transition(
        &self,
        transition_id: String,
        succeeded: bool,
    ) -> Result<()> {
        self.inner
            .complete_embedded_key_transition(&transition_id, succeeded)
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn reassert_embedded_keys(&self, role_id: String) -> Result<String> {
        let transition = self
            .inner
            .reassert_embedded_keys(&role_id)
            .map_err(to_napi_error)?;
        serde_json::to_string(&transition)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn has_embedded_held_keys(&self, role_id: String) -> Result<bool> {
        self.inner
            .has_embedded_held_keys(&role_id)
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn clear_embedded_keys(&self, role_id: String) -> Result<()> {
        self.inner
            .clear_embedded_keys(&role_id)
            .map_err(to_napi_error)
    }

    #[napi]
    pub fn invoke_resource_runtime(&self, command_json: String) -> Result<String> {
        let command = serde_json::from_str::<ResourceRuntimeCommand>(&command_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let result = self
            .inner
            .invoke_resource_runtime(command)
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

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
    pub async fn connect_external_chrome_cdp(
        &self,
        role_id: String,
        browser_user_data_dir: String,
        launch_url: String,
        timeout_ms: Option<u32>,
        cdn_enabled: Option<bool>,
    ) -> Result<NativeExternalChromeCdpClient> {
        let session = self
            .inner
            .connect_external_chrome_cdp(
                role_id,
                PathBuf::from(browser_user_data_dir),
                launch_url,
                timeout_ms.map(|value| Duration::from_millis(u64::from(value))),
                cdn_enabled.unwrap_or(false),
            )
            .await
            .map_err(to_napi_error)?;
        Ok(NativeExternalChromeCdpClient { inner: session })
    }

    #[napi]
    pub fn unregister_external_chrome_automation(&self, role_id: String) -> Result<()> {
        self.inner
            .unregister_external_chrome_automation(&role_id)
            .map_err(to_napi_error)
    }

    #[napi]
    pub async fn dispatch_external_browser_actions(&self, actions_json: String) -> Result<String> {
        let actions = serde_json::from_str::<Vec<BrowserActionRequest>>(&actions_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let result = self
            .inner
            .dispatch_external_browser_actions(actions)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub async fn focus_external_chrome(&self, role_id: String) -> Result<()> {
        self.inner
            .focus_external_chrome(&role_id)
            .await
            .map_err(to_napi_error)
    }

    #[napi]
    pub async fn set_external_chrome_window_bounds(
        &self,
        role_id: String,
        bounds_json: String,
    ) -> Result<()> {
        let bounds = serde_json::from_str::<StatePixelBoundsRecord>(&bounds_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        self.inner
            .set_external_chrome_window_bounds(&role_id, bounds)
            .await
            .map_err(to_napi_error)
    }

    #[napi]
    pub async fn capture_external_chrome_diagnostics(&self, role_id: String) -> Result<String> {
        let result = self
            .inner
            .capture_external_chrome_diagnostics(&role_id)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub async fn evaluate_external_chrome(
        &self,
        role_id: String,
        source: String,
    ) -> Result<String> {
        let result = self
            .inner
            .evaluate_external_chrome(&role_id, &source)
            .await
            .map_err(to_napi_error)?;
        serde_json::to_string(&result)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
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
    pub fn resolve_adaptive_workspace_zoom(
        &self,
        viewport_width: f64,
        current_percent: Option<u32>,
    ) -> u32 {
        self.inner
            .resolve_adaptive_workspace_zoom(viewport_width, current_percent)
    }

    #[napi]
    pub fn normalize_workspace_rects(&self, input_json: String) -> Result<String> {
        let input = serde_json::from_str::<Vec<LayoutRect>>(&input_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        serde_json::to_string(&self.inner.normalize_workspace_rects(&input))
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn create_workspace_dividers(&self, input_json: String) -> Result<String> {
        let input = serde_json::from_str::<Vec<LayoutRoleInput>>(&input_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        serde_json::to_string(&self.inner.create_workspace_dividers(&input))
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn resize_workspace_divider(&self, input_json: String) -> Result<String> {
        let input = serde_json::from_str::<WorkspaceDividerResizeInput>(&input_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        serde_json::to_string(
            &self
                .inner
                .resize_workspace_divider(&input)
                .map_err(to_napi_error)?,
        )
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
