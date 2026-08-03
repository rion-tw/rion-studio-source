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
        state
            .runtime
            .focus_selected_overlay_webview(&webview, &role_id)
            .map_err(|error| shell_error(error.code, error.message))?;
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
) -> Result<Value, CoreErrorPayload> {
    let window_id = state
        .runtime
        .tab_strip_window_for_webview(webview.label())
        .ok_or_else(|| {
            shell_error(
                "TAURI_RUNTIME_CHROME_UNAUTHORIZED",
                "Runtime tab actions are restricted to the local tab-strip WebView.",
            )
        })?;
    #[cfg(windows)]
    if action.get("type").and_then(Value::as_str) == Some("tabChromeReady") {
        let ready = action
            .get("ready")
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_CHROME_READY_INVALID",
                    "The runtime tab chrome ready identity is required.",
                )
            })
            .and_then(|value| {
                serde_json::from_value::<rion_core::RuntimeTabChromeReadyRecord>(value)
                    .map_err(|error| {
                        shell_error("TAURI_RUNTIME_CHROME_READY_INVALID", error.to_string())
                    })
            })?;
        state
            .runtime
            .register_tab_chrome_renderer(webview.label(), ready)
            .map_err(|message| shell_error("TAURI_RUNTIME_CHROME_READY_INVALID", message))?;
        return Ok(Value::Null);
    }
    #[cfg(windows)]
    if action.get("type").and_then(Value::as_str) == Some("tabChromeProjectionApplied") {
        let acknowledgement = action
            .get("acknowledgement")
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_CHROME_PROJECTION_ACK_INVALID",
                    "The runtime tab chrome projection acknowledgement is required.",
                )
            })
            .and_then(|value| {
                serde_json::from_value::<rion_core::RuntimeTabChromeAcknowledgementRecord>(value)
                    .map_err(|error| {
                        shell_error(
                            "TAURI_RUNTIME_CHROME_PROJECTION_ACK_INVALID",
                            error.to_string(),
                        )
                    })
            })?;
        state
            .runtime
            .acknowledge_tab_chrome_projection(webview.label(), acknowledgement)
            .map_err(|message| {
                shell_error("TAURI_RUNTIME_CHROME_PROJECTION_ACK_INVALID", message)
            })?;
        return Ok(Value::Null);
    }
    #[cfg(windows)]
    if action.get("type").and_then(Value::as_str) == Some("tabActivationApplied") {
        let acknowledgement = action
            .get("acknowledgement")
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTIVATION_ACK_INVALID",
                    "The tab activation acknowledgement is required.",
                )
            })
            .and_then(|value| {
                serde_json::from_value::<rion_core::RuntimeTabActivationAcknowledgementRecord>(
                    value,
                )
                .map_err(|error| {
                    shell_error(
                        "TAURI_RUNTIME_TAB_ACTIVATION_ACK_INVALID",
                        error.to_string(),
                    )
                })
            })?;
        state
            .runtime
            .acknowledge_tab_activation_presentation(webview.label(), acknowledgement)
            .map_err(|message| {
                shell_error("TAURI_RUNTIME_TAB_ACTIVATION_ACK_INVALID", message)
            })?;
        return Ok(Value::Null);
    }
    #[cfg(windows)]
    if action.get("type").and_then(Value::as_str) == Some("presentationApplied") {
        let revision = action
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_CHROME_ACK_INVALID",
                    "The runtime tab chrome acknowledgement revision is invalid.",
                )
            })?;
        state
            .runtime
            .acknowledge_tab_chrome_presentation(webview.label(), revision)
            .map_err(|message| shell_error("TAURI_RUNTIME_CHROME_ACK_INVALID", message))?;
        return Ok(Value::Null);
    }
    match handle_game_window_tab_drag(&app, &state, &window_id, &action).await {
        Ok(Some(response)) => return Ok(response),
        Ok(None) => {}
        Err(error) => {
            reveal_shell_error(
                &app,
                CoreErrorPayload {
                    code: error.code.clone(),
                    message: error.message.clone(),
                },
            );
            return Err(error);
        }
    }
    if action.get("type").and_then(Value::as_str) == Some("activate") {
        let tab_id = action
            .get("tabId")
            .and_then(Value::as_str)
            .filter(|tab_id| !tab_id.is_empty())
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime tab ID is required",
                )
            })?;
        let receipt = preview_and_commit_tab_selection(&app, &state, tab_id)
            .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))?;
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    if action.get("type").and_then(Value::as_str) == Some("activateAdjacent") {
        let direction = action
            .get("direction")
            .and_then(Value::as_str)
            .filter(|direction| matches!(*direction, "next" | "previous"))
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime tab direction is invalid",
                )
            })?;
        let receipt = preview_and_commit_adjacent_tab_selection(
            &app,
            &state,
            &window_id,
            direction,
        )
        .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))?;
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    if action.get("type").and_then(Value::as_str) == Some("windowControl") {
        let control = action
            .get("control")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime window control is required",
                )
            })?;
        let receipt = match control {
            "minimize" => state.runtime.minimize_runtime_window(&window_id),
            "toggleFullscreen" => state.runtime.toggle_runtime_window_fullscreen(&window_id),
            "zoom" => state.runtime.toggle_runtime_window_maximized(&window_id),
            _ => {
                return runtime_tab_menu::handle_scoped_action(
                    &app,
                    &state,
                    window_id,
                    action,
                )
                .await
                .map(|_| Value::Null)
                .map_err(|message| {
                    shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message)
                });
            }
        }
        .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message))?;
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    match runtime_tab_menu::handle_scoped_action(&app, &state, window_id, action).await {
        Ok(()) => Ok(Value::Null),
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
        "displayTopology": display_topology(state, window, "snapshot")?,
        "macros": snapshot["macros"].clone(),
        "macroStatuses": macro_statuses
    }))
}
