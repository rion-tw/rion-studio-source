fn visibility_fence() -> RestoredWindowVisibilityFence {
    RestoredWindowVisibilityFence {
        foreground_tab_id: "tab-foreground".to_owned(),
        launch_trace: None,
        reveal_dispatched: false,
        topology_revision: 41,
        visibility_signal: RestoredVisibilitySignal::new(),
        window_generation: 7,
    }
}

fn current_snapshot<'a>() -> RestoredForegroundVisibilitySnapshot<'a> {
    RestoredForegroundVisibilitySnapshot {
        host_current: true,
        live_contains_tab: true,
        live_revision: 42,
        live_selected_tab_id: Some("tab-foreground"),
        live_window_generation: 7,
        tab_current: true,
    }
}

#[test]
fn restored_foreground_reveals_only_after_the_exact_surface_attachment() {
    assert!(restored_foreground_visibility_is_current(
        &visibility_fence(),
        "tab-foreground",
        7,
        current_snapshot(),
    ));
}

#[test]
fn duplicate_stale_closed_or_superseded_attachment_never_reveals() {
    let mut duplicate = visibility_fence();
    duplicate.reveal_dispatched = true;
    assert!(!restored_foreground_visibility_is_current(
        &duplicate,
        "tab-foreground",
        7,
        current_snapshot(),
    ));

    let stale_generation = RestoredForegroundVisibilitySnapshot {
        live_window_generation: 8,
        ..current_snapshot()
    };
    assert!(!restored_foreground_visibility_is_current(
        &visibility_fence(),
        "tab-foreground",
        7,
        stale_generation,
    ));

    let closed = RestoredForegroundVisibilitySnapshot {
        tab_current: false,
        ..current_snapshot()
    };
    assert!(!restored_foreground_visibility_is_current(
        &visibility_fence(),
        "tab-foreground",
        7,
        closed,
    ));

    let superseded = RestoredForegroundVisibilitySnapshot {
        live_selected_tab_id: Some("tab-newer"),
        ..current_snapshot()
    };
    assert!(!restored_foreground_visibility_is_current(
        &visibility_fence(),
        "tab-foreground",
        7,
        superseded,
    ));
}

#[test]
fn restored_surface_attachment_never_overwrites_a_newer_visible_selection() {
    assert!(!restored_tab_selection_intent_is_current(
        true,
        Some("tab-restored"),
        "tab-restored",
        Some("tab-user-selected"),
    ));
    assert!(restored_tab_selection_intent_is_current(
        true,
        Some("tab-restored"),
        "tab-restored",
        Some("tab-restored"),
    ));
    assert!(restored_tab_selection_intent_is_current(
        true,
        Some("tab-restored"),
        "tab-restored",
        None,
    ));
    assert!(restored_tab_selection_intent_is_current(
        true,
        None,
        "tab-command",
        Some("tab-existing"),
    ));
}

#[tokio::test]
async fn foreground_visibility_signal_replays_the_exact_native_operation_before_followers() {
    let signal = RestoredVisibilitySignal::new();
    let mut before_submit = signal.subscribe();
    signal.submit("native-presentation-foreground");
    before_submit
        .changed()
        .await
        .expect("the exact visibility operation must wake an existing follower");
    assert_eq!(
        before_submit.borrow().as_deref(),
        Some("native-presentation-foreground")
    );

    let after_submit = signal.subscribe();
    assert_eq!(
        after_submit.borrow().as_deref(),
        Some("native-presentation-foreground"),
        "subscribe-after-terminal must not miss the visibility operation"
    );
}
