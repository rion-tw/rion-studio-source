fn synchronized_surface(label: &str) -> WindowsReparentSurfaceSyncResult {
    WindowsReparentSurfaceSyncResult {
        failure: None,
        label: label.to_owned(),
        notified: true,
        verified: true,
    }
}

#[test]
fn windows_reparent_sync_requires_every_scheduled_surface() {
    let (sender, receiver) = mpsc::channel();
    sender.send(synchronized_surface("role-a")).unwrap();
    sender.send(synchronized_surface("role-b")).unwrap();
    drop(sender);
    let started = Instant::now();

    let outcome = collect_windows_reparent_sync_results(
        receiver,
        2,
        2,
        started,
        started + WINDOWS_REPARENT_SYNC_TIMEOUT,
        None,
        None,
    )
    .unwrap();

    assert_eq!(outcome.completed_surface_count, 2);
    assert_eq!(outcome.notified_surface_count, 2);
    assert_eq!(outcome.verified_surface_count, 2);
}

#[test]
fn windows_reparent_sync_drains_callbacks_before_reporting_native_failure() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(WindowsReparentSurfaceSyncResult {
            failure: Some(WindowsReparentSurfaceSyncFailure {
                message: "wrong root".to_owned(),
                stage: "ancestor-mismatch",
            }),
            label: "role-a".to_owned(),
            notified: false,
            verified: false,
        })
        .unwrap();
    sender.send(synchronized_surface("role-b")).unwrap();
    drop(sender);
    let started = Instant::now();

    let failure = collect_windows_reparent_sync_results(
        receiver,
        2,
        2,
        started,
        started + WINDOWS_REPARENT_SYNC_TIMEOUT,
        None,
        None,
    )
    .unwrap_err();

    assert_eq!(failure.completed_surface_count, 2);
    assert_eq!(failure.failed_surface_label.as_deref(), Some("role-a"));
    assert_eq!(failure.notified_surface_count, 1);
    assert_eq!(failure.stage, "ancestor-mismatch");
    assert_eq!(failure.verified_surface_count, 1);
}

#[test]
fn windows_reparent_sync_timeout_is_one_aggregate_deadline() {
    let (_sender, receiver) = mpsc::channel();
    let started = Instant::now();

    let failure = collect_windows_reparent_sync_results(
        receiver,
        9,
        9,
        started,
        started,
        None,
        None,
    )
    .unwrap_err();

    assert_eq!(failure.completed_surface_count, 0);
    assert_eq!(failure.stage, "callback-timeout");
    assert!(failure.timed_out);
    assert!(failure.elapsed_ms < WINDOWS_REPARENT_SYNC_TIMEOUT.as_millis() as u64);
}

#[test]
fn windows_reparent_sync_rejects_callback_scheduling_failure() {
    let (sender, receiver) = mpsc::channel();
    drop(sender);
    let started = Instant::now();

    let failure = collect_windows_reparent_sync_results(
        receiver,
        1,
        0,
        started,
        started + WINDOWS_REPARENT_SYNC_TIMEOUT,
        Some(WindowsReparentSurfaceSyncFailure {
            message: "dispatcher unavailable".to_owned(),
            stage: "callback-scheduling",
        }),
        Some("role-a".to_owned()),
    )
    .unwrap_err();

    assert_eq!(failure.completed_surface_count, 0);
    assert_eq!(failure.failed_surface_label.as_deref(), Some("role-a"));
    assert_eq!(failure.stage, "callback-scheduling");
    assert!(!failure.timed_out);
}
