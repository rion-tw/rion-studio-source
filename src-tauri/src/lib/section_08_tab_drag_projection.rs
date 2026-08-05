fn complete_visible_tab_drag(state: &CoreState, session: &GameWindowTabDragSession) {
    let final_window_id = session.current_window_id.as_str();
    let persisted_motion_window = (session.single_tab
        && final_window_id == session.source_window_id
        && session.window_was_moved)
        .then_some(final_window_id);
    release_tab_drag_window_motion_suppression(state, session, persisted_motion_window);
    if let Err(message) = state
        .runtime
        .make_provisional_game_window_interactive(final_window_id, &session.id)
    {
        eprintln!(
            "Committed tab drag window interactivity remains pending: window={final_window_id} error={message}"
        );
    }
    if !session.single_tab && final_window_id != session.provisional_window_id {
        state
            .runtime
            .discard_provisional_game_window(&session.provisional_window_id);
    } else if session.single_tab && final_window_id != session.source_window_id {
        state
            .runtime
            .discard_provisional_game_window(&session.source_window_id);
    }
}

fn finish_visible_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<Value, CoreErrorPayload> {
    complete_visible_tab_drag(state, session);
    record_tab_drag_lifecycle(
        state,
        session,
        "tab.drag-live-committed",
        "The live tab destination committed and released the gesture lane.",
    );
    finish_applied_tab_drag(
        app,
        state,
        session,
        RuntimeTabMutationProjectionOutcome::Applied,
    )
}
