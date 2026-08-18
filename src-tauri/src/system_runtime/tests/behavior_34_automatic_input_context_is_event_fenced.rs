fn input_context_readback(
    document_instance_id: &str,
    revision: u64,
    target: AutomaticInputContextTarget,
) -> AutomaticInputContextReadback {
    AutomaticInputContextReadback {
        document_instance_id: document_instance_id.to_owned(),
        revision,
        target,
    }
}

fn role_input_context(
    document_instance_id: &str,
    revision: u64,
    target: AutomaticInputContextTarget,
) -> RoleAutomaticInputContext {
    RoleAutomaticInputContext {
        document_instance_id: document_instance_id.to_owned(),
        revision,
        surface_generation: 7,
        target,
        webview_label: "role-webview-1".to_owned(),
    }
}

#[test]
fn automatic_input_context_rejects_duplicate_reverse_old_document_and_old_surface_events() {
    let previous = role_input_context("document-1", 4, AutomaticInputContextTarget::EmbeddedFrame);

    for revision in [4, 3] {
        assert!(automatic_input_context_is_stale(
            Some(&previous),
            Some("document-1"),
            &input_context_readback("document-1", revision, AutomaticInputContextTarget::Game),
            7,
            "role-webview-1",
        ));
    }
    assert!(automatic_input_context_is_stale(
        Some(&previous),
        Some("document-2"),
        &input_context_readback("document-1", 5, AutomaticInputContextTarget::Game),
        7,
        "role-webview-1",
    ));
    assert!(automatic_input_context_is_stale(
        Some(&previous),
        Some("document-1"),
        &input_context_readback("document-1", 5, AutomaticInputContextTarget::Game),
        8,
        "role-webview-1",
    ));
    assert!(automatic_input_context_is_stale(
        Some(&previous),
        Some("document-1"),
        &input_context_readback("document-1", 5, AutomaticInputContextTarget::Game),
        7,
        "role-webview-2",
    ));
}

#[test]
fn authoritative_new_document_accepts_a_fresh_revision_but_document_context_cannot_resume() {
    let previous = role_input_context("document-1", 8, AutomaticInputContextTarget::EmbeddedFrame);
    assert!(!automatic_input_context_is_stale(
        Some(&previous),
        Some("document-2"),
        &input_context_readback("document-2", 1, AutomaticInputContextTarget::Document),
        7,
        "role-webview-1",
    ));
    assert!(!MacroInputRecoveryEvidence::InputContextBlocked.permits_in_place_resume());
    assert!(!MacroInputRecoveryEvidence::DocumentReplacementPending.permits_in_place_resume());
    assert!(MacroInputRecoveryEvidence::InputContextRestored.permits_in_place_resume());
}

#[test]
fn automatic_input_context_wire_values_are_provider_neutral_three_state_values() {
    for (target, wire) in [
        (AutomaticInputContextTarget::Game, "game"),
        (AutomaticInputContextTarget::EmbeddedFrame, "embedded-frame"),
        (AutomaticInputContextTarget::Document, "document"),
    ] {
        let parsed = parse_automatic_input_context(json!({
            "documentInstanceId": "document-1",
            "revision": 1,
            "target": wire,
        }))
        .expect("context should parse");
        assert_eq!(parsed.target, target);
    }
}

#[test]
fn embedded_frame_fence_diagnostics_wait_for_game_context_without_restart_required() {
    let fence = RoleInputFence {
        input_epoch: 5,
        navigation_operation: None,
        reason: "embedded-frame-input-context".to_owned(),
        started_at: Instant::now(),
        drained: true,
        surface_generation: 7,
        recovery_scheduled: false,
        restart_required: false,
        macro_recovery_id: Some("recovery-1".to_owned()),
        pending_macro_restart_count: 1,
        resuming: false,
    };
    assert_eq!(
        diagnostic_input_fence_state(Some(&fence), true, false, true, false),
        ("waiting-game-input-context", false)
    );
}
