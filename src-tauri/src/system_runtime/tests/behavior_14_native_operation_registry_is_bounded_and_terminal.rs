fn registry_operation(timeout: Duration) -> NativeOperationContext {
    NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Presentation,
        "registry-test",
        timeout,
        "windows",
    )
    .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
}

#[test]
fn operation_id_is_stable_and_wait_works_before_and_after_completion() {
    let registry = Arc::new(NativeOperationRegistry::default());
    let operation = registry_operation(Duration::from_secs(1));
    let operation_id = operation.operation_id.clone();
    registry.register(operation.clone()).unwrap();

    let completing_registry = Arc::clone(&registry);
    let completing_operation = operation.clone();
    let (release, released) = mpsc::channel();
    let worker = thread::spawn(move || {
        released.recv().unwrap();
        completing_registry.complete(NativeOperationReceipt::applied(
            completing_operation,
            "nativePresentation",
        ));
    });
    release.send(()).unwrap();
    let first = registry.wait(&operation_id).unwrap();
    worker.join().unwrap();
    let second = registry.wait(&operation_id).unwrap();

    assert_eq!(first.context.operation_id, operation_id);
    assert_eq!(second, first);
    assert_eq!(first.completion_scope(), SystemRuntimeOperationCompletionScope::NativeAcknowledgement);
}

#[test]
fn first_terminal_receipt_wins_over_late_callbacks() {
    let registry = NativeOperationRegistry::default();
    let operation = registry_operation(Duration::from_secs(1));
    registry.register(operation.clone()).unwrap();
    let first = registry.complete(NativeOperationReceipt::with_status(
        operation.clone(),
        "nativePresentationQueued",
        NativeOperationStatus::Superseded,
        None,
    ));
    let late = registry.complete(NativeOperationReceipt::applied(
        operation,
        "nativePresentation",
    ));

    assert_eq!(first.status, NativeOperationStatus::Superseded);
    assert_eq!(late, first);
}

#[test]
fn v8_operation_metadata_and_cancelled_receipts_are_frozen_at_acceptance() {
    for platform in ["macos", "windows"] {
        let registry = NativeOperationRegistry::default();
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::WindowLifecycle,
            "v8-metadata-test",
            Duration::from_secs(1),
            platform,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::PolicyDecision)
        .with_revision(11)
        .with_window_generation(13)
        .with_lifecycle_epoch(14)
        .with_window("window-1");
        let operation_id = operation.operation_id.clone();
        let accepted_at = operation.accepted_at.clone();
        let deadline_at = operation.deadline_at.clone();
        registry.register(operation.clone()).unwrap();
        let receipt = registry.complete(NativeOperationReceipt::with_status(
            operation,
            "policyCancelled",
            NativeOperationStatus::Cancelled,
            None,
        ));
        let summary = receipt.summary();

        assert_eq!(summary.status, SystemRuntimeOperationStatus::Cancelled, "{platform}");
        assert_eq!(summary.operation_id, operation_id, "{platform}");
        assert_eq!(summary.accepted_at, accepted_at, "{platform}");
        assert_eq!(summary.deadline_at, deadline_at, "{platform}");
        assert_eq!(summary.completion_scope, SystemRuntimeOperationCompletionScope::PolicyDecision, "{platform}");
        assert_eq!(summary.revision, Some(11), "{platform}");
        assert_eq!(summary.topology_revision, None, "{platform}");
        assert_eq!(summary.window_generation, Some(13), "{platform}");
        assert_eq!(summary.lifecycle_epoch, Some(14), "{platform}");
        assert_eq!(summary.parent_operation_id, None);
        assert_eq!(summary.session_id, None);
    }
}

#[test]
fn latest_only_and_ordered_presentation_work_complete_their_original_receipts() {
    for platform in ["macos", "windows"] {
        let registry = NativeOperationRegistry::default();
        let mut latest = NativePresentationQueue::default();
        let first = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "latest-first",
            Duration::from_secs(1),
            platform,
        );
        let second = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "latest-second",
            Duration::from_secs(1),
            platform,
        );
        registry.register(first.clone()).unwrap();
        registry.register(second.clone()).unwrap();
        assert!(latest.enqueue_latest(first).unwrap().is_none());
        let superseded = latest.enqueue_latest(second.clone()).unwrap().unwrap();
        registry.complete(NativeOperationReceipt::with_status(
            superseded.clone(),
            "nativePresentationQueued",
            NativeOperationStatus::Superseded,
            None,
        ));
        let scheduled = latest.begin_next().unwrap();
        assert_eq!(scheduled.operation_id, second.operation_id);
        assert!(registry.mark_in_flight(&scheduled.operation_id));
        registry.complete(NativeOperationReceipt::applied(
            scheduled,
            "nativePresentation",
        ));
        latest.finish();
        assert_eq!(
            registry.wait(&superseded.operation_id).unwrap().status,
            NativeOperationStatus::Superseded,
            "{platform}"
        );
        assert_eq!(
            registry.wait(&second.operation_id).unwrap().status,
            NativeOperationStatus::Applied,
            "{platform}"
        );

        let mut ordered = NativePresentationQueue::default();
        let toggles = (0..3)
            .map(|_| {
                NativeOperationContext::new_for_platform(
                    NativeOperationSubsystem::Presentation,
                    "ordered-toggle",
                    Duration::from_secs(1),
                    platform,
                )
            })
            .collect::<Vec<_>>();
        for toggle in &toggles {
            registry.register(toggle.clone()).unwrap();
            ordered.enqueue_ordered(toggle.clone()).unwrap();
        }
        for toggle in &toggles {
            let scheduled = ordered.begin_next().unwrap();
            assert_eq!(scheduled.operation_id, toggle.operation_id);
            assert!(registry.mark_in_flight(&scheduled.operation_id));
            registry.complete(NativeOperationReceipt::applied(
                scheduled,
                "nativeWindowModeApplied",
            ));
            ordered.finish();
        }
        for toggle in toggles {
            assert_eq!(
                registry.wait(&toggle.operation_id).unwrap().status,
                NativeOperationStatus::Applied,
                "{platform}"
            );
        }
    }
}

#[test]
fn queue_full_and_actor_stop_complete_receipts_without_fake_success() {
    for platform in ["macos", "windows"] {
        let registry = NativeOperationRegistry::default();
        let mut queue = NativePresentationQueue::default();
        let mut queued_ids = Vec::new();
        for _ in 0..NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY {
            let operation = NativeOperationContext::new_for_platform(
                NativeOperationSubsystem::Presentation,
                "queued-control",
                Duration::from_secs(1),
                platform,
            );
            queued_ids.push(operation.operation_id.clone());
            registry.register(operation.clone()).unwrap();
            queue.enqueue_ordered(operation).unwrap();
        }
        let overflow = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "queue-overflow",
            Duration::from_secs(1),
            platform,
        );
        let overflow_id = overflow.operation_id.clone();
        registry.register(overflow.clone()).unwrap();
        let rejected = queue.enqueue_ordered(overflow).unwrap_err();
        registry.complete(NativeOperationReceipt::with_status(
            rejected,
            "nativePresentationQueueFull",
            NativeOperationStatus::Failed,
            Some("NATIVE_PRESENTATION_QUEUE_FULL"),
        ));

        for stopped in queue.drain() {
            registry.complete(NativeOperationReceipt::with_status(
                stopped,
                "nativePresentationStopped",
                NativeOperationStatus::Superseded,
                None,
            ));
        }
        assert_eq!(
            registry.wait(&overflow_id).unwrap().status,
            NativeOperationStatus::Failed,
            "{platform}"
        );
        for operation_id in queued_ids {
            let receipt = registry.wait(&operation_id).unwrap();
            assert_eq!(receipt.status, NativeOperationStatus::Superseded, "{platform}");
            assert_eq!(receipt.failure_code, None, "{platform}");
        }
    }
}

#[test]
fn active_operations_are_never_evicted_for_capacity() {
    let registry = NativeOperationRegistry::default();
    let first = registry_operation(Duration::from_secs(5));
    registry.register(first.clone()).unwrap();
    for _ in 1..ACTIVE_NATIVE_OPERATION_CAPACITY {
        registry.register(registry_operation(Duration::from_secs(5))).unwrap();
    }
    assert_eq!(registry.active_count(), ACTIVE_NATIVE_OPERATION_CAPACITY);
    assert_eq!(
        registry.register(first),
        Err("SYSTEM_NATIVE_OPERATION_ID_CONFLICT")
    );
    assert_eq!(
        registry.register(registry_operation(Duration::from_secs(5))),
        Err("SYSTEM_NATIVE_OPERATION_REGISTRY_FULL")
    );
    assert_eq!(registry.active_count(), ACTIVE_NATIVE_OPERATION_CAPACITY);
}

#[test]
fn repeated_platform_operation_cycles_leave_the_active_registry_empty() {
    for platform in ["macos", "windows"] {
        let registry = NativeOperationRegistry::default();
        for cycle in 0..5_000 {
            let operation = NativeOperationContext::new_for_platform(
                NativeOperationSubsystem::Presentation,
                "registry-stress",
                Duration::from_secs(1),
                platform,
            )
            .with_completion_scope(
                SystemRuntimeOperationCompletionScope::NativeAcknowledgement,
            );
            assert!(registry.register(operation.clone()).is_ok(), "{platform} {cycle}");
            assert!(registry.mark_in_flight(&operation.operation_id));
            registry.complete(NativeOperationReceipt::applied(
                operation,
                "registryStressCompleted",
            ));
        }
        assert_eq!(registry.active_count(), 0, "{platform}");
    }
}

#[test]
fn navigation_is_rejected_before_input_mutation_when_the_registry_is_full() {
    let registry = NativeOperationRegistry::default();
    for _ in 0..ACTIVE_NATIVE_OPERATION_CAPACITY {
        registry
            .register(registry_operation(Duration::from_secs(5)))
            .unwrap();
    }
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Navigation,
        NavigationInputFenceSource::MainFrame.trigger(),
        Duration::from_secs(5),
        "windows",
    )
    .with_completion_scope(SystemRuntimeOperationCompletionScope::InputReady)
    .with_role("role-1")
    .with_surface_generation(7);
    let operation_id = operation.operation_id.clone();

    let error = accept_navigation_input_operation(&registry, &operation).unwrap_err();

    assert_eq!(error.code, "SYSTEM_NATIVE_OPERATION_REGISTRY_FULL");
    let receipt = registry.wait(&operation_id).unwrap();
    assert_eq!(receipt.status, NativeOperationStatus::Failed);
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("SYSTEM_NATIVE_OPERATION_REGISTRY_FULL")
    );
    assert_eq!(registry.active_count(), ACTIVE_NATIVE_OPERATION_CAPACITY);
}

#[test]
fn queued_and_in_flight_deadlines_have_distinct_terminal_statuses() {
    for platform in ["macos", "windows"] {
        let queued_registry = NativeOperationRegistry::default();
        let queued = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "registry-test",
            Duration::ZERO,
            platform,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement);
        let queued_id = queued.operation_id.clone();
        queued_registry.register(queued).unwrap();
        let queued_receipt = queued_registry.wait(&queued_id).unwrap();
        assert_eq!(queued_receipt.status, NativeOperationStatus::Failed, "{platform}");

        let in_flight_registry = NativeOperationRegistry::default();
        let in_flight = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "registry-test",
            Duration::ZERO,
            platform,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement);
        let in_flight_id = in_flight.operation_id.clone();
        in_flight_registry.register(in_flight).unwrap();
        assert!(in_flight_registry.mark_in_flight(&in_flight_id));
        let in_flight_receipt = in_flight_registry.wait(&in_flight_id).unwrap();
        assert_eq!(
            in_flight_receipt.status,
            NativeOperationStatus::Indeterminate,
            "{platform}"
        );
    }
}

#[test]
fn a_late_native_callback_cannot_turn_an_in_flight_timeout_into_success() {
    let registry = NativeOperationRegistry::default();
    let operation = registry_operation(Duration::ZERO);
    let operation_id = operation.operation_id.clone();
    registry.register(operation.clone()).unwrap();
    assert!(registry.mark_in_flight(&operation_id));

    let receipt = registry.complete(NativeOperationReceipt::applied(
        operation,
        "nativePresentation",
    ));
    assert_eq!(receipt.status, NativeOperationStatus::Indeterminate);
    assert_eq!(
        registry.wait(&operation_id).unwrap().failure_code.as_deref(),
        Some("NATIVE_OPERATION_INDETERMINATE")
    );
}

#[test]
fn background_tab_presentation_timeout_is_superseded_without_user_error() {
    let registry = NativeOperationRegistry::default();
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Presentation,
        "launcher-external",
        Duration::ZERO,
        "macos",
    )
    .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement);
    let operation_id = operation.operation_id.clone();
    registry.register(operation).unwrap();
    assert!(registry.mark_in_flight(&operation_id));

    let receipt = registry.wait(&operation_id).unwrap();
    assert_eq!(receipt.status, NativeOperationStatus::Superseded);
    assert_eq!(receipt.stage, "backgroundLiveTabRecordSuperseded");
    assert_eq!(receipt.failure_code, None);
}

#[test]
fn terminal_receipt_history_is_bounded() {
    let registry = NativeOperationRegistry::default();
    for _ in 0..(RECENT_NATIVE_OPERATION_CAPACITY + 5) {
        let operation = registry_operation(Duration::from_secs(1));
        registry.register(operation.clone()).unwrap();
        registry.complete(NativeOperationReceipt::applied(
            operation,
            "nativePresentation",
        ));
    }
    assert_eq!(
        registry.recent_summaries().len(),
        RECENT_NATIVE_OPERATION_CAPACITY
    );
}

#[test]
fn evicted_terminal_operations_reject_late_tracked_callbacks() {
    let registry = NativeOperationRegistry::default();
    let operation = registry_operation(Duration::from_secs(1));
    let operation_id = operation.operation_id.clone();
    registry.register(operation.clone()).unwrap();
    registry.complete(NativeOperationReceipt::with_status(
        operation.clone(),
        "nativePresentationQueued",
        NativeOperationStatus::Superseded,
        None,
    ));
    for _ in 0..=RECENT_NATIVE_OPERATION_CAPACITY {
        let next = registry_operation(Duration::from_secs(1));
        registry.register(next.clone()).unwrap();
        registry.complete(NativeOperationReceipt::applied(next, "nativePresentation"));
    }

    assert_eq!(
        registry.wait(&operation_id),
        Err("SYSTEM_NATIVE_OPERATION_NOT_FOUND")
    );
    registry.complete(NativeOperationReceipt::applied(
        operation,
        "nativePresentation",
    ));
    assert_eq!(
        registry.wait(&operation_id),
        Err("SYSTEM_NATIVE_OPERATION_NOT_FOUND")
    );
}

#[test]
fn repeated_shutdown_waiters_observe_the_same_terminal_receipt() {
    let registry = NativeOperationRegistry::default();
    let operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Shutdown,
        "closeAll",
        Duration::from_secs(1),
        "macos",
    )
    .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement);
    registry.register(operation.clone()).unwrap();
    let terminal = registry.complete(NativeOperationReceipt::applied(
        operation.clone(),
        "shutdownClosed",
    ));

    let first = registry.wait(&operation.operation_id).unwrap();
    for _ in 0..(RECENT_NATIVE_OPERATION_CAPACITY + 5) {
        let next = registry_operation(Duration::from_secs(1));
        registry.register(next.clone()).unwrap();
        registry.complete(NativeOperationReceipt::applied(next, "nativePresentation"));
    }
    let repeated = registry.wait(&operation.operation_id).unwrap();
    assert_eq!(first, terminal);
    assert_eq!(repeated, terminal);
    assert_eq!(registry.recent_summaries().len(), RECENT_NATIVE_OPERATION_CAPACITY);
}
