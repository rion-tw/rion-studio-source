fn diagnostic_failure(code: &str) -> SystemRuntimeFailureRecord {
    SystemRuntimeFailureRecord {
        captured_at: "2026-08-02T00:00:00Z".to_owned(),
        subsystem: "effect".to_owned(),
        stage: "nativeExecution".to_owned(),
        code: code.to_owned(),
        action: Some("embeddedCreateTab".to_owned()),
        effect_id: Some(format!("effect-{code}")),
        operation_id: Some("operation-a".to_owned()),
        role_id: None,
        tab_id: None,
        window_id: None,
        rollback_error_count: None,
    }
}

#[test]
fn recent_runtime_failures_are_bounded_and_newest_first() {
    let mut diagnostics = RuntimeDiagnosticsState::default();
    for index in 0..25 {
        diagnostics.push_failure(diagnostic_failure(&index.to_string()));
    }
    let failures = diagnostics.failures_newest_first();
    assert_eq!(failures.len(), RECENT_RUNTIME_FAILURE_CAPACITY);
    assert_eq!(failures.first().map(|failure| failure.code.as_str()), Some("24"));
    assert_eq!(failures.last().map(|failure| failure.code.as_str()), Some("5"));
}

#[test]
fn recent_input_fence_history_keeps_forty_privacy_safe_events() {
    let mut diagnostics = RuntimeDiagnosticsState::default();
    for index in 0..45 {
        diagnostics.push_input_fence_event(SystemRuntimeInputFenceEventRecord {
            captured_at: "2026-08-02T00:00:00Z".to_owned(),
            role_id: "role-a".to_owned(),
            input_epoch: index,
            event: "page-finished".to_owned(),
            reason: "navigation".to_owned(),
            elapsed_ms: index,
            surface_generation: Some(3),
            drained: true,
            pending_page_finish_count: 0,
            recovery_scheduled: false,
            recovery_id: None,
            pending_macro_restart_count: 0,
        });
    }

    let events = diagnostics.input_fence_events_newest_first();
    assert_eq!(events.len(), RECENT_INPUT_FENCE_EVENT_CAPACITY);
    assert_eq!(events.first().map(|event| event.input_epoch), Some(44));
    assert_eq!(events.last().map(|event| event.input_epoch), Some(5));
    let json = serde_json::to_string(&events).unwrap();
    for forbidden in ["url", "webviewLabel", "token", "pageContent"] {
        assert!(!json.contains(forbidden));
    }
}

#[test]
fn effect_acknowledgement_outcomes_have_stable_classifications() {
    for (field, expected_status, expected_code) in [
        ("accepted", "accepted", None),
        ("duplicate", "duplicate", Some("CORE_EFFECT_ACK_DUPLICATE")),
        ("late", "late", Some("CORE_EFFECT_ACK_LATE")),
        ("unknown", "unknown", Some("CORE_EFFECT_ACK_UNKNOWN")),
        (
            "operationMismatch",
            "operationMismatch",
            Some("CORE_EFFECT_ACK_OPERATION_MISMATCH"),
        ),
    ] {
        let mut report = CoreEffectDispatchReport::default();
        match field {
            "accepted" => report.accepted.push("effect-a".to_owned()),
            "duplicate" => report.duplicate.push("effect-a".to_owned()),
            "late" => report.late.push("effect-a".to_owned()),
            "unknown" => report.unknown.push("effect-a".to_owned()),
            _ => report.operation_mismatch.push("effect-a".to_owned()),
        }
        let status = effect_acknowledgement_status(&report, "effect-a");
        assert_eq!(status, expected_status);
        assert_eq!(effect_acknowledgement_error_code(status), expected_code);
    }

    let missing = effect_acknowledgement_status(&CoreEffectDispatchReport::default(), "effect-a");
    assert_eq!(missing, "missing");
    assert_eq!(
        effect_acknowledgement_error_code(missing),
        Some("CORE_EFFECT_ACK_MISSING")
    );
}

#[test]
fn runtime_failure_summary_omits_messages_and_sensitive_runtime_data() {
    let value = serde_json::to_value(diagnostic_failure("SYSTEM_ROLE_SETUP_FAILED")).unwrap();
    let object = value.as_object().unwrap();
    for forbidden in ["message", "origin", "token", "url", "webviewLabel"] {
        assert!(!object.contains_key(forbidden));
    }
    assert_eq!(value["code"], "SYSTEM_ROLE_SETUP_FAILED");
    assert_eq!(value["subsystem"], "effect");
}

#[test]
fn diagnostic_surface_closing_policy_matches_lifecycle_boundaries() {
    for phase in [
        ManagedSurfacePhase::CloseRequested,
        ManagedSurfacePhase::Isolating,
        ManagedSurfacePhase::Isolated,
        ManagedSurfacePhase::Retired,
    ] {
        assert!(diagnostic_surface_is_closing(phase));
    }
    for phase in [
        ManagedSurfacePhase::Live,
        ManagedSurfacePhase::Provisional,
        ManagedSurfacePhase::Quarantined,
        ManagedSurfacePhase::Released,
    ] {
        assert!(!diagnostic_surface_is_closing(phase));
    }
}

#[test]
fn input_fence_diagnostics_classify_core_and_native_orphans() {
    assert_eq!(
        diagnostic_input_fence_state(None, false, false, true, false),
        ("orphaned-core", true)
    );
    assert_eq!(
        diagnostic_input_fence_state(None, true, false, false, false),
        ("orphaned-native", true)
    );
    assert_eq!(
        diagnostic_input_fence_state(None, true, true, true, false),
        ("waiting-page-finish", false)
    );
    assert_eq!(
        diagnostic_input_fence_state(None, true, false, true, true),
        ("restart-required", false)
    );
}
