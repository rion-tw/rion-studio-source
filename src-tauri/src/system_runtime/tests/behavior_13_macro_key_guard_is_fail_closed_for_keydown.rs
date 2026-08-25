fn guarded_key_effect(phase: &str, code: &str, suppress_shortcut: bool) -> EmbeddedKeyEffectRecord {
    EmbeddedKeyEffectRecord {
        phase: phase.to_owned(),
        code: code.to_owned(),
        active_codes_before: Vec::new(),
        active_codes: Vec::new(),
        auto_repeat: false,
        suppress_shortcut,
    }
}

fn guard_acknowledgement(codes: &[&str]) -> MacroKeyGuardAcknowledgement {
    MacroKeyGuardAcknowledgement {
        armed: true,
        input_context: AutomaticInputContextReadback {
            document_instance_id: "document-1".to_owned(),
            revision: 1,
            target: AutomaticInputContextTarget::Game,
        },
        physical_modifier_codes: codes.iter().map(|code| (*code).to_owned()).collect(),
    }
}

fn observation_fixture() -> (
    Mutex<HashMap<String, PendingMacroKeyObservation>>,
    RoleInputDispatchLane,
    mpsc::Receiver<MacroKeyObservationSignal>,
) {
    let lane = RoleInputDispatchLane::default();
    lane.epoch.store(7, Ordering::Release);
    lane.surface_generation.store(3, Ordering::Release);
    let (sender, receiver) = mpsc::sync_channel(1);
    let observations = Mutex::new(HashMap::from([(
        "dispatch-1".to_owned(),
        PendingMacroKeyObservation {
            code: "Digit2".to_owned(),
            input_epoch: 7,
            phase: "keydown".to_owned(),
            role_id: "role-1".to_owned(),
            sender,
            surface_generation: 3,
            webview_label: "role-webview-1".to_owned(),
        },
    )]));
    (observations, lane, receiver)
}

fn exact_observation() -> MacroKeyEventObservation {
    MacroKeyEventObservation {
        dispatch_id: "dispatch-1".to_owned(),
        code: "Digit2".to_owned(),
        phase: "keydown".to_owned(),
    }
}

#[test]
fn macro_readiness_projection_skips_workspace_web_surface() {
    assert_eq!(
        macro_readiness_projection_role_id([
            ("web-tab-1-3", true),
            ("role-a", false),
            ("role-b", false),
        ]),
        Some("role-a")
    );
    assert_eq!(
        macro_readiness_projection_role_id([("role-a", false), ("role-b", false)]),
        Some("role-a")
    );
    assert_eq!(
        macro_readiness_projection_role_id([("web-tab-1-1", true), ("web-tab-1-2", true)]),
        None
    );
}

#[test]
fn macro_key_observation_is_identity_fenced_and_one_shot() {
    let (observations, lane, _receiver) = observation_fixture();
    let pending = claim_macro_key_observation(
        &observations,
        &lane,
        "role-webview-1",
        "role-1",
        &exact_observation(),
    )
    .unwrap();
    assert_eq!(pending.code, "Digit2");
    assert!(observations.lock().unwrap().is_empty());
    assert_eq!(
        claim_macro_key_observation(
            &observations,
            &lane,
            "role-webview-1",
            "role-1",
            &exact_observation(),
        )
        .expect_err("a receipt must be consumed exactly once")
        .code,
        "SYSTEM_MACRO_KEY_OBSERVATION_STALE"
    );
}

#[test]
fn mismatched_observation_does_not_consume_the_waiter() {
    for observation in [
        MacroKeyEventObservation {
            code: "Digit3".to_owned(),
            ..exact_observation()
        },
        MacroKeyEventObservation {
            phase: "keyup".to_owned(),
            ..exact_observation()
        },
    ] {
        let (observations, lane, _receiver) = observation_fixture();
        assert_eq!(
            claim_macro_key_observation(
                &observations,
                &lane,
                "role-webview-1",
                "role-1",
                &observation,
            )
            .expect_err("mismatched receipt must be rejected")
            .code,
            "SYSTEM_MACRO_KEY_OBSERVATION_MISMATCH"
        );
        assert_eq!(observations.lock().unwrap().len(), 1);
    }
}

#[test]
fn observation_rejects_webview_role_generation_and_epoch_mismatches() {
    let (observations, lane, _receiver) = observation_fixture();
    assert_eq!(
        claim_macro_key_observation(
            &observations,
            &lane,
            "other-webview",
            "role-1",
            &exact_observation(),
        )
        .unwrap_err()
        .code,
        "SYSTEM_MACRO_KEY_OBSERVATION_MISMATCH"
    );
    assert_eq!(
        claim_macro_key_observation(
            &observations,
            &lane,
            "role-webview-1",
            "other-role",
            &exact_observation(),
        )
        .unwrap_err()
        .code,
        "SYSTEM_MACRO_KEY_OBSERVATION_MISMATCH"
    );
    lane.epoch.store(8, Ordering::Release);
    assert_eq!(
        claim_macro_key_observation(
            &observations,
            &lane,
            "role-webview-1",
            "role-1",
            &exact_observation(),
        )
        .unwrap_err()
        .code,
        "SYSTEM_MACRO_KEY_OBSERVATION_STALE"
    );
    lane.epoch.store(7, Ordering::Release);
    lane.surface_generation.store(4, Ordering::Release);
    assert_eq!(
        claim_macro_key_observation(
            &observations,
            &lane,
            "role-webview-1",
            "role-1",
            &exact_observation(),
        )
        .unwrap_err()
        .code,
        "SYSTEM_MACRO_KEY_OBSERVATION_STALE"
    );
    assert_eq!(observations.lock().unwrap().len(), 1);
}

#[test]
fn navigation_or_dispose_cancels_the_exact_pending_waiter() {
    let (observations, _lane, receiver) = observation_fixture();
    cancel_macro_key_observations_matching(&observations, |pending| {
        pending.webview_label == "role-webview-1"
    });
    assert!(observations.lock().unwrap().is_empty());
    assert!(matches!(
        receiver.recv().unwrap(),
        MacroKeyObservationSignal::Cancelled
    ));
}

#[test]
fn macro_key_guard_script_serializes_dispatch_code_and_phase_without_expiry() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA\"\\", true);
    let source = macro_key_guard_arm_script(&effect, "dispatch-123").unwrap();

    assert!(source.contains("suppressNextShortcut"));
    assert!(source.contains(r#""dispatch-123""#));
    assert!(source.contains(r#""KeyA\"\\""#));
    assert!(source.contains(r#""keydown""#));
    assert!(!source.contains("expires"));
    assert!(source.contains("automaticInputContext"));
    assert!(source.contains("physicalModifierCodes"));
}

#[test]
fn modifier_projection_guard_has_its_own_disposition_and_dispatch_id() {
    let effect = guarded_key_effect("rawKeyDown", "ShiftLeft", false);
    let source = macro_modifier_projection_guard_arm_script(&effect, "dispatch-shift").unwrap();

    assert!(source.contains("suppressNextModifierProjection"));
    assert!(source.contains("automaticInputContext"));
    assert!(source.contains(r#""dispatch-shift""#));
    assert!(source.contains(r#""ShiftLeft""#));
    assert!(source.contains("physicalModifierCodes: []"));
    assert!(macro_modifier_projection_guard_arm_script(
        &guarded_key_effect("rawKeyDown", "Digit2", true),
        "dispatch-2"
    )
    .is_err());
}

#[test]
fn unknown_keydown_compensation_is_an_exact_non_repeat_keyup() {
    let mut effect = guarded_key_effect("rawKeyDown", "Digit2", true);
    effect.active_codes = vec!["Digit2".to_owned(), "ShiftLeft".to_owned()];
    let compensation = macro_key_compensation_effect(&effect);

    assert_eq!(compensation.phase, "keyUp");
    assert_eq!(compensation.code, "Digit2");
    assert_eq!(compensation.active_codes_before, ["Digit2", "ShiftLeft"]);
    assert_eq!(compensation.active_codes, ["ShiftLeft"]);
    assert!(!compensation.auto_repeat);
}

#[test]
fn macro_key_guard_acknowledgement_validates_modifier_sides() {
    assert_eq!(
        macro_key_guard_acknowledgement(
            r#"{"armed":true,"inputContext":{"documentInstanceId":"document-1","revision":1,"target":"game"},"physicalModifierCodes":["ShiftRight","ControlLeft"]}"#
        ),
        Some(guard_acknowledgement(&["ShiftRight", "ControlLeft"]))
    );
    for raw in [
        r#"{"armed":false,"inputContext":{"documentInstanceId":"document-1","revision":1,"target":"game"},"physicalModifierCodes":[]}"#,
        r#"{"armed":true,"inputContext":{"documentInstanceId":"document-1","revision":1,"target":"game"},"physicalModifierCodes":["KeyA"]}"#,
        r#"{"armed":true,"inputContext":{"documentInstanceId":"document-1","revision":1,"target":"game"},"physicalModifierCodes":["ShiftLeft","ShiftLeft"]}"#,
        "true",
        "null",
        "not-json",
    ] {
        assert!(macro_key_guard_acknowledgement(raw).is_none(), "{raw}");
    }
}

#[test]
fn physical_modifier_projection_preserves_sides_and_unions_macro_state() {
    let mut effect = guarded_key_effect("keyUp", "ShiftLeft", false);
    effect.active_codes_before = vec!["ShiftLeft".to_owned(), "AltLeft".to_owned()];
    effect.active_codes = vec!["AltLeft".to_owned()];
    let projections = physical_modifier_projection_effects(
        &effect,
        &[
            "ShiftRight".to_owned(),
            "ShiftLeft".to_owned(),
            "ControlLeft".to_owned(),
        ],
        |code| code != "ControlLeft",
    );

    assert_eq!(projections.len(), 2);
    assert_eq!(projections[0].code, "ShiftRight");
    assert_eq!(projections[0].active_codes, ["AltLeft", "ShiftRight"]);
    assert_eq!(projections[1].code, "ShiftLeft");
    assert_eq!(
        projections[1].active_codes,
        ["AltLeft", "ShiftLeft", "ShiftRight"]
    );
}

#[test]
fn background_roles_receive_no_physical_modifier_projection() {
    let mut effect = guarded_key_effect("rawKeyDown", "ShiftLeft", false);
    effect.active_codes = vec!["ShiftLeft".to_owned()];
    assert!(physical_modifier_projection_effects(&effect, &[], |_| true).is_empty());
    assert!(physical_modifier_projection_effects(
        &effect,
        &["ShiftLeft".to_owned()],
        |_| true
    )
    .is_empty());
}

#[test]
fn macro_focus_waits_for_essential_page_readiness() {
    for phase in [
        None,
        Some(LaunchPhase::Attaching),
        Some(LaunchPhase::Navigating),
    ] {
        assert_eq!(focus_launch_readiness(phase), FocusLaunchReadiness::Pending);
    }
    for phase in [
        LaunchPhase::EssentialReady,
        LaunchPhase::OptionalHydrating,
        LaunchPhase::Ready,
    ] {
        assert_eq!(
            focus_launch_readiness(Some(phase)),
            FocusLaunchReadiness::Ready
        );
    }
    assert_eq!(
        focus_launch_readiness(Some(LaunchPhase::Degraded)),
        FocusLaunchReadiness::Unavailable
    );
}

#[test]
fn managed_shortcut_replay_is_balanced_and_suppresses_only_the_main_key() {
    let effects = managed_shortcut_key_effects(
        "Digit2",
        "replay",
        vec!["ShiftRight".to_owned(), "ControlLeft".to_owned()],
    )
    .unwrap();

    assert_eq!(effects.len(), 6);
    assert_eq!(
        effects
            .iter()
            .map(|effect| (effect.phase.as_str(), effect.code.as_str()))
            .collect::<Vec<_>>(),
        [
            ("rawKeyDown", "ControlLeft"),
            ("rawKeyDown", "ShiftRight"),
            ("rawKeyDown", "Digit2"),
            ("keyUp", "Digit2"),
            ("keyUp", "ShiftRight"),
            ("keyUp", "ControlLeft"),
        ]
    );
    assert!(effects[2].suppress_shortcut);
    assert!(effects[3].suppress_shortcut);
    assert!(effects
        .iter()
        .enumerate()
        .filter(|(index, _)| !matches!(index, 2 | 3))
        .all(|(_, effect)| !effect.suppress_shortcut));
    assert!(effects.last().unwrap().active_codes.is_empty());
}

#[test]
fn managed_while_held_phases_preserve_modifier_sides() {
    let modifiers = vec!["ShiftRight".to_owned(), "ControlLeft".to_owned()];
    let down = managed_shortcut_key_effects("Digit2", "keyDown", modifiers.clone()).unwrap();
    let up = managed_shortcut_key_effects("Digit2", "keyUp", modifiers).unwrap();

    assert_eq!(down.len(), 1);
    assert_eq!(down[0].phase, "rawKeyDown");
    assert_eq!(down[0].active_codes_before, ["ControlLeft", "ShiftRight"]);
    assert_eq!(
        down[0].active_codes,
        ["ControlLeft", "Digit2", "ShiftRight"]
    );
    assert!(down[0].suppress_shortcut);

    assert_eq!(up.len(), 1);
    assert_eq!(up[0].phase, "keyUp");
    assert_eq!(
        up[0].active_codes_before,
        ["ControlLeft", "Digit2", "ShiftRight"]
    );
    assert_eq!(up[0].active_codes, ["ControlLeft", "ShiftRight"]);
    assert!(up[0].suppress_shortcut);
}

#[test]
fn managed_shortcut_effects_reject_unknown_phases() {
    assert_eq!(
        managed_shortcut_key_effects("Digit2", "unknown", Vec::new())
            .unwrap_err()
            .code,
        "SYSTEM_MANAGED_SHORTCUT_INVALID"
    );
}
