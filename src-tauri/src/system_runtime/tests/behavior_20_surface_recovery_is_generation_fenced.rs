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
fn clean_exit_requires_a_terminal_shutdown_drain() {
    for _platform in ["macos", "windows"] {
        assert!(shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Applied));
        assert!(shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Degraded));
        assert!(!shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Failed));
        assert!(!shutdown_receipt_allows_clean_exit(&SystemRuntimeOperationStatus::Indeterminate));
    }
}
