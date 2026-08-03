pub(crate) async fn handle_game_window_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    source_window_id: &str,
    action: &Value,
) -> Result<Option<Value>, CoreErrorPayload> {
    let deferred_native_commit = tab_drag_defers_native_mutations(cfg!(windows));
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
    let action_point = matches!(
        action_type,
        "tabDragMove" | "tabDragHover" | "tabDragDrop" | "tabDragEnd"
            | "tabDragSourceEnd"
    )
    .then(|| {
        drag_screen_point(
            app,
            action,
            matches!(action_type, "tabDragEnd" | "tabDragSourceEnd"),
        )
    })
    .transpose()?;
    if let Some((screen_x, screen_y)) = action_point {
        record_latest_tab_drag_point(state, session_id, screen_x, screen_y)?;
    }
    let _lane = state.tab_drag_lane.lock().await;
    if action_type != "tabDragStart"
        && let Some(terminal) = tab_drag_terminal(state, session_id)?
    {
        return serialize_tab_drag_response(&terminal.receipt).map(Some);
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
            let tab_id = action["tabId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_INVALID", "Runtime tab ID is required.")
                })?;
            let (screen_x, screen_y) = drag_screen_point(app, action, false)?;
            let runtime = state
                .core
                .invoke(CoreCommand::BrowserRuntimeSnapshot)
                .map_err(error_payload)?;
            let tab = runtime["tabs"]
                .as_array()
                .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(tab_id)))
                .filter(|tab| tab["windowId"].as_str() == Some(source_window_id))
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Runtime tab is outside the source Game Window.",
                    )
                })?;
            let grab_ratio_x = drag_fraction(action, "grabRatioX")?;
            let grab_ratio_y = drag_fraction(action, "grabRatioY")?;
            let tab_width = drag_dimension(action, "tabWidth")?;
            let tab_height = drag_dimension(action, "tabHeight")?;
            let source = state
                .runtime
                .launch_target_for_window_id(source_window_id)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_INVALID", message))?;
            if state
                .tab_drag
                .lock()
                .map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?
                .is_some()
            {
                return Err(shell_error(
                    "TAURI_TAB_DRAG_BUSY",
                    "Another runtime tab drag is already active.",
                ));
            }
            let source_snapshot = state
                .runtime
                .tab_drag_window_snapshot(source_window_id)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
            let single_tab = state.runtime.window_tab_count(source_window_id) == 1;
            let provisional_window_id = if single_tab {
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
            let title = tab["name"].as_str().unwrap_or("Rion Studio").to_owned();
            let lifecycle_epoch = state.runtime.lifecycle_epoch();
            let topology_revision = state.display_topology.current_revision();
            let operation = state
                .runtime
                .accept_tab_drag_operation(
                    session_id,
                    source_window_id,
                    tab_id,
                    lifecycle_epoch,
                    topology_revision,
                )
                .map_err(|error| shell_error(error.code, error.message))?;
            let mut snapshots = HashMap::new();
            snapshots.insert(source_window_id.to_owned(), source_snapshot);
            {
                let mut active_drag = state.tab_drag.lock().map_err(|_| {
                    shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
                })?;
                *active_drag = Some(GameWindowTabDragSession {
                    accepted_at: operation.accepted_at,
                    current_window_id: source_window_id.to_owned(),
                    drop_before_tab_id: None,
                    drop_window_id: None,
                    grab_ratio_x,
                    grab_ratio_y,
                    id: session_id.to_owned(),
                    latest_move_revision: 0,
                    latest_screen_x: screen_x,
                    latest_screen_y: screen_y,
                    native_changes_applied: !deferred_native_commit,
                    operation_id: operation.operation_id.clone(),
                    original_target: source.clone(),
                    phase: if deferred_native_commit {
                        GameWindowTabDragPhase::Previewing
                    } else {
                        GameWindowTabDragPhase::Attached
                    },
                    processed_move_revision: 0,
                    provisional_window_id,
                    single_tab,
                    snapshots,
                    source_window_id: source_window_id.to_owned(),
                    source_window_generation: operation.window_generation,
                    source_cancelled: false,
                    source_drop_accepted: false,
                    source_end_received: false,
                    tab_height,
                    tab_id: tab_id.to_owned(),
                    tab_width,
                    target: target.clone(),
                    title: title.clone(),
                    topology_revision,
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
            schedule_tab_drag_session_timeout(app, session_id);
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
                    .and_then(|_| state.runtime.position_provisional_game_window(&target))
            {
                return finish_failed_tab_drag(
                    app,
                    state,
                    session_id,
                    shell_error("TAURI_TAB_DRAG_FAILED", message),
                )
                .map(Some);
            }
            if single_tab && !deferred_native_commit {
                state.runtime.begin_tab_drag_window_motion(source_window_id);
            }
        }
        "tabDragMove" => {
            if !deferred_native_commit
                && let Err(error) = process_tab_drag_motion(app, state, session_id, None, None)
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
                let ready = match record_windows_tab_drag_drop_intent(
                    state,
                    session_id,
                    target_window_id,
                    action["beforeTabId"].as_str(),
                ) {
                    Ok(ready) => ready,
                    Err(error) => {
                        return finish_failed_tab_drag(app, state, session_id, error).map(Some);
                    }
                };
                if ready {
                    return finish_windows_tab_drag_session(app, state, session_id)
                        .await
                        .map(Some);
                }
            } else {
                if let Err(error) = process_tab_drag_motion(
                    app,
                    state,
                    session_id,
                    Some(target_window_id),
                    action["beforeTabId"].as_str(),
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
                let exact_cleanup = match commit_tab_drag_session(state, &session).await {
                    Ok(exact_cleanup) => exact_cleanup,
                    Err(error) => {
                        return finish_failed_tab_drag_session(app, state, &mut session, error)
                            .map(Some);
                    }
                };
                return finish_applied_tab_drag(app, state, &session, exact_cleanup).map(Some);
            }
        }
        "tabDragEnd" => {
            let cancelled = action["cancelled"].as_bool().unwrap_or(false);
            if deferred_native_commit {
                record_windows_tab_drag_source_end(state, session_id, cancelled, false)?;
                return finish_windows_tab_drag_session(app, state, session_id)
                    .await
                    .map(Some);
            } else {
                if !cancelled
                    && let Err(error) =
                        process_tab_drag_motion(app, state, session_id, None, None)
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
                    let exact_cleanup = match commit_tab_drag_session(state, &session).await {
                        Ok(exact_cleanup) => exact_cleanup,
                        Err(error) => {
                            return finish_failed_tab_drag_session(app, state, &mut session, error)
                                .map(Some);
                        }
                    };
                    return finish_applied_tab_drag(app, state, &session, exact_cleanup).map(Some);
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
                shell_error("TAURI_TAB_DRAG_INVALID", "Drag cancellation state is invalid.")
            })?;
            let drop_accepted = action["dropAccepted"].as_bool().ok_or_else(|| {
                shell_error("TAURI_TAB_DRAG_INVALID", "Drag drop state is invalid.")
            })?;
            let ready = record_windows_tab_drag_source_end(
                state,
                session_id,
                cancelled,
                drop_accepted,
            )?;
            if ready {
                return finish_windows_tab_drag_session(app, state, session_id)
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

fn tab_drag_defers_native_mutations(is_windows: bool) -> bool {
    is_windows
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

fn record_latest_tab_drag_point(
    state: &CoreState,
    session_id: &str,
    screen_x: f64,
    screen_y: f64,
) -> Result<(), CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if let Some(session) = current.as_mut().filter(|session| session.id == session_id) {
        session.latest_screen_x = screen_x;
        session.latest_screen_y = screen_y;
        session.latest_move_revision = session.latest_move_revision.saturating_add(1);
    }
    Ok(())
}

fn update_tab_drag_dimensions(
    state: &CoreState,
    session_id: &str,
    tab_width: f64,
    tab_height: f64,
) -> Result<(), CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if let Some(session) = current.as_mut().filter(|session| session.id == session_id) {
        session.tab_width = tab_width;
        session.tab_height = tab_height;
    }
    Ok(())
}

fn process_tab_drag_motion(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
    explicit_window_id: Option<&str>,
    before_tab_id: Option<&str>,
) -> Result<(), CoreErrorPayload> {
    let mut session = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
        .clone()
        .filter(|session| session.id == session_id)
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_STALE", "Runtime tab drag session is stale."))?;
    if session.processed_move_revision == session.latest_move_revision
        && explicit_window_id.is_none()
    {
        return Ok(());
    }
    session.processed_move_revision = session.latest_move_revision;
    let screen_x = session.latest_screen_x;
    let screen_y = session.latest_screen_y;
    let floating_window_id = session.provisional_window_id.clone();
    let excluded = Some(floating_window_id.as_str());
    let attached_window_id = explicit_window_id
        .filter(|window_id| *window_id != floating_window_id)
        .filter(|window_id| {
            state
                .runtime
                .tab_control_row_contains_screen_point(window_id, screen_x, screen_y)
        })
        .map(str::to_owned)
        .or_else(|| {
            matches!(session.phase, GameWindowTabDragPhase::Attached)
                .then(|| session.current_window_id.clone())
                .filter(|window_id| {
                    state
                        .runtime
                        .tab_control_row_contains_screen_point(window_id, screen_x, screen_y)
                })
        })
        .or_else(|| {
            state
                .runtime
                .tab_drag_target_at_screen_point(screen_x, screen_y, excluded)
        });

    if let Some(target_window_id) = attached_window_id {
        attach_tab_drag_session(state, &mut session, &target_window_id, before_tab_id)?;
    } else {
        float_tab_drag_session(app, state, &mut session, screen_x, screen_y)?;
    }
    store_tab_drag_session_progress(state, session)
}

fn attach_tab_drag_session(
    state: &CoreState,
    session: &mut GameWindowTabDragSession,
    target_window_id: &str,
    before_tab_id: Option<&str>,
) -> Result<(), CoreErrorPayload> {
    if target_window_id == session.provisional_window_id && !session.single_tab {
        return Ok(());
    }
    if !session.snapshots.contains_key(target_window_id) {
        let snapshot = state
            .runtime
            .tab_drag_window_snapshot(target_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        session
            .snapshots
            .insert(target_window_id.to_owned(), snapshot);
    }
    let previous_window_id = session.current_window_id.clone();
    let ownership_changed = previous_window_id != target_window_id;
    if ownership_changed {
        state
            .runtime
            .provisionally_move_tab(&session.tab_id, target_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        restore_left_tab_drag_window(state, session, &previous_window_id)?;
    }
    state
        .runtime
        .preview_tab_drag_activation(&session.tab_id)
        .and_then(|_| {
            state.runtime.preview_tab_drag_order(
                target_window_id,
                &session.tab_id,
                before_tab_id.filter(|before| *before != session.tab_id),
                ownership_changed,
            )
        })
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    session.current_window_id = target_window_id.to_owned();
    session.phase = GameWindowTabDragPhase::Attached;
    Ok(())
}

fn float_tab_drag_session(
    app: &AppHandle,
    state: &CoreState,
    session: &mut GameWindowTabDragSession,
    screen_x: f64,
    screen_y: f64,
) -> Result<(), CoreErrorPayload> {
    let floating_window_id = session.provisional_window_id.clone();
    let previous_window_id = session.current_window_id.clone();
    if previous_window_id != floating_window_id {
        state
            .runtime
            .provisionally_move_tab(&session.tab_id, &floating_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        restore_left_tab_drag_window(state, session, &previous_window_id)?;
    }
    state
        .runtime
        .preview_tab_drag_activation(&session.tab_id)
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    let anchor = state
        .runtime
        .tab_drag_window_anchor(
            &floating_window_id,
            &session.tab_id,
            session.grab_ratio_x,
            session.grab_ratio_y,
            session.tab_width,
            session.tab_height,
        )
        .or(session.window_anchor)
        .unwrap_or((
            session.tab_width * session.grab_ratio_x,
            session.tab_height * session.grab_ratio_y,
        ));
    let target = tab_drag_target_for_screen(
        app,
        &session.original_target,
        &floating_window_id,
        screen_x,
        screen_y,
        anchor,
    )?;
    if session.single_tab && !matches!(session.phase, GameWindowTabDragPhase::Floating) {
        state
            .runtime
            .relocate_game_window(target.clone())
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    } else {
        state
            .runtime
            .position_provisional_game_window(&target)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    if cfg!(windows) {
        state
            .runtime
            .show_tab_drag_window(&floating_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    } else {
        state
            .runtime
            .set_tab_drag_window_ignores_cursor(&floating_window_id, true)
            .and_then(|_| state.runtime.show_tab_drag_window(&floating_window_id))
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    session.current_window_id = floating_window_id;
    session.phase = GameWindowTabDragPhase::Floating;
    session.target = target;
    session.window_anchor = Some(anchor);
    session.window_was_moved |= session.single_tab;
    Ok(())
}

fn restore_left_tab_drag_window(
    state: &CoreState,
    session: &GameWindowTabDragSession,
    window_id: &str,
) -> Result<(), CoreErrorPayload> {
    if window_id == session.provisional_window_id || window_id == session.source_window_id {
        return Ok(());
    }
    if let Some(snapshot) = session.snapshots.get(window_id) {
        state
            .runtime
            .restore_tab_drag_window_snapshot(snapshot)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_ROLLBACK_FAILED", message))?;
    }
    Ok(())
}

fn store_tab_drag_session_progress(
    state: &CoreState,
    mut progress: GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    let Some(existing) = current.as_mut().filter(|session| session.id == progress.id) else {
        return Ok(());
    };
    let (revision, screen_x, screen_y) = latest_tab_drag_sample(
        (
            progress.latest_move_revision,
            progress.latest_screen_x,
            progress.latest_screen_y,
        ),
        (
            existing.latest_move_revision,
            existing.latest_screen_x,
            existing.latest_screen_y,
        ),
    );
    progress.latest_move_revision = revision;
    progress.latest_screen_x = screen_x;
    progress.latest_screen_y = screen_y;
    *existing = progress;
    Ok(())
}

fn latest_tab_drag_sample(processed: (u64, f64, f64), current: (u64, f64, f64)) -> (u64, f64, f64) {
    if current.0 > processed.0 {
        current
    } else {
        processed
    }
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
