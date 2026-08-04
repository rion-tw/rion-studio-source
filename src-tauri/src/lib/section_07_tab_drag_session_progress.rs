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

fn latest_tab_drag_sample(
    processed: (u64, f64, f64),
    current: (u64, f64, f64),
) -> (u64, f64, f64) {
    if current.0 > processed.0 {
        current
    } else {
        processed
    }
}
