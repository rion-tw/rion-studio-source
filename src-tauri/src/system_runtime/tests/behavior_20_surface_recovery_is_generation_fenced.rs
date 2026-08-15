#[test]
fn surface_recovery_attempts_replay_exactly_and_keep_parent_metadata() {
    for platform in ["macos", "windows"] {
        let registry = SurfaceRecoveryRegistry::default();
        let context = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Recovery,
            "processFailure",
            Duration::from_secs(1),
            platform,
        )
        .with_parent_operation_id("native-navigation-parent")
        .with_role("role-1")
        .with_window("window-1")
        .with_surface_generation(7)
        .with_lifecycle_epoch(3);
        let operation_id = context.operation_id.clone();
        let started = registry.begin(
            context,
            "role-1".to_owned(),
            "window-1".to_owned(),
            7,
            3,
        );
        let SurfaceRecoveryBegin::Started(_, initial) = started else {
            panic!("{platform}: recovery must start");
        };
        assert_eq!(initial.operation_id, operation_id);
        assert_eq!(initial.parent_operation_id.as_deref(), Some("native-navigation-parent"));
        assert_eq!(initial.surface_generation, 7);
        assert_eq!(initial.lifecycle_epoch, 3);
        assert_eq!(initial.status, "active");

        let navigating = registry.update_phase(&operation_id, "navigating").unwrap();
        assert_eq!(navigating.phase, "navigating");
        let terminal = registry
            .complete(
                &operation_id,
                "completed",
                "applied",
                None,
            )
            .unwrap();
        let late = registry
            .complete(
                &operation_id,
                "blocked",
                "restartRequired",
                Some("LATE_CALLBACK".to_owned()),
            )
            .unwrap();
        assert_eq!(late, terminal, "{platform}: first terminal result wins");

        let duplicate = registry.begin(
            NativeOperationContext::new_for_platform(
                NativeOperationSubsystem::Recovery,
                "duplicateFailure",
                Duration::from_secs(1),
                platform,
            ),
            "role-1".to_owned(),
            "window-1".to_owned(),
            7,
            3,
        );
        let SurfaceRecoveryBegin::Existing(replayed) = duplicate else {
            panic!("{platform}: duplicate callback must replay");
        };
        assert_eq!(replayed, terminal);

        registry.release_terminal_key_for_retry("role-1", 7);
        let retry = registry.begin(
            NativeOperationContext::new_for_platform(
                NativeOperationSubsystem::Recovery,
                "lifecycleRetry",
                Duration::from_secs(1),
                platform,
            ),
            "role-1".to_owned(),
            "window-1".to_owned(),
            7,
            4,
        );
        let SurfaceRecoveryBegin::Started(_, retry_record) = retry else {
            panic!("{platform}: an explicit lifecycle retry must start a new attempt");
        };
        assert_ne!(retry_record.operation_id, operation_id);
        assert_eq!(retry_record.lifecycle_epoch, 4);
    }
}

#[test]
fn surface_recovery_generation_and_destructive_boundary_are_explicit() {
    for _platform in ["macos", "windows"] {
        assert!(surface_recovery_target_is_current(
            "window-1", "window-1", 8, 8,
        ));
        assert!(!surface_recovery_target_is_current(
            "window-2", "window-1", 8, 8,
        ));
        assert!(!surface_recovery_target_is_current(
            "window-1", "window-1", 9, 8,
        ));
        assert!(!surface_recovery_requires_restart(false));
        assert!(surface_recovery_requires_restart(true));
    }
}

#[test]
fn owner_close_cancels_the_exact_surface_recovery_without_restart() {
    for platform in ["macos", "windows"] {
        let registry = SurfaceRecoveryRegistry::default();
        let context = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Recovery,
            "processFailure",
            Duration::from_secs(1),
            platform,
        )
        .with_role("role-1")
        .with_window("window-1")
        .with_surface_generation(7);
        let operation_id = context.operation_id.clone();
        let SurfaceRecoveryBegin::Started(_, _) = registry.begin(
            context,
            "role-1".to_owned(),
            "window-1".to_owned(),
            7,
            3,
        ) else {
            panic!("{platform}: recovery must start");
        };
        let navigation = Arc::new(NavigationTracker::new_for_platform(platform));
        assert!(!registry.attach_navigation(&operation_id, &navigation));
        assert_eq!(registry.cancel_active_for_role("role-1"), 1);
        assert!(registry.operation_was_cancelled(&operation_id));
        assert!(navigation.owner_close_cancelled());
        assert!(navigation.wait().is_err());
        assert!(!navigation.native_navigation_started(91));

        let outcome = surface_recovery_failure_outcome(
            "SYSTEM_SURFACE_RECOVERY_FAILED",
            true,
            true,
        );
        assert_eq!(outcome.stage, "surfaceRecoveryCancelled");
        assert_eq!(outcome.native_status, NativeOperationStatus::Cancelled);
        assert!(!outcome.restart_required);

        let terminal = registry
            .complete(
                &operation_id,
                "blocked",
                "failed",
                Some("SYSTEM_SURFACE_RECOVERY_CANCELLED".to_owned()),
            )
            .unwrap();
        let late = registry
            .complete(
                &operation_id,
                "blocked",
                "restartRequired",
                Some("SYSTEM_SURFACE_RECOVERY_FAILED".to_owned()),
            )
            .unwrap();
        assert_eq!(late, terminal, "{platform}: cancellation is terminal");
    }
}

#[test]
fn clean_exit_requires_a_terminal_shutdown_drain() {
    for _platform in ["macos", "windows"] {
        assert!(shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Applied));
        assert!(shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Degraded));
        assert!(!shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Failed));
        assert!(!shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Indeterminate));
    }
}

#[test]
fn full_application_shutdown_does_not_wait_for_in_process_store_reuse() {
    assert_eq!(
        application_shutdown_release_boundary(SurfaceReleaseBoundary::DedicatedStore),
        SurfaceReleaseBoundary::SharedBrowserProcess
    );
    assert_eq!(
        application_shutdown_release_boundary(SurfaceReleaseBoundary::SharedBrowserProcess),
        SurfaceReleaseBoundary::SharedBrowserProcess
    );
}

#[test]
fn full_application_shutdown_uses_the_platform_stop_boundary_without_cookie_preflight() {
    assert!(!application_shutdown_defers_navigation_to_preflight());
    #[cfg(windows)]
    {
        assert!(windows_surface_quiesce_completes_at_stop(
            application_shutdown_defers_navigation_to_preflight()
        ));
        assert!(!windows_surface_quiesce_completes_at_stop(true));
    }
    for platform in ["windows", "macos"] {
        assert!(managed_surface_close_checkpoints_role_session(
            ManagedSurfaceKind::Role,
            true,
            false,
        ), "{platform}");
        assert!(!managed_surface_close_checkpoints_role_session(
            ManagedSurfaceKind::Role,
            false,
            false,
        ), "{platform}");
        assert!(!managed_surface_close_checkpoints_role_session(
            ManagedSurfaceKind::Divider,
            true,
            false,
        ), "{platform}");
        assert!(!managed_surface_close_checkpoints_role_session(
            ManagedSurfaceKind::Role,
            true,
            true,
        ), "{platform}");
    }
}

#[test]
fn shutdown_rejects_late_non_clean_restore_session_writes() {
    assert!(restore_session_persist_is_admitted(
        RuntimeShutdownState::Accepting,
        false
    ));
    for state in [
        RuntimeShutdownState::Draining,
        RuntimeShutdownState::Closed,
        RuntimeShutdownState::Indeterminate,
    ] {
        assert!(!restore_session_persist_is_admitted(state, false));
        assert!(restore_session_persist_is_admitted(state, true));
    }
}

#[test]
fn placeholder_only_restored_tabs_have_an_authoritative_ready_boundary() {
    for platform in ["windows", "macos"] {
        assert!(placeholder_attachment_is_role_load_boundary(0), "{platform}");
        assert!(!placeholder_attachment_is_role_load_boundary(1), "{platform}");
    }
}

#[test]
fn windows_dividers_release_without_a_remote_page_quiesce() {
    assert!(!managed_surface_requires_page_quiesce(
        "windows",
        ManagedSurfaceKind::Divider,
    ));
    assert!(managed_surface_requires_page_quiesce(
        "macos",
        ManagedSurfaceKind::Divider,
    ));
    for kind in [
        ManagedSurfaceKind::Popup,
        ManagedSurfaceKind::Recovery,
        ManagedSurfaceKind::Role,
    ] {
        assert!(managed_surface_requires_page_quiesce("windows", kind));
        assert!(managed_surface_requires_page_quiesce("macos", kind));
    }
}

#[test]
fn only_retired_recovery_surfaces_with_a_durable_checkpoint_can_skip_failed_readback() {
    for platform in ["windows", "macos"] {
        assert!(managed_surface_close_allows_durable_checkpoint_fallback(
            ManagedSurfacePhase::Retired,
            ManagedSurfaceKind::Role,
        ), "{platform}");
        assert!(!managed_surface_close_allows_durable_checkpoint_fallback(
            ManagedSurfacePhase::CloseRequested,
            ManagedSurfaceKind::Role,
        ), "{platform}");
        assert!(!managed_surface_close_allows_durable_checkpoint_fallback(
            ManagedSurfacePhase::Retired,
            ManagedSurfaceKind::Recovery,
        ), "{platform}");
        assert!(durable_checkpoint_fallback_is_allowed(
            true,
            "TAURI_EVALUATION_TIMEOUT",
            true,
        ), "{platform}");
        assert!(!durable_checkpoint_fallback_is_allowed(
            false,
            "TAURI_EVALUATION_TIMEOUT",
            true,
        ), "{platform}");
        assert!(!durable_checkpoint_fallback_is_allowed(
            true,
            "ROLE_LOCAL_STORAGE_CHECKPOINT_WRITE_FAILED",
            true,
        ), "{platform}");
        assert!(!durable_checkpoint_fallback_is_allowed(
            true,
            "TAURI_EVALUATION_TIMEOUT",
            false,
        ), "{platform}");
    }
}
