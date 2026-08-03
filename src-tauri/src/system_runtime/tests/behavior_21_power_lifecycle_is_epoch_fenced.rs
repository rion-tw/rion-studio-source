#[test]
fn lifecycle_projection_revisions_and_acceptance_are_platform_explicit() {
    for platform in ["macos", "windows"] {
        let lifecycle = ApplicationLifecycleCoordinator::new_for_platform(platform);
        let mut changed = lifecycle.subscribe();
        let initial = lifecycle.current();
        assert_eq!(initial.platform, platform);
        assert_eq!(initial.state, "active");
        assert!(lifecycle.accepts_native_work());

        lifecycle.suspended.store(true, Ordering::Release);
        let suspending = lifecycle.transition(
            ApplicationLifecyclePhase::Suspending,
            4,
            "power-suspend",
        );
        assert_eq!(suspending.revision, initial.revision + 1);
        assert_eq!(suspending.lifecycle_epoch, 4);
        assert!(changed.has_changed().unwrap());
        assert_eq!(*changed.borrow_and_update(), 4);
        assert!(!lifecycle.accepts_native_work());

        let degraded_suspend = lifecycle.transition(
            ApplicationLifecyclePhase::Degraded,
            4,
            "input-drain-failed",
        );
        assert!(!lifecycle.accepts_native_work());
        lifecycle.suspended.store(false, Ordering::Release);
        let degraded_resume = lifecycle.transition(
            ApplicationLifecyclePhase::Degraded,
            4,
            "input-resume-failed",
        );
        assert!(degraded_resume.revision > degraded_suspend.revision);
        assert!(lifecycle.accepts_native_work());
    }
}

#[test]
fn suspend_interrupts_old_epoch_work_without_interrupting_power_or_shutdown() {
    for platform in ["macos", "windows"] {
        let registry = NativeOperationRegistry::default();
        let queued = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "queued-before-sleep",
            Duration::from_secs(1),
            platform,
        )
        .with_lifecycle_epoch(2);
        let in_flight = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Input,
            "submitted-before-sleep",
            Duration::from_secs(1),
            platform,
        )
        .with_lifecycle_epoch(2);
        let power = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Power,
            "applicationSuspend",
            Duration::from_secs(1),
            platform,
        )
        .with_lifecycle_epoch(3);
        registry.register(queued.clone()).unwrap();
        registry.register(in_flight.clone()).unwrap();
        registry.register(power.clone()).unwrap();
        assert!(registry.mark_in_flight(&in_flight.operation_id));

        assert_eq!(registry.interrupt_for_lifecycle(), 2, "{platform}");
        assert_eq!(
            registry.terminal(&queued.operation_id).unwrap().status,
            NativeOperationStatus::Cancelled
        );
        assert_eq!(
            registry.terminal(&in_flight.operation_id).unwrap().status,
            NativeOperationStatus::Indeterminate
        );
        assert!(registry.terminal(&power.operation_id).is_none());
        assert_eq!(registry.active_count(), 1);
    }
}

#[test]
fn tab_drag_epoch_fence_rejects_pre_sleep_sessions() {
    for _platform in ["macos", "windows"] {
        assert!(crate::tab_drag_lifecycle_is_current(5, 5));
        assert!(!crate::tab_drag_lifecycle_is_current(6, 5));
    }
}

#[test]
fn deferred_surface_recovery_is_bounded_and_latest_generation_wins() {
    for platform in ["macos", "windows"] {
        let lifecycle = ApplicationLifecycleCoordinator::new_for_platform(platform);
        assert!(lifecycle.defer_surface_recovery(
            "role-1".to_owned(),
            "first".to_owned(),
            2,
            None,
            false,
        ));
        assert!(lifecycle.defer_surface_recovery(
            "role-1".to_owned(),
            "newer".to_owned(),
            3,
            Some("parent".to_owned()),
            true,
        ));
        assert!(lifecycle.defer_surface_recovery(
            "role-1".to_owned(),
            "stale".to_owned(),
            1,
            None,
            false,
        ));
        for index in 2..=DEFERRED_SURFACE_RECOVERY_CAPACITY {
            assert!(lifecycle.defer_surface_recovery(
                format!("role-{index}"),
                "bounded".to_owned(),
                1,
                None,
                false,
            ));
        }
        assert!(!lifecycle.defer_surface_recovery(
            "overflow".to_owned(),
            "bounded".to_owned(),
            1,
            None,
            false,
        ));
        let deferred = lifecycle.take_deferred_surface_recoveries();
        assert_eq!(deferred.len(), DEFERRED_SURFACE_RECOVERY_CAPACITY);
        let latest = deferred
            .iter()
            .find(|recovery| recovery.role_id == "role-1")
            .unwrap();
        assert_eq!(latest.generation, 3);
        assert_eq!(latest.reason, "newer");
        assert_eq!(latest.parent_operation_id.as_deref(), Some("parent"));
        assert!(latest.retry_terminal);
    }
}
