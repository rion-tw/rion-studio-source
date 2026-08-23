#[test]
fn empty_role_load_distinguishes_placeholder_web_only_and_attached_roles() {
    assert_eq!(
        empty_role_load_boundary_kind(0, 0),
        Some(EmptyRoleLoadBoundaryKind::PlaceholderOnly)
    );
    assert_eq!(
        empty_role_load_boundary_kind(3, 3),
        Some(EmptyRoleLoadBoundaryKind::WorkspaceWeb)
    );
    assert_eq!(empty_role_load_boundary_kind(2, 1), None);
    assert_eq!(empty_role_load_boundary_kind(1, 0), None);
    assert!(empty_role_load_has_native_readiness_boundary(0));
    assert!(!empty_role_load_has_native_readiness_boundary(1));
}

#[test]
fn workspace_web_commit_fence_terminalizes_lifecycle_interruption_only_for_same_launch() {
    assert!(workspace_web_readiness_commit_allowed(
        WorkspaceWebReadinessOutcome::Degraded,
        false,
        true,
    ));
    assert!(!workspace_web_readiness_commit_allowed(
        WorkspaceWebReadinessOutcome::Ready,
        false,
        true,
    ));
    assert!(!workspace_web_readiness_commit_allowed(
        WorkspaceWebReadinessOutcome::Degraded,
        false,
        false,
    ));
    assert!(workspace_web_readiness_commit_allowed(
        WorkspaceWebReadinessOutcome::Ready,
        true,
        true,
    ));
}

#[tokio::test]
async fn workspace_web_only_readiness_waits_for_every_initial_page_finish() {
    let first = Arc::new(NavigationTracker::new_for_platform("macos"));
    let second = Arc::new(NavigationTracker::new_for_platform("macos"));
    let first_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_secs(1),
        "macos",
    );
    let second_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_secs(1),
        "macos",
    );
    first.begin_operation(&first_operation).unwrap();
    second.begin_operation(&second_operation).unwrap();

    let first_wait = {
        let tracker = Arc::clone(&first);
        tokio::spawn(async move { tracker.wait_operation_async(first_operation).await })
    };
    let second_wait = {
        let tracker = Arc::clone(&second);
        tokio::spawn(async move { tracker.wait_operation_async(second_operation).await })
    };
    first.page_event(
        PageLoadEvent::Finished,
        &Url::parse("https://first.example.test/ready").unwrap(),
    );
    tokio::task::yield_now().await;
    assert!(first_wait.is_finished());
    assert!(!second_wait.is_finished());

    second.page_event(
        PageLoadEvent::Finished,
        &Url::parse("https://second.example.test/ready").unwrap(),
    );
    let statuses = vec![
        first_wait.await.unwrap().status,
        second_wait.await.unwrap().status,
    ];
    assert_eq!(
        aggregate_workspace_web_readiness(&statuses),
        WorkspaceWebReadinessOutcome::Ready
    );
}

#[tokio::test]
async fn workspace_web_navigation_failure_degrades_the_complete_batch() {
    let ready = NavigationTracker::new_for_platform("macos");
    let ready_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_secs(1),
        "macos",
    );
    ready.begin_operation(&ready_operation).unwrap();
    ready.page_event(
        PageLoadEvent::Finished,
        &Url::parse("https://ready.example.test/").unwrap(),
    );

    let failed = NavigationTracker::new_for_platform("windows");
    let failed_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_secs(1),
        "windows",
    );
    failed.begin_operation(&failed_operation).unwrap();
    assert!(failed.native_navigation_started(71));
    assert!(failed.native_navigation_completed(
        71,
        false,
        Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED"),
    ));

    let statuses = vec![
        ready.wait_operation_async(ready_operation).await.status,
        failed.wait_operation_async(failed_operation).await.status,
    ];
    assert_eq!(
        aggregate_workspace_web_readiness(&statuses),
        WorkspaceWebReadinessOutcome::Degraded
    );
}

#[tokio::test]
async fn workspace_web_batch_degrades_immediately_when_a_later_surface_fails() {
    let lifecycle = Arc::new(ApplicationLifecycleCoordinator::new_for_platform("macos"));
    let operations = Arc::new(NativeOperationRegistry::default());
    let pending = Arc::new(NavigationTracker::new_for_platform("macos"));
    let failed = Arc::new(NavigationTracker::new_for_platform("windows"));
    let pending_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-pending",
        Duration::from_secs(5),
        "macos",
    );
    let failed_operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-failed",
        Duration::from_secs(5),
        "windows",
    );
    for operation in [&pending_operation, &failed_operation] {
        operations.register(operation.clone()).unwrap();
        assert!(operations.mark_in_flight(&operation.operation_id));
    }
    pending.begin_operation(&pending_operation).unwrap();
    failed.begin_operation(&failed_operation).unwrap();
    assert!(failed.native_navigation_started(83));
    assert!(failed.native_navigation_completed(
        83,
        false,
        Some("SYSTEM_NAVIGATION_WEBVIEW2_FAILED"),
    ));

    let receipts = tokio::time::timeout(
        Duration::from_millis(250),
        wait_workspace_web_navigation_batch(
            lifecycle,
            operations,
            0,
            vec![
                WorkspaceWebNavigationWait {
                    navigation: pending,
                    operation: pending_operation,
                },
                WorkspaceWebNavigationWait {
                    navigation: failed,
                    operation: failed_operation,
                },
            ],
        ),
    )
    .await
    .expect("an authoritative failure must not wait for the pending surface deadline");
    let statuses = receipts
        .iter()
        .map(|receipt| receipt.status)
        .collect::<Vec<_>>();
    assert_eq!(statuses[0], NativeOperationStatus::Superseded);
    assert_eq!(statuses[1], NativeOperationStatus::Failed);
    assert_eq!(
        aggregate_workspace_web_readiness(&statuses),
        WorkspaceWebReadinessOutcome::Degraded
    );
}

#[tokio::test]
async fn workspace_web_batch_interrupts_every_target_on_one_lifecycle_edge() {
    let lifecycle = Arc::new(ApplicationLifecycleCoordinator::new_for_platform("macos"));
    let operations = Arc::new(NativeOperationRegistry::default());
    let mut waits = Vec::new();
    for trigger in ["workspace-web-first", "workspace-web-second"] {
        let navigation = Arc::new(NavigationTracker::new_for_platform("macos"));
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            trigger,
            Duration::from_secs(5),
            "macos",
        )
        .with_lifecycle_epoch(0);
        operations.register(operation.clone()).unwrap();
        assert!(operations.mark_in_flight(&operation.operation_id));
        navigation.begin_operation(&operation).unwrap();
        waits.push(WorkspaceWebNavigationWait {
            navigation,
            operation,
        });
    }

    let batch = tokio::spawn(wait_workspace_web_navigation_batch(
        Arc::clone(&lifecycle),
        Arc::clone(&operations),
        0,
        waits,
    ));
    tokio::task::yield_now().await;
    lifecycle.suspended.store(true, Ordering::Release);
    lifecycle.transition(
        ApplicationLifecyclePhase::Suspending,
        1,
        "workspace-web-test-suspend",
    );
    operations.interrupt_for_lifecycle();

    let receipts = tokio::time::timeout(Duration::from_millis(250), batch)
        .await
        .expect("all navigation waiters must observe the same lifecycle edge")
        .unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts
        .iter()
        .all(|receipt| receipt.status == NativeOperationStatus::Indeterminate));
}

#[tokio::test]
async fn workspace_web_navigation_deadline_degrades_instead_of_becoming_ready() {
    let tracker = NavigationTracker::new_for_platform("macos");
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_millis(5),
        "macos",
    );
    tracker.begin_operation(&operation).unwrap();

    let receipt = tracker.wait_operation_async(operation).await;
    assert_eq!(receipt.status, NativeOperationStatus::Failed);
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("TAURI_NAVIGATION_FAILED")
    );
    assert_eq!(
        aggregate_workspace_web_readiness(&[receipt.status]),
        WorkspaceWebReadinessOutcome::Degraded
    );
}

#[tokio::test]
async fn close_supersede_makes_late_workspace_web_page_finish_ineffective() {
    let tracker = NavigationTracker::new_for_platform("macos");
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-test",
        Duration::from_secs(1),
        "macos",
    );
    tracker.begin_operation(&operation).unwrap();
    tracker.reset();
    tracker.page_event(
        PageLoadEvent::Finished,
        &Url::parse("https://late.example.test/").unwrap(),
    );

    let receipt = tracker.wait_operation_async(operation).await;
    assert_eq!(receipt.status, NativeOperationStatus::Superseded);
    assert_eq!(
        aggregate_workspace_web_readiness(&[receipt.status]),
        WorkspaceWebReadinessOutcome::Degraded
    );
}

#[tokio::test]
async fn loading_time_navigation_supersede_is_terminal_for_a_current_batch() {
    let lifecycle = Arc::new(ApplicationLifecycleCoordinator::new_for_platform("macos"));
    let operations = Arc::new(NativeOperationRegistry::default());
    let navigation = Arc::new(NavigationTracker::new_for_platform("macos"));
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        "workspace-web-loading-action",
        Duration::from_secs(1),
        "macos",
    );
    operations.register(operation.clone()).unwrap();
    assert!(operations.mark_in_flight(&operation.operation_id));
    navigation.begin_operation(&operation).unwrap();

    // Loading-time reload/home/navigate resets the initial tracker while the tab and
    // surface generation remain current. The coordinator must terminalize that launch.
    navigation.reset();
    let receipts = wait_workspace_web_navigation_batch(
        lifecycle,
        operations,
        0,
        vec![WorkspaceWebNavigationWait {
            navigation,
            operation,
        }],
    )
    .await;
    assert_eq!(receipts[0].status, NativeOperationStatus::Superseded);
    assert_eq!(
        aggregate_workspace_web_readiness(&[receipts[0].status]),
        WorkspaceWebReadinessOutcome::Degraded
    );
}
