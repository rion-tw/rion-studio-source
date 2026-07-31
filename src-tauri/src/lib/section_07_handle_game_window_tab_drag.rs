pub(crate) async fn handle_game_window_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    source_window_id: &str,
    action: &Value,
) -> Result<bool, CoreErrorPayload> {
    let Some(action_type) = action["type"].as_str() else {
        return Ok(false);
    };
    if !matches!(
        action_type,
        "tabDragStart"
            | "tabDragMove"
            | "tabDragHover"
            | "tabDragDrop"
            | "tabDragEnd"
            | "tabDragCancel"
    ) {
        return Ok(false);
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
    )
    .then(|| drag_screen_point(app, action))
    .transpose()?;
    if let Some((screen_x, screen_y)) = action_point {
        record_latest_tab_drag_point(state, session_id, screen_x, screen_y)?;
    }
    let _lane = state.tab_drag_lane.lock().await;
    if action_type != "tabDragStart"
        && tab_drag_session_finished(state, session_id)?
        && state
            .tab_drag
            .lock()
            .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
            .as_ref()
            .is_none_or(|session| session.id != session_id)
    {
        return Ok(true);
    }

    match action_type {
        "tabDragStart" => {
            if tab_drag_session_finished(state, session_id)? {
                return Ok(true);
            }
            let tab_id = action["tabId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    shell_error("TAURI_TAB_DRAG_INVALID", "Runtime tab ID is required.")
                })?;
            let (screen_x, screen_y) = drag_screen_point(app, action)?;
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
            if let Err(message) = state.runtime.preview_tab_drag_activation(tab_id) {
                return Err(shell_error("TAURI_TAB_DRAG_FAILED", message));
            }
            if !single_tab
                && let Err(message) = state
                    .runtime
                    .prepare_provisional_game_window(&target, &title)
                    .and_then(|_| state.runtime.position_provisional_game_window(&target))
            {
                state
                    .runtime
                    .discard_provisional_game_window(&provisional_window_id);
                let _ = state
                    .runtime
                    .restore_tab_drag_window_snapshot(&source_snapshot);
                return Err(shell_error("TAURI_TAB_DRAG_FAILED", message));
            }
            let mut snapshots = HashMap::new();
            snapshots.insert(source_window_id.to_owned(), source_snapshot);
            *state.tab_drag.lock().map_err(|_| {
                shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned.")
            })? = Some(GameWindowTabDragSession {
                current_window_id: source_window_id.to_owned(),
                grab_ratio_x,
                grab_ratio_y,
                id: session_id.to_owned(),
                latest_move_revision: 0,
                latest_screen_x: screen_x,
                latest_screen_y: screen_y,
                original_target: source.clone(),
                phase: GameWindowTabDragPhase::Attached,
                processed_move_revision: 0,
                provisional_window_id,
                single_tab,
                snapshots,
                source_window_id: source_window_id.to_owned(),
                tab_height,
                tab_id: tab_id.to_owned(),
                tab_width,
                target,
                window_anchor: initial_anchor,
                window_was_moved: false,
            });
            if single_tab {
                state.runtime.begin_tab_drag_window_motion(source_window_id);
            }
        }
        "tabDragMove" => {
            if let Err(error) = process_tab_drag_motion(app, state, session_id, None, None) {
                return Err(abort_tab_drag_motion(state, session_id, error));
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
            if let Err(error) = process_tab_drag_motion(
                app,
                state,
                session_id,
                Some(target_window_id),
                action["beforeTabId"].as_str(),
            ) {
                return Err(abort_tab_drag_motion(state, session_id, error));
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
            if let Err(error) = process_tab_drag_motion(
                app,
                state,
                session_id,
                Some(target_window_id),
                action["beforeTabId"].as_str(),
            ) {
                return Err(abort_tab_drag_motion(state, session_id, error));
            }
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(mut session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            session.phase = GameWindowTabDragPhase::Finishing;
            if let Err(error) = commit_tab_drag_session(state, &session).await {
                return Err(cancel_tab_drag_preserving_error(state, &session, error));
            }
        }
        "tabDragEnd" => {
            let cancelled = action["cancelled"].as_bool().unwrap_or(false);
            if !cancelled
                && let Err(error) = process_tab_drag_motion(app, state, session_id, None, None)
            {
                return Err(abort_tab_drag_motion(state, session_id, error));
            }
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(mut session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            if cancelled {
                session.phase = GameWindowTabDragPhase::Cancelled;
                cancel_tab_drag_session_recoverable(state, &session)?;
            } else {
                session.phase = GameWindowTabDragPhase::Finishing;
                if let Err(error) = commit_tab_drag_session(state, &session).await {
                    return Err(cancel_tab_drag_preserving_error(state, &session, error));
                }
            }
        }
        "tabDragCancel" => {
            mark_tab_drag_session_finished(state, session_id)?;
            let Some(mut session) = take_tab_drag_session(state, session_id)? else {
                return Ok(true);
            };
            session.phase = GameWindowTabDragPhase::Cancelled;
            cancel_tab_drag_session_recoverable(state, &session)?;
        }
        _ => unreachable!(),
    }
    Ok(true)
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
    state
        .runtime
        .set_tab_drag_window_ignores_cursor(&floating_window_id, true)
        .and_then(|_| state.runtime.show_tab_drag_window(&floating_window_id))
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
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

const FINISHED_TAB_DRAG_LIMIT: usize = 128;

fn tab_drag_session_finished(
    state: &CoreState,
    session_id: &str,
) -> Result<bool, CoreErrorPayload> {
    state
        .tab_drag_finished
        .lock()
        .map(|finished| finished.iter().any(|id| id == session_id))
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))
}

fn mark_tab_drag_session_finished(
    state: &CoreState,
    session_id: &str,
) -> Result<(), CoreErrorPayload> {
    let mut finished = state
        .tab_drag_finished
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if !finished.iter().any(|id| id == session_id) {
        finished.push_back(session_id.to_owned());
    }
    while finished.len() > FINISHED_TAB_DRAG_LIMIT {
        finished.pop_front();
    }
    Ok(())
}

fn abort_tab_drag_motion(
    state: &CoreState,
    session_id: &str,
    error: CoreErrorPayload,
) -> CoreErrorPayload {
    let _ = mark_tab_drag_session_finished(state, session_id);
    match take_tab_drag_session(state, session_id) {
        Ok(Some(mut session)) => {
            session.phase = GameWindowTabDragPhase::Cancelled;
            cancel_tab_drag_preserving_error(state, &session, error)
        }
        Ok(None) => error,
        Err(cleanup) => tab_drag_rollback_error(&error, &cleanup),
    }
}

fn cancel_tab_drag_preserving_error(
    state: &CoreState,
    session: &GameWindowTabDragSession,
    error: CoreErrorPayload,
) -> CoreErrorPayload {
    match cancel_tab_drag_session(state, session) {
        Ok(()) => error,
        Err(cleanup) => {
            reopen_tab_drag_session(state, session);
            tab_drag_rollback_error(&error, &cleanup)
        }
    }
}

fn cancel_tab_drag_session_recoverable(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    cancel_tab_drag_session(state, session).inspect_err(|_| {
        reopen_tab_drag_session(state, session);
    })
}

fn reopen_tab_drag_session(state: &CoreState, session: &GameWindowTabDragSession) {
    if let Ok(mut finished) = state.tab_drag_finished.lock() {
        finished.retain(|id| id != &session.id);
    }
    if let Ok(mut current) = state.tab_drag.lock()
        && current.is_none()
    {
        *current = Some(session.clone());
    }
}

fn tab_drag_rollback_error(
    error: &CoreErrorPayload,
    cleanup: &CoreErrorPayload,
) -> CoreErrorPayload {
    shell_error(
        "TAURI_TAB_DRAG_ROLLBACK_FAILED",
        format!(
            "Runtime tab drag failed ({}: {}); rollback failed ({}: {}).",
            error.code, error.message, cleanup.code, cleanup.message
        ),
    )
}

fn drag_screen_point(app: &AppHandle, action: &Value) -> Result<(f64, f64), CoreErrorPayload> {
    let screen_x = action["screenX"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen X is invalid."))?;
    let screen_y = action["screenY"]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_INVALID", "Drag screen Y is invalid."))?;
    if cfg!(windows) {
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
