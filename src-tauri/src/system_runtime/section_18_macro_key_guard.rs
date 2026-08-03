const MACRO_KEY_GUARD_MAX_LIFETIME: Duration = Duration::from_secs(1);

fn dispatch_guarded_macro_key_effect(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    dispatch_guarded_macro_key_effect_with(
        effect,
        || arm_macro_key_event_guard(webview, effect, context),
        || dispatch_key_effect(webview, effect, context),
    )
}

fn dispatch_guarded_macro_key_effect_with(
    effect: &EmbeddedKeyEffectRecord,
    mut arm: impl FnMut() -> RuntimeResult<()>,
    dispatch: impl FnOnce() -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    if effect.suppress_shortcut {
        let guard = arm();
        if effect.phase == "rawKeyDown" {
            guard?;
        }
    }
    dispatch()
}

fn arm_macro_key_event_guard(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    context.ensure_current()?;
    let lifetime = context.remaining(MACRO_KEY_GUARD_MAX_LIFETIME);
    if lifetime.is_zero() {
        return Err(RuntimeError::new(
            "BROWSER_ACTION_DEADLINE",
            "Macro key guard expired before it could be armed.",
        ));
    }
    let expires_at_ms = chrono::Utc::now()
        .timestamp_millis()
        .max(0)
        .saturating_add(lifetime.as_millis().min(i64::MAX as u128) as i64);
    let source = macro_key_guard_arm_script(effect, expires_at_ms)?;
    if effect.phase == "keyUp" {
        return webview.eval(&source).map_err(|error| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                format!("Unable to arm the macro key release guard: {error}"),
            )
        });
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(&source, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|error| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                format!("Unable to arm the macro key guard: {error}"),
            )
        })?;
    match receiver.recv_timeout(lifetime) {
        Ok(value) if macro_key_guard_acknowledged(&value) => Ok(()),
        Ok(_) => Err(RuntimeError::new(
            "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
            "The game page did not acknowledge the macro key guard.",
        )),
        Err(_) => {
            context.ensure_current()?;
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_TIMEOUT",
                "The macro key guard did not become ready before input dispatch.",
            ))
        }
    }
}

fn macro_key_guard_arm_script(
    effect: &EmbeddedKeyEffectRecord,
    expires_at_ms: i64,
) -> RuntimeResult<String> {
    let phase = match effect.phase.as_str() {
        "rawKeyDown" => "keydown",
        "keyUp" => "keyup",
        _ => {
            return Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_INVALID",
                "Macro key guard received an unsupported key phase.",
            ));
        }
    };
    let code = serde_json::to_string(&effect.code).map_err(|error| {
        RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string())
    })?;
    let phase = serde_json::to_string(phase).map_err(|error| {
        RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string())
    })?;
    Ok(format!(
        "globalThis.__rionStudioMacroOverlay?.suppressNextShortcut?.({code},{phase},{expires_at_ms}) === true"
    ))
}

fn macro_key_guard_acknowledged(raw: &str) -> bool {
    fn acknowledged(value: &Value) -> bool {
        match value {
            Value::Bool(value) => *value,
            Value::String(value) => serde_json::from_str::<Value>(value)
                .ok()
                .is_some_and(|nested| acknowledged(&nested)),
            _ => false,
        }
    }

    serde_json::from_str::<Value>(raw)
        .ok()
        .is_some_and(|value| acknowledged(&value))
}
