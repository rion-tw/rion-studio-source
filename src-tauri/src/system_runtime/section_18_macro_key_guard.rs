#[cfg(windows)]
const MACRO_KEY_GUARD_MAX_LIFETIME: Duration = PLATFORM_CALLBACK_TIMEOUT;
#[cfg(not(windows))]
const MACRO_KEY_GUARD_MAX_LIFETIME: Duration = Duration::from_secs(1);
#[cfg(not(windows))]
const MACRO_KEY_RELEASE_GUARD_WAIT: Duration = Duration::from_millis(100);

fn dispatch_guarded_macro_key_effect(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    dispatch_guarded_macro_key_effect_with(
        effect,
        || arm_macro_key_event_guard(webview, effect, context),
        |physical_modifier_codes| {
            dispatch_key_effect_with_physical_modifiers(
                webview,
                effect,
                physical_modifier_codes,
                context,
            )
        },
        || acknowledge_forwarded_macro_key_release(webview, effect, context).map(|_| ()),
    )
}

fn dispatch_guarded_macro_key_effect_with(
    effect: &EmbeddedKeyEffectRecord,
    mut arm: impl FnMut() -> RuntimeResult<MacroKeyGuardAcknowledgement>,
    dispatch: impl FnOnce(&[String]) -> RuntimeResult<()>,
    release_forwarded: impl FnOnce() -> RuntimeResult<()>,
) -> RuntimeResult<()> {
    let guard = arm();
    if effect.phase != "keyUp" {
        let acknowledgement = guard?;
        return dispatch(&acknowledgement.physical_modifier_codes);
    }
    let physical_modifier_codes = guard
        .as_ref()
        .map(|acknowledgement| acknowledgement.physical_modifier_codes.as_slice())
        .unwrap_or_default();
    let dispatched = dispatch(physical_modifier_codes);
    let released = release_forwarded();
    match (dispatched, released) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn arm_macro_key_event_guard(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<MacroKeyGuardAcknowledgement> {
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
    #[cfg(windows)]
    return arm_windows_macro_key_event_guard(webview, &source, context, lifetime);
    #[cfg(not(windows))]
    {
        arm_webview_macro_key_event_guard(webview, &source, effect, context, lifetime)
    }
}

#[cfg(not(windows))]
fn arm_webview_macro_key_event_guard(
    webview: &Webview,
    source: &str,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
    lifetime: Duration,
) -> RuntimeResult<MacroKeyGuardAcknowledgement> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(source, move |value| {
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
        Ok(value) => macro_key_guard_acknowledgement(&value).ok_or_else(|| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                "The game page did not acknowledge the macro key guard.",
            )
        }),
        Err(_) => {
            context.ensure_current()?;
            Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_TIMEOUT",
                "The macro key guard did not become ready before input dispatch.",
            ))
        }
    }
}

#[cfg(windows)]
fn arm_windows_macro_key_event_guard(
    webview: &Webview,
    source: &str,
    context: &InputDispatchContext,
    lifetime: Duration,
) -> RuntimeResult<MacroKeyGuardAcknowledgement> {
    let result = call_system_input_devtools_bounded(
        webview,
        "Runtime.evaluate",
        &json!({
            "expression": source,
            "returnByValue": true
        }),
        context,
        lifetime,
    );
    let raw = match result {
        Ok(raw) => raw,
        Err(error)
            if matches!(
                error.code,
                "BROWSER_ACTION_DEADLINE" | "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
            ) =>
        {
            context.ensure_current()?;
            return Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_TIMEOUT",
                "The macro key guard did not become ready before input dispatch.",
            ));
        }
        Err(error) => return Err(error),
    };
    macro_key_guard_devtools_acknowledgement(&raw).ok_or_else(|| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
            "The game page did not acknowledge the macro key guard.",
        )
    })
}

#[cfg(windows)]
fn macro_key_guard_devtools_acknowledgement(raw: &str) -> Option<MacroKeyGuardAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.pointer("/result/value").cloned())
        .and_then(parse_macro_key_guard_acknowledgement)
}

fn acknowledge_forwarded_macro_key_release(
    webview: &Webview,
    effect: &EmbeddedKeyEffectRecord,
    context: &InputDispatchContext,
) -> RuntimeResult<MacroKeyReleaseAcknowledgement> {
    let source = macro_key_guard_release_script(&effect.code)?;
    #[cfg(windows)]
    return acknowledge_windows_forwarded_macro_key_release(webview, &source, context);
    #[cfg(not(windows))]
    {
        let _ = context;
        acknowledge_webview_forwarded_macro_key_release(webview, &source)
    }
}

#[cfg(not(windows))]
fn acknowledge_webview_forwarded_macro_key_release(
    webview: &Webview,
    source: &str,
) -> RuntimeResult<MacroKeyReleaseAcknowledgement> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .eval_with_callback(source, move |value| {
            let _ = sender.send(value);
        })
        .map_err(|error| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE",
                format!("Unable to submit forwarded macro key cleanup: {error}"),
            )
        })?;
    let raw = receiver
        .recv_timeout(MACRO_KEY_RELEASE_GUARD_WAIT)
        .map_err(|_| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_RELEASE_TIMEOUT",
                "The game page did not acknowledge forwarded macro key cleanup.",
            )
        })?;
    macro_key_release_acknowledgement(&raw).ok_or_else(|| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE",
            "The game page returned an invalid forwarded macro key cleanup acknowledgement.",
        )
    })
}

#[cfg(windows)]
fn acknowledge_windows_forwarded_macro_key_release(
    webview: &Webview,
    source: &str,
    context: &InputDispatchContext,
) -> RuntimeResult<MacroKeyReleaseAcknowledgement> {
    let raw = call_system_input_devtools_bounded(
        webview,
        "Runtime.evaluate",
        &json!({
            "expression": source,
            "returnByValue": true
        }),
        context,
        MACRO_KEY_GUARD_MAX_LIFETIME,
    )?;
    macro_key_release_devtools_acknowledgement(&raw).ok_or_else(|| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_RELEASE_UNAVAILABLE",
            "The game page returned an invalid forwarded macro key cleanup acknowledgement.",
        )
    })
}

#[cfg(windows)]
fn macro_key_release_devtools_acknowledgement(
    raw: &str,
) -> Option<MacroKeyReleaseAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.pointer("/result/value").cloned())
        .and_then(parse_macro_key_release_acknowledgement)
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
        "(() => {{ const controller = globalThis.__rionStudioMacroOverlay; const armed = controller?.suppressNextShortcut?.({code},{phase},{expires_at_ms}) === true; const physicalModifierCodes = armed ? controller?.physicalModifierCodes?.() : []; return {{ armed, physicalModifierCodes: Array.isArray(physicalModifierCodes) ? physicalModifierCodes : [] }}; }})()"
    ))
}

fn macro_key_guard_release_script(code: &str) -> RuntimeResult<String> {
    let code = serde_json::to_string(code).map_err(|error| {
        RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string())
    })?;
    Ok(format!(
        "(() => {{ const controller = globalThis.__rionStudioMacroOverlay; if (typeof controller?.releaseForwardedMacroKey !== 'function') return {{ acknowledged: false, released: false }}; return {{ acknowledged: true, released: controller.releaseForwardedMacroKey({code}) === true }}; }})()"
    ))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MacroKeyGuardAcknowledgement {
    armed: bool,
    physical_modifier_codes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MacroKeyReleaseAcknowledgement {
    acknowledged: bool,
    released: bool,
}

fn parse_macro_key_guard_acknowledgement(
    value: Value,
) -> Option<MacroKeyGuardAcknowledgement> {
    if let Value::String(nested) = value {
        return serde_json::from_str::<Value>(&nested)
            .ok()
            .and_then(parse_macro_key_guard_acknowledgement);
    }
    let acknowledgement = serde_json::from_value::<MacroKeyGuardAcknowledgement>(value).ok()?;
    if !acknowledgement.armed || acknowledgement.physical_modifier_codes.len() > 8 {
        return None;
    }
    let mut seen = HashSet::new();
    if acknowledgement
        .physical_modifier_codes
        .iter()
        .any(|code| !is_modifier_input_code(code) || !seen.insert(code))
    {
        return None;
    }
    Some(acknowledgement)
}

fn parse_macro_key_release_acknowledgement(
    value: Value,
) -> Option<MacroKeyReleaseAcknowledgement> {
    if let Value::String(nested) = value {
        return serde_json::from_str::<Value>(&nested)
            .ok()
            .and_then(parse_macro_key_release_acknowledgement);
    }
    let acknowledgement = serde_json::from_value::<MacroKeyReleaseAcknowledgement>(value).ok()?;
    acknowledgement.acknowledged.then_some(acknowledgement)
}

#[cfg(any(not(windows), test))]
fn macro_key_guard_acknowledgement(raw: &str) -> Option<MacroKeyGuardAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(parse_macro_key_guard_acknowledgement)
}

#[cfg(any(not(windows), test))]
fn macro_key_release_acknowledgement(raw: &str) -> Option<MacroKeyReleaseAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(parse_macro_key_release_acknowledgement)
}
