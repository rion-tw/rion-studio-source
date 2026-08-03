const MACRO_KEY_GUARD_MAX_LIFETIME: Duration = Duration::from_secs(1);
const MACRO_KEY_RELEASE_GUARD_WAIT: Duration = Duration::from_millis(100);

fn dispatch_guarded_macro_key_effect(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    dispatch_guarded_macro_key_effect_with(
        effect,
        || arm_macro_key_event_guard(webview, effect, context),
        || dispatch_key_effect(webview, effect, context),
        || {
            let _ = release_forwarded_macro_key(webview, effect);
        },
    )
}

fn dispatch_guarded_macro_key_effect_with(
    effect: &EmbeddedKeyEffectRecord,
    mut arm: impl FnMut() -> RuntimeResult<()>,
    dispatch: impl FnOnce() -> RuntimeResult<()>,
    release_forwarded: impl FnOnce(),
) -> RuntimeResult<()> {
    let guard = arm();
    if effect.phase != "keyUp" {
        guard?;
        return dispatch();
    }
    let dispatched = dispatch();
    if guard.is_err() {
        release_forwarded();
    }
    dispatched
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
    let wait = if effect.phase == "keyUp" {
        lifetime.min(MACRO_KEY_RELEASE_GUARD_WAIT)
    } else {
        lifetime
    };
    match receiver.recv_timeout(wait) {
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

fn release_forwarded_macro_key(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
) -> RuntimeResult<()> {
    let source = macro_key_guard_release_script(&effect.code)?;
    webview.eval(&source).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
            format!("Unable to release the forwarded macro key: {error}"),
        )
    })
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

fn macro_key_guard_release_script(code: &str) -> RuntimeResult<String> {
    let code = serde_json::to_string(code).map_err(|error| {
        RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string())
    })?;
    Ok(format!(
        "globalThis.__rionStudioMacroOverlay?.releaseForwardedMacroKey?.({code}) === true"
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
