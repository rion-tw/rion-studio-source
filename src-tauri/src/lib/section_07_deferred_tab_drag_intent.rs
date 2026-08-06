fn drag_drop_ordered_tab_ids(action: &Value) -> Result<Vec<String>, CoreErrorPayload> {
    let tab_ids = action["orderedTabIds"].as_array().ok_or_else(|| {
        shell_error(
            "TAURI_TAB_DRAG_INVALID",
            "Tab drag topology order is required.",
        )
    })?;
    if tab_ids.is_empty() || tab_ids.len() > 256 {
        return Err(shell_error(
            "TAURI_TAB_DRAG_INVALID",
            "Tab drag topology order must contain between one and 256 tabs.",
        ));
    }
    let mut seen = HashSet::new();
    let ordered_tab_ids = tab_ids
        .iter()
        .map(|tab_id| {
            tab_id
                .as_str()
                .filter(|tab_id| !tab_id.is_empty())
                .ok_or_else(|| {
                    shell_error(
                        "TAURI_TAB_DRAG_INVALID",
                        "Tab drag topology contains an invalid tab identifier.",
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if !ordered_tab_ids.iter().all(|tab_id| seen.insert(*tab_id)) {
        return Err(shell_error(
            "TAURI_TAB_DRAG_INVALID",
            "Tab drag topology contains duplicate tab identifiers.",
        ));
    }
    Ok(ordered_tab_ids.into_iter().map(str::to_owned).collect())
}

fn record_deferred_tab_drag_drop_intent(
    state: &CoreState,
    session_id: &str,
    target_window_id: &str,
    before_tab_id: Option<&str>,
    ordered_tab_ids: Vec<String>,
) -> Result<bool, CoreErrorPayload> {
    let session_is_active = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
        .as_ref()
        .is_some_and(|session| session.id == session_id);
    if !session_is_active {
        return Ok(false);
    }
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    let Some(session) = current
        .as_mut()
        .filter(|session| session.id == session_id)
    else {
        return Ok(false);
    };
    if !windows_html_tab_drag_target_is_local(&session.source_window_id, target_window_id) {
        session.source_cancelled = true;
        session.source_drop_accepted = false;
        session.source_end_received = true;
        return Ok(true);
    }
    session.drop_window_id = Some(target_window_id.to_owned());
    session.drop_before_tab_id = before_tab_id
        .filter(|before_tab_id| *before_tab_id != session.tab_id)
        .map(str::to_owned);
    session.drop_ordered_tab_ids = Some(ordered_tab_ids);
    session.phase = GameWindowTabDragPhase::Previewing;
    Ok(session.source_end_received && session.source_drop_accepted)
}

fn windows_html_tab_drag_target_is_local(
    source_window_id: &str,
    target_window_id: &str,
) -> bool {
    source_window_id == target_window_id
}

fn record_deferred_tab_drag_source_end(
    state: &CoreState,
    session_id: &str,
    cancelled: bool,
    drop_accepted: bool,
) -> Result<bool, CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    let Some(session) = current
        .as_mut()
        .filter(|session| session.id == session_id)
    else {
        return Ok(false);
    };
    session.source_cancelled = cancelled;
    session.source_drop_accepted = drop_accepted;
    session.source_end_received = true;
    let ready = deferred_tab_drag_terminal_ready(
        cancelled,
        drop_accepted,
        session.drop_window_id.is_some(),
    );
    if !ready {
        session.phase = GameWindowTabDragPhase::Previewing;
    }
    Ok(ready)
}

fn deferred_tab_drag_terminal_ready(
    cancelled: bool,
    drop_accepted: bool,
    has_drop_intent: bool,
) -> bool {
    cancelled || !drop_accepted || has_drop_intent
}
