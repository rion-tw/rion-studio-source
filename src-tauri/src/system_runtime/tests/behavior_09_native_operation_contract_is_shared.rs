#[test]
fn native_operation_receipts_expose_the_same_terminal_contract_on_both_platforms() {
    let cases = [
        (NativeOperationSubsystem::SurfaceLifecycle, "nativeAcknowledgement"),
        (NativeOperationSubsystem::Navigation, "pageFinished"),
        (NativeOperationSubsystem::Input, "nativeSubmission"),
        (NativeOperationSubsystem::Presentation, "nativeAcknowledgement"),
        (NativeOperationSubsystem::Popup, "stateCommit"),
        (NativeOperationSubsystem::Security, "nativeAcknowledgement"),
        (NativeOperationSubsystem::Session, "stateCommit"),
        (NativeOperationSubsystem::Audio, "nativeAcknowledgement"),
        (NativeOperationSubsystem::Zoom, "nativeAcknowledgement"),
        (NativeOperationSubsystem::Metadata, "nativeSubmission"),
        (NativeOperationSubsystem::Performance, "runtimeProbe"),
        (NativeOperationSubsystem::Capability, "runtimeProbe"),
    ];
    for platform in ["macos", "windows"] {
        for (subsystem, completion_scope) in cases {
            let context = NativeOperationContext::new_for_platform(
                subsystem,
                "contract-test",
                Duration::from_millis(750),
                platform,
            )
            .with_role("role-1")
            .with_tab("tab-1")
            .with_window("window-1")
            .with_surface_generation(9);
            let summary = NativeOperationReceipt::applied(context, "contractApplied").summary();
            assert_eq!(summary.platform, platform);
            assert_eq!(summary.status, "applied");
            assert_eq!(summary.completion_scope, completion_scope);
            assert_eq!(summary.timeout_ms, 750);
            assert_eq!(summary.surface_generation, Some(9));
            assert!(
                summary
                    .operation_id
                    .starts_with(&format!("native-{}-", summary.subsystem))
            );
        }
    }
}

#[test]
fn popup_policy_is_engine_independent_and_fail_closed() {
    for _platform in ["macos", "windows"] {
        assert_eq!(
            popup_contract_decision(false, "https"),
            PopupContractDecision::DenyMissingOwner
        );
        assert_eq!(
            popup_contract_decision(true, "file"),
            PopupContractDecision::DenyUnsupportedScheme
        );
        assert_eq!(
            popup_contract_decision(true, "https"),
            PopupContractDecision::Create
        );
    }
}

#[test]
fn navigation_receipt_supersedes_an_obsolete_operation_before_applying_the_latest() {
    for platform in ["macos", "windows"] {
        let tracker = NavigationTracker::default();
        let first = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
            platform,
        );
        let latest = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Navigation,
            "contract-test",
            Duration::from_secs(1),
            platform,
        );
        tracker.begin_operation(&first).unwrap();
        tracker.begin_operation(&latest).unwrap();
        assert_eq!(
            tracker.wait_operation(first).status,
            NativeOperationStatus::Superseded
        );
        tracker.page_event(
            PageLoadEvent::Finished,
            &Url::parse("https://example.test/ready").unwrap(),
        );
        assert_eq!(
            tracker.wait_operation(latest).status,
            NativeOperationStatus::Applied
        );
    }
}

#[test]
fn rollback_failures_are_preserved_in_the_public_summary() {
    let context = NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::Audio,
        "contract-test",
        Duration::from_secs(1),
        "windows",
    );
    let summary = NativeOperationReceipt::with_status(
        context,
        "audioMuteRollbackFailed",
        NativeOperationStatus::Indeterminate,
        Some("SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"),
    )
    .with_rollback_error_count(2)
    .summary();
    assert_eq!(summary.status, "indeterminate");
    assert_eq!(summary.rollback_error_count, Some(2));

    let session_result: RuntimeResult<()> = Err(RuntimeError::new(
        "SESSION_IMPORT_ROLLBACK_VERIFY_FAILED",
        "contract test",
    ));
    let session = receipt_for_runtime_result(
        NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Session,
            "contract-test",
            Duration::from_secs(1),
            "macos",
        ),
        "sessionTransferRolledBack",
        &session_result,
    );
    assert_eq!(session.status, NativeOperationStatus::Indeterminate);
}

#[test]
fn an_operation_that_finishes_after_its_deadline_cannot_report_applied() {
    for platform in ["macos", "windows"] {
        let context = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Metadata,
            "contract-test",
            Duration::ZERO,
            platform,
        );
        let summary = NativeOperationReceipt::applied(context, "metadataSubmitted").summary();
        assert_eq!(summary.status, "degraded");
        assert_eq!(
            summary.failure_code.as_deref(),
            Some("NATIVE_OPERATION_DEADLINE_EXCEEDED")
        );
    }
}
