impl AppCore {
    pub fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.launch_completion.shutdown();
        self.browser_operations.shutdown();
        self.macro_runtime.shutdown();
        self.browser_action_effects.shutdown();
        self.operation_actor.shutdown();
        let core_effects = self.operation_actor.metrics();
        self.overlay_refresh.shutdown();
        if let Ok(mut embedded_input) = self.embedded_input.lock() {
            embedded_input.shutdown();
        }
        if let Ok(mut runtime) = self.runtime.write()
            && let Some(mut runtime) = runtime.take()
        {
            runtime.scheduler.shutdown();
            runtime.telemetry.record_core_effects(core_effects);
            runtime.telemetry.shutdown();
            if let Err(error) = runtime.logs.shutdown() {
                eprintln!("Rion Studio log database shutdown failed: {error}");
            }
            runtime.state.shutdown();
        }
        self.emit(vec![CoreEvent::Shutdown]);
        if let Ok(mut lock) = self.instance_lock.lock()
            && let Some(file) = lock.take()
        {
            let _ = fs2::FileExt::unlock(&file);
        }
    }

    fn with_runtime<T>(&self, operation: impl FnOnce(&Runtime) -> CoreResult<T>) -> CoreResult<T> {
        let runtime = self
            .runtime
            .read()
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
                "foregroundPerformance": snapshot.browser_performance,
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
        publish_events(&self.event_sender, events);
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
    let codec = (game.builtin_key.as_deref() == Some("flyff-universe"))
        .then(|| "flyff-client-settings-v7".to_owned());
    if game.local_storage_sync_keys.is_empty()
        && game.local_storage_sync_selectors.is_empty()
        && codec.is_none()
    {
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
        selectors: game.local_storage_sync_selectors.clone(),
        codec,
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

fn launching_browser_status(role_id: String) -> crate::model::BrowserRoleStatusRecord {
    crate::model::BrowserRoleStatusRecord {
        role_id,
        state: "launching".to_owned(),
        launched_at: None,
        notice: None,
        runtime_mode: "embedded".to_owned(),
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

fn validate_runtime_theme(theme: &str) -> CoreResult<()> {
    if matches!(theme, "light" | "dark") {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "runtime theme is invalid".to_owned(),
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

fn finalize_chrome_import_post_commit(
    warnings: &mut Vec<String>,
    cleanup_journal: impl FnOnce() -> CoreResult<()>,
    cleanup_staging: impl FnOnce() -> std::io::Result<()>,
    cleanup_operation: impl FnOnce() -> CoreResult<()>,
) {
    if cleanup_journal().is_err() {
        // Preserve staging and its durable commit marker so startup recovery
        // can distinguish this committed import from a rollback candidate.
        warnings.push("SESSION_IMPORT_JOURNAL_CLEANUP_PENDING".to_owned());
    } else if let Err(error) = cleanup_staging()
        && error.kind() != ErrorKind::NotFound
    {
        warnings.push("SESSION_IMPORT_STAGING_CLEANUP_PENDING".to_owned());
    }
    if cleanup_operation().is_err() {
        warnings.push("BROWSER_OPERATION_CLEANUP_PENDING".to_owned());
    }
}

fn recover_operation_journals(
    state: &StateDatabaseWorker,
    user_data_dir: &std::path::Path,
) -> CoreResult<()> {
    for journal in state.operation_journals()? {
        if journal.kind == "native_effect_compensation_v1" {
            if journal.phase != "restart-required" {
                return Err(CoreError::Migration(format!(
                    "unsupported native compensation journal phase: {}",
                    journal.phase
                )));
            }
            // Tauri windows and WebViews cannot survive a process restart. At this point the
            // orphaned native handles are gone and the persisted runtime projection is once
            // again authoritative, so the restart itself completes this recovery boundary.
            state.delete_operation_journal(journal.id)?;
            continue;
        }
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
