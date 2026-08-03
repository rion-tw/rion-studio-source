#[test]
fn tab_drag_receipt_freezes_session_and_fences_on_both_platforms() {
    for platform in ["macos", "windows"] {
        let context = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Drag,
            "runtime-tab-drag",
            Duration::from_secs(10),
            platform,
        )
        .with_session_id("drag-session")
        .with_window("window-a")
        .with_window_generation(17)
        .with_tab("tab-a")
        .with_lifecycle_epoch(9)
        .with_topology_revision(23);
        let summary = NativeOperationReceipt::applied(context, "tabDragCommitted").summary();

        assert_eq!(summary.platform, platform);
        assert_eq!(summary.subsystem, "drag");
        assert_eq!(summary.completion_scope, "dragCommitted");
        assert_eq!(summary.session_id.as_deref(), Some("drag-session"));
        assert_eq!(summary.window_generation, Some(17));
        assert_eq!(summary.lifecycle_epoch, Some(9));
        assert_eq!(summary.topology_revision, Some(23));
    }
}

#[test]
fn tab_drag_registry_replays_the_first_terminal_receipt() {
    let registry = NativeOperationRegistry::default();
    let context = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Drag,
        "runtime-tab-drag",
        Duration::from_secs(10),
        "windows",
    )
    .with_session_id("drag-session");
    let operation_id = context.operation_id.clone();
    registry.register(context.clone()).unwrap();
    assert!(registry.mark_in_flight(&operation_id));

    let first = registry.complete(NativeOperationReceipt::with_status(
        context.clone(),
        "tabDragCancelled",
        NativeOperationStatus::Cancelled,
        None,
    ));
    let late = registry.complete(NativeOperationReceipt::with_status(
        context,
        "tabDragLateCallback",
        NativeOperationStatus::Applied,
        None,
    ));

    assert_eq!(late, first);
    assert_eq!(registry.wait(&operation_id).unwrap(), first);
    assert_eq!(first.summary().status, "cancelled");
}
