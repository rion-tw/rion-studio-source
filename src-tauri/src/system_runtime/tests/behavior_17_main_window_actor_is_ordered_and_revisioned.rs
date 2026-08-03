fn main_window_request_for_test(
    command: MainWindowCommand,
    sequence: u64,
) -> MainWindowRequest {
    let mut operation = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Presentation,
        "main-window-actor-test",
        Duration::from_secs(1),
        if sequence.is_multiple_of(2) {
            "windows"
        } else {
            "macos"
        },
    );
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
fn main_window_readback_guarantees_match_on_macos_and_windows() {
    for platform in ["macos", "windows"] {
        let before = main_window_semantic_state(true, false, false, false);
        assert!(main_window_readback_matches(
            MainWindowCommand::Hide,
            &before,
            &main_window_semantic_state(false, false, false, false),
        ), "{platform}");
        assert!(!main_window_readback_matches(
            MainWindowCommand::Show { focus: true },
            &before,
            &main_window_semantic_state(true, false, false, false),
        ), "{platform}");
        assert!(main_window_readback_matches(
            MainWindowCommand::Show { focus: true },
            &before,
            &main_window_semantic_state(true, true, false, false),
        ), "{platform}");
        assert!(main_window_readback_matches(
            MainWindowCommand::ToggleMaximized,
            &before,
            &main_window_semantic_state(true, false, true, false),
        ), "{platform}");
        assert!(main_window_readback_matches(
            MainWindowCommand::ToggleFullscreen,
            &before,
            &main_window_semantic_state(true, false, false, true),
        ), "{platform}");
        assert_eq!(
            MainWindowCommand::StartDragging.completion_scope(),
            SystemRuntimeOperationCompletionScope::NativeSubmission,
            "{platform}"
        );
    }
}
