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
        AppCoreOptions, BrowserActionResult, CdnRule, CoreCommand, CoreEffectDispatchReport,
        CoreEffectResult, CoreEvent, GameBrowserSettingsRecord, LegalAcceptanceRecord,
        MacroSettingsRecord, OperationCancelResultRecord, ResourcePolicyDecision,
        ResourcePolicyInput, RuntimeWindowPreferencesRecord, StateCompatibilityReportRecord,
        StateGameRecord, StateRoleRecord,
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
