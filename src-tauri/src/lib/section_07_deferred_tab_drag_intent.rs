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
    let target = state
        .runtime
        .tab_drag_window_snapshot(target_window_id)
        .map_err(|message| shell_error("TAURI_TAB_DRAG_INVALID", message))?;
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
    let target = session
        .snapshots
        .entry(target_window_id.to_owned())
        .or_insert(target);
    if let Some(before_tab_id) = before_tab_id
        && !target.tab_ids.iter().any(|tab_id| tab_id == before_tab_id)
    {
        return Err(shell_error(
            "TAURI_TAB_DRAG_INVALID",
            "The drop insertion tab is outside the target Game Window.",
        ));
    }
    let mut expected_tab_ids = target.tab_ids.clone();
    if target_window_id != session.source_window_id {
        expected_tab_ids.push(session.tab_id.clone());
    }
    if !tab_drag_exact_order_matches(&expected_tab_ids, &ordered_tab_ids) {
        return Err(shell_error(
            "TAURI_TAB_DRAG_INVALID",
            "Drop topology does not match the frozen Game Window tabs.",
        ));
    }
    session.drop_window_id = Some(target_window_id.to_owned());
    session.drop_before_tab_id = before_tab_id
        .filter(|before_tab_id| *before_tab_id != session.tab_id)
        .map(str::to_owned);
    session.drop_ordered_tab_ids = Some(ordered_tab_ids);
    session.phase = GameWindowTabDragPhase::AwaitingDropIntent;
    Ok(session.source_end_received && session.source_drop_accepted)
}

fn tab_drag_exact_order_matches(expected: &[String], observed: &[String]) -> bool {
    expected.len() == observed.len()
        && expected.iter().collect::<HashSet<_>>() == observed.iter().collect::<HashSet<_>>()
        && observed.iter().all(|tab_id| !tab_id.is_empty())
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
        session.phase = GameWindowTabDragPhase::AwaitingDropIntent;
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
