const AUTOMATIC_INPUT_CONTEXT_BLOCKED: &str = "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED";

impl SystemRuntimeExecutor {
    fn preflight_automatic_input_context(
        &self,
        role_id: &str,
        webview: &Webview,
        context: &InputDispatchContext,
    ) -> RuntimeResult<()> {
        let readback = read_automatic_input_context(webview, context)?;
        let target = self.observe_automatic_input_context(role_id, webview.label(), readback)?;
        if target == AutomaticInputContextTarget::EmbeddedFrame {
            return Err(automatic_input_context_blocked_error());
        }
        Ok(())
    }

    pub(crate) fn observe_overlay_automatic_input_context(
        &self,
        role_id: &str,
        webview_label: &str,
        document_instance_id: String,
        revision: u64,
        target: &str,
    ) -> RuntimeResult<()> {
        let target = match target {
            "game" => AutomaticInputContextTarget::Game,
            "embedded-frame" => AutomaticInputContextTarget::EmbeddedFrame,
            "document" => AutomaticInputContextTarget::Document,
            _ => {
                return Err(RuntimeError::new(
                    "SYSTEM_AUTOMATIC_INPUT_CONTEXT_INVALID",
                    "The automatic input context target is invalid.",
                ));
            }
        };
        self.observe_automatic_input_context(
            role_id,
            webview_label,
            AutomaticInputContextReadback {
                document_instance_id,
                revision,
                target,
            },
        )?;
        Ok(())
    }

    fn observe_automatic_input_context(
        &self,
        role_id: &str,
        webview_label: &str,
        readback: AutomaticInputContextReadback,
    ) -> RuntimeResult<AutomaticInputContextTarget> {
        if readback.document_instance_id.is_empty()
            || readback.document_instance_id.len() > 256
            || readback.revision == 0
        {
            return Err(RuntimeError::new(
                "SYSTEM_AUTOMATIC_INPUT_CONTEXT_INVALID",
                "The automatic input context identity is invalid.",
            ));
        }

        let (accepted, recovery_epoch) = {
            let mut state = self.state()?;
            let generation = state
                .native_resources
                .tabs
                .values()
                .find_map(|tab| tab.roles.get(role_id))
                .filter(|surface| surface.webview.label() == webview_label)
                .map(|surface| surface.generation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        "SYSTEM_AUTOMATIC_INPUT_CONTEXT_STALE",
                        "The automatic input context belongs to an obsolete role surface.",
                    )
                })?;

            let previous = state.automatic_input_contexts.get(role_id).cloned();
            let stale = automatic_input_context_is_stale(
                previous.as_ref(),
                state
                    .last_completed_document_ids
                    .get(webview_label)
                    .map(String::as_str),
                &readback,
                generation,
                webview_label,
            );
            if stale {
                return Ok(previous
                    .map(|previous| previous.target)
                    .unwrap_or(AutomaticInputContextTarget::Document));
            }

            state.automatic_input_contexts.insert(
                role_id.to_owned(),
                RoleAutomaticInputContext {
                    document_instance_id: readback.document_instance_id.clone(),
                    revision: readback.revision,
                    surface_generation: generation,
                    target: readback.target,
                    webview_label: webview_label.to_owned(),
                },
            );
            let recovery_epoch = state.macro_input_recoveries.get_mut(role_id).and_then(|recovery| {
                if recovery.surface_generation != generation
                    || matches!(
                        recovery.evidence,
                        MacroInputRecoveryEvidence::DocumentReplacementPending
                            | MacroInputRecoveryEvidence::DocumentReplaced
                    )
                {
                    return None;
                }
                match readback.target {
                    AutomaticInputContextTarget::EmbeddedFrame => {
                        recovery.evidence = MacroInputRecoveryEvidence::InputContextBlocked;
                    }
                    AutomaticInputContextTarget::Game
                        if recovery.evidence == MacroInputRecoveryEvidence::InputContextBlocked =>
                    {
                        recovery.evidence = MacroInputRecoveryEvidence::InputContextRestored;
                    }
                    _ => {}
                }
                (recovery.input_epoch > 0).then_some(recovery.input_epoch)
            });
            (true, recovery_epoch)
        };

        if accepted {
            match readback.target {
                AutomaticInputContextTarget::EmbeddedFrame => {
                    let recovery_id = format!("input-context-{}", uuid::Uuid::new_v4());
                    self.schedule_macro_input_recovery(
                        role_id,
                        &recovery_id,
                        &automatic_input_context_blocked_error(),
                    );
                    self.publish_projection();
                }
                AutomaticInputContextTarget::Game => {
                    if let Some(input_epoch) = recovery_epoch {
                        self.try_resume_navigation_input(role_id, input_epoch);
                    }
                    self.publish_projection();
                }
                AutomaticInputContextTarget::Document => {}
            }
        }
        Ok(readback.target)
    }
}

fn automatic_input_context_is_stale(
    previous: Option<&RoleAutomaticInputContext>,
    completed_document_id: Option<&str>,
    readback: &AutomaticInputContextReadback,
    surface_generation: u64,
    webview_label: &str,
) -> bool {
    if completed_document_id.is_some_and(|document_id| {
        document_id != readback.document_instance_id
    }) {
        return true;
    }
    previous.is_some_and(|previous| {
        previous.surface_generation != surface_generation
            || previous.webview_label != webview_label
            || (previous.document_instance_id == readback.document_instance_id
                && previous.revision >= readback.revision)
    })
}

fn automatic_input_context_blocked_error() -> RuntimeError {
    RuntimeError::new(
        AUTOMATIC_INPUT_CONTEXT_BLOCKED,
        "Automatic input is paused while an embedded frame owns the page input context.",
    )
}

fn read_automatic_input_context(
    webview: &Webview,
    context: &InputDispatchContext,
) -> RuntimeResult<AutomaticInputContextReadback> {
    let source = "(() => { const value = globalThis.__rionStudioMacroOverlay?.automaticInputContext?.(); return JSON.stringify(value ?? null); })()";
    #[cfg(windows)]
    {
        let raw = call_system_input_devtools_bounded(
            webview,
            "Runtime.evaluate",
            &json!({ "expression": source, "returnByValue": true }),
            context,
            context.remaining(PLATFORM_CALLBACK_TIMEOUT),
        )?;
        let value = serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| value.pointer("/result/value").cloned())
            .ok_or_else(automatic_input_context_unavailable_error)?;
        parse_automatic_input_context(value)
            .ok_or_else(automatic_input_context_unavailable_error)
    }
    #[cfg(not(windows))]
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .eval_with_callback(source, move |value| {
                let _ = sender.send(value);
            })
            .map_err(RuntimeError::tauri)?;
        let raw = receiver
            .recv_timeout(context.remaining(PLATFORM_CALLBACK_TIMEOUT))
            .map_err(|_| automatic_input_context_unavailable_error())?;
        parse_automatic_input_context(Value::String(raw))
            .ok_or_else(automatic_input_context_unavailable_error)
    }
}

fn parse_automatic_input_context(value: Value) -> Option<AutomaticInputContextReadback> {
    match value {
        Value::String(nested) => serde_json::from_str::<Value>(&nested)
            .ok()
            .and_then(parse_automatic_input_context),
        value => serde_json::from_value(value).ok(),
    }
}

fn automatic_input_context_unavailable_error() -> RuntimeError {
    RuntimeError::new(
        "SYSTEM_AUTOMATIC_INPUT_CONTEXT_UNAVAILABLE",
        "The page did not expose its automatic input context before native input submission.",
    )
}
