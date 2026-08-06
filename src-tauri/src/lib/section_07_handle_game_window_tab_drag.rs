pub(crate) async fn handle_game_window_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    source_window_id: &str,
    action: &Value,
) -> Result<Option<Value>, CoreErrorPayload> {
    let deferred_native_commit =
        tab_drag_defers_native_mutations(cfg!(windows), cfg!(target_os = "macos"));
    let Some(action_type) = action["type"].as_str() else {
        return Ok(None);
    };
    if !matches!(
        action_type,
        "tabDragStart"
            | "tabDragMove"
            | "tabDragHover"
            | "tabDragDrop"
            | "tabDragEnd"
            | "tabDragSourceEnd"
            | "tabDragCancel"
    ) {
        return Ok(None);
    }
    let session_id = action["sessionId"]
        .as_str()
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                "Runtime tab drag session ID is invalid.",
            )
        })?;
    let event_sequence = action["eventSequence"].as_u64().unwrap_or_default();
    let intent_generation = action["intentGeneration"].as_u64().unwrap_or_default();
    let action_point = matches!(
        action_type,
        "tabDragMove" | "tabDragHover" | "tabDragDrop" | "tabDragEnd" | "tabDragSourceEnd"
    )
    .then(|| {
        drag_screen_point(
            app,
            action,
            matches!(action_type, "tabDragEnd" | "tabDragSourceEnd"),
        )
    })
    .transpose()?;
    let hover_ordered_tab_ids = if action_type == "tabDragHover" {
        let target_window_id = action["windowId"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                shell_error(
                    "TAURI_TAB_DRAG_INVALID",
                    "Hover target window ID is required.",
                )
            })?;
        let ordered_tab_ids = drag_drop_ordered_tab_ids(action)?;
        #[cfg(target_os = "macos")]
        let _ = target_window_id;
        #[cfg(not(target_os = "macos"))]
        {
            if deferred_native_commit {
                let source_window_id = state
                    .tab_drag
                    .lock()
                    .map_err(|_| {
                        shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                    })?
                    .as_ref()
                    .filter(|session| session.id == session_id)
                    .map(|session| session.source_window_id.clone())
                    .ok_or_else(|| {
                        shell_error(
                            "TAURI_TAB_DRAG_STALE",
                            "The Windows HTML tab drag session is no longer active.",
                        )
                    })?;
                if !windows_html_tab_drag_target_is_local(
                    &source_window_id,
                    target_window_id,
                ) {
                    return Err(shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Windows HTML tabs cannot be dragged between windows.",
                    ));
                }
            }
            if let Err(error) = state
                .runtime
                .commit_live_tab_order_intent(target_window_id, &ordered_tab_ids)
            {
                eprintln!(
                    "Live HTML tab order intent was retired: window={target_window_id} error={error}"
                );
            }
        }
        Some(ordered_tab_ids)
    } else {
        None
    };
    let _lane = if matches!(action_type, "tabDragMove" | "tabDragHover") {
        match state.tab_drag_lane.try_lock() {
            Ok(lane) => lane,
            Err(_) => {
                if let Some((screen_x, screen_y)) = action_point {
                    record_latest_tab_drag_point(state, session_id, screen_x, screen_y)?;
                }
                return active_tab_drag_response(app, state, session_id).map(Some);
            }
        }
    } else {
        state.tab_drag_lane.lock().await
    };
    if action_type != "tabDragStart"
        && let Some(terminal) = tab_drag_terminal(state, session_id)?
    {
        return serialize_tab_drag_response(&terminal.receipt).map(Some);
    }
    if action_type != "tabDragStart"
        && intent_generation > 0
        && !state
            .runtime
            .tab_drag_intent_is_latest(session_id, intent_generation)
    {
        let active_session = state
            .tab_drag
            .lock()
            .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
            .as_ref()
            .filter(|session| session.id == session_id)
            .cloned();
        if let Some(active_session) = active_session
            && superseded_tab_drag_terminal_action(action_type)
        {
            let destination = match action_type {
                "tabDragDrop" => action["windowId"].as_str(),
                "tabDragEnd" if active_session.single_tab => {
                    Some(active_session.source_window_id.as_str())
                }
                _ => None,
            };
            let retains_durable_fallback = destination.is_some_and(|window_id| {
                state.runtime.newer_tab_drag_intent_started_in(
                    session_id,
                    intent_generation,
                    window_id,
                )
            });
            if !retains_durable_fallback {
                return finish_superseded_tab_drag(app, state, session_id).map(Some);
            }
        } else {
            return Ok(Some(superseded_tab_drag_response(
                session_id,
                event_sequence,
                intent_generation,
            )));
        }
    }
    if action_type != "tabDragStart"
        && event_sequence > 0
        && !accept_ordered_tab_drag_event(state, session_id, intent_generation, event_sequence)?
    {
        return Ok(Some(json!({
            "eventSequence": event_sequence,
            "intentGeneration": intent_generation,
            "sessionId": session_id,
            "status": "superseded",
        })));
    }
    if let Some((screen_x, screen_y)) = action_point {
        record_latest_tab_drag_point(state, session_id, screen_x, screen_y)?;
    }

    match action_type {
        "tabDragStart" => {
            if let Some(terminal) = tab_drag_terminal(state, session_id)? {
                return serialize_tab_drag_response(&terminal.receipt).map(Some);
            }
            if state
                .tab_drag
                .lock()
                .map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?
                .as_ref()
                .is_some_and(|session| session.id == session_id)
            {
                return active_tab_drag_response(app, state, session_id).map(Some);
            }
            #[cfg(target_os = "macos")]
            if let Some(abandoned_session_id) = active_tab_drag_session_id(state)? {
                // A new native NSDraggingSession proves the previous one has
                // ended even if AppKit omitted its terminal callback. Held
                // gestures are AppKit-local, so cancellation only retires the
                // old intent and visual suppression.
                if let Some(abandoned) = take_tab_drag_session(state, &abandoned_session_id)? {
                    let _ = finish_cancelled_tab_drag(app, state, abandoned)?;
                }
            }
            #[cfg(not(target_os = "macos"))]
            if active_tab_drag_session_id(state)?.is_some() {
                return Err(shell_error(
                    "TAURI_TAB_DRAG_BUSY",
                    "Another runtime tab drag is already active.",
                ));
            }
            let tab_id = action["tabId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_INVALID", "Runtime tab ID is required.")
                })?;
            let (screen_x, screen_y) = drag_screen_point(app, action, false)?;
            let title = match state
                .runtime
                .tab_drag_source_title(source_window_id, tab_id)
            {
                Ok(title) => title,
                Err(message) => {
                    eprintln!(
                        "Late AppKit tab drag start was retired: tab={tab_id} window={source_window_id} error={message}"
                    );
                    return Ok(Some(superseded_tab_drag_response(
                        session_id,
                        event_sequence,
                        intent_generation,
                    )));
                }
            };
            let grab_ratio_x = drag_fraction(action, "grabRatioX")?;
            let grab_ratio_y = drag_fraction(action, "grabRatioY")?;
            let tab_width = drag_dimension(action, "tabWidth")?;
            let tab_height = drag_dimension(action, "tabHeight")?;
            let source = state
                .runtime
                .launch_target_for_window_id(source_window_id)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_INVALID", message))?;
            let single_tab = state.runtime.window_tab_count(source_window_id) == 1;
            let provisional_window_id = if deferred_native_commit || single_tab {
                source_window_id.to_owned()
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            let initial_anchor = state.runtime.tab_drag_window_anchor(
                source_window_id,
                tab_id,
                grab_ratio_x,
                grab_ratio_y,
                tab_width,
                tab_height,
            );
            let target = tab_drag_target_for_screen(
                app,
                &source,
                &provisional_window_id,
                screen_x,
                screen_y,
                initial_anchor.unwrap_or((tab_width * grab_ratio_x, tab_height * grab_ratio_y)),
            )?;
            let lifecycle_epoch = state.runtime.lifecycle_epoch();
            let operation = state
                .runtime
                .accept_tab_drag_operation(
                    session_id,
                    source_window_id,
                    tab_id,
                    lifecycle_epoch,
                )
                .map_err(|error| shell_error(error.code, error.message))?;
            {
                let mut active_drag = state.tab_drag.lock().map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?;
                *active_drag = Some(GameWindowTabDragSession {
                    accepted_at: operation.accepted_at,
                    current_window_id: source_window_id.to_owned(),
                    drop_before_tab_id: None,
                    drop_ordered_tab_ids: None,
                    drop_window_id: None,
                    grab_ratio_x,
                    grab_ratio_y,
                    hover_window_id: None,
                    id: session_id.to_owned(),
                    intent_generation,
                    last_event_sequence: event_sequence,
                    latest_move_revision: 0,
                    latest_screen_x: screen_x,
                    latest_screen_y: screen_y,
                    operation_id: operation.operation_id.clone(),
                    original_target: source.clone(),
                    phase: if deferred_native_commit {
                        GameWindowTabDragPhase::Previewing
                    } else {
                        GameWindowTabDragPhase::Attached
                    },
                    processed_move_revision: 0,
                    provisional_window_id: provisional_window_id.clone(),
                    single_tab,
                    source_window_id: source_window_id.to_owned(),
                    source_cancelled: false,
                    source_drop_accepted: false,
                    source_end_received: false,
                    tab_height,
                    tab_id: tab_id.to_owned(),
                    tab_width,
                    target: target.clone(),
                    lifecycle_epoch,
                    window_anchor: initial_anchor,
                    window_was_moved: false,
                });
                if let Some(session) = active_drag.as_ref() {
                    record_tab_drag_lifecycle(
                        state,
                        session,
                        "tab.drag-started",
                        "The runtime tab drag reached Rust and created its native session.",
                    );
                }
            }
            if !deferred_native_commit {
                state.runtime.begin_tab_drag_window_motion(source_window_id);
                if provisional_window_id != source_window_id {
                    state
                        .runtime
                        .begin_tab_drag_window_motion(&provisional_window_id);
                }
            }
            if !deferred_native_commit
                && !state
                    .runtime
                    .mark_tab_drag_native_submitted(&operation.operation_id)
            {
                return finish_failed_tab_drag(
                    app,
                    state,
                    session_id,
                    shell_error(
                        "SYSTEM_TAB_DRAG_OPERATION_EXPIRED",
                        "The tab drag expired before native preview started.",
                    ),
                )
                .map(Some);
            }
            if !deferred_native_commit
                && let Err(message) = state.runtime.preview_tab_drag_activation(tab_id)
            {
                return finish_failed_tab_drag(
                    app,
                    state,
                    session_id,
                    shell_error("TAURI_TAB_DRAG_FAILED", message),
                )
                .map(Some);
            }
            if !deferred_native_commit
                && !single_tab
                && let Err(message) = state
                    .runtime
                    .prepare_provisional_game_window(&target, &title)
            {
                return finish_failed_tab_drag(
                    app,
                    state,
                    session_id,
                    shell_error("TAURI_TAB_DRAG_FAILED", message),
                )
                .map(Some);
            }
        }
        "tabDragMove" => {
            if !deferred_native_commit
                && let Err(error) =
                    process_tab_drag_motion(app, state, session_id, None, None, None)
            {
                return finish_failed_tab_drag(app, state, session_id, error).map(Some);
            }
        }
        "tabDragHover" => {
            let target_window_id = action["windowId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Hover target window ID is required.",
                    )
                })?;
            update_tab_drag_dimensions(
                state,
                session_id,
                drag_dimension(action, "tabWidth")?,
                drag_dimension(action, "tabHeight")?,
            )?;
            if !deferred_native_commit
                && let Err(error) = process_tab_drag_motion(
                    app,
                    state,
                    session_id,
                    Some(target_window_id),
                    action["beforeTabId"].as_str(),
                    hover_ordered_tab_ids.as_deref(),
                )
            {
                return finish_failed_tab_drag(app, state, session_id, error).map(Some);
            }
        }
        "tabDragDrop" => {
            let target_window_id = action["windowId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Drop target window ID is required.",
                    )
                })?;
            if deferred_native_commit {
                let ordered_tab_ids = drag_drop_ordered_tab_ids(action)?;
                let ready = match record_deferred_tab_drag_drop_intent(
                    state,
                    session_id,
                    target_window_id,
                    action["beforeTabId"].as_str(),
                    ordered_tab_ids,
                ) {
                    Ok(ready) => ready,
                    Err(error) => {
                        return finish_failed_tab_drag(app, state, session_id, error).map(Some);
                    }
                };
                if ready || cfg!(target_os = "macos") {
                    return finish_deferred_tab_drag_session(app, state, session_id)
                        .await
                        .map(Some);
                }
            } else {
                let ordered_tab_ids = drag_drop_ordered_tab_ids(action)?;
                if let Err(error) = process_tab_drag_motion(
                    app,
                    state,
                    session_id,
                    Some(target_window_id),
                    action["beforeTabId"].as_str(),
                    Some(&ordered_tab_ids),
                ) {
                    return finish_failed_tab_drag(app, state, session_id, error).map(Some);
                }
                let Some(mut session) = take_tab_drag_session(state, session_id)? else {
                    return active_tab_drag_response(app, state, session_id).map(Some);
                };
                session.phase = GameWindowTabDragPhase::Finishing;
                if let Some(error) = tab_drag_fence_error(state, &session) {
                    return finish_failed_tab_drag_session(app, state, &mut session, error)
                        .map(Some);
                }
                return finish_visible_tab_drag(app, state, &session)
                    .map(Some);
            }
        }
        "tabDragEnd" => {
            let cancelled = action["cancelled"].as_bool().unwrap_or(false);
            if deferred_native_commit {
                record_deferred_tab_drag_source_end(state, session_id, cancelled, false)?;
                return finish_deferred_tab_drag_session(app, state, session_id)
                    .await
                    .map(Some);
            } else {
                if !cancelled
                    && let Err(error) =
                        process_tab_drag_motion(app, state, session_id, None, None, None)
                {
                    return finish_failed_tab_drag(app, state, session_id, error).map(Some);
                }
                let Some(mut session) = take_tab_drag_session(state, session_id)? else {
                    return active_tab_drag_response(app, state, session_id).map(Some);
                };
                if cancelled {
                    return finish_cancelled_tab_drag(app, state, session).map(Some);
                } else {
                    session.phase = GameWindowTabDragPhase::Finishing;
                    if let Some(error) = tab_drag_fence_error(state, &session) {
                        return finish_failed_tab_drag_session(app, state, &mut session, error)
                            .map(Some);
                    }
                    return finish_visible_tab_drag(app, state, &session)
                        .map(Some);
                }
            }
        }
        "tabDragSourceEnd" => {
            if !deferred_native_commit {
                return Err(shell_error(
                    "TAURI_TAB_DRAG_INVALID",
                    "The source-end drag action is only valid for WebView2.",
                ));
            }
            let cancelled = action["cancelled"].as_bool().ok_or_else(|| {
                shell_error(
                    "TAURI_TAB_DRAG_INVALID",
                    "Drag cancellation state is invalid.",
                )
            })?;
            let drop_accepted = action["dropAccepted"].as_bool().ok_or_else(|| {
                shell_error("TAURI_TAB_DRAG_INVALID", "Drag drop state is invalid.")
            })?;
            let ready =
                record_deferred_tab_drag_source_end(state, session_id, cancelled, drop_accepted)?;
            if ready {
                return finish_deferred_tab_drag_session(app, state, session_id)
                    .await
                    .map(Some);
            } else {
                schedule_windows_tab_drag_intent_timeout(app, session_id);
            }
        }
        "tabDragCancel" => {
            let Some(session) = take_tab_drag_session(state, session_id)? else {
                return active_tab_drag_response(app, state, session_id).map(Some);
            };
            return finish_cancelled_tab_drag(app, state, session).map(Some);
        }
        _ => unreachable!(),
    }
    active_tab_drag_response(app, state, session_id).map(Some)
}

fn drag_fraction(action: &Value, field: &str) -> Result<f64, CoreErrorPayload> {
    action[field]
        .as_f64()
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                format!("Drag {field} is invalid."),
            )
        })
}

fn drag_dimension(action: &Value, field: &str) -> Result<f64, CoreErrorPayload> {
    action[field]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                format!("Drag {field} is invalid."),
            )
        })
}

fn drag_screen_point(
    app: &AppHandle,
    action: &Value,
    allow_native_cursor: bool,
) -> Result<(f64, f64), CoreErrorPayload> {
    let screen_x = action["screenX"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen X is invalid."))?;
    let screen_y = action["screenY"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen Y is invalid."))?;
    if cfg!(windows) && allow_native_cursor {
        app.cursor_position()
            .map(|point| (point.x, point.y))
            .map_err(|error| shell_error("TAURI_TAB_DRAG_FAILED", error.to_string()))
    } else {
        Ok((screen_x, screen_y))
    }
}

fn take_tab_drag_session(
    state: &CoreState,
    session_id: &str,
) -> Result<Option<GameWindowTabDragSession>, CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if current
        .as_ref()
        .is_none_or(|session| session.id != session_id)
    {
        return Ok(None);
    }
    Ok(current.take())
}
