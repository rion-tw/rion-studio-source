fn presentation_outcome(
    applied: bool,
    visible: Option<bool>,
    focused: Option<bool>,
    errors: Vec<String>,
) -> NativePresentationOutcome {
    NativePresentationOutcome {
        applied,
        focus_applied: focused == Some(true),
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

fn presentation_plan(platform: &str) -> NativePresentationPlan {
    assert!(matches!(platform, "macos" | "windows"));
    NativePresentationPlan {
        focus: NativePresentationFocus::WindowAndContent,
        revision: 41,
        surface_identities: HashSet::from([("surface-1".to_owned(), 7)]),
        tab_id: Some("tab-1".to_owned()),
        window_id: "window-1".to_owned(),
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

        let superseded = NativePresentationReceipt::from_outcome(
            &plan,
            &presentation_outcome(false, None, None, Vec::new()),
        );
        assert_eq!(
            superseded.status,
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
