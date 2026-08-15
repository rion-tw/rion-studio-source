fn presentation_outcome(
    applied: bool,
    visible: Option<bool>,
    focused: Option<bool>,
    errors: Vec<String>,
) -> NativePresentationOutcome {
    NativePresentationOutcome {
        applied,
        presentation_applied: applied,
        focus_applied: focused == Some(true),
        focus_superseded: false,
        hidden_surface_count: 0,
        hide_ms: 0,
        main_queue_wait_ms: 0,
        main_thread_ms: 0,
        no_op: false,
        planned_surface_mutation_count: 0,
        shown_surface_count: 0,
        show_ms: 0,
        skipped_surface_count: 0,
        visibility_errors: errors,
        webview_focus_ms: 0,
        window_focused_after: focused,
        window_focus_applied: focused == Some(true),
        window_focus_ms: 0,
        window_restore_applied: false,
        window_visible_after: visible,
        window_visibility_ms: 0,
        window_was_minimized: Some(false),
    }
}

fn presentation_plan(platform: &'static str) -> NativePresentationPlan {
    assert!(matches!(platform, "macos" | "windows"));
    NativePresentationPlan {
        focus: NativePresentationFocus::WindowAndContent,
        operation: NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Presentation,
            "contract-test",
            Duration::from_secs(1),
            platform,
        )
        .with_revision(41)
        .with_window("window-1"),
        revision: 41,
        surface_identities: HashSet::from([("surface-1".to_owned(), 7)]),
        tab_id: Some("tab-1".to_owned()),
        window_id: "window-1".to_owned(),
        window_mode: None,
        window_visibility: Some(true),
    }
}

#[cfg(feature = "desktop-e2e")]
#[test]
fn desktop_e2e_fullscreen_edges_use_the_macos_transition_owner_only() {
    for (platform, current, requested, expected) in [
        ("macos", false, "fullscreen", Some(true)),
        ("macos", true, "normal", Some(false)),
        ("macos", false, "normal", None),
        ("macos", true, "fullscreen", None),
        ("windows", false, "fullscreen", None),
        ("windows", true, "normal", None),
    ] {
        assert_eq!(
            desktop_e2e_event_bound_fullscreen_target(platform, current, requested),
            expected,
            "unexpected E2E fullscreen owner: platform={platform} current={current} requested={requested}"
        );
    }
}

#[test]
fn macos_and_windows_share_exact_launch_visibility_terminal_semantics() {
    for platform in ["macos", "windows"] {
        assert_eq!(
            launch_visibility_terminal_status(true, Some(true), false),
            "completed",
            "{platform}"
        );
        assert_eq!(
            launch_visibility_terminal_status(true, Some(false), false),
            "degraded",
            "{platform}"
        );
        assert_eq!(
            launch_visibility_terminal_status(false, None, false),
            "superseded",
            "{platform}"
        );
        assert_eq!(
            launch_visibility_terminal_status(false, None, true),
            "failed",
            "{platform}"
        );
    }
}

#[test]
fn macos_and_windows_share_presentation_receipt_semantics() {
    for platform in ["macos", "windows"] {
        let plan = presentation_plan(platform);
        let applied = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(true, Some(true), Some(true), Vec::new()),
        );
        assert_eq!(applied.status, NativePresentationStatus::Applied, "{platform}");
        assert_eq!(applied.applied_revision, Some(41), "{platform}");
        assert_eq!(applied.surface_identities, plan.surface_identities, "{platform}");
        assert_eq!(applied.operation.completion_scope(), SystemRuntimeOperationCompletionScope::NativeAcknowledgement);

        let mut window_mode_plan = plan.clone();
        window_mode_plan.window_mode = Some(NativeWindowMode::Fullscreen);
        window_mode_plan.operation = window_mode_plan
            .operation
            .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission);
        let window_mode = NativePresentationReceipt::from_outcome(
            &window_mode_plan,
            &presentation_outcome(true, Some(true), Some(true), Vec::new()),
        );
        assert_eq!(window_mode.status, NativePresentationStatus::Applied, "{platform}");
        assert_eq!(window_mode.operation.completion_scope(), SystemRuntimeOperationCompletionScope::NativeSubmission);

        let mut control_only_outcome =
            presentation_outcome(true, Some(true), Some(false), Vec::new());
        control_only_outcome.presentation_applied = false;
        let control_only = NativePresentationReceipt::from_outcome(
            &window_mode_plan,
            &control_only_outcome,
        );
        assert_eq!(control_only.status, NativePresentationStatus::Applied, "{platform}");
        assert!(control_only.surface_identities.is_empty(), "{platform}");

        let superseded = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(false, None, None, Vec::new()),
        );
        assert_eq!(
            superseded.status,
            NativePresentationStatus::Superseded,
            "{platform}"
        );
        let mut owner_superseded = presentation_outcome(false, None, None, Vec::new());
        owner_superseded.planned_surface_mutation_count = 3;
        owner_superseded.skipped_surface_count = 1;
        let owner_superseded =
            NativePresentationReceipt::from_outcome(&plan, &owner_superseded);
        assert_eq!(
            owner_superseded.status,
            NativePresentationStatus::Superseded,
            "{platform}"
        );
        assert_eq!(owner_superseded.applied_revision, None, "{platform}");
        assert_eq!(owner_superseded.planned_surface_mutation_count, 3, "{platform}");
        assert_eq!(owner_superseded.applied_surface_mutation_count, 0, "{platform}");
        assert_eq!(owner_superseded.skipped_surface_mutation_count, 1, "{platform}");
        assert_eq!(
            owner_superseded.supersede_reason,
            Some("surfaceOwnerTokenMismatch"),
            "{platform}"
        );
        assert!(owner_superseded.surface_identities.is_empty(), "{platform}");
        assert_eq!(
            owner_superseded.operation.failure_code.as_deref(),
            Some("NATIVE_SURFACE_OWNER_SUPERSEDED"),
            "{platform}"
        );
        let mut cross_window_focus =
            presentation_outcome(true, Some(true), Some(true), Vec::new());
        cross_window_focus.focus_superseded = true;
        let cross_window_focus =
            NativePresentationReceipt::from_outcome(&plan, &cross_window_focus);
        assert_eq!(
            cross_window_focus.status,
            NativePresentationStatus::Superseded,
            "{platform}"
        );

        let degraded = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(true, Some(false), Some(false), Vec::new()),
        );
        assert_eq!(
            degraded.status,
            NativePresentationStatus::Degraded,
            "{platform}"
        );

        let failed = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(
                false,
                Some(true),
                Some(true),
                vec!["native failure".to_owned()],
            ),
        );
        assert_eq!(failed.status, NativePresentationStatus::Failed, "{platform}");
        assert_eq!(failed.applied_revision, None, "{platform}");
    }
}

#[test]
fn retirement_hide_is_acknowledged_from_submission_without_sync_readback() {
    for platform in ["macos", "windows"] {
        let mut plan = presentation_plan(platform);
        plan.focus = NativePresentationFocus::ContentOnly;
        plan.tab_id = None;
        plan.surface_identities.clear();
        plan.window_visibility = Some(false);

        let receipt = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(true, None, None, Vec::new()),
        );
        assert_eq!(receipt.status, NativePresentationStatus::Applied, "{platform}");
        assert_eq!(receipt.visible, None, "{platform}");
    }
}
