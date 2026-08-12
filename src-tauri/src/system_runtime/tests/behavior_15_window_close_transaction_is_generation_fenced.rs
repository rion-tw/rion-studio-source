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
fn dormant_window_delete_bypasses_live_generation_teardown() {
    for platform in ["macos", "windows"] {
        let dormant = RuntimeWindowCloseOperation {
            label: None,
            native_expected: false,
            operation_id: format!("{platform}-dormant-delete"),
            should_execute: true,
        };
        assert!(dormant.is_state_only_delete(true), "{platform}");
        assert!(!dormant.is_state_only_delete(false), "{platform}");

        let live = RuntimeWindowCloseOperation {
            label: Some(format!("{platform}-runtime-window")),
            native_expected: true,
            operation_id: format!("{platform}-live-delete"),
            should_execute: true,
        };
        assert!(!live.is_state_only_delete(true), "{platform}");
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
fn late_tab_cleanup_cannot_recreate_a_fence_after_native_host_retirement() {
    for platform in ["macos", "windows"] {
        assert!(
            should_preserve_window_retirement_fence(Some(7), Some(7)),
            "{platform}: the exact live host needs a continuous retirement fence"
        );
        assert!(
            !should_preserve_window_retirement_fence(Some(7), Some(8)),
            "{platform}: a stale cleanup must not fence a newer generation"
        );
        assert!(
            !should_preserve_window_retirement_fence(Some(7), None),
            "{platform}: a late completion after host handoff or destruction must stay terminal"
        );
        assert!(
            !should_preserve_window_retirement_fence(None, Some(7)),
            "{platform}: an unfenced cleanup cannot establish window retirement"
        );
    }
}

#[test]
fn failed_native_cleanup_terminalizes_reopen_instead_of_waiting_forever() {
    let mut state = RuntimeState::default();
    state
        .retiring_window_tabs
        .insert("window-1".to_owned(), HashSet::new());
    state
        .quarantined_window_hosts
        .insert("window-1".to_owned());

    assert!(window_close_in_progress(&state, "window-1"));
    assert!(window_close_cleanup_failed(&state, "window-1"));
}

#[test]
fn native_absent_saved_tabs_retire_their_exact_window_close_tombstones() {
    for platform in ["macos", "windows"] {
        let mut state = RuntimeState::default();
        state
            .retiring_window_tabs
            .insert("window-1".to_owned(), HashSet::from(["saved-tab".to_owned()]));
        state.close_previews.insert(
            "saved-tab".to_owned(),
            TabCloseTombstone {
                kernel_operation_id: "kernel-close-1".to_owned(),
                parent_operation_id: Some("window-close-1".to_owned()),
                revision: 11,
                retirement_revision: None,
                slot_owners: Vec::new(),
                source_id: "saved-source".to_owned(),
                tab_type: "workspace".to_owned(),
                window_id: "window-1".to_owned(),
            },
        );
        let cleanup = RetiringTabCleanup {
            expected_kernel_operation_id: Some("kernel-close-1".to_owned()),
            parent_operation_id: "window-close-1".to_owned(),
            tab_id: "saved-tab".to_owned(),
            window_id: "window-1".to_owned(),
        };

        assert!(window_close_in_progress(&state, "window-1"), "{platform}");
        let Some(Some(tombstone)) =
            take_matching_absent_retiring_tab_tombstone(&mut state, &cleanup)
        else {
            panic!("{platform}: the exact native-absent tombstone must retire");
        };
        assert_eq!(tombstone.kernel_operation_id, "kernel-close-1", "{platform}");
        assert!(!state.close_previews.contains_key("saved-tab"), "{platform}");
        state.retiring_window_tabs.remove("window-1");
        assert!(
            !window_close_in_progress(&state, "window-1"),
            "{platform}: reopen must not wait after every authoritative close fence retired"
        );
    }
}

#[test]
fn stale_native_absent_cleanup_cannot_retire_a_newer_close_tombstone() {
    for platform in ["macos", "windows"] {
        let mut state = RuntimeState::default();
        state.close_previews.insert(
            "saved-tab".to_owned(),
            TabCloseTombstone {
                kernel_operation_id: "kernel-close-new".to_owned(),
                parent_operation_id: Some("window-close-new".to_owned()),
                revision: 12,
                retirement_revision: Some(8),
                slot_owners: Vec::new(),
                source_id: "saved-source".to_owned(),
                tab_type: "workspace".to_owned(),
                window_id: "window-1".to_owned(),
            },
        );
        let stale = RetiringTabCleanup {
            expected_kernel_operation_id: Some("kernel-close-old".to_owned()),
            parent_operation_id: "window-close-old".to_owned(),
            tab_id: "saved-tab".to_owned(),
            window_id: "window-1".to_owned(),
        };

        assert!(
            take_matching_absent_retiring_tab_tombstone(&mut state, &stale).is_none(),
            "{platform}"
        );
        assert_eq!(
            state
                .close_previews
                .get("saved-tab")
                .map(|tombstone| tombstone.kernel_operation_id.as_str()),
            Some("kernel-close-new"),
            "{platform}"
        );
    }
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
