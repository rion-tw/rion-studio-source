#[tauri::command]
async fn rion_overlay_request(
    webview: Webview,
    state: State<'_, CoreState>,
    capability: String,
    payload: Value,
) -> Result<Value, CoreErrorPayload> {
    let role_id = state
        .runtime
        .authorize_overlay_request(webview.label(), &capability)
        .map_err(|message| shell_error("OVERLAY_REQUEST_UNAUTHORIZED", message))?;
    let request_json = serde_json::to_string(&payload).map_err(|error| CoreErrorPayload {
        code: "OVERLAY_REQUEST_INVALID".to_owned(),
        message: error.to_string(),
    })?;
    if request_json.len() > OVERLAY_REQUEST_MAX_BYTES {
        return Err(shell_error(
            "OVERLAY_REQUEST_TOO_LARGE",
            "The overlay request exceeds the allowed size.",
        ));
    }
    if overlay_request_activates_webview(&payload)
        && state
            .runtime
            .overlay_webview_is_selected(webview.label(), &role_id)
            .map_err(|message| shell_error("OVERLAY_WEBVIEW_FOCUS_STATE_FAILED", message))?
    {
        webview.set_focus().map_err(|error| {
            shell_error(
                "OVERLAY_WEBVIEW_FOCUS_FAILED",
                format!("Unable to focus the active role WebView: {error}"),
            )
        })?;
    }
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::OverlayRequest {
            role_id,
            request_json,
            language: None,
        })
        .await
        .map_err(error_payload)
}

#[tauri::command]
async fn rion_overlay_ready(
    webview: Webview,
    state: State<'_, CoreState>,
    capability: String,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .mark_overlay_ready(webview.label(), &capability)
        .map_err(|message| shell_error("OVERLAY_READY_UNAUTHORIZED", message))
}

#[tauri::command]
async fn rion_runtime_audio_state(
    webview: Webview,
    state: State<'_, CoreState>,
    audible: bool,
) -> Result<(), CoreErrorPayload> {
    let role_id = state
        .runtime
        .role_id_for_webview(webview.label())
        .map_err(|message| shell_error("TAURI_RUNTIME_AUDIO_UNAUTHORIZED", message))?;
    state
        .runtime
        .set_webview_audible(webview.label(), &role_id, audible)
        .map_err(|message| shell_error("TAURI_RUNTIME_AUDIO_FAILED", message))
}

#[tauri::command]
async fn rion_local_storage_sync_changed(
    webview: Webview,
    state: State<'_, CoreState>,
    token: String,
    generation: u64,
    sequence: u64,
    entries: Vec<(String, Option<String>)>,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .local_storage_sync_changed(webview.label(), &token, generation, sequence, entries)
        .map_err(|message| shell_error("TAURI_LOCAL_STORAGE_SYNC_REJECTED", message))
}

#[tauri::command]
async fn rion_divider_pointer(
    app: AppHandle,
    webview: Webview,
    state: State<'_, CoreState>,
    payload: system_runtime::DividerPointerPayload,
) -> Result<(), CoreErrorPayload> {
    match state
        .runtime
        .handle_divider_pointer(webview.label(), payload)
    {
        Ok(()) => Ok(()),
        Err(message) => {
            let error = shell_error("TAURI_DIVIDER_FAILED", message);
            reveal_shell_error(
                &app,
                CoreErrorPayload {
                    code: error.code.clone(),
                    message: error.message.clone(),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn rion_runtime_tab_action(
    app: AppHandle,
    webview: Webview,
    state: State<'_, CoreState>,
    action: Value,
) -> Result<(), CoreErrorPayload> {
    let window_id = state
        .runtime
        .tab_strip_window_for_webview(webview.label())
        .ok_or_else(|| {
            shell_error(
                "TAURI_RUNTIME_CHROME_UNAUTHORIZED",
                "Runtime tab actions are restricted to the local tab-strip WebView.",
            )
        })?;
    match runtime_tab_menu::handle_scoped_action(&app, &state, window_id, action).await {
        Ok(()) => Ok(()),
        Err(message) => {
            let error = shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message);
            reveal_shell_error(
                &app,
                CoreErrorPayload {
                    code: error.code.clone(),
                    message: error.message.clone(),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn rion_dispatch_core_effect_results(
    state: State<'_, CoreState>,
    results: Vec<CoreEffectResult>,
) -> Result<Value, CoreErrorPayload> {
    let core = Arc::clone(&state.core);
    tauri::async_runtime::spawn_blocking(move || {
        core.dispatch_core_effect_results(results)
            .and_then(|report| {
                serde_json::to_value(report)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            })
    })
    .await
    .map_err(|error| CoreErrorPayload {
        code: "CORE_INTERNAL_FAILED".to_owned(),
        message: error.to_string(),
    })?
    .map_err(error_payload)
}

#[tauri::command]
fn rion_shared_user_data_dir(state: State<'_, CoreState>) -> String {
    state.core.user_data_dir().to_string_lossy().into_owned()
}

fn monitor_id(monitor: &tauri::Monitor) -> i64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    monitor.name().hash(&mut hasher);
    monitor.position().x.hash(&mut hasher);
    monitor.position().y.hash(&mut hasher);
    monitor.size().width.hash(&mut hasher);
    monitor.size().height.hash(&mut hasher);
    safe_display_id(hasher.finish())
}

fn safe_display_id(hash: u64) -> i64 {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    (hash % MAX_SAFE_INTEGER) as i64
}

fn display_inventory(window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
    let primary = window
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = primary.as_ref().map(monitor_id);
    let monitors = window
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    Ok(Value::Array(
        monitors
            .iter()
            .map(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let scale_factor = monitor.scale_factor();
                let logical_width = (size.width as f64 / scale_factor).round() as i64;
                let logical_height = (size.height as f64 / scale_factor).round() as i64;
                let work_area = monitor.work_area();
                let id = monitor_id(monitor);
                json!({
                    "id": id,
                    "label": monitor.name().cloned().unwrap_or_else(|| format!("Display {id}")),
                    "bounds": {
                        "x": (position.x as f64 / scale_factor).round() as i64,
                        "y": (position.y as f64 / scale_factor).round() as i64,
                        "width": logical_width,
                        "height": logical_height
                    },
                    "workArea": {
                        "x": (work_area.position.x as f64 / scale_factor).round() as i64,
                        "y": (work_area.position.y as f64 / scale_factor).round() as i64,
                        "width": (work_area.size.width as f64 / scale_factor).round() as i64,
                        "height": (work_area.size.height as f64 / scale_factor).round() as i64
                    },
                    "resolution": {
                        "width": size.width,
                        "height": size.height
                    },
                    "scaleFactor": scale_factor,
                    "isPrimary": primary_id == Some(id),
                    "isInternal": false
                })
            })
            .collect(),
    ))
}

fn start_display_watcher(app: AppHandle) -> Result<(), String> {
    thread::Builder::new()
        .name("rion-tauri-display-watcher".to_owned())
        .spawn(move || {
            let mut previous = None;
            loop {
                thread::sleep(std::time::Duration::from_secs(2));
                let Some(window) = app.get_webview_window("main") else {
                    break;
                };
                let Ok(displays) = display_inventory(&window) else {
                    continue;
                };
                if previous.as_ref() == Some(&displays) {
                    continue;
                }
                let Some(state) = app.try_state::<CoreState>() else {
                    break;
                };
                let records = match serde_json::from_value::<Vec<rion_core::DisplayInfoRecord>>(
                    displays.clone(),
                ) {
                    Ok(records) => records,
                    Err(error) => {
                        let _ = app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "TAURI_DISPLAY_STATE_INVALID",
                                "message": error.to_string()
                            }),
                        );
                        continue;
                    }
                };
                let available_ids = records
                    .iter()
                    .map(|display| display.id)
                    .collect::<HashSet<_>>();
                let game_windows =
                    match state
                        .core
                        .invoke(CoreCommand::GameWindowsList)
                        .and_then(|value| {
                            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                                .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
                        }) {
                        Ok(game_windows) => game_windows,
                        Err(error) => {
                            reveal_shell_error(&app, error_payload(error));
                            continue;
                        }
                    };
                let mut reconcile_failed = false;
                for game_window in game_windows
                    .iter()
                    .filter(|game_window| !available_ids.contains(&game_window.target_display.id))
                {
                    let result = resolve_game_window_launch_target(&app, game_window).and_then(
                        |resolution| {
                            let Some(remap) = resolution.remap else {
                                return Ok(());
                            };
                            let target = resolution.target;
                            relocate_before_display_remap(
                                || {
                                    state
                                        .runtime
                                        .relocate_game_window_if_live(target.clone())
                                        .map(|_| ())
                                        .map_err(|error| {
                                            shell_error("TAURI_RUNTIME_WINDOW_MOVE_FAILED", error)
                                        })
                                },
                                || {
                                    persist_game_window_display_remap(
                                        &app,
                                        &state,
                                        &game_window.id,
                                        target.display_id,
                                        remap,
                                    )
                                },
                            )
                        },
                    );
                    if let Err(error) = result {
                        reveal_shell_error(&app, error);
                        reconcile_failed = true;
                    }
                }
                if reconcile_failed {
                    continue;
                }
                if let Err(error) = state.runtime.persist_restore_session(false) {
                    reveal_shell_error(&app, shell_error("TAURI_RESTORE_PERSIST_FAILED", error));
                    continue;
                }
                state.runtime.publish_projection();
                let _ = app.emit("rion://displays", &displays);
                previous = Some(displays);
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn embedded_runtime_state(state: &CoreState) -> Result<Value, CoreErrorPayload> {
    let snapshot = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let snapshot = serde_json::from_value(snapshot)
        .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))?;
    Ok(state.runtime.projection(&snapshot))
}

fn app_snapshot(state: &CoreState, window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
    let snapshot = state
        .core
        .invoke(CoreCommand::StateSnapshot)
        .map_err(error_payload)?;
    let role_statuses = state
        .core
        .invoke(CoreCommand::BrowserStatuses)
        .map_err(error_payload)?;
    let macro_statuses = state
        .core
        .invoke(CoreCommand::MacroStatuses)
        .map_err(error_payload)?;
    Ok(json!({
        "embeddedRuntimeState": embedded_runtime_state(state)?,
        "games": snapshot["games"].clone(),
        "gameWindows": snapshot["gameWindows"].clone(),
        "roles": snapshot["roles"].clone(),
        "roleStatuses": role_statuses,
        "launchWorkspaces": snapshot["launchWorkspaces"].clone(),
        "displays": display_inventory(window)?,
        "macros": snapshot["macros"].clone(),
        "macroStatuses": macro_statuses
    }))
}
