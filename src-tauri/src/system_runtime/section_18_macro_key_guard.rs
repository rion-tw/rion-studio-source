const MACRO_KEY_OBSERVATION_MAX_WAIT: Duration = PLATFORM_CALLBACK_TIMEOUT;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MacroKeyEventObservation {
    dispatch_id: String,
    code: String,
    phase: String,
}

struct MacroKeyObservationWaiter {
    dispatch_id: String,
    receiver: mpsc::Receiver<MacroKeyObservationSignal>,
}

struct MacroKeyObservationError {
    dispatch_id: String,
    error: RuntimeError,
}

impl SystemRuntimeExecutor {
    fn dispatch_guarded_macro_key_effect(
        &self,
        role_id: &str,
        webview: &Webview,
        effect: &EmbeddedKeyEffectRecord,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        self.dispatch_guarded_macro_key_effect_inner(
            role_id, webview, effect, context, true, false,
        )
    }

    fn dispatch_guarded_macro_key_effect_inner(
        &self,
        role_id: &str,
        webview: &Webview,
        effect: &EmbeddedKeyEffectRecord,
        context: &InputDispatchContext,
        compensate_unknown: bool,
        modifier_projection: bool,
    ) -> RuntimeResult<()> {
        let (acknowledgement, waiter) =
            self.arm_macro_key_event_guard(
                role_id,
                webview,
                effect,
                context,
                modifier_projection,
            )?;
        let native_result = dispatch_key_effect(webview, effect, context);
        if native_result
            .as_ref()
            .is_err_and(|error| error.code != "SYSTEM_TRUSTED_INPUT_INDETERMINATE")
        {
            self.cancel_macro_key_observation(&waiter.dispatch_id);
            let cleanup = self.cleanup_input_context(context);
            let _ = cancel_macro_key_event_guard(webview, &waiter.dispatch_id, &cleanup);
            return native_result;
        }
        if native_result.is_ok() {
            self.record_macro_key_receipt(
                "macro-key-native-acknowledged",
                role_id,
                webview.label(),
                effect,
                &waiter.dispatch_id,
            );
        }
        let observed = self.wait_for_macro_key_observation(waiter, context);
        if let Err(observation_error) = observed {
            if observation_error.error.code != "SYSTEM_TRUSTED_INPUT_INDETERMINATE" {
                return Err(observation_error.error);
            }
            let cleanup = self.cleanup_input_context(context);
            let _ = cancel_macro_key_event_guard(
                webview,
                &observation_error.dispatch_id,
                &cleanup,
            );
            if compensate_unknown {
                let compensation = macro_key_compensation_effect(effect);
                if let Err(cleanup_error) = self.dispatch_guarded_macro_key_effect_inner(
                    role_id,
                    webview,
                    &compensation,
                    &cleanup,
                    false,
                    false,
                ) {
                    return Err(RuntimeError::new(
                        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                        format!(
                            "The page did not acknowledge {} {}; guarded cleanup also failed: {}",
                            effect.code, effect.phase, cleanup_error.message
                        ),
                    ));
                }
            }
            return Err(observation_error.error);
        }
        if let Err(error) = native_result
            && error.code != "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
        {
            return Err(error);
        }
        dispatch_key_effect_with_physical_modifiers(
            webview,
            effect,
            &acknowledgement.physical_modifier_codes,
            context,
            |projection| {
                self.dispatch_guarded_macro_key_effect_inner(
                    role_id,
                    webview,
                    projection,
                    context,
                    true,
                    true,
                )
            },
        )
    }

    fn arm_macro_key_event_guard(
        &self,
        role_id: &str,
        webview: &Webview,
        effect: &EmbeddedKeyEffectRecord,
        context: &InputDispatchContext,
        modifier_projection: bool,
    ) -> RuntimeResult<(MacroKeyGuardAcknowledgement, MacroKeyObservationWaiter)> {
        context.ensure_current()?;
        let waiter = self.register_macro_key_observation(role_id, webview, effect, context)?;
        let source = if modifier_projection {
            macro_modifier_projection_guard_arm_script(effect, &waiter.dispatch_id)
        } else {
            macro_key_guard_arm_script(effect, &waiter.dispatch_id)
        };
        let source = match source {
            Ok(source) => source,
            Err(error) => {
                self.cancel_macro_key_observation(&waiter.dispatch_id);
                return Err(error);
            }
        };
        let acknowledgement = arm_webview_macro_key_event_guard(webview, &source, context);
        match acknowledgement {
            Ok(acknowledgement) => {
                self.record_macro_key_receipt(
                    "macro-key-guard-armed",
                    role_id,
                    webview.label(),
                    effect,
                    &waiter.dispatch_id,
                );
                Ok((acknowledgement, waiter))
            }
            Err(error) => {
                self.cancel_macro_key_observation(&waiter.dispatch_id);
                let cleanup = self.cleanup_input_context(context);
                let _ = cancel_macro_key_event_guard(webview, &waiter.dispatch_id, &cleanup);
                Err(error)
            }
        }
    }

    fn register_macro_key_observation(
        &self,
        role_id: &str,
        webview: &Webview,
        effect: &EmbeddedKeyEffectRecord,
        context: &InputDispatchContext,
    ) -> RuntimeResult<MacroKeyObservationWaiter> {
        let phase = macro_key_dom_phase(effect)?;
        context.ensure_current()?;
        let dispatch_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::sync_channel(1);
        let pending = PendingMacroKeyObservation {
            code: effect.code.clone(),
            input_epoch: context.input_epoch,
            phase: phase.to_owned(),
            role_id: role_id.to_owned(),
            sender,
            surface_generation: context.surface_generation,
            webview_label: webview.label().to_owned(),
        };
        let mut observations = self.macro_key_observations.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_OBSERVATION_UNAVAILABLE",
                "The macro key observation registry is unavailable.",
            )
        })?;
        if observations
            .values()
            .any(|observation| observation.webview_label == webview.label())
        {
            return Err(RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_BUSY",
                "The role WebView already has a guarded key event in flight.",
            ));
        }
        observations.insert(dispatch_id.clone(), pending);
        Ok(MacroKeyObservationWaiter {
            dispatch_id,
            receiver,
        })
    }

    fn wait_for_macro_key_observation(
        &self,
        waiter: MacroKeyObservationWaiter,
        context: &InputDispatchContext,
    ) -> Result<(), MacroKeyObservationError> {
        let wait = context.remaining(MACRO_KEY_OBSERVATION_MAX_WAIT);
        let signal = if wait.is_zero() {
            Err(mpsc::RecvTimeoutError::Timeout)
        } else {
            waiter.receiver.recv_timeout(wait)
        };
        match signal {
            Ok(MacroKeyObservationSignal::Observed) => context.ensure_current().map_err(|error| {
                MacroKeyObservationError {
                    dispatch_id: waiter.dispatch_id,
                    error,
                }
            }),
            Ok(MacroKeyObservationSignal::Cancelled) => Err(MacroKeyObservationError {
                dispatch_id: waiter.dispatch_id,
                error: RuntimeError::new(
                    "BROWSER_ACTION_STALE",
                    "The role surface changed before trusted key delivery was acknowledged.",
                ),
            }),
            Err(_) => {
                self.cancel_macro_key_observation(&waiter.dispatch_id);
                Err(MacroKeyObservationError {
                    dispatch_id: waiter.dispatch_id,
                    error: RuntimeError::new(
                        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                        "Native key submission was not acknowledged by a matching trusted DOM event before its deadline.",
                    ),
                })
            }
        }
    }

    pub(crate) fn observe_macro_key_event(
        &self,
        webview_label: &str,
        role_id: &str,
        observation: MacroKeyEventObservation,
    ) -> RuntimeResult<()> {
        let lane = self.role_input_lane(role_id)?;
        let pending = claim_macro_key_observation(
            &self.macro_key_observations,
            &lane,
            webview_label,
            role_id,
            &observation,
        )?;
        let _ = pending.sender.send(MacroKeyObservationSignal::Observed);
        self.record_macro_key_observation_receipt(
            role_id,
            webview_label,
            &observation.code,
            &observation.phase,
            &observation.dispatch_id,
        );
        Ok(())
    }

    fn cancel_macro_key_observation(&self, dispatch_id: &str) {
        let pending = self
            .macro_key_observations
            .lock()
            .ok()
            .and_then(|mut observations| observations.remove(dispatch_id));
        if let Some(pending) = pending {
            let _ = pending.sender.send(MacroKeyObservationSignal::Cancelled);
        }
    }

    fn cancel_macro_key_observations_for_webview(&self, webview_label: &str) {
        cancel_macro_key_observations_matching(&self.macro_key_observations, |pending| {
            pending.webview_label == webview_label
        });
    }

    fn cancel_macro_key_observations_for_role(&self, role_id: &str) {
        cancel_macro_key_observations_matching(&self.macro_key_observations, |pending| {
            pending.role_id == role_id
        });
    }

    #[cfg(not(feature = "desktop-e2e"))]
    fn record_macro_key_receipt(
        &self,
        _kind: &str,
        _role_id: &str,
        _webview_label: &str,
        _effect: &EmbeddedKeyEffectRecord,
        _dispatch_id: &str,
    ) {
    }

    #[cfg(feature = "desktop-e2e")]
    fn record_macro_key_receipt(
        &self,
        kind: &str,
        role_id: &str,
        webview_label: &str,
        effect: &EmbeddedKeyEffectRecord,
        dispatch_id: &str,
    ) {
        crate::desktop_e2e::record_event(
            kind,
            self.window_id_for_webview(webview_label).as_deref(),
            None,
            None,
            json!({
                "code": effect.code,
                "dispatchId": dispatch_id,
                "phase": macro_key_dom_phase(effect).ok(),
                "roleId": role_id,
                "webviewLabel": webview_label,
            }),
        );
    }

    #[cfg(not(feature = "desktop-e2e"))]
    fn record_macro_key_observation_receipt(
        &self,
        _role_id: &str,
        _webview_label: &str,
        _code: &str,
        _phase: &str,
        _dispatch_id: &str,
    ) {
    }

    #[cfg(feature = "desktop-e2e")]
    fn record_macro_key_observation_receipt(
        &self,
        role_id: &str,
        webview_label: &str,
        code: &str,
        phase: &str,
        dispatch_id: &str,
    ) {
        crate::desktop_e2e::record_event(
            "macro-key-dom-observed",
            self.window_id_for_webview(webview_label).as_deref(),
            None,
            None,
            json!({
                "code": code,
                "dispatchId": dispatch_id,
                "phase": phase,
                "roleId": role_id,
                "webviewLabel": webview_label,
            }),
        );
    }
}

fn claim_macro_key_observation(
    observations: &Mutex<HashMap<String, PendingMacroKeyObservation>>,
    lane: &RoleInputDispatchLane,
    webview_label: &str,
    role_id: &str,
    observation: &MacroKeyEventObservation,
) -> RuntimeResult<PendingMacroKeyObservation> {
    let mut observations = observations.lock().map_err(|_| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_OBSERVATION_UNAVAILABLE",
            "The macro key observation registry is unavailable.",
        )
    })?;
    let pending = observations.get(&observation.dispatch_id).ok_or_else(|| {
        RuntimeError::new(
            "SYSTEM_MACRO_KEY_OBSERVATION_STALE",
            "The macro key observation is stale or was already consumed.",
        )
    })?;
    if pending.webview_label != webview_label
        || pending.role_id != role_id
        || pending.code != observation.code
        || pending.phase != observation.phase
    {
        return Err(RuntimeError::new(
            "SYSTEM_MACRO_KEY_OBSERVATION_MISMATCH",
            "The macro key observation does not match its guarded dispatch.",
        ));
    }
    if lane.epoch.load(Ordering::Acquire) != pending.input_epoch
        || lane.surface_generation.load(Ordering::Acquire) != pending.surface_generation
    {
        return Err(RuntimeError::new(
            "SYSTEM_MACRO_KEY_OBSERVATION_STALE",
            "The macro key observation belongs to an obsolete role surface.",
        ));
    }
    Ok(observations
        .remove(&observation.dispatch_id)
        .expect("validated macro key observation must remain registered"))
}

fn cancel_macro_key_observations_matching(
    observations: &Mutex<HashMap<String, PendingMacroKeyObservation>>,
    matches: impl Fn(&PendingMacroKeyObservation) -> bool,
) {
    let pending = observations
        .lock()
        .ok()
        .map(|mut observations| {
            let dispatch_ids = observations
                .iter()
                .filter_map(|(dispatch_id, pending)| matches(pending).then_some(dispatch_id.clone()))
                .collect::<Vec<_>>();
            dispatch_ids
                .into_iter()
                .filter_map(|dispatch_id| observations.remove(&dispatch_id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for pending in pending {
        let _ = pending.sender.send(MacroKeyObservationSignal::Cancelled);
    }
}

fn macro_key_compensation_effect(effect: &EmbeddedKeyEffectRecord) -> EmbeddedKeyEffectRecord {
    let mut active_codes = effect.active_codes.clone();
    active_codes.retain(|code| code != &effect.code);
    EmbeddedKeyEffectRecord {
        phase: "keyUp".to_owned(),
        code: effect.code.clone(),
        active_codes_before: effect.active_codes.clone(),
        active_codes,
        auto_repeat: false,
        suppress_shortcut: effect.suppress_shortcut,
    }
}

fn macro_key_dom_phase(effect: &EmbeddedKeyEffectRecord) -> RuntimeResult<&'static str> {
    match effect.phase.as_str() {
        "rawKeyDown" => Ok("keydown"),
        "keyUp" => Ok("keyup"),
        _ => Err(RuntimeError::new(
            "SYSTEM_MACRO_KEY_GUARD_INVALID",
            "Macro key guard received an unsupported key phase.",
        )),
    }
}

fn arm_webview_macro_key_event_guard(
    webview: &Webview,
    source: &str,
    context: &InputDispatchContext,
) -> RuntimeResult<MacroKeyGuardAcknowledgement> {
    #[cfg(windows)]
    {
        let raw = call_system_input_devtools_bounded(
            webview,
            "Runtime.evaluate",
            &json!({ "expression": source, "returnByValue": true }),
            context,
            context.remaining(PLATFORM_CALLBACK_TIMEOUT),
        )?;
        macro_key_guard_devtools_acknowledgement(&raw).ok_or_else(|| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                "The game page did not acknowledge the macro key guard.",
            )
        })
    }
    #[cfg(not(windows))]
    {
        let (sender, receiver) = mpsc::sync_channel(1);
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
        let raw = receiver
            .recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT))
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_MACRO_KEY_GUARD_TIMEOUT",
                    "The macro key guard did not become ready before input dispatch.",
                )
            })?;
        macro_key_guard_acknowledgement(&raw).ok_or_else(|| {
            RuntimeError::new(
                "SYSTEM_MACRO_KEY_GUARD_UNAVAILABLE",
                "The game page did not acknowledge the macro key guard.",
            )
        })
    }
}

fn cancel_macro_key_event_guard(
    webview: &Webview,
    dispatch_id: &str,
    context: &InputDispatchContext,
) -> RuntimeResult<()> {
    let dispatch_id = serde_json::to_string(dispatch_id)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    let source = format!(
        "globalThis.__rionStudioMacroOverlay?.clearSuppressedShortcut?.({dispatch_id}) === true"
    );
    #[cfg(windows)]
    {
        call_system_input_devtools_bounded(
            webview,
            "Runtime.evaluate",
            &json!({ "expression": source, "returnByValue": true }),
            context,
            context.remaining(PLATFORM_CALLBACK_TIMEOUT),
        )?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .eval_with_callback(source, move |value| {
                let _ = sender.send(value);
            })
            .map_err(RuntimeError::tauri)?;
        receiver
            .recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT))
            .map(|_| ())
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_MACRO_KEY_GUARD_TIMEOUT",
                    "The page did not acknowledge guarded key cancellation.",
                )
            })
    }
}

fn macro_key_guard_arm_script(
    effect: &EmbeddedKeyEffectRecord,
    dispatch_id: &str,
) -> RuntimeResult<String> {
    let phase = serde_json::to_string(macro_key_dom_phase(effect)?)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    let code = serde_json::to_string(&effect.code)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    let dispatch_id = serde_json::to_string(dispatch_id)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    Ok(format!(
        "(() => {{ const controller = globalThis.__rionStudioMacroOverlay; const armed = controller?.suppressNextShortcut?.({dispatch_id},{code},{phase}) === true; const physicalModifierCodes = armed ? controller?.physicalModifierCodes?.() : []; return {{ armed, physicalModifierCodes: Array.isArray(physicalModifierCodes) ? physicalModifierCodes : [] }}; }})()"
    ))
}

fn macro_modifier_projection_guard_arm_script(
    effect: &EmbeddedKeyEffectRecord,
    dispatch_id: &str,
) -> RuntimeResult<String> {
    if effect.phase != "rawKeyDown" || !is_modifier_input_code(&effect.code) {
        return Err(RuntimeError::new(
            "SYSTEM_MACRO_KEY_GUARD_INVALID",
            "A modifier projection guard requires a modifier keydown.",
        ));
    }
    let code = serde_json::to_string(&effect.code)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    let dispatch_id = serde_json::to_string(dispatch_id)
        .map_err(|error| RuntimeError::new("SYSTEM_MACRO_KEY_GUARD_INVALID", error.to_string()))?;
    Ok(format!(
        "(() => {{ const controller = globalThis.__rionStudioMacroOverlay; const armed = controller?.suppressNextModifierProjection?.({dispatch_id},{code}) === true; return {{ armed, physicalModifierCodes: [] }}; }})()"
    ))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MacroKeyGuardAcknowledgement {
    armed: bool,
    physical_modifier_codes: Vec<String>,
}

fn parse_macro_key_guard_acknowledgement(value: Value) -> Option<MacroKeyGuardAcknowledgement> {
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

#[cfg(any(not(windows), test))]
fn macro_key_guard_acknowledgement(raw: &str) -> Option<MacroKeyGuardAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(parse_macro_key_guard_acknowledgement)
}

#[cfg(windows)]
fn macro_key_guard_devtools_acknowledgement(raw: &str) -> Option<MacroKeyGuardAcknowledgement> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.pointer("/result/value").cloned())
        .and_then(parse_macro_key_guard_acknowledgement)
}
