use super::coalesce_native_tab_drag_actions;

#[test]
fn drag_action_queue_coalesces_all_transient_samples_for_the_same_session() {
    assert!(coalesce_native_tab_drag_actions(
        "tabDragMove",
        Some("session-a"),
        "tabDragMove",
        Some("session-a"),
    ));
    assert!(coalesce_native_tab_drag_actions(
        "tabDragHover",
        Some("session-a"),
        "tabDragHover",
        Some("session-a"),
    ));
    assert!(coalesce_native_tab_drag_actions(
        "tabDragMove",
        Some("session-a"),
        "tabDragHover",
        Some("session-a"),
    ));
    assert!(coalesce_native_tab_drag_actions(
        "tabDragHover",
        Some("session-a"),
        "tabDragMove",
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
fn drag_action_queue_lets_terminals_replace_pending_motion() {
    for action in ["tabDragDrop", "tabDragEnd", "tabDragCancel"] {
        assert!(coalesce_native_tab_drag_actions(
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
    assert!(!coalesce_native_tab_drag_actions(
        "tabDragMove",
        Some("session-a"),
        "tabDragStart",
        Some("session-a"),
    ));
}
