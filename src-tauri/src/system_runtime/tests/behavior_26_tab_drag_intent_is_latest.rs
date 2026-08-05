#[test]
fn newer_drag_generation_supersedes_old_callbacks_and_projection() {
    let coordinator = TabDragIntentCoordinator::default();
    let first = coordinator.stamp_action(
        "tabDragStart",
        Some("session-1"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );
    let hover = coordinator.stamp_action(
        "tabDragHover",
        Some("session-1"),
        Some("tab-a"),
        Some("window-main"),
        Some("window-detached"),
    );
    coordinator.bind_operation("session-1", "operation-1");

    assert!(hover.event_sequence > first.event_sequence);
    assert_eq!(hover.intent_generation, first.intent_generation);
    assert!(coordinator.is_latest("session-1", first.intent_generation));
    assert!(!coordinator.projection_is_superseded(Some("operation-1"), "window-main"));

    let second = coordinator.stamp_action(
        "tabDragStart",
        Some("session-2"),
        Some("tab-a"),
        Some("window-detached"),
        None,
    );
    coordinator.bind_operation("session-2", "operation-2");

    assert!(second.event_sequence > hover.event_sequence);
    assert!(second.intent_generation > first.intent_generation);
    assert!(!coordinator.is_latest("session-1", first.intent_generation));
    assert!(coordinator.newer_intent_started_in(
        "session-1",
        first.intent_generation,
        "window-detached"
    ));
    assert!(!coordinator.newer_intent_started_in(
        "session-1",
        first.intent_generation,
        "window-main"
    ));
    assert!(coordinator.projection_is_superseded(Some("operation-1"), "window-main"));
    assert!(!coordinator.projection_is_superseded(Some("operation-2"), "window-detached"));
}

#[test]
fn completed_drag_releases_unowned_window_projection_fence() {
    let coordinator = TabDragIntentCoordinator::default();
    let stamp = coordinator.stamp_action(
        "tabDragStart",
        Some("session-1"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );

    assert!(coordinator.projection_is_superseded(None, "window-main"));
    coordinator.complete("session-1");
    assert!(coordinator.is_latest("session-1", stamp.intent_generation));
    assert!(!coordinator.projection_is_superseded(None, "window-main"));
}

#[test]
fn concurrent_tabs_keep_independent_latest_generations() {
    let coordinator = TabDragIntentCoordinator::default();
    let first = coordinator.stamp_action(
        "tabDragStart",
        Some("session-a"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );
    let second = coordinator.stamp_action(
        "tabDragStart",
        Some("session-b"),
        Some("tab-b"),
        Some("window-other"),
        None,
    );

    assert!(coordinator.is_latest("session-a", first.intent_generation));
    assert!(coordinator.is_latest("session-b", second.intent_generation));
}

#[test]
fn newer_drag_of_another_tab_supersedes_the_old_shared_window_projection() {
    let coordinator = TabDragIntentCoordinator::default();
    let first = coordinator.stamp_action(
        "tabDragStart",
        Some("session-a"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );
    coordinator.bind_operation("session-a", "operation-a");
    let second = coordinator.stamp_action(
        "tabDragStart",
        Some("session-b"),
        Some("tab-b"),
        Some("window-main"),
        None,
    );

    assert!(coordinator.is_latest("session-a", first.intent_generation));
    assert!(coordinator.is_latest("session-b", second.intent_generation));
    assert!(!coordinator.projection_is_latest("session-a", first.intent_generation));
}

#[test]
fn duplicate_start_for_one_native_session_keeps_its_generation() {
    let coordinator = TabDragIntentCoordinator::default();
    let first = coordinator.stamp_action(
        "tabDragStart",
        Some("session-a"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );
    let duplicate = coordinator.stamp_action(
        "tabDragStart",
        Some("session-a"),
        Some("tab-a"),
        Some("window-main"),
        None,
    );

    assert!(duplicate.event_sequence > first.event_sequence);
    assert_eq!(duplicate.intent_generation, first.intent_generation);
}
