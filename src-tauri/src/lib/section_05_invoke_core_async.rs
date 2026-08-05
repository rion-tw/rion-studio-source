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

async fn restore_saved_game_windows(
    state: &CoreState,
    window: &WebviewWindow,
    args: &[Value],
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
    let selected = if scope == "window" {
        game_windows
            .iter()
            .filter(|saved| Some(saved.id.as_str()) == input["windowId"].as_str())
            .cloned()
            .collect::<Vec<_>>()
    } else {
        let runtime_before_restore = browser_runtime_snapshot(state)?;
        select_auto_restore_saved_windows(
            &game_windows,
            last_focused_window_id.as_deref(),
            &runtime_before_restore,
        )
    };
    let recovery_flow = state.runtime.recovery_required();
    replace_restore_progress(
        state,
        selected.iter().map(|saved| saved.id.clone()).collect(),
    )?;
    let restore_progress = RestoreProgressGuard::new(state);
    let mut restored_ids = Vec::new();
    let mut failures = Vec::new();
    for saved in selected {
        let close_runtime = Arc::clone(&state.runtime);
        let close_window_id = saved.id.clone();
        if let Err(error) = tauri::async_runtime::spawn_blocking(move || {
            close_runtime.wait_for_window_close_before_reopen(&close_window_id)
        })
        .await
        .map_err(|error| shell_error("TAURI_RESTORE_WINDOW_FAILED", error.to_string()))?
        {
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
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_WINDOW_FAILED",
                "message": error.to_string()
            }));
            window_failed = true;
        }
        state
            .runtime
            .prepare_restored_window_tabs(
                &target,
                &saved.tabs,
                saved.active_tab_id.clone(),
            )
            .map_err(|error| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", error))?;
        let mut active_runtime_tab_id = None;
        for tab in restore_tabs_in_owner_priority(&saved) {
            let mut prepared_role_slots = false;
            let mut restored_tab_id = tab.id.clone();
            let native_owner = state
                .runtime
                .native_tab_for_source(&tab.source_id, &tab.tab_type);
            let launch_succeeded = if let Some(native_tab_id) = native_owner {
                let owner_window_id = state.runtime.live_tab_window_id(&native_tab_id);
                if owner_window_id.as_deref() == Some(saved.id.as_str()) {
                    restored_tab_id = native_tab_id;
                    true
                } else {
                    failures.push(json!({
                        "windowId": saved.id,
                        "tabId": tab.id,
                        "sourceId": tab.source_id,
                        "code": "TAURI_RESTORE_SOURCE_CONFLICT",
                        "message": format!(
                            "The saved source is already running in Game Window {}.",
                            owner_window_id.unwrap_or_else(|| "unknown".to_owned())
                        )
                    }));
                    window_failed = true;
                    false
                }
            } else {
                // Live topology was seeded for the whole saved window above, but it is
                // only durable demand. Stage slot geometry and enqueue native creation
                // without treating the pre-seeded LiveTabRecord as an attached WebView.
                state
                    .runtime
                    .prepare_restored_tab_role_slots(&tab.id, &tab.role_slots)
                    .map_err(|error| shell_error("TAURI_RESTORE_LAYOUT_PREPARE_FAILED", error))?;
                prepared_role_slots = true;
                let launch_result = if tab.tab_type == "workspace" {
                    invoke_core_async(
                        state,
                        json!({
                            "type": "browserWorkspaceLaunch",
                            "workspaceId": tab.source_id,
                            "target": target,
                            "restoreRoleSlots": tab.role_slots
                        }),
                    )
                    .await
                } else {
                    invoke_core_async(
                        state,
                        json!({
                            "type": "browserRoleLaunch",
                            "roleId": tab.source_id,
                            "target": target
                        }),
                    )
                    .await
                };
                match launch_result {
                    Ok(_) => true,
                    Err(error) => {
                        state.runtime.discard_prepared_tab_role_slots(&tab.id);
                        failures.push(json!({
                            "windowId": saved.id,
                            "tabId": tab.id,
                            "sourceId": tab.source_id,
                            "code": error.code,
                            "message": error.message
                        }));
                        window_failed = true;
                        false
                    }
                }
            };

            if !launch_succeeded {
                continue;
            }
            if saved.active_tab_id.as_deref() == Some(tab.id.as_str()) {
                active_runtime_tab_id = Some(restored_tab_id.clone());
            }
            if prepared_role_slots && restored_tab_id != tab.id {
                state.runtime.discard_prepared_tab_role_slots(&tab.id);
                prepared_role_slots = false;
            }
            if !prepared_role_slots
                && state.runtime.native_tab_exists(&restored_tab_id)
                && let Err(error) = state
                    .runtime
                    .restore_tab_role_slots(&restored_tab_id, &tab.role_slots)
            {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": "TAURI_RESTORE_LAYOUT_FAILED",
                    "message": error
                }));
                window_failed = true;
            }
            if tab.audio_muted
                && state.runtime.native_tab_exists(&restored_tab_id)
                && let Err(error) = state.runtime.restore_tab_audio_muted(&tab.source_id, true)
            {
                failures.push(json!({
                    "windowId": saved.id,
                    "tabId": tab.id,
                    "sourceId": tab.source_id,
                    "code": "TAURI_RESTORE_AUDIO_FAILED",
                    "message": error
                }));
                window_failed = true;
            }
        }
        if let Err(error) = state
            .runtime
            .finish_prepared_restored_window_tabs(&saved.id)
        {
            failures.push(json!({
                "windowId": saved.id,
                "code": "TAURI_RESTORE_TAB_ORDER_FAILED",
                "message": error
            }));
            window_failed = true;
        }
        if let Some(active_tab_id) = active_runtime_tab_id.as_deref()
            && let Err(error) = preview_and_commit_tab_selection(
                window.app_handle(),
                state,
                active_tab_id,
            )
        {
            failures.push(json!({
                "windowId": saved.id,
                "tabId": active_tab_id,
                "code": "TAURI_RESTORE_ACTIVATION_FAILED",
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
    let remaining_windows = game_windows
        .iter()
        .filter(|saved| {
            !saved.tabs.is_empty() && !restored_ids.iter().any(|restored| restored == &saved.id)
        })
        .map(game_window_restore_record)
        .collect::<Vec<_>>();
    let focus_window_id = last_focused_window_id
        .filter(|window_id| restored_ids.contains(window_id))
        .or_else(|| restored_ids.last().cloned());
    restore_progress.finish()?;
    state.runtime.replace_dormant_windows(
        remaining_windows.clone(),
        recovery_flow && !remaining_windows.is_empty(),
    );
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    if let Some(window_id) = focus_window_id {
        Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedWindowsShow {
                window_id: Some(window_id),
            })
            .await
            .map_err(error_payload)?;
    }
    Ok(json!({
        "restoredWindowIds": restored_ids,
        "failures": failures
    }))
}

fn browser_runtime_snapshot(state: &CoreState) -> Result<BrowserRuntimeSnapshot, CoreErrorPayload> {
    state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)
        .and_then(|snapshot| {
            serde_json::from_value(snapshot)
                .map_err(|error| shell_error("TAURI_RESTORE_INVALID", error.to_string()))
        })
        .and_then(|snapshot| {
            state.runtime.live_runtime_snapshot(snapshot).ok_or_else(|| {
                shell_error(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The live tab topology could not be read; the stale Core snapshot was ignored.",
                )
            })
        })
}
