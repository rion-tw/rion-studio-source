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
        shown_surface_count: 0,
        show_ms: 0,
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
        assert_eq!(applied.operation.completion_scope(), "nativeAcknowledgement");

        let mut window_mode_plan = plan.clone();
        window_mode_plan.window_mode = Some(NativeWindowMode::Fullscreen);
        window_mode_plan.operation = window_mode_plan
            .operation
            .with_completion_scope("nativeSubmission");
        let window_mode = NativePresentationReceipt::from_outcome(
            &window_mode_plan,
            &presentation_outcome(true, Some(true), Some(true), Vec::new()),
        );
        assert_eq!(window_mode.status, NativePresentationStatus::Applied, "{platform}");
        assert_eq!(window_mode.operation.completion_scope(), "nativeSubmission");

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
                true,
                Some(true),
                Some(true),
                vec!["native failure".to_owned()],
            ),
        );
        assert_eq!(failed.status, NativePresentationStatus::Failed, "{platform}");
    }
}
