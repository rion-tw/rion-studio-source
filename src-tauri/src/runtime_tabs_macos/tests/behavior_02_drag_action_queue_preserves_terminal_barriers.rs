use super::coalesce_native_tab_drag_actions;

#[test]
fn drag_action_queue_only_coalesces_one_sessions_move_and_hover_samples() {
    assert!(coalesce_native_tab_drag_actions(
        "tabDragMove",
        Some("session-a"),
        "tabDragHover",
        Some("session-a"),
    ));
    assert!(!coalesce_native_tab_drag_actions(
        "tabDragHover",
        Some("session-a"),
        "tabDragMove",
        Some("session-b"),
    ));
}

#[test]
fn drag_action_queue_never_coalesces_terminal_or_start_barriers() {
    for action in ["tabDragStart", "tabDragDrop", "tabDragEnd", "tabDragCancel"] {
        assert!(!coalesce_native_tab_drag_actions(
            "tabDragMove",
            Some("session-a"),
            action,
            Some("session-a"),
        ));
        assert!(!coalesce_native_tab_drag_actions(
            action,
            Some("session-a"),
            "tabDragHover",
            Some("session-a"),
        ));
    }
}
