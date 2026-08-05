fn process_tab_drag_motion(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
    explicit_window_id: Option<&str>,
    before_tab_id: Option<&str>,
    ordered_tab_ids: Option<&[String]>,
) -> Result<(), CoreErrorPayload> {
    let session = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
        .clone()
        .filter(|session| session.id == session_id);
    let Some(mut session) = session else {
        return Ok(());
    };
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
            (!session.single_tab && matches!(session.phase, GameWindowTabDragPhase::Attached))
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
        if target_window_id == session.current_window_id && ordered_tab_ids.is_none() {
            return store_tab_drag_session_progress(state, session);
        }
        attach_tab_drag_session(
            state,
            &mut session,
            &target_window_id,
            before_tab_id,
            ordered_tab_ids,
        )?;
        if let Some(ordered_tab_ids) = ordered_tab_ids {
            session.drop_window_id = Some(target_window_id);
            session.drop_before_tab_id = before_tab_id
                .filter(|before_tab_id| *before_tab_id != session.tab_id)
                .map(str::to_owned);
            session.drop_ordered_tab_ids = Some(ordered_tab_ids.to_vec());
        }
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
    ordered_tab_ids: Option<&[String]>,
) -> Result<(), CoreErrorPayload> {
    if target_window_id == session.provisional_window_id && !session.single_tab {
        return Ok(());
    }
    state.runtime.begin_tab_drag_window_motion(target_window_id);
    let previous_window_id = session.current_window_id.clone();
    let ownership_changed = previous_window_id != target_window_id;
    if ownership_changed {
        let target_order = if let Some(ordered_tab_ids) = ordered_tab_ids {
            ordered_tab_ids.to_vec()
        } else {
            let mut target_order = state
                .runtime
                .tab_drag_window_snapshot(target_window_id)
                .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?
                .tab_ids;
            target_order.retain(|tab_id| tab_id != &session.tab_id);
            let insertion = before_tab_id
                .and_then(|before| target_order.iter().position(|tab_id| tab_id == before))
                .unwrap_or(target_order.len());
            target_order.insert(insertion, session.tab_id.clone());
            target_order
        };
        state
            .runtime
            .commit_live_tab_drag_destination(
                &previous_window_id,
                target_window_id,
                &session.tab_id,
                &target_order,
            )
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        if let Err(message) = state
            .runtime
            .provisionally_move_tab_for_live_drag(&session.tab_id, target_window_id)
        {
            eprintln!(
                "Live tab destination retained while surface projection retries: tab={} target={} error={message}",
                session.tab_id, target_window_id
            );
            state
                .runtime
                .schedule_tab_surface_move_retry(session.tab_id.clone(), target_window_id.to_owned());
        }
    }
    if !ownership_changed {
        (if let Some(ordered_tab_ids) = ordered_tab_ids {
            state
                .runtime
                .preview_tab_drag_order_exact(target_window_id, ordered_tab_ids, false)
        } else {
            state.runtime.preview_tab_drag_order(
                target_window_id,
                &session.tab_id,
                before_tab_id.filter(|before| *before != session.tab_id),
                false,
            )
        })
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    session.current_window_id = target_window_id.to_owned();
    session.hover_window_id = None;
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
    let returning_from_hover = session.hover_window_id.take().is_some();
    let entering_floating = !matches!(session.phase, GameWindowTabDragPhase::Floating)
        || previous_window_id != floating_window_id
        || returning_from_hover;
    if previous_window_id != floating_window_id {
        state
            .runtime
            .commit_live_tab_drag_destination(
                &previous_window_id,
                &floating_window_id,
                &session.tab_id,
                std::slice::from_ref(&session.tab_id),
            )
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        if let Err(message) = state
            .runtime
            .provisionally_move_tab_for_live_drag(&session.tab_id, &floating_window_id)
        {
            eprintln!(
                "Detached live tab retained while surface projection retries: tab={} target={} error={message}",
                session.tab_id, floating_window_id
            );
            state.runtime.schedule_tab_surface_move_retry(
                session.tab_id.clone(),
                floating_window_id.clone(),
            );
        }
    }
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
    if cfg!(windows) {
        state
            .runtime
            .position_provisional_game_window(&target)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        state
            .runtime
            .show_tab_drag_window(&floating_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    } else {
        state
            .runtime
            .acquire_tab_drag_cursor_lease(&floating_window_id, &session.id)
            .and_then(|_| state.runtime.position_tab_drag_window(&target, &session.id))
            .and_then(|_| {
                if entering_floating {
                    state.runtime.show_tab_drag_window(&floating_window_id)
                } else {
                    Ok(())
                }
            })
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    session.current_window_id = floating_window_id;
    session.phase = GameWindowTabDragPhase::Floating;
    session.target = target;
    session.window_anchor = Some(anchor);
    session.window_was_moved |= session.single_tab;
    Ok(())
}
