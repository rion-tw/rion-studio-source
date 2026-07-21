use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use rion_platform::PixelBounds;
use serde_json::{Value, json};

use crate::{
    cdn::CdnMatcher,
    database::{DatabasePaths, LogDatabaseWorker, StateDatabaseWorker, bootstrap_databases},
    error::{CoreError, CoreResult},
    model::{
        AppCoreOptions, BrowserActionResult, CdnRule, CoreCommand, CoreEvent,
        ResourcePolicyDecision, ResourcePolicyInput,
    },
    pressure::PressureMonitor,
    resource::resolve_resource_policy,
    scheduler::MonotonicScheduler,
};

const EVENT_QUEUE_CAPACITY: usize = 64;

struct Runtime {
    state: StateDatabaseWorker,
    logs: LogDatabaseWorker,
    pressure: PressureMonitor,
    scheduler: MonotonicScheduler,
}

pub struct AppCore {
    app_version: String,
    cdn: RwLock<CdnMatcher>,
    database_paths: DatabasePaths,
    platform: rion_platform::Platform,
    runtime: Mutex<Option<Runtime>>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<CoreEvent>>>>>,
}

impl AppCore {
    pub fn create(options: AppCoreOptions) -> CoreResult<Self> {
        let user_data_dir = PathBuf::from(options.user_data_dir.trim());
        if options.user_data_dir.trim().is_empty() || !user_data_dir.is_absolute() {
            return Err(CoreError::InvalidInput(
                "userDataDir must be an absolute path".to_owned(),
            ));
        }
        let platform = rion_platform::Platform::parse(&options.platform)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        let database_paths = bootstrap_databases(&user_data_dir)?;
        let state = StateDatabaseWorker::start(database_paths.state.clone())?;
        let logs = LogDatabaseWorker::start(database_paths.logs.clone())?;
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        let pressure_subscribers = Arc::clone(&subscribers);
        let pressure = PressureMonitor::start(Arc::new(move |snapshot| {
            broadcast_events(
                &pressure_subscribers,
                vec![CoreEvent::PressureChanged { snapshot }],
            );
        }))?;
        let scheduler = MonotonicScheduler::start()?;
        let core = Self {
            app_version: options.app_version,
            cdn: RwLock::new(CdnMatcher::default()),
            database_paths,
            platform,
            runtime: Mutex::new(Some(Runtime {
                state,
                logs,
                pressure,
                scheduler,
            })),
            subscribers,
        };
        core.emit(vec![CoreEvent::Ready { schema_version: 1 }]);
        Ok(core)
    }

    pub fn invoke(&self, command: CoreCommand) -> CoreResult<Value> {
        match command {
            CoreCommand::Health => self.with_runtime(|runtime| {
                Ok(json!({
                  "coreVersion": env!("CARGO_PKG_VERSION"),
                  "appVersion": self.app_version,
                  "platform": self.platform,
                  "stateDatabase": self.database_paths.state,
                  "logDatabase": self.database_paths.logs,
                  "migrationBackup": self.database_paths.migration_backup,
                  "state": runtime.state.metadata()?
                }))
            }),
            CoreCommand::StateSnapshot => self.with_runtime(|runtime| runtime.state.snapshot()),
            CoreCommand::StateReplace { key, value } => self.with_runtime(|runtime| {
                let revision = runtime.state.replace(key, value)?;
                self.emit(vec![CoreEvent::StateChanged { revision }]);
                Ok(json!({ "revision": revision }))
            }),
            CoreCommand::StateReplaceSnapshot { snapshot } => self.with_runtime(|runtime| {
                let revision = runtime.state.replace_snapshot(snapshot)?;
                self.emit(vec![CoreEvent::StateChanged { revision }]);
                Ok(json!({ "revision": revision }))
            }),
            CoreCommand::CdnReplaceRules { rules } => {
                let mut matcher = self
                    .cdn
                    .write()
                    .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?;
                matcher.replace_rules(rules)?;
                Ok(json!({ "ruleIds": matcher.rule_ids() }))
            }
            CoreCommand::CdnRewriteUrl { url } => {
                let matcher = self
                    .cdn
                    .read()
                    .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?;
                Ok(json!({ "redirectUrl": matcher.rewrite(&url) }))
            }
            CoreCommand::ResourceResolve { input } => {
                serde_json::to_value(resolve_resource_policy(&input))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LogsAppend { entries } => self.with_runtime(|runtime| {
                let inserted = runtime.logs.append(entries)?;
                if inserted > 0 {
                    self.emit(vec![CoreEvent::LogsChanged]);
                }
                Ok(json!({ "inserted": inserted }))
            }),
            CoreCommand::LogsQuery { query } => {
                self.with_runtime(|runtime| runtime.logs.query(query))
            }
            CoreCommand::LogsClear => self.with_runtime(|runtime| {
                runtime.logs.clear()?;
                self.emit(vec![CoreEvent::LogsChanged]);
                Ok(json!({ "cleared": true }))
            }),
            CoreCommand::LogsStatus => self.with_runtime(|runtime| {
                serde_json::to_value(runtime.logs.status()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }),
            CoreCommand::LogsExport => {
                self.with_runtime(|runtime| Ok(json!({ "jsonl": runtime.logs.export_jsonl()? })))
            }
            CoreCommand::LogsExportTo { path } => self.with_runtime(|runtime| {
                runtime.logs.export_jsonl_to(PathBuf::from(&path))?;
                Ok(json!({ "path": path }))
            }),
        }
    }

    pub fn dispatch_browser_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        for result in results {
            if result.request_id.trim().is_empty() {
                return Err(CoreError::InvalidInput(
                    "browser action result requires requestId".to_owned(),
                ));
            }
            if result.ok && (result.error_code.is_some() || result.error_message.is_some()) {
                return Err(CoreError::InvalidInput(
                    "successful browser action result cannot contain an error".to_owned(),
                ));
            }
            if !result.ok
                && (result.error_code.as_deref().is_none_or(str::is_empty)
                    || result.error_message.as_deref().is_none_or(str::is_empty))
            {
                return Err(CoreError::InvalidInput(
                    "failed browser action result requires an error code and message".to_owned(),
                ));
            }
        }
        Ok(())
    }

    pub fn replace_cdn_rules(&self, rules: Vec<CdnRule>) -> CoreResult<Vec<String>> {
        let mut matcher = self
            .cdn
            .write()
            .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?;
        matcher.replace_rules(rules)?;
        Ok(matcher.rule_ids().into_iter().map(str::to_owned).collect())
    }

    pub fn rewrite_cdn_url(&self, url: &str) -> CoreResult<Option<String>> {
        let matcher = self
            .cdn
            .read()
            .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?;
        Ok(matcher.rewrite(url))
    }

    pub fn resolve_resource_policy(&self, input: &ResourcePolicyInput) -> ResourcePolicyDecision {
        resolve_resource_policy(input)
    }

    pub fn update_system_pressure_signals(
        &self,
        speed_limit: Option<f64>,
        thermal_state: Option<String>,
    ) -> CoreResult<()> {
        self.with_runtime(|runtime| runtime.pressure.update_signals(speed_limit, thermal_state))
    }

    pub fn schedule_wait(
        &self,
        id: String,
        duration_ms: u32,
    ) -> CoreResult<tokio::sync::oneshot::Receiver<CoreResult<()>>> {
        self.with_runtime(|runtime| runtime.scheduler.schedule(id, duration_ms))
    }

    pub fn cancel_wait(&self, id: String) -> CoreResult<()> {
        self.with_runtime(|runtime| runtime.scheduler.cancel(id))
    }

    pub fn align_external_chrome_window(
        &self,
        process_id: u32,
        target: PixelBounds,
    ) -> CoreResult<PixelBounds> {
        #[cfg(windows)]
        {
            rion_platform::windows::align_visible_frame(process_id, target)
                .map_err(|error| CoreError::Platform(error.to_string()))
        }
        #[cfg(not(windows))]
        {
            let _ = (process_id, target);
            Err(CoreError::Platform(
                "external Chrome window alignment is available on Windows only".to_owned(),
            ))
        }
    }

    pub fn find_chrome_executable(&self) -> CoreResult<PathBuf> {
        rion_platform::find_chrome_executable(self.platform)
            .map_err(|error| CoreError::Platform(error.to_string()))
    }

    pub fn prepare_external_chrome_profile(&self, path: PathBuf) -> CoreResult<()> {
        if !path.is_absolute() {
            return Err(CoreError::InvalidInput(
                "external Chrome profile path must be absolute".to_owned(),
            ));
        }
        match fs::remove_file(path.join("DevToolsActivePort")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CoreError::ExternalChrome(error.to_string())),
        }
    }

    pub fn subscribe(&self) -> CoreResult<Receiver<Vec<CoreEvent>>> {
        let (sender, receiver) = bounded(EVENT_QUEUE_CAPACITY);
        sender
            .try_send(vec![CoreEvent::Ready { schema_version: 1 }])
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        self.subscribers
            .lock()
            .map_err(|_| CoreError::Internal("subscriber lock poisoned".to_owned()))?
            .push(sender);
        Ok(receiver)
    }

    pub fn shutdown(&self) {
        if let Ok(mut runtime) = self.runtime.lock()
            && let Some(mut runtime) = runtime.take()
        {
            runtime.pressure.shutdown();
            runtime.scheduler.shutdown();
            runtime.logs.shutdown();
            runtime.state.shutdown();
        }
        self.emit(vec![CoreEvent::Shutdown]);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.clear();
        }
    }

    fn with_runtime<T>(&self, operation: impl FnOnce(&Runtime) -> CoreResult<T>) -> CoreResult<T> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| CoreError::Internal("runtime lock poisoned".to_owned()))?;
        operation(runtime.as_ref().ok_or(CoreError::ShuttingDown)?)
    }

    fn emit(&self, events: Vec<CoreEvent>) {
        broadcast_events(&self.subscribers, events);
    }
}

fn broadcast_events(subscribers: &Mutex<Vec<Sender<Vec<CoreEvent>>>>, events: Vec<CoreEvent>) {
    let Ok(mut subscribers) = subscribers.lock() else {
        return;
    };
    subscribers.retain(|subscriber| match subscriber.try_send(events.clone()) {
        Ok(()) | Err(TrySendError::Full(_)) => true,
        Err(TrySendError::Disconnected(_)) => false,
    });
}

impl Drop for AppCore {
    fn drop(&mut self) {
        self.shutdown();
    }
}
