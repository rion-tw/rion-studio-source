fn main_window_request_for_test(
    command: MainWindowCommand,
    sequence: u64,
) -> MainWindowRequest {
    let platform = if sequence.is_multiple_of(2) {
        "windows"
    } else {
        "macos"
    };
    let mut operation = if command.requests_focus() {
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
    };
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
                MainWindowCommand::ToggleMaximized,
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
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::ToggleMaximized,
            &before,
            &main_window_semantic_state(true, false, true, false),
            is_windows,
        ), "{platform}");
        assert!(main_window_readback_matches_for_platform(
            MainWindowCommand::ToggleFullscreen,
            &before,
            &main_window_semantic_state(true, false, false, true),
            is_windows,
        ), "{platform}");
        assert_eq!(
            MainWindowCommand::StartDragging.completion_scope(),
            SystemRuntimeOperationCompletionScope::NativeSubmission,
            "{platform}"
        );
    }
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
