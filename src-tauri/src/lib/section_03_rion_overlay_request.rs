#[tauri::command]
async fn rion_overlay_request(
    app: AppHandle,
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
    if payload.get("type").and_then(Value::as_str) == Some("runtime-tab-shortcut") {
        let payload_object = payload.as_object().ok_or_else(|| {
            shell_error(
                "OVERLAY_REQUEST_INVALID",
                "The runtime tab shortcut payload must be an object.",
            )
        })?;
        if payload_object.len() != 3 {
            return Err(shell_error(
                "OVERLAY_REQUEST_INVALID",
                "The runtime tab shortcut payload contains unsupported fields.",
            ));
        }
        let direction = payload
            .get("direction")
            .and_then(Value::as_str)
            .filter(|direction| matches!(*direction, "next" | "previous"))
            .ok_or_else(|| {
                shell_error(
                    "OVERLAY_REQUEST_INVALID",
                    "The runtime tab shortcut direction is invalid.",
                )
            })?;
        let modifier_codes = payload
            .get("modifierCodes")
            .and_then(Value::as_array)
            .filter(|codes| !codes.is_empty() && codes.len() <= 4)
            .and_then(|codes| {
                let mut parsed = Vec::with_capacity(codes.len());
                for code in codes {
                    let code = code.as_str()?;
                    if !matches!(code, "ControlLeft" | "ControlRight" | "ShiftLeft" | "ShiftRight")
                        || parsed.iter().any(|existing| existing == code)
                    {
                        return None;
                    }
                    parsed.push(code.to_owned());
                }
                Some(parsed)
            })
            .filter(|codes| codes.iter().any(|code| code.starts_with("Control")))
            .filter(|codes| {
                let shift = codes.iter().any(|code| code.starts_with("Shift"));
                (direction == "previous") == shift
            })
            .ok_or_else(|| {
                shell_error(
                    "OVERLAY_REQUEST_INVALID",
                    "The runtime tab shortcut modifiers are invalid.",
                )
            })?;
        if !state
            .runtime
            .overlay_webview_is_selected(webview.label(), &role_id)
            .map_err(|message| shell_error("OVERLAY_WEBVIEW_FOCUS_STATE_FAILED", message))?
        {
            return Err(shell_error(
                "OVERLAY_REQUEST_UNAUTHORIZED",
                "Runtime tab shortcuts are restricted to the selected role WebView.",
            ));
        }
        #[cfg(windows)]
        system_runtime::defer_runtime_tab_shortcut(
            app.clone(),
            webview.label().to_owned(),
            direction.to_owned(),
            modifier_codes,
        );
        #[cfg(not(windows))]
        {
            let window_id = state
                .runtime
                .window_id_for_webview(webview.label())
                .ok_or_else(|| {
                    shell_error(
                        "OVERLAY_REQUEST_UNAUTHORIZED",
                        "The overlay WebView is no longer attached to a runtime window.",
                    )
                })?;
            activate_adjacent_runtime_tab_on_demand(&app, &state, &window_id, direction).await?;
            let _ = modifier_codes;
        }
        return Ok(Value::Null);
    }
    if payload.get("type").and_then(Value::as_str) == Some("coordinate-context") {
        serde_json::from_value::<rion_core::MacroOverlayRequestRecord>(payload)
            .map_err(|error| shell_error("OVERLAY_REQUEST_INVALID", error.to_string()))?;
        let context = state
            .runtime
            .overlay_coordinate_context(&webview, &role_id)
            .map_err(|error| shell_error(error.code, error.message))?;
        return serde_json::to_value(context)
            .map_err(|error| shell_error("OVERLAY_REQUEST_INVALID", error.to_string()));
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
fn rion_macro_key_event_observed(
    webview: Webview,
    state: State<'_, CoreState>,
    capability: String,
    observation: system_runtime::MacroKeyEventObservation,
) -> Result<(), CoreErrorPayload> {
    let role_id = state
        .runtime
        .authorize_overlay_request(webview.label(), &capability)
        .map_err(|message| shell_error("MACRO_KEY_OBSERVATION_UNAUTHORIZED", message))?;
    state
        .runtime
        .observe_macro_key_event(webview.label(), &role_id, observation)
        .map_err(|error| shell_error(error.code, error.message))
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
async fn rion_runtime_role_slot_action(
    webview: Webview,
    state: State<'_, CoreState>,
    action: system_runtime::RuntimeRolePlaceholderIdentity,
) -> Result<Value, CoreErrorPayload> {
    state
        .runtime
        .authorize_role_placeholder_action(webview.label(), &action)
        .map_err(|error| shell_error(error.code, error.message))?;
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::BrowserRoleSlotClaim {
            tab_id: action.tab_id,
            slot_id: action.slot_id,
            expected_owner_generation: action.owner_generation,
        })
        .await
        .map_err(error_payload)
}

#[tauri::command]
fn rion_runtime_role_slot_ready(
    webview: Webview,
    state: State<'_, CoreState>,
    action: system_runtime::RuntimeRolePlaceholderIdentity,
) -> Result<(), CoreErrorPayload> {
    state
        .runtime
        .authorize_role_placeholder_action(webview.label(), &action)
        .map_err(|error| shell_error(error.code, error.message))?;
    #[cfg(feature = "desktop-e2e")]
    {
        let window_id = state
            .runtime
            .live_tab_window_id(&action.tab_id)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_ROLE_SLOT_READY_STALE",
                    "The role placeholder no longer belongs to a live window.",
                )
            })?;
        desktop_e2e::record_event(
            &format!(
                "role-placeholder-ready:{}:{}",
                action.tab_id, action.role_id
            ),
            Some(&window_id),
            None,
            None,
            json!({
                "roleId": action.role_id,
                "slotId": action.slot_id,
                "tabId": action.tab_id,
            }),
        );
    }
    Ok(())
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
    let action_type = action.get("type").and_then(Value::as_str);
    let tab_strip_window_id = state
        .runtime
        .tab_strip_window_for_webview(webview.label());
    let tab_status_window_id = state
        .runtime
        .tab_status_window_for_webview(webview.label());
    let window_id = if action_type == Some("retryFailed") {
        tab_status_window_id
    } else {
        tab_strip_window_id
    }
    .ok_or_else(|| {
        shell_error(
            "TAURI_RUNTIME_CHROME_UNAUTHORIZED",
            "Runtime tab actions are restricted to the matching local chrome WebView.",
        )
    })?;
    if action_type == Some("retryFailed") {
        let identity = action
            .get("identity")
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_STATUS_INVALID",
                    "The runtime tab failure status identity is required.",
                )
            })
            .and_then(|value| {
                serde_json::from_value::<rion_core::RuntimeTabStatusIdentityRecord>(value)
                    .map_err(|error| {
                        shell_error("TAURI_RUNTIME_TAB_STATUS_INVALID", error.to_string())
                    })
            })?;
        state
            .runtime
            .hide_runtime_tab_status(&window_id);
        if identity.window_id != window_id
            || !state
                .runtime
                .failed_tab_status_identity_is_current(&identity)
        {
            state.runtime.publish_projection();
            return Ok(serde_json::json!({ "status": "superseded" }));
        }
        let receipt =
            activate_runtime_tab_on_demand(&app, &state, &identity.tab_id, false).await?;
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
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
    let is_tab_drag = action
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|action_type| action_type.starts_with("tabDrag"));
    match handle_game_window_tab_drag(&app, &state, &window_id, &action).await {
        Ok(Some(response)) => return Ok(response),
        Ok(None) => {}
        Err(error) => {
            if is_tab_drag {
                eprintln!(
                    "Runtime tab drag follower will reconcile from live HTML state: code={} message={}",
                    error.code, error.message
                );
                return Ok(serde_json::json!({ "status": "superseded" }));
            }
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
        let result = if state.runtime.live_tab_window_id(tab_id).as_deref()
            != Some(window_id.as_str())
        {
            state.runtime.publish_projection();
            Ok(state.runtime.superseded_tab_activation_summary(tab_id))
        } else {
            activate_runtime_tab_on_demand(&app, &state, tab_id, false).await
        };
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "runtime-tab-activation-terminal",
            Some(&window_id),
            None,
            None,
            runtime_tab_activation_terminal_details(
                tab_id,
                result.as_ref().err().map(|error| error.message.as_str()),
            ),
        );
        let receipt = result?;
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
        let receipt =
            activate_adjacent_runtime_tab_on_demand(&app, &state, &window_id, direction).await?;
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    if action.get("type").and_then(Value::as_str) == Some("stop") {
        #[cfg(windows)]
        let intent = action
            .get("intent")
            .cloned()
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_INTENT_INVALID",
                    "The typed runtime tab intent is required.",
                )
            })
            .and_then(|value| {
                serde_json::from_value::<rion_core::RuntimeTabIntentRecord>(value).map_err(|error| {
                    shell_error("TAURI_RUNTIME_TAB_INTENT_INVALID", error.to_string())
                })
            })?;
        #[cfg(windows)]
        let (intent_window_generation, intent_window_id) =
            match state
                .runtime
                .admit_runtime_tab_intent(webview.label(), &intent)
                .map_err(|message| shell_error("TAURI_RUNTIME_TAB_INTENT_FAILED", message))?
            {
                system_runtime::RuntimeTabIntentAdmission::Accepted {
                    window_generation,
                    window_id,
                } => (window_generation, window_id),
                system_runtime::RuntimeTabIntentAdmission::Superseded {
                    failure_code,
                    window_generation,
                    window_id: _,
                } => {
                    state.runtime.publish_projection();
                    let receipt = rion_core::RuntimeTabIntentReceiptRecord {
                        intent_id: intent.intent_id,
                        status: rion_core::SystemRuntimeOperationStatus::Superseded,
                        topology_committed: false,
                        window_generation,
                        topology_revision: state.runtime.live_topology_revision(),
                        cleanup_operation_id: None,
                        failure_code: Some(failure_code.to_owned()),
                    };
                    return serde_json::to_value(receipt).map_err(|error| {
                        shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
                    });
                }
            };
        #[cfg(windows)]
        let tab_id = intent.tab_id.as_str();
        #[cfg(not(windows))]
        let tab_id = action["tabId"]
            .as_str()
            .filter(|tab_id| !tab_id.is_empty())
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime tab ID is required",
                )
            })?;
        let receipt = execute_tab_stop(&app, &state, tab_id).await?;
        #[cfg(windows)]
        {
            let intent_receipt = rion_core::RuntimeTabIntentReceiptRecord {
                intent_id: intent.intent_id,
                status: receipt.status,
                topology_committed: state.runtime.live_tab_window_id(tab_id).is_none(),
                window_generation: intent_window_generation,
                topology_revision: receipt
                    .topology_revision
                    .unwrap_or_else(|| state.runtime.live_topology_revision()),
                cleanup_operation_id: Some(receipt.operation_id),
                failure_code: receipt.failure_code,
            };
            debug_assert_eq!(intent_window_id, window_id);
            return serde_json::to_value(intent_receipt).map_err(|error| {
                shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
            });
        }
        #[cfg(not(windows))]
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    if matches!(
        action.get("type").and_then(Value::as_str),
        Some("hide" | "move" | "reorder")
    ) {
        let action_type = action["type"].as_str().unwrap_or_default();
        let tab_id = action["tabId"]
            .as_str()
            .filter(|tab_id| !tab_id.is_empty())
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime tab ID is required",
                )
            })?;
        let Some(live_window_id) = state.runtime.live_tab_window_id(tab_id) else {
            let receipt = state
                .runtime
                .superseded_tab_mutation_summary(action_type, tab_id);
            return serde_json::to_value(receipt).map_err(|error| {
                shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
            });
        };
        if live_window_id != window_id {
            return Err(shell_error(
                "TAURI_RUNTIME_TAB_ACTION_FAILED",
                "runtime tab is outside this tab-strip WebView's window",
            ));
        }
        let before_tab_id = action
            .get("beforeTabId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(before) = before_tab_id.as_deref()
            && state.runtime.live_tab_window_id(before).as_deref() != Some(window_id.as_str())
        {
            return Err(shell_error(
                "TAURI_RUNTIME_TAB_ACTION_FAILED",
                "reorder target is outside this tab-strip WebView's window",
            ));
        }
        let target = if action_type == "move" {
            let target_window_id = action["windowId"].as_str().ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "target window ID is required",
                )
            })?;
            Some(
                state
                    .runtime
                    .launcher_context_for_window_id(target_window_id)
                    .map_err(|message| {
                        shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message)
                    })?
                    .1,
            )
        } else {
            None
        };
        let receipt = execute_tab_mutation(
            &state,
            action_type,
            tab_id,
            target,
            before_tab_id,
        )
        .await?;
        record_runtime_operation_terminal(&receipt);
        return serde_json::to_value(receipt).map_err(|error| {
            shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string())
        });
    }
    if action.get("type").and_then(Value::as_str) == Some("windowControl") {
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "runtime-tab-window-control-received",
            Some(&window_id),
            None,
            None,
            serde_json::json!({
                "control": action.get("control"),
                "webviewLabel": webview.label(),
            }),
        );
        let control = action
            .get("control")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                shell_error(
                    "TAURI_RUNTIME_TAB_ACTION_FAILED",
                    "runtime window control is required",
                )
            })?;
        if !matches!(control, "minimize" | "toggleFullscreen" | "zoom") {
            return runtime_tab_menu::handle_scoped_action(
                &app,
                &state,
                window_id,
                action,
            )
            .await
            .map(|_| Value::Null)
            .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", message));
        }
        #[cfg(windows)]
        let receipt = {
            let runtime = Arc::clone(&state.runtime);
            let window_id = window_id.clone();
            let control = control.to_owned();
            tauri::async_runtime::spawn_blocking(move || match control.as_str() {
                "minimize" => runtime.minimize_runtime_window(&window_id),
                "toggleFullscreen" => runtime.toggle_runtime_window_fullscreen(&window_id),
                "zoom" => runtime.toggle_runtime_window_maximized(&window_id),
                _ => unreachable!("direct runtime window controls were validated before dispatch"),
            })
            .await
            .map_err(|error| shell_error("TAURI_RUNTIME_TAB_ACTION_FAILED", error.to_string()))?
        };
        #[cfg(not(windows))]
        let receipt = match control {
            "minimize" => state.runtime.minimize_runtime_window(&window_id),
            "toggleFullscreen" => state.runtime.toggle_runtime_window_fullscreen(&window_id),
            "zoom" => state.runtime.toggle_runtime_window_maximized(&window_id),
            _ => unreachable!("direct runtime window controls were validated before dispatch"),
        };
        let receipt = receipt
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
        .browser_runtime_snapshot()
        .map_err(error_payload)?;
    state.runtime.live_projection(snapshot).ok_or_else(|| {
        shell_error(
            "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
            "The live tab topology could not be read; the stale Core projection was ignored.",
        )
    })
}

fn app_snapshot(state: &CoreState, window: &WebviewWindow) -> Result<Value, CoreErrorPayload> {
    let snapshot = state
        .core
        .invoke(CoreCommand::AppSnapshot)
        .map_err(error_payload)?;
    let snapshot = serde_json::from_value::<rion_core::CoreAppSnapshotRecord>(snapshot)
        .map_err(|error| shell_error("CORE_INTERNAL_FAILED", error.to_string()))?;
    Ok(json!({
        "revision": snapshot.revision,
        "stateRevision": snapshot.state_revision,
        "runtimeRevision": snapshot.runtime_revision,
        "embeddedRuntimeState": state.runtime.projection(&snapshot.browser_runtime),
        "games": snapshot.state.games,
        "gameWindows": snapshot.state.game_windows,
        "roles": snapshot.state.roles,
        "roleStatuses": snapshot.role_statuses,
        "launchWorkspaces": snapshot.state.launch_workspaces,
        "displayTopology": display_topology(state, window, "snapshot")?,
        "macros": snapshot.state.macros,
        "macroStatuses": snapshot.macro_statuses
    }))
}
