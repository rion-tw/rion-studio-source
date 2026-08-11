async fn invoke_core_async(state: &CoreState, command: Value) -> Result<Value, CoreErrorPayload> {
    let command = serde_json::from_value::<CoreCommand>(command)
        .map_err(|error| shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string()))?;
    Arc::clone(&state.core)
        .invoke_async(command)
        .await
        .map_err(error_payload)
}

fn invoke_core_sync(state: &CoreState, command: Value) -> Result<Value, CoreErrorPayload> {
    let command = serde_json::from_value::<CoreCommand>(command)
        .map_err(|error| shell_error("TAURI_SHELL_INPUT_INVALID", error.to_string()))?;
    state.core.invoke(command).map_err(error_payload)
}

async fn export_portable_data(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    state
        .runtime
        .persist_all_game_window_placements()
        .map_err(|error| shell_error("TAURI_GAME_WINDOW_FLUSH_FAILED", error))?;
    let default_name = "rion-studio-export.json".to_owned();
    let path = native_shell::save_file(
        app,
        window,
        "Export Rion Studio JSON",
        &default_name,
        "json",
    )
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let input = args.first().cloned().unwrap_or(Value::Null);
    let selection = input.get("selection").cloned().unwrap_or_else(|| {
        json!({
            "games": true,
            "roles": true,
            "launchWorkspaces": true,
            "gameWindows": true,
            "macros": true,
            "preferences": true
        })
    });
    let mut command = json!({
        "type": "portableExportTo",
        "path": path.to_string_lossy(),
        "selection": selection
    });
    if let Some(preferences) = input.get("preferences") {
        command["preferences"] = preferences.clone();
    }
    invoke_core_sync(state, command)
}

async fn preview_portable_import(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let path = native_shell::pick_file(app, window, "Import Rion Studio JSON", "json")
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    invoke_core_sync(
        state,
        json!({ "type": "portablePreviewFile", "path": path.to_string_lossy() }),
    )
}

async fn preview_chrome_profile_import(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let default_path = invoke_core_sync(state, json!({ "type": "chromeProfileDefaultPath" }))?
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| {
            shell_error(
                "CHROME_PROFILE_PATH_UNAVAILABLE",
                "The default Chrome User Data folder is unavailable.",
            )
        })?;
    let selected =
        native_shell::pick_directory(app, window, "Choose Chrome User Data", &default_path)
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = selected else {
        return Ok(Value::Null);
    };
    invoke_core_sync(
        state,
        json!({
            "type": "chromeProfilePreview",
            "sourceUserDataDir": path.to_string_lossy()
        }),
    )
}

async fn reveal_logs(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let directory = invoke_core_sync(state, json!({ "type": "logsStatus" }))?
        .get("directory")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| shell_error("SHELL_REVEAL_FAILED", "Log directory is unavailable."))?;
    tauri::async_runtime::spawn_blocking(move || native_shell::reveal_in_file_manager(&directory))
        .await
        .map_err(|error| shell_error("SHELL_REVEAL_FAILED", error.to_string()))?
        .map_err(|error| shell_error("SHELL_REVEAL_FAILED", error))?;
    Ok(Value::Null)
}

async fn export_diagnostics(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &CoreState,
) -> Result<Value, CoreErrorPayload> {
    let path = native_shell::save_file(
        app,
        window,
        "Export Rion Studio Diagnostics",
        "Rion-Studio-Diagnostics.zip",
        "zip",
    )
    .await
    .map_err(|error| shell_error("SHELL_DIALOG_FAILED", error))?;
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let displays = capture_display_inventory(window)?
        .records
        .into_iter()
        .map(|display| {
            json!({
                "bounds": display.bounds,
                "resolution": display.resolution,
                "scaleFactor": display.scale_factor
            })
        })
        .collect::<Vec<_>>();
    let versions = runtime_versions(app, state)?;
    invoke_core_async(
        state,
        json!({
            "type": "diagnosticsExport",
            "path": path.to_string_lossy(),
            "snapshot": {
                "applicationName": app.package_info().name,
                "applicationVersion": app.package_info().version.to_string(),
                "buildCommit": option_env!("RION_STUDIO_BUILD_COMMIT").unwrap_or("unknown"),
                "packaged": !cfg!(debug_assertions),
                "engine": versions["engine"].clone(),
                "engineVersion": versions["engineVersion"].clone(),
                "shell": versions["shell"].clone(),
                "shellVersion": versions["shellVersion"].clone(),
                "locale": "system",
                "systemVersion": std::env::consts::OS,
                "displays": displays,
                "gpuFeatureStatusRawJson": "{}",
                "browserPerformance": state.runtime.last_browser_performance_diagnostics(),
                "nativeRuntime": state.runtime.system_runtime_diagnostics(
                    state.core.macro_input_diagnostics().ok()
                )
            }
        }),
    )
    .await
}

fn runtime_versions(_app: &tauri::AppHandle, state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let probe = invoke_core_sync(state, json!({ "type": "systemWebViewProbe" }))?;
    Ok(json!({
        "engine": probe["engine"].clone(),
        "engineVersion": probe["runtimeVersion"]
            .as_str()
            .unwrap_or("unknown"),
        "shell": "tauri",
        "shellVersion": tauri::VERSION
    }))
}

async fn create_game_window_transaction(
    state: &CoreState,
    input: GameWindowCreateInputRecord,
) -> Result<Value, CoreErrorPayload> {
    let created = Arc::clone(&state.core)
        .invoke_async(CoreCommand::GameWindowCreate { input })
        .await
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<StateGameWindowRecord>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    serde_json::to_value(created)
        .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SavedWindowRestoreActivation {
    Background,
    UserInitiated,
}

fn saved_window_restore_candidate_ids(
    activation: SavedWindowRestoreActivation,
    scope: &str,
    dormant_window_ids: &HashSet<String>,
    session_recovery_window_ids: &HashSet<String>,
    startup_restore_window_ids: Option<&HashSet<String>>,
) -> HashSet<String> {
    if activation == SavedWindowRestoreActivation::Background {
        startup_restore_window_ids
            .cloned()
            .unwrap_or_else(|| dormant_window_ids.clone())
    } else if scope != "window"
        && activation == SavedWindowRestoreActivation::UserInitiated
        && !session_recovery_window_ids.is_empty()
    {
        session_recovery_window_ids.clone()
    } else {
        dormant_window_ids.clone()
    }
}

fn saved_window_restore_focus_target(
    activation: SavedWindowRestoreActivation,
    selected: &[StateGameWindowRecord],
    last_focused_window_id: Option<&str>,
) -> Option<String> {
    if activation == SavedWindowRestoreActivation::Background {
        return None;
    }
    last_focused_window_id
        .filter(|window_id| selected.iter().any(|saved| saved.id == *window_id))
        .map(str::to_owned)
        .or_else(|| selected.first().map(|saved| saved.id.clone()))
}

async fn restore_saved_game_windows(
    state: &CoreState,
    window: &WebviewWindow,
    args: &[Value],
    activation: SavedWindowRestoreActivation,
) -> Result<Value, CoreErrorPayload> {
    let input = args
        .first()
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "all" }));
    let scope = input["scope"].as_str().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window restore scope is invalid.",
        )
    })?;
    if !matches!(scope, "all" | "last-visible" | "window") {
        return Err(shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window restore scope is invalid.",
        ));
    }
    let game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })?;
    let last_focused_window_id = state
        .core
        .invoke(CoreCommand::RuntimeRestoreSessionGet)
        .ok()
        .and_then(|session| session["lastFocusedWindowId"].as_str().map(str::to_owned));
    let dormant_window_ids = state.runtime.dormant_window_ids();
    let session_recovery_window_ids = state.runtime.session_recovery_window_ids();
    let startup_restore_window_ids = state.runtime.startup_restore_window_ids();
    let restore_candidate_ids = saved_window_restore_candidate_ids(
        activation,
        scope,
        &dormant_window_ids,
        &session_recovery_window_ids,
        startup_restore_window_ids.as_ref(),
    );
    let eligible_game_windows = game_windows
        .iter()
        .filter(|saved| restore_candidate_ids.contains(&saved.id))
        .cloned()
        .collect::<Vec<_>>();
    let selected = if scope == "window" {
        let requested_window_id = input["windowId"]
            .as_str()
            .filter(|window_id| !window_id.trim().is_empty())
            .ok_or_else(|| {
                shell_error(
                    "TAURI_SHELL_INPUT_INVALID",
                    "Saved Game Window ID is required for window restore scope.",
                )
            })?;
        let saved = game_windows
            .iter()
            .find(|saved| saved.id == requested_window_id)
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_GAME_WINDOW_NOT_FOUND",
                    "The requested saved Game Window does not exist.",
                )
            })?;
        let runtime_before_restore = browser_runtime_snapshot(state)?;
        if saved_window_conflicts_with_runtime(&saved, &runtime_before_restore) {
            return Err(shell_error(
                "TAURI_RESTORE_SOURCE_CONFLICT",
                "A saved Game Window source is already owned by another live window.",
            ));
        }
        vec![saved]
    } else {
        let runtime_before_restore = browser_runtime_snapshot(state)?;
        select_auto_restore_saved_windows(
            &eligible_game_windows,
            last_focused_window_id.as_deref(),
            &runtime_before_restore,
        )
    };
    let requested_window_ids = selected
        .iter()
        .map(|saved| saved.id.clone())
        .collect::<Vec<_>>();
    let selected_window_ids = if scope == "window"
        && activation == SavedWindowRestoreActivation::UserInitiated
    {
        state.runtime.begin_saved_window_restore(&selected)
    } else {
        state
            .runtime
            .begin_dormant_window_restore(&requested_window_ids)
    };
    if selected_window_ids.is_empty() {
        return Ok(json!({
            "restoredWindowIds": [],
            "failures": []
        }));
    }
    let selected_window_id_set = selected_window_ids.iter().cloned().collect::<HashSet<_>>();
    let selected = selected
        .into_iter()
        .filter(|saved| selected_window_id_set.contains(&saved.id))
        .collect::<Vec<_>>();
    let focus_window_id = saved_window_restore_focus_target(
        activation,
        &selected,
        last_focused_window_id.as_deref(),
    );
    let restore_progress = RestoreProgressGuard::new(state, selected_window_ids.clone());
    replace_restore_progress(state, selected_window_ids.clone())?;
    let mut restored_ids = Vec::new();
    let mut failures = Vec::new();
    let mut failed_window_messages = HashMap::new();
    for saved in selected {
        let close_runtime = Arc::clone(&state.runtime);
        let close_window_id = saved.id.clone();
        let close_result = match tauri::async_runtime::spawn_blocking(move || {
            close_runtime.wait_for_window_close_before_reopen(&close_window_id)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let message = error.to_string();
                failed_window_messages
                    .entry(saved.id.clone())
                    .or_insert_with(|| message.clone());
                failures.push(json!({
                    "windowId": saved.id,
                    "code": "TAURI_RESTORE_WINDOW_FAILED",
                    "message": message
                }));
                continue;
            }
        };
        if let Err(error) = close_result {
            failed_window_messages
                .entry(saved.id.clone())
                .or_insert_with(|| error.clone());
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_WINDOW_CLOSE_PENDING",
                "message": error
            }));
            continue;
        }
        let target = match launch_target_for_game_window(window.app_handle(), &saved.id) {
            Ok(target) => target,
            Err(error) => {
                failed_window_messages
                    .entry(saved.id.clone())
                    .or_insert_with(|| error.message.clone());
                failures.push(json!({
                    "windowId": saved.id,
                    "code": error.code,
                    "message": error.message
                }));
                continue;
            }
        };
        let mut window_failed = false;
        if saved.tabs.is_empty()
            && let Err(error) = Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedWindowRegister {
                    target: target.clone(),
                })
                .await
        {
            let message = error.to_string();
            failed_window_messages
                .entry(saved.id.clone())
                .or_insert_with(|| message.clone());
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_WINDOW_FAILED",
                "message": message
            }));
            window_failed = true;
        }
        if let Err(error) = state
            .runtime
            .prepare_restored_window_tabs(
                &target,
                &saved.name,
                &saved.tabs,
                saved.active_tab_id.clone(),
            )
        {
            failed_window_messages
                .entry(saved.id.clone())
                .or_insert_with(|| error.clone());
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_TAB_ORDER_FAILED",
                "message": error
            }));
            state
                .runtime
                .discard_prepared_restored_window_tabs(&saved.id);
            continue;
        }
        if focus_window_id.as_deref() == Some(saved.id.as_str()) {
            match state
                .runtime
                .activate_live_runtime_window(&saved.id, "saved-window-restore")
            {
                Ok(true) => state
                    .runtime
                    .mark_prepared_restored_window_visible(&saved.id),
                Ok(false) => failures.push(json!({
                    "windowId": saved.id,
                    "code": "TAURI_RESTORE_ACTIVATION_FAILED",
                    "message": "The restored Game Window was unavailable for its initial activation."
                })),
                Err(error) => failures.push(json!({
                    "windowId": saved.id,
                    "code": "TAURI_RESTORE_ACTIVATION_FAILED",
                    "message": error
                })),
            }
        }
        let foreground_tab = saved_window_foreground_tab(&saved);
        if let Some(tab) = foreground_tab
            && let Err(error) = activate_runtime_tab_on_demand(
                window.app_handle(),
                state,
                &tab.id,
                false,
            )
            .await
        {
            failed_window_messages
                .entry(saved.id.clone())
                .or_insert_with(|| error.message.clone());
            failures.push(json!({
                "windowId": saved.id,
                "tabId": tab.id,
                "sourceId": tab.source_id,
                "code": error.code,
                "message": error.message
            }));
            window_failed = true;
        }
        if let Err(error) = state
            .runtime
            .finish_prepared_restored_window_tabs(&saved.id)
        {
            failed_window_messages
                .entry(saved.id.clone())
                .or_insert_with(|| error.clone());
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_TAB_ORDER_FAILED",
                "message": error
            }));
            window_failed = true;
        }
        if window_failed {
            state
                .runtime
                .discard_prepared_restored_window_tabs(&saved.id);
        }
        if !window_failed {
            restored_ids.push(saved.id.clone());
        }
    }
    state.runtime.finish_dormant_window_restore(
        &selected_window_ids,
        &restored_ids,
        &failed_window_messages,
    );
    restore_progress.finish()?;
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    Ok(json!({
        "restoredWindowIds": restored_ids,
        "failures": failures
    }))
}

fn browser_runtime_snapshot(state: &CoreState) -> Result<BrowserRuntimeSnapshot, CoreErrorPayload> {
    state
        .core
        .browser_runtime_snapshot()
        .map_err(error_payload)
        .and_then(|snapshot| {
            state.runtime.live_runtime_snapshot(snapshot).ok_or_else(|| {
                shell_error(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The live tab topology could not be read; the stale Core snapshot was ignored.",
                )
            })
        })
}
