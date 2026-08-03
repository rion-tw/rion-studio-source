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

#[test]
fn macro_main_keydown_arms_the_page_guard_before_native_dispatch() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA", true);
    let order = Mutex::new(Vec::new());
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || {
            order.lock().unwrap().push("arm");
            Ok(())
        },
        || {
            order.lock().unwrap().push("dispatch");
            Ok(())
        },
        || order.lock().unwrap().push("release"),
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
        || {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || {},
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
        || {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || released.store(true, Ordering::Release),
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
            Ok(())
        },
        || {
            dispatched.store(true, Ordering::Release);
            Ok(())
        },
        || {},
    );

    assert!(result.is_ok());
    assert!(armed.load(Ordering::Acquire));
    assert!(dispatched.load(Ordering::Acquire));
}

#[test]
fn successful_keyup_guard_does_not_run_forwarded_release_fallback() {
    let effect = guarded_key_effect("keyUp", "KeyA", true);
    let released = AtomicBool::new(false);
    let result = dispatch_guarded_macro_key_effect_with(
        &effect,
        || Ok(()),
        || Ok(()),
        || released.store(true, Ordering::Release),
    );

    assert!(result.is_ok());
    assert!(!released.load(Ordering::Acquire));
}

#[test]
fn macro_key_guard_script_serializes_code_phase_and_deadline() {
    let effect = guarded_key_effect("rawKeyDown", "KeyA\"\\", true);
    let source = macro_key_guard_arm_script(&effect, 123_456).unwrap();

    assert!(source.contains("suppressNextShortcut"));
    assert!(source.contains(r#""KeyA\"\\""#));
    assert!(source.contains(r#""keydown""#));
    assert!(source.ends_with(",123456) === true"));
}

#[test]
fn macro_key_release_script_serializes_the_code() {
    let source = macro_key_guard_release_script("KeyA\"\\").unwrap();

    assert!(source.contains("releaseForwardedMacroKey"));
    assert!(source.contains(r#""KeyA\"\\""#));
    assert!(source.ends_with(") === true"));
}

#[test]
fn macro_key_guard_acknowledgement_accepts_only_boolean_true() {
    assert!(macro_key_guard_acknowledged("true"));
    assert!(macro_key_guard_acknowledged(r#""true""#));
    assert!(!macro_key_guard_acknowledged("false"));
    assert!(!macro_key_guard_acknowledged(r#""false""#));
    assert!(!macro_key_guard_acknowledged("null"));
    assert!(!macro_key_guard_acknowledged("not-json"));
}
