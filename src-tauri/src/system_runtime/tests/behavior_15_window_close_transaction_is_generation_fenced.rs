fn close_transaction(
    operation: NativeOperationContext,
    label: Option<&str>,
    generation: Option<u64>,
) -> WindowCloseTransaction {
    WindowCloseTransaction {
        context: operation,
        generation,
        label: label.map(str::to_owned),
        native_submitted: false,
        window_id: "window-1".to_owned(),
    }
}

#[test]
fn duplicate_window_close_uses_one_operation_until_it_is_terminal() {
    for platform in ["macos", "windows"] {
        let mut ledger = WindowCloseLedger::default();
        let first = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::WindowLifecycle,
            "os-close-requested",
            Duration::from_secs(5),
            platform,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeDestroyed)
        .with_window_generation(7)
        .with_window("window-1");
        let first_id = first.operation_id.clone();
        ledger
            .insert(close_transaction(first, Some("runtime-window-1"), Some(7)))
            .unwrap();
        let duplicate = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::WindowLifecycle,
            "renderer-stop-window",
            Duration::from_secs(5),
            platform,
        );

        assert_eq!(
            ledger.pending_operation_id("runtime-window-1").as_deref(),
            Some(first_id.as_str()),
            "{platform}"
        );
        assert_eq!(
            ledger.insert(close_transaction(
                duplicate,
                Some("runtime-window-1"),
                Some(7),
            )),
            Err("SYSTEM_WINDOW_CLOSE_ALREADY_PENDING"),
            "{platform}"
        );
        assert_eq!(
            ledger.take_destroyed("another-window"),
            None,
            "{platform}"
        );
        let destroyed = ledger.take_destroyed("runtime-window-1").unwrap();
        assert_eq!(destroyed.context.operation_id, first_id, "{platform}");
        assert_eq!(destroyed.generation, Some(7), "{platform}");
        assert_eq!(ledger.pending_operation_id("runtime-window-1"), None);
    }
}

#[test]
fn post_submission_failure_is_indeterminate_only_after_the_exact_generation_is_gone() {
    for platform in ["macos", "windows"] {
        assert_eq!(
            window_close_failure_status(false, true),
            NativeOperationStatus::Failed,
            "{platform}"
        );
        assert_eq!(
            window_close_failure_status(true, true),
            NativeOperationStatus::Failed,
            "{platform}"
        );
        assert_eq!(
            window_close_failure_status(true, false),
            NativeOperationStatus::Indeterminate,
            "{platform}"
        );
    }
}

#[test]
fn retired_native_host_blocks_reopen_until_destroyed() {
    let mut state = RuntimeState::default();
    state
        .retiring_window_tabs
        .insert("window-1".to_owned(), HashSet::new());
    assert!(window_close_in_progress(&state, "window-1"));
    state.retiring_window_tabs.remove("window-1");

    state.retiring_native_window_hosts.insert(
        "runtime-window-1".to_owned(),
        RetiringNativeWindowHost {
            generation: 7,
            window_id: "window-1".to_owned(),
        },
    );

    assert!(window_close_in_progress(&state, "window-1"));
    state
        .retiring_native_window_hosts
        .remove("runtime-window-1");
    assert!(!window_close_in_progress(&state, "window-1"));
}

#[test]
fn destroyed_host_surface_completion_is_window_and_generation_fenced() {
    assert!(destroyed_host_surface_identity_matches(
        "window-1", 7, "window-1", 7
    ));
    assert!(!destroyed_host_surface_identity_matches(
        "window-1", 6, "window-1", 7
    ));
    assert!(!destroyed_host_surface_identity_matches(
        "window-2", 7, "window-1", 7
    ));
    assert!(destroyed_host_surface_close_is_pending(
        true,
        ManagedSurfacePhase::Live
    ));
    assert!(destroyed_host_surface_close_is_pending(
        false,
        ManagedSurfacePhase::Isolating
    ));
    assert!(!destroyed_host_surface_close_is_pending(
        false,
        ManagedSurfacePhase::Live
    ));
}
