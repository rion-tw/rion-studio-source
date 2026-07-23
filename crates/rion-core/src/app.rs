use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use futures_util::future::join_all;
use rion_platform::PixelBounds;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::{
    cdn::CdnMatcher,
    database::{
        DatabasePaths, LogDatabaseWorker, OperationJournalRecord, SCHEMA_VERSION,
        StateDatabaseWorker, StateMutation, bootstrap_databases,
    },
    domain::{
        normalize_game_browser_settings, normalize_macro_settings, validate_game_browser_settings,
        validate_legal_acceptance, validate_macro_settings,
    },
    error::{CoreError, CoreResult},
    external_health::ExternalHealthRuntime,
    layout,
    macro_runtime::MacroRuntime,
    model::{
        AppCoreOptions, BrowserActionResult, BrowserOperationRequest, BrowserRuntimeCommand,
        CdnResolutionRecord, ChromeProfileImportProgressRecord, ChromeProfileImportedSessionRecord,
        CompatibilityCheckOutcome, CompatibilityRunPhase, CompatibilityVersionRecord, CoreCommand,
        CoreEffectAction, CoreEffectDispatchReport, CoreEffectResult, CoreEffectTarget, CoreEvent,
        DiagnosticExportResultRecord, ElectronDiagnosticsSnapshotRecord,
        EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord, EmbeddedRoleLoadEffectRecord,
        EmbeddedRoleViewEffectRecord, EmbeddedTabEffectRecord, ExternalChromeDiagnosticsRecord,
        ExternalGraphicsDiagnosticsRecord, ExternalPrepareSessionResultRecord,
        ExternalSessionCommand, ExternalSessionRecord, GameBrowserSettingsRecord,
        GraphicsDiagnosticsRecord, GraphicsVersionRecord, LegalAcceptanceRecord, LogCaptureRecord,
        MacroSettingsRecord, OperationCancelResultRecord, ResourcePolicyDecision,
        ResourcePolicyInput, ResourceRuntimeCommand, ResourceRuntimeStatusRecord,
        ResourceRuntimeTargetRecord, RuntimeWindowPreferencesRecord,
        StateCompatibilityReportRecord, StateGameRecord, StateLaunchWorkspaceRecord,
        StateMacroRecord, StateNormalizedRectRecord, StatePixelBoundsRecord, StateRoleRecord,
        StateWorkspaceResourcePolicyRecord,
    },
    pressure::PressureMonitor,
    resource::resolve_resource_policy,
    scheduler::MonotonicScheduler,
};

const EVENT_QUEUE_CAPACITY: usize = 64;
const CDN_COMPATIBILITY_EXTERNAL_NOTICE: &str =
    "China CDN compatibility mode is active in external Chrome.";
const CDN_COMPATIBILITY_UNAVAILABLE_NOTICE: &str = "China CDN compatibility mode could not be prepared. The game opened with its original resource URLs.";
const EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE: &str =
    "Macro control could not connect to compatibility mode. Restart this role to try again.";
const EXTERNAL_COMPAT_NOTICE: &str = "The embedded browser could not load this game. It opened in external Chrome compatibility mode.";
const EXTERNAL_OVERLAY_BINDING: &str = "rionStudioMacroOverlay";
const EXTERNAL_OVERLAY_BRIDGE_KEY: &str = "__rionStudioExternalMacroBridge";
const EXTERNAL_PAGE_UNRESPONSIVE_NOTICE: &str =
    "The external Chrome game page stopped responding. Capture diagnostics or restart this role.";
const EXTERNAL_ZOOM_UNAVAILABLE_NOTICE: &str =
    "Workspace zoom could not be applied in external Chrome. Restart this role to try again.";

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
    pressure: PressureMonitor,
    scheduler: MonotonicScheduler,
    telemetry: crate::telemetry::TelemetryWorker,
}

pub struct AppCore {
    app_version: String,
    browser_operations: crate::browser_operations::BrowserOperationCoordinator,
    cdn: Arc<RwLock<CdnMatcher>>,
    cdn_detection: Mutex<crate::cdn_detection::CdnDetectionRuntime>,
    browser_runtime: Arc<Mutex<crate::browser_runtime::BrowserRuntime>>,
    chrome_profile_import: Mutex<crate::chrome_profile_import::ChromeProfileImportRuntime>,
    compatibility_runtime: Mutex<crate::compatibility_runtime::CompatibilityRuntime>,
    database_paths: DatabasePaths,
    embedded_input: Mutex<crate::embedded_input::EmbeddedInputRuntime>,
    embedded_operations: Mutex<std::collections::HashMap<String, String>>,
    external_automation: Arc<crate::external_automation::ExternalAutomationRuntime>,
    external_health: Arc<Mutex<ExternalHealthRuntime>>,
    external_processes: crate::external_processes::ExternalProcessRuntime,
    external_sessions: Arc<Mutex<crate::external_sessions::ExternalSessionRuntime>>,
    macro_runtime: Arc<MacroRuntime>,
    log_capture: Mutex<crate::log_capture::LogCaptureRuntime>,
    operation_actor: Arc<crate::operation_actor::OperationActor>,
    platform: rion_platform::Platform,
    portable: Mutex<crate::portable::PortableRuntime>,
    resource_controller: Arc<crate::resource_controller::ResourceController>,
    runtime: Mutex<Option<Runtime>>,
    embedded_runtime_sequence: Arc<crate::runtime_sequence::RuntimeOperationSequence>,
    state_mutation_guard: Mutex<()>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<CoreEvent>>>>>,
    system_fonts: Mutex<Option<Vec<crate::model::SystemFontFamilyRecord>>>,
    user_data_dir: PathBuf,
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
        let platform_name = match platform {
            rion_platform::Platform::Macos => "darwin",
            rion_platform::Platform::Windows => "win32",
        };
        let database_paths = bootstrap_databases(&user_data_dir)?;
        let state = StateDatabaseWorker::start(database_paths.state.clone())?;
        state.recover_portable_import(user_data_dir.clone())?;
        recover_operation_journals(&state, &user_data_dir)?;
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
        let resource_subscribers = Arc::clone(&subscribers);
        let resource_controller = Arc::new(crate::resource_controller::ResourceController::start(
            Arc::clone(&operation_actor),
            Arc::new(move |events| broadcast_events(&resource_subscribers, events)),
        )?);
        let pressure_subscribers = Arc::clone(&subscribers);
        let pressure_resources = Arc::clone(&resource_controller);
        let pressure = PressureMonitor::start(Arc::new(move |snapshot| {
            let _ = pressure_resources.enqueue(ResourceRuntimeCommand::SetPressure {
                level: snapshot.level.clone(),
                reason: snapshot.reason.clone(),
            });
            broadcast_events(
                &pressure_subscribers,
                vec![CoreEvent::PressureChanged { snapshot }],
            );
        }))?;
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
        let macro_subscribers = Arc::clone(&subscribers);
        let macro_resources = Arc::clone(&resource_controller);
        let macro_runtime = Arc::new(MacroRuntime::new(Arc::new(move |events| {
            if let Some(CoreEvent::MacroStatuses { statuses }) = events
                .iter()
                .rev()
                .find(|event| matches!(event, CoreEvent::MacroStatuses { .. }))
            {
                let role_ids = statuses
                    .iter()
                    .filter(|status| matches!(status.state.as_str(), "running" | "stopping"))
                    .map(|status| status.role_id.clone())
                    .collect();
                let _ =
                    macro_resources.enqueue(ResourceRuntimeCommand::SetMacroRoleIds { role_ids });
            }
            broadcast_events(&macro_subscribers, events);
        })));
        let browser_runtime =
            Arc::new(Mutex::new(crate::browser_runtime::BrowserRuntime::default()));
        let external_sessions = Arc::new(Mutex::new(
            crate::external_sessions::ExternalSessionRuntime::default(),
        ));
        let health_subscribers = Arc::clone(&subscribers);
        let health_browser_runtime = Arc::clone(&browser_runtime);
        let health_external_sessions = Arc::clone(&external_sessions);
        let external_health = Arc::new(Mutex::new(ExternalHealthRuntime::new(Arc::new(
            move |mut events| {
                let mut changed = false;
                for event in &events {
                    match event {
                        CoreEvent::ExternalHealthChanged { role_id, health } => {
                            if let Ok(mut sessions) = health_external_sessions.lock()
                                && let Some(session) = sessions.get(role_id).cloned()
                            {
                                let notice = if health == "unresponsive" {
                                    append_external_notice(
                                        session.notice,
                                        EXTERNAL_PAGE_UNRESPONSIVE_NOTICE,
                                    )
                                } else {
                                    remove_external_notice(
                                        session.notice,
                                        EXTERNAL_PAGE_UNRESPONSIVE_NOTICE,
                                    )
                                };
                                let _ = sessions.invoke(ExternalSessionCommand::SetHealth {
                                    role_id: role_id.clone(),
                                    health: Some(health.clone()),
                                    page_hidden: session.page_hidden,
                                });
                                let _ = sessions.invoke(ExternalSessionCommand::SetNotice {
                                    role_id: role_id.clone(),
                                    notice,
                                });
                                changed = true;
                            }
                        }
                        CoreEvent::ExternalHealthProbeFailed { role_id, .. } => {
                            if let Ok(mut sessions) = health_external_sessions.lock() {
                                let _ = sessions.invoke(ExternalSessionCommand::RecordCdpTimeout {
                                    role_id: role_id.clone(),
                                    at_ms: system_epoch_millis(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
                if changed
                    && let (Ok(browser), Ok(sessions)) = (
                        health_browser_runtime.lock(),
                        health_external_sessions.lock(),
                    )
                {
                    events.push(CoreEvent::BrowserStatuses {
                        statuses: crate::external_runtime::role_statuses(
                            browser.snapshot().roles.into_iter(),
                            &sessions.snapshot(),
                        ),
                    });
                }
                broadcast_events(&health_subscribers, events);
            },
        ))?));
        let external_automation = Arc::new(
            crate::external_automation::ExternalAutomationRuntime::new(platform_name.to_owned()),
        );
        let process_subscribers = Arc::clone(&subscribers);
        let process_browser_runtime = Arc::clone(&browser_runtime);
        let process_external_sessions = Arc::clone(&external_sessions);
        let process_external_automation = Arc::clone(&external_automation);
        let process_external_health = Arc::clone(&external_health);
        let process_macro_runtime = Arc::clone(&macro_runtime);
        let external_processes = crate::external_processes::ExternalProcessRuntime::new(Arc::new(
            move |role_id, event| {
                let mut changed = false;
                if let (Ok(mut browser), Ok(mut sessions)) = (
                    process_browser_runtime.lock(),
                    process_external_sessions.lock(),
                ) && let Some(session) = sessions.get(&role_id).cloned()
                {
                    let _ = sessions.invoke(crate::model::ExternalSessionCommand::Remove {
                        role_id: role_id.clone(),
                        preserve_workspace: false,
                    });
                    let _ = browser.invoke(crate::model::BrowserRuntimeCommand::RemoveRole {
                        role_id: role_id.clone(),
                    });
                    if let Some(workspace_id) = session.workspace_id
                        && !sessions.workspace_has_sessions(&workspace_id)
                    {
                        let _ =
                            browser.invoke(crate::model::BrowserRuntimeCommand::RemoveWorkspace {
                                workspace_id,
                            });
                    }
                    changed = true;
                }
                let _ = process_external_automation.unregister(&role_id);
                if let Ok(health) = process_external_health.lock() {
                    let _ = health.remove(role_id.clone());
                }
                let _ = process_macro_runtime.release_role(&role_id);
                let mut events = vec![CoreEvent::ExternalProcessExited {
                    role_id,
                    exit_code: event.exit_code,
                    terminated: event.terminated,
                }];
                if changed
                    && let (Ok(browser), Ok(sessions)) = (
                        process_browser_runtime.lock(),
                        process_external_sessions.lock(),
                    )
                {
                    events.push(CoreEvent::BrowserStatuses {
                        statuses: crate::external_runtime::role_statuses(
                            browser.snapshot().roles.into_iter(),
                            &sessions.snapshot(),
                        ),
                    });
                }
                broadcast_events(&process_subscribers, events);
            },
        ));
        let core = Self {
            app_version: options.app_version,
            browser_operations: crate::browser_operations::BrowserOperationCoordinator::default(),
            browser_runtime,
            cdn: Arc::new(RwLock::new(CdnMatcher::bundled()?)),
            cdn_detection: Mutex::new(crate::cdn_detection::CdnDetectionRuntime::default()),
            chrome_profile_import: Mutex::new(
                crate::chrome_profile_import::ChromeProfileImportRuntime::new(
                    user_data_dir.clone(),
                ),
            ),
            compatibility_runtime: Mutex::new(
                crate::compatibility_runtime::CompatibilityRuntime::default(),
            ),
            database_paths,
            embedded_input: Mutex::new(crate::embedded_input::EmbeddedInputRuntime::default()),
            embedded_operations: Mutex::new(std::collections::HashMap::new()),
            external_automation,
            external_health,
            external_processes,
            external_sessions,
            log_capture: Mutex::new(crate::log_capture::LogCaptureRuntime::new(
                user_data_dir.clone(),
            )),
            macro_runtime,
            operation_actor,
            platform,
            portable: Mutex::new(crate::portable::PortableRuntime::default()),
            resource_controller,
            runtime: Mutex::new(Some(Runtime {
                state,
                logs,
                pressure,
                scheduler,
                telemetry,
            })),
            embedded_runtime_sequence: Arc::new(
                crate::runtime_sequence::RuntimeOperationSequence::default(),
            ),
            state_mutation_guard: Mutex::new(()),
            subscribers,
            system_fonts: Mutex::new(None),
            user_data_dir,
        };
        core.emit(vec![CoreEvent::Ready {
            schema_version: SCHEMA_VERSION,
        }]);
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
            CoreCommand::RoleSetBrowserSessionSource { id, source } => {
                self.mutate_state(StateMutation::RoleSetBrowserSessionSource { id, source })
            }
            CoreCommand::RoleAssignGameIds { assignments } => {
                self.mutate_state(StateMutation::RoleAssignGameIds(assignments))
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
            CoreCommand::WorkspaceReconcileDisplays { displays } => {
                self.mutate_state(StateMutation::WorkspaceReconcileDisplays(displays))
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
            CoreCommand::CompatibilityPrepare {
                game_id,
                system_chrome_available,
                versions,
            } => {
                let _guard = self.state_mutation_guard()?;
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                    "gameBrowserSettings",
                    "game browser settings are missing",
                )?;
                let (plan, statuses) = {
                    let mut runtime = self.compatibility_runtime()?;
                    let plan = runtime.prepare(
                        &games,
                        &settings,
                        &game_id,
                        system_chrome_available,
                        &versions,
                    )?;
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
                let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                    "gameBrowserSettings",
                    "game browser settings are missing",
                )?;
                serde_json::to_value(
                    crate::compatibility_runtime::CompatibilityRuntime::current_reports(
                        &games, &reports, &settings, &versions,
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
            CoreCommand::LegalAcceptanceStatus { versions } => {
                let acceptance =
                    self.read_optional_scalar_state::<LegalAcceptanceRecord>("legalAcceptance")?;
                serde_json::to_value(crate::legal::status(acceptance.as_ref(), versions))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LegalAcceptanceAccept { versions, input } => {
                let acceptance = crate::legal::accept(&versions, input)?;
                validate_legal_acceptance(&acceptance)?;
                self.replace_scalar_state("legalAcceptance", acceptance.clone())?;
                serde_json::to_value(crate::legal::status(Some(&acceptance), versions))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserPreferencesApply {
                browser_user_data_dir,
                role_session_partition,
                fonts,
                zoom_factor,
            } => Ok(json!({
                "updatedPaths": crate::browser_preferences::apply(
                    &self.user_data_dir,
                    &PathBuf::from(browser_user_data_dir),
                    role_session_partition.as_deref(),
                    &fonts,
                    zoom_factor,
                )?
            })),
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
                let _guard = self.state_mutation_guard()?;
                let snapshot = self.read_typed_snapshot()?;
                let mut portable = self.portable()?;
                let prepared =
                    portable.prepare_apply(&import_id, selection, resolutions, snapshot)?;
                let lease_id = if prepared.affected_macro_ids.is_empty() {
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
                            return Err(CoreError::Domain {
                                code: "PORTABLE_IMPORT_BUSY",
                                message: "Stop affected macros before importing.".to_owned(),
                            });
                        }
                        Err(error) => return Err(error),
                    }
                };
                let result = (|| {
                    let snapshot = serde_json::to_value(&prepared.snapshot)
                        .map_err(|error| CoreError::Internal(error.to_string()))?;
                    let (revision, changed) =
                        self.with_runtime(|runtime| runtime.state.replace_snapshot(snapshot))?;
                    portable.discard(&import_id);
                    if changed {
                        self.emit(vec![CoreEvent::StateChanged { revision }]);
                    }
                    serde_json::to_value(prepared.result)
                        .map_err(|error| CoreError::Internal(error.to_string()))
                })();
                if let Some(lease_id) = lease_id {
                    self.macro_runtime.release_mutation(&lease_id)?;
                }
                result
            }
            CoreCommand::PortableDiscard { import_id } => {
                Ok(json!({ "discarded": self.portable()?.discard(&import_id) }))
            }
            CoreCommand::ResourceResolve { input } => {
                serde_json::to_value(resolve_resource_policy(&input))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::LayoutResolve { input } => serde_json::to_value(layout::resolve(&input))
                .map_err(|error| CoreError::Internal(error.to_string())),
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
            CoreCommand::TelemetrySnapshot => self.with_runtime(|runtime| {
                serde_json::to_value(runtime.telemetry.snapshot()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }),
            CoreCommand::MacroStart { request } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                let request = crate::model::MacroStartRequest {
                    macros,
                    settings,
                    macro_id: request.macro_id,
                    role_id: request.role_id,
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
                        role_id: Some(request.role_id),
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
            CoreCommand::MacroStopForRole { macro_id, role_id } => {
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
                    && !macro_definition.role_ids.contains(&role_id)
                {
                    return Err(CoreError::Domain {
                        code: "MACRO_ROLE_INVALID",
                        message: "This macro is not assigned to the current role.".to_owned(),
                    });
                }
                self.macro_runtime.stop_macro_role(&macro_id, &role_id)?;
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
            CoreCommand::ExternalHealthRegister { role_id } => {
                self.external_health()?.register(role_id)?;
                Ok(json!({ "registered": true }))
            }
            CoreCommand::ExternalHealthHeartbeat {
                role_id,
                page_hidden,
            } => {
                self.external_health()?.heartbeat(role_id, page_hidden)?;
                Ok(json!({ "updated": true }))
            }
            CoreCommand::ExternalHealthRemove { role_id } => {
                self.external_health()?.remove(role_id)?;
                Ok(json!({ "removed": true }))
            }
            CoreCommand::ExternalHealthSuspend { suspended } => {
                self.external_health()?.suspend(suspended)?;
                Ok(json!({ "suspended": suspended }))
            }
            CoreCommand::ExternalProcessLaunch {
                role_id,
                executable_path,
                arguments,
            } => Ok(json!({
                "pid": self.external_processes.launch(
                    role_id,
                    PathBuf::from(executable_path).as_path(),
                    &arguments,
                )?
            })),
            CoreCommand::ExternalProcessTerminate { role_id } => Ok(json!({
                "terminated": self.external_processes.terminate(&role_id)?
            })),
            CoreCommand::ChromeProfileDefaultPath => Ok(json!({
                "path": rion_platform::default_chrome_user_data_directory(self.platform)
                    .map(|path| path.to_string_lossy().into_owned())
            })),
            CoreCommand::ChromeProfilePreview {
                source_user_data_dir,
            } => {
                let preview = self
                    .chrome_profile_import()?
                    .preview(&source_user_data_dir)?;
                serde_json::to_value(preview)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfilePrepare {
                import_id,
                profile_ids,
                game_id,
                consent_accepted,
            } => {
                let _guard = self.state_mutation_guard()?;
                let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
                let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
                let prepared = self.chrome_profile_import()?.prepare(
                    &import_id,
                    profile_ids,
                    &game_id,
                    consent_accepted,
                    &games,
                    &roles,
                )?;
                serde_json::to_value(prepared)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileCommit { import_id } => {
                let _guard = self.state_mutation_guard()?;
                let roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
                let mut profile_import = self.chrome_profile_import()?;
                let prepared = profile_import.commit_files(&import_id, roles)?;
                let revision = match self.with_runtime(|runtime| {
                    runtime.state.apply_profile_roles(prepared.roles.clone())
                }) {
                    Ok(revision) => revision,
                    Err(error) => {
                        let _ = profile_import.finish_rollback(&import_id);
                        return Err(error);
                    }
                };
                self.emit(vec![CoreEvent::StateChanged { revision }]);
                serde_json::to_value(prepared.result)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ChromeProfileFinalize { import_id } => {
                self.chrome_profile_import()?.finalize(&import_id)?;
                Ok(json!({ "finalized": true }))
            }
            CoreCommand::ChromeProfileRollback { import_id } => {
                let _guard = self.state_mutation_guard()?;
                let mut profile_import = self.chrome_profile_import()?;
                let roles = profile_import.rollback_roles(&import_id)?;
                let revision =
                    self.with_runtime(|runtime| runtime.state.apply_profile_roles(roles))?;
                profile_import.finish_rollback(&import_id)?;
                self.emit(vec![CoreEvent::StateChanged { revision }]);
                Ok(json!({ "rolledBack": true }))
            }
            CoreCommand::ChromeProfileDiscard { import_id } => {
                self.chrome_profile_import()?.discard(&import_id)?;
                Ok(json!({ "discarded": true }))
            }
            CoreCommand::ChromeProfileReadCookies {
                browser_user_data_dir,
            } => serde_json::to_value(crate::chrome_cookies::read_imported_cookies(
                &PathBuf::from(browser_user_data_dir),
                self.platform,
            )?)
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
            CoreCommand::EmbeddedWindowsShow { display_id } => {
                let display_ids = match display_id {
                    Some(display_id) => vec![display_id],
                    None => self
                        .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                        .snapshot
                        .displays
                        .into_iter()
                        .map(|display| display.display_id)
                        .collect(),
                };
                serde_json::to_value(
                    self.apply_embedded_runtime_command(
                        display_ids
                            .iter()
                            .map(|display_id| BrowserRuntimeCommand::ShowDisplay {
                                display_id: *display_id,
                            })
                            .collect(),
                        None,
                        display_ids.clone(),
                        display_ids,
                        None,
                        None,
                    )?,
                )
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabActivate { tab_id } => {
                let display_id = self.embedded_tab_display_id(&tab_id)?;
                serde_json::to_value(self.apply_embedded_runtime_command(
                    vec![BrowserRuntimeCommand::ActivateTab {
                        tab_id: tab_id.clone(),
                    }],
                    None,
                    vec![display_id],
                    vec![display_id],
                    Some(tab_id),
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedTabActivateAdjacent {
                display_id,
                direction,
            } => serde_json::to_value(self.apply_embedded_runtime_command(
                vec![BrowserRuntimeCommand::ActivateAdjacentTab {
                    display_id,
                    direction,
                }],
                None,
                vec![display_id],
                Vec::new(),
                None,
                Some(display_id),
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
                        display_id: target.display_id,
                    }],
                    Some(target.clone()),
                    vec![target.display_id],
                    vec![target.display_id],
                    Some(tab_id),
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedDisplayRemove {
                display_id,
                fallback,
            } => serde_json::to_value(self.apply_embedded_runtime_command(
                vec![BrowserRuntimeCommand::MoveDisplayTabs {
                    source_display_id: display_id,
                    target_display_id: fallback.display_id,
                }],
                Some(fallback.clone()),
                vec![fallback.display_id],
                Vec::new(),
                None,
                None,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserStatuses => serde_json::to_value(self.browser_statuses()?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserWorkspaceStatuses => {
                serde_json::to_value(self.browser_workspace_statuses()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRuntimeSuspend { suspended } => {
                self.external_health()?.suspend(suspended)?;
                Ok(json!({ "suspended": suspended }))
            }
            CoreCommand::ExternalDiagnosticsList => {
                let sessions = self
                    .external_sessions
                    .lock()
                    .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
                    .snapshot();
                serde_json::to_value(
                    sessions
                        .iter()
                        .map(|session| {
                            crate::external_runtime::diagnostics(session, sessions.len(), None)
                        })
                        .collect::<Vec<_>>(),
                )
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleBrowserDataClear { .. }
            | CoreCommand::ChromeProfileApply { .. }
            | CoreCommand::CompatibilityRun { .. }
            | CoreCommand::CdnResolveSession { .. }
            | CoreCommand::GraphicsDiagnosticsAssemble { .. }
            | CoreCommand::DiagnosticsExport { .. }
            | CoreCommand::SystemChromeClose
            | CoreCommand::BrowserRoleLaunch { .. }
            | CoreCommand::BrowserWorkspaceLaunch { .. }
            | CoreCommand::BrowserRoleStop { .. }
            | CoreCommand::BrowserWorkspaceStop { .. }
            | CoreCommand::BrowserExternalRecover { .. }
            | CoreCommand::ExternalDiagnosticsCapture { .. }
            | CoreCommand::ResourceActivateWorkspace { .. }
            | CoreCommand::ResourceDeactivateWorkspace { .. }
            | CoreCommand::ResourceRefreshTarget { .. } => Err(CoreError::Internal(
                "asynchronous browser intent reached the synchronous core dispatcher".to_owned(),
            )),
        }
    }

    pub async fn invoke_async(self: &Arc<Self>, command: CoreCommand) -> CoreResult<Value> {
        match command {
            CoreCommand::RoleBrowserDataClear { role_id } => {
                self.clear_role_browser_data(role_id).await
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
                    .external_workspace(&id)?
                    .slots
                    .into_iter()
                    .filter_map(|slot| slot.role_id)
                    .collect::<Vec<_>>();
                role_ids.extend(workspace_update_role_ids(&input));
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
            CoreCommand::ChromeProfileApply {
                import_id,
                profile_ids,
                game_id,
                consent_accepted,
            } => {
                self.apply_chrome_profile_import(import_id, profile_ids, game_id, consent_accepted)
                    .await
            }
            CoreCommand::CompatibilityRun { game_id, versions } => {
                self.run_compatibility_check(game_id, versions).await
            }
            CoreCommand::CdnResolveSession { session_handle_id } => {
                serde_json::to_value(self.resolve_cdn_session(session_handle_id).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::GraphicsDiagnosticsAssemble {
                applied_settings,
                embedded_raw_json,
                embedded_error,
                gpu_info_raw_json,
                feature_status_raw_json,
                gpu_info_ready,
                hardware_acceleration_enabled,
                platform,
                versions,
            } => serde_json::to_value(
                self.assemble_graphics_diagnostics(
                    applied_settings,
                    embedded_raw_json,
                    embedded_error,
                    gpu_info_raw_json,
                    feature_status_raw_json,
                    gpu_info_ready,
                    hardware_acceleration_enabled,
                    platform,
                    versions,
                )
                .await?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::DiagnosticsExport { path, snapshot } => {
                serde_json::to_value(self.export_diagnostics(path, snapshot).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::SystemChromeClose => {
                let platform = self.platform;
                tokio::task::spawn_blocking(move || {
                    rion_platform::request_graceful_chrome_quit(platform)
                        .map_err(|_| CoreError::Domain {
                            code: "CHROME_CLOSE_FAILED",
                            message: "Unable to ask Google Chrome to close. Close Chrome manually and try again.".to_owned(),
                        })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "closed": true }))
            }
            CoreCommand::BrowserRoleLaunch {
                role_id,
                target,
                zoom_factor,
            } => {
                let role = self.external_role(&role_id)?;
                let game = self.external_game(&role.game_id)?;
                let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                    "gameBrowserSettings",
                    "game browser settings are missing",
                )?;
                let mode = crate::external_runtime::resolve_launch_mode(
                    &game.browser_launch_mode,
                    &settings.launch_mode,
                );
                let zoom_factor = zoom_factor.unwrap_or(1.0);
                let statuses = match mode {
                    "external" => {
                        vec![
                            self.launch_external_role(role, target, zoom_factor, None, settings)
                                .await?,
                        ]
                    }
                    "auto" => {
                        let core = Arc::clone(self);
                        let embedded_target = target.clone();
                        let role_id = role.id.clone();
                        match tokio::task::spawn_blocking(move || {
                            core.launch_embedded_role(&role_id, embedded_target, zoom_factor)
                        })
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))?
                        {
                            Ok(statuses) => statuses.into_iter().map(embedded_status).collect(),
                            Err(error) if error.code() == "GAME_PAGE_LOAD_FAILED" => {
                                vec![
                                    self.launch_external_role(
                                        role,
                                        target,
                                        zoom_factor,
                                        Some(EXTERNAL_COMPAT_NOTICE.to_owned()),
                                        settings,
                                    )
                                    .await?,
                                ]
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    _ => {
                        let core = Arc::clone(self);
                        let role_id = role.id;
                        tokio::task::spawn_blocking(move || {
                            core.launch_embedded_role(&role_id, target, zoom_factor)
                        })
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))??
                        .into_iter()
                        .map(embedded_status)
                        .collect()
                    }
                };
                serde_json::to_value(statuses)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserWorkspaceLaunch {
                workspace_id,
                target,
            } => {
                let workspace = self.external_workspace(&workspace_id)?;
                let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                    "gameBrowserSettings",
                    "game browser settings are missing",
                )?;
                let mode = crate::external_runtime::resolve_launch_mode(
                    &workspace.browser_launch_mode,
                    &settings.launch_mode,
                );
                let statuses = match mode {
                    "external" => {
                        self.launch_external_workspace(workspace, target, None, settings)
                            .await?
                    }
                    "auto" => {
                        let core = Arc::clone(self);
                        let embedded_target = target.clone();
                        let embedded_workspace_id = workspace.id.clone();
                        match tokio::task::spawn_blocking(move || {
                            core.launch_embedded_workspace(&embedded_workspace_id, embedded_target)
                        })
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))?
                        {
                            Ok(statuses) => statuses.into_iter().map(embedded_status).collect(),
                            Err(error) if error.code() == "GAME_PAGE_LOAD_FAILED" => {
                                self.launch_external_workspace(
                                    workspace,
                                    target,
                                    Some(EXTERNAL_COMPAT_NOTICE.to_owned()),
                                    settings,
                                )
                                .await?
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    _ => {
                        let core = Arc::clone(self);
                        let embedded_workspace_id = workspace.id;
                        tokio::task::spawn_blocking(move || {
                            core.launch_embedded_workspace(&embedded_workspace_id, target)
                        })
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))??
                        .into_iter()
                        .map(embedded_status)
                        .collect()
                    }
                };
                serde_json::to_value(statuses)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRoleStop { role_id } => {
                let runtime = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot
                    .roles
                    .into_iter()
                    .find(|role| role.role_id == role_id)
                    .map(|role| role.runtime);
                if runtime.as_deref() == Some("external") {
                    self.stop_external_role(&role_id).await?;
                } else {
                    let core = Arc::clone(self);
                    tokio::task::spawn_blocking(move || core.stop_embedded_role(&role_id))
                        .await
                        .map_err(|error| CoreError::Internal(error.to_string()))??;
                }
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserWorkspaceStop { workspace_id } => {
                let runtime = self
                    .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
                    .snapshot
                    .workspaces
                    .into_iter()
                    .find(|workspace| workspace.workspace_id == workspace_id)
                    .map(|workspace| workspace.runtime);
                if runtime.as_deref() == Some("external") {
                    self.stop_external_workspace(&workspace_id).await?;
                } else {
                    let core = Arc::clone(self);
                    tokio::task::spawn_blocking(move || {
                        core.stop_embedded_workspace(&workspace_id)
                    })
                    .await
                    .map_err(|error| CoreError::Internal(error.to_string()))??;
                }
                Ok(json!({ "stopped": true }))
            }
            CoreCommand::BrowserExternalRecover { role_id } => {
                serde_json::to_value(self.recover_external_role(&role_id).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ExternalDiagnosticsCapture { role_id } => {
                serde_json::to_value(self.capture_external_diagnostics(&role_id).await?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::ResourceActivateWorkspace {
                workspace_id,
                policy_mode,
                targets,
            } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.resource_controller
                        .invoke(ResourceRuntimeCommand::ActivateWorkspace {
                            workspace_id,
                            policy_mode,
                            targets,
                        })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "activated": true }))
            }
            CoreCommand::ResourceDeactivateWorkspace { workspace_id } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.resource_controller
                        .invoke(ResourceRuntimeCommand::DeactivateWorkspace { workspace_id })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "deactivated": true }))
            }
            CoreCommand::ResourceRefreshTarget {
                workspace_id,
                role_id,
                process_id,
            } => {
                let core = Arc::clone(self);
                tokio::task::spawn_blocking(move || {
                    core.resource_controller
                        .invoke(ResourceRuntimeCommand::RefreshTarget {
                            workspace_id,
                            role_id,
                            process_id,
                        })
                })
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))??;
                Ok(json!({ "refreshed": true }))
            }
            command => self.invoke(command),
        }
    }

    async fn stop_role_runtime(self: &Arc<Self>, role_id: &str) -> CoreResult<()> {
        let runtime = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .roles
            .into_iter()
            .find(|role| role.role_id == role_id)
            .map(|role| role.runtime);
        if runtime.as_deref() == Some("external") {
            self.stop_external_role(role_id).await
        } else if runtime.as_deref() == Some("embedded") {
            let core = Arc::clone(self);
            let role_id = role_id.to_owned();
            tokio::task::spawn_blocking(move || core.stop_embedded_role(&role_id))
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
        } else {
            Ok(())
        }
    }

    async fn stop_workspace_runtime(self: &Arc<Self>, workspace_id: &str) -> CoreResult<()> {
        let runtime = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .workspaces
            .into_iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .map(|workspace| workspace.runtime);
        if runtime.as_deref() == Some("external") {
            self.stop_external_workspace(workspace_id).await
        } else if runtime.as_deref() == Some("embedded") {
            let core = Arc::clone(self);
            let workspace_id = workspace_id.to_owned();
            tokio::task::spawn_blocking(move || core.stop_embedded_workspace(&workspace_id))
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
        } else {
            Ok(())
        }
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
        if candidate.game_id != current.game_id || candidate.launch_url != current.launch_url {
            self.stop_role_runtime(&id).await?;
        }
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            core.mutate_with_role_lease(vec![id.clone()], StateMutation::RoleUpdate { id, input })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    async fn delete_role_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        self.ensure_role_exists(&id)?;
        self.stop_role_runtime(&id).await?;
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || core.delete_role_saga(&id))
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    async fn delete_roles_runtime_aware(self: &Arc<Self>, ids: Vec<String>) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let existing = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| role.id)
            .collect::<std::collections::HashSet<_>>();
        let mut eligible = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            match self.stop_role_runtime(&id).await {
                Ok(()) => eligible.push(id),
                Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
            }
        }
        if eligible.is_empty() {
            return Ok(json!({ "deletedIds": [], "skipped": skipped }));
        }
        let core = Arc::clone(self);
        let mut result = tokio::task::spawn_blocking(move || core.delete_roles_saga(eligible))
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))??;
        if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
            result_skipped.extend(skipped);
        }
        Ok(result)
    }

    async fn delete_workspace_runtime_aware(self: &Arc<Self>, id: String) -> CoreResult<Value> {
        self.read_state_record(
            "launchWorkspaces",
            "id",
            &id,
            "WORKSPACE_NOT_FOUND",
            "Launch workspace not found.",
        )?;
        self.stop_workspace_runtime(&id).await?;
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            core.mutate_state(StateMutation::WorkspaceDelete { id })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    async fn delete_workspaces_runtime_aware(
        self: &Arc<Self>,
        ids: Vec<String>,
    ) -> CoreResult<Value> {
        let ids = normalize_runtime_bulk_ids(ids)?;
        let existing = self
            .read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?
            .into_iter()
            .map(|workspace| workspace.id)
            .collect::<std::collections::HashSet<_>>();
        let mut eligible = Vec::new();
        let mut skipped = Vec::new();
        for id in ids {
            if !existing.contains(&id) {
                skipped.push(json!({ "id": id, "reason": "not_found", "relatedNames": [] }));
                continue;
            }
            match self.stop_workspace_runtime(&id).await {
                Ok(()) => eligible.push(id),
                Err(error) => skipped.push(classify_runtime_bulk_error(id, &error)),
            }
        }
        let core = Arc::clone(self);
        let mut result = tokio::task::spawn_blocking(move || {
            core.mutate_state(StateMutation::WorkspacesDelete { ids: eligible })
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))??;
        if let Some(result_skipped) = result.get_mut("skipped").and_then(Value::as_array_mut) {
            result_skipped.extend(skipped);
        }
        Ok(result)
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
        self.macro_runtime.stop_role(id)?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![id.to_owned()],
            kind: "destructiveMutation".to_owned(),
        })?;
        let result = (|| {
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
        })();
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

    fn delete_roles_saga(&self, ids: Vec<String>) -> CoreResult<Value> {
        for id in &ids {
            self.ensure_role_exists(id)?;
            self.macro_runtime.stop_role(id)?;
        }
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: ids.clone(),
            kind: "destructiveMutation".to_owned(),
        })?;
        let result = (|| {
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
        })();
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

    async fn clear_role_browser_data(self: &Arc<Self>, role_id: String) -> CoreResult<Value> {
        let role = self.external_role(&role_id)?;
        self.stop_role_runtime(&role_id).await?;
        self.macro_runtime.stop_role(&role_id)?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let operation_id = format!("role-browser-clear-{}", uuid::Uuid::new_v4());
        let browser_user_data_dir =
            crate::role_browser_data::paths(&self.user_data_dir, &role_id)?.browser_user_data_dir;
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
                    browser_user_data_dir,
                    session_source: role
                        .browser_session_source
                        .unwrap_or_else(|| "embedded".to_owned()),
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

    async fn apply_chrome_profile_import(
        self: &Arc<Self>,
        import_id: String,
        profile_ids: Vec<String>,
        game_id: String,
        consent_accepted: bool,
    ) -> CoreResult<Value> {
        let prepared = {
            let core = Arc::clone(self);
            let import_id = import_id.clone();
            tokio::task::spawn_blocking(move || {
                let _guard = core.state_mutation_guard()?;
                let games = core.read_typed_state_collection::<StateGameRecord>("games")?;
                let roles = core.read_typed_state_collection::<StateRoleRecord>("roles")?;
                core.chrome_profile_import()?.prepare(
                    &import_id,
                    profile_ids,
                    &game_id,
                    consent_accepted,
                    &games,
                    &roles,
                )
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))??
        };
        self.emit_chrome_profile_progress(
            &import_id,
            "preparing",
            0,
            prepared.profiles.len(),
            None,
        );

        for role_id in &prepared.overwritten_role_ids {
            if let Err(error) = self.stop_role_runtime(role_id).await {
                let _ = self.chrome_profile_import()?.abort_prepare(&import_id);
                return Err(error);
            }
            if let Err(error) = self.macro_runtime.stop_role(role_id) {
                let _ = self.chrome_profile_import()?.abort_prepare(&import_id);
                return Err(error);
            }
        }
        let lease = if prepared.overwritten_role_ids.is_empty() {
            None
        } else {
            match self
                .acquire_browser_operation_async(BrowserOperationRequest {
                    role_ids: prepared.overwritten_role_ids.clone(),
                    kind: "recoverableMutation".to_owned(),
                })
                .await
            {
                Ok(lease) => Some(lease),
                Err(error) => {
                    let _ = self.chrome_profile_import()?.abort_prepare(&import_id);
                    return Err(error);
                }
            }
        };

        let committed = {
            let core = Arc::clone(self);
            let import_id = import_id.clone();
            tokio::task::spawn_blocking(move || core.commit_chrome_profile_import(&import_id))
                .await
                .map_err(|error| CoreError::Internal(error.to_string()))?
        };
        let committed = match committed {
            Ok(committed) => committed,
            Err(error) => {
                let _ = complete_profile_lease(self, lease.as_ref(), false);
                return Err(error);
            }
        };

        let effect_steps = match self
            .profile_session_effect_steps(&committed.result.sessions)
            .await
        {
            Ok(steps) => steps,
            Err(error) => {
                let rollback = self.rollback_chrome_profile_import(&import_id);
                let _ = complete_profile_lease(self, lease.as_ref(), false);
                rollback?;
                return Err(error);
            }
        };
        let effects = self.run_effect_plan_async(effect_steps).await;
        if let Err(error) = effects {
            let rollback = self.rollback_chrome_profile_import(&import_id);
            let _ = complete_profile_lease(self, lease.as_ref(), false);
            rollback?;
            return Err(error);
        }
        for (index, session) in committed.result.sessions.iter().enumerate() {
            self.emit_chrome_profile_progress(
                &import_id,
                "importing",
                index + 1,
                committed.result.sessions.len(),
                Some((&session.profile_id, &session.profile_name)),
            );
        }

        let finalize = self.chrome_profile_import()?.finalize(&import_id);
        if let Err(error) = finalize {
            let _ = self
                .clear_imported_profile_sessions(&committed.result.sessions)
                .await;
            let rollback = self.rollback_chrome_profile_import(&import_id);
            let _ = complete_profile_lease(self, lease.as_ref(), false);
            rollback?;
            return Err(error);
        }
        complete_profile_lease(self, lease.as_ref(), true)?;
        self.emit_chrome_profile_progress(
            &import_id,
            "completed",
            committed.result.sessions.len(),
            committed.result.sessions.len(),
            None,
        );
        serde_json::to_value(crate::model::ChromeProfileImportResultRecord {
            roles: committed.result.roles,
        })
        .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn commit_chrome_profile_import(
        &self,
        import_id: &str,
    ) -> CoreResult<crate::chrome_profile_import::PreparedChromeProfileCommit> {
        let _guard = self.state_mutation_guard()?;
        let current_roles = self.read_typed_state_collection::<StateRoleRecord>("roles")?;
        let mut profile_import = self.chrome_profile_import()?;
        let prepared = profile_import.commit_files(import_id, current_roles)?;
        let result = self.with_runtime(|runtime| {
            runtime.state.mutate(StateMutation::ProfileRolesPatch {
                upserts: prepared.upsert_roles.clone(),
                delete_ids: Vec::new(),
            })
        });
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let _ = profile_import.finish_rollback(import_id);
                return Err(error);
            }
        };
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.emit(vec![CoreEvent::StateChanged { revision }]);
        Ok(prepared)
    }

    fn rollback_chrome_profile_import(&self, import_id: &str) -> CoreResult<()> {
        let _guard = self.state_mutation_guard()?;
        let mut profile_import = self.chrome_profile_import()?;
        let plan = profile_import.rollback_plan(import_id)?;
        let result = self.with_runtime(|runtime| {
            runtime.state.mutate(StateMutation::ProfileRolesPatch {
                upserts: plan.restore_roles,
                delete_ids: plan.delete_role_ids,
            })
        })?;
        profile_import.finish_rollback(import_id)?;
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.emit(vec![CoreEvent::StateChanged { revision }]);
        Ok(())
    }

    async fn run_effect_plan_async(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan { steps })?;
        let outcome = handle.outcome.await.map_err(|_| {
            CoreError::Internal("operation actor stopped before returning an outcome".to_owned())
        })?;
        if let Some(error) = &outcome.error {
            return Err(CoreError::Effect {
                code: error.code.clone(),
                message: error.message.clone(),
            });
        }
        Ok(outcome)
    }

    async fn clear_imported_profile_sessions(
        &self,
        sessions: &[ChromeProfileImportedSessionRecord],
    ) -> CoreResult<()> {
        let steps = sessions
            .iter()
            .map(|session| {
                effect_step(
                    &session.role.id,
                    CoreEffectAction::ChromeProfileClearSession {
                        role_id: session.role.id.clone(),
                        browser_user_data_dir: session.browser_user_data_dir.clone(),
                    },
                    Duration::from_secs(30),
                    None,
                )
            })
            .collect();
        self.run_effect_plan_async(steps).await.map(|_| ())
    }

    async fn profile_session_effect_steps(
        &self,
        sessions: &[ChromeProfileImportedSessionRecord],
    ) -> CoreResult<Vec<crate::operation_actor::OperationStep>> {
        let mut steps = Vec::with_capacity(sessions.len());
        for session in sessions {
            let browser_user_data_dir = PathBuf::from(&session.browser_user_data_dir);
            let platform = self.platform;
            let cookies = tokio::task::spawn_blocking(move || {
                crate::chrome_cookies::read_imported_cookies(&browser_user_data_dir, platform)
            })
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))??;
            let cookies_json = serde_json::to_string(&cookies)
                .map_err(|error| CoreError::Internal(error.to_string()))?;
            steps.push(effect_step(
                &session.role.id,
                CoreEffectAction::ChromeProfileApplySession {
                    role_id: session.role.id.clone(),
                    browser_user_data_dir: session.browser_user_data_dir.clone(),
                    cookies_json,
                },
                Duration::from_secs(60),
                Some(CoreEffectAction::ChromeProfileClearSession {
                    role_id: session.role.id.clone(),
                    browser_user_data_dir: session.browser_user_data_dir.clone(),
                }),
            ));
        }
        Ok(steps)
    }

    fn emit_chrome_profile_progress(
        &self,
        import_id: &str,
        phase: &str,
        completed: usize,
        total: usize,
        current: Option<(&str, &str)>,
    ) {
        self.emit(vec![CoreEvent::ChromeProfileImportProgress {
            progress: ChromeProfileImportProgressRecord {
                completed_profile_count: completed as u32,
                current_profile_id: current.map(|(id, _)| id.to_owned()),
                current_profile_name: current.map(|(_, name)| name.to_owned()),
                import_id: import_id.to_owned(),
                phase: phase.to_owned(),
                total_profile_count: total as u32,
            },
        }]);
    }

    async fn run_compatibility_check(
        self: &Arc<Self>,
        game_id: String,
        versions: CompatibilityVersionRecord,
    ) -> CoreResult<Value> {
        let system_chrome_available = self.find_chrome_executable().is_ok();
        let plan = {
            let _guard = self.state_mutation_guard()?;
            let games = self.read_typed_state_collection::<StateGameRecord>("games")?;
            let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
                "gameBrowserSettings",
                "game browser settings are missing",
            )?;
            let (plan, statuses) = {
                let mut runtime = self.compatibility_runtime()?;
                let plan = runtime.prepare(
                    &games,
                    &settings,
                    &game_id,
                    system_chrome_available,
                    &versions,
                )?;
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
                        source: crate::graphics_diagnostics::WEB_GRAPHICS_PROBE_SOURCE.to_owned(),
                    },
                    Duration::from_secs(2),
                )
                .await
            {
                Ok(result) => {
                    crate::graphics_diagnostics::normalize_web_graphics(effect_value(&result)?)
                }
                Err(error) => {
                    crate::graphics_diagnostics::unavailable_probe(Some(error.to_string()))
                }
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

    async fn resolve_cdn_session(
        &self,
        session_handle_id: String,
    ) -> CoreResult<CdnResolutionRecord> {
        if session_handle_id.trim().is_empty() || session_handle_id.len() > 160 {
            return Err(CoreError::InvalidInput(
                "CDN session handle is invalid".to_owned(),
            ));
        }
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let start = self
            .cdn_detection
            .lock()
            .map_err(|_| CoreError::Internal("CDN detection lock poisoned".to_owned()))?
            .begin(
                &settings.network.cdn_compatibility.mode,
                &settings.network.proxy,
            )?;
        let enabled = match start {
            crate::cdn_detection::DetectionStart::Immediate(enabled) => enabled,
            crate::cdn_detection::DetectionStart::Follower(receiver) => receiver
                .await
                .map_err(|_| CoreError::Internal("CDN detection leader stopped".to_owned()))?,
            crate::cdn_detection::DetectionStart::Leader { cache_key } => {
                let timeout = self
                    .cdn_detection
                    .lock()
                    .map_err(|_| CoreError::Internal("CDN detection lock poisoned".to_owned()))?
                    .probe_timeout();
                let google_available = self
                    .request_core_effect(
                        &session_handle_id,
                        CoreEffectAction::CdnProbeGoogle {
                            url: "https://www.google.com/recaptcha/api.js?render=explicit"
                                .to_owned(),
                        },
                        timeout,
                    )
                    .await
                    .ok()
                    .and_then(|result| effect_value::<Value>(&result).ok())
                    .and_then(|value| value.get("available").and_then(Value::as_bool))
                    .unwrap_or(false);
                let enabled = !google_available;
                self.cdn_detection
                    .lock()
                    .map_err(|_| CoreError::Internal("CDN detection lock poisoned".to_owned()))?
                    .complete(cache_key, enabled);
                enabled
            }
        };
        let request_patterns = if enabled {
            self.cdn
                .read()
                .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?
                .request_patterns()
        } else {
            Vec::new()
        };
        Ok(CdnResolutionRecord {
            enabled,
            request_patterns,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn assemble_graphics_diagnostics(
        &self,
        applied_settings: crate::model::BrowserGraphicsSettingsRecord,
        embedded_raw_json: String,
        embedded_error: Option<String>,
        gpu_info_raw_json: Option<String>,
        feature_status_raw_json: String,
        gpu_info_ready: bool,
        hardware_acceleration_enabled: Option<bool>,
        platform: String,
        versions: GraphicsVersionRecord,
    ) -> CoreResult<GraphicsDiagnosticsRecord> {
        let requested_platform = rion_platform::Platform::parse(&platform)
            .map_err(|error| CoreError::Platform(error.to_string()))?;
        if requested_platform != self.platform {
            return Err(CoreError::InvalidInput(
                "graphics diagnostics platform does not match the application core".to_owned(),
            ));
        }
        let saved_settings = self
            .read_scalar_state::<GameBrowserSettingsRecord>(
                "gameBrowserSettings",
                "game browser settings are missing",
            )?
            .graphics;
        let sessions = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .snapshot()
            .into_iter()
            .filter(|session| session.state == "running")
            .collect::<Vec<_>>();
        let automation = Arc::clone(&self.external_automation);
        let external_roles = join_all(sessions.into_iter().map(|session| {
            let automation = Arc::clone(&automation);
            async move {
                if !session.automation_available {
                    return ExternalGraphicsDiagnosticsRecord {
                        error: Some("Chrome DevTools connection is unavailable.".to_owned()),
                        probe: None,
                        role_id: session.role.id,
                        role_name: session.role.name,
                        state: "unavailable".to_owned(),
                    };
                }
                match tokio::time::timeout(
                    Duration::from_secs(2),
                    automation.evaluate(
                        &session.role.id,
                        crate::graphics_diagnostics::WEB_GRAPHICS_PROBE_SOURCE,
                    ),
                )
                .await
                {
                    Ok(Ok(value)) => {
                        let probe = crate::graphics_diagnostics::normalize_web_graphics(value);
                        let unavailable = probe.error.is_some()
                            || (probe.webgl == "unknown"
                                && probe.webgl2 == "unknown"
                                && probe.webgpu == "unknown");
                        ExternalGraphicsDiagnosticsRecord {
                            error: unavailable.then(|| {
                                probe.error.clone().unwrap_or_else(|| {
                                    "Chrome graphics probe returned invalid data.".to_owned()
                                })
                            }),
                            probe: Some(probe),
                            role_id: session.role.id,
                            role_name: session.role.name,
                            state: if unavailable { "unavailable" } else { "ready" }.to_owned(),
                        }
                    }
                    Ok(Err(error)) => ExternalGraphicsDiagnosticsRecord {
                        error: Some(error.to_string()),
                        probe: None,
                        role_id: session.role.id,
                        role_name: session.role.name,
                        state: "unavailable".to_owned(),
                    },
                    Err(_) => ExternalGraphicsDiagnosticsRecord {
                        error: Some("Chrome graphics probe timed out.".to_owned()),
                        probe: None,
                        role_id: session.role.id,
                        role_name: session.role.name,
                        state: "unavailable".to_owned(),
                    },
                }
            }
        }))
        .await;
        Ok(crate::graphics_diagnostics::assemble(
            crate::graphics_diagnostics::GraphicsDiagnosticsInput {
                applied_settings,
                embedded_raw_json,
                embedded_error,
                external_roles,
                feature_status_raw_json,
                gpu_info_raw_json,
                gpu_info_ready,
                hardware_acceleration_enabled,
                platform: requested_platform,
                saved_settings,
                versions,
            },
        ))
    }

    fn external_role(&self, role_id: &str) -> CoreResult<StateRoleRecord> {
        self.read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .find(|role| role.id == role_id)
            .ok_or_else(|| CoreError::Domain {
                code: "ROLE_NOT_FOUND",
                message: "Role not found.".to_owned(),
            })
    }

    fn external_game(&self, game_id: &str) -> CoreResult<StateGameRecord> {
        self.read_typed_state_collection::<StateGameRecord>("games")?
            .into_iter()
            .find(|game| game.id == game_id)
            .ok_or_else(|| CoreError::Domain {
                code: "GAME_NOT_FOUND",
                message: "Game not found.".to_owned(),
            })
    }

    fn external_workspace(&self, workspace_id: &str) -> CoreResult<StateLaunchWorkspaceRecord> {
        self.read_typed_state_collection::<StateLaunchWorkspaceRecord>("launchWorkspaces")?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| CoreError::Domain {
                code: "WORKSPACE_NOT_FOUND",
                message: "Launch workspace not found.".to_owned(),
            })
    }

    async fn launch_external_role(
        self: &Arc<Self>,
        role: StateRoleRecord,
        target: EmbeddedLaunchTargetRecord,
        zoom_factor: f64,
        notice: Option<String>,
        settings: GameBrowserSettingsRecord,
    ) -> CoreResult<crate::model::BrowserRoleStatusRecord> {
        if let Some(existing) = self.external_session(&role.id)? {
            self.invoke_external_session(ExternalSessionCommand::UpdateRole { role })?;
            let _ = self.external_automation.focus(&existing.role.id).await;
            return self
                .external_session(&existing.role.id)?
                .map(|session| external_status(&session))
                .ok_or_else(|| CoreError::Internal("external session disappeared".to_owned()));
        }

        let role_id = role.id.clone();
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.clone()],
                kind: "normal".to_owned(),
            })
            .await?;
        let result = self
            .launch_external_session(
                role,
                target.work_area.clone(),
                None,
                None,
                notice,
                zoom_factor,
                settings,
            )
            .await;
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(session), Ok(())) => Ok(external_status(&session)),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn launch_external_workspace(
        self: &Arc<Self>,
        workspace: StateLaunchWorkspaceRecord,
        target: EmbeddedLaunchTargetRecord,
        notice: Option<String>,
        settings: GameBrowserSettingsRecord,
    ) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let available_roles = self
            .read_typed_state_collection::<StateRoleRecord>("roles")?
            .into_iter()
            .map(|role| (role.id.clone(), role))
            .collect::<std::collections::HashMap<_, _>>();
        let slots = workspace
            .slots
            .iter()
            .filter_map(|slot| {
                let role_id = slot.role_id.as_ref()?;
                Some((slot, available_roles.get(role_id).cloned()))
            })
            .collect::<Vec<_>>();
        if slots.is_empty() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLES_REQUIRED",
                message: "The launch workspace has no roles.".to_owned(),
            });
        }
        if slots.iter().any(|(_, role)| role.is_none()) {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLE_NOT_FOUND",
                message: "A launch workspace role no longer exists.".to_owned(),
            });
        }
        let role_ids = slots
            .iter()
            .filter_map(|(_, role)| role.as_ref().map(|role| role.id.clone()))
            .collect::<Vec<_>>();
        if role_ids
            .iter()
            .any(|role_id| self.external_session(role_id).ok().flatten().is_some())
        {
            return Err(CoreError::Domain {
                code: "ROLE_ALREADY_RUNNING",
                message: "A workspace role is already running.".to_owned(),
            });
        }
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: role_ids.clone(),
                kind: "normal".to_owned(),
            })
            .await?;
        let result = async {
            self.invoke_browser_runtime(BrowserRuntimeCommand::CreateExternalWorkspace {
                workspace_id: workspace.id.clone(),
                name: workspace.name.clone(),
                display_id: Some(target.display_id),
                exclusive_display: true,
                role_ids: role_ids.clone(),
            })?;
            let bounds = crate::external_runtime::workspace_bounds(
                &slots
                    .iter()
                    .map(|(slot, _)| slot.rect.clone())
                    .collect::<Vec<_>>(),
                &target.work_area,
                self.platform,
            );
            let physical_bounds = if self.platform == rion_platform::Platform::Windows {
                let physical_work_area = self
                    .resolve_external_physical_bounds(&target.work_area)
                    .await?;
                Some(crate::external_runtime::workspace_bounds(
                    &slots
                        .iter()
                        .map(|(slot, _)| slot.rect.clone())
                        .collect::<Vec<_>>(),
                    &physical_work_area,
                    self.platform,
                ))
            } else {
                None
            };
            let launches = slots
                .iter()
                .zip(bounds)
                .enumerate()
                .map(|(index, ((slot, role), bounds))| {
                    let core = Arc::clone(self);
                    let role = role.clone().expect("workspace roles were validated");
                    let physical_bounds = physical_bounds
                        .as_ref()
                        .and_then(|items| items.get(index))
                        .cloned();
                    let workspace_id = workspace.id.clone();
                    let notice = notice.clone();
                    let settings = settings.clone();
                    let zoom_factor = slot.browser_zoom_percent.map_or_else(
                        || {
                            if workspace.browser_zoom_mode == "adaptive" {
                                f64::from(layout::adaptive_zoom_percent(
                                    f64::from(bounds.width),
                                    None,
                                )) / 100.0
                            } else {
                                workspace.browser_zoom_percent / 100.0
                            }
                        },
                        |percent| percent / 100.0,
                    );
                    async move {
                        core.launch_external_session(
                            role,
                            bounds,
                            physical_bounds,
                            Some(workspace_id),
                            notice,
                            zoom_factor,
                            settings,
                        )
                        .await
                    }
                })
                .collect::<Vec<_>>();
            let results = join_all(launches).await;
            if let Some(error) = results.iter().find_map(|result| result.as_ref().err()) {
                let code = error.code();
                let message = error.to_string();
                for role_id in &role_ids {
                    let _ = self.stop_external_session(role_id, true).await;
                }
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                    workspace_id: workspace.id.clone(),
                });
                return Err(CoreError::Effect {
                    code: code.to_owned(),
                    message,
                });
            }
            let by_role_id = results
                .into_iter()
                .filter_map(Result::ok)
                .map(|session| (session.role.id.clone(), external_status(&session)))
                .collect::<std::collections::HashMap<_, _>>();
            if let Some(first) = role_ids.first() {
                let _ = self.external_automation.focus(first).await;
            }
            Ok(role_ids
                .iter()
                .filter_map(|role_id| by_role_id.get(role_id).cloned())
                .collect::<Vec<_>>())
        }
        .await;
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(statuses), Ok(())) => Ok(statuses),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn launch_external_session(
        self: &Arc<Self>,
        role: StateRoleRecord,
        bounds: StatePixelBoundsRecord,
        physical_bounds: Option<StatePixelBoundsRecord>,
        workspace_id: Option<String>,
        notice: Option<String>,
        zoom_factor: f64,
        settings: GameBrowserSettingsRecord,
    ) -> CoreResult<ExternalSessionRecord> {
        let paths = crate::role_browser_data::ensure(&self.user_data_dir, &role.id)?;
        let browser_user_data_dir = PathBuf::from(&paths.browser_user_data_dir);
        self.prepare_external_chrome_profile(browser_user_data_dir.clone())?;
        let mut session_notice = notice;
        if crate::browser_preferences::apply(
            &self.user_data_dir,
            &browser_user_data_dir,
            None,
            &settings.fonts,
            Some(zoom_factor),
        )
        .is_err()
        {
            session_notice =
                append_external_notice(session_notice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
        }

        let prepared = self
            .request_core_effect(
                &role.id,
                CoreEffectAction::ExternalPrepareSession {
                    role_id: role.id.clone(),
                    cdn_mode: settings.network.cdn_compatibility.mode.clone(),
                },
                Duration::from_secs(10),
            )
            .await
            .and_then(|result| effect_value::<ExternalPrepareSessionResultRecord>(&result));
        let (cdn_enabled, proxy_server) = match prepared {
            Ok(value) => {
                let proxy = value.proxy_server.or_else(|| {
                    (settings.network.proxy.mode == "custom"
                        && !settings.network.proxy.server.trim().is_empty())
                    .then(|| settings.network.proxy.server.clone())
                });
                (value.cdn_enabled, proxy)
            }
            Err(_) => {
                session_notice =
                    append_external_notice(session_notice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
                (false, None)
            }
        };

        let executable = self.find_chrome_executable()?;
        let arguments = crate::external_runtime::build_arguments(
            &role.launch_url,
            &paths.browser_user_data_dir,
            &bounds,
            proxy_server.as_deref(),
            &settings.graphics,
            self.platform,
        );
        self.invoke_external_session(ExternalSessionCommand::Begin {
            role: role.clone(),
            bounds: bounds.clone(),
            physical_bounds: physical_bounds.clone(),
            workspace_id: workspace_id.clone(),
            notice: session_notice.clone(),
            zoom_factor,
        })?;
        self.emit_browser_statuses();
        let process_id =
            match self
                .external_processes
                .launch(role.id.clone(), &executable, &arguments)
            {
                Ok(process_id) => process_id,
                Err(error) => {
                    let _ = self.invoke_external_session(ExternalSessionCommand::Remove {
                        role_id: role.id.clone(),
                        preserve_workspace: false,
                    });
                    self.emit_browser_statuses();
                    return Err(error);
                }
            };

        let automation = self
            .connect_external_chrome_cdp(
                role.id.clone(),
                browser_user_data_dir,
                role.launch_url.clone(),
                Some(Duration::from_secs(10)),
                cdn_enabled,
            )
            .await;
        match automation {
            Ok(session) => {
                if let Err(error) = self
                    .initialize_external_automation(&role.id, Arc::clone(&session))
                    .await
                {
                    let _ = self.external_automation.unregister(&role.id);
                    session_notice = append_external_notice(
                        session_notice,
                        EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE,
                    );
                    self.invoke_external_session(ExternalSessionCommand::SetNotice {
                        role_id: role.id.clone(),
                        notice: session_notice.clone(),
                    })?;
                    self.invoke_external_session(ExternalSessionCommand::SetAutomation {
                        role_id: role.id.clone(),
                        available: false,
                        cdn_active: false,
                    })?;
                    let _ = error;
                } else {
                    if cdn_enabled {
                        session_notice = append_external_notice(
                            session_notice,
                            CDN_COMPATIBILITY_EXTERNAL_NOTICE,
                        );
                        self.invoke_external_session(ExternalSessionCommand::SetNotice {
                            role_id: role.id.clone(),
                            notice: session_notice.clone(),
                        })?;
                    }
                    self.invoke_external_session(ExternalSessionCommand::SetAutomation {
                        role_id: role.id.clone(),
                        available: true,
                        cdn_active: cdn_enabled,
                    })?;
                    self.invoke_external_session(ExternalSessionCommand::SetHealth {
                        role_id: role.id.clone(),
                        health: Some("healthy".to_owned()),
                        page_hidden: false,
                    })?;
                    self.external_health()?.register(role.id.clone())?;
                    let _ = self
                        .external_automation
                        .set_window_bounds(&role.id, bounds.clone())
                        .await;
                }
            }
            Err(_) => {
                session_notice =
                    append_external_notice(session_notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
                self.invoke_external_session(ExternalSessionCommand::SetNotice {
                    role_id: role.id.clone(),
                    notice: session_notice,
                })?;
                self.invoke_external_session(ExternalSessionCommand::SetAutomation {
                    role_id: role.id.clone(),
                    available: false,
                    cdn_active: false,
                })?;
            }
        }

        if self.platform == rion_platform::Platform::Windows
            && let Some(physical_bounds) = &physical_bounds
        {
            let target = PixelBounds {
                x: physical_bounds.x,
                y: physical_bounds.y,
                width: physical_bounds.width,
                height: physical_bounds.height,
            };
            let _ = self.align_external_chrome_window(process_id, target);
        }
        let launched_at = chrono::Utc::now().to_rfc3339();
        self.invoke_external_session(ExternalSessionCommand::SetRunning {
            role_id: role.id.clone(),
            launched_at,
        })?;
        self.emit_browser_statuses();
        self.external_session(&role.id)?
            .ok_or_else(|| CoreError::Internal("external session disappeared".to_owned()))
    }

    async fn initialize_external_automation(
        self: &Arc<Self>,
        role_id: &str,
        session: Arc<crate::ExternalChromeCdpSession>,
    ) -> CoreResult<()> {
        let events = session.take_events()?;
        session
            .send("Page.enable".to_owned(), None, None, None)
            .await?;
        session
            .send("Runtime.enable".to_owned(), None, None, None)
            .await?;
        session
            .send(
                "Runtime.addBinding".to_owned(),
                Some(json!({"name":EXTERNAL_OVERLAY_BINDING})),
                None,
                None,
            )
            .await?;
        self.install_external_overlay(role_id, &session).await;

        let weak = Arc::downgrade(self);
        let role_id = role_id.to_owned();
        let runtime_handle = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name(format!("rion-external-events-{role_id}"))
            .spawn(move || {
                while let Ok(event) = events.recv() {
                    let Some(core) = weak.upgrade() else {
                        break;
                    };
                    let role_id = role_id.clone();
                    let session = Arc::clone(&session);
                    runtime_handle.spawn(async move {
                        core.handle_external_cdp_event(&role_id, &session, event)
                            .await;
                    });
                }
            })
            .map_err(|error| CoreError::Internal(error.to_string()))?;
        Ok(())
    }

    async fn install_external_overlay(
        self: &Arc<Self>,
        role_id: &str,
        session: &crate::ExternalChromeCdpSession,
    ) {
        let Ok(source_result) = self
            .request_core_effect(
                role_id,
                CoreEffectAction::ExternalOverlaySource {
                    role_id: role_id.to_owned(),
                },
                Duration::from_secs(5),
            )
            .await
        else {
            return;
        };
        let Ok(source) = effect_value::<String>(&source_result) else {
            return;
        };
        let bootstrap = external_overlay_bridge_source();
        let expression = format!("{bootstrap}\n{source}");
        let _ = session
            .send(
                "Runtime.evaluate".to_owned(),
                Some(json!({"expression":expression})),
                Some(Duration::from_secs(5)),
                None,
            )
            .await;
    }

    async fn handle_external_cdp_event(
        self: &Arc<Self>,
        role_id: &str,
        session: &crate::ExternalChromeCdpSession,
        event: crate::external_chrome::CdpEvent,
    ) {
        match event {
            crate::external_chrome::CdpEvent::Disconnected { message: _ } => {
                let _ = self.invoke_external_session(ExternalSessionCommand::SetAutomation {
                    role_id: role_id.to_owned(),
                    available: false,
                    cdn_active: false,
                });
                let _ = self
                    .external_health()
                    .and_then(|health| health.remove(role_id.to_owned()));
                let _ = self.macro_runtime.release_role(role_id);
                self.emit_browser_statuses();
            }
            crate::external_chrome::CdpEvent::Notification { method, params, .. }
                if method == "Page.frameNavigated"
                    && params
                        .as_ref()
                        .and_then(|value| value.get("frame"))
                        .and_then(|value| value.get("parentId"))
                        .is_none() =>
            {
                let _ = self.macro_runtime.release_role(role_id);
                self.install_external_overlay(role_id, session).await;
            }
            crate::external_chrome::CdpEvent::Notification { method, params, .. }
                if method == "Runtime.bindingCalled" =>
            {
                let Some(payload) = params
                    .as_ref()
                    .and_then(|value| value.get("payload"))
                    .and_then(Value::as_str)
                else {
                    return;
                };
                let Ok(envelope) = serde_json::from_str::<Value>(payload) else {
                    return;
                };
                let Some(request_id) = envelope.get("id").and_then(Value::as_str) else {
                    return;
                };
                let request_json = envelope
                    .get("request")
                    .cloned()
                    .unwrap_or(Value::Null)
                    .to_string();
                let result = self
                    .request_core_effect(
                        role_id,
                        CoreEffectAction::ExternalOverlayRequest {
                            role_id: role_id.to_owned(),
                            request_json,
                        },
                        Duration::from_secs(10),
                    )
                    .await;
                let (ok, value_json) = match result {
                    Ok(result) if result.ok => {
                        (true, result.value_json.unwrap_or_else(|| "null".to_owned()))
                    }
                    Ok(result) => (
                        false,
                        serde_json::to_string(
                            &result
                                .error
                                .map(|error| error.message)
                                .unwrap_or_else(|| "Overlay request failed.".to_owned()),
                        )
                        .unwrap_or_else(|_| "\"Overlay request failed.\"".to_owned()),
                    ),
                    Err(error) => (
                        false,
                        serde_json::to_string(&error.to_string())
                            .unwrap_or_else(|_| "\"Overlay request failed.\"".to_owned()),
                    ),
                };
                let request_id =
                    serde_json::to_string(request_id).unwrap_or_else(|_| "\"invalid\"".to_owned());
                let expression = format!(
                    "window[{bridge}]?.resolve({request_id},{ok},{value});",
                    bridge = serde_json::to_string(EXTERNAL_OVERLAY_BRIDGE_KEY)
                        .expect("bridge key is valid JSON"),
                    value = value_json
                );
                let _ = session
                    .send(
                        "Runtime.evaluate".to_owned(),
                        Some(json!({"expression":expression})),
                        None,
                        None,
                    )
                    .await;
            }
            _ => {}
        }
    }

    async fn stop_external_role(self: &Arc<Self>, role_id: &str) -> CoreResult<()> {
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role_id.to_owned()],
                kind: "normal".to_owned(),
            })
            .await?;
        let result = self.stop_external_session(role_id, false).await;
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    async fn stop_external_workspace(self: &Arc<Self>, workspace_id: &str) -> CoreResult<()> {
        let role_ids = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .snapshot()
            .into_iter()
            .filter(|session| session.workspace_id.as_deref() == Some(workspace_id))
            .map(|session| session.role.id)
            .collect::<Vec<_>>();
        if role_ids.is_empty() {
            return Ok(());
        }
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: role_ids.clone(),
                kind: "normal".to_owned(),
            })
            .await?;
        let results = join_all(
            role_ids
                .iter()
                .map(|role_id| self.stop_external_session(role_id, true)),
        )
        .await;
        let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
            workspace_id: workspace_id.to_owned(),
        });
        let completion = self.browser_operations.complete(&lease.id);
        if let Some(error) = results.into_iter().find_map(Result::err) {
            return Err(error);
        }
        completion
    }

    async fn stop_external_session(
        &self,
        role_id: &str,
        preserve_workspace: bool,
    ) -> CoreResult<()> {
        if self.external_session(role_id)?.is_none() {
            return Ok(());
        }
        self.invoke_external_session(ExternalSessionCommand::SetStopping {
            role_id: role_id.to_owned(),
        })?;
        let _ = self.macro_runtime.release_role(role_id);
        let _ = self.external_health()?.remove(role_id.to_owned());
        let _ = self.external_automation.unregister(role_id);
        let _ = self.external_processes.terminate(role_id);
        self.invoke_external_session(ExternalSessionCommand::Remove {
            role_id: role_id.to_owned(),
            preserve_workspace,
        })?;
        self.emit_browser_statuses();
        Ok(())
    }

    async fn recover_external_role(
        self: &Arc<Self>,
        role_id: &str,
    ) -> CoreResult<crate::model::BrowserRoleStatusRecord> {
        let session = self
            .external_session(role_id)?
            .ok_or_else(|| CoreError::Domain {
                code: "EXTERNAL_SESSION_NOT_FOUND",
                message: "External Chrome role is not running.".to_owned(),
            })?;
        if session.state != "running" || session.page_health.as_deref() != Some("unresponsive") {
            return Err(CoreError::Domain {
                code: "EXTERNAL_RECOVERY_NOT_REQUIRED",
                message: "External Chrome role does not need recovery.".to_owned(),
            });
        }
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let notice = remove_external_notice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE);
        self.stop_external_session(role_id, true).await?;
        let replacement = self
            .launch_external_session(
                session.role,
                session.bounds,
                session.physical_bounds,
                session.workspace_id,
                notice,
                session.zoom_factor,
                settings,
            )
            .await?;
        let _ = self.external_automation.focus(role_id).await;
        Ok(external_status(&replacement))
    }

    async fn capture_external_diagnostics(
        &self,
        role_id: &str,
    ) -> CoreResult<ExternalChromeDiagnosticsRecord> {
        let session = self
            .external_session(role_id)?
            .ok_or_else(|| CoreError::Domain {
                code: "EXTERNAL_SESSION_NOT_FOUND",
                message: "External Chrome role is not running.".to_owned(),
            })?;
        let chrome = if session.automation_available {
            self.external_automation.diagnostics(role_id).await.ok()
        } else {
            None
        };
        let count = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .snapshot()
            .len();
        Ok(crate::external_runtime::diagnostics(
            &session, count, chrome,
        ))
    }

    async fn resolve_external_physical_bounds(
        self: &Arc<Self>,
        bounds: &StatePixelBoundsRecord,
    ) -> CoreResult<StatePixelBoundsRecord> {
        let result = self
            .request_core_effect(
                "external-bounds",
                CoreEffectAction::ExternalResolvePhysicalBounds {
                    bounds: bounds.clone(),
                },
                Duration::from_secs(5),
            )
            .await?;
        effect_value(&result)
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

    async fn acquire_browser_operation_async(
        self: &Arc<Self>,
        request: BrowserOperationRequest,
    ) -> CoreResult<crate::model::BrowserOperationLease> {
        let core = Arc::clone(self);
        tokio::task::spawn_blocking(move || core.browser_operations.acquire(request))
            .await
            .map_err(|error| CoreError::Internal(error.to_string()))?
    }

    fn external_session(&self, role_id: &str) -> CoreResult<Option<ExternalSessionRecord>> {
        Ok(self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .get(role_id)
            .cloned())
    }

    fn emit_browser_statuses(&self) {
        if let Ok(statuses) = self.browser_statuses() {
            self.emit(vec![CoreEvent::BrowserStatuses { statuses }]);
        }
    }

    pub fn browser_statuses(&self) -> CoreResult<Vec<crate::model::BrowserRoleStatusRecord>> {
        let mut statuses = {
            let browser = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let sessions = self
                .external_sessions
                .lock()
                .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?;
            crate::external_runtime::role_statuses(
                browser.snapshot().roles.into_iter(),
                &sessions.snapshot(),
            )
        };
        let resources = self.resource_controller.snapshot()?.statuses;
        for status in &mut statuses {
            if let Some(resource) = resources
                .iter()
                .find(|resource| resource.role_id == status.role_id)
            {
                apply_resource_status(status, resource);
            }
        }
        Ok(statuses)
    }

    fn macro_active_role_ids(&self) -> CoreResult<Vec<String>> {
        let embedded = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?
            .snapshot()
            .roles
            .into_iter()
            .filter(|role| role.runtime == "embedded" && role.state == "running")
            .map(|role| role.role_id);
        let external = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .snapshot()
            .into_iter()
            .filter(|session| session.state == "running" && session.automation_available)
            .map(|session| session.role.id);
        let mut role_ids = embedded.chain(external).collect::<Vec<_>>();
        role_ids.sort();
        role_ids.dedup();
        Ok(role_ids)
    }

    pub fn browser_workspace_statuses(
        &self,
    ) -> CoreResult<Vec<crate::model::BrowserWorkspaceStatusRecord>> {
        let browser = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        let sessions = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?;
        Ok(crate::external_runtime::workspace_statuses(
            &sessions.snapshot(),
            browser.snapshot().workspaces.into_iter(),
        ))
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
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![role_id.to_owned()],
            kind: "normal".to_owned(),
        })?;
        let result = self.launch_embedded_role_with_lease(role_id, target, zoom_factor);
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
                vec![self.embedded_tab_display_id(&tab_id)?],
                vec![self.embedded_tab_display_id(&tab_id)?],
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

        let tab_id = self
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                source_id: role.id.clone(),
                name: role.name.clone(),
                display_id: target.display_id,
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

        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
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
                rect: full_window_rect(),
                zoom_factor,
                zoom_mode: "fixed".to_owned(),
            }],
        };
        let runtime_snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let resource_policy = StateWorkspaceResourcePolicyRecord {
            mode: "unrestricted".to_owned(),
        };
        let plan = embedded_launch_effects(
            &tab_id,
            tab,
            std::slice::from_ref(&role),
            resource_policy.clone(),
            runtime_snapshot,
        );
        let launch = self
            .run_effect_plan_for_roles(plan, std::slice::from_ref(&role.id))
            .and_then(|outcome| {
                self.activate_embedded_resources(&tab_id, &resource_policy, &outcome)
            });
        if let Err(error) = launch {
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role.id.clone(),
            });
            let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                tab_id: tab_id.clone(),
            });
            return Err(error);
        }

        let launched_at = chrono::Utc::now().to_rfc3339();
        self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role.id.clone(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id),
            state: "running".to_owned(),
            launched_at: Some(launched_at.clone()),
        })?;
        Ok(vec![embedded_launch_result(&role.id, launched_at)])
    }

    fn launch_embedded_workspace(
        &self,
        workspace_id: &str,
        target: EmbeddedLaunchTargetRecord,
    ) -> CoreResult<Vec<EmbeddedLaunchResultRecord>> {
        let _sequence = self.embedded_runtime_sequence.acquire()?;
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
        if role_ids.is_empty() {
            return Err(CoreError::Domain {
                code: "WORKSPACE_ROLES_REQUIRED",
                message: "The launch workspace has no roles.".to_owned(),
            });
        }
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: role_ids.clone(),
            kind: "normal".to_owned(),
        })?;
        let result = self.launch_embedded_workspace_with_lease(workspace, role_ids, target);
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
        self.invoke_browser_runtime(BrowserRuntimeCommand::BeginWorkspace {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
            display_id: Some(target.display_id),
            role_ids: role_ids.clone(),
        })?;
        let tab_id = match self.invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
            source_id: workspace.id.clone(),
            name: workspace.name.clone(),
            display_id: target.display_id,
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
        let settings = self.read_scalar_state::<GameBrowserSettingsRecord>(
            "gameBrowserSettings",
            "game browser settings are missing",
        )?;
        let effect_roles = workspace
            .slots
            .iter()
            .filter_map(|slot| {
                let role_id = slot.role_id.as_ref()?;
                let role = roles.iter().find(|role| &role.id == role_id)?.clone();
                Some(EmbeddedRoleViewEffectRecord {
                    role,
                    rect: slot.rect.clone(),
                    zoom_factor: slot
                        .browser_zoom_percent
                        .unwrap_or(workspace.browser_zoom_percent)
                        / 100.0,
                    zoom_mode: if slot.browser_zoom_percent.is_some() {
                        "fixed".to_owned()
                    } else {
                        workspace.browser_zoom_mode.clone()
                    },
                })
            })
            .collect::<Vec<_>>();
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
        let resource_policy = workspace.resource_policy.clone();
        let launch = self
            .run_effect_plan_for_roles(
                embedded_launch_effects(
                    &tab_id,
                    tab,
                    &roles,
                    resource_policy.clone(),
                    runtime_snapshot,
                ),
                &role_ids,
            )
            .and_then(|outcome| {
                self.activate_embedded_resources(&tab_id, &resource_policy, &outcome)
            });
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
            return Err(error);
        }

        let launched_at = chrono::Utc::now().to_rfc3339();
        for role_id in &role_ids {
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: role_id.clone(),
                runtime: "embedded".to_owned(),
                workspace_id: Some(workspace.id.clone()),
                tab_id: Some(tab_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(launched_at.clone()),
            })?;
        }
        self.invoke_browser_runtime(BrowserRuntimeCommand::SetWorkspaceState {
            workspace_id: workspace.id,
            state: "running".to_owned(),
        })?;
        Ok(role_ids
            .iter()
            .map(|role_id| embedded_launch_result(role_id, launched_at.clone()))
            .collect())
    }

    fn activate_embedded_resources(
        &self,
        tab_id: &str,
        policy: &StateWorkspaceResourcePolicyRecord,
        outcome: &crate::operation_actor::OperationOutcome,
    ) -> CoreResult<()> {
        let targets = outcome
            .results
            .last()
            .ok_or_else(|| CoreError::Internal("embedded resource effect is missing".to_owned()))
            .and_then(effect_value::<Vec<ResourceRuntimeTargetRecord>>)?;
        self.resource_controller
            .invoke(ResourceRuntimeCommand::ActivateWorkspace {
                workspace_id: tab_id.to_owned(),
                policy_mode: policy.mode.clone(),
                targets,
            })?;
        Ok(())
    }

    fn stop_embedded_role(&self, role_id: &str) -> CoreResult<()> {
        self.cancel_embedded_operations(&[role_id.to_owned()])?;
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
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
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: vec![role_id.to_owned()],
            kind: "normal".to_owned(),
        })?;
        let result = (|| {
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
            if let Some(workspace_id) = &next_active_tab_id {
                self.resource_controller.invoke(
                    ResourceRuntimeCommand::PrepareWorkspaceForeground {
                        workspace_id: workspace_id.clone(),
                    },
                )?;
            }
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
                if tab_role_count <= 1 {
                    let _ = self.resource_controller.invoke(
                        ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                            workspace_ids: hidden_embedded_workspace_ids(&snapshot),
                        },
                    );
                }
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                    role_id: role_id.to_owned(),
                    runtime: "embedded".to_owned(),
                    workspace_id: role.workspace_id,
                    tab_id: Some(tab_id),
                    state: "running".to_owned(),
                    launched_at: role.launched_at,
                });
                return Err(error);
            }
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                role_id: role_id.to_owned(),
            })?;
            if tab_role_count <= 1 {
                self.resource_controller
                    .invoke(ResourceRuntimeCommand::DeactivateWorkspace {
                        workspace_id: tab_id.clone(),
                    })?;
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: tab_id.clone(),
                })?;
                if let Some(workspace_id) = role.workspace_id {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                        workspace_id,
                    })?;
                }
            } else {
                self.reconcile_embedded_resource_roles()?;
            }
            Ok(())
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    fn stop_embedded_workspace(&self, workspace_id: &str) -> CoreResult<()> {
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
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        let snapshot = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
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
        let lease = self.browser_operations.acquire(BrowserOperationRequest {
            role_ids: workspace.role_ids.clone(),
            kind: "normal".to_owned(),
        })?;
        let result = (|| {
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
            if let Some(workspace_id) = &next_active_tab_id {
                self.resource_controller.invoke(
                    ResourceRuntimeCommand::PrepareWorkspaceForeground {
                        workspace_id: workspace_id.clone(),
                    },
                )?;
            }
            if let Err(error) = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id,
                },
                Duration::from_secs(15),
                None,
            )]) {
                let _ = self.resource_controller.invoke(
                    ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                        workspace_ids: hidden_embedded_workspace_ids(&snapshot),
                    },
                );
                for role_id in &workspace.role_ids {
                    if let Some(previous) =
                        snapshot.roles.iter().find(|role| role.role_id == *role_id)
                    {
                        let _ =
                            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                                role_id: role_id.clone(),
                                runtime: "embedded".to_owned(),
                                workspace_id: Some(workspace_id.to_owned()),
                                tab_id: Some(tab_id.clone()),
                                state: "running".to_owned(),
                                launched_at: previous.launched_at.clone(),
                            });
                    }
                }
                let _ = self.invoke_browser_runtime(BrowserRuntimeCommand::SetWorkspaceState {
                    workspace_id: workspace_id.to_owned(),
                    state: "running".to_owned(),
                });
                return Err(error);
            }
            for role_id in &workspace.role_ids {
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveRole {
                    role_id: role_id.clone(),
                })?;
            }
            self.resource_controller
                .invoke(ResourceRuntimeCommand::DeactivateWorkspace {
                    workspace_id: tab_id.clone(),
                })?;
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab { tab_id })?;
            self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                workspace_id: workspace_id.to_owned(),
            })?;
            Ok(())
        })();
        let completion = self.browser_operations.complete(&lease.id);
        match (result, completion) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        }
    }

    fn reconcile_embedded_resource_roles(&self) -> CoreResult<()> {
        let active_role_ids = self
            .invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .roles
            .into_iter()
            .filter(|role| role.runtime == "embedded")
            .map(|role| role.role_id)
            .collect();
        self.resource_controller
            .invoke(ResourceRuntimeCommand::ReconcileRuntimeRoleIds {
                runtime_mode: "embedded".to_owned(),
                active_role_ids,
            })?;
        Ok(())
    }

    fn run_effect_plan(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        self.run_effect_plan_for_roles(steps, &[])
    }

    fn run_effect_plan_for_roles(
        &self,
        steps: Vec<crate::operation_actor::OperationStep>,
        role_ids: &[String],
    ) -> CoreResult<crate::operation_actor::OperationOutcome> {
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan { steps })?;
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

    fn embedded_tab_display_id(&self, tab_id: &str) -> CoreResult<i64> {
        self.invoke_browser_runtime(BrowserRuntimeCommand::Snapshot)?
            .snapshot
            .tabs
            .into_iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.display_id)
            .ok_or_else(|| CoreError::Domain {
                code: "RUNTIME_TAB_NOT_FOUND",
                message: "Runtime tab was not found.".to_owned(),
            })
    }

    fn apply_embedded_runtime_command(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_display_ids: Vec<i64>,
        focus_window_display_ids: Vec<i64>,
        focus_tab_id: Option<String>,
        focus_active_display_id: Option<i64>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let _sequence = self.embedded_runtime_sequence.acquire()?;
        self.apply_embedded_runtime_command_inner(
            commands,
            target,
            reveal_display_ids,
            focus_window_display_ids,
            focus_tab_id,
            focus_active_display_id,
        )
    }

    fn apply_embedded_runtime_command_inner(
        &self,
        commands: Vec<BrowserRuntimeCommand>,
        target: Option<EmbeddedLaunchTargetRecord>,
        reveal_display_ids: Vec<i64>,
        focus_window_display_ids: Vec<i64>,
        focus_tab_id: Option<String>,
        focus_active_display_id: Option<i64>,
    ) -> CoreResult<crate::model::BrowserRuntimeSnapshot> {
        let (previous, next) = {
            let mut runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            let previous = runtime.clone();
            let mut result = runtime.invoke(BrowserRuntimeCommand::Snapshot)?;
            for command in commands {
                result = runtime.invoke(command)?;
            }
            (previous, result.snapshot)
        };
        let previous_snapshot = previous
            .clone()
            .invoke(BrowserRuntimeCommand::Snapshot)?
            .snapshot;
        let previous_hidden_workspace_ids = hidden_embedded_workspace_ids(&previous_snapshot);
        let next_hidden_workspace_ids = hidden_embedded_workspace_ids(&next);
        self.resource_controller
            .invoke(ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                workspace_ids: next_hidden_workspace_ids,
            })?;
        let focus_tab_id = focus_tab_id.or_else(|| {
            focus_active_display_id.and_then(|display_id| {
                next.displays
                    .iter()
                    .find(|display| display.display_id == display_id)
                    .and_then(|display| display.active_tab_id.clone())
            })
        });
        let effect = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: next.clone(),
            target: target.clone(),
            reveal_display_ids,
            focus_window_display_ids,
            focus_tab_id,
        };
        let compensation = CoreEffectAction::EmbeddedApplyRuntime {
            snapshot: previous_snapshot,
            target,
            reveal_display_ids: Vec::new(),
            focus_window_display_ids: Vec::new(),
            focus_tab_id: None,
        };
        if let Err(error) = self.run_effect_plan(vec![effect_step(
            "embedded-runtime",
            effect,
            Duration::from_secs(15),
            Some(compensation),
        )]) {
            let _ =
                self.resource_controller
                    .invoke(ResourceRuntimeCommand::SetHiddenWorkspaceIds {
                        workspace_ids: previous_hidden_workspace_ids,
                    });
            let mut runtime = self
                .browser_runtime
                .lock()
                .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
            *runtime = previous;
            return Err(error);
        }
        Ok(next)
    }

    pub fn resolve_role_paths(&self, role_id: &str) -> CoreResult<crate::model::RolePathsRecord> {
        self.with_runtime(|_| crate::role_browser_data::paths(&self.user_data_dir, role_id))
    }

    pub fn invoke_resource_runtime(
        &self,
        command: crate::model::ResourceRuntimeCommand,
    ) -> CoreResult<crate::model::ResourceRuntimeResult> {
        self.resource_controller.invoke(command)
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
        self.external_health()?.dispatch_results(results.clone());
        self.macro_runtime.dispatch_results(results)
    }

    pub fn dispatch_core_effect_results(
        &self,
        results: Vec<CoreEffectResult>,
    ) -> CoreResult<CoreEffectDispatchReport> {
        self.operation_actor.dispatch_results(results)
    }

    pub fn match_cdn_url(&self, url: &str) -> CoreResult<Option<String>> {
        let matcher = self
            .cdn
            .read()
            .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?;
        Ok(matcher.rewrite(url))
    }

    pub fn resolve_resource_policy(&self, input: &ResourcePolicyInput) -> ResourcePolicyDecision {
        resolve_resource_policy(input)
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
            self.emit(vec![CoreEvent::StateChanged { revision }]);
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
        let result = self.with_runtime(|runtime| runtime.state.mutate(mutation))?;
        let revision = result
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        self.emit(vec![CoreEvent::StateChanged { revision }]);
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

    fn chrome_profile_import(
        &self,
    ) -> CoreResult<
        std::sync::MutexGuard<'_, crate::chrome_profile_import::ChromeProfileImportRuntime>,
    > {
        self.chrome_profile_import
            .lock()
            .map_err(|_| CoreError::Internal("Chrome profile import lock poisoned".to_owned()))
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

    pub fn invoke_external_session(
        &self,
        command: crate::model::ExternalSessionCommand,
    ) -> CoreResult<crate::model::ExternalSessionResult> {
        self.with_runtime(|_| Ok(()))?;
        let mut browser = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
        let mut sessions = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?;
        let previous = sessions.clone();
        let removed = match &command {
            crate::model::ExternalSessionCommand::Remove { role_id, .. } => {
                sessions.get(role_id).cloned()
            }
            _ => None,
        };
        let result = sessions.invoke(command.clone())?;
        let browser_result = match command {
            crate::model::ExternalSessionCommand::Begin {
                role, workspace_id, ..
            } => browser.invoke(crate::model::BrowserRuntimeCommand::RoleTransition {
                role_id: role.id,
                runtime: "external".to_owned(),
                workspace_id,
                tab_id: None,
                state: "launching".to_owned(),
                launched_at: None,
            }),
            crate::model::ExternalSessionCommand::SetRunning {
                role_id,
                launched_at,
            } => {
                let workspace_id = sessions
                    .get(&role_id)
                    .and_then(|session| session.workspace_id.clone());
                browser.invoke(crate::model::BrowserRuntimeCommand::RoleTransition {
                    role_id,
                    runtime: "external".to_owned(),
                    workspace_id,
                    tab_id: None,
                    state: "running".to_owned(),
                    launched_at: Some(launched_at),
                })
            }
            crate::model::ExternalSessionCommand::SetStopping { role_id } => {
                let workspace_id = sessions
                    .get(&role_id)
                    .and_then(|session| session.workspace_id.clone());
                browser.invoke(crate::model::BrowserRuntimeCommand::RoleTransition {
                    role_id,
                    runtime: "external".to_owned(),
                    workspace_id,
                    tab_id: None,
                    state: "stopping".to_owned(),
                    launched_at: None,
                })
            }
            crate::model::ExternalSessionCommand::Remove {
                role_id,
                preserve_workspace,
            } => {
                browser.invoke(crate::model::BrowserRuntimeCommand::RemoveRole { role_id })?;
                if let Some(workspace_id) = removed.and_then(|session| session.workspace_id)
                    && !preserve_workspace
                    && !sessions.workspace_has_sessions(&workspace_id)
                {
                    browser.invoke(crate::model::BrowserRuntimeCommand::RemoveWorkspace {
                        workspace_id,
                    })
                } else {
                    browser.invoke(crate::model::BrowserRuntimeCommand::Snapshot)
                }
            }
            _ => browser.invoke(crate::model::BrowserRuntimeCommand::Snapshot),
        };
        if let Err(error) = browser_result {
            *sessions = previous;
            return Err(error);
        }
        Ok(result)
    }

    pub async fn connect_external_chrome_cdp(
        &self,
        role_id: String,
        browser_user_data_dir: PathBuf,
        launch_url: String,
        timeout: Option<std::time::Duration>,
        cdn_enabled: bool,
    ) -> CoreResult<Arc<crate::ExternalChromeCdpSession>> {
        self.with_runtime(|_| Ok(()))?;
        let cdn = if cdn_enabled {
            let matcher = Arc::clone(&self.cdn);
            let patterns = matcher
                .read()
                .map_err(|_| CoreError::Internal("CDN matcher lock poisoned".to_owned()))?
                .request_patterns();
            Some(crate::external_chrome::CdnRequestRewriter {
                patterns,
                rewrite: Arc::new(move |url| {
                    matcher.read().ok().and_then(|matcher| matcher.rewrite(url))
                }),
            })
        } else {
            None
        };
        let session = Arc::new(
            crate::ExternalChromeCdpSession::connect(
                browser_user_data_dir,
                launch_url,
                timeout,
                cdn,
            )
            .await?,
        );
        self.external_automation
            .register(role_id, Arc::clone(&session))?;
        Ok(session)
    }

    pub fn unregister_external_chrome_automation(&self, role_id: &str) -> CoreResult<()> {
        self.external_automation.unregister(role_id)
    }

    pub async fn dispatch_external_browser_actions(
        &self,
        actions: Vec<crate::model::BrowserActionRequest>,
    ) -> CoreResult<crate::model::ExternalBrowserActionDispatch> {
        self.with_runtime(|_| Ok(()))?;
        self.external_automation.dispatch(actions).await
    }

    pub async fn focus_external_chrome(&self, role_id: &str) -> CoreResult<()> {
        self.with_runtime(|_| Ok(()))?;
        self.external_automation.focus(role_id).await
    }

    pub async fn set_external_chrome_window_bounds(
        &self,
        role_id: &str,
        bounds: crate::model::StatePixelBoundsRecord,
    ) -> CoreResult<()> {
        self.with_runtime(|_| Ok(()))?;
        self.external_automation
            .set_window_bounds(role_id, bounds)
            .await
    }

    pub async fn capture_external_chrome_diagnostics(
        &self,
        role_id: &str,
    ) -> CoreResult<serde_json::Value> {
        self.with_runtime(|_| Ok(()))?;
        self.external_automation.diagnostics(role_id).await
    }

    pub async fn evaluate_external_chrome(
        &self,
        role_id: &str,
        source: &str,
    ) -> CoreResult<serde_json::Value> {
        self.with_runtime(|_| Ok(()))?;
        self.external_automation.evaluate(role_id, source).await
    }

    pub fn shutdown(&self) {
        self.browser_operations.shutdown();
        self.operation_actor.shutdown();
        self.resource_controller.shutdown();
        self.external_automation.shutdown();
        self.external_processes.shutdown();
        self.macro_runtime.shutdown();
        if let Ok(mut embedded_input) = self.embedded_input.lock() {
            embedded_input.shutdown();
        }
        if let Ok(mut health) = self.external_health.lock() {
            health.shutdown();
        }
        if let Ok(mut runtime) = self.runtime.lock()
            && let Some(mut runtime) = runtime.take()
        {
            runtime.pressure.shutdown();
            runtime.scheduler.shutdown();
            runtime.telemetry.shutdown();
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

    pub fn record_napi_latency(&self, duration_ms: f64) {
        let _ = self.with_runtime(|runtime| {
            runtime.telemetry.record_napi(duration_ms);
            Ok(())
        });
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
        snapshot: ElectronDiagnosticsSnapshotRecord,
    ) -> CoreResult<DiagnosticExportResultRecord> {
        let captured_at = chrono::Utc::now();
        let freeze_reported_at = snapshot
            .external_freeze_reported_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&chrono::Utc));
        let graphics_since = freeze_reported_at
            .map(|value| value - chrono::Duration::minutes(30))
            .unwrap_or_else(|| captured_at - chrono::Duration::minutes(30));
        let windows_graphics_events =
            crate::windows_graphics_events::collect(self.platform, &graphics_since.to_rfc3339())?;
        let host = rion_platform::collect_system_host_diagnostics();
        let state = self.read_typed_snapshot()?;
        let external_role_ids = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?
            .snapshot()
            .into_iter()
            .map(|session| session.role.id)
            .collect::<Vec<_>>();
        let mut external_chrome = Vec::with_capacity(external_role_ids.len());
        for role_id in external_role_ids {
            if let Ok(diagnostics) = self.capture_external_diagnostics(&role_id).await {
                external_chrome.push(diagnostics);
            }
        }
        let current_level = self.log_capture()?.current_level();
        let logging = self.with_runtime(|runtime| runtime.logs.storage_status(current_level))?;
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
                "electron": snapshot.electron_version,
                "chromium": snapshot.chromium_version,
                "node": snapshot.node_version,
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
            "externalChrome": external_chrome,
            "windowsGraphicsEvents": windows_graphics_events,
            "windowsGraphicsEventWindow": {
                "freezeReportedAt": freeze_reported_at.map(|value| value.to_rfc3339()),
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

    fn external_health(&self) -> CoreResult<std::sync::MutexGuard<'_, ExternalHealthRuntime>> {
        self.external_health
            .lock()
            .map_err(|_| CoreError::Internal("external health lock poisoned".to_owned()))
    }

    fn emit(&self, events: Vec<CoreEvent>) {
        broadcast_events(&self.subscribers, events);
    }
}

fn embedded_status(result: EmbeddedLaunchResultRecord) -> crate::model::BrowserRoleStatusRecord {
    crate::model::BrowserRoleStatusRecord {
        role_id: result.role_id,
        state: result.state,
        launched_at: Some(result.launched_at),
        notice: None,
        runtime_mode: result.runtime_mode,
        automation_state: None,
        page_health: None,
        resource_state: None,
        cpu_throttle_rate: None,
        resource_pressure_level: None,
        resource_reason: None,
    }
}

fn external_status(session: &ExternalSessionRecord) -> crate::model::BrowserRoleStatusRecord {
    crate::model::BrowserRoleStatusRecord {
        role_id: session.role.id.clone(),
        state: session.state.clone(),
        launched_at: session.launched_at.clone(),
        notice: session.notice.clone(),
        runtime_mode: "external".to_owned(),
        automation_state: (session.state == "running").then(|| {
            if session.automation_available {
                "ready".to_owned()
            } else {
                "unavailable".to_owned()
            }
        }),
        page_health: session.page_health.clone(),
        resource_state: None,
        cpu_throttle_rate: None,
        resource_pressure_level: None,
        resource_reason: None,
    }
}

fn apply_resource_status(
    status: &mut crate::model::BrowserRoleStatusRecord,
    resource: &ResourceRuntimeStatusRecord,
) {
    status.resource_state = Some(resource.resource_state.clone());
    status.cpu_throttle_rate = Some(resource.cpu_throttle_rate);
    status.resource_pressure_level = resource.resource_pressure_level.clone();
    status.resource_reason = resource.resource_reason.clone();
}

fn effect_value<T: DeserializeOwned>(result: &CoreEffectResult) -> CoreResult<T> {
    if !result.ok {
        let error = result
            .error
            .clone()
            .unwrap_or_else(|| crate::error::CoreErrorPayload {
                code: "CORE_EFFECT_FAILED".to_owned(),
                message: "The Electron effect failed.".to_owned(),
            });
        return Err(CoreError::Effect {
            code: error.code,
            message: error.message,
        });
    }
    let value = result.value_json.as_deref().unwrap_or("null");
    serde_json::from_str(value).map_err(|error| {
        CoreError::Internal(format!(
            "Electron effect returned an invalid result: {error}"
        ))
    })
}

fn append_external_notice(current: Option<String>, next: &str) -> Option<String> {
    match current {
        Some(current) if current.contains(next) => Some(current),
        Some(current) => Some(format!("{current} {next}")),
        None => Some(next.to_owned()),
    }
}

fn remove_external_notice(current: Option<String>, target: &str) -> Option<String> {
    current.and_then(|current| {
        let next = current.replace(target, "").trim().to_owned();
        (!next.is_empty()).then_some(next)
    })
}

fn external_overlay_bridge_source() -> String {
    format!(
        r#"(() => {{
  const bindingName = {binding};
  const bridgeKey = {bridge};
  if (window[bridgeKey]?.version === 1 || typeof window[bindingName] !== "function") return;
  const nativeBinding = window[bindingName];
  let nextId = 1;
  const pending = new Map();
  window[bridgeKey] = {{
    version: 1,
    resolve(id, ok, value) {{
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (ok) request.resolve(value);
      else request.reject(new Error(String(value)));
    }}
  }};
  window[bindingName] = (request) => new Promise((resolve, reject) => {{
    const id = nextId++;
    pending.set(id, {{ resolve, reject }});
    nativeBinding(JSON.stringify({{ id, request }}));
  }});
}})()"#,
        binding =
            serde_json::to_string(EXTERNAL_OVERLAY_BINDING).expect("overlay binding is valid JSON"),
        bridge = serde_json::to_string(EXTERNAL_OVERLAY_BRIDGE_KEY)
            .expect("overlay bridge key is valid JSON"),
    )
}

fn system_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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
                kind: "app".to_owned(),
                handle_id: handle_id.to_owned(),
            },
            action,
            timeout,
        },
        compensation: compensation.map(|action| crate::operation_actor::OperationEffect {
            target: CoreEffectTarget {
                kind: "app".to_owned(),
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

fn complete_profile_lease(
    core: &AppCore,
    lease: Option<&crate::model::BrowserOperationLease>,
    succeeded: bool,
) -> CoreResult<()> {
    let Some(lease) = lease else {
        return Ok(());
    };
    if succeeded {
        core.browser_operations.complete(&lease.id)
    } else {
        core.browser_operations.abort(&lease.id)
    }
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

fn hidden_embedded_workspace_ids(snapshot: &crate::model::BrowserRuntimeSnapshot) -> Vec<String> {
    let active_tabs = snapshot
        .displays
        .iter()
        .filter_map(|display| display.active_tab_id.as_deref())
        .collect::<std::collections::HashSet<_>>();
    snapshot
        .tabs
        .iter()
        .filter(|tab| tab.hidden || !active_tabs.contains(tab.id.as_str()))
        .map(|tab| tab.id.clone())
        .collect()
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
    policy: StateWorkspaceResourcePolicyRecord,
    runtime_snapshot: crate::model::BrowserRuntimeSnapshot,
) -> Vec<crate::operation_actor::OperationStep> {
    let target = tab.target.clone();
    let zoom_factors = tab
        .roles
        .iter()
        .map(|role| (role.role.id.clone(), role.zoom_factor))
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
                reveal_display_ids: vec![target.display_id],
                focus_window_display_ids: vec![target.display_id],
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
    steps.push(effect_step(
        tab_id,
        CoreEffectAction::EmbeddedActivateResources {
            tab_id: tab_id.to_owned(),
            policy,
            role_ids,
        },
        Duration::from_secs(15),
        None,
    ));
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
    let display_id = snapshot
        .tabs
        .iter()
        .find(|tab| tab.id == removed_tab_id)?
        .display_id;
    snapshot
        .displays
        .iter()
        .find(|display| display.display_id == display_id)?
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

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::{
        error::CoreErrorPayload,
        model::{CoreEffectRequest, CoreEffectResult},
    };

    fn command(value: Value) -> CoreCommand {
        serde_json::from_value(value).unwrap()
    }

    fn core() -> (TempDir, Arc<AppCore>) {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(AppCoreOptions {
                app_version: "2.1.0-test".to_owned(),
                platform: "darwin".to_owned(),
                user_data_dir: directory.path().to_string_lossy().into_owned(),
                performance_telemetry_path: None,
            })
            .unwrap(),
        );
        (directory, core)
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
    ) -> (
        CoreResult<Value>,
        Vec<CoreEffectAction>,
        Vec<ChromeProfileImportProgressRecord>,
    ) {
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
        let progress = Arc::new(Mutex::new(Vec::new()));
        while !invocation.is_finished() {
            let Ok(events) = receiver.recv_timeout(Duration::from_secs(2)) else {
                continue;
            };
            for event in events {
                match event {
                    CoreEvent::CoreEffects { effects } => {
                        let results = effects
                            .into_iter()
                            .map(|effect| {
                                actions.lock().unwrap().push(effect.action.clone());
                                effect_result(effect, fail_action)
                            })
                            .collect();
                        core.dispatch_core_effect_results(results).unwrap();
                    }
                    CoreEvent::ChromeProfileImportProgress { progress: update } => {
                        progress.lock().unwrap().push(update)
                    }
                    _ => {}
                }
            }
        }
        (
            invocation.join().unwrap(),
            Arc::try_unwrap(actions).unwrap().into_inner().unwrap(),
            Arc::try_unwrap(progress).unwrap().into_inner().unwrap(),
        )
    }

    fn effect_result(effect: CoreEffectRequest, fail_action: Option<&str>) -> CoreEffectResult {
        let action_name = match &effect.action {
            CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
            CoreEffectAction::ChromeProfileApplySession { .. } => "chromeProfileApplySession",
            CoreEffectAction::ChromeProfileClearSession { .. } => "chromeProfileClearSession",
            CoreEffectAction::RoleBrowserDataClearSession { .. } => "roleBrowserDataClearSession",
            CoreEffectAction::CompatibilityLoadUrl { .. } => "compatibilityLoadUrl",
            CoreEffectAction::CompatibilityProbeGraphics { .. } => "compatibilityProbeGraphics",
            CoreEffectAction::CdnProbeGoogle { .. } => "cdnProbeGoogle",
            _ => "other",
        };
        let failed = fail_action == Some(action_name);
        let value_json = match &effect.action {
            CoreEffectAction::EmbeddedActivateResources { role_ids, .. } => Some(
                serde_json::to_string(
                    &role_ids
                        .iter()
                        .map(|role_id| ResourceRuntimeTargetRecord {
                            role_id: role_id.clone(),
                            runtime_mode: "embedded".to_owned(),
                            process_id: None,
                        })
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            ),
            CoreEffectAction::EmbeddedApplyResourceEffects { .. } => {
                Some(json!({ "unavailableRoleIds": [] }).to_string())
            }
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
            CoreEffectAction::CdnProbeGoogle { .. } => {
                Some(json!({ "available": false }).to_string())
            }
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
                    "ELECTRON_EFFECT_FAILED"
                }
                .to_owned(),
                message: "The fixture rejected the Electron effect.".to_owned(),
            }),
        }
    }

    fn chrome_profile_source_fixture(root: &Path) -> PathBuf {
        let source = root.join("Chrome User Data");
        fs::create_dir_all(source.join("Default/Local Storage")).unwrap();
        fs::write(
            source.join("Default/Local Storage/session"),
            b"imported-login-state",
        )
        .unwrap();
        fs::write(
            source.join("Local State"),
            json!({"profile":{"info_cache":{"Default":{"name":"Aron"}}}}).to_string(),
        )
        .unwrap();
        source
    }

    fn create_named_role(core: &AppCore, game_id: &str, name: &str) -> StateRoleRecord {
        serde_json::from_value(
            core.invoke(command(json!({
                "type": "roleCreate",
                "input": {
                    "gameId": game_id,
                    "name": name,
                    "launchUrl": "https://example.com/play"
                }
            })))
            .unwrap(),
        )
        .unwrap()
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
    fn role_browser_data_clear_commits_only_after_the_electron_session_is_cleared() {
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

        let role: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
        assert_eq!(role.browser_session_source.as_deref(), Some("embedded"));
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
        core.shutdown();
    }

    #[test]
    fn role_browser_data_clear_restores_the_login_directory_after_effect_failure() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        core.invoke(CoreCommand::RoleSetBrowserSessionSource {
            id: role_id.clone(),
            source: "chrome-profile".to_owned(),
        })
        .unwrap();
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

        assert_eq!(result.unwrap_err().code(), "ELECTRON_EFFECT_FAILED");
        assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
        let role: StateRoleRecord = serde_json::from_value(
            core.invoke(CoreCommand::RoleGet {
                id: role_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            role.browser_session_source.as_deref(),
            Some("chrome-profile")
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
    fn chrome_profile_apply_commits_files_state_session_effects_and_progress() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let existing = create_named_role(&core, &game_id, "Aron");
        let browser = directory
            .path()
            .join("roles")
            .join(&existing.id)
            .join("browser");
        fs::write(browser.join("session"), b"old-login-state").unwrap();
        let source = chrome_profile_source_fixture(directory.path());
        let preview = core
            .invoke(CoreCommand::ChromeProfilePreview {
                source_user_data_dir: source.to_string_lossy().into_owned(),
            })
            .unwrap();
        let import_id = preview["importId"].as_str().unwrap().to_owned();

        let (result, actions, progress) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::ChromeProfileApply {
                import_id: import_id.clone(),
                profile_ids: vec!["Default".to_owned()],
                game_id,
                consent_accepted: true,
            },
            None,
        );

        assert_eq!(result.unwrap()["roles"][0]["id"], existing.id);
        assert_eq!(
            fs::read(browser.join("Default/Local Storage/session")).unwrap(),
            b"imported-login-state"
        );
        assert!(!browser.join("session").exists());
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::ChromeProfileApplySession {
                role_id,
                cookies_json,
                ..
            } if role_id == &existing.id && cookies_json == "[]"
        )));
        assert_eq!(
            progress
                .iter()
                .map(|update| update.phase.as_str())
                .collect::<Vec<_>>(),
            vec!["preparing", "importing", "completed"]
        );
        let role: StateRoleRecord = serde_json::from_value(
            core.invoke(CoreCommand::RoleGet {
                id: existing.id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            role.browser_session_source.as_deref(),
            Some("chrome-profile")
        );
        assert!(
            !directory
                .path()
                .join("chrome-profile-import-transaction.json")
                .exists()
        );
        core.shutdown();
    }

    #[test]
    fn chrome_profile_apply_rolls_back_files_and_state_after_session_effect_failure() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let existing = create_named_role(&core, &game_id, "Aron");
        let browser = directory
            .path()
            .join("roles")
            .join(&existing.id)
            .join("browser");
        fs::write(browser.join("session"), b"old-login-state").unwrap();
        let source = chrome_profile_source_fixture(directory.path());
        let preview = core
            .invoke(CoreCommand::ChromeProfilePreview {
                source_user_data_dir: source.to_string_lossy().into_owned(),
            })
            .unwrap();

        let (result, actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::ChromeProfileApply {
                import_id: preview["importId"].as_str().unwrap().to_owned(),
                profile_ids: vec!["Default".to_owned()],
                game_id,
                consent_accepted: true,
            },
            Some("chromeProfileApplySession"),
        );

        assert_eq!(result.unwrap_err().code(), "ELECTRON_EFFECT_FAILED");
        assert_eq!(
            fs::read(browser.join("session")).unwrap(),
            b"old-login-state"
        );
        assert!(!browser.join("Default/Local Storage/session").exists());
        assert!(actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::ChromeProfileClearSession { role_id, .. }
                if role_id == &existing.id
        )));
        let role: StateRoleRecord = serde_json::from_value(
            core.invoke(CoreCommand::RoleGet {
                id: existing.id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(role.browser_session_source, existing.browser_session_source);
        assert!(
            !directory
                .path()
                .join("chrome-profile-import-transaction.json")
                .exists()
        );
        let lease = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![existing.id],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&lease.id).unwrap();
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
                versions: CompatibilityVersionRecord {
                    chrome: "140".to_owned(),
                    electron: "40".to_owned(),
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
        let invocation = thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(invocation_core.invoke_async(CoreCommand::CompatibilityRun {
                    game_id,
                    versions: CompatibilityVersionRecord {
                        chrome: "140".to_owned(),
                        electron: "40".to_owned(),
                    },
                }))
        });
        let mut saw_cleanup = false;
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
        core.shutdown();
    }

    #[test]
    fn cdn_auto_detection_is_deduplicated_cached_and_returns_bundled_patterns() {
        let (_directory, core) = core();

        let (first, first_actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::CdnResolveSession {
                session_handle_id: "session-1".to_owned(),
            },
            None,
        );
        let (second, second_actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::CdnResolveSession {
                session_handle_id: "session-2".to_owned(),
            },
            None,
        );

        assert_eq!(first.unwrap()["enabled"], true);
        assert_eq!(second.unwrap()["enabled"], true);
        assert_eq!(
            first_actions
                .iter()
                .filter(|action| matches!(action, CoreEffectAction::CdnProbeGoogle { .. }))
                .count(),
            1
        );
        assert!(second_actions.is_empty());
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
            Some(CoreEffectAction::EmbeddedCreateTab { .. })
        ));
        assert!(launch_actions.iter().any(|action| matches!(
            action,
            CoreEffectAction::EmbeddedLoadRoles { roles } if roles.len() == 1
        )));

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
    fn rolls_back_runtime_and_electron_handles_after_load_failure() {
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
            let (stop, _) = drive_command(
                Arc::clone(&core),
                CoreCommand::EmbeddedWorkspaceStop { workspace_id },
                None,
            );
            assert!(stop.is_ok());
            core.shutdown();
        }
    }
}
