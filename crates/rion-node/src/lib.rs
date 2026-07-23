use std::{path::PathBuf, sync::Arc, thread, time::Instant};

use napi::{Status, bindgen_prelude::*, threadsafe_function::ThreadsafeFunctionCallMode};
use napi_derive::napi;
use rion_core::{
    AppCore, AppCoreOptions as CoreOptions, CoreCommand, CoreEffectResult, CoreError, CoreEvent,
};

#[napi]
pub fn read_bootstrap_plan(
    user_data_dir: String,
    platform: String,
    current_enable_features: String,
    current_disable_features: String,
) -> Result<String> {
    let platform = rion_platform::Platform::parse(&platform)
        .map_err(|error| to_napi_error(CoreError::Platform(error.to_string())))?;
    serde_json::to_string(&rion_core::read_bootstrap_plan(
        PathBuf::from(user_data_dir).as_path(),
        platform,
        &current_enable_features,
        &current_disable_features,
    ))
    .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
}

#[napi(object)]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
    pub performance_telemetry_path: Option<String>,
}

#[napi]
pub struct NativeAppCore {
    inner: Arc<AppCore>,
}

#[napi]
impl NativeAppCore {
    #[napi]
    pub async fn invoke(&self, command_json: String) -> Result<String> {
        let started_at = Instant::now();
        let command = serde_json::from_str::<CoreCommand>(&command_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let core = Arc::clone(&self.inner);
        let telemetry_core = Arc::clone(&self.inner);
        let value = if command.requires_async_dispatch() {
            core.invoke_async(command).await.map_err(to_napi_error)?
        } else {
            napi::tokio::task::spawn_blocking(move || core.invoke(command))
                .await
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
                .map_err(to_napi_error)?
        };
        telemetry_core.record_napi_latency(started_at.elapsed().as_secs_f64() * 1_000.0);
        serde_json::to_string(&value)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
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
                    let is_critical = is_shutdown
                        || events
                            .iter()
                            .any(|event| matches!(event, CoreEvent::CoreEffects { .. }));
                    let Ok(serialized) = serde_json::to_string(&events) else {
                        continue;
                    };
                    let mode = if is_critical {
                        ThreadsafeFunctionCallMode::Blocking
                    } else {
                        ThreadsafeFunctionCallMode::NonBlocking
                    };
                    let _ = threadsafe.call(serialized, mode);
                    if is_shutdown {
                        break;
                    }
                }
            })
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
        Ok(())
    }

    #[napi]
    pub async fn dispatch_core_effect_results(&self, results_json: String) -> Result<String> {
        let results = serde_json::from_str::<Vec<CoreEffectResult>>(&results_json)
            .map_err(|error| to_napi_error(CoreError::InvalidInput(error.to_string())))?;
        let core = Arc::clone(&self.inner);
        let report =
            napi::tokio::task::spawn_blocking(move || core.dispatch_core_effect_results(results))
                .await
                .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?
                .map_err(to_napi_error)?;
        serde_json::to_string(&report)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }

    #[napi]
    pub fn match_cdn_url(&self, url: String) -> Result<Option<String>> {
        self.inner.match_cdn_url(&url).map_err(to_napi_error)
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
        performance_telemetry_path: options.performance_telemetry_path,
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
