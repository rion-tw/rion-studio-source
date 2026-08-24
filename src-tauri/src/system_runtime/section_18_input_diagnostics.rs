impl SystemRuntimeExecutor {
    #[allow(clippy::too_many_arguments)]
    fn record_macro_browser_action_result(
        &self,
        request_id: &str,
        role_id: &str,
        input_epoch: u64,
        intent: &str,
        scheduled_at_ms: u64,
        deadline_ms: u64,
        diagnostic: Value,
        started: Instant,
        result: &RuntimeResult<Option<String>>,
    ) {
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let lane = self
            .input_dispatch_lanes
            .lock()
            .ok()
            .and_then(|lanes| lanes.get(role_id).cloned());
        let role_tab = self.state.lock().ok().and_then(|state| {
            let tab_id = state.native_tab_id_for_role_surface(role_id)?.clone();
            let window_id = state.native_host_for_tab_handle(&tab_id)?;
            Some((tab_id, window_id))
        });
        let tab_selected = role_tab.as_ref().and_then(|(tab_id, window_id)| {
            self.presentation
                .live
                .kernel
                .snapshot()
                .ok()?
                .native_projection(window_id)
                .and_then(|projection| {
                    projection
                        .tabs
                        .iter()
                        .find(|tab| tab.tab_id == *tab_id)
                        .map(|tab| tab.selected)
                })
        });
        let mut context = diagnostic.as_object().cloned().unwrap_or_default();
        context.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
        context.insert("roleId".to_owned(), Value::String(role_id.to_owned()));
        context.insert("inputEpoch".to_owned(), Value::from(input_epoch));
        let lifecycle = self.application_lifecycle_status();
        context.insert(
            "applicationLifecycleEpoch".to_owned(),
            Value::from(lifecycle.lifecycle_epoch),
        );
        context.insert(
            "applicationLifecycleState".to_owned(),
            Value::String(lifecycle.state),
        );
        context.insert("intent".to_owned(), Value::String(intent.to_owned()));
        context.insert(
            "tabSelected".to_owned(),
            tab_selected.map(Value::from).unwrap_or(Value::Null),
        );
        context.insert(
            "scheduledAgeMs".to_owned(),
            Value::from(now_ms.saturating_sub(scheduled_at_ms)),
        );
        context.insert(
            "deadlineRemainingMs".to_owned(),
            Value::from(deadline_ms.saturating_sub(now_ms)),
        );
        context.insert(
            "elapsedMs".to_owned(),
            Value::from(started.elapsed().as_millis().min(u64::MAX as u128) as u64),
        );
        context.insert(
            "runtimeEpoch".to_owned(),
            lane.as_ref()
                .map(|lane| Value::from(lane.epoch.load(Ordering::Acquire)))
                .unwrap_or(Value::Null),
        );
        context.insert(
            "runtimeSurfaceGeneration".to_owned(),
            lane.as_ref()
                .map(|lane| Value::from(lane.surface_generation.load(Ordering::Acquire)))
                .unwrap_or(Value::Null),
        );
        context.insert(
            "normalInputEnabled".to_owned(),
            lane.as_ref()
                .map(|lane| Value::from(lane.normal_enabled.load(Ordering::Acquire)))
                .unwrap_or(Value::Null),
        );
        let error = result.as_ref().err();
        let core = Arc::clone(&self.core);
        let entry = LogCaptureRecord {
            level: if error.is_some() {
                LogLevel::Warn
            } else {
                LogLevel::Debug
            },
            source: LogSource::Macro,
            event: if error.is_some() {
                "input.browser-action-failed".to_owned()
            } else {
                "input.browser-action-completed".to_owned()
            },
            message: if error.is_some() {
                "A macro browser action failed before native completion.".to_owned()
            } else {
                "A macro browser action completed through the native input adapter.".to_owned()
            },
            context_raw_json: serde_json::to_string(&Value::Object(context)).ok(),
            error: error.map(|error| log_error_details(error.code, &error.message)),
        };
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![entry],
                })
                .await;
        });
    }

    fn record_macro_click_resolution(
        &self,
        role_id: &str,
        webview_label: &str,
        click: &ClickActionDispatch<'_>,
        viewport: ViewportSize,
        point: ClickPoint,
        context: &InputDispatchContext,
    ) {
        let core = Arc::clone(&self.core);
        let diagnostic = json!({
            "anchor": click.anchor,
            "button": click.button,
            "inputEpoch": context.input_epoch,
            "intent": context.intent,
            "normalInputEnabled": context.lane.normal_enabled.load(Ordering::Acquire),
            "pointX": point.x,
            "pointY": point.y,
            "roleId": role_id,
            "runtimeEpoch": context.lane.epoch.load(Ordering::Acquire),
            "runtimeSurfaceGeneration": context.lane.surface_generation.load(Ordering::Acquire),
            "unit": click.unit,
            "viewportHeight": viewport.height,
            "viewportWidth": viewport.width,
            "webviewLabel": webview_label,
            "x": click.x,
            "y": click.y,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Macro,
                        event: "input.click-resolved".to_owned(),
                        message: "A macro click was resolved within the DOM viewport.".to_owned(),
                        context_raw_json: serde_json::to_string(&diagnostic).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn record_macro_click_submission(
        &self,
        role_id: &str,
        webview_label: &str,
        context: &InputDispatchContext,
        diagnostics: MouseInputDispatchDiagnostics,
        down_confirmed: bool,
        action_error_code: Option<&str>,
        cleanup_error_code: Option<&str>,
    ) {
        let core = Arc::clone(&self.core);
        let succeeded = action_error_code.is_none();
        let diagnostic = json!({
            "actionErrorCode": action_error_code,
            "cleanupErrorCode": cleanup_error_code,
            "completionScope": "native-submission",
            "deliveryMode": mouse_input_delivery_mode(),
            "downCompletionUs": duration_micros(diagnostics.down_completion),
            "downConfirmed": down_confirmed,
            "handoffWaitUs": duration_micros(diagnostics.handoff_wait),
            "inputEpoch": context.input_epoch,
            "intent": context.intent,
            "pressDurationUs": duration_micros(diagnostics.press_duration),
            "roleId": role_id,
            "succeeded": succeeded,
            "upCompletionUs": diagnostics.up_completion.map(duration_micros),
            "webviewLabel": webview_label,
        });
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Debug,
                        source: LogSource::Macro,
                        event: "input.click-native-submission".to_owned(),
                        message: if succeeded {
                            "A macro click completed its native submission sequence."
                        } else {
                            "A macro click did not complete its native submission sequence."
                        }
                        .to_owned(),
                        context_raw_json: serde_json::to_string(&diagnostic).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }
}

fn browser_action_diagnostic_context(action: &BrowserAction) -> Value {
    match action {
        BrowserAction::Focus => json!({ "action": "focus" }),
        BrowserAction::Key {
            phase,
            key,
            code,
            modifiers,
            ..
        } => json!({
            "action": "key",
            "code": code.as_deref().unwrap_or(key),
            "modifierCount": modifiers.len(),
            "phase": phase,
        }),
        BrowserAction::Click {
            anchor,
            unit,
            x,
            y,
            button,
        } => json!({
            "action": "click",
            "anchor": anchor,
            "button": button,
            "completionScope": "native-submission",
            "deliveryMode": mouse_input_delivery_mode(),
            "handoffWaitPolicyMs": mouse_input_handoff_policy().as_millis() as u64,
            "pressDurationPolicyMs": mouse_input_press_policy().as_millis() as u64,
            "unit": unit,
            "x": x,
            "y": y,
        }),
    }
}

fn duration_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u64::MAX as u128) as u64
}

fn mouse_input_delivery_mode() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "appkit-direct-responder"
    }
    #[cfg(windows)]
    {
        "webview2-cdp"
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        "unsupported"
    }
}

fn mouse_input_handoff_policy() -> Duration {
    #[cfg(target_os = "macos")]
    {
        MACOS_MOUSE_DISPATCH_SETTLE_INTERVAL
    }
    #[cfg(not(target_os = "macos"))]
    {
        Duration::ZERO
    }
}

fn mouse_input_press_policy() -> Duration {
    #[cfg(target_os = "macos")]
    {
        MACOS_MOUSE_PRESS_INTERVAL
    }
    #[cfg(not(target_os = "macos"))]
    {
        Duration::ZERO
    }
}
