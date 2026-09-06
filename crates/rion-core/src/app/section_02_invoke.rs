impl AppCore {
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
            CoreCommand::BrowserRuntimeRegister { registration } => {
                serde_json::to_value(self.register_browser_runtime(registration)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::StateSnapshot => self.with_runtime(|runtime| runtime.state.snapshot()),
            CoreCommand::AppSnapshot => serde_json::to_value(self.app_snapshot()?)
                .map_err(|error| CoreError::Internal(error.to_string())),
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
                if self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION {
                    let _guard = self.state_mutation_guard()?;
                    let role_id = uuid::Uuid::new_v4().to_string();
                    let initialization = crate::v23_role_initialization::new_evidence(
                        role_id.clone(),
                        self.platform,
                    );
                    crate::v23_role_initialization::prepare_empty_store(
                        &self.user_data_dir,
                        &initialization,
                    )?;
                    return match self.mutate_state_under_guard(
                        StateMutation::RoleCreateWithV23Ready {
                            id: role_id,
                            input,
                            initialization: initialization.clone(),
                        },
                    ) {
                        Ok(role) => Ok(role),
                        Err(error) => {
                            crate::v23_role_initialization::rollback_empty_store(
                                &self.user_data_dir,
                                &initialization,
                            );
                            Err(error)
                        }
                    };
                }
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
            CoreCommand::GlobalWebProfilePathsResolve => {
                if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
                    return Err(CoreError::Domain {
                        code: "GLOBAL_WEB_PROFILE_RUNTIME_UNAVAILABLE",
                        message: "The global Web Chromium profile is unavailable before runtime contract v23."
                            .to_owned(),
                    });
                }
                serde_json::to_value(crate::global_web_profile::ensure(&self.user_data_dir)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleAssignGameIds { assignments } => {
                self.mutate_state(StateMutation::RoleAssignGameIds(assignments))
            }
            CoreCommand::RoleSessionMigrationGet { role_id } => {
                serde_json::to_value(self.role_session_migration(role_id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleSessionMigrationsList => {
                serde_json::to_value(self.role_session_migrations()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
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
            CoreCommand::GameWindowSaveRuntime { input } => self.save_runtime_game_window(input),
            CoreCommand::GameWindowRuntimeSnapshotCommit { input } => {
                self.commit_runtime_window_snapshot(input)
            }
            CoreCommand::GameWindowRuntimeSnapshotBatchCommit { input } => {
                self.commit_runtime_window_snapshot_batch(input)
            }
            CoreCommand::GameWindowUpdate { id, input } => {
                self.mutate_state(StateMutation::GameWindowUpdate { id, input })
            }
            CoreCommand::GameWindowSaveConfiguration { id, input } => {
                self.save_game_window_configuration(id, input)
            }
            CoreCommand::GameWindowsDisplayRemap { updates } => {
                self.mutate_state(StateMutation::GameWindowsDisplayRemap { updates })
            }
            CoreCommand::GameWindowReorder { ordered_ids } => {
                self.mutate_state(StateMutation::GameWindowReorder { ordered_ids })
            }
            CoreCommand::GameWindowDelete { id } => self.delete_game_window(id),
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
            CoreCommand::GameBrowserSettingsPatch { patch } => {
                serde_json::to_value(self.patch_game_browser_settings(patch)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserFontCatalogList => {
                serde_json::to_value(crate::font_catalog::list(&self.user_data_dir))
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserFontPackInstall { catalog_id } => serde_json::to_value(
                crate::font_catalog::install(&self.user_data_dir, &catalog_id)?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserFontFamilyInstall { family } => serde_json::to_value(
                crate::font_catalog::install_family(&self.user_data_dir, &family)?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserFontPackRemove { catalog_id } => serde_json::to_value(
                crate::font_catalog::remove(&self.user_data_dir, &catalog_id)?,
            )
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserFontRuntimePayload { settings } => {
                let settings = if let Some(settings) = settings {
                    settings
                } else {
                    self.read_scalar_state::<GameBrowserSettingsRecord>(
                        "gameBrowserSettings",
                        "game browser settings are missing",
                    )?
                    .fonts
                };
                serde_json::to_value(crate::font_catalog::runtime_payload(
                    &self.user_data_dir,
                    settings,
                )?)
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
            CoreCommand::QuickAccessPinSet { item, pinned } => {
                self.mutate_state(StateMutation::QuickAccessPinSet { item, pinned })
            }
            CoreCommand::QuickAccessRecentRecord { item } => {
                self.mutate_state(StateMutation::QuickAccessRecentRecord { item })
            }
            CoreCommand::QuickAccessRecentClear => {
                self.mutate_state(StateMutation::QuickAccessRecentClear)
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
                let session = self.replace_runtime_restore_session(session)?;
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
            CoreCommand::SystemFontsList { families } => {
                let mut cache = self.system_fonts.lock().map_err(|_| {
                    CoreError::Internal("system font cache lock poisoned".to_owned())
                })?;
                if cache.is_none() {
                    let queried = if self.runtime_contract_version >= 23 {
                        families.unwrap_or_default()
                    } else {
                        rion_platform::query_system_font_names(self.platform).unwrap_or_default()
                    };
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
            } => self.apply_portable_import(import_id, selection, resolutions),
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
            CoreCommand::OverlayLanguageSet { language } => {
                validate_overlay_language(&language)?;
                *self.overlay_language.lock().map_err(|_| {
                    CoreError::Internal("overlay language lock poisoned".to_owned())
                })? = Some(language.clone());
                self.overlay_refresh.invalidate(Vec::new());
                Ok(json!({ "language": language }))
            }
            CoreCommand::RuntimeThemeSet { theme } => {
                validate_runtime_theme(&theme)?;
                *self.resolved_theme.lock().map_err(|_| {
                    CoreError::Internal("resolved theme lock poisoned".to_owned())
                })? = theme.clone();
                self.overlay_refresh.invalidate(Vec::new());
                Ok(json!({ "theme": theme }))
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
            CoreCommand::MacroReleaseRole { role_id } => self.release_macro_role(role_id),
            CoreCommand::MacroInputFence { role_id } => self.macro_input_fence(role_id),
            CoreCommand::MacroInputDrain {
                role_id,
                input_epoch,
            } => self.macro_input_drain(role_id, input_epoch),
            CoreCommand::MacroInputResume {
                role_id,
                input_epoch,
            } => self.macro_input_resume(role_id, input_epoch),
            CoreCommand::MacroInputRecoveryInspect {
                recovery_id,
                role_id,
                expected_input_epoch,
            } => serde_json::to_value(self.inspect_macro_input_recovery(
                &recovery_id,
                &role_id,
                expected_input_epoch,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::MacroInputRecoveryComplete {
                recovery_id,
                role_id,
                expected_input_epoch,
            } => serde_json::to_value(self.complete_macro_input_recovery_exact(
                &recovery_id,
                &role_id,
                expected_input_epoch,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::MacroInputRecoveryFail {
                recovery_id,
                role_id,
                expected_input_epoch,
                message,
            } => serde_json::to_value(self.fail_macro_input_recovery_exact(
                &recovery_id,
                &role_id,
                expected_input_epoch,
                &message,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::ManagedShortcutPhase {
                operation_id,
                role_id,
                tab_id,
                surface_generation,
                document_instance_id,
                expected_owner_generation,
                press_id,
                macro_id,
                code,
                phase,
                modifier_codes,
            } => serde_json::to_value(self.dispatch_managed_shortcut_phase(
                ManagedShortcutPhaseInput {
                    operation_id,
                    role_id,
                    tab_id,
                    surface_generation,
                    document_instance_id,
                    expected_owner_generation,
                    press_id,
                    macro_id,
                    code,
                    phase,
                    modifier_codes,
                },
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::ManagedShortcutSurfaceRetire {
                role_id,
                surface_generation,
                document_instance_id,
            } => serde_json::to_value(self.retire_managed_shortcut_surface(
                &role_id,
                surface_generation,
                &document_instance_id,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
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
            CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id,
                reason,
                expected_tab_id,
                expected_owner_generation,
            } => serde_json::to_value(self.report_crashed_system_surface(
                &role_id,
                reason.as_deref(),
                expected_tab_id.as_deref(),
                expected_owner_generation,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedSystemSurfaceRecovered { role_id } => {
                serde_json::to_value(self.report_recovered_system_surface(&role_id)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowRegister { target } => {
                serde_json::to_value(self.register_embedded_window(target)?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowDelete { window_id: _ } => {
                serde_json::to_value(self.apply_embedded_runtime_command(
                    Vec::new(),
                    None,
                    Vec::new(),
                    Vec::new(),
                    None,
                )?)
                .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowsShow { window_id } => self.show_embedded_windows(window_id),
            CoreCommand::EmbeddedWindowVisibility {
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                visible,
            } => serde_json::to_value(self.apply_runtime_window_visibility_action(
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                visible,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedWindowPresentation {
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                presentation,
            } => serde_json::to_value(self.apply_runtime_window_presentation_action(
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                presentation,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserRuntimeWindowZoom {
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                action,
            } => serde_json::to_value(self.apply_runtime_window_zoom_action(
                operation_id,
                window_id,
                window_generation,
                topology_revision,
                action,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserWindowsRuntimeWindowPlacement { event } => {
                serde_json::to_value(self.commit_windows_runtime_window_placement(event)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::EmbeddedWindowProvisionForTabMove {
                operation_id,
                tab_id,
                source_window_id,
                source_window_generation,
                source_topology_revision,
                target,
            } => serde_json::to_value(self.apply_runtime_window_provision_for_tab_move(
                operation_id,
                tab_id,
                source_window_id,
                source_window_generation,
                source_topology_revision,
                target,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedWindowProvisionResume {
                operation_id,
                tab_id,
            } => serde_json::to_value(self.resume_runtime_window_provision(operation_id, tab_id)?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedWindowRetireProvision {
                operation_id,
                window_id,
                window_generation,
                topology_revision,
            } => {
                self.retire_runtime_window_provision(
                    operation_id,
                    window_id,
                    window_generation,
                    topology_revision,
                )?;
                Ok(json!({ "retired": true }))
            }
            CoreCommand::EmbeddedTabActivate {
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
            } => serde_json::to_value(self.apply_runtime_tab_action(
                RuntimeUiTabAction::Activate,
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedTabHide {
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
                hidden,
            } => serde_json::to_value(self.apply_runtime_tab_action(
                RuntimeUiTabAction::Hide { hidden },
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedTabReorder {
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
                before_tab_id,
            } => serde_json::to_value(self.apply_runtime_tab_action(
                RuntimeUiTabAction::Reorder { before_tab_id },
                operation_id,
                tab_id,
                window_id,
                window_generation,
                topology_revision,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::EmbeddedTabMove {
                operation_id,
                tab_id,
                source_window_id,
                source_window_generation,
                source_topology_revision,
                target_window_id,
                target_window_generation,
                target_topology_revision,
                before_tab_id,
            } => serde_json::to_value(self.apply_runtime_tab_move_action(
                operation_id,
                tab_id,
                source_window_id,
                source_window_generation,
                source_topology_revision,
                target_window_id,
                target_window_generation,
                target_topology_revision,
                before_tab_id,
            )?)
            .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserStatuses => serde_json::to_value(self.browser_statuses()?)
                .map_err(|error| CoreError::Internal(error.to_string())),
            CoreCommand::BrowserWorkspaceStatuses => {
                serde_json::to_value(self.browser_workspace_statuses()?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserRuntimeSnapshot => self.serialized_browser_runtime_snapshot(),
            CoreCommand::BrowserRuntimeSuspend {
                suspended,
                lifecycle_epoch,
            } => {
                let reload_admission = self
                    .supersede_all_controlled_role_reloads("applicationLifecycle")?;
                let current_epoch = self.application_lifecycle_epoch.load(Ordering::Acquire);
                let next_epoch = lifecycle_epoch
                    .unwrap_or_else(|| current_epoch.saturating_add(1).max(1));
                if next_epoch < current_epoch {
                    return Err(CoreError::Domain {
                        code: "SYSTEM_LIFECYCLE_EPOCH_STALE",
                        message: "The application lifecycle epoch is stale.".to_owned(),
                    });
                }
                self.application_lifecycle_epoch
                    .store(next_epoch, Ordering::Release);
                if suspended {
                    self.application_suspended.store(true, Ordering::Release);
                }
                let role_input_epochs = if suspended {
                    self.macro_runtime.suspend_for_application_lifecycle()?
                } else {
                    self.macro_runtime.resume_after_application_lifecycle()?
                };
                self.application_suspended
                    .store(suspended, Ordering::Release);
                drop(reload_admission);
                Ok(json!({
                    "suspended": suspended,
                    "lifecycleEpoch": next_epoch,
                    "roleInputEpochs": role_input_epochs,
                }))
            }
            CoreCommand::BrowserPopupOpenAdmit { request } => {
                serde_json::to_value(self.admit_chromium_popup(request)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::BrowserPopupLifecycleCommit { event } => {
                serde_json::to_value(self.commit_chromium_popup_lifecycle(event)?)
                    .map_err(|error| CoreError::Internal(error.to_string()))
            }
            CoreCommand::RoleBrowserDataClear { .. }
            | CoreCommand::GlobalWebProfileClear
            | CoreCommand::ChromeProfileRequestQuit { .. }
            | CoreCommand::ChromeProfileApply { .. }
            | CoreCommand::DiagnosticsExport { .. }
            | CoreCommand::OverlayRequest { .. }
            | CoreCommand::BrowserRoleLaunch { .. }
            | CoreCommand::BrowserWorkspaceLaunch { .. }
            | CoreCommand::BrowserRoleSlotClaim { .. }
            | CoreCommand::BrowserWorkspaceWebSurfaceFailed { .. }
            | CoreCommand::BrowserTabAudioMute { .. }
            | CoreCommand::BrowserRuntimeTabReload { .. }
            | CoreCommand::BrowserRoleStop { .. }
            | CoreCommand::BrowserWorkspaceStop { .. }
            | CoreCommand::EmbeddedTabStop { .. }
            | CoreCommand::BrowserWindowCloseAdmit { .. }
            | CoreCommand::BrowserWindowStop { .. }
            | CoreCommand::BrowserWindowDelete { .. }
            | CoreCommand::BrowserAppKitRuntimeEvent { .. }
            | CoreCommand::BrowserWorkspaceDividerPointer { .. } => Err(CoreError::Internal(
                "asynchronous browser intent reached the synchronous core dispatcher".to_owned(),
            )),
        }
    }
}
