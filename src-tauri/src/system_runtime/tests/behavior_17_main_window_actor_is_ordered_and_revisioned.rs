fn main_window_request_for_test(
    command: MainWindowCommand,
    sequence: u64,
) -> MainWindowRequest {
    let platform = if sequence.is_multiple_of(2) {
        "windows"
    } else {
        "macos"
    };
    let mut operation = if command.requests_focus() || command.awaits_window_state_event() {
        NativeOperationContext::new_event_bound_for_platform(
            NativeOperationSubsystem::Presentation,
            "main-window-actor-test",
            platform,
        )
    } else {
        NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "main-window-actor-test",
            Duration::from_secs(1),
            platform,
        )
    }
    .with_completion_scope(command.completion_scope());
    operation.operation_id = format!("main-window-test-{sequence}");
    MainWindowRequest {
        command,
        focus_lease: None,
        operation,
    }
}

fn main_window_semantic_state(
    visible: bool,
    focused: bool,
    maximized: bool,
    fullscreen: bool,
) -> MainWindowSemanticState {
    MainWindowSemanticState {
        focused,
        fullscreen,
        maximized,
        minimized: false,
        visible,
    }
}

fn minimized_main_window_semantic_state(
    visible: bool,
    focused: bool,
    maximized: bool,
    fullscreen: bool,
) -> MainWindowSemanticState {
    MainWindowSemanticState {
        minimized: true,
        ..main_window_semantic_state(visible, focused, maximized, fullscreen)
    }
}

#[test]
fn main_window_projection_reuses_an_identical_envelope_and_revisions_changes() {
    let projection = MainWindowStateProjection::new(23);
    let initial = main_window_semantic_state(true, false, false, false);
    let (first, changed) = projection.commit_observation(initial.clone()).unwrap();
    assert!(changed);
    assert_eq!(first.revision, 1);
    assert_eq!(first.window_generation, 23);

    let (replayed, changed) = projection.commit_observation(initial.clone()).unwrap();
    assert!(!changed);
    assert_eq!(replayed, first);

    let (focused, changed) = projection
        .commit_observation(MainWindowSemanticState {
            focused: true,
            ..initial.clone()
        })
        .unwrap();
    assert!(changed);
    assert_eq!(focused.revision, 2);
    assert!(focused.focused);

    projection.lifecycle_epoch.store(4, Ordering::Release);
    let (new_epoch, changed) = projection
        .commit_observation(MainWindowSemanticState {
            focused: true,
            ..initial
        })
        .unwrap();
    assert!(changed);
    assert_eq!(new_epoch.revision, 3);
    assert_eq!(new_epoch.lifecycle_epoch, 4);
}

#[test]
fn main_window_queue_is_bounded_fifo_and_rejects_work_after_stop() {
    let mut state = MainWindowActorState::default();
    for sequence in 0..MAIN_WINDOW_ACTOR_CAPACITY as u64 {
        state
            .enqueue(main_window_request_for_test(
                MainWindowCommand::ToggleFullscreen,
                sequence,
            ))
            .unwrap();
    }
    assert_eq!(
        state.enqueue(main_window_request_for_test(
            MainWindowCommand::ToggleFullscreen,
            100,
        )),
        Err(MainWindowQueueError::Full)
    );
    let ids = state
        .requests
        .drain(..)
        .map(|request| request.operation.operation_id)
        .collect::<Vec<_>>();
    assert_eq!(ids.first().map(String::as_str), Some("main-window-test-0"));
    assert_eq!(
        ids.last().map(String::as_str),
        Some("main-window-test-63")
    );

    state.stopped = true;
    assert_eq!(
        state.enqueue(main_window_request_for_test(MainWindowCommand::Hide, 101)),
        Err(MainWindowQueueError::Stopped)
    );
}

#[test]
fn hide_lifecycle_and_shutdown_drain_each_focus_continuation_exactly_once() {
    let mut state = MainWindowActorState::default();
    let queued = main_window_request_for_test(MainWindowCommand::Show { focus: true }, 201);
    let pending = main_window_request_for_test(MainWindowCommand::Show { focus: true }, 202);
    let active = pending.operation.clone();
    state.requests.push_back(queued.clone());
    state.pending_focus = Some(pending);
    state.active_focus_operation = Some(active);

    let drained = state.take_focus_operations();
    assert_eq!(drained.len(), 2);
    assert!(drained
        .iter()
        .all(|operation| operation.completion_policy == OperationCompletionPolicy::EventBound));
    assert!(drained
        .iter()
        .all(|operation| operation.deadline.is_none() && operation.timeout.is_none()));
    assert_eq!(
        drained
            .iter()
            .filter(|operation| operation.operation_id == queued.operation.operation_id)
            .count(),
        1
    );
    assert!(state.requests.is_empty());
    assert!(state.pending_focus.is_none());
    assert!(state.active_focus_operation.is_none());
    assert!(state.take_focus_operations().is_empty());
}

#[test]
fn main_window_readback_guarantees_match_on_macos_and_windows() {
    for (platform, is_windows) in [("macos", false), ("windows", true)] {
        let before = main_window_semantic_state(true, false, false, false);
        let hidden = main_window_semantic_state(false, false, false, false);
        let minimized = minimized_main_window_semantic_state(true, false, false, false);
        let hidden_minimized = minimized_main_window_semantic_state(false, false, false, false);
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::Hide,
            &before,
            if is_windows { &minimized } else { &hidden },
            is_windows,
        ), "{platform}");
        assert!(!main_window_readback_matches_for_platform(
            MainWindowCommand::Hide,
            &before,
            if is_windows { &hidden } else { &minimized },
            is_windows,
        ), "{platform}");
        if is_windows {
            assert!(!main_window_readback_matches_for_platform(
                MainWindowCommand::Hide,
                &before,
                &hidden_minimized,
                is_windows,
            ), "{platform}");
        }
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::Minimize,
            &before,
            &minimized,
            is_windows,
        ), "{platform}");
        assert!(!main_window_readback_matches_for_platform(
            MainWindowCommand::Minimize,
            &before,
            &hidden,
            is_windows,
        ), "{platform}");
        assert!(!main_window_readback_matches_for_platform(
            MainWindowCommand::Minimize,
            &before,
            &hidden_minimized,
            is_windows,
        ), "{platform}");
        assert!(!main_window_readback_matches_for_platform(
            MainWindowCommand::Show { focus: false },
            &before,
            &main_window_semantic_state(false, false, false, false),
            is_windows,
        ), "{platform}");
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::Show { focus: false },
            &before,
            &main_window_semantic_state(true, false, false, false),
            is_windows,
        ), "{platform}");
        assert!(MainWindowCommand::Show { focus: true }.requests_focus());
        assert!(!MainWindowCommand::StartDragging.requests_focus());
        assert!(!MainWindowCommand::StartDragging.awaits_window_state_event());
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::StartDragging,
            &before,
            &before,
            is_windows,
        ), "{platform}");
        let drag = main_window_request_for_test(MainWindowCommand::StartDragging, 299);
        assert_eq!(
            drag.operation.completion_policy,
            OperationCompletionPolicy::DeadlineBound
        );
        assert_eq!(
            drag.operation.completion_scope,
            SystemRuntimeOperationCompletionScope::NativeSubmission
        );
        assert!(drag.focus_lease.is_none());
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::ToggleFullscreen,
            &before,
            &main_window_semantic_state(true, false, false, true),
            is_windows,
        ), "{platform}");
        assert!(!main_window_readback_matches_for_platform(
            MainWindowCommand::ToggleMaximized,
            &before,
            &main_window_semantic_state(true, false, true, false),
            is_windows,
        ), "{platform}");
        assert!(!MainWindowCommand::ToggleMaximized.requests_focus());
        assert!(MainWindowCommand::ToggleMaximized.awaits_window_state_event());
        let request = main_window_request_for_test(MainWindowCommand::ToggleMaximized, 300);
        assert_eq!(
            request.operation.completion_policy,
            OperationCompletionPolicy::EventBound
        );
        assert!(request.operation.deadline.is_none() && request.operation.timeout.is_none());
    }
}

#[test]
fn already_focused_main_window_resolves_without_a_new_event_bound_focus_operation() {
    let broker = NativeFocusBroker::default();
    broker
        .observe_native_focus("main", 17, 4, None)
        .expect("the authoritative focus event establishes the main-window projection");

    let command = resolve_main_window_command(
        &broker,
        MainWindowCommand::Show { focus: true },
        17,
        4,
        NativeFocusIntentOrigin::UserGesture,
    );
    assert_eq!(command, MainWindowCommand::Show { focus: false });
    assert!(!command.requests_focus());

    let stale_generation = resolve_main_window_command(
        &broker,
        MainWindowCommand::Show { focus: true },
        18,
        4,
        NativeFocusIntentOrigin::UserGesture,
    );
    assert!(stale_generation.requests_focus());
}

#[test]
fn delayed_focus_event_completes_the_exact_event_bound_lease_once() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let lease = broker.accept(
        "main",
        17,
        4,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    assert!(broker.mark_submitted(&lease));
    let mut operation = NativeOperationContext::new_event_bound_for_platform(
        NativeOperationSubsystem::Presentation,
        "focus-test",
        "macos",
    )
    .with_window("main")
    .with_window_generation(17)
    .with_lifecycle_epoch(4);
    operation.operation_id = "focus-event-bound".to_owned();
    let registry = NativeOperationRegistry::default();
    registry.register(operation.clone()).unwrap();
    assert!(registry.mark_in_flight(&operation.operation_id));

    let observed = broker
        .observe_native_focus("main", 17, 4, None)
        .expect("the submitted lease matches the native focus event");
    assert_eq!(observed, lease);
    let applied = registry.complete(NativeOperationReceipt::applied(
        operation.clone(),
        "mainWindowFocused",
    ));
    assert_eq!(applied.status, NativeOperationStatus::Applied);

    let late = registry.complete(NativeOperationReceipt::with_status(
        operation,
        "lateFocusEvent",
        NativeOperationStatus::Failed,
        Some("LATE_EVENT"),
    ));
    assert_eq!(late.status, NativeOperationStatus::Applied);
    assert_eq!(late.stage, "mainWindowFocused");
}

#[test]
fn reentrant_focus_event_before_pending_install_completes_the_exact_operation() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let lease = broker.accept(
        "main",
        17,
        4,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    let mut request = main_window_request_for_test(
        MainWindowCommand::Show { focus: true },
        301,
    );
    request.focus_lease = Some(lease.clone());
    request.operation.window_id = Some("main".to_owned());
    request.operation.window_generation = Some(17);
    request.operation.lifecycle_epoch = Some(4);
    let registry = NativeOperationRegistry::default();
    registry.register(request.operation.clone()).unwrap();
    assert!(registry.mark_in_flight(&request.operation.operation_id));

    assert!(broker.mark_submitted(&lease));
    assert_eq!(
        broker.observe_native_focus("main", 17, 4, None),
        Some(lease)
    );
    let queue = Arc::new((
        Mutex::new(MainWindowActorState::default()),
        Condvar::new(),
    ));
    MainWindowActor::install_pending_focus(&queue, &registry, &broker, request.clone());

    let receipt = registry
        .terminal(&request.operation.operation_id)
        .expect("the early authoritative event completes after pending installation");
    assert_eq!(receipt.status, NativeOperationStatus::Applied);
    assert_eq!(receipt.stage, "mainWindowFocused");
    assert!(queue.0.lock().unwrap().pending_focus.is_none());
}

#[test]
fn pending_main_window_observer_does_not_occupy_following_operation_work() {
    let registry = Arc::new(NativeOperationRegistry::default());
    let mut open = NativeOperationContext::new_event_bound_for_platform(
        NativeOperationSubsystem::Presentation,
        "overlay-open-macro-page",
        "windows",
    );
    open.operation_id = "pending-overlay-open".to_owned();
    registry.register(open.clone()).unwrap();
    assert!(registry.mark_in_flight(&open.operation_id));

    let observer_registry = Arc::clone(&registry);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let observer_barrier = Arc::clone(&barrier);
    let open_operation_id = open.operation_id.clone();
    let observer = thread::spawn(move || {
        observer_barrier.wait();
        wait_main_window_presentation_failure(&observer_registry, &open_operation_id)
    });
    barrier.wait();

    let mut copy = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Presentation,
        "overlay-copy-coordinate",
        Duration::from_secs(1),
        "windows",
    );
    copy.operation_id = "following-overlay-copy".to_owned();
    registry.register(copy.clone()).unwrap();
    assert!(registry.mark_in_flight(&copy.operation_id));
    let copy_receipt = registry.complete(NativeOperationReceipt::applied(
        copy,
        "overlayCoordinateCopied",
    ));
    assert_eq!(copy_receipt.status, NativeOperationStatus::Applied);
    assert!(registry.terminal(&open.operation_id).is_none());

    registry.complete(NativeOperationReceipt::applied(open, "mainWindowFocused"));
    assert_eq!(observer.join().unwrap(), None);
}

#[test]
fn main_window_presentation_observer_handles_every_terminal_status() {
    let statuses = [
        (NativeOperationStatus::Applied, false),
        (NativeOperationStatus::Superseded, false),
        (NativeOperationStatus::Cancelled, true),
        (NativeOperationStatus::Degraded, true),
        (NativeOperationStatus::Failed, true),
        (NativeOperationStatus::Indeterminate, true),
    ];
    for (index, (status, fails)) in statuses.into_iter().enumerate() {
        let registry = NativeOperationRegistry::default();
        let mut operation = NativeOperationContext::new_event_bound_for_platform(
            NativeOperationSubsystem::Presentation,
            "overlay-open-macro-page",
            "windows",
        );
        operation.operation_id = format!("presentation-terminal-{index}");
        registry.register(operation.clone()).unwrap();
        registry.complete(NativeOperationReceipt::with_status(
            operation.clone(),
            "presentationTerminal",
            status,
            fails.then_some("PRESENTATION_TERMINAL_FAILURE"),
        ));
        assert_eq!(
            wait_main_window_presentation_failure(&registry, &operation.operation_id),
            fails.then(|| "PRESENTATION_TERMINAL_FAILURE".to_owned())
        );
    }

    let registry = NativeOperationRegistry::default();
    assert_eq!(
        wait_main_window_presentation_failure(&registry, "missing-operation"),
        Some("SYSTEM_NATIVE_OPERATION_NOT_FOUND".to_owned())
    );
}

#[test]
fn newer_focus_intent_supersedes_the_old_lease_before_submission() {
    let broker = NativeFocusBroker::default();
    broker.observe_application_foreground();
    let old = broker.accept(
        "main",
        17,
        4,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    let replacement = broker.accept(
        "main",
        17,
        4,
        None,
        NativePresentationFocus::WindowAndContent,
    );
    assert!(!broker.mark_submitted(&old));
    assert!(broker.mark_submitted(&replacement));
    assert_eq!(
        broker.observe_native_focus("main", 17, 4, None),
        Some(replacement)
    );
}
