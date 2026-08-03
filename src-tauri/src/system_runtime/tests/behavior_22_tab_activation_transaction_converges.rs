fn tab_activation_operation(
    platform: &'static str,
    window_id: &str,
    tab_id: &str,
    revision: u64,
) -> NativeOperationContext {
    NativeOperationContext::new_for_platform(
        NativeOperationSubsystem::TabActivation,
        "activation-test",
        Duration::from_secs(1),
        platform,
    )
    .with_revision(revision)
    .with_window(window_id)
    .with_tab(tab_id)
    .with_completion_scope(SystemRuntimeOperationCompletionScope::TabActivationConverged)
}

#[test]
fn tab_activation_latest_revision_supersedes_the_previous_transaction() {
    for platform in ["macos", "windows"] {
        let coordinator = TabActivationCoordinator::default();
        let first = tab_activation_operation(platform, "window-1", "tab-1", 1);
        let second = tab_activation_operation(platform, "window-1", "tab-2", 2);
        assert!(coordinator.accept(first.clone(), true).unwrap().is_none());
        let superseded = coordinator.accept(second.clone(), true).unwrap().unwrap();

        assert_eq!(superseded.operation_id, first.operation_id, "{platform}");
        assert!(
            coordinator
                .record_presentation(
                    &first.operation_id,
                    TabActivationComponentStatus::Applied,
                )
                .is_none(),
            "{platform}"
        );
        assert!(
            coordinator
                .record_presentation(
                    &second.operation_id,
                    TabActivationComponentStatus::Applied,
                )
                .is_none()
        );
        assert!(
            coordinator
                .record_chrome(
                    &second.operation_id,
                    TabActivationComponentStatus::Applied,
                )
                .is_none()
        );
        let receipt = coordinator
            .record_core(
                &second.operation_id,
                TabActivationComponentStatus::Applied,
            )
            .unwrap();
        assert_eq!(receipt.status, NativeOperationStatus::Applied, "{platform}");
        assert_eq!(receipt.stage, "tabActivationConverged", "{platform}");
        assert_eq!(receipt.completion_scope(), SystemRuntimeOperationCompletionScope::TabActivationConverged);
    }
}

#[test]
fn tab_activation_keeps_confirmed_content_when_chrome_or_core_degrades() {
    for (failed_component, expected_code) in [
        ("chrome", "TAB_ACTIVATION_CHROME_NOT_CONFIRMED"),
        ("core", "TAB_ACTIVATION_STATE_COMMIT_FAILED"),
    ] {
        let coordinator = TabActivationCoordinator::default();
        let operation = tab_activation_operation("windows", "window-1", "tab-2", 3);
        coordinator.accept(operation.clone(), true).unwrap();
        assert!(
            coordinator
                .record_presentation(
                    &operation.operation_id,
                    TabActivationComponentStatus::Applied,
                )
                .is_none()
        );
        let chrome = if failed_component == "chrome" {
            TabActivationComponentStatus::Failed
        } else {
            TabActivationComponentStatus::Applied
        };
        assert!(
            coordinator
                .record_chrome(&operation.operation_id, chrome)
                .is_none()
        );
        let core = if failed_component == "core" {
            TabActivationComponentStatus::Failed
        } else {
            TabActivationComponentStatus::Applied
        };
        let receipt = coordinator
            .record_core(&operation.operation_id, core)
            .unwrap();

        assert_eq!(receipt.status, NativeOperationStatus::Degraded);
        assert_eq!(receipt.failure_code.as_deref(), Some(expected_code));
    }
}

#[test]
fn unknown_native_presentation_makes_tab_activation_indeterminate() {
    let coordinator = TabActivationCoordinator::default();
    let operation = tab_activation_operation("windows", "window-1", "tab-2", 4);
    coordinator.accept(operation.clone(), false).unwrap();
    assert!(
        coordinator
            .record_chrome(
                &operation.operation_id,
                TabActivationComponentStatus::Applied,
            )
            .is_none()
    );
    let receipt = coordinator
        .record_presentation(
            &operation.operation_id,
            TabActivationComponentStatus::Indeterminate,
        )
        .unwrap();

    assert_eq!(receipt.status, NativeOperationStatus::Indeterminate);
    assert_eq!(
        receipt.failure_code.as_deref(),
        Some("TAB_ACTIVATION_INDETERMINATE")
    );
}
