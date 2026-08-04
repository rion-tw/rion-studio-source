use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::ErrorKind,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
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
    macro_runtime::MacroRuntime,
    model::{
        AppCoreOptions, ApplicationDiagnosticsSnapshotRecord, BrowserActionResult,
        BrowserOperationRequest, BrowserRuntimeCommand, ChromeProfileImportAuthStateRecord,
        ChromeProfileImportItemResultRecord, ChromeProfileImportProgressRecord,
        ChromeProfileImportResolutionRecord, ChromeProfileImportResultRecord,
        ChromeProfileImportUnsupportedCountsRecord, CoreCommand, CoreEffectAction,
        CoreEffectDispatchReport, CoreEffectResult, CoreEffectTarget, CoreEffectTargetKind,
        CoreEvent, CoreStateSnapshotRecord, DiagnosticExportResultRecord,
        EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
        EmbeddedRoleSlotEffectRecord, EmbeddedRoleViewEffectRecord, EmbeddedTabEffectRecord,
        GameBrowserSettingsPatchRecord, GameWindowRuntimeSnapshotCommitInputRecord,
        GameBrowserSettingsRecord, GameWindowRoleSlotRecord, GameWindowSaveRuntimeInputRecord,
        GameWindowTabRecord,
        GameWindowUpdateInputRecord, LegalAcceptanceRecord, LogCaptureRecord, LogLevel,
        MacroInputDiagnosticsRecord, MacroInputEpochRecord, MacroOverlayRequestRecord,
        MacroOverlayStartSummaryRecord, MacroOverlayViewModelRecord, MacroPressRequest,
        MacroReleaseRequest, MacroSettingsRecord, MacroStartRequest,
        OperationCancelResultRecord, RolePathsRecord, RuntimeRestoreSessionRecord,
        RuntimeRoleSlotInputRecord, RuntimeWindowPersistenceReceiptRecord,
        RuntimeWindowPreferencesRecord, StateCollection,
        StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord, StateMacroRecord,
        StateNormalizedRectRecord, StateRoleRecord, SystemWebViewRuntimeRegistrationRecord,
    },
    scheduler::MonotonicScheduler,
};

const EVENT_QUEUE_CAPACITY: usize = 64;
const LAUNCH_COMPLETION_QUEUE_CAPACITY: usize = 64;
const LAUNCH_COMPLETION_CONCURRENCY: usize = 4;
const INSTANCE_LOCK_FILE_NAME: &str = "rion-studio.instance.lock";
// Native System WebView session effects may spend up to 40 seconds waiting for
// one navigation. Keep the core deadline above that bound so the shell can
// close its hidden surface and return an authoritative result.
const CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT: Duration = Duration::from_secs(60);
// A persistent login cookie can be committed before a newly-created native
// WebView has rehydrated it into the site's active session. Give the post-apply
// verifier a short, bounded stabilization window before requiring login.
const CHROME_PROFILE_IMPORT_AUTH_RETRY_DELAYS: [Duration; 2] =
    [Duration::from_millis(250), Duration::from_millis(750)];

fn validate_runtime_game_window_snapshot(
    snapshot: &crate::model::BrowserRuntimeSnapshot,
    input: &GameWindowSaveRuntimeInputRecord,
) -> CoreResult<()> {
    let runtime_window = snapshot
        .windows
        .iter()
        .find(|window| window.window_id == input.window_id)
        .ok_or_else(|| CoreError::Domain {
            code: "RUNTIME_WINDOW_NOT_FOUND",
            message: "Runtime window was not found.".to_owned(),
        })?;
    let input_tab_ids = input
        .tabs
        .iter()
        .map(|tab| tab.id.as_str())
        .collect::<Vec<_>>();
    let runtime_tab_ids = runtime_window
        .tab_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if input_tab_ids != runtime_tab_ids
        || input.active_tab_id.as_ref() != runtime_window.active_tab_id.as_ref()
        || input.tabs.iter().any(|input_tab| {
            snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == input_tab.id)
                .is_none_or(|runtime_tab| {
                    runtime_tab.window_id != input.window_id
                        || runtime_tab.tab_type != input_tab.tab_type
                        || runtime_tab.source_id != input_tab.source_id
                        || runtime_tab.name != input_tab.name
                        || runtime_tab
                            .slots
                            .iter()
                            .map(|slot| slot.role_id.as_str())
                            .collect::<Vec<_>>()
                            != input_tab
                                .role_slots
                                .iter()
                                .map(|slot| slot.role_id.as_str())
                                .collect::<Vec<_>>()
                        || runtime_tab.hidden != input_tab.hidden
                })
        })
    {
        return Err(CoreError::Domain {
            code: "GAME_WINDOW_RUNTIME_SNAPSHOT_CHANGED",
            message: "The runtime window changed while it was being saved.".to_owned(),
        });
    }
    Ok(())
}

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
    telemetry: crate::telemetry::TelemetryWorker,
}

#[derive(Clone)]
pub struct BrowserLaunchCompletionRecord {
    pub accepted_at: Instant,
    pub error: Option<crate::error::CoreErrorPayload>,
    pub launch_preview_id: Option<String>,
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
    webview2_user_data_dir: String,
    webkit_data_store_identifier: String,
    staging: PathBuf,
}

struct PendingEmbeddedRoleLaunch {
    handle: crate::operation_actor::OperationHandle,
    lease_id: String,
    role: StateRoleRecord,
    tab_id: String,
    target: EmbeddedLaunchTargetRecord,
    window_id: String,
}

struct PendingEmbeddedWorkspaceLaunch {
    handle: crate::operation_actor::OperationHandle,
    lease_id: String,
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
    browser_action_effects: crate::browser_action_effects::BrowserActionEffectRuntime,
    browser_launch_completion_sink: RwLock<Option<BrowserLaunchCompletionSink>>,
    browser_operations: crate::browser_operations::BrowserOperationCoordinator,
    browser_runtime: Arc<Mutex<crate::browser_runtime::BrowserRuntime>>,
    browser_status_emit_guard: Mutex<()>,
    chrome_profile_import: Mutex<crate::chrome_profile_import::ChromeProfileImportRuntime>,
    database_paths: DatabasePaths,
    embedded_input: Mutex<crate::embedded_input::EmbeddedInputRuntime>,
    system_webview_issues:
        RwLock<std::collections::HashMap<String, crate::model::SystemWebViewIssueReason>>,
    embedded_closing_tabs: Mutex<std::collections::HashSet<String>>,
    embedded_operations: Mutex<std::collections::HashMap<String, String>>,
    pending_game_window_configurations: Mutex<std::collections::HashSet<String>>,
    runtime_window_persistence_revisions:
        Mutex<std::collections::HashMap<String, (u64, u64)>>,
    embedded_selection_revisions: Mutex<std::collections::HashMap<String, u64>>,
    instance_lock: Mutex<Option<File>>,
    macro_runtime: Arc<MacroRuntime>,
    log_capture: Mutex<crate::log_capture::LogCaptureRuntime>,
    launch_completion: LaunchCompletionCoordinator,
    operation_actor: Arc<crate::operation_actor::OperationActor>,
    overlay_language: Mutex<Option<String>>,
    overlay_refresh: crate::overlay::OverlayRefreshRuntime,
    resolved_theme: Mutex<String>,
    platform: rion_platform::Platform,
    portable: Mutex<crate::portable::PortableRuntime>,
    runtime: RwLock<Option<Runtime>>,
    shutdown_started: AtomicBool,
    embedded_runtime_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    embedded_window_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    event_sender: Sender<Vec<CoreEvent>>,
    state_mutation_guard: Mutex<()>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<CoreEvent>>>>>,
    system_fonts: Mutex<Option<Vec<crate::model::SystemFontFamilyRecord>>>,
    system_webview_runtime: RwLock<SystemWebViewRuntimeRegistrationRecord>,
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
        let retired_sync_cache_warnings =
            crate::role_browser_data::retire_local_storage_sync_caches(&user_data_dir);
        let log_level = state
            .read_scalar("logLevel".to_owned())?
            .and_then(|value| serde_json::from_value::<LogLevel>(value).ok())
            .unwrap_or(LogLevel::Debug);
        let logs = LogDatabaseWorker::start(database_paths.logs.clone())?;
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        let event_sender = start_event_dispatcher(Arc::clone(&subscribers))?;
        let effect_event_sender = event_sender.clone();
        let operation_actor = Arc::new(crate::operation_actor::OperationActor::new(Arc::new(
            move |effects| {
                publish_events(
                    &effect_event_sender,
                    vec![CoreEvent::CoreEffects { effects }],
                );
            },
        )));
        let scheduler = MonotonicScheduler::start()?;
        let telemetry_path = options
            .performance_telemetry_path
            .as_deref()
            .map(PathBuf::from);
        let telemetry_path = telemetry_path
            .map(|path| {
                if path.is_absolute() {
                    Ok(path)
                } else {
                    std::env::current_dir()
                        .map(|directory| directory.join(path))
                        .map_err(|error| CoreError::Platform(error.to_string()))
                }
            })
            .transpose()?;
        let telemetry = crate::telemetry::TelemetryWorker::start(telemetry_path)?;
        let launch_completion = LaunchCompletionCoordinator::start()?;
        let (browser_action_sender, browser_action_receiver) =
            crate::browser_action_effects::action_queue();
        let macro_event_sender = event_sender.clone();
        let macro_browser_action_sender = browser_action_sender.clone();
        let macro_runtime = Arc::new(MacroRuntime::new(Arc::new(move |events| {
            route_browser_action_events(events, &macro_browser_action_sender, &macro_event_sender);
        })));
        let browser_runtime =
            Arc::new(Mutex::new(crate::browser_runtime::BrowserRuntime::default()));
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
        let core = Self {
            app_version: options.app_version,
            browser_action_effects,
            browser_launch_completion_sink: RwLock::new(None),
            browser_operations: crate::browser_operations::BrowserOperationCoordinator::default(),
            browser_runtime,
            browser_status_emit_guard: Mutex::new(()),
            chrome_profile_import: Mutex::new(
                crate::chrome_profile_import::ChromeProfileImportRuntime::default(),
            ),
            database_paths,
            embedded_input: Mutex::new(crate::embedded_input::EmbeddedInputRuntime::default()),
            system_webview_issues: RwLock::new(std::collections::HashMap::new()),
            embedded_closing_tabs: Mutex::new(std::collections::HashSet::new()),
            embedded_operations: Mutex::new(std::collections::HashMap::new()),
            pending_game_window_configurations: Mutex::new(std::collections::HashSet::new()),
            runtime_window_persistence_revisions: Mutex::new(std::collections::HashMap::new()),
            instance_lock: Mutex::new(Some(instance_lock)),
            log_capture: Mutex::new(crate::log_capture::LogCaptureRuntime::new(
                user_data_dir.clone(),
                log_level,
            )),
            launch_completion,
            macro_runtime,
            operation_actor,
            overlay_language: Mutex::new(None),
            overlay_refresh,
            resolved_theme: Mutex::new("light".to_owned()),
            platform,
            portable: Mutex::new(crate::portable::PortableRuntime::default()),
            runtime: RwLock::new(Some(Runtime {
                state,
                logs,
                scheduler,
                telemetry,
            })),
            shutdown_started: AtomicBool::new(false),
            embedded_runtime_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            embedded_selection_revisions: Mutex::new(std::collections::HashMap::new()),
            embedded_window_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            event_sender,
            state_mutation_guard: Mutex::new(()),
            subscribers,
            system_fonts: Mutex::new(None),
            system_webview_runtime: RwLock::new(unavailable_system_webview_runtime(platform)),
            user_data_dir,
        };
        if !retired_sync_cache_warnings.is_empty() {
            let _ = core.capture_logs(vec![LogCaptureRecord {
                level: LogLevel::Warn,
                source: crate::model::LogSource::Main,
                event: "storage.retired-local-storage-sync-cache-cleanup-failed".to_owned(),
                message: "Retired role synchronization cache cleanup will retry on the next startup."
                    .to_owned(),
                context_raw_json: serde_json::to_string(&json!({
                    "errors": retired_sync_cache_warnings,
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
