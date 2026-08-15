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
        physical_modifier_codes: codes.iter().map(|code| (*code).to_owned()).collect(),
    }
}

#[test]
fn macro_main_keydown_arms_the_page_guard_before_native_dispatch() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA", true);
    let order = Mutex::new(Vec::new());
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || {
            order.lock().unwrap().push("arm");
            Ok(guard_acknowledgement(&[]))
        },
        |_| {
            order.lock().unwrap().push("dispatch");
            Ok(())
        },
        || {
            order.lock().unwrap().push("release");
            Ok(())
        },
    );

    assert!(result.is_ok());
    assert_eq!(*order.lock().unwrap(), ["arm", "dispatch"]);
}

#[test]
fn macro_main_keydown_is_not_dispatched_when_the_page_guard_fails() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA", true);
    let dispatched = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || {
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                "guard unavailable",
            ))
        },
        |_| {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || Ok(()),
    );

    assert_eq!(
        result.expect_err("keydown guard failure must be returned").code,
        "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE"
    );
    assert!(!dispatched.load(Ordering::Acquire));
}

#[test]
fn macro_keyup_is_always_dispatched_even_when_guard_arming_fails() {
    let effect = guarded_key_effect("keyUp", "KeyA", true);
    let dispatched = AtomicBool::new(false);
    let released = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || {
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                "guard unavailable",
            ))
        },
        |_| {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || {
            released.store(true, Ordering::Release);
            Ok(())
        },
    );

    assert!(result.is_ok());
    assert!(dispatched.load(Ordering::Acquire));
    assert!(released.load(Ordering::Acquire));
}

#[test]
fn modifier_keydown_is_armed_before_native_dispatch() {
    let effect = guarded_key_effect("rawKeyDown", "ControlLeft", false);
    let armed = AtomicBool::new(false);
    let dispatched = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || {
            armed.store(true, Ordering::Release);
            Ok(guard_acknowledgement(&[]))
        },
        |_| {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || Ok(()),
    );

    assert!(result.is_ok());
    assert!(armed.load(Ordering::Acquire));
    assert!(dispatched.load(Ordering::Acquire));
}

#[test]
fn successful_keyup_guard_acknowledges_forwarded_release_after_native_dispatch() {
    let effect = guarded_key_effect("keyUp", "KeyA", true);
    let released = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || Ok(guard_acknowledgement(&[])),
        |_| Ok(()),
        || {
            released.store(true, Ordering::Release);
            Ok(())
        },
    );

    assert!(result.is_ok());
    assert!(released.load(Ordering::Acquire));
}

#[test]
fn macro_keyup_cleanup_failure_is_terminal_after_successful_native_dispatch() {
    let effect = guarded_key_effect("keyUp", "KeyA", true);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || Ok(guard_acknowledgement(&[])),
        |_| Ok(()),
        || {
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE",
                "cleanup unavailable",
            ))
        },
    );

    assert_eq!(
        result.expect_err("cleanup acknowledgement must be terminal").code,
        "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE"
    );
}

#[test]
fn macro_keyup_preserves_native_failure_after_attempting_cleanup() {
    let effect = guarded_key_effect("keyUp", "KeyA", true);
    let released = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || Ok(guard_acknowledgement(&[])),
        |_| {
            Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "native dispatch failed",
            ))
        },
        || {
            released.store(true, Ordering::Release);
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE",
                "cleanup unavailable",
            ))
        },
    );

    assert_eq!(
        result.expect_err("native failure must remain authoritative").code,
        "SYSTEM_TRUSTED_INPUT_FAILED"
    );
    assert!(released.load(Ordering::Acquire));
}

#[test]
fn guarded_dispatch_receives_the_foreground_physical_modifier_sides() {
    let effect = guarded_key_effect("rawKeyDown", "Digit4", true);
    let observed = Mutex::new(Vec::new());
    dispatch_guarded_macro_key_effect_with(
        &effect,
        || Ok(guard_acknowledgement(&["ShiftRight", "ControlLeft"])),
        |codes| {
            *observed.lock().unwrap() = codes.to_vec();
            Ok(())
        },
        || Ok(()),
    )
    .unwrap();

    assert_eq!(*observed.lock().unwrap(), ["ShiftRight", "ControlLeft"]);
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
    assert!(projections.iter().all(|projection| !projection.suppress_shortcut));
}

#[test]
fn physical_modifier_projection_does_not_inherit_background_or_repress_macro_owned_sides() {
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
fn macro_key_guard_script_serializes_code_phase_and_deadline() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA\"\\", true);
    let source = macro_key_guard_arm_script(&effect, 123_456).unwrap();

    assert!(source.contains("suppressNextShortcut"));
    assert!(source.contains(r#""KeyA\"\\""#));
    assert!(source.contains(r#""keydown""#));
    assert!(source.contains(",123456) === true"));
    assert!(source.contains("physicalModifierCodes"));
}

#[test]
fn macro_key_release_script_serializes_the_code() {
    let source = macro_key_guard_release_script("KeyA\"\\").unwrap();

    assert!(source.contains("releaseForwardedMacroKey"));
    assert!(source.contains(r#""KeyA\"\\""#));
    assert!(source.contains("acknowledged: true"));
    assert!(source.contains("released:"));
}

#[test]
fn macro_key_guard_acknowledgement_validates_armed_state_and_modifier_sides() {
    assert_eq!(
        macro_key_guard_acknowledgement(
            r#"{"armed":true,"physicalModifierCodes":["ShiftRight","ControlLeft"]}"#
        ),
        Some(guard_acknowledgement(&["ShiftRight", "ControlLeft"]))
    );
    assert_eq!(
        macro_key_guard_acknowledgement(
            r#""{\"armed\":true,\"physicalModifierCodes\":[\"ShiftLeft\"]}""#
        ),
        Some(guard_acknowledgement(&["ShiftLeft"]))
    );
    for raw in [
        r#"{"armed":false,"physicalModifierCodes":[]}"#,
        r#"{"armed":true,"physicalModifierCodes":["KeyA"]}"#,
        r#"{"armed":true,"physicalModifierCodes":["ShiftLeft","ShiftLeft"]}"#,
        "true",
        "null",
        "not-json",
    ] {
        assert!(macro_key_guard_acknowledgement(raw).is_none(), "{raw}");
    }
}

#[test]
fn macro_key_release_acknowledgement_is_structured_and_idempotent() {
    assert_eq!(
        macro_key_release_acknowledgement(r#"{"acknowledged":true,"released":true}"#),
        Some(MacroKeyReleaseAcknowledgement {
            acknowledged: true,
            released: true,
        })
    );
    assert_eq!(
        macro_key_release_acknowledgement(
            r#""{\"acknowledged\":true,\"released\":false}""#
        ),
        Some(MacroKeyReleaseAcknowledgement {
            acknowledged: true,
            released: false,
        })
    );
    for raw in [
        r#"{"acknowledged":false,"released":true}"#,
        r#"{"acknowledged":true}"#,
        "true",
        "null",
        "not-json",
    ] {
        assert!(macro_key_release_acknowledgement(raw).is_none(), "{raw}");
    }
}

#[cfg(windows)]
#[test]
fn windows_macro_key_guard_accepts_only_the_cdp_structured_terminal() {
    assert_eq!(
        macro_key_guard_devtools_acknowledgement(
            r#"{"result":{"type":"object","value":{"armed":true,"physicalModifierCodes":["ShiftLeft"]}}}"#
        ),
        Some(guard_acknowledgement(&["ShiftLeft"]))
    );
    assert!(macro_key_guard_devtools_acknowledgement(
        r#"{"result":{"type":"boolean","value":true}}"#
    )
    .is_none());
    assert!(macro_key_guard_devtools_acknowledgement(
        r#"{"exceptionDetails":{"text":"failed"}}"#
    )
    .is_none());
}

#[cfg(windows)]
#[test]
fn windows_macro_key_release_accepts_only_the_cdp_structured_terminal() {
    assert_eq!(
        macro_key_release_devtools_acknowledgement(
            r#"{"result":{"type":"object","value":{"acknowledged":true,"released":false}}}"#
        ),
        Some(MacroKeyReleaseAcknowledgement {
            acknowledged: true,
            released: false,
        })
    );
    assert!(macro_key_release_devtools_acknowledgement(
        r#"{"result":{"type":"boolean","value":true}}"#
    )
    .is_none());
    assert!(macro_key_release_devtools_acknowledgement(
        r#"{"exceptionDetails":{"text":"failed"}}"#
    )
    .is_none());
}

#[cfg(windows)]
#[test]
fn windows_macro_key_guard_uses_the_authoritative_action_callback_budget() {
    assert_eq!(MACRO_KEY_GUARD_MAX_LIFETIME, PLATFORM_CALLBACK_TIMEOUT);
}

#[test]
fn macro_focus_waits_for_essential_page_readiness() {
    for phase in [None, Some(LaunchPhase::Attaching), Some(LaunchPhase::Navigating)] {
        assert_eq!(
            focus_launch_readiness(phase),
            FocusLaunchReadiness::Pending,
            "{phase:?}"
        );
    }
    for phase in [
        LaunchPhase::EssentialReady,
        LaunchPhase::OptionalHydrating,
        LaunchPhase::Ready,
    ] {
        assert_eq!(
            focus_launch_readiness(Some(phase)),
            FocusLaunchReadiness::Ready,
            "{phase:?}"
        );
    }
    assert_eq!(
        focus_launch_readiness(Some(LaunchPhase::Degraded)),
        FocusLaunchReadiness::Unavailable
    );
}
