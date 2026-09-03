#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppCoreShutdownOutcome {
    Completed,
    AlreadyCompleted,
}

struct ProcessRetainedInstanceLock {
    #[cfg(test)]
    user_data_dir: std::path::PathBuf,
    _file: std::fs::File,
}

fn process_retained_instance_locks(
) -> &'static std::sync::Mutex<Vec<ProcessRetainedInstanceLock>> {
    static RETAINED: std::sync::OnceLock<
        std::sync::Mutex<Vec<ProcessRetainedInstanceLock>>,
    > = std::sync::OnceLock::new();
    RETAINED.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

impl AppCore {
    pub fn quiesce_automatic_input_for_shutdown(&self) {
        self.macro_runtime.shutdown();
    }

    /// Performs the irreversible Core shutdown only after the destructive
    /// command domain is proven idle. Callers that own a bounded external drain
    /// must use this checked boundary so an active Role browser-data clear can
    /// never be reported as a successful teardown.
    pub fn shutdown_checked(&self) -> CoreResult<AppCoreShutdownOutcome> {
        self.begin_role_browser_data_clear_command_drain()
            .map_err(|error| {
                shutdown_preterminal_unverified(
                    "Core could not establish the Role browser-data clear admission fence",
                    error,
                )
            })?;
        if !self
            .role_browser_data_clear_commands
            .is_idle()
            .map_err(|error| {
                shutdown_preterminal_unverified(
                    "Core could not verify the Role browser-data clear command terminal",
                    error,
                )
            })?
        {
            return Err(CoreError::Domain {
                code: "CORE_SHUTDOWN_ROLE_BROWSER_DATA_CLEAR_UNVERIFIED",
                message: "Core shutdown cannot release its runtime or instance lock before every accepted Role browser-data clear reaches its command-domain terminal."
                .to_owned(),
            });
        }
        if !self
            .browser_operations
            .begin_shutdown_and_check_idle()
            .map_err(|error| {
                shutdown_preterminal_unverified(
                    "Core could not verify the browser-operation terminal",
                    error,
                )
            })?
        {
            return Err(CoreError::Domain {
                code: "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED",
                message: "Core shutdown cannot release its runtime or instance lock while an admitted browser operation still owns a non-terminal lease."
                    .to_owned(),
            });
        }
        if self
            .shutdown_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            let runtime_released = self
                .runtime
                .read()
                .map_err(|_| CoreError::Internal("runtime lock poisoned".to_owned()))?
                .is_none();
            let instance_lock_released = self
                .instance_lock
                .lock()
                .map_err(|_| CoreError::Internal("instance lock poisoned".to_owned()))?
                .is_none();
            return if runtime_released && instance_lock_released {
                Ok(AppCoreShutdownOutcome::AlreadyCompleted)
            } else {
                Err(CoreError::Domain {
                    code: "CORE_SHUTDOWN_IN_PROGRESS",
                    message: "Core shutdown has started but has not proven terminal teardown."
                        .to_owned(),
                })
            };
        }
        self.launch_completion.shutdown();
        self.quiesce_automatic_input_for_shutdown();
        self.browser_action_effects.shutdown();
        self.operation_actor.shutdown();
        self.overlay_refresh.shutdown();
        self.embedded_input
            .lock()
            .map_err(|_| CoreError::Internal("embedded input lock poisoned".to_owned()))?
            .shutdown();
        {
            let mut divider_runtime = self.workspace_divider_runtime.lock().map_err(|_| {
                CoreError::Internal("workspace divider runtime lock poisoned".to_owned())
            })?;
            // Core shutdown is the terminal actor-stop boundary for native
            // divider gestures. Move commits remain authoritative in memory;
            // shutdown itself performs no divider durability commit. A prior,
            // independent window snapshot may already have persisted them.
            divider_runtime.gestures.clear();
        }
        let core_effects = self.operation_actor.metrics();
        let mut instance_lock = self
            .instance_lock
            .lock()
            .map_err(|_| CoreError::Internal("instance lock poisoned".to_owned()))?;
        if instance_lock.is_none() {
            return Err(CoreError::Domain {
                code: "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
                message: "Core instance-lock ownership was unavailable during verified shutdown."
                    .to_owned(),
            });
        }
        let mut runtime = self
            .runtime
            .write()
            .map_err(|_| CoreError::Internal("runtime lock poisoned".to_owned()))?;
        {
            let runtime = runtime.as_mut().ok_or_else(|| CoreError::Domain {
                code: "CORE_SHUTDOWN_RUNTIME_UNVERIFIED",
                message: "Core runtime teardown was not available for verified shutdown."
                    .to_owned(),
            })?;
            runtime.scheduler.shutdown();
            runtime.telemetry.record_core_effects(core_effects);
            runtime.telemetry.shutdown();
            runtime.logs.shutdown()?;
            runtime.state.shutdown()?;
        }
        let released_runtime = runtime.take().ok_or_else(|| CoreError::Domain {
            code: "CORE_SHUTDOWN_RUNTIME_UNVERIFIED",
            message: "Core runtime teardown lost ownership before terminal release.".to_owned(),
        })?;
        drop(runtime);
        drop(released_runtime);
        self.emit(vec![CoreEvent::Shutdown]);
        let file = instance_lock.as_ref().ok_or_else(|| CoreError::Domain {
            code: "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
            message: "Core instance-lock ownership was lost before terminal release.".to_owned(),
        })?;
        fs2::FileExt::unlock(file).map_err(|error| {
            CoreError::Internal(format!("Core instance lock unlock failed: {error}"))
        })?;
        let _released_instance_lock = instance_lock.take().ok_or_else(|| CoreError::Domain {
            code: "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
            message: "Core instance-lock ownership was lost after successful unlock.".to_owned(),
        })?;
        Ok(AppCoreShutdownOutcome::Completed)
    }

    /// Compatibility boundary for existing Rust owners. Production shells that
    /// need to decide whether process exit is clean must call
    /// [`Self::shutdown_checked`] and inspect its result.
    pub fn shutdown(&self) {
        if let Err(error) = self.shutdown_checked() {
            eprintln!("Core shutdown did not reach a verified terminal: {error}");
        }
    }

    /// Transfers a still-owned OS instance lock to process-lifetime quarantine.
    /// A checked shutdown failure must never turn object destruction into an
    /// observable unlock that lets another shell enter the same data directory.
    fn retain_instance_lock_until_process_exit(&mut self) -> bool {
        #[cfg(test)]
        if !self
            .retain_failed_shutdown_instance_lock_for_test
            .load(Ordering::Acquire)
        {
            return false;
        }

        let instance_lock = match self.instance_lock.get_mut() {
            Ok(instance_lock) => instance_lock,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(file) = instance_lock.take() else {
            return false;
        };
        let retained = ProcessRetainedInstanceLock {
            #[cfg(test)]
            user_data_dir: self.user_data_dir.clone(),
            _file: file,
        };
        let mut locks = match process_retained_instance_locks().lock() {
            Ok(locks) => locks,
            Err(poisoned) => poisoned.into_inner(),
        };
        locks.push(retained);
        true
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
        let browser_runtime_registration = self.browser_runtime_registration()?;
        let gpu_feature_status =
            serde_json::from_str::<Value>(&snapshot.gpu_feature_status_raw_json)
                .unwrap_or(Value::Null);
        let gpu_info = snapshot
            .gpu_info_raw_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let runtime_registration_key = if self.runtime_contract_version
            >= CHROMIUM_RUNTIME_CONTRACT_VERSION
        {
            "browserRuntime"
        } else {
            "systemRuntime"
        };
        let runtime_registration_value = if self.runtime_contract_version
            >= CHROMIUM_RUNTIME_CONTRACT_VERSION
        {
            serde_json::to_value(&browser_runtime_registration)
        } else {
            serde_json::to_value(SystemWebViewRuntimeRegistrationRecord {
                platform: browser_runtime_registration.platform.clone(),
                engine: browser_runtime_registration.engine,
                adapter_version: browser_runtime_registration.adapter_version.clone(),
                available: browser_runtime_registration.available,
                capability_snapshot: browser_runtime_registration.capabilities.clone(),
                failure_reason: browser_runtime_registration.failure_reason.map(Into::into),
            })
        }
        .map_err(|error| CoreError::Internal(error.to_string()))?;
        let mut browser_engines = json!({
            "activeRoles": browser_role_statuses,
            "activeWorkspaces": browser_workspace_statuses,
            "foregroundPerformance": snapshot.browser_performance,
            "nativeRuntime": snapshot.native_runtime,
        });
        browser_engines
            .as_object_mut()
            .ok_or_else(|| CoreError::Internal("browser diagnostics must be an object".to_owned()))?
            .insert(runtime_registration_key.to_owned(), runtime_registration_value);
        let diagnostics = json!({
            "generatedAt": captured_at.to_rfc3339(),
            "application": {
                "buildCommit": snapshot.build_commit,
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
            "browserEngines": browser_engines,
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

fn shutdown_preterminal_unverified(context: &str, cause: CoreError) -> CoreError {
    CoreError::Domain {
        code: "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED",
        message: format!("{context}: {cause}"),
    }
}

#[cfg(test)]
fn release_process_retained_instance_lock_for_test(
    user_data_dir: &std::path::Path,
) -> CoreResult<bool> {
    let mut locks = process_retained_instance_locks()
        .lock()
        .map_err(|_| CoreError::Internal("retained instance-lock registry poisoned".to_owned()))?;
    let Some(index) = locks
        .iter()
        .position(|retained| retained.user_data_dir == user_data_dir)
    else {
        return Ok(false);
    };
    let retained = locks.swap_remove(index);
    fs2::FileExt::unlock(&retained._file).map_err(|error| {
        CoreError::Internal(format!(
            "could not release the test process-retained instance lock: {error}"
        ))
    })?;
    Ok(true)
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
            compensate_on_rejected_result: true,
        },
        compensation: compensation.map(|action| crate::operation_actor::OperationEffect {
            target: CoreEffectTarget {
                kind: CoreEffectTargetKind::App,
                handle_id: handle_id.to_owned(),
            },
            action,
            timeout: Duration::from_secs(15),
            compensate_on_rejected_result: true,
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
        operation_ids.extend(tab.role_slots.iter().map(|slot| slot.role_id.clone()));
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

fn rollback_role_delete_journals(core: &AppCore, journals: &[(String, String, bool)]) {
    for (role_id, operation_id, deferred_cleanup) in journals.iter().rev() {
        if *deferred_cleanup
            || crate::role_browser_data::restore_quarantine(
                &core.user_data_dir,
                role_id,
                operation_id,
            )
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
    deferred_by_windows_lock: bool,
) -> CoreResult<()> {
    if !deferred_by_windows_lock {
        crate::role_browser_data::remove(&core.user_data_dir, role_id)?;
        if had_directory {
            crate::role_browser_data::restore_quarantine(
                &core.user_data_dir,
                role_id,
                operation_id,
            )?;
        }
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

fn require_chrome_import_journal_fence(
    journal: &OperationJournalRecord,
    expected_phase: &str,
    expected_revision: u64,
) -> CoreResult<()> {
    if journal.kind != "chrome_profile_import_v2"
        || journal.phase != expected_phase
        || crate::chrome_profile_import_contract::journal_revision(journal)? != expected_revision
    {
        return Err(CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
            message: "The Chrome profile import transaction changed before completion."
                .to_owned(),
        });
    }
    Ok(())
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
                    crate::role_browser_data::remove(user_data_dir, role_id)?;
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
                "deferred" => {
                    if journal
                        .payload
                        .get("deferredByWindowsLock")
                        .and_then(Value::as_bool)
                        != Some(true)
                        || journal
                            .payload
                            .get("hadDirectory")
                            .and_then(Value::as_bool)
                            != Some(true)
                    {
                        return Err(CoreError::Migration(
                            "deferred role browser-data clear journal is invalid".to_owned(),
                        ));
                    }
                    // A deferred prepare means Windows rejected the quarantine
                    // rename and the original role directory never moved. A
                    // timed-out helper has no authoritative completion receipt,
                    // so restart may only roll the journal back after proving
                    // that exact disk topology. It must not turn uncertainty
                    // into a clear or a v23 explicit-reset transaction.
                    crate::role_browser_data::recover_deferred_clear_rollback(
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
