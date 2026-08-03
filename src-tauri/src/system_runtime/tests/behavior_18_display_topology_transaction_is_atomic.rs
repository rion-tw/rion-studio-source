#[test]
fn display_topology_receipts_freeze_the_committed_revision_on_both_platforms() {
    for platform in ["macos", "windows"] {
        let context = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::DisplayTopology,
            "nativeDisplayTopologyChanged",
            Duration::from_secs(10),
            platform,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::TopologyCommitted)
        .with_topology_revision(42);
        let summary = NativeOperationReceipt::applied(context, "displayTopologyCommitted").summary();

        assert_eq!(summary.platform, platform);
        assert_eq!(summary.subsystem, SystemRuntimeOperationSubsystem::DisplayTopology);
        assert_eq!(summary.completion_scope, SystemRuntimeOperationCompletionScope::TopologyCommitted);
        assert_eq!(summary.topology_revision, Some(42));
    }
}

#[test]
fn display_topology_compensation_status_is_platform_neutral() {
    for platform in ["macos", "windows"] {
        let applied = display_topology_transaction_status(
            DisplayTopologyTransactionClassification {
                committed: true,
                exact_readback: true,
                rollback_error_count: 0,
            },
        );
        let degraded = display_topology_transaction_status(
            DisplayTopologyTransactionClassification {
                committed: true,
                exact_readback: false,
                rollback_error_count: 0,
            },
        );
        let failed = display_topology_transaction_status(
            DisplayTopologyTransactionClassification {
                committed: false,
                exact_readback: false,
                rollback_error_count: 0,
            },
        );
        let indeterminate = display_topology_transaction_status(
            DisplayTopologyTransactionClassification {
                committed: false,
                exact_readback: false,
                rollback_error_count: 1,
            },
        );

        assert_eq!(applied, NativeOperationStatus::Applied, "{platform}");
        assert_eq!(degraded, NativeOperationStatus::Degraded, "{platform}");
        assert_eq!(failed, NativeOperationStatus::Failed, "{platform}");
        assert_eq!(
            indeterminate,
            NativeOperationStatus::Indeterminate,
            "{platform}"
        );
    }
}
