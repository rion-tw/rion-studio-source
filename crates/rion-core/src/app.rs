use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};
use rion_platform::PixelBounds;
use serde_json::{Value, json};

use crate::{
    cdn::CdnMatcher,
    database::{
        DatabasePaths, LogDatabaseWorker, SCHEMA_VERSION, StateDatabaseWorker, StateMutation,
        bootstrap_databases,
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
        CdnRule, CoreCommand, CoreEffectAction, CoreEffectDispatchReport, CoreEffectResult,
        CoreEffectTarget, CoreEvent, EmbeddedLaunchResultRecord, EmbeddedLaunchTargetRecord,
        EmbeddedRoleLoadEffectRecord, EmbeddedRoleViewEffectRecord, EmbeddedTabEffectRecord,
        GameBrowserSettingsRecord, LegalAcceptanceRecord, MacroSettingsRecord,
        OperationCancelResultRecord, ResourcePolicyDecision, ResourcePolicyInput,
        RuntimeWindowPreferencesRecord, StateCompatibilityReportRecord, StateGameRecord,
        StateLaunchWorkspaceRecord, StateNormalizedRectRecord, StateRoleRecord,
        StateWorkspaceResourcePolicyRecord,
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
    browser_operations: crate::browser_operations::BrowserOperationCoordinator,
    cdn: Arc<RwLock<CdnMatcher>>,
    browser_runtime: Mutex<crate::browser_runtime::BrowserRuntime>,
    chrome_profile_import: Mutex<crate::chrome_profile_import::ChromeProfileImportRuntime>,
    compatibility_runtime: Mutex<crate::compatibility_runtime::CompatibilityRuntime>,
    database_paths: DatabasePaths,
    embedded_input: Mutex<crate::embedded_input::EmbeddedInputRuntime>,
    embedded_operations: Mutex<std::collections::HashMap<String, String>>,
    external_automation: crate::external_automation::ExternalAutomationRuntime,
    external_health: Mutex<ExternalHealthRuntime>,
    external_processes: crate::external_processes::ExternalProcessRuntime,
    external_sessions: Mutex<crate::external_sessions::ExternalSessionRuntime>,
    macro_runtime: MacroRuntime,
    operation_actor: crate::operation_actor::OperationActor,
    platform: rion_platform::Platform,
    portable: Mutex<crate::portable::PortableRuntime>,
    resource_runtime: Mutex<crate::resource_runtime::ResourceRuntime>,
    runtime: Mutex<Option<Runtime>>,
    embedded_runtime_sequence: crate::runtime_sequence::RuntimeOperationSequence,
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
        let macro_subscribers = Arc::clone(&subscribers);
        let macro_runtime = MacroRuntime::new(Arc::new(move |events| {
            broadcast_events(&macro_subscribers, events);
        }));
        let health_subscribers = Arc::clone(&subscribers);
        let external_health = ExternalHealthRuntime::new(Arc::new(move |events| {
            broadcast_events(&health_subscribers, events);
        }))?;
        let process_subscribers = Arc::clone(&subscribers);
        let external_processes = crate::external_processes::ExternalProcessRuntime::new(Arc::new(
            move |role_id, event| {
                broadcast_events(
                    &process_subscribers,
                    vec![CoreEvent::ExternalProcessExited {
                        role_id,
                        exit_code: event.exit_code,
                        terminated: event.terminated,
                    }],
                );
            },
        ));
        let effect_subscribers = Arc::clone(&subscribers);
        let operation_actor =
            crate::operation_actor::OperationActor::new(Arc::new(move |effects| {
                broadcast_events(
                    &effect_subscribers,
                    vec![CoreEvent::CoreEffects { effects }],
                );
            }));
        let core = Self {
            app_version: options.app_version,
            browser_operations: crate::browser_operations::BrowserOperationCoordinator::default(),
            browser_runtime: Mutex::new(crate::browser_runtime::BrowserRuntime::default()),
            cdn: Arc::new(RwLock::new(CdnMatcher::default())),
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
            external_automation: crate::external_automation::ExternalAutomationRuntime::new(
                platform_name.to_owned(),
            ),
            external_health: Mutex::new(external_health),
            external_processes,
            external_sessions: Mutex::new(
                crate::external_sessions::ExternalSessionRuntime::default(),
            ),
            macro_runtime,
            operation_actor,
            platform,
            portable: Mutex::new(crate::portable::PortableRuntime::default()),
            resource_runtime: Mutex::new(crate::resource_runtime::ResourceRuntime::default()),
            runtime: Mutex::new(Some(Runtime {
                state,
                logs,
                pressure,
                scheduler,
            })),
            embedded_runtime_sequence: crate::runtime_sequence::RuntimeOperationSequence::default(),
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
                let result = self.mutate_state(StateMutation::RoleDelete { id: id.clone() })?;
                crate::role_browser_data::remove(&self.user_data_dir, &id)?;
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
                let requested = self.compatibility_runtime()?.request_cancel(&game_id);
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
            CoreCommand::LayoutResolve { input } => serde_json::to_value(layout::resolve(&input))
                .map_err(|error| CoreError::Internal(error.to_string())),
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
            CoreCommand::LogsExportTo { path } => self.with_runtime(|runtime| {
                runtime.logs.export_jsonl_to(PathBuf::from(&path))?;
                Ok(json!({ "path": path }))
            }),
            CoreCommand::MacroStart { request } => {
                let (macros, settings) =
                    self.with_runtime(|runtime| runtime.state.macro_configuration())?;
                let request = crate::model::MacroStartRequest {
                    macros,
                    settings,
                    macro_id: request.macro_id,
                    role_id: request.role_id,
                    active_role_ids: request.active_role_ids,
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
                        active_role_ids: request.active_role_ids,
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
            CoreCommand::MacroMutationAcquire {
                macro_ids,
                stop_active,
            } => Ok(json!({
                "leaseId": self.macro_runtime.acquire_mutation(macro_ids, stop_active)?
            })),
            CoreCommand::MacroMutationRelease { lease_id } => {
                self.macro_runtime.release_mutation(&lease_id)?;
                Ok(json!({ "released": true }))
            }
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
        }
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
        let plan = embedded_launch_effects(
            &tab_id,
            tab,
            std::slice::from_ref(&role),
            StateWorkspaceResourcePolicyRecord {
                mode: "unrestricted".to_owned(),
            },
            runtime_snapshot,
        );
        if let Err(error) = self.run_effect_plan_for_roles(plan, std::slice::from_ref(&role.id)) {
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
        if let Err(error) = self.run_effect_plan_for_roles(
            embedded_launch_effects(
                &tab_id,
                tab,
                &roles,
                workspace.resource_policy.clone(),
                runtime_snapshot,
            ),
            &role_ids,
        ) {
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
            let action = if tab_role_count <= 1 {
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id: next_active_tab_after_removal(&snapshot, &tab_id),
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
                self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveTab {
                    tab_id: tab_id.clone(),
                })?;
                if let Some(workspace_id) = role.workspace_id {
                    self.invoke_browser_runtime(BrowserRuntimeCommand::RemoveWorkspace {
                        workspace_id,
                    })?;
                }
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
            if let Err(error) = self.run_effect_plan(vec![effect_step(
                &tab_id,
                CoreEffectAction::EmbeddedDestroyTab {
                    tab_id: tab_id.clone(),
                    next_active_tab_id: next_active_tab_after_removal(&snapshot, &tab_id),
                },
                Duration::from_secs(15),
                None,
            )]) {
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
        self.resource_runtime
            .lock()
            .map_err(|_| CoreError::Internal("resource runtime lock poisoned".to_owned()))?
            .invoke(command)
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
        let mut sessions = self
            .external_sessions
            .lock()
            .map_err(|_| CoreError::Internal("external session lock poisoned".to_owned()))?;
        let mut browser = self
            .browser_runtime
            .lock()
            .map_err(|_| CoreError::Internal("browser runtime lock poisoned".to_owned()))?;
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

    fn external_health(&self) -> CoreResult<std::sync::MutexGuard<'_, ExternalHealthRuntime>> {
        self.external_health
            .lock()
            .map_err(|_| CoreError::Internal("external health lock poisoned".to_owned()))
    }

    fn emit(&self, events: Vec<CoreEvent>) {
        broadcast_events(&self.subscribers, events);
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

    fn effect_result(effect: CoreEffectRequest, fail_action: Option<&str>) -> CoreEffectResult {
        let action_name = match effect.action {
            CoreEffectAction::EmbeddedLoadRoles { .. } => "embeddedLoadRoles",
            _ => "other",
        };
        let failed = fail_action == Some(action_name);
        CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: !failed,
            value_json: None,
            error: failed.then(|| CoreErrorPayload {
                code: "GAME_PAGE_LOAD_FAILED".to_owned(),
                message: "The fixture rejected navigation.".to_owned(),
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
