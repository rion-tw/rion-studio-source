use std::{
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use fs2::FileExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    database::{
        DatabasePaths, LegacySessionRestoreState, LogDatabaseWorker, OperationJournalRecord,
        SCHEMA_VERSION, StateDatabaseWorker, StateMutation, bootstrap_databases,
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
        ChromeProfileImportUnsupportedCountsRecord, CompatibilityCheckOutcome,
        CompatibilityRunPhase, CoreCommand, CoreEffectAction, CoreEffectDispatchReport,
        CoreEffectResult, CoreEffectTarget, CoreEffectTargetKind, CoreEvent,
        CoreStateSnapshotRecord, DiagnosticExportResultRecord, EmbeddedLaunchResultRecord,
        EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord, EmbeddedRoleViewEffectRecord,
        EmbeddedTabEffectRecord, GameBrowserSettingsRecord, GameWindowCreateInputRecord,
        GameWindowTabRecord, LegacySessionRestoreRecord, LegalAcceptanceRecord, LogCaptureRecord,
        LogLevel, MacroOverlayRequestRecord, MacroOverlayStartSummaryRecord,
        MacroOverlayViewModelRecord, MacroPressRequest, MacroReleaseRequest, MacroSettingsRecord,
        MacroStartRequest, OperationCancelResultRecord, RolePathsRecord,
        RuntimeRestoreSessionRecord, RuntimeVersionRecord, RuntimeWindowPreferencesRecord,
        StateCollection, StateCompatibilityReportRecord, StateGameRecord, StateGameWindowRecord,
        StateLaunchWorkspaceRecord, StateMacroRecord, StateNormalizedRectRecord, StateRoleRecord,
        SystemWebViewRuntimeRegistrationRecord,
    },
    scheduler::MonotonicScheduler,
};

const EVENT_QUEUE_CAPACITY: usize = 64;
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

fn compatibility_load_timeout() -> Duration {
    if cfg!(test) {
        Duration::from_millis(100)
    } else {
        Duration::from_secs(20)
    }
}

struct Runtime {
    state: StateDatabaseWorker,
    logs: LogDatabaseWorker,
    scheduler: MonotonicScheduler,
    telemetry: crate::telemetry::TelemetryWorker,
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
    browser_operations: crate::browser_operations::BrowserOperationCoordinator,
    browser_runtime: Arc<Mutex<crate::browser_runtime::BrowserRuntime>>,
    chrome_profile_import: Mutex<crate::chrome_profile_import::ChromeProfileImportRuntime>,
    compatibility_runtime: Mutex<crate::compatibility_runtime::CompatibilityRuntime>,
    database_paths: DatabasePaths,
    embedded_input: Mutex<crate::embedded_input::EmbeddedInputRuntime>,
    system_webview_issues:
        RwLock<std::collections::HashMap<String, crate::model::SystemWebViewIssueReason>>,
    embedded_operations: Mutex<std::collections::HashMap<String, String>>,
    instance_lock: Mutex<Option<File>>,
    macro_runtime: Arc<MacroRuntime>,
    log_capture: Mutex<crate::log_capture::LogCaptureRuntime>,
    operation_actor: Arc<crate::operation_actor::OperationActor>,
    overlay_language: Mutex<Option<String>>,
    overlay_refresh: crate::overlay::OverlayRefreshRuntime,
    platform: rion_platform::Platform,
    portable: Mutex<crate::portable::PortableRuntime>,
    runtime: Mutex<Option<Runtime>>,
    embedded_runtime_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
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
        let log_level = state
            .read_scalar("logLevel".to_owned())?
            .and_then(|value| serde_json::from_value::<LogLevel>(value).ok())
            .unwrap_or(LogLevel::Debug);
        let logs = LogDatabaseWorker::start(database_paths.logs.clone())?;
        let subscribers = Arc::new(Mutex::new(Vec::new()));
        let effect_subscribers = Arc::clone(&subscribers);
        let operation_actor = Arc::new(crate::operation_actor::OperationActor::new(Arc::new(
            move |effects| {
                broadcast_events(
                    &effect_subscribers,
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
        let (browser_action_sender, browser_action_receiver) =
            crate::browser_action_effects::action_queue();
        let macro_subscribers = Arc::clone(&subscribers);
        let macro_browser_action_sender = browser_action_sender.clone();
        let macro_runtime = Arc::new(MacroRuntime::new(Arc::new(move |events| {
            route_browser_action_events(events, &macro_browser_action_sender, &macro_subscribers);
        })));
        let browser_runtime =
            Arc::new(Mutex::new(crate::browser_runtime::BrowserRuntime::default()));
        let browser_action_subscribers = Arc::clone(&subscribers);
        let browser_action_effects =
            crate::browser_action_effects::BrowserActionEffectRuntime::start(
                browser_action_receiver,
                Arc::new(move |events| broadcast_events(&browser_action_subscribers, events)),
            )?;
        let (overlay_event_sender, overlay_event_receiver) = bounded(EVENT_QUEUE_CAPACITY);
        subscribers
            .lock()
            .map_err(|_| CoreError::Internal("subscriber lock poisoned".to_owned()))?
            .push(overlay_event_sender);
        let overlay_subscribers = Arc::clone(&subscribers);
        let overlay_refresh = crate::overlay::OverlayRefreshRuntime::start(
            overlay_event_receiver,
            Arc::new(move |events| broadcast_events(&overlay_subscribers, events)),
        )?;
        let core = Self {
            app_version: options.app_version,
            browser_action_effects,
            browser_operations: crate::browser_operations::BrowserOperationCoordinator::default(),
            browser_runtime,
            chrome_profile_import: Mutex::new(
                crate::chrome_profile_import::ChromeProfileImportRuntime::default(),
            ),
            compatibility_runtime: Mutex::new(
                crate::compatibility_runtime::CompatibilityRuntime::default(),
            ),
            database_paths,
            embedded_input: Mutex::new(crate::embedded_input::EmbeddedInputRuntime::default()),
            system_webview_issues: RwLock::new(std::collections::HashMap::new()),
            embedded_operations: Mutex::new(std::collections::HashMap::new()),
            instance_lock: Mutex::new(Some(instance_lock)),
            log_capture: Mutex::new(crate::log_capture::LogCaptureRuntime::new(
                user_data_dir.clone(),
                log_level,
            )),
            macro_runtime,
            operation_actor,
            overlay_language: Mutex::new(None),
            overlay_refresh,
            platform,
            portable: Mutex::new(crate::portable::PortableRuntime::default()),
            runtime: Mutex::new(Some(Runtime {
                state,
                logs,
                scheduler,
                telemetry,
            })),
            embedded_runtime_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            state_mutation_guard: Mutex::new(()),
            subscribers,
            system_fonts: Mutex::new(None),
            system_webview_runtime: RwLock::new(unavailable_system_webview_runtime(platform)),
            user_data_dir,
        };
        core.emit(vec![CoreEvent::Ready {
            schema_version: SCHEMA_VERSION,
        }]);
        Ok(core)
    }

    pub fn user_data_dir(&self) -> &std::path::Path {
        &self.user_data_dir
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
            CoreCommand::SystemWebViewProbe => {
                let probe = rion_platform::probe_system_webview(self.platform);
                serde_json::to_value(crate::model::SystemWebViewProbeRecord {
                    platform: match probe.platform {
                        rion_platform::Platform::Macos => "macos",
                        rion_platform::Platform::Windows => "windows",
                    }
                    .to_owned(),
                    engine: match probe.platform {
                        rion_platform::Platform::Macos => {
                            crate::model::ResolvedBrowserEngine::Wkwebview
                        }
                        rion_platform::Platform::Windows => {
                            crate::model::ResolvedBrowserEngine::Webview2
                        }
                    },
                    available: probe.available,
                    runtime_version: probe.runtime_version,
                    public_api_available: probe.public_api_available,
                    macro_input_available: probe.macro_input_available,
                    audio_mute_available: probe.audio_mute_available,
                    reason_codes: probe.reason_codes,
                })
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::SystemWebViewRuntimeRegister { registration } => {
                serde_json::to_value(self.register_system_webview_runtime(registration)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::StateSnapshot => self.with_runtime(|runtime| runtime.state.snapshot()),
            CoreCommand::GamesList => self.read_state_collection("games"),
            CoreCommand::GameGet { id } => {
                self.read_state_record("games", "id", &id, "GAME_NOT_FOUND", "Game not found.")
            }
            CoreCommand::GameCreate { input } => {
                self.mutate_state(StateMutation::GameCreate(input))
            }
            CoreCommand::GameUpdate { id, input } => {
                self.mutate_state(StateMutation::GameUpdate { id, input })
            }
            CoreCommand::GameResetBuiltin { id } => {
                self.mutate_state(StateMutation::GameResetBuiltin { id })
            }
            CoreCommand::GameDelete { id } => self.mutate_state(StateMutation::GameDelete { id }),
            CoreCommand::GamesDelete { ids } => {
                self.mutate_state(StateMutation::GamesDelete { ids })
            }
            CoreCommand::RolesList => self.read_state_collection("roles"),
            CoreCommand::RoleGet { id } => {
                self.read_state_record("roles", "id", &id, "ROLE_NOT_FOUND", "Role not found.")
            }
            CoreCommand::RoleCreate { input } => {
                let role = self.mutate_state(StateMutation::RoleCreate(input))?;
                let role_id = role
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CoreError::Internal("created role has no id".to_owned()))?;
                if let Err(error) = crate::role_browser_data::ensure(&self.user_data_dir, role_id) {
                    let _ = self.mutate_state(StateMutation::RoleDelete {
                        id: role_id.to_owned(),
                        operation_id: None,
                    });
                    return Err(error);
                }
                Ok(role)
            }
            CoreCommand::RoleUpdate { id, input } => {
                self.mutate_state(StateMutation::RoleUpdate { id, input })
            }
            CoreCommand::RoleReorder { ordered_ids } => {
                self.mutate_state(StateMutation::RoleReorder { ordered_ids })
            }
            CoreCommand::RoleDelete { id } => {
                let result = self.mutate_state(StateMutation::RoleDelete {
                    id: id.clone(),
                    operation_id: None,
                })?;
                crate::role_browser_data::remove(&self.user_data_dir, &id)?;
                Ok(result)
            }
            CoreCommand::RolesDelete { ids } => {
                let result = self.mutate_state(StateMutation::RolesDelete {
                    ids,
                    operation_ids: std::collections::HashMap::new(),
                })?;
                let deleted_ids = result
                    .get("deletedIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                for id in deleted_ids {
                    crate::role_browser_data::remove(&self.user_data_dir, &id)?;
                }
                Ok(result)
            }
            CoreCommand::RoleBrowserDirectoryEnsure { id } => {
                let _guard = self.state_mutation_guard()?;
                self.ensure_role_exists(&id)?;
                serde_json::to_value(crate::role_browser_data::ensure(&self.user_data_dir, &id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleBrowserDirectoryReset { id } => {
                let _guard = self.state_mutation_guard()?;
                self.ensure_role_exists(&id)?;
                serde_json::to_value(crate::role_browser_data::reset(&self.user_data_dir, &id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RolePathsResolve { id } => {
                self.ensure_role_exists(&id)?;
                serde_json::to_value(self.resolve_role_paths(&id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleAssignGameIds { assignments } => {
                self.mutate_state(StateMutation::RoleAssignGameIds(assignments))
            }
            CoreCommand::ChromeProfileDefaultPath => Ok(
                rion_platform::default_chrome_user_data_directory(self.platform)
                    .map(|path| Value::String(path.to_string_lossy().into_owned()))
                    .unwrap_or(Value::Null),
            ),
            CoreCommand::ChromeProfilePreview {
                source_user_data_dir,
            } => {
                let preview = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .preview(&source_user_data_dir)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileRefresh { import_id } => {
                let preview = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .refresh(&import_id)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileDiscard { import_id } => {
                self.chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .discard(&import_id);
                Ok(json!({ "discarded": true }))
            }
            CoreCommand::WorkspacesList => self.read_state_collection("launchWorkspaces"),
            CoreCommand::WorkspaceGet { id } => self.read_state_record(
                "launchWorkspaces",
                "id",
                &id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            ),
            CoreCommand::WorkspaceCreate { input } => {
                self.mutate_state(StateMutation::WorkspaceCreate(input))
            }
            CoreCommand::WorkspaceUpdate { id, input } => {
                self.mutate_state(StateMutation::WorkspaceUpdate { id, input })
            }
            CoreCommand::WorkspaceReorder { ordered_ids } => {
                self.mutate_state(StateMutation::WorkspaceReorder { ordered_ids })
            }
            CoreCommand::WorkspaceDelete { id } => {
                self.mutate_state(StateMutation::WorkspaceDelete { id })
            }
            CoreCommand::WorkspacesDelete { ids } => {
                self.mutate_state(StateMutation::WorkspacesDelete { ids })
            }
            CoreCommand::WorkspaceClearRole { role_id } => {
                self.mutate_state(StateMutation::WorkspaceClearRole { role_id })
            }
            CoreCommand::WorkspaceSetRoleBrowserZoom {
                workspace_id,
                role_id,
                browser_zoom_percent,
            } => self.mutate_state(StateMutation::WorkspaceSetRoleBrowserZoom {
                workspace_id,
                role_id,
                browser_zoom_percent,
            }),
            CoreCommand::GameWindowsList => self.read_state_collection("gameWindows"),
            CoreCommand::GameWindowGet { id } => self.read_state_record(
                "gameWindows",
                "id",
                &id,
                "GAME_WINDOW_NOT_FOUND",
                "Game window not found.",
            ),
            CoreCommand::GameWindowCreate { input } => {
                self.mutate_state(StateMutation::GameWindowCreate(input))
            }
            CoreCommand::GameWindowUpdate { id, input } => {
                self.mutate_state(StateMutation::GameWindowUpdate { id, input })
            }
            CoreCommand::GameWindowReorder { ordered_ids } => {
                self.mutate_state(StateMutation::GameWindowReorder { ordered_ids })
            }
            CoreCommand::GameWindowDelete { id } => {
                self.mutate_state(StateMutation::GameWindowDelete { id })
            }
            CoreCommand::MacrosList => self.read_state_collection("macros"),
            CoreCommand::MacroGet { id } => {
                self.read_state_record("macros", "id", &id, "MACRO_NOT_FOUND", "Macro not found.")
            }
            CoreCommand::MacroCreate { input } => {
                self.mutate_state(StateMutation::MacroCreate(input))
            }
            CoreCommand::MacroUpdate { id, input } => {
                self.mutate_state(StateMutation::MacroUpdate { id, input })
            }
            CoreCommand::MacroDelete { id } => self.mutate_state(StateMutation::MacroDelete { id }),
            CoreCommand::MacrosDelete { ids } => {
                self.mutate_state(StateMutation::MacrosDelete { ids })
            }
            CoreCommand::MacrosClearRole { role_id } => {
                self.mutate_state(StateMutation::MacrosClearRole { role_id })
            }
            CoreCommand::CompatibilityReportRecordObservation {
                game_id,
                observation,
            } => self.mutate_state(StateMutation::CompatibilityReportRecordObservation {
                game_id,
                observation,
            }),
            CoreCommand::CompatibilityReportDelete { game_id } => {
                self.mutate_state(StateMutation::CompatibilityReportDelete { game_id })
            }
            CoreCommand::CompatibilityStatuses => {
                serde_json::to_value(self.compatibility_runtime()?.statuses())
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::CompatibilityPrepare { game_id, versions } => {
                let _guard = self.state_mutation_guard()?;
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let (plan, statuses) = {
                    let mut runtime = self.compatibility_runtime()?;
                    let plan = runtime.prepare(&games, &game_id, &versions)?;
                    (plan, runtime.statuses())
                };
                self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
                serde_json::to_value(plan).map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::CompatibilityTransition { game_id, phase } => {
                let statuses = {
                    let mut runtime = self.compatibility_runtime()?;
                    runtime.transition(&game_id, phase)?;
                    runtime.statuses()
                };
                self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
                Ok(json!({ "updated": true }))
            }
            CoreCommand::CompatibilityComplete { game_id, outcome } => {
                let report = self
                    .compatibility_runtime()?
                    .build_report(&game_id, outcome)?;
                let saved =
                    self.mutate_state(StateMutation::CompatibilityReportSave(Box::new(report)))?;
                let statuses = {
                    let mut runtime = self.compatibility_runtime()?;
                    runtime.finish(&game_id);
                    runtime.statuses()
                };
                self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
                Ok(saved)
            }
            CoreCommand::CompatibilityCancel { game_id } => {
                let (requested, operation_id) =
                    self.compatibility_runtime()?.request_cancel(&game_id);
                if let Some(operation_id) = operation_id {
                    let _ = self.operation_actor.cancel(&operation_id)?;
                }
                Ok(json!({ "requested": requested }))
            }
            CoreCommand::CompatibilityReportsCurrent { versions } => {
                let _guard = self.state_mutation_guard()?;
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let reports = self.read_typed_state_collection::<StateCompatibilityReportRecord>(
                    "compatibilityReports",
                )?;
                serde_json::to_value(
                    crate::compatibility_runtime::CompatibilityRuntime::current_reports(
                        &games, &reports, &versions,
                    )?,
                )
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::GameBrowserSettingsGet => {
                serde_json::to_value(self.read_scalar_state::<GameBrowserSettingsRecord>(
                    "gameBrowserSettings",
                    "game browser settings are missing",
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::GameBrowserSettingsReplace { settings } => {
                let settings = normalize_game_browser_settings(settings);
                validate_game_browser_settings(&settings)?;
                self.replace_scalar_state("gameBrowserSettings", settings.clone())?;
                serde_json::to_value(settings)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EngineCompatibilityCacheGet { key } => serde_json::to_value(
                self.with_runtime(|runtime| runtime.state.engine_compatibility_cache_get(key))?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EngineCompatibilityCachePut { record } => serde_json::to_value(
                self.with_runtime(|runtime| runtime.state.engine_compatibility_cache_put(record))?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EngineCompatibilityCacheDeleteGame { game_id } => {
                let deleted = self.with_runtime(|runtime| {
                    runtime
                        .state
                        .engine_compatibility_cache_delete_game(game_id)
                })?;
                Ok(json!({ "deletedCount": deleted }))
            }
            CoreCommand::MacroSettingsGet => {
                serde_json::to_value(self.read_scalar_state::<MacroSettingsRecord>(
                    "macroSettings",
                    "macro settings are missing",
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::MacroSettingsReplace { settings } => {
                let settings = normalize_macro_settings(settings);
                validate_macro_settings(&settings)?;
                self.replace_scalar_state("macroSettings", settings.clone())?;
                serde_json::to_value(settings)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RuntimeWindowPreferencesGet => {
                serde_json::to_value(self.read_scalar_state::<RuntimeWindowPreferencesRecord>(
                    "runtimeWindowPreferences",
                    "runtime window preferences are missing",
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RuntimeWindowPreferencesReplace { preferences } => {
                self.replace_scalar_state("runtimeWindowPreferences", preferences.clone())?;
                serde_json::to_value(preferences)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RuntimeRestoreSessionGet => {
                let session = self
                    .read_optional_scalar_state::<RuntimeRestoreSessionRecord>(
                        "runtimeRestoreSession",
                    )?
                    .map(normalize_runtime_restore_session)
                    .transpose()?
                    .unwrap_or_else(default_runtime_restore_session);
                serde_json::to_value(session)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RuntimeRestoreSessionReplace { session } => {
                let session = normalize_runtime_restore_session(session)?;
                self.replace_scalar_state("runtimeRestoreSession", session.clone())?;
                serde_json::to_value(session)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LegalAcceptanceStatus => {
                let acceptance = self.read_legal_acceptance_fail_closed()?;
                serde_json::to_value(crate::legal::status(
                    acceptance.as_ref(),
                    crate::legal::current_versions(),
                ))
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LegalAcceptanceAccept { input } => {
                let versions = crate::legal::current_versions();
                let acceptance = crate::legal::accept(&versions, input)?;
                validate_legal_acceptance(&acceptance)?;
                self.replace_scalar_state("legalAcceptance", acceptance.clone())?;
                serde_json::to_value(crate::legal::status(Some(&acceptance), versions))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::SystemFontsList => {
                let mut cache = self.system_fonts.lock().map_err(|_| {
                    CoreError::Internal("system font cache lock poisoned".to_owned())
                })?;
                if cache.is_none() {
                    let queried =
                        rion_platform::query_system_font_names(self.platform).unwrap_or_default();
                    *cache = Some(crate::system_fonts::normalize_or_fallback(queried));
                }
                serde_json::to_value(cache.as_ref().expect("font cache initialized"))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::WindowsGraphicsEventsCollect { since } => serde_json::to_value(
                crate::windows_graphics_events::collect(self.platform, &since)?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::PortableExport {
                preferences,
                selection,
            } => {
                let _guard = self.state_mutation_guard()?;
                let snapshot = self.read_typed_snapshot()?;
                serde_json::to_value(crate::portable::export(
                    snapshot,
                    preferences,
                    selection,
                    &self.app_version,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::PortableExportTo {
                path,
                preferences,
                selection,
            } => {
                let _guard = self.state_mutation_guard()?;
                let snapshot = self.read_typed_snapshot()?;
                let data = crate::portable::export(
                    snapshot,
                    preferences,
                    selection.clone(),
                    &self.app_version,
                )?;
                serde_json::to_value(crate::portable::write_export(&path, &data, &selection)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::PortablePreview {
                raw_json,
                file_path,
            } => {
                let _guard = self.state_mutation_guard()?;
                let snapshot = self.read_typed_snapshot()?;
                let preview = self.portable()?.preview(&raw_json, file_path, snapshot)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::PortablePreviewFile { path } => {
                let _guard = self.state_mutation_guard()?;
                let snapshot = self.read_typed_snapshot()?;
                let preview = self.portable()?.preview_file(path, snapshot)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::PortableApply {
                import_id,
                selection,
                resolutions,
            } => {
                let runtime_snapshot = self
                    .browser_runtime
                    .lock()
                    .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                    .snapshot();
                let running_role_ids = runtime_snapshot
                    .roles
                    .iter()
                    .filter(|role| role.runtime == "embedded")
                    .map(|role| role.role_id.clone())
                    .collect::<std::collections::HashSet<_>>();
                let running_workspace_ids = runtime_snapshot
                    .workspaces
                    .iter()
                    .filter(|workspace| workspace.runtime == "embedded")
                    .map(|workspace| workspace_operation_key(&workspace.workspace_id))
                    .collect::<std::collections::HashSet<_>>();
                if selection.game_windows && !running_role_ids.is_empty() {
                    return Err(CoreError::Domain {
                        code: "PORTABLE_IMPORT_GAME_WINDOWS_RUNNING",
                        message: "Stop all running roles before importing Game Windows.".to_owned(),
                    });
                }
                let (before, prepared) = {
                    let _guard = self.state_mutation_guard()?;
                    let snapshot = self.read_typed_snapshot()?;
                    let prepared = self.portable()?.prepare_apply(
                        &import_id,
                        selection,
                        resolutions,
                        snapshot.clone(),
                    )?;
                    (snapshot, prepared)
                };
                let operation_role_ids = portable_operation_role_ids(&before, &prepared.snapshot)?;
                if operation_role_ids
                    .iter()
                    .any(|id| running_role_ids.contains(id) || running_workspace_ids.contains(id))
                {
                    return Err(CoreError::Domain {
                        code: "PORTABLE_IMPORT_ROLES_RUNNING",
                        message:
                            "Stop affected roles before importing Games, Roles, or Workspaces."
                                .to_owned(),
                    });
                }
                let browser_lease = if operation_role_ids.is_empty() {
                    None
                } else {
                    Some(self.browser_operations.acquire(BrowserOperationRequest {
                        role_ids: operation_role_ids,
                        kind: "recoverableMutation".to_owned(),
                    })?)
                };
                let macro_lease_id = if prepared.affected_macro_ids.is_empty() {
                    None
                } else {
                    match self
                        .macro_runtime
                        .acquire_mutation(prepared.affected_macro_ids.clone(), false)
                    {
                        Ok(lease_id) => Some(lease_id),
                        Err(CoreError::Domain {
                            code: "MACRO_MUTATION_BUSY",
                            ..
                        }) => {
                            if let Some(lease) = &browser_lease {
                                let _ = self.browser_operations.abort(&lease.id);
                            }
                            return Err(CoreError::Domain {
                                code: "PORTABLE_IMPORT_BUSY",
                                message: "Stop affected macros before importing.".to_owned(),
                            });
                        }
                        Err(error) => {
                            if let Some(lease) = &browser_lease {
                                let _ = self.browser_operations.abort(&lease.id);
                            }
                            return Err(error);
                        }
                    }
                };
                let result = (|| {
                    let _guard = self.state_mutation_guard()?;
                    let current = self.read_typed_snapshot()?;
                    if serde_json::to_value(&current)
                        .map_err(|error| CoreError::Internal(error.to_string()))?
                        != serde_json::to_value(&before)
                            .map_err(|error| CoreError::Internal(error.to_string()))?
                    {
                        return Err(CoreError::Domain {
                            code: "PORTABLE_IMPORT_STATE_CHANGED",
                            message: "App data changed while the import was waiting. Review and apply the import again."
                                .to_owned(),
                        });
                    }
                    let snapshot = serde_json::to_value(&prepared.snapshot)
                        .map_err(|error| CoreError::Internal(error.to_string()))?;
                    let (revision, changed) =
                        self.with_runtime(|runtime| runtime.state.replace_snapshot(snapshot))?;
                    self.portable()?.discard(&import_id);
                    if changed {
                        self.emit(vec![CoreEvent::StateChanged {
                            revision,
                            changed_collections: vec![
                                StateCollection::Games,
                                StateCollection::Roles,
                                StateCollection::LaunchWorkspaces,
                                StateCollection::GameWindows,
                                StateCollection::Macros,
                                StateCollection::CompatibilityReports,
                            ],
                        }]);
                    }
                    serde_json::to_value(prepared.result)
                        .map_err(|error| CoreError::Internal(error.to_string()))
                })();
                let macro_completion = macro_lease_id.as_deref().map_or(Ok(()), |lease_id| {
                    self.macro_runtime.release_mutation(lease_id)
                });
                let browser_completion = match (&browser_lease, result.is_ok()) {
                    (Some(lease), true) => self.browser_operations.complete(&lease.id),
                    (Some(lease), false) => self.browser_operations.abort(&lease.id),
                    (None, _) => Ok(()),
                };
                match (result, macro_completion, browser_completion) {
                    (Ok(value), Ok(()), Ok(())) => Ok(value),
                    (Err(error), _, _) | (Ok(_), Err(error), _) | (Ok(_), Ok(()), Err(error)) => {
                        Err(error)
                    }
                }
            }
            CoreCommand::PortableDiscard { import_id } => {
                Ok(json!({ "discarded": self.portable()?.discard(&import_id) }))
            }
            CoreCommand::LayoutResolve { input } => serde_json::to_value(layout::resolve(&input))
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::LayoutNormalizeRects { rects } => {
                serde_json::to_value(self.normalize_workspace_rects(&rects))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LayoutCreateDividers { roles } => {
                serde_json::to_value(self.create_workspace_dividers(&roles))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LayoutResizeDivider { input } => {
                serde_json::to_value(self.resize_workspace_divider(&input)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LayoutAdaptiveZoom {
                viewport_width,
                current_percent,
            } => Ok(json!(self.resolve_adaptive_workspace_zoom(
                viewport_width,
                current_percent,
            ))),
            CoreCommand::EmbeddedKeyPrepare {
                role_id,
                phase,
                code,
                modifier_codes,
                owner_id,
            } => serde_json::to_value(self.prepare_embedded_key_transition(
                &role_id,
                &phase,
                &code,
                &modifier_codes,
                &owner_id,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedKeyComplete {
                transition_id,
                succeeded,
            } => {
                self.complete_embedded_key_transition(&transition_id, succeeded)?;
                Ok(json!({ "completed": true }))
            }
            CoreCommand::EmbeddedKeysReassert { role_id } => {
                serde_json::to_value(self.reassert_embedded_keys(&role_id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedKeysHeld { role_id } => {
                Ok(json!(self.has_embedded_held_keys(&role_id)?))
            }
            CoreCommand::EmbeddedKeysClear { role_id } => {
                self.clear_embedded_keys(&role_id)?;
                Ok(json!({ "cleared": true }))
            }
            CoreCommand::LogsCapture { entries } => {
                let entries = self.capture_logs(entries)?;
                let inserted = self.with_runtime(|runtime| runtime.logs.append(entries.clone()))?;
                if inserted > 0 {
                    self.emit(vec![
                        CoreEvent::LogEntriesCaptured { entries },
                        CoreEvent::LogsChanged,
                    ]);
                }
                Ok(json!({ "inserted": inserted }))
            }
            CoreCommand::LogsSetLevel { level } => {
                self.replace_scalar_state("logLevel", level)?;
                self.log_capture()?.set_level(level);
                Ok(json!({ "level": level }))
            }
            CoreCommand::LogsQuery { query } => self.with_runtime(|runtime| {
                serde_json::to_value(runtime.logs.query(query)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }),
            CoreCommand::LogsClear => self.with_runtime(|runtime| {
                runtime.logs.clear()?;
                self.emit(vec![CoreEvent::LogsChanged]);
                Ok(json!({ "cleared": true }))
            }),
            CoreCommand::LogsStatus => {
                let current_level = self.log_capture()?.current_level();
                self.with_runtime(|runtime| {
                    serde_json::to_value(runtime.logs.storage_status(current_level)?)
                        .map_err(|error| CoreError::Internal(error.to_string()))
                })
            }
            CoreCommand::LogsExportTo { path } => self.with_runtime(|runtime| {
                runtime.logs.export_jsonl_to(PathBuf::from(&path))?;
                Ok(json!({ "path": path }))
            }),
            CoreCommand::TelemetryRecord { sample } => self.with_runtime(|runtime| {
                runtime.telemetry.record(sample);
                Ok(json!({ "recorded": true }))
            }),
            CoreCommand::TelemetrySnapshot => {
                let core_effects = self.operation_actor.metrics();
                self.with_runtime(|runtime| {
                    runtime.telemetry.record_core_effects(core_effects);
                    serde_json::to_value(runtime.telemetry.snapshot()?)
                        .map_err(|error| CoreError::Internal(error.to_string()))
                })
            }
            CoreCommand::OverlayLanguageSet { language } => {
                validate_overlay_language(&language)?;
                *self.overlay_language.lock().map_err(|_| {
                    CoreError::Internal("overlay language lock poisoned".to_owned())
                })? = Some(language.clone());
                self.overlay_refresh.invalidate(Vec::new());
                Ok(json!({ "language": language }))
            }
            CoreCommand::MacroStart { request } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                let request = crate::model::MacroStartRequest {
                    macros,
                    settings,
                    macro_id: request.macro_id,
                    source_role_id: request.source_role_id,
                    active_role_ids: self.macro_active_role_ids()?,
                };
                serde_json::to_value(self.macro_runtime.start(request)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::MacroPress { request } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                let request = crate::model::MacroPressRequest {
                    start: crate::model::MacroStartRequest {
                        macros,
                        settings,
                        macro_id: request.macro_id,
                        source_role_id: Some(request.source_role_id),
                        active_role_ids: self.macro_active_role_ids()?,
                    },
                    press_id: request.press_id,
                };
                serde_json::to_value(self.macro_runtime.press(request)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::MacroRelease { request } => {
                self.macro_runtime.release(request)?;
                Ok(json!({ "released": true }))
            }
            CoreCommand::MacroStop { macro_id } => {
                self.macro_runtime.stop_macro(&macro_id)?;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::MacroStopForRole {
                macro_id,
                source_role_id,
            } => {
                let (macros, _) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                let macro_definition = macros
                    .iter()
                    .find(|macro_definition| macro_definition.id == macro_id)
                    .ok_or_else(|| CoreError::Domain {
                        code: "MACRO_NOT_FOUND",
                        message: "Macro not found.".to_owned(),
                    })?;
                if !macro_definition.role_ids.is_empty()
                    && !macro_definition.role_ids.contains(&source_role_id)
                {
                    return Err(CoreError::Domain {
                        code: "MACRO_ROLE_INVALID",
                        message: "This macro is not assigned to the current role.".to_owned(),
                    });
                }
                self.macro_runtime
                    .stop_macro_from_role(&macro_id, &source_role_id)?;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::MacroStopRole { role_id } => {
                self.macro_runtime.stop_role(&role_id)?;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::MacroReleaseRole { role_id } => {
                self.macro_runtime.release_role(&role_id)?;
                Ok(json!({ "released": true }))
            }
            CoreCommand::MacroStatuses => serde_json::to_value(self.macro_runtime.statuses()?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::OperationCancel { operation_id } => {
                serde_json::to_value(OperationCancelResultRecord {
                    cancelled: self.operation_actor.cancel(&operation_id)?,
                })
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::CoreEffectMetrics => serde_json::to_value(self.operation_actor.metrics())
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedRoleLaunch {
                role_id,
                target,
                zoom_factor,
            } => serde_json::to_value(self.launch_embedded_role(
                &role_id,
                target,
                zoom_factor.unwrap_or(1.0),
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedWorkspaceLaunch {
                workspace_id,
                target,
            } => serde_json::to_value(self.launch_embedded_workspace(&workspace_id, target)?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedRoleStop { role_id } => {
                self.stop_embedded_role(&role_id)?;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::EmbeddedWorkspaceStop { workspace_id } => {
                self.stop_embedded_workspace(&workspace_id)?;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::EmbeddedSystemSurfaceFailed { role_id, reason } => serde_json::to_value(
                self.report_crashed_system_surface(&role_id, reason.as_deref())?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedSystemSurfaceRecovered { role_id } => {
                serde_json::to_value(self.report_recovered_system_surface(&role_id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowRegister { target } => {
                let window_id = target.window_id.clone();
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::RegisterWindow {
                        window_id: window_id.clone(),
                    }],
                    Some(target),
                    vec![window_id.clone()],
                    vec![window_id],
                    None,
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowDelete { window_id } => {
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::RemoveWindow { window_id }],
                    None,
                    Vec::new(),
                    Vec::new(),
                    None,
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowsShow { window_id } => {
                let window_ids = match window_id {
                    Some(window_id) => vec![window_id],
                    None => self
                        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                        .snapshot
                        .windows
                        .into_iter()
                        .map(|window| window.window_id)
                        .collect(),
                };
                serde_json::to_value(
                    self.apply_embedded_runtime_command(
                        window_ids
                            .iter()
                            .map(|window_id| BrowserRuntimeCommand::ShowWindow {
                                window_id: window_id.clone(),
                            })
                            .collect(),
                        None,
                        window_ids.clone(),
                        window_ids,
                        None,
                        None,
                    )?,
                )
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabActivate { tab_id } => {
                let window_id = self.embedded_tab_window_id(&tab_id)?;
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::ActivateTab {
                        tab_id: tab_id.clone(),
                    }],
                    None,
                    vec![window_id.clone()],
                    vec![window_id],
                    Some(tab_id),
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabActivateAdjacent {
                window_id,
                direction,
            } => serde_json::to_value(self.apply_embedded_runtime_command(
                vec![BrowserRuntimeCommand::ActivateAdjacentTab {
                    window_id: window_id.clone(),
                    direction,
                }],
                None,
                vec![window_id.clone()],
                Vec::new(),
                None,
                Some(window_id),
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedTabHide { tab_id } => {
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::HideTab {
                        tab_id: tab_id.clone(),
                    }],
                    None,
                    Vec::new(),
                    Vec::new(),
                    None,
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabReorder {
                tab_id,
                before_tab_id,
            } => serde_json::to_value(self.apply_embedded_runtime_command(
                vec![BrowserRuntimeCommand::ReorderTab {
                    tab_id,
                    before_tab_id,
                }],
                None,
                Vec::new(),
                Vec::new(),
                None,
                None,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedTabMove { tab_id, target } => {
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::MoveTab {
                        tab_id: tab_id.clone(),
                        window_id: target.window_id.clone(),
                    }],
                    Some(target.clone()),
                    vec![target.window_id.clone()],
                    vec![target.window_id.clone()],
                    Some(tab_id),
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabMoveOrdered {
                tab_id,
                target,
                before_tab_id,
            } => serde_json::to_value(self.apply_embedded_runtime_command(
                vec![
                    BrowserRuntimeCommand::MoveTab {
                        tab_id: tab_id.clone(),
                        window_id: target.window_id.clone(),
                    },
                    BrowserRuntimeCommand::ReorderTab {
                        tab_id: tab_id.clone(),
                        before_tab_id,
                    },
                ],
                Some(target.clone()),
                vec![target.window_id.clone()],
                vec![target.window_id.clone()],
                Some(tab_id),
                None,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::GameWindowCreateAndMoveTab {
                input,
                tab_id,
                target,
                before_tab_id,
            } => serde_json::to_value(self.create_game_window_and_move_tab(
                input,
                &tab_id,
                target,
                before_tab_id,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserStatuses => serde_json::to_value(self.browser_statuses()?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserWorkspaceStatuses => {
                serde_json::to_value(self.browser_workspace_statuses()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRuntimeSnapshot => {
                let snapshot = self
                    .browser_runtime
                    .lock()
                    .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                    .snapshot();
                serde_json::to_value(snapshot)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRuntimeSuspend { suspended } => {
                Ok(json!({ "suspended": suspended }))
            }
            CoreCommand::RoleBrowserDataClear { .. }
            | CoreCommand::ChromeProfileRequestQuit { .. }
            | CoreCommand::ChromeProfileApply { .. }
            | CoreCommand::CompatibilityRun { .. }
            | CoreCommand::DiagnosticsExport { .. }
            | CoreCommand::OverlayRequest { .. }
            | CoreCommand::BrowserRoleLaunch { .. }
            | CoreCommand::BrowserWorkspaceLaunch { .. }
            | CoreCommand::BrowserRoleStop { .. }
            | CoreCommand::BrowserWorkspaceStop { .. } => Err(CoreError::Internal(
                "asynchronous browser intent reached the synchronous core dispatcher".to_owned(),
            )),
        }
    }

    pub async fn invoke_async(self: &Arc<Self>, command: CoreCommand) -> CoreResult<Value> {
        match command {
            CoreCommand::RoleCreate { input } => {
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let mut roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
                let candidate = crate::domain::create_role(&games, &mut roles, input.clone())?;
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.refresh_local_storage_source_before_binding(&candidate)
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.invoke(CoreCommand::RoleCreate { input }))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::RoleBrowserDataClear { role_id } => {
                self.clear_role_browser_data(role_id).await
            }
            CoreCommand::ChromeProfileRequestQuit { import_id } => {
                let pending = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .get(&import_id)?;
                let platform = self.platform;
                tokio::task::spawn_blocking(move || {
                    rion_platform::request_graceful_chrome_quit(platform)
                        .map_err(|error| CoreError::Platform(error.to_string()))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while rion_platform::chrome_user_data_in_use(&pending.source_user_data_dir)
                    && std::time::Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                let preview = self
                    .chrome_profile_import
                    .lock()
                    .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
                    .refresh(&import_id)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileApply {
                import_id,
                game_id,
                consent_accepted,
                resolutions,
            } => {
                self.apply_chrome_profile_import(import_id, game_id, consent_accepted, resolutions)
                    .await
            }
            CoreCommand::GameDelete { id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_state(StateMutation::GameDelete { id })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::GamesDelete { ids } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_state(StateMutation::GamesDelete { ids })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::RoleUpdate { id, input } => {
                self.update_role_runtime_aware(id, input).await
            }
            CoreCommand::RoleDelete { id } => self.delete_role_runtime_aware(id).await,
            CoreCommand::RolesDelete { ids } => self.delete_roles_runtime_aware(ids).await,
            CoreCommand::WorkspaceCreate { input } => {
                let role_ids = workspace_create_role_ids(&input);
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(role_ids, StateMutation::WorkspaceCreate(input))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::WorkspaceUpdate { id, input } => {
                let mut role_ids = self
                    .state_workspace(&id)?
                    .slots
                    .into_iter()
                    .filter_map(|slot| slot.role_id)
                    .collect::<Vec<_>>();
                role_ids.extend(workspace_update_role_ids(&input));
                role_ids.push(workspace_operation_key(&id));
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(
                        role_ids,
                        StateMutation::WorkspaceUpdate { id, input },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::WorkspaceDelete { id } => self.delete_workspace_runtime_aware(id).await,
            CoreCommand::WorkspacesDelete { ids } => {
                self.delete_workspaces_runtime_aware(ids).await
            }
            CoreCommand::MacroCreate { input } => {
                let role_ids = input.role_ids.clone();
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_with_role_lease(role_ids, StateMutation::MacroCreate(input))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacroUpdate { id, input } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.update_macro_runtime_aware(id, input))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacroDelete { id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_macros_runtime_aware(
                        vec![id.clone()],
                        StateMutation::MacroDelete { id },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::MacrosDelete { ids } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.mutate_macros_runtime_aware(
                        ids.clone(),
                        StateMutation::MacrosDelete { ids },
                    )
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
            }
            CoreCommand::CompatibilityRun { game_id, versions } => {
                self.run_compatibility_check(game_id, versions).await
            }
            CoreCommand::DiagnosticsExport { path, snapshot } => {
                serde_json::to_value(self.export_diagnostics(path, snapshot).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::OverlayRequest {
                role_id,
                request_json,
                language,
            } => serde_json::to_value(
                self.handle_overlay_request(&role_id, &request_json, language)
                    .await?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserRoleLaunch {
                role_id,
                target,
                zoom_factor,
            } => {
                self.restore_legacy_session_if_needed(&role_id).await?;
                let core = Arc::clone(self);
                let statuses = tokio::task::spawn_blocking(move || {
                    core.launch_embedded_role(&role_id, target, zoom_factor.unwrap_or(1.0))
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??
                .into_iter()
                .map(embedded_status)
                .collect();
                serde_json::to_value(self.decorate_browser_statuses(statuses)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id,
                target,
            } => {
                let statuses = self
                    .launch_workspace_runtime_aware(workspace_id, target)
                    .await?
                    .into_iter()
                    .map(embedded_status)
                    .collect();
                serde_json::to_value(self.decorate_browser_statuses(statuses)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRoleStop { role_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_role(&role_id))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserWorkspaceStop { workspace_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.stop_embedded_workspace(&workspace_id))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "stopped": true }))
            }
            command => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || core.invoke(command))
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))?
            }
        }
    }

    async fn apply_chrome_profile_import(
        self: &Arc<Self>,
        import_id: String,
        game_id: String,
        consent_accepted: bool,
        resolutions: Vec<ChromeProfileImportResolutionRecord>,
    ) -> CoreResult<Value> {
        if !consent_accepted {
            return Err(CoreError::Domain {
                code: "CONSENT_REQUIRED",
                message: "Consent is required before importing Chrome profile data.".to_owned(),
            });
        }
        let pending = self
            .chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .get(&import_id)?;
        if rion_platform::chrome_user_data_in_use(&pending.source_user_data_dir) {
            return Err(CoreError::Domain {
                code: "CHROME_RUNNING",
                message: "Chrome is still using the selected profile.".to_owned(),
            });
        }
        if resolutions.is_empty() {
            return Err(CoreError::Domain {
                code: "PROFILE_SELECTION_EMPTY",
                message: "Select at least one Chrome profile to import.".to_owned(),
            });
        }
        let game = self.state_game(&game_id)?;
        let profiles = pending
            .profiles
            .iter()
            .map(|profile| (profile.id.as_str(), profile.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut seen_profiles = std::collections::HashSet::new();
        let mut seen_targets = std::collections::HashSet::new();
        for resolution in &resolutions {
            if !seen_profiles.insert(resolution.profile_id().to_owned())
                || !profiles.contains_key(resolution.profile_id())
            {
                return Err(CoreError::Domain {
                    code: "PROFILE_SELECTION_INVALID",
                    message: "Chrome profile selection is invalid.".to_owned(),
                });
            }
            if let ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } = resolution
                && !seen_targets.insert(target_role_id.clone())
            {
                return Err(CoreError::Domain {
                    code: "ROLE_TARGET_CONFLICT",
                    message: "Multiple Chrome profiles cannot replace the same role.".to_owned(),
                });
            }
        }
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let mut used_names = roles
            .iter()
            .filter(|role| role.game_id == game.id)
            .map(|role| role.name.to_lowercase())
            .collect::<std::collections::HashSet<_>>();
        let mut final_names = std::collections::HashSet::new();
        for resolution in &resolutions {
            let profile = profiles
                .get(resolution.profile_id())
                .expect("validated Chrome profile");
            let base_name = crate::chrome_profile_import::normalized_profile_name(
                &profile.name,
                &profile.directory_name,
            );
            let final_name = match resolution {
                ChromeProfileImportResolutionRecord::Create { .. } => {
                    if used_names.contains(&base_name.to_lowercase()) {
                        return Err(CoreError::Domain {
                            code: "ROLE_CONFLICT_RESOLUTION_REQUIRED",
                            message: "Choose how to handle each matching role.".to_owned(),
                        });
                    }
                    base_name
                }
                ChromeProfileImportResolutionRecord::Copy { .. } => {
                    crate::chrome_profile_import::copy_role_name(&base_name, &used_names)
                }
                ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } => roles
                    .iter()
                    .find(|role| role.id == *target_role_id && role.game_id == game.id)
                    .map(|role| role.name.clone())
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_TARGET_INVALID",
                        message: "The role selected for replacement is invalid.".to_owned(),
                    })?,
            };
            let normalized = final_name.to_lowercase();
            if !final_names.insert(normalized.clone()) {
                return Err(CoreError::Domain {
                    code: "FINAL_ROLE_NAME_CONFLICT",
                    message: "Multiple Chrome profiles cannot produce the same role name."
                        .to_owned(),
                });
            }
            used_names.insert(normalized);
        }

        self.chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .begin(&import_id)?;

        let total = resolutions.len() as u32;
        let mut items = Vec::with_capacity(resolutions.len());
        for (index, resolution) in resolutions.into_iter().enumerate() {
            if self.chrome_import_cancel_requested(&import_id)? {
                break;
            }
            let profile = profiles
                .get(resolution.profile_id())
                .expect("validated Chrome profile")
                .clone();
            let source_fingerprint = pending
                .source_fingerprints
                .get(&profile.id)
                .expect("validated Chrome profile fingerprint")
                .clone();
            self.emit_chrome_import_progress(
                &import_id,
                Some(&profile.id),
                "copying",
                index as u32,
                total,
            );
            let outcome = self
                .apply_one_chrome_profile(
                    &import_id,
                    &pending.source_user_data_dir,
                    &game,
                    profile.clone(),
                    &source_fingerprint,
                    resolution,
                )
                .await;
            let cancelled = outcome
                .as_ref()
                .is_err_and(|error| error.code() == "IMPORT_CANCELLED");
            let item = match outcome {
                Ok(item) => item,
                Err(error) => ChromeProfileImportItemResultRecord {
                    profile_id: profile.id.clone(),
                    role_id: None,
                    role_name: crate::chrome_profile_import::normalized_profile_name(
                        &profile.name,
                        &profile.directory_name,
                    ),
                    status: if cancelled { "cancelled" } else { "failed" }.to_owned(),
                    auth_state: ChromeProfileImportAuthStateRecord::NotApplicable,
                    cookie_count: 0,
                    local_storage_count: 0,
                    unsupported: ChromeProfileImportUnsupportedCountsRecord::default(),
                    warnings: Vec::new(),
                    error_code: Some(error.code().to_owned()),
                },
            };
            items.push(item);
            self.emit_chrome_import_progress(
                &import_id,
                Some(&profile.id),
                "complete",
                (index + 1) as u32,
                total,
            );
            if cancelled || self.chrome_import_cancel_requested(&import_id)? {
                break;
            }
        }
        self.chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .finish(&import_id);
        serde_json::to_value(ChromeProfileImportResultRecord { import_id, items })
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub async fn recover_pending_chrome_profile_imports(self: &Arc<Self>) -> CoreResult<Value> {
        let journals = self.with_runtime(|runtime| runtime.state.operation_journals())?;
        let mut recovered = 0_u32;
        let mut pending = 0_u32;
        for journal in journals
            .into_iter()
            .filter(|journal| journal.kind == "chrome_profile_import_v2")
        {
            let Some(role_id) = journal.payload.get("roleId").and_then(Value::as_str) else {
                pending += 1;
                continue;
            };
            let Some(transaction_id) = journal.payload.get("transactionId").and_then(Value::as_str)
            else {
                pending += 1;
                continue;
            };
            let transfer_directory = match crate::chrome_profile_import::session_transfer_directory(
                &self.user_data_dir,
                transaction_id,
            ) {
                Ok(path) => path,
                Err(_) => {
                    pending += 1;
                    continue;
                }
            };
            let committed = transfer_directory.join("committed").is_file();
            if !committed && transfer_directory.join("backup.enc").is_file() {
                let Some(launch_url) = journal.payload.get("launchUrl").and_then(Value::as_str)
                else {
                    pending += 1;
                    continue;
                };
                let paths = self.resolve_role_paths(role_id)?;
                if self
                    .request_core_effect(
                        role_id,
                        CoreEffectAction::ChromeProfileImportRollback {
                            transaction_id: transaction_id.to_owned(),
                            role_id: role_id.to_owned(),
                            launch_url: launch_url.to_owned(),
                            webview2_user_data_dir: paths.webview2_user_data_dir,
                            webkit_data_store_identifier: paths.webkit_data_store_identifier,
                        },
                        CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
                    )
                    .await
                    .is_err()
                {
                    pending += 1;
                    continue;
                }
            }
            if !committed
                && journal
                    .payload
                    .get("createdRole")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                && self
                    .read_typed_state_collection::<StateRoleRecord>("roles")?
                    .iter()
                    .any(|role| role.id == role_id)
                && self.delete_role_saga(role_id).is_err()
            {
                pending += 1;
                continue;
            }
            self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(journal.id.clone())
            })?;
            if transfer_directory.exists() {
                let _ = fs::remove_dir_all(&transfer_directory);
            }
            recovered += 1;
        }
        self.cleanup_orphaned_session_transfer_directories()?;
        Ok(json!({ "recovered": recovered, "pending": pending }))
    }

    fn cleanup_orphaned_session_transfer_directories(&self) -> CoreResult<()> {
        let active = self
            .with_runtime(|runtime| runtime.state.operation_journals())?
            .into_iter()
            .filter(|journal| journal.kind == "chrome_profile_import_v2")
            .filter_map(|journal| {
                journal
                    .payload
                    .get("transactionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<std::collections::HashSet<_>>();
        let root = self.user_data_dir.join(".session-transfers");
        let metadata = match fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(CoreError::Platform(error.to_string())),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CoreError::Platform(
                "Session-transfer root must be a real directory.".to_owned(),
            ));
        }
        for entry in fs::read_dir(&root).map_err(|error| CoreError::Platform(error.to_string()))? {
            let entry = entry.map_err(|error| CoreError::Platform(error.to_string()))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if uuid::Uuid::parse_str(&name).is_err() || active.contains(&name) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(entry.path())
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            }
        }
        Ok(())
    }

    fn chrome_import_cancel_requested(&self, import_id: &str) -> CoreResult<bool> {
        Ok(self
            .chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome import lock poisoned".to_owned()))?
            .is_cancel_requested(import_id))
    }

    fn ensure_role_session_recovery_complete(&self, role_id: &str) -> CoreResult<()> {
        let pending = self
            .with_runtime(|runtime| runtime.state.operation_journals())?
            .into_iter()
            .any(|journal| {
                journal.kind == "chrome_profile_import_v2"
                    && journal.payload.get("roleId").and_then(Value::as_str) == Some(role_id)
            });
        if pending {
            Err(CoreError::Domain {
                code: "ROLE_SESSION_RECOVERY_REQUIRED",
                message: "This role is waiting for browser session recovery before it can launch."
                    .to_owned(),
            })
        } else {
            Ok(())
        }
    }

    async fn restore_legacy_session_if_needed(self: &Arc<Self>, role_id: &str) -> CoreResult<()> {
        let current = self
            .with_runtime(|runtime| runtime.state.legacy_session_restore_get(role_id.to_owned()))?;
        if current
            .as_ref()
            .is_some_and(|record| record.status != "pending")
        {
            return Ok(());
        }
        self.with_runtime(|runtime| {
            runtime
                .state
                .legacy_session_restore_put(LegacySessionRestoreState {
                    role_id: role_id.to_owned(),
                    status: "pending".to_owned(),
                    source_fingerprint: current
                        .as_ref()
                        .and_then(|record| record.source_fingerprint.clone()),
                    cookie_count: 0,
                })
        })?;
        let role = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .find(|role| role.id == role_id)
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_NOT_FOUND",
                message: "Role not found.".to_owned(),
            })?;
        let candidates = crate::session_import::legacy_profile_candidates(self.platform, role_id);
        let platform = self.platform;
        let launch_url = role.launch_url.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            for candidate in candidates {
                if !candidate.is_dir() {
                    continue;
                }
                if let Ok(parsed) = crate::session_import::read_session_transfer(
                    &candidate,
                    platform,
                    &launch_url,
                    false,
                    crate::session_import::SessionTransferSource::LegacyRion,
                ) && !parsed.payload.cookies.is_empty()
                {
                    return Some(parsed);
                }
            }
            None
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let Some(parsed) = parsed else {
            self.with_runtime(|runtime| {
                runtime
                    .state
                    .legacy_session_restore_put(LegacySessionRestoreState {
                        role_id: role_id.to_owned(),
                        status: "unavailable".to_owned(),
                        source_fingerprint: None,
                        cookie_count: 0,
                    })
            })?;
            self.emit(vec![CoreEvent::LegacySessionsRestored {
                records: vec![LegacySessionRestoreRecord {
                    role_id: role_id.to_owned(),
                    status: "unavailable".to_owned(),
                    source_fingerprint: None,
                    cookie_count: 0,
                    warnings: vec!["LEGACY_SESSION_UNAVAILABLE".to_owned()],
                }],
            }]);
            return Ok(());
        };
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let staging = crate::chrome_profile_import::session_transfer_directory(
            &self.user_data_dir,
            &transaction_id,
        )?;
        let payload_for_staging = parsed.payload.clone();
        let staging_for_write = staging.clone();
        let staging_result = tokio::task::spawn_blocking(move || {
            let serialized = serde_json::to_vec(&payload_for_staging)
                .map_err(|error| CoreError::Internal(error.to_string()))?;
            let protected = rion_platform::protect_session_transfer(platform, &serialized)
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            crate::chrome_profile_import::persist_encrypted_staging(&staging_for_write, &protected)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        if staging_result.is_err() {
            let source_fingerprint = parsed.source_fingerprint.clone();
            let mut warnings = parsed.warnings.clone();
            warnings.push("LEGACY_SESSION_STAGING_FAILED".to_owned());
            self.with_runtime(|runtime| {
                runtime
                    .state
                    .legacy_session_restore_put(LegacySessionRestoreState {
                        role_id: role_id.to_owned(),
                        status: "unavailable".to_owned(),
                        source_fingerprint: Some(source_fingerprint.clone()),
                        cookie_count: 0,
                    })
            })?;
            let _ = fs::remove_dir_all(staging);
            self.emit(vec![CoreEvent::LegacySessionsRestored {
                records: vec![LegacySessionRestoreRecord {
                    role_id: role_id.to_owned(),
                    status: "unavailable".to_owned(),
                    source_fingerprint: Some(source_fingerprint),
                    cookie_count: 0,
                    warnings,
                }],
            }]);
            return Ok(());
        }
        let paths = self.resolve_role_paths(role_id)?;
        let effect = self
            .request_core_effect(
                role_id,
                CoreEffectAction::LegacySessionRestore {
                    transaction_id,
                    role_id: role_id.to_owned(),
                    launch_url: role.launch_url,
                    webview2_user_data_dir: paths.webview2_user_data_dir,
                    webkit_data_store_identifier: paths.webkit_data_store_identifier,
                },
                Duration::from_secs(30),
            )
            .await;
        let mut warnings = parsed.warnings.clone();
        let (status, cookie_count) = match effect {
            Ok(effect) => {
                let inserted = effect
                    .value_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Value>(value).ok())
                    .and_then(|value| value.get("insertedCookieCount").and_then(Value::as_u64))
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(parsed.payload.cookies.len() as u32);
                if inserted == 0 {
                    ("preservedExisting", 0)
                } else {
                    ("restored", inserted)
                }
            }
            Err(_) => {
                warnings.push("LEGACY_SESSION_APPLY_FAILED".to_owned());
                ("unavailable", 0)
            }
        };
        let _ = fs::remove_dir_all(&staging);
        let source_fingerprint = parsed.source_fingerprint.clone();
        self.with_runtime(|runtime| {
            runtime
                .state
                .legacy_session_restore_put(LegacySessionRestoreState {
                    role_id: role_id.to_owned(),
                    status: status.to_owned(),
                    source_fingerprint: Some(source_fingerprint.clone()),
                    cookie_count,
                })
        })?;
        self.emit(vec![CoreEvent::LegacySessionsRestored {
            records: vec![LegacySessionRestoreRecord {
                role_id: role_id.to_owned(),
                status: status.to_owned(),
                source_fingerprint: Some(source_fingerprint),
                cookie_count,
                warnings,
            }],
        }]);
        Ok(())
    }

    async fn launch_workspace_runtime_aware(
        self: &Arc<Self>,
        workspace_id: String,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        for _ in 0..4 {
            let workspace = self.state_workspace(&workspace_id)?;
            let expected_role_ids = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.clone())
                .collect::<Vec<_>>();
            for role_id in &expected_role_ids {
                self.restore_legacy_session_if_needed(role_id).await?;
            }
            let core = Arc::clone(self);
            let workspace_id = workspace_id.clone();
            let target = target.clone();
            let result = tokio::task::spawn_blocking(move || {
                core.launch_embedded_workspace_for_roles(&workspace_id, &expected_role_ids, target)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?;
            match result {
                Err(CoreError::Domain {
                    code: "WORKSPACE_DATA_CHANGED",
                    ..
                }) => continue,
                result => return result,
            }
        }
        Err(CoreError::Domain {
            code: "WORKSPACE_DATA_CHANGED",
            message: "The launch workspace kept changing while launch was waiting.".to_owned(),
        })
    }

    async fn apply_one_chrome_profile(
        self: &Arc<Self>,
        import_id: &str,
        source_user_data_dir: &std::path::Path,
        game: &StateGameRecord,
        profile: crate::model::ChromeProfileEntryRecord,
        expected_source_fingerprint: &str,
        resolution: ChromeProfileImportResolutionRecord,
    ) -> CoreResult<ChromeProfileImportItemResultRecord> {
        if rion_platform::chrome_user_data_in_use(source_user_data_dir) {
            return Err(CoreError::Domain {
                code: "CHROME_RUNNING",
                message: "Chrome started using the selected profile before it could be imported."
                    .to_owned(),
            });
        }
        let current_fingerprint = rion_platform::chrome_profile_source_fingerprint(
            source_user_data_dir,
            &profile.directory_name,
        )
        .map_err(|error| CoreError::Platform(error.to_string()))?;
        if current_fingerprint != expected_source_fingerprint {
            return Err(CoreError::Domain {
                code: "SOURCE_CHANGED",
                message:
                    "Chrome profile data changed after preview. Preview it again before importing."
                        .to_owned(),
            });
        }
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let base_name = crate::chrome_profile_import::normalized_profile_name(
            &profile.name,
            &profile.directory_name,
        );
        let identity_match = roles
            .iter()
            .find(|role| role.game_id == game.id && role.name.eq_ignore_ascii_case(&base_name));
        let (role_name, existing_role, replace_existing) = match &resolution {
            ChromeProfileImportResolutionRecord::Create { .. } => {
                if identity_match.is_some() {
                    return Err(CoreError::Domain {
                        code: "ROLE_CONFLICT_RESOLUTION_REQUIRED",
                        message: "Choose how to handle the matching role.".to_owned(),
                    });
                }
                (base_name.clone(), None, false)
            }
            ChromeProfileImportResolutionRecord::Copy { .. } => {
                let used = roles
                    .iter()
                    .filter(|role| role.game_id == game.id)
                    .map(|role| role.name.to_lowercase())
                    .collect::<std::collections::HashSet<_>>();
                (
                    crate::chrome_profile_import::copy_role_name(&base_name, &used),
                    None,
                    false,
                )
            }
            ChromeProfileImportResolutionRecord::Replace { target_role_id, .. } => {
                let role = roles
                    .iter()
                    .find(|role| role.id == *target_role_id && role.game_id == game.id)
                    .cloned()
                    .ok_or_else(|| CoreError::Domain {
                        code: "ROLE_TARGET_INVALID",
                        message: "The role selected for replacement is invalid.".to_owned(),
                    })?;
                if self
                    .browser_statuses()?
                    .iter()
                    .any(|status| status.role_id == role.id)
                {
                    return Err(CoreError::Domain {
                        code: "ROLE_BROWSER_DATA_IN_USE",
                        message: "Stop the role before replacing its session.".to_owned(),
                    });
                }
                (role.name.clone(), Some(role), true)
            }
        };
        let launch_url = existing_role
            .as_ref()
            .map(|role| role.launch_url.clone())
            .unwrap_or_else(|| game.default_launch_url.clone());
        let creates_role = existing_role.is_none();
        let role_id = existing_role
            .as_ref()
            .map(|role| role.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let operation_guard = BrowserOperationGuard::new(&self.browser_operations, lease.id);
        let paths = self.resolve_role_paths(&role_id)?;
        let auth_probe = chrome_import_auth_probe(game);
        if replace_existing && let Some(probe) = auth_probe {
            self.emit_chrome_import_progress(import_id, Some(&profile.id), "verifying", 0, 1);
            let auth_state = self
                .verify_chrome_import_auth(&role_id, &paths, probe)
                .await;
            if auth_state == ChromeProfileImportAuthStateRecord::Authenticated {
                operation_guard.complete()?;
                return Ok(ChromeProfileImportItemResultRecord {
                    profile_id: profile.id,
                    role_id: Some(role_id),
                    role_name,
                    status: "alreadyAuthenticated".to_owned(),
                    auth_state,
                    cookie_count: 0,
                    local_storage_count: 0,
                    unsupported: ChromeProfileImportUnsupportedCountsRecord::default(),
                    warnings: Vec::new(),
                    error_code: None,
                });
            }
        }
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let staging = crate::chrome_profile_import::session_transfer_directory(
            &self.user_data_dir,
            &transaction_id,
        )?;
        let source = source_user_data_dir.to_path_buf();
        let profile_directory = profile.directory_name.clone();
        let expected_source_fingerprint = expected_source_fingerprint.to_owned();
        let encrypted_staging = staging.clone();
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "copying", 0, 1);
        let platform = self.platform;
        let launch_for_parse = launch_url.clone();
        let include_all_cookie_paths = auth_probe.is_some();
        let parsed = tokio::task::spawn_blocking(move || {
            let parsed = crate::session_import::read_chrome_session_transfer(
                &source,
                &profile_directory,
                platform,
                &launch_for_parse,
                include_all_cookie_paths,
            )?;
            let current_fingerprint =
                rion_platform::chrome_profile_source_fingerprint(&source, &profile_directory)
                    .map_err(|error| CoreError::Platform(error.to_string()))?;
            if current_fingerprint != expected_source_fingerprint {
                return Err(CoreError::Domain {
                    code: "SOURCE_CHANGED",
                    message: "Chrome profile data changed while it was being read.".to_owned(),
                });
            }
            let serialized = serde_json::to_vec(&parsed.payload)
                .map_err(|error| CoreError::Internal(error.to_string()))?;
            let protected = rion_platform::protect_session_transfer(platform, &serialized)
                .map_err(|error| CoreError::Platform(error.to_string()))?;
            crate::chrome_profile_import::persist_encrypted_staging(
                &encrypted_staging,
                &protected,
            )?;
            Ok::<_, CoreError>(parsed)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))??;
        if self.chrome_import_cancel_requested(import_id)? {
            let _ = fs::remove_dir_all(&staging);
            return Err(chrome_import_cancelled());
        }
        if parsed.payload.cookies.is_empty() && parsed.payload.local_storage.is_empty() {
            let _ = fs::remove_dir_all(&staging);
            return Err(CoreError::Domain {
                code: "PROFILE_SESSION_EMPTY",
                message: "No transferable session data was found for this game.".to_owned(),
            });
        }

        let operation_id = format!("chrome-profile-import-{transaction_id}");
        let mut journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "chrome_profile_import_v2".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({
                "importId": import_id,
                "profileId": profile.id,
                "roleId": role_id,
                "createdRole": creates_role,
                "transactionId": transaction_id,
                "launchUrl": launch_url,
                "sourceFingerprint": parsed.source_fingerprint,
            }),
        };
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        let rollback = ChromeImportRollbackContext {
            operation_id: operation_id.clone(),
            transaction_id: transaction_id.clone(),
            role_id: role_id.clone(),
            launch_url: launch_url.clone(),
            webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
            webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
            staging: staging.clone(),
        };
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "backingUp", 0, 1);
        if let Err(error) = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportSnapshot {
                    transaction_id: transaction_id.clone(),
                    role_id: role_id.clone(),
                    launch_url: launch_url.clone(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                    replace_existing,
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await
        {
            let _ = self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(operation_id.clone())
            });
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        journal.phase = "snapshotted".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(chrome_import_cancelled());
        }
        journal.phase = "applying".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        self.emit_chrome_import_progress(import_id, Some(&profile.id), "applying", 0, 1);
        let effect = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportApply {
                    transaction_id: transaction_id.clone(),
                    role_id: role_id.clone(),
                    launch_url: launch_url.clone(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                    replace_existing,
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await;
        if let Err(error) = effect {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(error);
        }
        let auth_state = if let Some(probe) = auth_probe {
            self.emit_chrome_import_progress(import_id, Some(&profile.id), "verifying", 0, 1);
            self.verify_chrome_import_auth_after_apply(&role_id, &paths, probe)
                .await
        } else {
            ChromeProfileImportAuthStateRecord::NotApplicable
        };
        journal.phase = "verified".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, None)
                .await?;
            return Err(chrome_import_cancelled());
        }

        let created_role_id = if creates_role {
            let created = self.mutate_state(StateMutation::RoleCreateWithId {
                id: role_id.clone(),
                input: crate::model::RoleCreateInputRecord {
                    game_id: game.id.clone(),
                    name: role_name.clone(),
                    launch_url: Some(launch_url.clone()),
                    notes: Some("Imported from a local Chrome profile.".to_owned()),
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                    local_storage_source_role_id: None,
                },
            });
            match created {
                Ok(_) => Some(role_id.clone()),
                Err(error) => {
                    self.rollback_chrome_profile_import_item(&rollback, None)
                        .await?;
                    return Err(error);
                }
            }
        } else {
            None
        };
        journal.phase = "metadataCommitted".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if self.chrome_import_cancel_requested(import_id)? {
            self.rollback_chrome_profile_import_item(&rollback, created_role_id.as_deref())
                .await?;
            return Err(chrome_import_cancelled());
        }
        journal.phase = "committing".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
        if let Err(error) = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::ChromeProfileImportCommit {
                    transaction_id: transaction_id.clone(),
                },
                Duration::from_secs(10),
            )
            .await
        {
            self.rollback_chrome_profile_import_item(&rollback, created_role_id.as_deref())
                .await?;
            return Err(error);
        }
        self.with_runtime(|runtime| runtime.state.delete_operation_journal(operation_id))?;
        let _ = fs::remove_dir_all(&staging);
        operation_guard.complete()?;
        let status = chrome_import_status(auth_state);
        Ok(ChromeProfileImportItemResultRecord {
            profile_id: profile.id,
            role_id: Some(role_id),
            role_name,
            status: status.to_owned(),
            auth_state,
            cookie_count: parsed.payload.cookies.len() as u32,
            local_storage_count: parsed.payload.local_storage.len() as u32,
            unsupported: parsed.unsupported,
            warnings: parsed.warnings,
            error_code: None,
        })
    }

    async fn verify_chrome_import_auth(
        &self,
        role_id: &str,
        paths: &RolePathsRecord,
        probe: ChromeImportAuthProbe,
    ) -> ChromeProfileImportAuthStateRecord {
        let effect = self
            .request_core_effect(
                role_id,
                CoreEffectAction::ChromeProfileImportVerify {
                    role_id: role_id.to_owned(),
                    verification_url: probe.verification_url.to_owned(),
                    authenticated_path: probe.authenticated_path.to_owned(),
                    login_path: probe.login_path.to_owned(),
                    webview2_user_data_dir: paths.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: paths.webkit_data_store_identifier.clone(),
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await;
        match effect.and_then(|result| effect_value::<ChromeImportAuthProbeResult>(&result)) {
            Ok(result) => result.auth_state,
            Err(_) => ChromeProfileImportAuthStateRecord::Indeterminate,
        }
    }

    async fn verify_chrome_import_auth_after_apply(
        &self,
        role_id: &str,
        paths: &RolePathsRecord,
        probe: ChromeImportAuthProbe,
    ) -> ChromeProfileImportAuthStateRecord {
        let mut auth_state = self.verify_chrome_import_auth(role_id, paths, probe).await;
        for delay in CHROME_PROFILE_IMPORT_AUTH_RETRY_DELAYS {
            if auth_state != ChromeProfileImportAuthStateRecord::NotAuthenticated {
                break;
            }
            tokio::time::sleep(delay).await;
            auth_state = self.verify_chrome_import_auth(role_id, paths, probe).await;
        }
        auth_state
    }

    async fn rollback_chrome_profile_import_item(
        self: &Arc<Self>,
        context: &ChromeImportRollbackContext,
        created_role_id: Option<&str>,
    ) -> CoreResult<()> {
        if self
            .request_core_effect(
                &context.role_id,
                CoreEffectAction::ChromeProfileImportRollback {
                    transaction_id: context.transaction_id.clone(),
                    role_id: context.role_id.clone(),
                    launch_url: context.launch_url.clone(),
                    webview2_user_data_dir: context.webview2_user_data_dir.clone(),
                    webkit_data_store_identifier: context.webkit_data_store_identifier.clone(),
                },
                CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT,
            )
            .await
            .is_err()
        {
            return Err(CoreError::Domain {
                code: "SESSION_IMPORT_ROLLBACK_PENDING",
                message:
                    "The prior browser session is waiting for recovery before this role can launch."
                        .to_owned(),
            });
        }
        if let Some(created_role_id) = created_role_id {
            self.delete_role_saga(created_role_id)?;
        }
        self.with_runtime(|runtime| {
            runtime
                .state
                .delete_operation_journal(context.operation_id.clone())
        })?;
        let _ = fs::remove_dir_all(&context.staging);
        Ok(())
    }

    fn emit_chrome_import_progress(
        &self,
        import_id: &str,
        profile_id: Option<&str>,
        phase: &str,
        completed: u32,
        total: u32,
    ) {
        self.emit(vec![CoreEvent::ChromeProfileImportProgress {
            progress: ChromeProfileImportProgressRecord {
                import_id: import_id.to_owned(),
                profile_id: profile_id.map(str::to_owned),
                phase: phase.to_owned(),
                completed,
                total,
            },
        }]);
    }

    async fn update_role_runtime_aware(
        self: &Arc<Self>,
        id: String,
        input: crate::model::RoleUpdateInputRecord,
    ) -> CoreResult<Value> {
        let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
        let mut roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let current = roles
            .iter()
            .find(|role| role.id == id)
            .cloned()
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_NOT_FOUND",
                message: "Role not found.".to_owned(),
            })?;
        let candidate = crate::domain::update_role(&games, &mut roles, &id, input.clone())?;
        let mut role_ids = vec![id.clone()];
        role_ids.extend(current.local_storage_source_role_id.clone());
        role_ids.extend(candidate.local_storage_source_role_id.clone());
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let games = core.read_typed_state_collection::<StateGameRecord>("games")?;
            let mut roles = core.read_typed_state_collection::<StateRoleRecord>("roles")?;
            let current = roles
                .iter()
                .find(|role| role.id == id)
                .cloned()
                .ok_or_else(|| CoreError::Domain {
                    code: "ROLE_NOT_FOUND",
                    message: "Role not found.".to_owned(),
                })?;
            let candidate = crate::domain::update_role(&games, &mut roles, &id, input.clone())?;
            if candidate.local_storage_source_role_id != current.local_storage_source_role_id {
                core.refresh_local_storage_source_before_binding(&candidate)?;
            }
            if candidate.game_id != current.game_id
                || candidate.launch_url != current.launch_url
                || candidate.local_storage_source_role_id != current.local_storage_source_role_id
            {
                core.stop_embedded_role_under_active_lease(&id)?;
            }
            core.mutate_state(StateMutation::RoleUpdate { id, input })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn refresh_local_storage_source_before_binding(
        &self,
        candidate: &StateRoleRecord,
    ) -> CoreResult<()> {
        let Some(source_id) = candidate.local_storage_source_role_id.as_deref() else {
            return Ok(());
        };
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let source = roles
            .iter()
            .find(|role| role.id == source_id)
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_LOCAL_STORAGE_SOURCE_NOT_FOUND",
                message: "The localStorage source role was not found.".to_owned(),
            })?;
        let game = self.state_game(&candidate.game_id)?;
        self.run_effect_plan(vec![effect_step(
            source_id,
            CoreEffectAction::LocalStorageSyncRefresh {
                source_role_id: source.id.clone(),
                source_launch_url: source.launch_url.clone(),
                origin: crate::domain::launch_origin(&source.launch_url)?,
                keys: game.local_storage_sync_keys,
            },
            Duration::from_secs(45),
            None,
        )])?;
        Ok(())
    }

    async fn delete_role_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        self.ensure_role_exists(&id)?;
        self.cancel_embedded_operations(std::slice::from_ref(&id))?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![id.clone()],
                kind: "destructiveMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            core.stop_embedded_role_under_active_lease(&id)?;
            core.delete_role_saga_under_active_lease(&id)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn delete_roles_runtime_aware(self: &Arc<Self>, ids: Vec<String>) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let existing = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| role.id)
            .collect::<std::collections::HashSet<_>>();
        let mut candidates = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            candidates.push(id);
        }
        if candidates.is_empty() {
            return Ok(json!({ "deletedIds": [], "skipped": skipped }));
        }
        self.cancel_embedded_operations(&candidates)?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: candidates.clone(),
                kind: "destructiveMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let mut eligible = Vec::new();
            for id in candidates {
                match core.stop_embedded_role_under_active_lease(&id) {
                    Ok(()) => eligible.push(id),
                    Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
                }
            }
            let mut result = if eligible.is_empty() {
                json!({ "deletedIds": [], "skipped": [] })
            } else {
                core.delete_roles_saga_under_active_lease(eligible)?
            };
            if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
                result_skipped.extend(skipped);
            }
            Ok::<_, CoreError>(result)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = match &result {
            Ok(value) => {
                let deleted_ids = value
                    .get("deletedIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                self.browser_operations
                    .complete_destructive_with_retained_roles(&lease.id, &deleted_ids)
            }
            Err(_) => self.browser_operations.abort(&lease.id),
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn delete_workspace_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        let workspace =
            serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                "launchWorkspaces",
                "id",
                &id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            )?)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let mut operation_role_ids = workspace
            .slots
            .into_iter()
            .filter_map(|slot| slot.role_id)
            .collect::<Vec<_>>();
        operation_role_ids.extend(
            self.browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .snapshot()
                .workspaces
                .into_iter()
                .find(|workspace| workspace.workspace_id == id)
                .into_iter()
                .flat_map(|workspace| workspace.role_ids),
        );
        operation_role_ids.push(workspace_operation_key(&id));
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: operation_role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            core.stop_embedded_workspace_under_active_lease(&id)?;
            core.mutate_state(StateMutation::WorkspaceDelete { id })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn delete_workspaces_runtime_aware(
        self: &Arc<Self>,
        ids: Vec<String>,
    ) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let workspaces =
            self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?;
        let existing = workspaces
            .iter()
            .map(|workspace| workspace.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let mut eligible = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            eligible.push(id);
        }
        if eligible.is_empty() {
            return Ok(json!({ "deletedIds": [], "skipped": skipped }));
        }
        let eligible_set = eligible
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let mut operation_role_ids = workspaces
            .iter()
            .filter(|workspace| eligible_set.contains(workspace.id.as_str()))
            .flat_map(|workspace| workspace.slots.iter())
            .filter_map(|slot| slot.role_id.clone())
            .collect::<Vec<_>>();
        operation_role_ids.extend(
            self.browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .snapshot()
                .workspaces
                .into_iter()
                .filter(|workspace| eligible_set.contains(workspace.workspace_id.as_str()))
                .flat_map(|workspace| workspace.role_ids),
        );
        operation_role_ids.extend(eligible.iter().map(|id| workspace_operation_key(id)));
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: operation_role_ids,
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let mut stopped = Vec::new();
            for id in eligible {
                match core.stop_embedded_workspace_under_active_lease(&id) {
                    Ok(()) => stopped.push(id),
                    Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
                }
            }
            let mut result = core.mutate_state(StateMutation::WorkspacesDelete { ids: stopped })?;
            if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
                result_skipped.extend(skipped);
            }
            Ok::<_, CoreError>(result)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn mutate_with_role_lease(
        &self,
        role_ids: Vec<String>,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        let role_ids = role_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect::<Vec<_>>();
        if role_ids.is_empty() {
            return self.mutate_state(mutation);
        }
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids,
            kind: "normal".to_owned(),
        })?;
        let result = self.mutate_state(mutation);
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn update_macro_runtime_aware(
        &self,
        id: String,
        input: crate::model::MacroUpdateInputRecord,
    ) -> CoreResult<Value> {
        let mut macros = self.read_typed_state_collection::<StateMacroRecord>("macros")?;
        let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let candidate = crate::domain::update_macro(&mut macros, &id, input.clone())?;
        if candidate.role_ids.iter().any(|role_id| {
            !roles
                .iter()
                .any(|candidate_role| candidate_role.id == *role_id)
        }) {
            return Err(CoreError::Domain {
                code: "MACRO_ROLE_ID_INVALID",
                message: "Macro role IDs must reference existing roles.".to_owned(),
            });
        }
        let stop_active = input.enabled == Some(false);
        self.mutate_macros_with_mode(
            vec![id.clone()],
            stop_active,
            StateMutation::MacroUpdate { id, input },
        )
    }

    fn mutate_macros_runtime_aware(
        &self,
        ids: Vec<String>,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        self.mutate_macros_with_mode(ids, true, mutation)
    }

    fn mutate_macros_with_mode(
        &self,
        ids: Vec<String>,
        stop_active: bool,
        mutation: StateMutation,
    ) -> CoreResult<Value> {
        let lease = self.macro_runtime.acquire_mutation(ids, stop_active)?;
        let result = self.mutate_state(mutation);
        let release = self.macro_runtime.release_mutation(&lease);
        match (result, release) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn delete_role_saga(&self, id: &str) -> CoreResult<Value> {
        self.ensure_role_exists(id)?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![id.to_owned()],
            kind: "destructiveMutation".to_owned(),
        })?;
        let result = self.delete_role_saga_under_active_lease(id);
        let completion = if result.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn delete_role_saga_under_active_lease(&self, id: &str) -> CoreResult<Value> {
        self.ensure_role_exists(id)?;
        self.macro_runtime.stop_role(id)?;
        let operation_id = format!("role-delete-{}", uuid::Uuid::new_v4());
        let mut journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "role_delete_v1".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({ "roleId": id }),
        };
        self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))?;
        if let Err(error) =
            crate::role_browser_data::quarantine(&self.user_data_dir, id, &operation_id)
        {
            let _ = self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(operation_id.clone())
            });
            return Err(error);
        }
        journal.phase = "quarantined".to_owned();
        if let Err(error) =
            self.with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))
        {
            let _ = crate::role_browser_data::restore_quarantine(
                &self.user_data_dir,
                id,
                &operation_id,
            );
            let _ = self.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(operation_id.clone())
            });
            return Err(error);
        }
        let deletion = self.mutate_state(StateMutation::RoleDelete {
            id: id.to_owned(),
            operation_id: Some(operation_id.clone()),
        });
        let value = match deletion {
            Ok(value) => value,
            Err(error) => {
                let restore = crate::role_browser_data::restore_quarantine(
                    &self.user_data_dir,
                    id,
                    &operation_id,
                );
                let _ = self.with_runtime(|runtime| {
                    runtime.state.delete_operation_journal(operation_id.clone())
                });
                restore?;
                return Err(error);
            }
        };
        crate::role_browser_data::discard_quarantine(&self.user_data_dir, &operation_id)?;
        self.with_runtime(|runtime| runtime.state.delete_operation_journal(operation_id))?;
        Ok(value)
    }

    fn delete_roles_saga_under_active_lease(&self, ids: Vec<String>) -> CoreResult<Value> {
        for id in &ids {
            self.ensure_role_exists(id)?;
            self.macro_runtime.stop_role(id)?;
        }
        (|| {
            let mut journals = Vec::new();
            for id in &ids {
                let operation_id = format!("role-delete-{}", uuid::Uuid::new_v4());
                let mut journal = OperationJournalRecord {
                    id: operation_id.clone(),
                    kind: "role_delete_v1".to_owned(),
                    phase: "prepared".to_owned(),
                    payload: json!({ "roleId": id }),
                };
                if let Err(error) = self
                    .with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))
                {
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
                if let Err(error) =
                    crate::role_browser_data::quarantine(&self.user_data_dir, id, &operation_id)
                {
                    let _ = self.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id)
                    });
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
                journal.phase = "quarantined".to_owned();
                if let Err(error) = self
                    .with_runtime(|runtime| runtime.state.put_operation_journal(journal.clone()))
                {
                    let current = vec![(id.clone(), journal.id.clone())];
                    rollback_role_delete_journals(self, &current);
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
                journals.push((id.clone(), journal.id));
            }
            let operation_ids = journals.iter().cloned().collect();
            let deletion = self.mutate_state(StateMutation::RolesDelete {
                ids: ids.clone(),
                operation_ids,
            });
            let value = match deletion {
                Ok(value) => value,
                Err(error) => {
                    rollback_role_delete_journals(self, &journals);
                    return Err(error);
                }
            };
            for (_, operation_id) in &journals {
                crate::role_browser_data::discard_quarantine(&self.user_data_dir, operation_id)?;
                self.with_runtime(|runtime| {
                    runtime.state.delete_operation_journal(operation_id.clone())
                })?;
            }
            Ok(value)
        })()
    }

    async fn clear_role_browser_data(self: &Arc<Self>, role_id: String) -> CoreResult<Value> {
        self.ensure_role_exists(&role_id)?;
        self.cancel_embedded_operations(std::slice::from_ref(&role_id))?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let core = Arc::clone(self);
        let prepared_role_id = role_id.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            core.stop_embedded_role_under_active_lease(&prepared_role_id)?;
            core.macro_runtime.stop_role(&prepared_role_id)?;
            let role = core
                .read_typed_state_collection::<StateRoleRecord>("roles")?
                .into_iter()
                .find(|role| role.id == prepared_role_id)
                .ok_or_else(|| CoreError::Domain {
                    code: "ROLE_NOT_FOUND",
                    message: "Role not found.".to_owned(),
                })?;
            let game = core.state_game(&role.game_id)?;
            let origin = crate::domain::launch_origin(&role.launch_url)?;
            Ok::<_, CoreError>((game, origin))
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let (game, local_storage_sync_origin) = match prepared {
            Ok(value) => value,
            Err(error) => {
                let _ = self.browser_operations.abort(&lease.id);
                return Err(error);
            }
        };
        let operation_id = format!("role-browser-clear-{}", uuid::Uuid::new_v4());
        let role_paths = crate::role_browser_data::paths(&self.user_data_dir, &role_id)?;
        let journal = OperationJournalRecord {
            id: operation_id.clone(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "prepared".to_owned(),
            payload: json!({ "roleId": role_id, "hadDirectory": false }),
        };
        let prepare = {
            let core = Arc::clone(self);
            let role_id = role_id.clone();
            let operation_id = operation_id.clone();
            tokio::task::spawn_blocking(move || {
                core.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
                let had_directory = match crate::role_browser_data::quarantine(
                    &core.user_data_dir,
                    &role_id,
                    &operation_id,
                ) {
                    Ok(had_directory) => had_directory,
                    Err(error) => {
                        let _ = core.with_runtime(|runtime| {
                            runtime.state.delete_operation_journal(operation_id.clone())
                        });
                        return Err(error);
                    }
                };
                if let Err(error) = core.with_runtime(|runtime| {
                    runtime.state.put_operation_journal(OperationJournalRecord {
                        id: operation_id.clone(),
                        kind: "role_browser_data_clear_v1".to_owned(),
                        phase: "quarantined".to_owned(),
                        payload: json!({
                            "roleId": role_id.clone(),
                            "hadDirectory": had_directory
                        }),
                    })
                }) {
                    if had_directory {
                        let _ = crate::role_browser_data::restore_quarantine(
                            &core.user_data_dir,
                            &role_id,
                            &operation_id,
                        );
                    }
                    let _ = core.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id)
                    });
                    return Err(error);
                }
                Ok::<_, CoreError>(had_directory)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
        };
        let had_directory = match prepare {
            Ok(value) => value,
            Err(error) => {
                let _ = self.browser_operations.abort(&lease.id);
                return Err(error);
            }
        };

        let effect = self
            .request_core_effect(
                &role_id,
                CoreEffectAction::RoleBrowserDataClearSession {
                    role_id: role_id.clone(),
                    origin: local_storage_sync_origin,
                    local_storage_sync_keys: game.local_storage_sync_keys,
                    webview2_user_data_dir: role_paths.webview2_user_data_dir,
                    webkit_data_store_identifier: role_paths.webkit_data_store_identifier,
                },
                Duration::from_secs(30),
            )
            .await;
        if let Err(error) = effect {
            let _ = rollback_role_browser_data_clear(self, &role_id, &operation_id, had_directory);
            let _ = self.browser_operations.abort(&lease.id);
            return Err(error);
        }

        let commit = {
            let core = Arc::clone(self);
            let role_id = role_id.clone();
            let operation_id = operation_id.clone();
            tokio::task::spawn_blocking(move || {
                crate::role_browser_data::ensure(&core.user_data_dir, &role_id)?;
                let role = core.mutate_state(StateMutation::RoleBrowserDataReset {
                    id: role_id.clone(),
                    operation_id: operation_id.clone(),
                });
                let role = match role {
                    Ok(role) => role,
                    Err(error) => {
                        rollback_role_browser_data_clear(
                            &core,
                            &role_id,
                            &operation_id,
                            had_directory,
                        )?;
                        return Err(error);
                    }
                };
                core.with_runtime(|runtime| {
                    runtime
                        .state
                        .legacy_session_restore_put(LegacySessionRestoreState {
                            role_id: role_id.clone(),
                            status: "disabledAfterClear".to_owned(),
                            source_fingerprint: None,
                            cookie_count: 0,
                        })
                })?;
                if crate::role_browser_data::discard_quarantine(&core.user_data_dir, &operation_id)
                    .is_ok()
                {
                    let _ = core.with_runtime(|runtime| {
                        runtime.state.delete_operation_journal(operation_id)
                    });
                }
                Ok::<_, CoreError>(role)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
        };
        let completion = if commit.is_ok() {
            self.browser_operations.complete(&lease.id)
        } else {
            self.browser_operations.abort(&lease.id)
        };
        match (commit, completion) {
            (Ok(role), Ok(())) => Ok(role),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn run_compatibility_check(
        self: &Arc<Self>,
        game_id: String,
        versions: RuntimeVersionRecord,
    ) -> CoreResult<Value> {
        let plan = {
            let _guard = self.state_mutation_guard()?;
            let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
            let (plan, statuses) = {
                let mut runtime = self.compatibility_runtime()?;
                let plan = runtime.prepare(&games, &game_id, &versions)?;
                (plan, runtime.statuses())
            };
            self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
            plan
        };
        let started = std::time::Instant::now();
        let mut window_created = false;
        let operation = async {
            self.request_compatibility_effect(
                &game_id,
                CoreEffectAction::CompatibilityCreateWindow { plan: plan.clone() },
                Duration::from_secs(5),
            )
            .await?;
            window_created = true;
            self.request_compatibility_effect(
                &game_id,
                CoreEffectAction::CompatibilityConfigureSession {
                    game_id: game_id.clone(),
                },
                Duration::from_secs(10),
            )
            .await?;
            self.transition_compatibility(&game_id, CompatibilityRunPhase::Loading)?;
            let loaded = self
                .request_compatibility_effect(
                    &game_id,
                    CoreEffectAction::CompatibilityLoadUrl {
                        game_id: game_id.clone(),
                        url: plan.launch_url.clone(),
                    },
                    compatibility_load_timeout(),
                )
                .await
                .map_err(compatibility_load_error)?;
            let loaded: Value = effect_value(&loaded)?;
            let final_origin = loaded
                .get("finalUrl")
                .and_then(Value::as_str)
                .and_then(|value| url::Url::parse(value).ok())
                .map(|url| url.origin().ascii_serialization());

            self.transition_compatibility(&game_id, CompatibilityRunPhase::Probing)?;
            let graphics = match self
                .request_compatibility_effect(
                    &game_id,
                    CoreEffectAction::CompatibilityProbeGraphics {
                        game_id: game_id.clone(),
                        source: crate::web_graphics_probe::WEB_GRAPHICS_PROBE_SOURCE.to_owned(),
                    },
                    Duration::from_secs(2),
                )
                .await
            {
                Ok(result) => {
                    crate::web_graphics_probe::normalize_web_graphics(effect_value(&result)?)
                }
                Err(error) => crate::web_graphics_probe::unavailable_probe(Some(error.to_string())),
            };
            Ok::<_, CoreError>((final_origin, graphics))
        }
        .await;

        let cancelled = self.compatibility_runtime()?.is_cancel_requested(&game_id);
        let duration_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
        let outcome = if cancelled {
            CompatibilityCheckOutcome::Cancelled { duration_ms }
        } else {
            match operation {
                Ok((final_origin, graphics)) => CompatibilityCheckOutcome::Loaded {
                    duration_ms,
                    final_origin,
                    graphics,
                },
                Err(error) => CompatibilityCheckOutcome::Failed {
                    duration_ms,
                    error_code: error.code().to_owned(),
                },
            }
        };

        self.transition_compatibility(&game_id, CompatibilityRunPhase::CleaningUp)?;
        self.compatibility_runtime()?
            .set_effect_operation(&game_id, None)?;
        if window_created {
            let _ = self
                .request_core_effect(
                    &game_id,
                    CoreEffectAction::CompatibilityCleanupWindow {
                        game_id: game_id.clone(),
                    },
                    Duration::from_secs(10),
                )
                .await;
        }
        let report = self
            .compatibility_runtime()?
            .build_report(&game_id, outcome)?;
        let saved = self.mutate_state(StateMutation::CompatibilityReportSave(Box::new(report)))?;
        let statuses = {
            let mut runtime = self.compatibility_runtime()?;
            runtime.finish(&game_id);
            runtime.statuses()
        };
        self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
        Ok(saved)
    }

    async fn request_compatibility_effect(
        &self,
        game_id: &str,
        action: CoreEffectAction,
        timeout: Duration,
    ) -> CoreResult<CoreEffectResult> {
        if self.compatibility_runtime()?.is_cancel_requested(game_id) {
            return Err(CoreError::Effect {
                code: "CORE_OPERATION_CANCELLED".to_owned(),
                message: "The compatibility check was cancelled.".to_owned(),
            });
        }
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan {
                steps: vec![effect_step(game_id, action, timeout, None)],
            })?;
        self.compatibility_runtime()?
            .set_effect_operation(game_id, Some(handle.operation_id.clone()))?;
        if self.compatibility_runtime()?.is_cancel_requested(game_id) {
            let _ = self.operation_actor.cancel(&handle.operation_id)?;
        }
        let outcome = handle.outcome.await.map_err(|_| {
            CoreError::Internal("compatibility effect operation stopped".to_owned())
        })?;
        self.compatibility_runtime()?
            .set_effect_operation(game_id, None)?;
        if let Some(error) = outcome.error {
            return Err(CoreError::Effect {
                code: error.code,
                message: error.message,
            });
        }
        outcome.results.into_iter().next().ok_or_else(|| {
            CoreError::Internal("compatibility effect returned no result".to_owned())
        })
    }

    fn transition_compatibility(
        &self,
        game_id: &str,
        phase: CompatibilityRunPhase,
    ) -> CoreResult<()> {
        let statuses = {
            let mut runtime = self.compatibility_runtime()?;
            runtime.transition(game_id, phase)?;
            runtime.statuses()
        };
        self.emit(vec![CoreEvent::CompatibilityStatuses { statuses }]);
        Ok(())
    }

    fn state_game(&self, game_id: &str) -> CoreResult<StateGameRecord> {
        self.read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .find(|game| game.id == game_id)
            .ok_or_else(|| CoreError::Domain {
                code: "GAME_NOT_FOUND",
                message: "Game not found.".to_owned(),
            })
    }

    fn state_workspace(&self, workspace_id: &str) -> CoreResult<StateLaunchWorkspaceRecord> {
        self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| CoreError::Domain {
                code: "WORKSPACE_NOT_FOUND",
                message: "Launch workspace not found.".to_owned(),
            })
    }

    async fn request_core_effect(
        &self,
        handle_id: &str,
        action: CoreEffectAction,
        timeout: Duration,
    ) -> CoreResult<CoreEffectResult> {
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan {
                steps: vec![effect_step(handle_id, action, timeout, None)],
            })?;
        let outcome = handle.outcome.await.map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        })?;
        if let Some(error) = outcome.error {
            return Err(CoreError::Effect {
                code: error.code,
                message: error.message,
            });
        }
        outcome
            .results
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Internal("core effect returned no result".to_owned()))
    }

    async fn handle_overlay_request(
        &self,
        role_id: &str,
        request_json: &str,
        language: Option<String>,
    ) -> CoreResult<MacroOverlayViewModelRecord> {
        self.ensure_role_exists(role_id)?;
        let language = {
            let mut current = self
                .overlay_language
                .lock()
                .map_err(|_| CoreError::Internal("overlay language lock poisoned".to_owned()))?;
            if let Some(language) = language {
                validate_overlay_language(&language)?;
                *current = Some(language);
            }
            current.clone()
        };
        let request = crate::overlay::parse_request(request_json)?;
        let mut start_summary = None;
        match request {
            MacroOverlayRequestRecord::Activate
            | MacroOverlayRequestRecord::GameInputContext { .. }
            | MacroOverlayRequestRecord::List => {}
            MacroOverlayRequestRecord::Open => {
                self.request_core_effect(
                    role_id,
                    CoreEffectAction::OverlayOpenMacroPage {
                        role_id: role_id.to_owned(),
                    },
                    Duration::from_secs(10),
                )
                .await?;
            }
            MacroOverlayRequestRecord::CopyCoordinate { coordinate } => {
                self.request_core_effect(
                    role_id,
                    CoreEffectAction::OverlayCopyCoordinate { coordinate },
                    Duration::from_secs(10),
                )
                .await?;
            }
            MacroOverlayRequestRecord::Start { macro_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.start(MacroStartRequest {
                    macros,
                    settings,
                    macro_id,
                    source_role_id: Some(role_id.to_owned()),
                    active_role_ids: self.macro_active_role_ids()?,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Toggle { macro_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.toggle(MacroStartRequest {
                    macros,
                    settings,
                    macro_id,
                    source_role_id: Some(role_id.to_owned()),
                    active_role_ids: self.macro_active_role_ids()?,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Stop { macro_id } => {
                let (macros, _) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                self.macro_runtime
                    .stop_macro_from_role(&macro_id, role_id)?;
            }
            MacroOverlayRequestRecord::Press { macro_id, press_id } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                let assigned_count = macros
                    .iter()
                    .find(|definition| definition.id == macro_id)
                    .map_or(0, |definition| definition.role_ids.len());
                let statuses = self.macro_runtime.press(MacroPressRequest {
                    start: MacroStartRequest {
                        macros,
                        settings,
                        macro_id,
                        source_role_id: Some(role_id.to_owned()),
                        active_role_ids: self.macro_active_role_ids()?,
                    },
                    press_id,
                })?;
                start_summary = Some(MacroOverlayStartSummaryRecord {
                    skipped_count: assigned_count.saturating_sub(statuses.len()) as u32,
                    started_count: statuses.len() as u32,
                });
            }
            MacroOverlayRequestRecord::Release {
                macro_id,
                press_id,
                release_mode,
            } => {
                let (macros, _) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                crate::overlay::ensure_macro_available(&macros, role_id, &macro_id)?;
                self.macro_runtime.release(MacroReleaseRequest {
                    macro_id,
                    source_role_id: role_id.to_owned(),
                    press_id,
                    mode: release_mode.unwrap_or_else(|| "complete_first_iteration".to_owned()),
                })?;
            }
        }
        self.overlay_view_model(role_id, language, start_summary)
    }

    fn overlay_view_model(
        &self,
        role_id: &str,
        language: Option<String>,
        start_summary: Option<MacroOverlayStartSummaryRecord>,
    ) -> CoreResult<MacroOverlayViewModelRecord> {
        let (macros, macro_badge_position) =
            self.with_runtime(|runtime| runtime.state.overlay_configuration())?;
        let macros = crate::overlay::available_macros(&macros, role_id);
        let macro_ids = macros
            .iter()
            .map(|definition| definition.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let statuses = self
            .macro_runtime
            .statuses()?
            .into_iter()
            .filter(|status| {
                status.role_id == role_id && macro_ids.contains(status.macro_id.as_str())
            })
            .collect();
        Ok(MacroOverlayViewModelRecord {
            detached: false,
            language,
            macro_badge_position,
            macros,
            start_summary,
            statuses,
        })
    }

    async fn acquire_browser_operation_async(
        self: &Arc<Self>,
        request: BrowserOperationRequest,
    ) -> CoreResult<crate::model::BrowserOperationLease> {
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || core.browser_operations.acquire(request))
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    fn emit_browser_statuses(&self) {
        if let Ok(statuses) = self.browser_statuses() {
            self.emit(vec![CoreEvent::BrowserStatuses { statuses }]);
        }
    }

    pub fn browser_statuses(&self) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let statuses = embedded_role_statuses(
            self.browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .snapshot()
                .roles,
        );
        self.decorate_browser_statuses(statuses)
    }

    fn macro_active_role_ids(&self) -> CoreResult<Vec<String>> {
        let mut role_ids = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot()
            .roles
            .into_iter()
            .filter(|role| role.runtime == "embedded" && role.state == "running")
            .map(|role| role.role_id)
            .collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        Ok(role_ids)
    }

    pub fn browser_workspace_statuses(
        &self,
    ) -> CoreResult<Vec<crate::model::BrowserWorkspaceStatusRecord>> {
        let snapshot = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot();
        let role_statuses =
            self.decorate_browser_statuses(embedded_role_statuses(snapshot.roles.clone()))?;
        let status_by_role = role_statuses
            .into_iter()
            .map(|status| (status.role_id.clone(), status))
            .collect::<std::collections::HashMap<_, _>>();
        let role_ids_by_workspace = snapshot
            .workspaces
            .iter()
            .map(|workspace| (workspace.workspace_id.clone(), workspace.role_ids.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut statuses = embedded_workspace_statuses(snapshot.workspaces);
        for status in &mut statuses {
            let role_statuses = role_ids_by_workspace
                .get(&status.workspace_id)
                .into_iter()
                .flatten()
                .filter_map(|role_id| status_by_role.get(role_id))
                .collect::<Vec<_>>();
            let Some(first) = role_statuses.first() else {
                continue;
            };
            status.resolved_engine = role_statuses
                .iter()
                .all(|candidate| candidate.resolved_engine == first.resolved_engine)
                .then_some(first.resolved_engine)
                .flatten();
            status.host_kind = role_statuses
                .iter()
                .all(|candidate| candidate.host_kind == first.host_kind)
                .then_some(first.host_kind)
                .flatten();
            status.issue_reason = role_statuses
                .iter()
                .find_map(|candidate| candidate.issue_reason);
            status.capability_snapshot = role_statuses
                .iter()
                .all(|candidate| candidate.capability_snapshot == first.capability_snapshot)
                .then(|| first.capability_snapshot.clone())
                .flatten();
        }
        Ok(statuses)
    }

    fn decorate_browser_statuses(
        &self,
        mut statuses: Vec<crate::model::BrowserRoleStatusRecord>,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        if statuses.is_empty() {
            return Ok(statuses);
        }
        let roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let games = self
            .read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        let workspaces =
            self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?;
        let active_workspace_by_role = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .roles
            .into_iter()
            .filter_map(|role| {
                role.workspace_id
                    .map(|workspace_id| (role.role_id, workspace_id))
            })
            .collect::<std::collections::HashMap<_, _>>();
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        for status in &mut statuses {
            let Some(role) = roles.get(&status.role_id) else {
                continue;
            };
            let Some(game) = games.get(&role.game_id) else {
                continue;
            };
            let system_runtime = self.system_webview_runtime()?;
            let resolution = self.resolve_role_browser_engine(role, game, &settings)?;
            status.resolved_engine = Some(resolution.resolved_engine);
            status.host_kind = Some(resolution.host_kind);
            status.issue_reason = resolution.issue_reason;
            status.capability_snapshot = Some(system_runtime.capability_snapshot.clone());
        }
        for workspace in &workspaces {
            let active_role_ids = active_workspace_by_role
                .iter()
                .filter_map(|(role_id, workspace_id)| {
                    (workspace_id == &workspace.id).then_some(role_id.as_str())
                })
                .collect::<std::collections::HashSet<_>>();
            if active_role_ids.is_empty() {
                continue;
            }
            let workspace_roles = active_role_ids
                .iter()
                .filter_map(|role_id| roles.get(*role_id).cloned())
                .collect::<Vec<_>>();
            let resolution =
                self.resolve_workspace_browser_engine(&workspace_roles, &games, &settings)?;
            let capability_snapshot = Some(self.system_webview_runtime()?.capability_snapshot);
            for status in &mut statuses {
                if status.runtime_mode != "embedded"
                    || !active_role_ids.contains(status.role_id.as_str())
                {
                    continue;
                }
                status.resolved_engine = Some(resolution.resolved_engine);
                status.host_kind = Some(resolution.host_kind);
                status.issue_reason = match status.issue_reason {
                    Some(reason @ crate::model::SystemWebViewIssueReason::RuntimeCrashed) => {
                        Some(reason)
                    }
                    _ => resolution.issue_reason,
                };
                status.capability_snapshot = capability_snapshot.clone();
            }
        }
        Ok(statuses)
    }

    fn register_system_webview_runtime(
        &self,
        mut registration: SystemWebViewRuntimeRegistrationRecord,
    ) -> CoreResult<SystemWebViewRuntimeRegistrationRecord> {
        let expected_platform = match self.platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        };
        let expected_engine = match self.platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        };
        if registration.platform != expected_platform || registration.engine != expected_engine {
            return Err(CoreError::InvalidInput(
                "system WebView registration does not match the current platform".to_owned(),
            ));
        }
        if registration.adapter_version.trim().is_empty() || registration.adapter_version.len() > 64
        {
            return Err(CoreError::InvalidInput(
                "system WebView adapter version is invalid".to_owned(),
            ));
        }
        let probe = rion_platform::probe_system_webview(self.platform);
        let baseline_available = [
            registration.capability_snapshot.navigation,
            registration.capability_snapshot.persistent_session,
            registration.capability_snapshot.audio_mute,
        ]
        .into_iter()
        .all(system_capability_available);
        registration.available &= probe.available && baseline_available;
        if !registration.available && registration.failure_reason.is_none() {
            registration.failure_reason = Some(
                if self.platform == rion_platform::Platform::Macos
                    && !registration
                        .capability_snapshot
                        .trusted_input
                        .eq(&crate::model::EngineCapabilityStatus::Supported)
                {
                    crate::model::SystemWebViewIssueReason::WebkitSpiUnavailable
                } else {
                    crate::model::SystemWebViewIssueReason::RuntimeCreationFailed
                },
            );
        }
        let mut runtime = self
            .system_webview_runtime
            .write()
            .map_err(|_| CoreError::Internal("system WebView runtime lock poisoned".to_owned()))?;
        *runtime = registration.clone();
        self.system_webview_issues
            .write()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?
            .clear();
        Ok(registration)
    }

    fn system_webview_runtime(&self) -> CoreResult<SystemWebViewRuntimeRegistrationRecord> {
        self.system_webview_runtime
            .read()
            .map(|runtime| runtime.clone())
            .map_err(|_| CoreError::Internal("system WebView runtime lock poisoned".to_owned()))
    }

    fn resolve_role_browser_engine(
        &self,
        role: &StateRoleRecord,
        game: &StateGameRecord,
        settings: &GameBrowserSettingsRecord,
    ) -> CoreResult<crate::model::BrowserEngineResolutionRecord> {
        let system_runtime = self.system_webview_runtime()?;
        let (system_available, system_failure_reason) =
            self.system_runtime_preflight(role, game, settings, &system_runtime)?;
        Ok(crate::engine_resolution::resolve_browser_engine(
            crate::engine_resolution::BrowserEngineResolutionInput {
                platform: self.platform,
                system_available,
                system_failure_reason,
            },
        ))
    }

    fn resolve_workspace_browser_engine(
        &self,
        roles: &[StateRoleRecord],
        games: &std::collections::HashMap<String, StateGameRecord>,
        settings: &GameBrowserSettingsRecord,
    ) -> CoreResult<crate::model::BrowserEngineResolutionRecord> {
        let resolutions = roles
            .iter()
            .map(|role| {
                let game = games.get(&role.game_id).ok_or_else(|| CoreError::Domain {
                    code: "GAME_NOT_FOUND",
                    message: "Game not found.".to_owned(),
                })?;
                self.resolve_role_browser_engine(role, game, settings)
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let system_engine = match self.platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        };
        Ok(crate::model::BrowserEngineResolutionRecord {
            resolved_engine: system_engine,
            host_kind: crate::model::BrowserHostKind::SystemNative,
            issue_reason: resolutions
                .iter()
                .find_map(|resolution| resolution.issue_reason),
        })
    }

    fn system_runtime_preflight(
        &self,
        role: &StateRoleRecord,
        game: &StateGameRecord,
        settings: &GameBrowserSettingsRecord,
        runtime: &SystemWebViewRuntimeRegistrationRecord,
    ) -> CoreResult<(bool, Option<crate::model::SystemWebViewIssueReason>)> {
        if let Some(reason) = self
            .system_webview_issues
            .read()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?
            .get(&role.id)
            .copied()
        {
            return Ok((false, Some(reason)));
        }
        if !runtime.available {
            return Ok((false, runtime.failure_reason));
        }
        let role_uses_macros = self
            .read_typed_state_collection::<StateMacroRecord>("macros")?
            .into_iter()
            .any(|macro_record| {
                macro_record.enabled && macro_record.role_ids.iter().any(|id| id == &role.id)
            });
        if role_uses_macros
            && (!system_capability_verified(runtime.capability_snapshot.trusted_input)
                || !system_capability_verified(runtime.capability_snapshot.background_input)
                || !system_capability_available(runtime.capability_snapshot.frame_evaluation))
        {
            return Ok((
                false,
                Some(crate::model::SystemWebViewIssueReason::MacroInputUnavailable),
            ));
        }
        let cache_key = self.engine_compatibility_cache_key(game, settings, runtime)?;
        if self
            .with_runtime(|runtime| runtime.state.engine_compatibility_cache_get(cache_key))?
            .is_some_and(|record| !record.compatible)
        {
            return Ok((
                false,
                Some(crate::model::SystemWebViewIssueReason::CachedCompatibilityFailure),
            ));
        }
        Ok((true, None))
    }

    fn reset_system_launch_retry_state(&self, roles: &[StateRoleRecord]) -> CoreResult<()> {
        let game_ids = roles
            .iter()
            .map(|role| role.game_id.clone())
            .collect::<std::collections::HashSet<_>>();
        {
            let mut issues = self.system_webview_issues.write().map_err(|_| {
                CoreError::Internal("system WebView issue lock poisoned".to_owned())
            })?;
            for role in roles {
                let retryable = matches!(
                    issues.get(&role.id),
                    Some(
                        crate::model::SystemWebViewIssueReason::CachedCompatibilityFailure
                            | crate::model::SystemWebViewIssueReason::RuntimeCreationFailed
                    )
                );
                if retryable {
                    issues.remove(&role.id);
                }
            }
        }
        for game_id in game_ids {
            self.with_runtime(|runtime| {
                runtime
                    .state
                    .engine_compatibility_cache_delete_game(game_id)
            })?;
        }
        Ok(())
    }

    fn engine_compatibility_cache_key(
        &self,
        game: &StateGameRecord,
        settings: &GameBrowserSettingsRecord,
        runtime: &SystemWebViewRuntimeRegistrationRecord,
    ) -> CoreResult<crate::model::EngineCompatibilityCacheKeyRecord> {
        let settings_json = serde_json::to_vec(&json!({
            "defaultLaunchUrl": &game.default_launch_url,
            "fonts": &settings.fonts,
            "workspace": &settings.workspace
        }))
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let probe = rion_platform::probe_system_webview(self.platform);
        Ok(crate::model::EngineCompatibilityCacheKeyRecord {
            app_version: self.app_version.clone(),
            adapter_version: runtime.adapter_version.clone(),
            platform: runtime.platform.clone(),
            os_build: sysinfo::System::kernel_version()
                .or_else(sysinfo::System::os_version)
                .unwrap_or_else(|| "unknown".to_owned()),
            webview_version: probe
                .runtime_version
                .unwrap_or_else(|| "unknown".to_owned()),
            engine: runtime.engine,
            game_id: game.id.clone(),
            game_updated_at: game.updated_at.clone(),
            settings_fingerprint: format!("{:x}", Sha256::digest(settings_json)),
        })
    }

    fn record_system_engine_compatibility(
        &self,
        roles: &[StateRoleRecord],
        compatible: bool,
        issue_reason: Option<crate::model::SystemWebViewIssueReason>,
    ) -> CoreResult<()> {
        let runtime = self.system_webview_runtime()?;
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let games = self
            .read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        for game in roles.iter().filter_map(|role| games.get(&role.game_id)) {
            let record = crate::model::EngineCompatibilityCacheRecord {
                key: self.engine_compatibility_cache_key(game, &settings, &runtime)?,
                compatible,
                capability_snapshot: runtime.capability_snapshot.clone(),
                issue_reason,
                checked_at: chrono::Utc::now().to_rfc3339(),
            };
            self.with_runtime(|runtime| runtime.state.engine_compatibility_cache_put(record))?;
        }
        Ok(())
    }

    fn record_system_webview_issue(
        &self,
        role_ids: &[String],
        reason: crate::model::SystemWebViewIssueReason,
    ) -> CoreResult<()> {
        let mut issues = self
            .system_webview_issues
            .write()
            .map_err(|_| CoreError::Internal("system WebView issue lock poisoned".to_owned()))?;
        role_ids.iter().for_each(|role_id| {
            issues.insert(role_id.clone(), reason);
        });
        Ok(())
    }

    pub fn invoke_browser_runtime(
        &self,
        command: crate::model::BrowserRuntimeCommand,
    ) -> CoreResult<crate::model::BrowserRuntimeResult> {
        self.browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .invoke(command)
    }

    fn launch_embedded_role(
        &self,
        role_id: &str,
        target: EmbeddedLaunchTargetRecord,
        zoom_factor: f64,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        self.ensure_role_session_recovery_complete(role_id)?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![role_id.to_owned()],
            kind: "normal".to_owned(),
        })?;
        let result = (|| {
            let _sequence = self.embedded_runtime_sequence.acquire()?;
            self.launch_embedded_role_with_lease(role_id, target, zoom_factor)
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn launch_embedded_role_with_lease(
        &self,
        role_id: &str,
        target: EmbeddedLaunchTargetRecord,
        zoom_factor: f64,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let role = serde_json::from_value::<StateRoleRecord>(self.read_state_record(
            "roles",
            "id",
            role_id,
            "ROLE_NOT_FOUND",
            "Role not found.",
        )?)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        if let Some(runtime_role) = snapshot
            .roles
            .iter()
            .find(|candidate| candidate.role_id == role_id && candidate.runtime == "embedded")
        {
            if runtime_role.state != "running" {
                return Err(CoreError::Domain {
                    code: "ROLE_ALREADY_RUNNING",
                    message: "The role is already launching or stopping.".to_owned(),
                });
            }
            let tab_id = runtime_role.tab_id.clone().ok_or_else(|| {
                CoreError::Internal("embedded role runtime is missing its tab".to_owned())
            })?;
            self.apply_embedded_runtime_command_inner(
                vec![BrowserRuntimeCommand::ActivateTab {
                    tab_id: tab_id.clone(),
                }],
                None,
                vec![self.embedded_tab_window_id(&tab_id)?],
                vec![self.embedded_tab_window_id(&tab_id)?],
                None,
                None,
            )?;
            self.run_effect_plan(vec![effect_step(
                role_id,
                CoreEffectAction::EmbeddedFocusRole {
                    role_id: role_id.to_owned(),
                    zoom_factor: Some(zoom_factor),
                },
                Duration::from_secs(10),
                None,
            )])?;
            return Ok(vec![embedded_launch_result(
                role_id,
                runtime_role
                    .launched_at
                    .clone()
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            )]);
        }
        if snapshot
            .roles
            .iter()
            .any(|candidate| candidate.role_id == role_id)
        {
            return Err(CoreError::Domain {
                code: "ROLE_ALREADY_RUNNING",
                message: "The role is already running.".to_owned(),
            });
        }

        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let game = self.state_game(&role.game_id)?;
        let available_roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        self.reset_system_launch_retry_state(std::slice::from_ref(&role))?;
        let resolution = self.resolve_role_browser_engine(&role, &game, &settings)?;
        require_system_resolution(&resolution)?;
        let resolved_engine = resolution.resolved_engine;

        let tab_id = self
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: self.saved_game_window_tab_id(&target.window_id, "role", &role.id)?,
                source_id: role.id.clone(),
                name: role.name.clone(),
                window_id: target.window_id.clone(),
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_ids: vec![role.id.clone()],
            })?
            .created_tab_id
            .ok_or_else(|| CoreError::Internal("embedded tab was not created".to_owned()))?;
        self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role.id.clone(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id.clone()),
            state: "launching".to_owned(),
            launched_at: None,
        })?;
        self.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
            tab_id: tab_id.clone(),
        })?;

        let tab = EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            source_id: role.id.clone(),
            name: role.name.clone(),
            workspace_id: None,
            workspace_template: None,
            workspace_appearance: settings.workspace,
            target,
            roles: vec![EmbeddedRoleViewEffectRecord {
                role: role.clone(),
                local_storage_sync: local_storage_sync_role_effect(
                    &role,
                    &available_roles,
                    std::slice::from_ref(&game),
                )?,
                resolved_engine,
                rect: full_window_rect(),
                zoom_factor,
                zoom_mode: "fixed".to_owned(),
            }],
        };
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let launch =
            self.run_system_launch(&tab_id, tab, std::slice::from_ref(&role), runtime_snapshot);
        if let Err(error) = launch {
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role.id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }

        let launched_at = chrono::Utc::now().to_rfc3339();
        if let Err(error) = self.apply_embedded_runtime_command_inner(
            vec![BrowserRuntimeCommand::RoleTransition {
                role_id: role.id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: None,
                tab_id: Some(tab_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            }],
            None,
            Vec::new(),
            Vec::new(),
            None,
            None,
        ) {
            let _ = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role.id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        Ok(vec![embedded_launch_result(&role.id, launched_at)])
    }

    fn launch_embedded_workspace(
        &self,
        workspace_id: &str,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let workspace =
            serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                "launchWorkspaces",
                "id",
                workspace_id,
                "WORKSPACE_NOT_FOUND",
                "Launch workspace not found.",
            )?)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let expected_role_ids = workspace
            .slots
            .iter()
            .filter_map(|slot| slot.role_id.clone())
            .collect::<Vec<_>>();
        self.launch_embedded_workspace_for_roles(workspace_id, &expected_role_ids, target)
    }

    fn launch_embedded_workspace_for_roles(
        &self,
        workspace_id: &str,
        expected_role_ids: &[String],
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        if expected_role_ids.is_empty() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLES_REQUIRED",
                message: "The launch workspace has no roles.".to_owned(),
            });
        }
        let mut operation_role_ids = expected_role_ids.to_vec();
        operation_role_ids.push(workspace_operation_key(workspace_id));
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: operation_role_ids,
            kind: "normal".to_owned(),
        })?;
        let result = (|| {
            let workspace =
                serde_json::from_value::<StateLaunchWorkspaceRecord>(self.read_state_record(
                    "launchWorkspaces",
                    "id",
                    workspace_id,
                    "WORKSPACE_NOT_FOUND",
                    "Launch workspace not found.",
                )?)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            let role_ids = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.clone())
                .collect::<Vec<_>>();
            let expected = expected_role_ids
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            let current = role_ids
                .iter()
                .map(String::as_str)
                .collect::<std::collections::HashSet<_>>();
            if current != expected {
                return Err(CoreError::Domain {
                    code: "WORKSPACE_DATA_CHANGED",
                    message: "The launch workspace roles changed while launch was waiting."
                        .to_owned(),
                });
            }
            for role_id in &role_ids {
                self.ensure_role_session_recovery_complete(role_id)?;
            }
            let _sequence = self.embedded_runtime_sequence.acquire()?;
            let snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            if let Some(runtime_workspace) = snapshot
                .workspaces
                .iter()
                .find(|candidate| candidate.workspace_id == workspace_id)
            {
                if runtime_workspace.state != "running" {
                    return Err(CoreError::Domain {
                        code: "WORKSPACE_ALREADY_RUNNING",
                        message: "The workspace is already launching or stopping.".to_owned(),
                    });
                }
                let tab_id = runtime_workspace.tab_id.clone().ok_or_else(|| {
                    CoreError::Internal("embedded workspace runtime is missing its tab".to_owned())
                })?;
                self.apply_embedded_runtime_command_inner(
                    vec![BrowserRuntimeCommand::ActivateTab {
                        tab_id: tab_id.clone(),
                    }],
                    None,
                    vec![self.embedded_tab_window_id(&tab_id)?],
                    vec![self.embedded_tab_window_id(&tab_id)?],
                    None,
                    None,
                )?;
                return Ok(runtime_workspace
                    .role_ids
                    .iter()
                    .map(|role_id| {
                        let launched_at = snapshot
                            .roles
                            .iter()
                            .find(|role| &role.role_id == role_id)
                            .and_then(|role| role.launched_at.clone())
                            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                        embedded_launch_result(role_id, launched_at)
                    })
                    .collect());
            }
            self.launch_embedded_workspace_with_lease(workspace, role_ids, target)
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn launch_embedded_workspace_with_lease(
        &self,
        workspace: StateLaunchWorkspaceRecord,
        role_ids: Vec<String>,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let available_roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let roles = role_ids
            .iter()
            .filter_map(|role_id| available_roles.get(role_id).cloned())
            .collect::<Vec<_>>();
        if roles.len() != role_ids.len() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLE_NOT_FOUND",
                message: "A launch workspace role no longer exists.".to_owned(),
            });
        }
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let available_games = self
            .read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .map(|game| (game.id.clone(), game))
            .collect::<std::collections::HashMap<_, _>>();
        let all_roles = available_roles.values().cloned().collect::<Vec<_>>();
        let all_games = available_games.values().cloned().collect::<Vec<_>>();
        self.reset_system_launch_retry_state(&roles)?;
        let workspace_resolution =
            self.resolve_workspace_browser_engine(&roles, &available_games, &settings)?;
        require_system_resolution(&workspace_resolution)?;
        let workspace_resolved_engine = workspace_resolution.resolved_engine;
        self.invoke_browser_runtime(BrowserRuntimeCommand::BeginWorkspace {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
            window_id: Some(target.window_id.clone()),
            role_ids: role_ids.clone(),
        })?;
        let tab_id = match self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            tab_id: self.saved_game_window_tab_id(&target.window_id, "workspace", &workspace.id)?,
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            window_id: target.window_id.clone(),
            tab_type: "workspace".to_owned(),
            workspace_id: Some(workspace.id.clone()),
            role_ids: role_ids.clone(),
        }) {
            Ok(result) => result
                .created_tab_id
                .ok_or_else(|| CoreError::Internal("workspace tab was not created".to_owned()))?,
            Err(error) => {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                    workspace_id: workspace.id,
                });
                return Err(error);
            }
        };
        for role_id in &role_ids {
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: Some(workspace.id.clone()),
                tab_id: Some(tab_id.clone()),
                state: "launching".to_owned(),
                launched_at: None,
            })?;
        }
        self.invoke_browser_runtime(BrowserRuntimeCommand::ActivateTab {
            tab_id: tab_id.clone(),
        })?;
        let effect_roles = workspace
            .slots
            .iter()
            .filter_map(|slot| {
                let role_id = slot.role_id.as_ref()?;
                let role = roles.iter().find(|role| &role.id == role_id)?.clone();
                Some((slot, role))
            })
            .map(|(slot, role)| {
                Ok(EmbeddedRoleViewEffectRecord {
                    local_storage_sync: local_storage_sync_role_effect(
                        &role, &all_roles, &all_games,
                    )?,
                    role,
                    resolved_engine: workspace_resolved_engine,
                    rect: slot.rect.clone(),
                    zoom_factor: slot.browser_zoom_percent.unwrap_or(100.0) / 100.0,
                    zoom_mode: if slot.browser_zoom_percent.is_some() {
                        "fixed".to_owned()
                    } else {
                        "adaptive".to_owned()
                    },
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let tab = EmbeddedTabEffectRecord {
            tab_id: tab_id.clone(),
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            workspace_id: Some(workspace.id.clone()),
            workspace_template: Some(workspace.template.clone()),
            workspace_appearance: settings.workspace,
            target,
            roles: effect_roles,
        };
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let launch = self.run_system_launch(&tab_id, tab, &roles, runtime_snapshot);
        if let Err(error) = launch {
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace.id.clone(),
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }

        let launched_at = chrono::Utc::now().to_rfc3339();
        let mut commands = Vec::with_capacity(role_ids.len() + 1);
        for role_id in &role_ids {
            commands.push(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: Some(workspace.id.clone()),
                tab_id: Some(tab_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            });
        }
        commands.push(BrowserRuntimeCommand::SetWorkspaceState {
            workspace_id: workspace.id.clone(),
            state: "running".to_owned(),
        });
        if let Err(error) = self.apply_embedded_runtime_command_inner(
            commands,
            None,
            Vec::new(),
            Vec::new(),
            None,
            None,
        ) {
            let _ = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            for role_id in &role_ids {
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                });
            }
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace.id,
            });
            self.publish_embedded_runtime_snapshot_best_effort();
            return Err(error);
        }
        Ok(role_ids
            .iter()
            .map(|role_id| embedded_launch_result(role_id, launched_at.clone()))
            .collect())
    }

    fn stop_embedded_role(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, true)
    }

    fn stop_embedded_role_under_active_lease(&self, role_id: &str) -> CoreResult<()> {
        self.stop_embedded_role_with_operation_lease(role_id, false)
    }

    fn stop_embedded_role_with_operation_lease(
        &self,
        role_id: &str,
        acquire_operation_lease: bool,
    ) -> CoreResult<()> {
        self.cancel_embedded_operations(&[role_id.to_owned()])?;
        let lease = acquire_operation_lease
            .then(|| {
                self.browser_operations.acquire(BrowserOperationRequest {
                    role_ids: vec![role_id.to_owned()],
                    kind: "normal".to_owned(),
                })
            })
            .transpose()?;
        let result = (|| {
            let _sequence = self.embedded_runtime_sequence.acquire()?;
            let snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let previous_runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .clone();
            let Some(role) = snapshot
                .roles
                .iter()
                .find(|candidate| candidate.role_id == role_id && candidate.runtime == "embedded")
                .cloned()
            else {
                return Ok(());
            };
            let tab_id = role
                .tab_id
                .clone()
                .ok_or_else(|| CoreError::Internal("embedded role has no tab".to_owned()))?;
            let source_window_id = snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .map(|tab| tab.window_id.clone());
            self.macro_runtime.stop_role(role_id)?;
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.to_owned(),
                runtime: "embedded".to_owned(),
                workspace_id: role.workspace_id.clone(),
                tab_id: Some(tab_id.clone()),
                state: "stopping".to_owned(),
                launched_at: role.launched_at.clone(),
            })?;
            let tab_role_count = snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .map_or(1, |tab| tab.role_ids.len());
            let next_active_tab_id = (tab_role_count <= 1)
                .then(|| next_active_tab_after_removal(&snapshot, &tab_id))
                .flatten();
            let action = if tab_role_count <= 1 {
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id,
                }
            } else {
                CoreEffectAction::EmbeddedDestroyRole {
                    role_id: role_id.to_owned(),
                }
            };
            if let Err(error) = self.run_effect_plan(vec![effect_step(
                role_id,
                action,
                Duration::from_secs(15),
                None,
            )]) {
                if let Ok(mut runtime) = self.browser_runtime.lock() {
                    *runtime = previous_runtime;
                }
                self.publish_embedded_runtime_snapshot_best_effort();
                return Err(error);
            }
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role_id.to_owned(),
            })?;
            if tab_role_count <= 1 {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: tab_id.clone(),
                })?;
                if let Some(workspace_id) = role.workspace_id {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                        workspace_id,
                    })?;
                }
            }
            let removed_window_ids = if tab_role_count <= 1 {
                source_window_id
                    .iter()
                    .cloned()
                    .collect::<std::collections::HashSet<_>>()
            } else {
                std::collections::HashSet::new()
            };
            self.publish_embedded_runtime_snapshot_with_removed(&removed_window_ids)?;
            Ok(())
        })();
        let Some(lease) = lease else {
            return result;
        };
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    fn stop_embedded_workspace(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, true)
    }

    fn stop_embedded_workspace_under_active_lease(&self, workspace_id: &str) -> CoreResult<()> {
        self.stop_embedded_workspace_with_operation_lease(workspace_id, false)
    }

    fn stop_embedded_workspace_with_operation_lease(
        &self,
        workspace_id: &str,
        acquire_operation_lease: bool,
    ) -> CoreResult<()> {
        let initial_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let initial_role_ids = initial_snapshot
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.workspace_id == workspace_id && workspace.runtime == "embedded"
            })
            .map(|workspace| workspace.role_ids.clone())
            .unwrap_or_default();
        self.cancel_embedded_operations(&initial_role_ids)?;
        let lease = acquire_operation_lease
            .then(|| {
                let mut operation_role_ids = initial_role_ids.clone();
                operation_role_ids.push(workspace_operation_key(workspace_id));
                self.browser_operations.acquire(BrowserOperationRequest {
                    role_ids: operation_role_ids,
                    kind: "normal".to_owned(),
                })
            })
            .transpose()?;
        let result = (|| {
            let _sequence = self.embedded_runtime_sequence.acquire()?;
            let snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let previous_runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
                .clone();
            let Some(workspace) = snapshot
                .workspaces
                .iter()
                .find(|workspace| {
                    workspace.workspace_id == workspace_id && workspace.runtime == "embedded"
                })
                .cloned()
            else {
                return Ok(());
            };
            let tab_id = workspace
                .tab_id
                .clone()
                .ok_or_else(|| CoreError::Internal("embedded workspace has no tab".to_owned()))?;
            let source_window_id = snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .map(|tab| tab.window_id.clone());
            for role_id in &workspace.role_ids {
                self.macro_runtime.stop_role(role_id)?;
                self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                    role_id: role_id.clone(),
                    runtime: "embedded".to_owned(),
                    workspace_id: Some(workspace_id.to_owned()),
                    tab_id: Some(tab_id.clone()),
                    state: "stopping".to_owned(),
                    launched_at: snapshot
                        .roles
                        .iter()
                        .find(|role| role.role_id == *role_id)
                        .and_then(|role| role.launched_at.clone()),
                })?;
            }
            let next_active_tab_id = next_active_tab_after_removal(&snapshot, &tab_id);
            if let Err(error) = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id,
                },
                Duration::from_secs(15),
                None,
            )]) {
                if let Ok(mut runtime) = self.browser_runtime.lock() {
                    *runtime = previous_runtime;
                }
                self.publish_embedded_runtime_snapshot_best_effort();
                return Err(error);
            }
            for role_id in &workspace.role_ids {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                })?;
            }
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id })?;
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace_id.to_owned(),
            })?;
            let removed_window_ids = source_window_id
                .iter()
                .cloned()
                .collect::<std::collections::HashSet<_>>();
            self.publish_embedded_runtime_snapshot_with_removed(&removed_window_ids)?;
            Ok(())
        })();
        let Some(lease) = lease else {
            return result;
        };
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    fn run_effect_plan(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        self.run_effect_plan_for_roles(steps, &[])
    }

    fn run_system_launch(
        &self,
        tab_id: &str,
        tab: EmbeddedTabEffectRecord,
        roles: &[StateRoleRecord],
        runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
        let launch = self.run_effect_plan_for_roles(
            embedded_launch_effects(tab_id, tab.clone(), roles, runtime_snapshot.clone()),
            &role_ids,
        );
        let error = match launch {
            Ok(outcome) => {
                self.record_system_engine_compatibility(roles, true, None)?;
                return Ok(outcome);
            }
            Err(error) => error,
        };
        if error.code() == "LAUNCH_CANCELLED" {
            return Err(error);
        }
        let failure_reason = crate::model::SystemWebViewIssueReason::RuntimeCreationFailed;
        self.record_system_webview_issue(&role_ids, failure_reason)?;
        self.record_system_engine_compatibility(roles, false, Some(failure_reason))?;
        Err(error)
    }

    fn report_crashed_system_surface(
        &self,
        role_id: &str,
        reason: Option<&str>,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_role = snapshot
            .roles
            .iter()
            .find(|role| role.role_id == role_id && role.runtime == "embedded")
            .ok_or_else(|| CoreError::Domain {
                code: "EMBEDDED_ROLE_NOT_RUNNING",
                message: "The embedded role is not running.".to_owned(),
            })?;
        let role_ids = snapshot
            .tabs
            .iter()
            .find(|tab| runtime_role.tab_id.as_deref() == Some(tab.id.as_str()))
            .map(|tab| tab.role_ids.clone())
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        let _ = self.macro_runtime.stop_role(role_id);
        let roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .filter(|role| role_ids.contains(&role.id))
            .collect::<Vec<_>>();
        let _ = self.record_system_engine_compatibility(
            &roles,
            false,
            Some(crate::model::SystemWebViewIssueReason::RuntimeCrashed),
        );
        let failure_reason = if reason == Some("popup-unsupported") {
            crate::model::SystemWebViewIssueReason::RuntimeCreationFailed
        } else {
            crate::model::SystemWebViewIssueReason::RuntimeCrashed
        };
        {
            let mut issues = self.system_webview_issues.write().map_err(|_| {
                CoreError::Internal("system WebView issue lock poisoned".to_owned())
            })?;
            for role_id in &role_ids {
                issues.insert(role_id.clone(), failure_reason);
            }
        }
        let statuses = self
            .browser_statuses()?
            .into_iter()
            .filter(|status| role_ids.contains(&status.role_id))
            .collect::<Vec<_>>();
        self.emit(vec![CoreEvent::BrowserStatuses {
            statuses: self.browser_statuses()?,
        }]);
        Ok(statuses)
    }

    fn report_recovered_system_surface(
        &self,
        role_id: &str,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let runtime_role = snapshot
            .roles
            .iter()
            .find(|role| role.role_id == role_id && role.runtime == "embedded")
            .ok_or_else(|| CoreError::Domain {
                code: "EMBEDDED_ROLE_NOT_RUNNING",
                message: "The embedded role is not running.".to_owned(),
            })?;
        let role_ids = snapshot
            .tabs
            .iter()
            .find(|tab| runtime_role.tab_id.as_deref() == Some(tab.id.as_str()))
            .map(|tab| tab.role_ids.clone())
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        let roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .filter(|role| role_ids.contains(&role.id))
            .collect::<Vec<_>>();
        {
            let mut issues = self.system_webview_issues.write().map_err(|_| {
                CoreError::Internal("system WebView issue lock poisoned".to_owned())
            })?;
            for role_id in &role_ids {
                issues.remove(role_id);
            }
        }
        self.record_system_engine_compatibility(&roles, true, None)?;
        let statuses = self
            .browser_statuses()?
            .into_iter()
            .filter(|status| role_ids.contains(&status.role_id))
            .collect::<Vec<_>>();
        self.emit(vec![CoreEvent::BrowserStatuses {
            statuses: self.browser_statuses()?,
        }]);
        Ok(statuses)
    }

    fn run_effect_plan_for_roles(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let plan = crate::operation_actor::OperationPlan { steps };
        let handle = if role_ids.is_empty() {
            self.operation_actor.start(plan)?
        } else {
            self.operation_actor.start_launch(plan)?
        };
        let operation_id = handle.operation_id.clone();
        if !role_ids.is_empty() {
            let mut operations = self.embedded_operations.lock().map_err(|_| {
                CoreError::Internal("embedded operation registry poisoned".to_owned())
            })?;
            role_ids.iter().for_each(|role_id| {
                operations.insert(role_id.clone(), operation_id.clone());
            });
        }
        let outcome = handle.outcome.blocking_recv().map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        })?;
        if !role_ids.is_empty() {
            let mut operations = self.embedded_operations.lock().map_err(|_| {
                CoreError::Internal("embedded operation registry poisoned".to_owned())
            })?;
            operations.retain(|_, candidate| candidate != &operation_id);
        }
        if let Some(error) = &outcome.error {
            if error.code == "CORE_OPERATION_CANCELLED" {
                return Err(CoreError::Effect {
                    code: "LAUNCH_CANCELLED".to_owned(),
                    message: "Browser launch was cancelled.".to_owned(),
                });
            }
            return Err(CoreError::Effect {
                code: error.code.clone(),
                message: error.message.clone(),
            });
        }
        Ok(outcome)
    }

    fn cancel_embedded_operations(&self, role_ids: &[String]) -> CoreResult<()> {
        let operation_ids = {
            let operations = self.embedded_operations.lock().map_err(|_| {
                CoreError::Internal("embedded operation registry poisoned".to_owned())
            })?;
            role_ids
                .iter()
                .filter_map(|role_id| operations.get(role_id).cloned())
                .collect::<std::collections::HashSet<_>>()
        };
        for operation_id in operation_ids {
            self.operation_actor.cancel(&operation_id)?;
        }
        Ok(())
    }

    fn embedded_tab_window_id(&self, tab_id: &str) -> CoreResult<String> {
        self.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .tabs
            .into_iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.window_id)
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })
    }

    fn create_game_window_and_move_tab(
        &self,
        input: GameWindowCreateInputRecord,
        tab_id: &str,
        target: EmbeddedLaunchTargetRecord,
        before_tab_id: Option<String>,
    ) -> CoreResult<StateGameWindowRecord> {
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let previous = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .clone();
        let previous_snapshot = previous
            .clone()
            .invoke(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let source_window_id = previous_snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.window_id.clone())
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })?;
        let source_will_empty = previous_snapshot
            .windows
            .iter()
            .find(|window| window.window_id == source_window_id)
            .is_some_and(|window| window.tab_ids.len() == 1);
        let mut game_windows =
            self.read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?;
        let removed_source = source_will_empty
            .then(|| {
                game_windows
                    .iter()
                    .position(|window| window.id == source_window_id)
                    .map(|index| game_windows.remove(index))
            })
            .flatten();
        let created = crate::domain::create_game_window(&mut game_windows, input)?;
        if created.id != target.window_id {
            return Err(CoreError::Domain {
                code: "GAME_WINDOW_TARGET_INVALID",
                message: "The reserved Game Window id must match the runtime target.".to_owned(),
            });
        }
        if let Some(source) = removed_source {
            game_windows.push(source);
        }
        let mut next_runtime = previous.clone();
        next_runtime.invoke(BrowserRuntimeCommand::MoveTab {
            tab_id: tab_id.to_owned(),
            window_id: target.window_id.clone(),
        })?;
        next_runtime.invoke(BrowserRuntimeCommand::ReorderTab {
            tab_id: tab_id.to_owned(),
            before_tab_id,
        })?;
        let next = next_runtime
            .invoke(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let removed_window_ids = previous_snapshot
            .windows
            .iter()
            .filter(|window| window.window_id == source_window_id && window.tab_ids.len() == 1)
            .map(|window| window.window_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let compensation = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: previous_snapshot,
            target: Some(target.clone()),
            reveal_window_ids: Vec::new(),
            focus_window_ids: Vec::new(),
            focus_tab_id: None,
        };
        self.run_effect_plan(vec![effect_step(
            "embedded-runtime-create-window-move-tab",
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: next.clone(),
                target: Some(target.clone()),
                reveal_window_ids: vec![target.window_id.clone()],
                focus_window_ids: vec![target.window_id.clone()],
                focus_tab_id: Some(tab_id.to_owned()),
            },
            Duration::from_secs(15),
            Some(compensation.clone()),
        )])?;
        let (projected, _) =
            self.project_game_windows_from_runtime(game_windows, &next, &removed_window_ids);
        if let Err(error) = self.mutate_state(StateMutation::GameWindowsSync {
            windows: projected.clone(),
        }) {
            let _ = self.run_effect_plan(vec![effect_step(
                "embedded-runtime-create-window-move-tab-rollback",
                compensation,
                Duration::from_secs(15),
                None,
            )]);
            return Err(error);
        }
        if !removed_window_ids.is_empty() {
            for window_id in &removed_window_ids {
                next_runtime.invoke(BrowserRuntimeCommand::RemoveWindow {
                    window_id: window_id.clone(),
                })?;
            }
            let committed_snapshot = next_runtime
                .invoke(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let _ = self.run_effect_plan(vec![effect_step(
                "embedded-runtime-create-window-empty-source-cleanup",
                CoreEffectAction::EmbeddedApplyRuntime {
                    snapshot: committed_snapshot.clone(),
                    target: None,
                    reveal_window_ids: Vec::new(),
                    focus_window_ids: Vec::new(),
                    focus_tab_id: Some(tab_id.to_owned()),
                },
                Duration::from_secs(15),
                None,
            )]);
        }
        let mut runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        *runtime = next_runtime;
        drop(runtime);
        self.emit_browser_statuses();
        projected
            .into_iter()
            .find(|window| window.id == created.id)
            .ok_or_else(|| CoreError::Internal("created Game Window was not persisted".to_owned()))
    }

    fn apply_embedded_runtime_command(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: Vec<String>,
        focus_window_ids: Vec<String>,
        focus_tab_id: Option<String>,
        focus_active_window_id: Option<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        self.apply_embedded_runtime_command_inner(
            commands,
            target,
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
            focus_active_window_id,
        )
    }

    fn apply_embedded_runtime_command_inner(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_window_ids: Vec<String>,
        focus_window_ids: Vec<String>,
        focus_tab_id: Option<String>,
        focus_active_window_id: Option<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let (previous, mut next_runtime, mut next) = {
            let runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let previous = runtime.clone();
            let mut next_runtime = previous.clone();
            let mut result = next_runtime.invoke(BrowserRuntimeCommand::Snapshot)?;
            for command in commands {
                result = next_runtime.invoke(command)?;
            }
            (previous, next_runtime, result.snapshot)
        };
        let previous_snapshot = previous
            .clone()
            .invoke(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let focus_tab_id = focus_tab_id.or_else(|| {
            focus_active_window_id.and_then(|window_id| {
                next.windows
                    .iter()
                    .find(|window| window.window_id == window_id)
                    .and_then(|window| window.active_tab_id.clone())
            })
        });
        let effect = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: next.clone(),
            target: target.clone(),
            reveal_window_ids,
            focus_window_ids,
            focus_tab_id,
        };
        let compensation = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: previous_snapshot.clone(),
            target,
            reveal_window_ids: Vec::new(),
            focus_window_ids: Vec::new(),
            focus_tab_id: None,
        };
        self.run_effect_plan(vec![effect_step(
            "embedded-runtime",
            effect,
            Duration::from_secs(15),
            Some(compensation.clone()),
        )])?;
        let removed_window_ids = previous_snapshot
            .windows
            .iter()
            .filter(|previous_window| {
                !previous_window.tab_ids.is_empty()
                    && next
                        .windows
                        .iter()
                        .find(|next_window| next_window.window_id == previous_window.window_id)
                        .is_some_and(|next_window| next_window.tab_ids.is_empty())
            })
            .map(|window| window.window_id.clone())
            .collect::<std::collections::HashSet<_>>();
        if let Err(error) = self.sync_game_windows_from_runtime(&next, &removed_window_ids) {
            let _ = self.run_effect_plan(vec![effect_step(
                "embedded-runtime-persistence-rollback",
                compensation,
                Duration::from_secs(15),
                None,
            )]);
            return Err(error);
        }
        if !removed_window_ids.is_empty() {
            let mut cleaned_runtime = next_runtime.clone();
            for window_id in &removed_window_ids {
                cleaned_runtime.invoke(BrowserRuntimeCommand::RemoveWindow {
                    window_id: window_id.clone(),
                })?;
            }
            let cleaned = cleaned_runtime
                .invoke(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            let _ = self.run_effect_plan(vec![effect_step(
                "embedded-runtime-empty-window-cleanup",
                CoreEffectAction::EmbeddedApplyRuntime {
                    snapshot: cleaned.clone(),
                    target: None,
                    reveal_window_ids: Vec::new(),
                    focus_window_ids: Vec::new(),
                    focus_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )]);
            next_runtime = cleaned_runtime;
            next = cleaned;
        }
        let mut runtime = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        *runtime = next_runtime;
        drop(runtime);
        self.emit_browser_statuses();
        Ok(next)
    }

    fn saved_game_window_tab_id(
        &self,
        window_id: &str,
        tab_type: &str,
        source_id: &str,
    ) -> CoreResult<Option<String>> {
        Ok(self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .into_iter()
            .find(|window| window.id == window_id)
            .and_then(|window| {
                window
                    .tabs
                    .into_iter()
                    .find(|tab| tab.tab_type == tab_type && tab.source_id == source_id)
            })
            .map(|tab| tab.id))
    }

    fn sync_game_windows_from_runtime(
        &self,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<()> {
        let game_windows =
            self.read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?;
        let (game_windows, changed) =
            self.project_game_windows_from_runtime(game_windows, snapshot, removed_window_ids);
        if changed {
            self.mutate_state(StateMutation::GameWindowsSync {
                windows: game_windows,
            })?;
        }
        Ok(())
    }

    fn project_game_windows_from_runtime(
        &self,
        mut game_windows: Vec<StateGameWindowRecord>,
        snapshot: &crate::model::BrowserRuntimeSnapshot,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> (Vec<StateGameWindowRecord>, bool) {
        let previous_tabs = game_windows
            .iter()
            .flat_map(|window| window.tabs.iter().cloned())
            .map(|tab| (tab.id.clone(), tab))
            .collect::<std::collections::HashMap<_, _>>();
        let previous_len = game_windows.len();
        game_windows.retain(|window| !removed_window_ids.contains(&window.id));
        let mut changed = game_windows.len() != previous_len;
        for runtime_window in &snapshot.windows {
            let Some(game_window) = game_windows
                .iter_mut()
                .find(|window| window.id == runtime_window.window_id)
            else {
                continue;
            };
            let tabs = runtime_window
                .tab_ids
                .iter()
                .filter_map(|tab_id| snapshot.tabs.iter().find(|tab| &tab.id == tab_id))
                .map(|tab| {
                    let previous = previous_tabs.get(&tab.id);
                    GameWindowTabRecord {
                        id: tab.id.clone(),
                        tab_type: tab.tab_type.clone(),
                        source_id: tab.source_id.clone(),
                        name: tab.name.clone(),
                        role_ids: tab.role_ids.clone(),
                        hidden: tab.hidden,
                        audio_muted: previous.is_some_and(|tab| tab.audio_muted),
                        role_views: previous
                            .map(|tab| tab.role_views.clone())
                            .unwrap_or_default(),
                    }
                })
                .collect::<Vec<_>>();
            game_window.tabs = tabs;
            game_window.active_tab_id = runtime_window.active_tab_id.clone();
            game_window.updated_at = chrono::Utc::now().to_rfc3339();
            changed = true;
        }
        (game_windows, changed)
    }

    fn publish_embedded_runtime_snapshot(
        &self,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        self.publish_embedded_runtime_snapshot_with_removed(&std::collections::HashSet::new())
    }

    fn publish_embedded_runtime_snapshot_with_removed(
        &self,
        removed_window_ids: &std::collections::HashSet<String>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let removed_window_ids = removed_window_ids
            .iter()
            .filter(|window_id| {
                snapshot
                    .windows
                    .iter()
                    .find(|window| &window.window_id == *window_id)
                    .is_some_and(|window| window.tab_ids.is_empty())
            })
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.run_effect_plan(vec![effect_step(
            "embedded-runtime-projection",
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: snapshot.clone(),
                target: None,
                reveal_window_ids: Vec::new(),
                focus_window_ids: Vec::new(),
                focus_tab_id: None,
            },
            Duration::from_secs(15),
            None,
        )])?;
        self.sync_game_windows_from_runtime(&snapshot, &removed_window_ids)?;
        let mut cleaned = false;
        for window_id in &removed_window_ids {
            if snapshot
                .windows
                .iter()
                .find(|window| &window.window_id == window_id)
                .is_some_and(|window| window.tab_ids.is_empty())
            {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWindow {
                    window_id: window_id.clone(),
                })?;
                cleaned = true;
            }
        }
        if cleaned {
            let cleaned_snapshot = self
                .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                .snapshot;
            self.run_effect_plan(vec![effect_step(
                "embedded-runtime-empty-window-cleanup",
                CoreEffectAction::EmbeddedApplyRuntime {
                    snapshot: cleaned_snapshot.clone(),
                    target: None,
                    reveal_window_ids: Vec::new(),
                    focus_window_ids: Vec::new(),
                    focus_tab_id: None,
                },
                Duration::from_secs(15),
                None,
            )])?;
            self.emit_browser_statuses();
            return Ok(cleaned_snapshot);
        }
        self.emit_browser_statuses();
        Ok(snapshot)
    }

    fn publish_embedded_runtime_snapshot_best_effort(&self) {
        if self.publish_embedded_runtime_snapshot().is_err() {
            self.emit_browser_statuses();
        }
    }

    pub fn resolve_role_paths(&self, role_id: &str) -> CoreResult<crate::model::RolePathsRecord> {
        self.with_runtime(|_| crate::role_browser_data::paths(&self.user_data_dir, role_id))
    }

    pub fn prepare_embedded_key_transition(
        &self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: &[String],
        owner_id: &str,
    ) -> CoreResult<crate::model::EmbeddedKeyTransitionRecord> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .prepare(role_id, phase, code, modifier_codes, owner_id)
    }

    pub fn complete_embedded_key_transition(
        &self,
        transition_id: &str,
        succeeded: bool,
    ) -> CoreResult<()> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .complete(transition_id, succeeded)
    }

    pub fn reassert_embedded_keys(
        &self,
        role_id: &str,
    ) -> CoreResult<crate::model::EmbeddedKeyTransitionRecord> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .reassert(role_id)
    }

    pub fn has_embedded_held_keys(&self, role_id: &str) -> CoreResult<bool> {
        Ok(self
            .embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .has_held_keys(role_id))
    }

    pub fn clear_embedded_keys(&self, role_id: &str) -> CoreResult<()> {
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input runtime lock poisoned".to_owned()))?
            .clear_role(role_id);
        Ok(())
    }

    pub fn dispatch_browser_results(&self, results: Vec<BrowserActionResult>) -> CoreResult<()> {
        self.macro_runtime.dispatch_results(results)
    }

    pub fn dispatch_core_effect_results(
        &self,
        results: Vec<CoreEffectResult>,
    ) -> CoreResult<CoreEffectDispatchReport> {
        let mut browser_results = Vec::new();
        let mut operation_results = Vec::new();
        let mut browser_effect_ids = Vec::new();
        for result in results {
            let effect_id = result.effect_id.clone();
            if let Some(result) =
                crate::browser_action_effects::result_as_browser_action(result.clone())
            {
                browser_effect_ids.push(effect_id);
                browser_results.push(result);
            } else {
                operation_results.push(result);
            }
        }
        if !browser_results.is_empty() {
            self.macro_runtime.dispatch_results(browser_results)?;
        }
        let mut report = self.operation_actor.dispatch_results(operation_results)?;
        let core_effects = self.operation_actor.metrics();
        self.with_runtime(|runtime| {
            runtime.telemetry.record_core_effects(core_effects);
            Ok(())
        })?;
        report.accepted.extend(browser_effect_ids);
        Ok(report)
    }

    pub fn resolve_workspace_layout(
        &self,
        input: &crate::model::WorkspaceLayoutInput,
    ) -> crate::model::WorkspaceLayoutOutput {
        layout::resolve(input)
    }

    pub fn resolve_adaptive_workspace_zoom(
        &self,
        viewport_width: f64,
        current_percent: Option<u32>,
    ) -> u32 {
        layout::adaptive_zoom_percent(viewport_width, current_percent)
    }

    pub fn normalize_workspace_rects(
        &self,
        rects: &[crate::model::LayoutRect],
    ) -> Vec<crate::model::LayoutRect> {
        layout::normalize_rect_edges(rects)
    }

    pub fn create_workspace_dividers(
        &self,
        roles: &[crate::model::LayoutRoleInput],
    ) -> Vec<crate::model::WorkspaceDividerDescriptor> {
        layout::create_dividers(roles)
    }

    pub fn resize_workspace_divider(
        &self,
        input: &crate::model::WorkspaceDividerResizeInput,
    ) -> CoreResult<crate::model::WorkspaceDividerResizeOutput> {
        layout::resize_divider(input).ok_or_else(|| {
            CoreError::InvalidInput("workspace divider does not reference live roles".to_owned())
        })
    }

    fn replace_scalar_state<T: serde::Serialize>(&self, key: &str, value: T) -> CoreResult<Value> {
        let _guard = self.state_mutation_guard()?;
        let value =
            serde_json::to_value(value).map_err(|error| CoreError::Internal(error.to_string()))?;
        self.with_runtime(|runtime| {
            let revision = runtime.state.replace_scalar(key.to_owned(), value)?;
            self.emit(vec![CoreEvent::StateChanged {
                revision,
                changed_collections: Vec::new(),
            }]);
            Ok(json!({ "revision": revision }))
        })
    }

    fn read_optional_scalar_state<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> CoreResult<Option<T>> {
        let value = self.with_runtime(|runtime| runtime.state.read_scalar(key.to_owned()))?;
        value
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    CoreError::StateDatabase(format!("stored {key} is invalid: {error}"))
                })
            })
            .transpose()
    }

    fn read_legal_acceptance_fail_closed(&self) -> CoreResult<Option<LegalAcceptanceRecord>> {
        let value =
            self.with_runtime(|runtime| runtime.state.read_scalar("legalAcceptance".to_owned()))?;
        Ok(value
            .and_then(|value| serde_json::from_value::<LegalAcceptanceRecord>(value).ok())
            .filter(|acceptance| validate_legal_acceptance(acceptance).is_ok()))
    }

    fn read_scalar_state<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
        missing_message: &str,
    ) -> CoreResult<T> {
        self.read_optional_scalar_state(key)?
            .ok_or_else(|| CoreError::StateDatabase(missing_message.to_owned()))
    }

    fn mutate_state(&self, mutation: StateMutation) -> CoreResult<Value> {
        let _guard = self.state_mutation_guard()?;
        let changed_collections = mutation.changed_collections();
        let result = self.with_runtime(|runtime| runtime.state.mutate(mutation))?;
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.emit(vec![CoreEvent::StateChanged {
            revision,
            changed_collections,
        }]);
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    }

    fn read_state_collection(&self, key: &str) -> CoreResult<Value> {
        self.with_runtime(|runtime| runtime.state.read_collection(key.to_owned()))
    }

    fn read_typed_state_collection<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> CoreResult<Vec<T>> {
        serde_json::from_value(self.read_state_collection(key)?)
            .map_err(|error| CoreError::StateDatabase(format!("stored {key} are invalid: {error}")))
    }

    fn read_state_record(
        &self,
        collection: &str,
        id_field: &str,
        id: &str,
        code: &'static str,
        message: &str,
    ) -> CoreResult<Value> {
        debug_assert!(matches!(id_field, "id" | "gameId"));
        self.with_runtime(|runtime| {
            runtime
                .state
                .read_record(collection.to_owned(), id.to_owned())
        })?
        .ok_or_else(|| CoreError::Domain {
            code,
            message: message.to_owned(),
        })
    }

    fn read_typed_snapshot(&self) -> CoreResult<crate::model::CoreStateSnapshotRecord> {
        let value = self.with_runtime(|runtime| runtime.state.snapshot())?;
        serde_json::from_value(value).map_err(|error| {
            CoreError::StateDatabase(format!("state snapshot is invalid: {error}"))
        })
    }

    fn ensure_role_exists(&self, id: &str) -> CoreResult<()> {
        self.read_state_record("roles", "id", id, "ROLE_NOT_FOUND", "Role not found.")
            .map(|_| ())
    }

    fn portable(&self) -> CoreResult<std::sync::MutexGuard<'_, crate::portable::PortableRuntime>> {
        self.portable
            .lock()
            .map_err(|_| CoreError::Internal("portable runtime lock poisoned".to_owned()))
    }

    fn compatibility_runtime(
        &self,
    ) -> CoreResult<std::sync::MutexGuard<'_, crate::compatibility_runtime::CompatibilityRuntime>>
    {
        self.compatibility_runtime
            .lock()
            .map_err(|_| CoreError::Internal("compatibility runtime lock poisoned".to_owned()))
    }

    fn state_mutation_guard(&self) -> CoreResult<std::sync::MutexGuard<'_, ()>> {
        self.state_mutation_guard
            .lock()
            .map_err(|_| CoreError::Internal("state mutation lock poisoned".to_owned()))
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

    pub fn subscribe(&self) -> CoreResult<Receiver<Vec<CoreEvent>>> {
        let (sender, receiver) = bounded(EVENT_QUEUE_CAPACITY);
        sender
            .try_send(vec![CoreEvent::Ready {
                schema_version: SCHEMA_VERSION,
            }])
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        self.subscribers
            .lock()
            .map_err(|_| CoreError::Internal("subscriber lock poisoned".to_owned()))?
            .push(sender);
        Ok(receiver)
    }

    pub fn acquire_browser_operation(
        &self,
        request: crate::model::BrowserOperationRequest,
    ) -> CoreResult<crate::model::BrowserOperationLease> {
        self.with_runtime(|_| Ok(()))?;
        self.browser_operations.acquire(request)
    }

    pub fn complete_browser_operation(&self, id: &str) -> CoreResult<()> {
        self.browser_operations.complete(id)
    }

    pub fn shutdown(&self) {
        self.browser_operations.shutdown();
        self.macro_runtime.shutdown();
        self.browser_action_effects.shutdown();
        self.operation_actor.shutdown();
        let core_effects = self.operation_actor.metrics();
        self.overlay_refresh.shutdown();
        if let Ok(mut embedded_input) = self.embedded_input.lock() {
            embedded_input.shutdown();
        }
        if let Ok(mut runtime) = self.runtime.lock()
            && let Some(mut runtime) = runtime.take()
        {
            runtime.scheduler.shutdown();
            runtime.telemetry.record_core_effects(core_effects);
            runtime.telemetry.shutdown();
            runtime.logs.shutdown();
            runtime.state.shutdown();
        }
        self.emit(vec![CoreEvent::Shutdown]);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.clear();
        }
        if let Ok(mut lock) = self.instance_lock.lock()
            && let Some(file) = lock.take()
        {
            let _ = fs2::FileExt::unlock(&file);
        }
    }

    fn with_runtime<T>(&self, operation: impl FnOnce(&Runtime) -> CoreResult<T>) -> CoreResult<T> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| CoreError::Internal("runtime lock poisoned".to_owned()))?;
        operation(runtime.as_ref().ok_or(CoreError::ShuttingDown)?)
    }

    fn capture_logs(
        &self,
        entries: Vec<LogCaptureRecord>,
    ) -> CoreResult<Vec<crate::model::LogEntry>> {
        Ok(self.log_capture()?.capture(entries))
    }

    fn log_capture(
        &self,
    ) -> CoreResult<std::sync::MutexGuard<'_, crate::log_capture::LogCaptureRuntime>> {
        self.log_capture
            .lock()
            .map_err(|_| CoreError::Internal("log capture lock poisoned".to_owned()))
    }

    async fn export_diagnostics(
        self: &Arc<Self>,
        path: String,
        snapshot: ApplicationDiagnosticsSnapshotRecord,
    ) -> CoreResult<DiagnosticExportResultRecord> {
        let captured_at = chrono::Utc::now();
        let graphics_since = captured_at - chrono::Duration::minutes(30);
        let windows_graphics_events =
            crate::windows_graphics_events::collect(self.platform, &graphics_since.to_rfc3339())?;
        let host = rion_platform::collect_system_host_diagnostics();
        let state = self.read_typed_snapshot()?;
        let current_level = self.log_capture()?.current_level();
        let logging = self.with_runtime(|runtime| runtime.logs.storage_status(current_level))?;
        let browser_role_statuses = self.browser_statuses()?;
        let browser_workspace_statuses = self.browser_workspace_statuses()?;
        let system_webview_runtime = self.system_webview_runtime()?;
        let browser_settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let engine_compatibility_cache = state
            .games
            .iter()
            .filter_map(|game| {
                let key = self
                    .engine_compatibility_cache_key(
                        game,
                        &browser_settings,
                        &system_webview_runtime,
                    )
                    .ok()?;
                self.with_runtime(|runtime| runtime.state.engine_compatibility_cache_get(key))
                    .ok()
                    .flatten()
            })
            .collect::<Vec<_>>();
        let gpu_feature_status =
            serde_json::from_str::<Value>(&snapshot.gpu_feature_status_raw_json)
                .unwrap_or(Value::Null);
        let gpu_info = snapshot
            .gpu_info_raw_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let diagnostics = json!({
            "generatedAt": captured_at.to_rfc3339(),
            "application": {
                "name": snapshot.application_name,
                "version": snapshot.application_version,
                "packaged": snapshot.packaged,
            },
            "runtime": {
                "engine": snapshot.engine,
                "engineVersion": snapshot.engine_version,
                "shell": snapshot.shell,
                "shellVersion": snapshot.shell_version,
            },
            "system": {
                "platform": match self.platform {
                    rion_platform::Platform::Macos => "darwin",
                    rion_platform::Platform::Windows => "win32",
                },
                "release": snapshot.system_version,
                "arch": std::env::consts::ARCH,
                "locale": snapshot.locale,
                "cpu": host.cpu_model.map(|model| json!({
                    "model": model,
                    "cores": host.cpu_cores,
                })),
                "memory": {
                    "totalBytes": host.total_memory_bytes,
                    "freeBytes": host.free_memory_bytes,
                },
                "displayCount": snapshot.displays.len(),
                "displays": snapshot.displays,
                "gpuFeatureStatus": gpu_feature_status,
                "gpuInfo": gpu_info,
            },
            "browserEngines": {
                "systemRuntime": system_webview_runtime,
                "activeRoles": browser_role_statuses,
                "activeWorkspaces": browser_workspace_statuses,
                "compatibilityCache": engine_compatibility_cache,
            },
            "windowsGraphicsEvents": windows_graphics_events,
            "windowsGraphicsEventWindow": {
                "since": graphics_since.to_rfc3339(),
                "until": captured_at.to_rfc3339(),
            },
            "dataCounts": {
                "games": state.games.len(),
                "roles": state.roles.len(),
                "workspaces": state.launch_workspaces.len(),
                "macros": state.macros.len(),
            },
            "logging": {
                "currentLevel": logging.current_level,
                "entryCount": logging.entry_count,
                "fileCount": logging.file_count,
                "totalBytes": logging.total_bytes,
                "oldestTimestamp": logging.oldest_timestamp,
                "newestTimestamp": logging.newest_timestamp,
                "retentionDays": logging.retention_days,
                "maxBytes": logging.max_bytes,
                "directory": "<USER_DATA>/logs",
            },
        });
        self.with_runtime(|runtime| {
            crate::diagnostics::export_bundle(
                PathBuf::from(path).as_path(),
                &diagnostics,
                &runtime.logs,
            )
        })
    }

    fn emit(&self, events: Vec<CoreEvent>) {
        broadcast_events(&self.subscribers, events);
    }
}

fn local_storage_sync_role_effect(
    role: &StateRoleRecord,
    roles: &[StateRoleRecord],
    games: &[StateGameRecord],
) -> CoreResult<Option<crate::model::LocalStorageSyncRoleEffectRecord>> {
    let game = games
        .iter()
        .find(|game| game.id == role.game_id)
        .ok_or_else(|| CoreError::Domain {
            code: "GAME_NOT_FOUND",
            message: "Game not found.".to_owned(),
        })?;
    if game.local_storage_sync_keys.is_empty() {
        return Ok(None);
    }
    let origin = crate::domain::launch_origin(&role.launch_url)?;
    let source = role
        .local_storage_source_role_id
        .as_deref()
        .map(|source_id| {
            roles
                .iter()
                .find(|candidate| candidate.id == source_id)
                .map(|source| crate::model::LocalStorageSyncSourceEffectRecord {
                    role_id: source.id.clone(),
                    launch_url: source.launch_url.clone(),
                })
                .ok_or_else(|| CoreError::Domain {
                    code: "ROLE_LOCAL_STORAGE_SOURCE_NOT_FOUND",
                    message: "The localStorage source role was not found.".to_owned(),
                })
        })
        .transpose()?;
    let dependent_role_ids = roles
        .iter()
        .filter(|candidate| {
            candidate.local_storage_source_role_id.as_deref() == Some(role.id.as_str())
        })
        .map(|candidate| candidate.id.clone())
        .collect();
    Ok(Some(crate::model::LocalStorageSyncRoleEffectRecord {
        origin,
        keys: game.local_storage_sync_keys.clone(),
        source,
        dependent_role_ids,
    }))
}

fn embedded_status(result: EmbeddedLaunchResultRecord) -> crate::model::BrowserRoleStatusRecord {
    crate::model::BrowserRoleStatusRecord {
        role_id: result.role_id,
        state: result.state,
        launched_at: Some(result.launched_at),
        notice: None,
        runtime_mode: result.runtime_mode,
        automation_state: None,
        overlay_state: None,
        page_health: None,
        resolved_engine: None,
        host_kind: None,
        issue_reason: None,
        capability_snapshot: None,
    }
}

fn embedded_role_statuses(
    roles: Vec<crate::model::BrowserRuntimeRoleRecord>,
) -> Vec<crate::model::BrowserRoleStatusRecord> {
    let mut statuses = roles
        .into_iter()
        .filter(|role| role.runtime == "embedded")
        .map(|role| crate::model::BrowserRoleStatusRecord {
            role_id: role.role_id,
            state: role.state,
            launched_at: role.launched_at,
            notice: None,
            runtime_mode: "embedded".to_owned(),
            automation_state: None,
            overlay_state: None,
            page_health: None,
            resolved_engine: None,
            host_kind: None,
            issue_reason: None,
            capability_snapshot: None,
        })
        .collect::<Vec<_>>();
    statuses.sort_by(|left, right| left.role_id.cmp(&right.role_id));
    statuses
}

fn embedded_workspace_statuses(
    workspaces: Vec<crate::model::BrowserRuntimeWorkspaceRecord>,
) -> Vec<crate::model::BrowserWorkspaceStatusRecord> {
    let mut statuses = workspaces
        .into_iter()
        .map(|workspace| crate::model::BrowserWorkspaceStatusRecord {
            workspace_id: workspace.workspace_id,
            state: workspace.state,
            resolved_engine: None,
            host_kind: None,
            issue_reason: None,
            capability_snapshot: None,
        })
        .collect::<Vec<_>>();
    statuses.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    statuses
}

fn effect_value<T: DeserializeOwned>(result: &CoreEffectResult) -> CoreResult<T> {
    if !result.ok {
        let error = result
            .error
            .clone()
            .unwrap_or_else(|| crate::error::CoreErrorPayload {
                code: "CORE_EFFECT_FAILED".to_owned(),
                message: "The desktop shell effect failed.".to_owned(),
            });
        return Err(CoreError::Effect {
            code: error.code,
            message: error.message,
        });
    }
    let value = result.value_json.as_deref().unwrap_or("null");
    serde_json::from_str(value).map_err(|error| {
        CoreError::Internal(format!(
            "Desktop shell effect returned an invalid result: {error}"
        ))
    })
}

fn validate_overlay_language(language: &str) -> CoreResult<()> {
    if matches!(language, "en" | "zh-TW" | "zh-CN" | "ja") {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "macro overlay language is invalid".to_owned(),
        ))
    }
}

fn effect_step(
    handle_id: &str,
    action: CoreEffectAction,
    timeout: Duration,
    compensation: Option<CoreEffectAction>,
) -> crate::operation_actor::OperationStep {
    crate::operation_actor::OperationStep {
        effect: crate::operation_actor::OperationEffect {
            target: CoreEffectTarget {
                kind: CoreEffectTargetKind::App,
                handle_id: handle_id.to_owned(),
            },
            action,
            timeout,
        },
        compensation: compensation.map(|action| crate::operation_actor::OperationEffect {
            target: CoreEffectTarget {
                kind: CoreEffectTargetKind::App,
                handle_id: handle_id.to_owned(),
            },
            action,
            timeout: Duration::from_secs(15),
        }),
    }
}

fn workspace_create_role_ids(input: &crate::model::WorkspaceCreateInputRecord) -> Vec<String> {
    input
        .slots
        .as_ref()
        .into_iter()
        .flatten()
        .filter_map(|slot| slot.role_id.clone())
        .collect()
}

fn workspace_update_role_ids(input: &crate::model::WorkspaceUpdateInputRecord) -> Vec<String> {
    input
        .slots
        .as_ref()
        .into_iter()
        .flatten()
        .filter_map(|slot| slot.role_id.clone())
        .collect()
}

fn workspace_operation_key(workspace_id: &str) -> String {
    format!("workspace:{workspace_id}")
}

fn portable_operation_role_ids(
    before: &CoreStateSnapshotRecord,
    after: &CoreStateSnapshotRecord,
) -> CoreResult<Vec<String>> {
    let before_games = serialized_records_by_id(&before.games, |game| game.id.clone())?;
    let after_games = serialized_records_by_id(&after.games, |game| game.id.clone())?;
    let changed_game_ids = changed_record_ids(&before_games, &after_games);

    let before_roles = serialized_records_by_id(&before.roles, |role| role.id.clone())?;
    let after_roles = serialized_records_by_id(&after.roles, |role| role.id.clone())?;
    let mut operation_ids = changed_record_ids(&before_roles, &after_roles);
    operation_ids.extend(
        before
            .roles
            .iter()
            .chain(after.roles.iter())
            .filter(|role| changed_game_ids.contains(&role.game_id))
            .map(|role| role.id.clone()),
    );

    if serde_json::to_value(&before.game_browser_settings)
        .map_err(|error| CoreError::Internal(error.to_string()))?
        != serde_json::to_value(&after.game_browser_settings)
            .map_err(|error| CoreError::Internal(error.to_string()))?
    {
        operation_ids.extend(
            before
                .roles
                .iter()
                .chain(after.roles.iter())
                .map(|role| role.id.clone()),
        );
    }

    let before_workspaces =
        serialized_records_by_id(&before.launch_workspaces, |workspace| workspace.id.clone())?;
    let after_workspaces =
        serialized_records_by_id(&after.launch_workspaces, |workspace| workspace.id.clone())?;
    let changed_workspace_ids = changed_record_ids(&before_workspaces, &after_workspaces);
    for workspace_id in &changed_workspace_ids {
        operation_ids.insert(workspace_operation_key(workspace_id));
    }
    operation_ids.extend(
        before
            .launch_workspaces
            .iter()
            .chain(after.launch_workspaces.iter())
            .filter(|workspace| changed_workspace_ids.contains(&workspace.id))
            .flat_map(|workspace| workspace.slots.iter())
            .filter_map(|slot| slot.role_id.clone()),
    );

    let before_windows =
        serialized_records_by_id(&before.game_windows, |window| window.id.clone())?;
    let after_windows = serialized_records_by_id(&after.game_windows, |window| window.id.clone())?;
    let changed_window_ids = changed_record_ids(&before_windows, &after_windows);
    for tab in before
        .game_windows
        .iter()
        .chain(after.game_windows.iter())
        .filter(|window| changed_window_ids.contains(&window.id))
        .flat_map(|window| window.tabs.iter())
    {
        operation_ids.extend(tab.role_ids.iter().cloned());
        if tab.tab_type == "workspace" {
            operation_ids.insert(workspace_operation_key(&tab.source_id));
        }
    }

    let mut operation_ids = operation_ids.into_iter().collect::<Vec<_>>();
    operation_ids.sort();
    Ok(operation_ids)
}

fn serialized_records_by_id<T: Serialize>(
    records: &[T],
    id: impl Fn(&T) -> String,
) -> CoreResult<std::collections::HashMap<String, Value>> {
    records
        .iter()
        .map(|record| {
            Ok((
                id(record),
                serde_json::to_value(record)
                    .map_err(|error| CoreError::Internal(error.to_string()))?,
            ))
        })
        .collect()
}

fn changed_record_ids(
    before: &std::collections::HashMap<String, Value>,
    after: &std::collections::HashMap<String, Value>,
) -> std::collections::HashSet<String> {
    before
        .keys()
        .chain(after.keys())
        .filter(|id| before.get(*id) != after.get(*id))
        .cloned()
        .collect()
}

fn normalize_runtime_bulk_ids(ids: Vec<String>) -> CoreResult<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() {
            return Err(CoreError::InvalidInput(
                "Bulk delete input is invalid.".to_owned(),
            ));
        }
        if seen.insert(id.clone()) {
            normalized.push(id);
        }
    }
    Ok(normalized)
}

fn classify_runtime_bulk_error(id: String, error: &CoreError) -> Value {
    let reason = match error.code() {
        "GAME_BUILTIN_DELETE_FORBIDDEN" => "protected",
        "GAME_IN_USE" | "MACRO_IN_USE" => "in_use",
        code if code.ends_with("_NOT_FOUND") => "not_found",
        "MACRO_MUTATION_BUSY" | "ROLE_MUTATION_BLOCKED" | "ROLE_DATA_CHANGED" => "busy",
        _ => "failed",
    };
    json!({ "id": id, "reason": reason, "relatedNames": [] })
}

fn rollback_role_delete_journals(core: &AppCore, journals: &[(String, String)]) {
    for (role_id, operation_id) in journals.iter().rev() {
        if crate::role_browser_data::restore_quarantine(&core.user_data_dir, role_id, operation_id)
            .is_ok()
        {
            let _ = core.with_runtime(|runtime| {
                runtime.state.delete_operation_journal(operation_id.clone())
            });
        }
    }
}

fn rollback_role_browser_data_clear(
    core: &AppCore,
    role_id: &str,
    operation_id: &str,
    had_directory: bool,
) -> CoreResult<()> {
    crate::role_browser_data::remove(&core.user_data_dir, role_id)?;
    if had_directory {
        crate::role_browser_data::restore_quarantine(&core.user_data_dir, role_id, operation_id)?;
    }
    core.with_runtime(|runtime| {
        runtime
            .state
            .delete_operation_journal(operation_id.to_owned())
    })
}

fn compatibility_load_error(error: CoreError) -> CoreError {
    if error.code() == "CORE_EFFECT_TIMEOUT" {
        CoreError::Effect {
            code: "COMPATIBILITY_LOAD_TIMEOUT".to_owned(),
            message: "The compatibility test page did not load before the deadline.".to_owned(),
        }
    } else {
        error
    }
}

fn chrome_import_cancelled() -> CoreError {
    CoreError::Domain {
        code: "IMPORT_CANCELLED",
        message: "Chrome profile import was cancelled.".to_owned(),
    }
}

fn chrome_import_auth_probe(game: &StateGameRecord) -> Option<ChromeImportAuthProbe> {
    (game.builtin_key.as_deref() == Some("flyff-universe")).then_some(ChromeImportAuthProbe {
        verification_url: "https://universe.flyff.com/profile",
        authenticated_path: "/profile",
        login_path: "/user/login",
    })
}

fn chrome_import_status(auth_state: ChromeProfileImportAuthStateRecord) -> &'static str {
    match auth_state {
        ChromeProfileImportAuthStateRecord::NotAuthenticated
        | ChromeProfileImportAuthStateRecord::Indeterminate => "needsLogin",
        ChromeProfileImportAuthStateRecord::Authenticated
        | ChromeProfileImportAuthStateRecord::NotApplicable => "imported",
    }
}

fn recover_operation_journals(
    state: &StateDatabaseWorker,
    user_data_dir: &std::path::Path,
) -> CoreResult<()> {
    for journal in state.operation_journals()? {
        let role_id = journal
            .payload
            .get("roleId")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::Migration("role operation journal is invalid".to_owned()))?;
        match journal.kind.as_str() {
            "role_delete_v1" => match journal.phase.as_str() {
                "prepared" | "quarantined" => {
                    crate::role_browser_data::restore_quarantine(
                        user_data_dir,
                        role_id,
                        &journal.id,
                    )?;
                }
                "committed" => {
                    crate::role_browser_data::discard_quarantine(user_data_dir, &journal.id)?;
                }
                phase => {
                    return Err(CoreError::Migration(format!(
                        "unsupported role delete journal phase: {phase}"
                    )));
                }
            },
            "role_browser_data_clear_v1" => match journal.phase.as_str() {
                "prepared" => {
                    crate::role_browser_data::restore_quarantine(
                        user_data_dir,
                        role_id,
                        &journal.id,
                    )?;
                }
                "quarantined" => {
                    crate::role_browser_data::remove(user_data_dir, role_id)?;
                    if journal
                        .payload
                        .get("hadDirectory")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        crate::role_browser_data::restore_quarantine(
                            user_data_dir,
                            role_id,
                            &journal.id,
                        )?;
                    }
                }
                "committed" => {
                    crate::role_browser_data::discard_quarantine(user_data_dir, &journal.id)?;
                }
                phase => {
                    return Err(CoreError::Migration(format!(
                        "unsupported role browser data journal phase: {phase}"
                    )));
                }
            },
            // Cookie payloads never enter the journal. Preserve an unfinished
            // marker so the next migration preview/apply can clear the target
            // store through the platform effect bridge before trying again.
            "role_session_migration_v1" => continue,
            // System WebView registration is required before this encrypted
            // backup can be rolled back. Keep both the journal and role intact;
            // the Tauri startup recovery pass handles it immediately afterward.
            "chrome_profile_import_v2" => continue,
            kind => {
                return Err(CoreError::Migration(format!(
                    "unsupported operation journal kind: {kind}"
                )));
            }
        }
        state.delete_operation_journal(journal.id)?;
    }
    Ok(())
}

fn embedded_launch_effects(
    tab_id: &str,
    tab: EmbeddedTabEffectRecord,
    roles: &[StateRoleRecord],
    runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
) -> Vec<crate::operation_actor::OperationStep> {
    let target = tab.target.clone();
    let zoom_factors = tab
        .roles
        .iter()
        .map(|role| (role.role.id.clone(), role.zoom_factor))
        .collect::<std::collections::HashMap<_, _>>();
    let resolved_engines = tab
        .roles
        .iter()
        .map(|role| (role.role.id.clone(), role.resolved_engine))
        .collect::<std::collections::HashMap<_, _>>();
    let mut steps = vec![
        effect_step(
            tab_id,
            CoreEffectAction::EmbeddedCreateTab { tab: Box::new(tab) },
            Duration::from_secs(15),
            Some(CoreEffectAction::EmbeddedDestroyTab {
                tab_id: tab_id.to_owned(),
                next_active_tab_id: None,
            }),
        ),
        effect_step(
            tab_id,
            CoreEffectAction::EmbeddedApplyRuntime {
                snapshot: runtime_snapshot,
                target: Some(target.clone()),
                reveal_window_ids: vec![target.window_id.clone()],
                focus_window_ids: vec![target.window_id.clone()],
                focus_tab_id: None,
            },
            Duration::from_secs(10),
            None,
        ),
    ];
    let role_ids = roles.iter().map(|role| role.id.clone()).collect::<Vec<_>>();
    steps.push(effect_step(
        tab_id,
        CoreEffectAction::EmbeddedConfigureRoleSessions {
            role_ids: role_ids.clone(),
        },
        Duration::from_secs(15),
        None,
    ));
    steps.push(effect_step(
        tab_id,
        CoreEffectAction::EmbeddedLoadRoles {
            roles: roles
                .iter()
                .map(|role| EmbeddedRoleLoadEffectRecord {
                    role_id: role.id.clone(),
                    resolved_engine: resolved_engines
                        .get(&role.id)
                        .copied()
                        .expect("every launched role has a resolved system engine"),
                    url: role.launch_url.clone(),
                    zoom_factor: zoom_factors.get(&role.id).copied().unwrap_or(1.0),
                })
                .collect(),
        },
        Duration::from_secs(45),
        None,
    ));
    steps.push(effect_step(
        tab_id,
        CoreEffectAction::EmbeddedInstallOverlays {
            role_ids: role_ids.clone(),
        },
        Duration::from_secs(15),
        None,
    ));
    if let Some(role_id) = role_ids.first() {
        steps.push(effect_step(
            tab_id,
            CoreEffectAction::EmbeddedFocusRole {
                role_id: role_id.clone(),
                zoom_factor: None,
            },
            Duration::from_secs(15),
            None,
        ));
    }
    steps
}

fn full_window_rect() -> StateNormalizedRectRecord {
    StateNormalizedRectRecord {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    }
}

fn unavailable_system_webview_runtime(
    platform: rion_platform::Platform,
) -> SystemWebViewRuntimeRegistrationRecord {
    use crate::model::{EngineCapabilitySnapshotRecord, EngineCapabilityStatus};

    SystemWebViewRuntimeRegistrationRecord {
        platform: match platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        }
        .to_owned(),
        engine: match platform {
            rion_platform::Platform::Macos => crate::model::ResolvedBrowserEngine::Wkwebview,
            rion_platform::Platform::Windows => crate::model::ResolvedBrowserEngine::Webview2,
        },
        adapter_version: "unregistered".to_owned(),
        available: false,
        capability_snapshot: EngineCapabilitySnapshotRecord {
            navigation: EngineCapabilityStatus::Disabled,
            persistent_session: EngineCapabilityStatus::Disabled,
            trusted_input: EngineCapabilityStatus::Disabled,
            background_input: EngineCapabilityStatus::Disabled,
            frame_evaluation: EngineCapabilityStatus::Disabled,
            popup: EngineCapabilityStatus::Disabled,
            audio_mute: EngineCapabilityStatus::Disabled,
            custom_fonts: EngineCapabilityStatus::Disabled,
            downloads: EngineCapabilityStatus::Disabled,
            file_upload: EngineCapabilityStatus::Disabled,
            permissions: EngineCapabilityStatus::Disabled,
            dialogs: EngineCapabilityStatus::Disabled,
            certificate_handling: EngineCapabilityStatus::Disabled,
        },
        failure_reason: Some(crate::model::SystemWebViewIssueReason::RuntimeCreationFailed),
    }
}

fn system_capability_available(status: crate::model::EngineCapabilityStatus) -> bool {
    matches!(
        status,
        crate::model::EngineCapabilityStatus::Supported
            | crate::model::EngineCapabilityStatus::Degraded
    )
}

fn system_capability_verified(status: crate::model::EngineCapabilityStatus) -> bool {
    status == crate::model::EngineCapabilityStatus::Supported
}

fn require_system_resolution(
    resolution: &crate::model::BrowserEngineResolutionRecord,
) -> CoreResult<()> {
    if let Some(reason) = resolution.issue_reason {
        return Err(CoreError::Domain {
            code: "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE",
            message: format!("The System WebView cannot satisfy this launch because {reason:?}."),
        });
    }
    Ok(())
}

fn embedded_launch_result(role_id: &str, launched_at: String) -> EmbeddedLaunchResultRecord {
    EmbeddedLaunchResultRecord {
        role_id: role_id.to_owned(),
        state: "running".to_owned(),
        launched_at,
        runtime_mode: "embedded".to_owned(),
    }
}

fn next_active_tab_after_removal(
    snapshot: &crate::model::BrowserRuntimeSnapshot,
    removed_tab_id: &str,
) -> Option<String> {
    let window_id = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == removed_tab_id)?
        .window_id
        .clone();
    snapshot
        .windows
        .iter()
        .find(|window| window.window_id == window_id)?
        .tab_ids
        .iter()
        .filter(|tab_id| tab_id.as_str() != removed_tab_id)
        .find(|tab_id| {
            snapshot
                .tabs
                .iter()
                .find(|tab| &tab.id == *tab_id)
                .is_some_and(|tab| !tab.hidden)
        })
        .cloned()
}

fn route_browser_action_events(
    events: Vec<CoreEvent>,
    browser_actions: &Sender<Vec<crate::model::BrowserActionRequest>>,
    subscribers: &Mutex<Vec<Sender<Vec<CoreEvent>>>>,
) {
    let mut public_events = Vec::with_capacity(events.len());
    for event in events {
        if let CoreEvent::BrowserActions { actions } = event {
            let _ = browser_actions.send(actions);
        } else {
            public_events.push(event);
        }
    }
    if !public_events.is_empty() {
        broadcast_events(subscribers, public_events);
    }
}

fn broadcast_events(subscribers: &Mutex<Vec<Sender<Vec<CoreEvent>>>>, events: Vec<CoreEvent>) {
    let Ok(current) = subscribers.lock().map(|subscribers| subscribers.clone()) else {
        return;
    };
    let critical = events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::CoreEffects { .. }
                | CoreEvent::MacroStatuses { reliable: true, .. }
                | CoreEvent::Shutdown
        )
    });
    let mut disconnected = Vec::new();
    for subscriber in current {
        let result = if critical {
            subscriber.send(events.clone()).map_err(|_| ())
        } else {
            match subscriber.try_send(events.clone()) {
                Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
                Err(TrySendError::Disconnected(_)) => Err(()),
            }
        };
        if result.is_err() {
            disconnected.push(subscriber);
        }
    }
    if disconnected.is_empty() {
        return;
    }
    if let Ok(mut subscribers) = subscribers.lock() {
        subscribers.retain(|subscriber| {
            !disconnected
                .iter()
                .any(|candidate| subscriber.same_channel(candidate))
        });
    }
}

impl Drop for AppCore {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, HashSet},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        error::CoreErrorPayload,
        model::{CoreEffectRequest, CoreEffectResult, StatePixelBoundsRecord},
    };

    fn command(mut value: Value) -> CoreCommand {
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("embeddedRoleLaunch" | "embeddedWorkspaceLaunch")
        ) && let Some(target) = value.get_mut("target").and_then(Value::as_object_mut)
        {
            let work_area = target
                .get("workArea")
                .cloned()
                .unwrap_or_else(|| json!({"x": 0, "y": 0, "width": 1200, "height": 800}));
            let display_id = target.get("displayId").and_then(Value::as_i64).unwrap_or(1);
            target
                .entry("windowId")
                .or_insert_with(|| json!(format!("test-window-{display_id}")));
            target.entry("bounds").or_insert(work_area);
            target
                .entry("presentation")
                .or_insert_with(|| json!("normal"));
        }
        serde_json::from_value(value).unwrap()
    }

    fn core() -> (TempDir, Arc<AppCore>) {
        core_for_platform("darwin")
    }

    fn core_for_platform(platform: &str) -> (TempDir, Arc<AppCore>) {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            })
            .unwrap(),
        );
        install_test_system_runtime_for_platform(&core, platform, supported_system_capabilities());
        (directory, core)
    }

    #[test]
    fn application_instance_lock_is_shared_by_both_shell_platforms() {
        for platform in ["darwin", "win32"] {
            let directory = tempfile::tempdir().unwrap();
            let options = || AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            };
            let first = AppCore::create(options()).unwrap();
            let locked = match AppCore::create(options()) {
                Ok(_) => panic!("a second core acquired the same application data lock"),
                Err(error) => error,
            };
            assert_eq!(locked.code(), "APP_INSTANCE_LOCKED");
            first.shutdown();

            let replacement = AppCore::create(options()).unwrap();
            replacement.shutdown();
        }
    }

    #[test]
    fn tauri_stable_startup_creates_a_valid_online_database_backup() {
        let directory = tempfile::tempdir().unwrap();
        let options = || AppCoreOptions {
            app_version: "2.1.0".to_owned(),
            platform: "darwin".to_owned(),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        };
        let stable = AppCore::create(options()).unwrap();
        stable.shutdown();

        let stable = AppCore::create_with_startup_backup(options(), "tauri-stable").unwrap();
        let backup_root = directory.path().join("shell-migration-backups");
        let backup = fs::read_dir(&backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(backup.join("rion-studio.sqlite3").is_file());
        assert!(backup.join("logs.sqlite3").is_file());
        let manifest: Value =
            serde_json::from_slice(&fs::read(backup.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["label"], "tauri-stable");
        assert_eq!(manifest["appVersion"], "2.1.0");
        stable.shutdown();
    }

    fn first_game_id(core: &AppCore) -> String {
        core.invoke(CoreCommand::GamesList).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn create_role(core: &AppCore, game_id: &str, index: usize) -> String {
        core.invoke(command(json!({
            "type": "roleCreate",
            "input": {
                "gameId": game_id,
                "name": format!("Role {index}"),
                "launchUrl": format!("https://example.com/play/{index}")
            }
        })))
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn seed_running_role(core: &AppCore, role_id: &str) {
        let window_id = format!("running-window-{role_id}");
        core.invoke_browser_runtime(BrowserRuntimeCommand::RegisterWindow {
            window_id: window_id.clone(),
        })
        .unwrap();
        let tab_id = core
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: Some(uuid::Uuid::new_v4().to_string()),
                source_id: role_id.to_owned(),
                name: "Running role".to_owned(),
                window_id,
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_ids: vec![role_id.to_owned()],
            })
            .unwrap()
            .created_tab_id
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.to_owned(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id.clone()),
            state: "launching".to_owned(),
            launched_at: None,
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.to_owned(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id),
            state: "running".to_owned(),
            launched_at: Some(chrono::Utc::now().to_rfc3339()),
        })
        .unwrap();
    }

    fn flyff_game_id(core: &AppCore) -> String {
        core.invoke(CoreCommand::GamesList)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|game| game["builtinKey"] == json!("flyff-universe"))
            .and_then(|game| game["id"].as_str())
            .unwrap()
            .to_owned()
    }

    fn create_chrome_import_fixture(source: &std::path::Path) {
        let cookie_path = source.join("Default/Network/Cookies");
        fs::create_dir_all(cookie_path.parent().unwrap()).unwrap();
        fs::write(
            source.join("Local State"),
            br#"{"profile":{"info_cache":{"Default":{"name":"Main"}}}}"#,
        )
        .unwrap();
        let connection = rusqlite::Connection::open(cookie_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
                 INSERT INTO meta(key, value) VALUES ('version', '23');
                 CREATE TABLE cookies(
                   host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER,
                   is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
                   encrypted_value BLOB, top_frame_site_key TEXT
                 );
                 INSERT INTO cookies VALUES
                   ('.flyff.com','remember_session','present','/profile',0,1,1,1,X'','');",
            )
            .unwrap();
    }

    fn preview_chrome_import(core: &AppCore, source: &std::path::Path) -> (String, String) {
        let preview = core
            .invoke(CoreCommand::ChromeProfilePreview {
                source_user_data_dir: source.to_string_lossy().into_owned(),
            })
            .unwrap();
        (
            preview["importId"].as_str().unwrap().to_owned(),
            preview["profiles"][0]["id"].as_str().unwrap().to_owned(),
        )
    }

    fn chrome_import_effect_result(
        effect: CoreEffectRequest,
        auth_state: &str,
    ) -> CoreEffectResult {
        let value_json = matches!(
            effect.action,
            CoreEffectAction::ChromeProfileImportVerify { .. }
        )
        .then(|| json!({ "authState": auth_state }).to_string());
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: true,
            value_json,
            error: None,
        }
    }

    fn drive_post_apply_chrome_import_auth(
        core: Arc<AppCore>,
        auth_states: Vec<ChromeProfileImportAuthStateRecord>,
    ) -> (ChromeProfileImportAuthStateRecord, Vec<CoreEffectAction>) {
        assert!(!auth_states.is_empty());
        let receiver = core.subscribe().unwrap();
        let role_id = "auth-verification-role".to_owned();
        let paths = core.resolve_role_paths(&role_id).unwrap();
        let game = core.state_game(&flyff_game_id(&core)).unwrap();
        let probe = chrome_import_auth_probe(&game).unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation_role_id = role_id.clone();
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.verify_chrome_import_auth_after_apply(
                    &invocation_role_id,
                    &paths,
                    probe,
                ))
        });
        let fallback_auth_state = *auth_states.last().unwrap();
        let mut auth_state_index = 0;
        let mut actions = Vec::new();
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        assert!(matches!(
                            &effect.action,
                            CoreEffectAction::ChromeProfileImportVerify { .. }
                        ));
                        actions.push(effect.action.clone());
                        let auth_state = auth_states
                            .get(auth_state_index)
                            .copied()
                            .unwrap_or(fallback_auth_state);
                        auth_state_index += 1;
                        CoreEffectResult {
                            effect_id: effect.effect_id,
                            operation_id: effect.operation_id,
                            ok: true,
                            value_json: Some(json!({ "authState": auth_state }).to_string()),
                            error: None,
                        }
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (invocation.join().unwrap(), actions)
    }

    fn supported_system_capabilities() -> crate::model::EngineCapabilitySnapshotRecord {
        use crate::model::EngineCapabilityStatus::{Degraded, Supported};

        crate::model::EngineCapabilitySnapshotRecord {
            navigation: Supported,
            persistent_session: Supported,
            trusted_input: Supported,
            background_input: Supported,
            frame_evaluation: Supported,
            popup: Supported,
            audio_mute: Supported,
            custom_fonts: Degraded,
            downloads: Supported,
            file_upload: Supported,
            permissions: Degraded,
            dialogs: Supported,
            certificate_handling: Supported,
        }
    }

    fn install_test_system_runtime(
        core: &AppCore,
        capability_snapshot: crate::model::EngineCapabilitySnapshotRecord,
    ) {
        install_test_system_runtime_for_platform(core, "darwin", capability_snapshot);
    }

    fn install_test_system_runtime_for_platform(
        core: &AppCore,
        platform: &str,
        capability_snapshot: crate::model::EngineCapabilitySnapshotRecord,
    ) {
        let (platform_name, engine) = match platform {
            "darwin" => ("macos", crate::model::ResolvedBrowserEngine::Wkwebview),
            "win32" => ("windows", crate::model::ResolvedBrowserEngine::Webview2),
            _ => panic!("unsupported test platform: {platform}"),
        };
        *core.system_webview_runtime.write().unwrap() = SystemWebViewRuntimeRegistrationRecord {
            platform: platform_name.to_owned(),
            engine,
            adapter_version: "test-wkwebview-1".to_owned(),
            available: true,
            capability_snapshot,
            failure_reason: None,
        };
        core.system_webview_issues.write().unwrap().clear();
    }

    fn drive_command(
        core: Arc<AppCore>,
        command: CoreCommand,
        fail_action: Option<&'static str>,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || invocation_core.invoke(command));
        let actions = Arc::new(Mutex::new(Vec::new()));
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        actions.lock().unwrap().push(effect.action.clone());
                        effect_result(effect, fail_action)
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (
            invocation.join().unwrap(),
            Arc::try_unwrap(actions).unwrap().into_inner().unwrap(),
        )
    }

    fn drive_async_command(
        core: Arc<AppCore>,
        command: CoreCommand,
        fail_action: Option<&'static str>,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>, Vec<()>) {
        drive_async_command_with(core, command, |effect| effect_result(effect, fail_action))
    }

    fn drive_async_command_with(
        core: Arc<AppCore>,
        command: CoreCommand,
        mut result_for: impl FnMut(CoreEffectRequest) -> CoreEffectResult,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>, Vec<()>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.invoke_async(command))
        });
        let actions = Arc::new(Mutex::new(Vec::new()));
        let progress = Arc::new(Mutex::new(Vec::<()>::new()));
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                if let CoreEvent::CoreEffects { effects } = event {
                    let results = effects
                        .into_iter()
                        .map(|effect| {
                            actions.lock().unwrap().push(effect.action.clone());
                            result_for(effect)
                        })
                        .collect();
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        (
            invocation.join().unwrap(),
            Arc::try_unwrap(actions).unwrap().into_inner().unwrap(),
            Arc::try_unwrap(progress).unwrap().into_inner().unwrap(),
        )
    }

    fn drive_chrome_import_recovery(
        core: Arc<AppCore>,
        fail_rollback: bool,
    ) -> (CoreResult<Value>, Vec<CoreEffectAction>) {
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.recover_pending_chrome_profile_imports())
        });
        let mut actions = Vec::new();
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .map(|effect| {
                        let failed = fail_rollback
                            && matches!(
                                effect.action,
                                CoreEffectAction::ChromeProfileImportRollback { .. }
                            );
                        actions.push(effect.action.clone());
                        CoreEffectResult {
                            effect_id: effect.effect_id,
                            operation_id: effect.operation_id,
                            ok: !failed,
                            value_json: None,
                            error: failed.then(|| CoreErrorPayload {
                                code: "SESSION_IMPORT_ROLLBACK_FAILED".to_owned(),
                                message: "Injected rollback failure.".to_owned(),
                            }),
                        }
                    })
                    .collect();
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        (invocation.join().unwrap(), actions)
    }

    fn effect_result(effect: CoreEffectRequest, fail_action: Option<&str>) -> CoreEffectResult {
        let action_name = match &effect.action {
            CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
            CoreEffectAction::EmbeddedDestroyTab { .. } => "embeddedDestroyTab",
            CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
            CoreEffectAction::CompatibilityLoadUrl { .. } => "compatibilityLoadUrl",
            CoreEffectAction::CompatibilityProbeGraphics { .. } => "compatibilityProbeGraphics",
            _ => "other",
        };
        let failed = fail_action == Some(action_name);
        let value_json = match &effect.action {
            CoreEffectAction::CompatibilityLoadUrl { .. } => {
                Some(json!({ "finalUrl": "https://example.com/play?session=private" }).to_string())
            }
            CoreEffectAction::CompatibilityProbeGraphics { .. } => Some(
                json!({
                    "webgl":"available",
                    "webgl2":"available",
                    "webgpu":"unavailable",
                    "renderer":"Fixture GPU"
                })
                .to_string(),
            ),
            _ => None,
        };
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: !failed,
            value_json,
            error: failed.then(|| CoreErrorPayload {
                code: if action_name == "embeddedLoadRoles" {
                    "GAME_PAGE_LOAD_FAILED"
                } else {
                    "DESKTOP_EFFECT_FAILED"
                }
                .to_owned(),
                message: "The fixture rejected the desktop shell effect.".to_owned(),
            }),
        }
    }

    fn workspace_rect(index: usize, count: usize) -> Value {
        let columns = if count == 1 {
            1
        } else if count <= 4 {
            2
        } else {
            3
        };
        let rows = count.div_ceil(columns);
        let column = index % columns;
        let row = index / columns;
        json!({
            "x": column as f64 / columns as f64,
            "y": row as f64 / rows as f64,
            "width": 1.0 / columns as f64,
            "height": 1.0 / rows as f64
        })
    }

    #[test]
    fn moving_the_last_tab_deletes_only_its_empty_source_game_window() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let create_window = |name: &str| {
                core.invoke(command(json!({
                    "type": "gameWindowCreate",
                    "input": {
                        "name": name,
                        "targetDisplay": { "id": 1 },
                        "placement": {
                            "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                            "presentation": "normal"
                        }
                    }
                })))
                .unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            };
            let source_id = create_window("Source");
            let target_id = create_window("Target");
            let launch_target = |window_id: &str| EmbeddedLaunchTargetRecord {
                window_id: window_id.to_owned(),
                display_id: 1,
                work_area: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 1440,
                    height: 900,
                },
                bounds: StatePixelBoundsRecord {
                    x: 0,
                    y: 0,
                    width: 960,
                    height: 640,
                },
                presentation: "normal".to_owned(),
            };
            let created = core
                .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                    tab_id: None,
                    source_id: "role-source".to_owned(),
                    name: "Role".to_owned(),
                    window_id: source_id.clone(),
                    tab_type: "role".to_owned(),
                    workspace_id: None,
                    role_ids: vec!["role-source".to_owned()],
                })
                .unwrap();
            let tab_id = created.created_tab_id.unwrap();
            core.sync_game_windows_from_runtime(
                &created.snapshot,
                &std::collections::HashSet::new(),
            )
            .unwrap();

            drive_async_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedTabMove {
                    tab_id: tab_id.clone(),
                    target: launch_target(&target_id),
                },
                None,
            )
            .0
            .unwrap();

            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(windows[0]["id"], target_id, "{platform}");
            assert_eq!(
                windows[0]["tabs"].as_array().unwrap().len(),
                1,
                "{platform}"
            );
            let runtime = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert!(
                runtime["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|window| { window["windowId"].as_str() != Some(source_id.as_str()) })
            );

            let failed_id = uuid::Uuid::new_v4().to_string();
            let failed = drive_async_command(
                Arc::clone(&core),
                command(json!({
                    "type": "gameWindowCreateAndMoveTab",
                    "input": {
                        "id": failed_id,
                        "name": "Failed Tear Out",
                        "targetDisplay": { "id": 1 },
                        "placement": {
                            "normalBounds": { "x": 80, "y": 60, "width": 960, "height": 640 },
                            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                            "presentation": "normal"
                        }
                    },
                    "tabId": tab_id,
                    "target": {
                        "windowId": failed_id,
                        "displayId": 1,
                        "workArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "bounds": { "x": 80, "y": 60, "width": 960, "height": 640 },
                        "presentation": "normal"
                    }
                })),
                Some("other"),
            )
            .0;
            assert!(failed.is_err(), "{platform}");
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(windows[0]["id"], target_id, "{platform}");

            let torn_out_id = uuid::Uuid::new_v4().to_string();
            drive_async_command(
                Arc::clone(&core),
                command(json!({
                    "type": "gameWindowCreateAndMoveTab",
                    "input": {
                        "id": torn_out_id,
                        "name": "Torn Out",
                        "targetDisplay": { "id": 1 },
                        "placement": {
                            "normalBounds": { "x": 120, "y": 80, "width": 960, "height": 640 },
                            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                            "presentation": "normal"
                        }
                    },
                    "tabId": tab_id,
                    "target": {
                        "windowId": torn_out_id,
                        "displayId": 1,
                        "workArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "bounds": { "x": 120, "y": 80, "width": 960, "height": 640 },
                        "presentation": "normal"
                    }
                })),
                None,
            )
            .0
            .unwrap();
            let windows = core.invoke(CoreCommand::GameWindowsList).unwrap();
            assert_eq!(windows.as_array().unwrap().len(), 1, "{platform}");
            assert_eq!(windows[0]["id"], torn_out_id, "{platform}");
            core.shutdown();
        }
    }

    #[test]
    fn log_level_persists_across_core_restarts_on_supported_platforms() {
        for platform in ["darwin", "win32"] {
            let directory = tempfile::tempdir().unwrap();
            let options = || AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: platform.to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            };

            let first = AppCore::create(options()).unwrap();
            assert_eq!(
                first.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "debug"
            );
            first
                .invoke(CoreCommand::LogsSetLevel {
                    level: LogLevel::Debug,
                })
                .unwrap();
            first.shutdown();
            drop(first);

            let restored = AppCore::create(options()).unwrap();
            assert_eq!(
                restored.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "debug"
            );
            restored
                .invoke(command(json!({
                    "type": "logsCapture",
                    "entries": [{
                        "level": "debug",
                        "source": "main",
                        "event": "restored_debug_capture",
                        "message": "Persisted debug logging is active."
                    }]
                })))
                .unwrap();
            let debug_page = restored
                .invoke(command(json!({
                    "type": "logsQuery",
                    "query": {"levels": ["debug"], "limit": 10}
                })))
                .unwrap();
            assert!(
                debug_page["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["event"] == "restored_debug_capture")
            );
            restored
                .invoke(CoreCommand::LogsSetLevel {
                    level: LogLevel::Info,
                })
                .unwrap();
            restored.shutdown();
            drop(restored);

            let reset = AppCore::create(options()).unwrap();
            assert_eq!(
                reset.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
                "info"
            );
            reset.shutdown();
        }
    }

    #[test]
    fn invalid_persisted_log_level_falls_back_to_debug() {
        let (directory, core) = core();
        core.shutdown();
        drop(core);
        let connection =
            rusqlite::Connection::open(directory.path().join("rion-studio.sqlite3")).unwrap();
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES ('logLevel', 'not-json')
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                [],
            )
            .unwrap();
        drop(connection);

        let restored = AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            platform: "darwin".to_owned(),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        })
        .unwrap();
        assert_eq!(
            restored.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
            "debug"
        );
        restored.shutdown();
    }

    #[test]
    fn failed_log_level_persistence_does_not_change_the_runtime_level() {
        let (_directory, core) = core();
        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_log_level_insert
                 BEFORE INSERT ON settings
                 WHEN NEW.key='logLevel'
                 BEGIN
                   SELECT RAISE(ABORT, 'fixture rejects log level persistence');
                 END;",
            )
            .unwrap();

        assert!(
            core.invoke(CoreCommand::LogsSetLevel {
                level: LogLevel::Debug,
            })
            .is_err()
        );
        assert_eq!(
            core.invoke(CoreCommand::LogsStatus).unwrap()["currentLevel"],
            "debug"
        );
        assert!(
            core.with_runtime(|runtime| runtime.state.read_scalar("logLevel".to_owned()))
                .unwrap()
                .is_none()
        );
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runtime_aware_role_delete_removes_data_and_committed_quarantine() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        core.clone()
            .invoke_async(CoreCommand::RoleDelete {
                id: role_id.clone(),
            })
            .await
            .unwrap();

        crate::v1_case!("state-migration-9848b46489e1", {
            assert!(!directory.path().join("roles").join(&role_id).exists());
            assert!(
                core.invoke(CoreCommand::RolesList)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
        });
        core.shutdown();
    }

    #[test]
    fn role_creation_and_selected_browser_directory_reset_match_v1() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let first_id = create_role(&core, &game_id, 1);
        let second_id = create_role(&core, &game_id, 2);
        let first_browser = directory
            .path()
            .join("roles")
            .join(&first_id)
            .join("browser");
        let second_browser = directory
            .path()
            .join("roles")
            .join(&second_id)
            .join("browser");

        crate::v1_case!("state-migration-2847be74e6ef", {
            let role: StateRoleRecord = serde_json::from_value(
                core.invoke(CoreCommand::RoleGet {
                    id: first_id.clone(),
                })
                .unwrap(),
            )
            .unwrap();
            assert!(first_browser.is_dir());
            let value = serde_json::to_value(role).unwrap();
            assert!(value.get("windowWidth").is_none());
            assert!(value.get("windowHeight").is_none());
            assert!(value.get("launchPreset").is_none());
        });

        fs::write(first_browser.join("session"), b"first").unwrap();
        fs::write(second_browser.join("session"), b"second").unwrap();
        core.invoke(CoreCommand::RoleBrowserDirectoryReset {
            id: first_id.clone(),
        })
        .unwrap();

        crate::v1_case!("state-migration-022970179dc8", {
            assert!(first_browser.is_dir());
            assert!(!first_browser.join("session").exists());
            assert_eq!(fs::read(second_browser.join("session")).unwrap(), b"second");
            assert!(
                core.invoke(CoreCommand::RoleGet {
                    id: first_id.clone()
                })
                .is_ok()
            );
        });
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_role_deletions_do_not_restore_either_role() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let first_id = create_role(&core, &game_id, 1);
        let second_id = create_role(&core, &game_id, 2);
        let first_core = Arc::clone(&core);
        let second_core = Arc::clone(&core);
        let first = first_core.invoke_async(CoreCommand::RoleDelete {
            id: first_id.clone(),
        });
        let second = second_core.invoke_async(CoreCommand::RoleDelete {
            id: second_id.clone(),
        });
        let (first_result, second_result) = tokio::join!(first, second);

        crate::v1_case!("state-migration-badd3d9837fd", {
            first_result.unwrap();
            second_result.unwrap();
            assert!(
                core.invoke(CoreCommand::RolesList)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert!(!directory.path().join("roles").join(first_id).exists());
            assert!(!directory.path().join("roles").join(second_id).exists());
        });
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runtime_aware_role_delete_restores_data_and_lease_when_sqlite_commit_fails() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_role_delete
                 BEFORE DELETE ON roles
                 BEGIN
                   SELECT RAISE(ABORT, 'fixture rejects role deletion');
                 END;",
            )
            .unwrap();
        drop(connection);

        let error = core
            .clone()
            .invoke_async(CoreCommand::RoleDelete {
                id: role_id.clone(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), "CORE_STATE_DATABASE_FAILED");
        assert_eq!(
            fs::read(browser.join("session")).unwrap(),
            b"signed-in".to_vec()
        );
        assert_eq!(
            core.invoke(CoreCommand::RolesList)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );

        let lease = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&lease.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn overlay_requests_validate_and_return_rust_projected_view_models_and_ui_effects() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let role_id = create_role(&core, &game_id, 1);
        let unassigned_role_id = create_role(&core, &game_id, 2);
        let macro_record = core
            .invoke(command(json!({
                "type": "macroCreate",
                "input": {
                    "name": "Overlay macro",
                    "roleIds": [role_id.clone()],
                    "steps": [{"type": "delay", "ms": 10}]
                }
            })))
            .unwrap();
        let macro_id = macro_record["id"].as_str().unwrap().to_owned();
        let mut settings = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
        settings["macroBadgePosition"] =
            json!({"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280});
        core.invoke(command(json!({
            "type": "gameBrowserSettingsReplace",
            "settings": settings
        })))
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let view = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"list\"}",
                "language": "zh-TW"
            }))))
            .unwrap();
        assert_eq!(view["language"], "zh-TW");
        assert_eq!(view["macros"][0]["id"], macro_id);
        assert_eq!(view["statuses"], json!([]));
        crate::v1_case!("overlay-ff7db98ddb5f", {
            assert_eq!(view["macroBadgePosition"]["horizontalAlign"], "right");
            assert!(view["macroBadgePosition"]["topPx"].is_number());
        });
        crate::v1_case!("overlay-368345bae2c9", {
            assert_eq!(view["statuses"], json!([]));
        });

        let error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"start\",\"macroId\":\"not-assigned\"}"
            }))))
            .unwrap_err();
        assert_eq!(error.code(), "MACRO_ROLE_INVALID");

        let start_error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": unassigned_role_id.clone(),
                "requestJson": json!({"type": "start", "macroId": macro_id.clone()}).to_string()
            }))))
            .unwrap_err();
        let stop_error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": unassigned_role_id,
                "requestJson": json!({"type": "stop", "macroId": macro_id.clone()}).to_string()
            }))))
            .unwrap_err();
        crate::v1_case!("macro-7f0e0fdc25ad", {
            assert_eq!(start_error.code(), "MACRO_ROLE_INVALID");
            assert_eq!(stop_error.code(), "MACRO_ROLE_INVALID");
            assert!(core.macro_runtime.statuses().unwrap().is_empty());
        });

        let (opened, actions, _) = drive_async_command(
            Arc::clone(&core),
            command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"open\"}"
            })),
            None,
        );
        assert!(opened.is_ok());
        crate::v1_case!("overlay-af98ca2701ca", {
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::OverlayOpenMacroPage { role_id: current }
                    if current == &role_id
            )));
        });

        let (copied, actions, _) = drive_async_command(
            Arc::clone(&core),
            command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"copy-coordinate\",\"xPercent\":12.5,\"xPx\":10,\"viewportHeightPx\":100,\"viewportWidthPx\":100,\"yPercent\":25,\"yPx\":20}"
            })),
            None,
        );
        assert!(copied.is_ok());
        crate::v1_case!("overlay-ff53e3a9a048", {
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::OverlayCopyCoordinate { coordinate }
                    if coordinate.x_px == 10 && coordinate.y_px == 20
            )));
        });
        core.shutdown();
    }

    #[test]
    fn startup_recovery_restores_or_discards_role_delete_quarantines_by_phase() {
        let directory = tempfile::tempdir().unwrap();
        let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();

        crate::role_browser_data::ensure(directory.path(), "restore-role").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "restore-role",
            "role-delete-restore",
        )
        .unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "role-delete-restore".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({ "roleId": "restore-role" }),
            })
            .unwrap();
        recover_operation_journals(&state, directory.path()).unwrap();
        assert!(directory.path().join("roles/restore-role/browser").exists());

        crate::role_browser_data::ensure(directory.path(), "discard-role").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "discard-role",
            "role-delete-discard",
        )
        .unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "role-delete-discard".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "committed".to_owned(),
                payload: json!({ "roleId": "discard-role" }),
            })
            .unwrap();
        recover_operation_journals(&state, directory.path()).unwrap();
        assert!(!directory.path().join("roles/discard-role").exists());
        assert!(state.operation_journals().unwrap().is_empty());
    }

    #[test]
    fn role_browser_data_clear_commits_only_after_the_native_session_is_cleared() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let (result, actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::RoleBrowserDataClear {
                role_id: role_id.clone(),
            },
            None,
        );

        crate::v1_case!("portable-profile-d7ae496f0b91", {
            let _: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
            assert!(browser.is_dir());
            assert!(!browser.join("session").exists());
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::RoleBrowserDataClearSession {
                    role_id: effect_role_id,
                    ..
                } if effect_role_id == &role_id
            )));
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                core.with_runtime(|runtime| {
                    runtime.state.legacy_session_restore_get(role_id.clone())
                })
                .unwrap()
                .unwrap()
                .status,
                "disabledAfterClear"
            );
        });
        core.shutdown();
    }

    #[test]
    fn role_browser_data_clear_rejects_unknown_roles_before_runtime_or_effect_work() {
        let (_directory, core) = core();
        let receiver = core.subscribe().unwrap();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(core.invoke_async(CoreCommand::RoleBrowserDataClear {
                role_id: "missing".to_owned(),
            }));

        crate::v1_case!("portable-profile-57a504e12e6a", {
            let error = result.unwrap_err();
            assert_eq!(error.code(), "ROLE_NOT_FOUND");
            assert_eq!(error.to_string(), "Role not found.");
            assert!(
                receiver
                    .try_iter()
                    .flatten()
                    .all(|event| { !matches!(event, CoreEvent::CoreEffects { .. }) })
            );
        });
        core.shutdown();
    }

    #[test]
    fn role_browser_data_clear_restores_the_login_directory_after_effect_failure() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let (result, _, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::RoleBrowserDataClear {
                role_id: role_id.clone(),
            },
            Some("roleBrowserDataClearSession"),
        );

        assert_eq!(result.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
        assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );
        assert!(
            core.with_runtime(|runtime| {
                runtime.state.legacy_session_restore_get(role_id.clone())
            })
            .unwrap()
            .is_none()
        );
        let lease = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&lease.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn startup_recovery_restores_a_quarantined_browser_data_clear() {
        let directory = tempfile::tempdir().unwrap();
        let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
        let browser = PathBuf::from(
            crate::role_browser_data::ensure(directory.path(), "recover-role")
                .unwrap()
                .browser_user_data_dir,
        );
        fs::write(browser.join("session"), b"signed-in").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "recover-role",
            "browser-clear-recovery",
        )
        .unwrap();
        crate::role_browser_data::ensure(directory.path(), "recover-role").unwrap();
        fs::write(browser.join("new-session"), b"partial-clear").unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "browser-clear-recovery".to_owned(),
                kind: "role_browser_data_clear_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({ "roleId": "recover-role", "hadDirectory": true }),
            })
            .unwrap();

        recover_operation_journals(&state, directory.path()).unwrap();

        assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
        assert!(!browser.join("new-session").exists());
        assert!(state.operation_journals().unwrap().is_empty());
    }

    #[test]
    fn portable_apply_keeps_the_preview_when_an_affected_macro_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let macro_id = core
            .invoke(command(json!({
                "type":"macroCreate",
                "input":{
                    "name":"Auto heal",
                    "roleIds":[role_id],
                    "steps":[{"type":"delay","ms":1}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: true,
            game_windows: false,
            macros: true,
            preferences: false,
        };
        let mut portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        portable["macros"][0]["steps"][0]["ms"] = json!(2);
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/busy-portable.json".to_owned(),
            })
            .unwrap();
        let import_id = preview["importId"].as_str().unwrap().to_owned();
        core.macro_runtime
            .seed_running_status(&macro_id, &role_id)
            .unwrap();

        let busy = core.invoke(CoreCommand::PortableApply {
            import_id: import_id.clone(),
            selection: selection.clone(),
            resolutions: Vec::new(),
        });
        core.macro_runtime.stop_macro(&macro_id).unwrap();
        let retry = core.invoke(CoreCommand::PortableApply {
            import_id,
            selection,
            resolutions: Vec::new(),
        });

        crate::v1_case!("portable-profile-f3f377a06988", {
            assert_eq!(busy.unwrap_err().code(), "PORTABLE_IMPORT_BUSY");
            assert_eq!(retry.unwrap()["macroCount"], 1);
            assert_eq!(
                core.invoke(CoreCommand::MacroGet {
                    id: macro_id.clone()
                })
                .unwrap()["steps"][0]["ms"],
                2
            );
        });
        core.shutdown();
    }

    #[test]
    fn portable_game_window_import_is_blocked_while_a_role_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let game_window = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Import target",
                    "targetDisplay": { "id": 1 },
                    "placement": {
                        "normalBounds": { "x": 20, "y": 20, "width": 960, "height": 640 },
                        "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "presentation": "normal"
                    }
                }
            })))
            .unwrap();
        let window_id = game_window["id"].as_str().unwrap().to_owned();
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: false,
            game_windows: true,
            macros: false,
            preferences: false,
        };
        let portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/rion-game-window-running-import.json".to_owned(),
            })
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RegisterWindow {
            window_id: window_id.clone(),
        })
        .unwrap();
        let tab_id = core
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: Some(uuid::Uuid::new_v4().to_string()),
                source_id: role_id.clone(),
                name: "Role 1".to_owned(),
                window_id,
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_ids: vec![role_id.clone()],
            })
            .unwrap()
            .created_tab_id
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.clone(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id.clone()),
            state: "launching".to_owned(),
            launched_at: None,
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id,
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id),
            state: "running".to_owned(),
            launched_at: Some(chrono::Utc::now().to_rfc3339()),
        })
        .unwrap();

        let error = core
            .invoke(CoreCommand::PortableApply {
                import_id: preview["importId"].as_str().unwrap().to_owned(),
                selection,
                resolutions: Vec::new(),
            })
            .unwrap_err();

        assert_eq!(error.code(), "PORTABLE_IMPORT_GAME_WINDOWS_RUNNING");
        core.shutdown();
    }

    #[test]
    fn portable_role_import_is_blocked_while_the_affected_role_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: false,
            game_windows: false,
            macros: false,
            preferences: false,
        };
        let mut portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        portable["roles"][0]["launchUrl"] = json!("https://example.com/imported");
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/rion-running-role-import.json".to_owned(),
            })
            .unwrap();
        seed_running_role(&core, &role_id);

        let error = core
            .invoke(CoreCommand::PortableApply {
                import_id: preview["importId"].as_str().unwrap().to_owned(),
                selection,
                resolutions: Vec::new(),
            })
            .unwrap_err();

        assert_eq!(error.code(), "PORTABLE_IMPORT_ROLES_RUNNING");
        assert_eq!(
            core.invoke(CoreCommand::RoleGet { id: role_id }).unwrap()["launchUrl"],
            "https://example.com/play/1"
        );
        core.shutdown();
    }

    #[test]
    fn compatibility_run_owns_effect_order_report_outcome_and_cleanup() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);

        let (result, actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::CompatibilityRun {
                game_id: game_id.clone(),
                versions: RuntimeVersionRecord {
                    engine: crate::model::ResolvedBrowserEngine::Webview2,
                    engine_version: "140".to_owned(),
                    shell: "test".to_owned(),
                    shell_version: "1".to_owned(),
                },
            },
            None,
        );

        let report = result.unwrap();
        assert_eq!(report["gameId"], game_id);
        assert_eq!(report["load"]["state"], "available");
        assert_eq!(report["load"]["finalOrigin"], "https://example.com");
        assert_eq!(report["graphics"]["renderer"], "Fixture GPU");
        assert!(matches!(
            actions.as_slice(),
            [
                CoreEffectAction::CompatibilityCreateWindow { .. },
                CoreEffectAction::CompatibilityConfigureSession { .. },
                CoreEffectAction::CompatibilityLoadUrl { .. },
                CoreEffectAction::CompatibilityProbeGraphics { .. },
                CoreEffectAction::CompatibilityCleanupWindow { .. }
            ]
        ));
        assert!(core.compatibility_runtime().unwrap().statuses().is_empty());
        core.shutdown();
    }

    #[test]
    fn compatibility_load_deadline_is_owned_by_rust_and_still_cleans_up() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let receiver = core.subscribe().unwrap();
        let invocation_core = Arc::clone(&core);
        let invocation_game_id = game_id.clone();
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.invoke_async(CoreCommand::CompatibilityRun {
                    game_id: invocation_game_id,
                    versions: RuntimeVersionRecord {
                        engine: crate::model::ResolvedBrowserEngine::Webview2,
                        engine_version: "140".to_owned(),
                        shell: "test".to_owned(),
                        shell_version: "1".to_owned(),
                    },
                }))
        });
        let mut saw_cleanup = false;
        let mut duplicate_error_code = None;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !invocation.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "compatibility timeout fixture did not complete"
            );
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let results = effects
                    .into_iter()
                    .filter_map(|effect| {
                        if matches!(
                            effect.action,
                            CoreEffectAction::CompatibilityCreateWindow { .. }
                        ) && duplicate_error_code.is_none()
                        {
                            let duplicate = tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .unwrap()
                                .block_on(core.invoke_async(CoreCommand::CompatibilityRun {
                                    game_id: game_id.clone(),
                                    versions: RuntimeVersionRecord {
                                        engine: crate::model::ResolvedBrowserEngine::Webview2,
                                        engine_version: "140".to_owned(),
                                        shell: "test".to_owned(),
                                        shell_version: "1".to_owned(),
                                    },
                                }))
                                .unwrap_err();
                            duplicate_error_code = Some(duplicate.code().to_owned());
                        }
                        if matches!(effect.action, CoreEffectAction::CompatibilityLoadUrl { .. }) {
                            return None;
                        }
                        if matches!(
                            effect.action,
                            CoreEffectAction::CompatibilityCleanupWindow { .. }
                        ) {
                            saw_cleanup = true;
                        }
                        Some(effect_result(effect, None))
                    })
                    .collect::<Vec<_>>();
                if !results.is_empty() {
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        let report = invocation.join().unwrap().unwrap();
        assert_eq!(report["load"]["state"], "failed");
        assert_eq!(report["load"]["errorCode"], "COMPATIBILITY_LOAD_TIMEOUT");
        assert!(saw_cleanup);

        let cancel_core = Arc::clone(&core);
        let cancel_game_id = game_id.clone();
        let cancelled_invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(cancel_core.invoke_async(CoreCommand::CompatibilityRun {
                    game_id: cancel_game_id,
                    versions: RuntimeVersionRecord {
                        engine: crate::model::ResolvedBrowserEngine::Webview2,
                        engine_version: "140".to_owned(),
                        shell: "test".to_owned(),
                        shell_version: "1".to_owned(),
                    },
                }))
        });
        let mut cancel_requested = false;
        let mut saw_cancel_cleanup = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !cancelled_invocation.is_finished() {
            assert!(
                std::time::Instant::now() < deadline,
                "compatibility cancellation fixture did not complete"
            );
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(50)) else {
                continue;
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let mut results = Vec::new();
                for effect in effects {
                    if matches!(effect.action, CoreEffectAction::CompatibilityLoadUrl { .. }) {
                        let requested = core
                            .invoke(CoreCommand::CompatibilityCancel {
                                game_id: game_id.clone(),
                            })
                            .unwrap();
                        cancel_requested = requested["requested"] == true;
                        continue;
                    }
                    if matches!(
                        effect.action,
                        CoreEffectAction::CompatibilityCleanupWindow { .. }
                    ) {
                        saw_cancel_cleanup = true;
                    }
                    results.push(effect_result(effect, None));
                }
                if !results.is_empty() {
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        let cancelled_report = cancelled_invocation.join().unwrap().unwrap();
        crate::v1_case!("browser-workspace-4f62d15e31bf", {
            assert_eq!(
                duplicate_error_code.as_deref(),
                Some("COMPATIBILITY_CHECK_ACTIVE")
            );
            assert_eq!(report["load"]["state"], "failed");
            assert_eq!(report["load"]["errorCode"], "COMPATIBILITY_LOAD_TIMEOUT");
            assert!(saw_cleanup);
            assert!(cancel_requested);
            assert_eq!(cancelled_report["load"]["state"], "cancelled");
            assert!(saw_cancel_cleanup);
            assert!(core.compatibility_runtime().unwrap().statuses().is_empty());
        });
        core.shutdown();
    }

    #[test]
    fn launches_and_stops_an_embedded_role_through_typed_effects() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, launch_actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok());
        assert!(matches!(
            launch_actions.first(),
            Some(CoreEffectAction::EmbeddedCreateTab { tab })
                if tab.roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Wkwebview
                })
        ));
        assert!(launch_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedLoadRoles { roles }
                if roles.len() == 1
                    && roles[0].resolved_engine
                        == crate::model::ResolvedBrowserEngine::Wkwebview
        )));
        assert!(launch_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                if snapshot.roles.iter().any(|role| {
                    role.role_id == role_id && role.state == "running"
                })
        )));
        let (statuses, _) = drive_command(Arc::clone(&core), CoreCommand::BrowserStatuses, None);
        assert!(
            statuses
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .any(|status| { status["roleId"] == role_id && status["state"] == "running" })
        );
        let tab_id = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap()["tabs"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let (hide, _, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedTabHide {
                tab_id: tab_id.clone(),
            },
            None,
        );
        assert!(hide.is_ok());
        let (activate, _, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedTabActivate { tab_id },
            None,
        );
        assert!(activate.is_ok());

        let (stop, stop_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(stop.is_ok());
        assert!(
            stop_actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        );
        assert!(stop_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                if snapshot.roles.is_empty() && snapshot.tabs.is_empty()
        )));
        assert!(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot
                .roles
                .is_empty()
        );
        core.shutdown();
    }

    #[test]
    fn embedded_macro_from_one_role_runs_balanced_iterations_for_each_available_role() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let role_id = create_role(&core, &game_id, 1);
        let sibling_role_id = create_role(&core, &game_id, 2);
        let unavailable_role_id = create_role(&core, &game_id, 3);
        let (launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok());
        let (sibling_launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": sibling_role_id,
                "target": {
                    "displayId": 2,
                    "workArea": {"x": 1200, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(sibling_launch.is_ok());
        let macro_id = core
            .invoke(command(json!({
                "type": "macroCreate",
                "input": {
                    "name": "Digit one loop",
                    "roleIds": [
                        role_id.clone(),
                        sibling_role_id.clone(),
                        unavailable_role_id.clone()
                    ],
                    "trigger": {
                        "code": "KeyQ",
                        "ctrl": false,
                        "alt": false,
                        "shift": false,
                        "meta": false
                    },
                    "repeat": {"type": "loop", "intervalMs": 10},
                    "steps": [{
                        "type": "key",
                        "code": "Digit1",
                        "action": "tap"
                    }]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let receiver = core.subscribe().unwrap();
        let start_core = Arc::clone(&core);
        let start_macro_id = macro_id.clone();
        let source_role_id = role_id.clone();
        let start = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(
                    start_core.invoke_async(CoreCommand::OverlayRequest {
                        role_id: source_role_id,
                        request_json: json!({
                            "type": "start",
                            "macroId": start_macro_id
                        })
                        .to_string(),
                        language: Some("zh-TW".to_owned()),
                    }),
                )
        });
        let expected_roles = HashSet::from([role_id.clone(), sibling_role_id.clone()]);
        let mut presses = HashMap::<String, usize>::new();
        let mut releases = HashMap::<String, usize>::new();
        let mut held_roles = HashSet::<String>::new();
        let mut failed = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while releases.get(&role_id).copied().unwrap_or_default() < 3
            || releases.get(&sibling_role_id).copied().unwrap_or_default() < 3
            || !start.is_finished()
        {
            assert!(
                std::time::Instant::now() < deadline,
                "embedded macro did not complete three iterations"
            );
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            let mut results = Vec::new();
            for event in events {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        for effect in effects {
                            if let CoreEffectAction::BrowserAction { request } = &effect.action
                                && let crate::model::BrowserAction::Key { code, phase, .. } =
                                    &request.action
                            {
                                assert_eq!(code.as_deref(), Some("Digit1"));
                                assert!(expected_roles.contains(&request.role_id));
                                match phase.as_str() {
                                    "hold" => {
                                        assert!(held_roles.insert(request.role_id.clone()));
                                        *presses.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    "release" => {
                                        assert!(held_roles.remove(&request.role_id));
                                        *releases.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    phase => panic!("unexpected macro key phase {phase}"),
                                }
                            }
                            results.push(effect_result(effect, None));
                        }
                    }
                    CoreEvent::MacroStatuses { statuses, .. } => {
                        failed |= statuses.iter().any(|status| status.state == "failed");
                    }
                    _ => {}
                }
            }
            if !results.is_empty() {
                core.dispatch_core_effect_results(results).unwrap();
            }
        }
        let start_view = start.join().unwrap().unwrap();
        crate::v1_case!("overlay-a35a6eef09de", {
            assert_eq!(start_view["startSummary"]["startedCount"], 2);
            assert_eq!(start_view["startSummary"]["skippedCount"], 1);
        });
        crate::v1_case!("resource-platform-c06f9afb7ed3", {
            assert!(!failed);
            assert!(releases.get(&role_id).copied().unwrap_or_default() >= 3);
            assert!(releases.get(&sibling_role_id).copied().unwrap_or_default() >= 3);
            // The loop remains active until MacroStop below, so it may already have
            // started the next balanced iteration after both roles released three
            // times. Assert the fully drained key state only after stop completes.
        });

        let stop_core = Arc::clone(&core);
        let stop = thread::spawn(move || stop_core.invoke(CoreCommand::MacroStop { macro_id }));
        while !stop.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            for event in events {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        let mut results = Vec::new();
                        for effect in effects {
                            if let CoreEffectAction::BrowserAction { request } = &effect.action
                                && let crate::model::BrowserAction::Key { code, phase, .. } =
                                    &request.action
                            {
                                assert_eq!(code.as_deref(), Some("Digit1"));
                                assert!(expected_roles.contains(&request.role_id));
                                match phase.as_str() {
                                    "hold" => {
                                        assert!(held_roles.insert(request.role_id.clone()));
                                        *presses.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    "release" => {
                                        assert!(held_roles.remove(&request.role_id));
                                        *releases.entry(request.role_id.clone()).or_default() += 1;
                                    }
                                    phase => panic!("unexpected macro key phase {phase}"),
                                }
                            }
                            results.push(effect_result(effect, None));
                        }
                        core.dispatch_core_effect_results(results).unwrap();
                    }
                    CoreEvent::MacroStatuses { statuses, .. } => {
                        failed |= statuses.iter().any(|status| status.state == "failed");
                    }
                    _ => {}
                }
            }
        }
        assert!(stop.join().unwrap().is_ok());
        assert!(!failed);
        assert!(held_roles.is_empty());
        assert!(!presses.contains_key(&unavailable_role_id));
        assert!(!releases.contains_key(&unavailable_role_id));
        // Each role advances on its own worker. A role may complete another balanced
        // iteration before the global stop reaches every worker, so cross-role totals
        // are not required to match.
        for expected_role_id in [&role_id, &sibling_role_id] {
            let press_count = presses.get(expected_role_id).copied().unwrap_or_default();
            let release_count = releases.get(expected_role_id).copied().unwrap_or_default();
            assert!(
                release_count >= 3,
                "{expected_role_id} completed only {release_count} loops"
            );
            assert_eq!(
                press_count, release_count,
                "{expected_role_id} key state is unbalanced"
            );
        }
        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(stopped.is_ok());
        let (sibling_stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: sibling_role_id,
            },
            None,
        );
        assert!(sibling_stopped.is_ok());
        core.shutdown();
    }

    #[test]
    fn failed_embedded_stop_republishes_the_running_projection() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok());

        let (stop, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop {
                role_id: role_id.clone(),
            },
            Some("embeddedDestroyTab"),
        );
        assert_eq!(stop.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                    if snapshot.roles.iter().any(|role| {
                        role.role_id == role_id && role.state == "running"
                    })
            )),
            "{actions:?}"
        );
        assert!(
            core.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
                .unwrap()
                .snapshot
                .roles
                .iter()
                .any(|role| role.role_id == role_id && role.state == "running")
        );

        let (cleanup, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(cleanup.is_ok());
        core.shutdown();
    }

    #[test]
    fn rolls_back_runtime_and_native_handles_after_load_failure() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (result, actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            Some("embeddedLoadRoles"),
        );
        assert_eq!(result.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");
        assert!(
            actions
                .iter()
                .any(|action| matches!(action, CoreEffectAction::EmbeddedDestroyTab { .. }))
        );
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert!(snapshot.tabs.is_empty());
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                if snapshot.roles.is_empty() && snapshot.tabs.is_empty()
        )));
        core.shutdown();
    }

    #[test]
    fn stopping_a_launching_role_cancels_the_active_operation_and_rolls_back() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let receiver = core.subscribe().unwrap();
        let launch_core = Arc::clone(&core);
        let launch_role_id = role_id.clone();
        let launch = thread::spawn(move || {
            launch_core.invoke(command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": launch_role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })))
        });
        let mut stop = None;
        let mut saw_compensation = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !launch.is_finished()
            || stop
                .as_ref()
                .is_some_and(|stop: &thread::JoinHandle<_>| !stop.is_finished())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "launch cancellation did not complete before the deadline"
            );
            let events = match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(events) => events,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(error) => panic!("core event channel disconnected: {error}"),
            };
            for event in events {
                let CoreEvent::CoreEffects { effects } = event else {
                    continue;
                };
                let mut results = Vec::new();
                for effect in effects {
                    if matches!(effect.action, CoreEffectAction::EmbeddedLoadRoles { .. })
                        && stop.is_none()
                    {
                        let stop_core = Arc::clone(&core);
                        let stop_role_id = role_id.clone();
                        stop = Some(thread::spawn(move || {
                            stop_core.invoke(CoreCommand::EmbeddedRoleStop {
                                role_id: stop_role_id,
                            })
                        }));
                        continue;
                    }
                    if matches!(effect.action, CoreEffectAction::EmbeddedDestroyTab { .. }) {
                        saw_compensation = true;
                    }
                    results.push(effect_result(effect, None));
                }
                if !results.is_empty() {
                    core.dispatch_core_effect_results(results).unwrap();
                }
            }
        }
        assert_eq!(
            launch.join().unwrap().unwrap_err().code(),
            "LAUNCH_CANCELLED"
        );
        assert!(stop.unwrap().join().unwrap().is_ok());
        assert!(saw_compensation);
        let snapshot = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(snapshot.roles.is_empty());
        assert!(snapshot.tabs.is_empty());
        core.shutdown();
    }

    #[test]
    fn workspace_launch_rejects_a_role_snapshot_that_changed_before_the_lease() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let first_role_id = create_role(&core, &game_id, 1);
        let second_role_id = create_role(&core, &game_id, 2);
        let workspace_id = core
            .invoke(command(json!({
                "type": "workspaceCreate",
                "input": {
                    "name": "Changing workspace",
                    "template": "single",
                    "slots": [{"roleId": first_role_id, "rect": workspace_rect(0, 1)}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        core.invoke(command(json!({
            "type": "workspaceUpdate",
            "id": workspace_id,
            "input": {
                "slots": [{"roleId": second_role_id, "rect": workspace_rect(0, 1)}]
            }
        })))
        .unwrap();

        let error = core
            .launch_embedded_workspace_for_roles(
                &workspace_id,
                std::slice::from_ref(&first_role_id),
                EmbeddedLaunchTargetRecord {
                    window_id: "stale-workspace-window".to_owned(),
                    display_id: 1,
                    work_area: StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 1440,
                        height: 900,
                    },
                    bounds: StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 960,
                        height: 640,
                    },
                    presentation: "normal".to_owned(),
                },
            )
            .unwrap_err();

        assert_eq!(error.code(), "WORKSPACE_DATA_CHANGED");
        let available = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![first_role_id, workspace_operation_key(&workspace_id)],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&available.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn batches_one_four_and_nine_role_workspace_load_effects() {
        for count in [1_usize, 4, 9] {
            let (_directory, core) = core();
            let game_id = first_game_id(&core);
            let role_ids = (0..count)
                .map(|index| create_role(&core, &game_id, index))
                .collect::<Vec<_>>();
            let slots = role_ids
                .iter()
                .enumerate()
                .map(|(index, role_id)| {
                    json!({
                        "roleId": role_id,
                        "rect": workspace_rect(index, count)
                    })
                })
                .collect::<Vec<_>>();
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": format!("{count} roles"),
                        "template": match count {
                            1 => "single",
                            4 => "quad",
                            _ => "nine_grid"
                        },
                        "slots": slots
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let (result, actions) = drive_command(
                Arc::clone(&core),
                command(json!({
                    "type": "embeddedWorkspaceLaunch",
                    "workspaceId": workspace_id,
                    "target": {
                        "displayId": 1,
                        "workArea": {"x": 0, "y": 0, "width": 1800, "height": 1200}
                    }
                })),
                None,
            );
            assert!(result.is_ok(), "{result:?}");
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedLoadRoles { roles } if roles.len() == count
            )));
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                    if snapshot.roles.len() == count
                        && snapshot.roles.iter().all(|role| role.state == "running")
                        && snapshot.workspaces.iter().any(|runtime| {
                            runtime.workspace_id == workspace_id && runtime.state == "running"
                        })
            )));
            let (stop, stop_actions) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWorkspaceStop { workspace_id },
                None,
            );
            assert!(stop.is_ok());
            assert!(stop_actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::EmbeddedApplyRuntime { snapshot, .. }
                    if snapshot.roles.is_empty()
                        && snapshot.tabs.is_empty()
                        && snapshot.workspaces.is_empty()
            )));
            core.shutdown();
        }
    }

    #[test]
    fn transient_system_workspace_launch_failure_does_not_block_a_retry() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = first_game_id(&core);
            let role_id = create_role(&core, &game_id, 1);
            let workspace_id = core
                .invoke(command(json!({
                    "type": "workspaceCreate",
                    "input": {
                        "name": "Retryable workspace",
                        "template": "single",
                        "slots": [{"roleId": role_id, "rect": workspace_rect(0, 1)}]
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let launch_command = || {
                command(json!({
                    "type": "embeddedWorkspaceLaunch",
                    "workspaceId": workspace_id,
                    "target": {
                        "displayId": 1,
                        "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                    }
                }))
            };

            let (failed, _) = drive_command(
                Arc::clone(&core),
                launch_command(),
                Some("embeddedLoadRoles"),
            );
            assert_eq!(failed.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");

            let (retry, retry_actions) = drive_command(Arc::clone(&core), launch_command(), None);
            assert!(retry.is_ok(), "{retry:?}");
            assert!(
                retry_actions
                    .iter()
                    .any(|action| matches!(action, CoreEffectAction::EmbeddedLoadRoles { .. }))
            );

            let (stop, _) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWorkspaceStop { workspace_id },
                None,
            );
            assert!(stop.is_ok());
            core.shutdown();
        }
    }

    #[test]
    fn registered_system_runtime_with_macro_input_launches_macro_assigned_roles() {
        let (_directory, core) = core();
        install_test_system_runtime(&core, supported_system_capabilities());
        let role_id = create_role(&core, &first_game_id(&core), 1);
        core.invoke(command(json!({
            "type": "macroCreate",
            "input": {
                "name": "Supported macro input",
                "roleIds": [role_id.clone()],
                "steps": [{"type": "key", "code": "Digit1", "action": "tap"}]
            }
        })))
        .unwrap();
        let (result, actions) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(result.is_ok(), "{result:?}");
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedCreateTab { tab }
                if tab.roles.iter().all(|role| {
                    role.resolved_engine == crate::model::ResolvedBrowserEngine::Wkwebview
                })
        )));
        let statuses = core.browser_statuses().unwrap();
        assert_eq!(
            statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(
            statuses[0].host_kind,
            Some(crate::model::BrowserHostKind::SystemNative)
        );
        assert_eq!(
            statuses[0]
                .capability_snapshot
                .as_ref()
                .map(|snapshot| snapshot.navigation),
            Some(crate::model::EngineCapabilityStatus::Supported)
        );
        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(stopped.is_ok());
        core.shutdown();
    }

    #[test]
    fn macro_launch_fails_closed_before_surface_creation_when_macro_input_is_unavailable() {
        let (_directory, core) = core();
        let mut capabilities = supported_system_capabilities();
        capabilities.trusted_input = crate::model::EngineCapabilityStatus::Disabled;
        capabilities.background_input = crate::model::EngineCapabilityStatus::Disabled;
        install_test_system_runtime(&core, capabilities);
        let role_id = create_role(&core, &first_game_id(&core), 1);
        core.invoke(command(json!({
            "type": "macroCreate",
            "input": {
                "name": "Requires trusted input",
                "roleIds": [role_id.clone()],
                "steps": [{"type": "key", "code": "Digit1", "action": "tap"}]
            }
        })))
        .unwrap();

        let (result, actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleLaunch {
                role_id,
                target: EmbeddedLaunchTargetRecord {
                    window_id: uuid::Uuid::new_v4().to_string(),
                    display_id: 1,
                    work_area: crate::model::StatePixelBoundsRecord {
                        x: 0,
                        y: 0,
                        width: 1200,
                        height: 800,
                    },
                    bounds: crate::model::StatePixelBoundsRecord {
                        x: 120,
                        y: 80,
                        width: 960,
                        height: 640,
                    },
                    presentation: "normal".to_owned(),
                },
                zoom_factor: None,
            },
            None,
        );

        assert_eq!(
            result.unwrap_err().code(),
            "SYSTEM_WEBVIEW_CAPABILITY_UNAVAILABLE"
        );
        assert!(actions.is_empty());
        let runtime = core
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)
            .unwrap()
            .snapshot;
        assert!(runtime.roles.is_empty());
        assert!(runtime.tabs.is_empty());
        core.shutdown();
    }

    #[test]
    fn crashed_system_surface_stays_on_the_native_engine_and_clears_its_issue_after_recovery() {
        let (_directory, core) = core();
        install_test_system_runtime(&core, supported_system_capabilities());
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let (launch, _) = drive_command(
            Arc::clone(&core),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id,
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok(), "{launch:?}");

        let (failed, failed_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id: role_id.clone(),
                reason: Some("web-content-process-terminated".to_owned()),
            },
            None,
        );
        assert!(failed_actions.is_empty());
        let failed_statuses =
            serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(failed.unwrap())
                .unwrap();
        assert_eq!(
            failed_statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(
            failed_statuses[0].issue_reason,
            Some(crate::model::SystemWebViewIssueReason::RuntimeCrashed)
        );

        let (recovered, recovered_actions) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedSystemSurfaceRecovered {
                role_id: role_id.clone(),
            },
            None,
        );
        assert!(recovered_actions.is_empty());
        let recovered_statuses =
            serde_json::from_value::<Vec<crate::model::BrowserRoleStatusRecord>>(
                recovered.unwrap(),
            )
            .unwrap();
        assert_eq!(
            recovered_statuses[0].resolved_engine,
            Some(crate::model::ResolvedBrowserEngine::Wkwebview)
        );
        assert_eq!(recovered_statuses[0].issue_reason, None);

        let (stopped, _) = drive_command(
            Arc::clone(&core),
            CoreCommand::EmbeddedRoleStop { role_id },
            None,
        );
        assert!(stopped.is_ok());
        core.shutdown();
    }

    #[test]
    fn critical_effect_and_macro_lifecycle_events_wait_for_queue_capacity() {
        let (sender, receiver) = bounded(1);
        let subscribers = Arc::new(Mutex::new(vec![sender]));
        broadcast_events(&subscribers, vec![CoreEvent::Ready { schema_version: 1 }]);
        let broadcasting = {
            let subscribers = Arc::clone(&subscribers);
            thread::spawn(move || {
                broadcast_events(
                    &subscribers,
                    vec![CoreEvent::CoreEffects {
                        effects: Vec::new(),
                    }],
                );
            })
        };

        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()[0],
            CoreEvent::Ready { .. }
        ));
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()[0],
            CoreEvent::CoreEffects { .. }
        ));
        broadcasting.join().unwrap();

        broadcast_events(&subscribers, vec![CoreEvent::Ready { schema_version: 1 }]);
        let macro_broadcasting = {
            let subscribers = Arc::clone(&subscribers);
            thread::spawn(move || {
                broadcast_events(
                    &subscribers,
                    vec![CoreEvent::MacroStatuses {
                        reliable: true,
                        statuses: Vec::new(),
                    }],
                );
            })
        };
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()[0],
            CoreEvent::Ready { .. }
        ));
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap()[0],
            CoreEvent::MacroStatuses { reliable: true, .. }
        ));
        macro_broadcasting.join().unwrap();
    }

    #[test]
    fn browser_actions_are_routed_to_the_worker_and_not_public_subscribers() {
        let (action_sender, action_receiver) = bounded(1);
        let (event_sender, event_receiver) = bounded(1);
        let subscribers = Mutex::new(vec![event_sender]);
        let action = crate::model::BrowserActionRequest {
            request_id: "health-1".to_owned(),
            role_id: "role-1".to_owned(),
            origin: "macro".to_owned(),
            scheduled_at_ms: 1,
            deadline_ms: 2,
            action: crate::model::BrowserAction::Focus,
        };

        route_browser_action_events(
            vec![
                CoreEvent::BrowserActions {
                    actions: vec![action.clone()],
                },
                CoreEvent::Ready { schema_version: 1 },
            ],
            &action_sender,
            &subscribers,
        );

        let routed_actions = action_receiver.recv().unwrap();
        assert_eq!(routed_actions.len(), 1);
        assert_eq!(routed_actions[0].request_id, action.request_id);
        assert_eq!(routed_actions[0].role_id, action.role_id);
        assert_eq!(routed_actions[0].origin, action.origin);
        let public_events = event_receiver.recv().unwrap();
        assert!(
            public_events
                .iter()
                .all(|event| !matches!(event, CoreEvent::BrowserActions { .. }))
        );
        assert!(
            public_events
                .iter()
                .any(|event| matches!(event, CoreEvent::Ready { .. }))
        );
    }

    #[test]
    fn chrome_import_auth_outcomes_never_report_rejected_or_unknown_sessions_as_imported() {
        for (auth_state, expected) in [
            (
                ChromeProfileImportAuthStateRecord::Authenticated,
                "imported",
            ),
            (
                ChromeProfileImportAuthStateRecord::NotAuthenticated,
                "needsLogin",
            ),
            (
                ChromeProfileImportAuthStateRecord::Indeterminate,
                "needsLogin",
            ),
            (
                ChromeProfileImportAuthStateRecord::NotApplicable,
                "imported",
            ),
        ] {
            assert_eq!(chrome_import_status(auth_state), expected);
        }
    }

    #[test]
    fn chrome_import_effect_timeout_exceeds_the_native_navigation_bound() {
        assert!(
            CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT > Duration::from_secs(40),
            "the core must not time out while the native System WebView is still within its navigation deadline"
        );
    }

    #[test]
    fn post_apply_chrome_import_auth_retries_a_transient_login_redirect_on_both_platforms() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let (auth_state, actions) = drive_post_apply_chrome_import_auth(
                Arc::clone(&core),
                vec![
                    ChromeProfileImportAuthStateRecord::NotAuthenticated,
                    ChromeProfileImportAuthStateRecord::Authenticated,
                ],
            );

            assert_eq!(
                auth_state,
                ChromeProfileImportAuthStateRecord::Authenticated,
                "{platform} must accept the rehydrated session during the same import"
            );
            assert_eq!(actions.len(), 2, "{platform} must retry exactly once");
            core.shutdown();
        }
    }

    #[test]
    fn post_apply_chrome_import_auth_retry_is_bounded_and_skips_indeterminate_results() {
        for platform in ["darwin", "win32"] {
            for (auth_state, expected_attempts) in [
                (ChromeProfileImportAuthStateRecord::NotAuthenticated, 3),
                (ChromeProfileImportAuthStateRecord::Indeterminate, 1),
            ] {
                let (_directory, core) = core_for_platform(platform);
                let (result, actions) =
                    drive_post_apply_chrome_import_auth(Arc::clone(&core), vec![auth_state]);

                assert_eq!(result, auth_state, "{platform} must preserve the result");
                assert_eq!(
                    actions.len(),
                    expected_attempts,
                    "{platform} must keep retries bounded"
                );
                core.shutdown();
            }
        }
    }

    #[test]
    fn flyff_chrome_import_preserves_an_already_authenticated_role() {
        for platform in ["darwin", "win32"] {
            let (directory, core) = core_for_platform(platform);
            let source = directory.path().join("chrome-source");
            create_chrome_import_fixture(&source);
            let game_id = flyff_game_id(&core);
            let role_id = core
                .invoke(command(json!({
                    "type": "roleCreate",
                    "input": {
                        "gameId": game_id,
                        "name": "Main",
                        "launchUrl": "https://universe.flyff.com/play"
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let (import_id, profile_id) = preview_chrome_import(&core, &source);
            let (result, actions, _) = drive_async_command_with(
                Arc::clone(&core),
                CoreCommand::ChromeProfileApply {
                    import_id,
                    game_id,
                    consent_accepted: true,
                    resolutions: vec![ChromeProfileImportResolutionRecord::Replace {
                        profile_id,
                        target_role_id: role_id,
                    }],
                },
                |effect| chrome_import_effect_result(effect, "authenticated"),
            );
            let result = result.unwrap();
            assert_eq!(result["items"][0]["status"], json!("alreadyAuthenticated"));
            assert_eq!(result["items"][0]["cookieCount"], json!(0));
            assert_eq!(actions.len(), 1, "{platform} must skip every mutation");
            assert!(matches!(
                actions[0],
                CoreEffectAction::ChromeProfileImportVerify { .. }
            ));
            core.shutdown();
        }
    }

    #[test]
    fn session_transfer_cleanup_preserves_only_journaled_transactions() {
        let (directory, core) = core();
        let active = uuid::Uuid::new_v4().to_string();
        let orphan = uuid::Uuid::new_v4().to_string();
        let root = directory.path().join(".session-transfers");
        fs::create_dir_all(root.join(&active)).unwrap();
        fs::create_dir_all(root.join(&orphan)).unwrap();
        fs::write(root.join(&active).join("backup.enc"), b"active").unwrap();
        fs::write(root.join(&orphan).join("backup.enc"), b"orphan").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-import-active".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "applying".to_owned(),
                payload: json!({ "transactionId": active.clone() }),
            })
        })
        .unwrap();

        core.cleanup_orphaned_session_transfer_directories()
            .unwrap();
        assert!(root.join(&active).is_dir());
        assert!(!root.join(&orphan).exists());
    }

    #[test]
    fn every_chrome_import_journal_phase_blocks_role_launch_until_recovery() {
        let (_directory, core) = core();
        for phase in [
            "prepared",
            "snapshotted",
            "applying",
            "verified",
            "metadataCommitted",
            "committing",
        ] {
            core.with_runtime(|runtime| {
                runtime.state.put_operation_journal(OperationJournalRecord {
                    id: format!("chrome-import-{phase}"),
                    kind: "chrome_profile_import_v2".to_owned(),
                    phase: phase.to_owned(),
                    payload: json!({
                        "roleId": "role-1",
                        "transactionId": uuid::Uuid::new_v4().to_string()
                    }),
                })
            })
            .unwrap();
            assert_eq!(
                core.ensure_role_session_recovery_complete("role-1")
                    .unwrap_err()
                    .code(),
                "ROLE_SESSION_RECOVERY_REQUIRED"
            );
            core.with_runtime(|runtime| {
                runtime
                    .state
                    .delete_operation_journal(format!("chrome-import-{phase}"))
            })
            .unwrap();
        }
    }

    #[test]
    fn every_uncommitted_chrome_import_phase_rolls_back_and_clears_its_journal() {
        for phase in [
            "prepared",
            "snapshotted",
            "applying",
            "verified",
            "metadataCommitted",
            "committing",
        ] {
            let (directory, core) = core();
            let role_id = create_role(&core, &first_game_id(&core), 1);
            let transaction_id = uuid::Uuid::new_v4().to_string();
            let transfer = directory
                .path()
                .join(".session-transfers")
                .join(&transaction_id);
            fs::create_dir_all(&transfer).unwrap();
            fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
            core.with_runtime(|runtime| {
                runtime.state.put_operation_journal(OperationJournalRecord {
                    id: format!("chrome-recovery-{phase}"),
                    kind: "chrome_profile_import_v2".to_owned(),
                    phase: phase.to_owned(),
                    payload: json!({
                        "roleId": role_id,
                        "transactionId": transaction_id,
                        "launchUrl": "https://example.com/play",
                        "createdRole": false
                    }),
                })
            })
            .unwrap();

            let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), false);
            assert_eq!(result.unwrap(), json!({ "recovered": 1, "pending": 0 }));
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::ChromeProfileImportRollback { role_id: current, .. }
                    if current == &role_id
            )));
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
            assert!(!transfer.exists());
            core.shutdown();
        }
    }

    #[test]
    fn committed_chrome_import_marker_finalizes_without_rollback() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let transfer = directory
            .path()
            .join(".session-transfers")
            .join(&transaction_id);
        fs::create_dir_all(&transfer).unwrap();
        fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
        fs::write(transfer.join("committed"), b"").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-recovery-committed".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "committing".to_owned(),
                payload: json!({
                    "roleId": role_id,
                    "transactionId": transaction_id,
                    "launchUrl": "https://example.com/play",
                    "createdRole": false
                }),
            })
        })
        .unwrap();

        let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), false);
        assert_eq!(result.unwrap(), json!({ "recovered": 1, "pending": 0 }));
        assert!(actions.is_empty());
        assert!(core.invoke(CoreCommand::RoleGet { id: role_id }).is_ok());
        assert!(!transfer.exists());
        core.shutdown();
    }

    #[test]
    fn failed_chrome_import_rollback_remains_pending_and_keeps_encrypted_recovery_data() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let transfer = directory
            .path()
            .join(".session-transfers")
            .join(&transaction_id);
        fs::create_dir_all(&transfer).unwrap();
        fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-recovery-pending".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "applying".to_owned(),
                payload: json!({
                    "roleId": role_id,
                    "transactionId": transaction_id,
                    "launchUrl": "https://example.com/play",
                    "createdRole": false
                }),
            })
        })
        .unwrap();

        let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), true);
        assert_eq!(result.unwrap(), json!({ "recovered": 0, "pending": 1 }));
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::ChromeProfileImportRollback { .. }
            ))
        );
        assert_eq!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .len(),
            1
        );
        assert!(transfer.join("backup.enc").is_file());
        core.shutdown();
    }
}
