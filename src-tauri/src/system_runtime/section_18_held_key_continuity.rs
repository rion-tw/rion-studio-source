#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeldKeyContinuityReceipt {
    input_epoch: Option<u64>,
    loss_reason: String,
    loss_revision: u64,
    presentation_revision: u64,
    reasserted_key_count: usize,
    role_id: String,
    status: String,
    surface_generation: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldKeyContinuitySource {
    NativeFocus,
    PageObservation,
}

impl SystemRuntimeExecutor {
    pub(crate) fn restore_held_keys_after_input_context_loss(
        &self,
        role_id: &str,
        loss_reason: &str,
        loss_revision: u64,
    ) -> RuntimeResult<HeldKeyContinuityReceipt> {
        self.restore_held_keys_after_input_context_loss_inner(
            role_id,
            loss_reason,
            loss_revision,
            None,
            HeldKeyContinuitySource::PageObservation,
        )
    }

    #[cfg(windows)]
    fn restore_held_keys_after_native_focus_loss(
        &self,
        role_id: &str,
        loss_revision: u64,
        surface_generation: u64,
    ) -> RuntimeResult<HeldKeyContinuityReceipt> {
        self.restore_held_keys_after_input_context_loss_inner(
            role_id,
            "blur",
            loss_revision,
            Some(surface_generation),
            HeldKeyContinuitySource::NativeFocus,
        )
    }

    fn restore_held_keys_after_input_context_loss_inner(
        &self,
        role_id: &str,
        loss_reason: &str,
        loss_revision: u64,
        expected_surface_generation: Option<u64>,
        source: HeldKeyContinuitySource,
    ) -> RuntimeResult<HeldKeyContinuityReceipt> {
        let started = Instant::now();
        let presentation_revision = self.presentation.current_revision();
        let context = match self.current_input_context(role_id, "normal") {
            Ok(context) => context,
            Err(error) if held_key_continuity_is_superseded(&error) => {
                let receipt = held_key_continuity_receipt(
                    role_id,
                    loss_reason,
                    loss_revision,
                    presentation_revision,
                    None,
                    0,
                    "superseded",
                );
                self.record_held_key_continuity_result(started, &receipt, None);
                return Ok(receipt);
            }
            Err(error) => {
                let receipt = held_key_continuity_receipt(
                    role_id,
                    loss_reason,
                    loss_revision,
                    presentation_revision,
                    None,
                    0,
                    "failed",
                );
                self.record_held_key_continuity_result(started, &receipt, Some(&error));
                return Err(error);
            }
        };
        if !cfg!(windows) {
            let receipt = held_key_continuity_receipt(
                role_id,
                loss_reason,
                loss_revision,
                presentation_revision,
                Some((context.input_epoch, context.surface_generation)),
                0,
                "notRequired",
            );
            self.record_held_key_continuity_result(started, &receipt, None);
            return Ok(receipt);
        }
        if expected_surface_generation
            .is_some_and(|generation| generation != context.surface_generation)
        {
            let receipt = held_key_continuity_receipt(
                role_id,
                loss_reason,
                loss_revision,
                presentation_revision,
                Some((context.input_epoch, context.surface_generation)),
                0,
                "superseded",
            );
            self.record_held_key_continuity_result(started, &receipt, None);
            return Ok(receipt);
        }
        let result = self.with_input_context_lane(&context, || {
            if !held_key_continuity_should_reassert(
                loss_reason,
                self.held_key_continuity_tab_selected(role_id),
                source,
            ) {
                return Ok(None);
            }
            self.reassert_role_keys_matching_in_lane(role_id, &context, |_| true)
                .map(Some)
        });
        let presentation_owned = result.as_ref().is_ok_and(|count| count.is_none());
        let reasserted_key_count = result
            .as_ref()
            .ok()
            .and_then(|count| *count)
            .unwrap_or_default();
        let receipt = held_key_continuity_receipt(
            role_id,
            loss_reason,
            loss_revision,
            presentation_revision,
            Some((context.input_epoch, context.surface_generation)),
            reasserted_key_count,
            if result.is_err() {
                "failed"
            } else if presentation_owned {
                "superseded"
            } else if reasserted_key_count == 0 {
                "noHeldKeys"
            } else {
                "reasserted"
            },
        );
        if let Err(error) = result.as_ref()
            && matches!(
                error.code,
                "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
                    | "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED"
                    | "SYSTEM_AUTOMATION_SURFACE_WAKE_FAILED"
                    | "SYSTEM_AUTOMATION_SURFACE_WAKE_INDETERMINATE"
            )
        {
            self.schedule_macro_input_recovery(
                role_id,
                &format!("held-key-continuity-{role_id}-{loss_revision}"),
                error,
            );
        }
        self.record_held_key_continuity_result(started, &receipt, result.as_ref().err());
        result.map(|_| receipt)
    }

    fn install_role_held_key_continuity_tracker(
        &self,
        webview: &Webview,
        role_id: &str,
        surface_generation: u64,
    ) -> RuntimeResult<()> {
        #[cfg(windows)]
        {
            use webview2_com::FocusChangedEventHandler;

            let runtime = self.self_weak.get().cloned().ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_ROLE_FOCUS_CONTINUITY_UNAVAILABLE",
                    "The runtime focus-continuity owner was unavailable.",
                )
            })?;
            let role_id = role_id.to_owned();
            let webview_label = webview.label().to_owned();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            webview
                .with_webview(move |platform_webview| unsafe {
                    let handler = FocusChangedEventHandler::create(Box::new(move |_controller, _| {
                        let Some(runtime) = runtime.upgrade() else {
                            return Ok(());
                        };
                        let loss_revision = runtime
                            .held_key_continuity_revision
                            .fetch_add(1, Ordering::AcqRel)
                            .saturating_add(1);
                        let role_id = role_id.clone();
                        let webview_label = webview_label.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let window_id = runtime.window_id_for_webview(&webview_label);
                            let result = runtime.restore_held_keys_after_native_focus_loss(
                                &role_id,
                                loss_revision,
                                surface_generation,
                            );
                            #[cfg(feature = "desktop-e2e")]
                            record_desktop_e2e_held_key_continuity(
                                window_id.as_deref(),
                                &role_id,
                                "blur",
                                loss_revision,
                                &result,
                            );
                            #[cfg(not(feature = "desktop-e2e"))]
                            let _ = (&window_id, &result);
                        });
                        Ok(())
                    }));
                    let mut token = 0;
                    let result = platform_webview
                        .controller()
                        .add_LostFocus(&handler, &mut token)
                        .map_err(|error| error.to_string());
                    let _ = sender.send(result);
                })
                .map_err(RuntimeError::tauri)?;
            receiver
                .recv_timeout(PLATFORM_CALLBACK_TIMEOUT)
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_ROLE_FOCUS_CONTINUITY_TIMEOUT",
                        "WebView2 focus-continuity setup timed out.",
                    )
                })?
                .map_err(|message| {
                    RuntimeError::new("SYSTEM_ROLE_FOCUS_CONTINUITY_SETUP_FAILED", message)
                })
        }
        #[cfg(not(windows))]
        {
            let _ = (webview, role_id, surface_generation);
            Ok(())
        }
    }

    fn held_key_continuity_tab_selected(&self, role_id: &str) -> Option<bool> {
        let (tab_id, window_id) = {
            let state = self.state.lock().ok()?;
            let tab_id = state.native_tab_id_for_role_surface(role_id)?.clone();
            let window_id = state.native_host_for_tab_handle(&tab_id)?;
            (tab_id, window_id)
        };
        self.presentation
            .live
            .kernel
            .snapshot()
            .ok()?
            .native_projection(&window_id)?
            .tabs
            .iter()
            .find(|tab| tab.tab_id == tab_id)
            .map(|tab| tab.selected)
    }

    fn record_held_key_continuity_result(
        &self,
        started: Instant,
        receipt: &HeldKeyContinuityReceipt,
        error: Option<&RuntimeError>,
    ) {
        let input_transaction_stage = error
            .and_then(|error| error.input_transaction_stage)
            .map(InputTransactionStage::as_str);
        let context = json!({
            "elapsedMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            "inputEpoch": receipt.input_epoch,
            "inputTransactionStage": input_transaction_stage,
            "lossReason": receipt.loss_reason,
            "lossRevision": receipt.loss_revision,
            "presentationRevision": receipt.presentation_revision,
            "reassertedKeyCount": receipt.reasserted_key_count,
            "roleId": receipt.role_id,
            "status": receipt.status,
            "surfaceGeneration": receipt.surface_generation,
        });
        let core = Arc::clone(&self.core);
        let entry = LogCaptureRecord {
            level: if error.is_some() {
                LogLevel::Warn
            } else {
                LogLevel::Debug
            },
            source: LogSource::Macro,
            event: "input.held-key-continuity-terminal".to_owned(),
            message: if error.is_some() {
                "Held macro keys could not be restored after the page lost its input context."
            } else {
                "Held macro key continuity reached a terminal input-context-loss outcome."
            }
            .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
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
}

fn held_key_continuity_receipt(
    role_id: &str,
    loss_reason: &str,
    loss_revision: u64,
    presentation_revision: u64,
    input_context: Option<(u64, u64)>,
    reasserted_key_count: usize,
    status: &str,
) -> HeldKeyContinuityReceipt {
    let (input_epoch, surface_generation) = input_context
        .map(|(input_epoch, surface_generation)| (Some(input_epoch), Some(surface_generation)))
        .unwrap_or((None, None));
    HeldKeyContinuityReceipt {
        input_epoch,
        loss_reason: loss_reason.to_owned(),
        loss_revision,
        presentation_revision,
        reasserted_key_count,
        role_id: role_id.to_owned(),
        status: status.to_owned(),
        surface_generation,
    }
}

fn held_key_continuity_is_superseded(error: &RuntimeError) -> bool {
    matches!(
        error.code,
        "BROWSER_ACTION_STALE"
            | "SYSTEM_RUNTIME_NOT_ACTIVE"
            | "SYSTEM_RUNTIME_SHUTTING_DOWN"
            | "SYSTEM_TRUSTED_INPUT_QUARANTINED"
            | "TAURI_RUNTIME_ROLE_NOT_FOUND"
    )
}

fn held_key_continuity_should_reassert(
    loss_reason: &str,
    tab_selected: Option<bool>,
    source: HeldKeyContinuitySource,
) -> bool {
    if loss_reason != "blur" {
        return true;
    }
    source == HeldKeyContinuitySource::NativeFocus && tab_selected != Some(false)
}

#[cfg(feature = "desktop-e2e")]
pub(crate) fn record_desktop_e2e_held_key_continuity(
    window_id: Option<&str>,
    role_id: &str,
    loss_reason: &str,
    loss_revision: u64,
    result: &RuntimeResult<HeldKeyContinuityReceipt>,
) {
    let details = result
        .as_ref()
        .map(|receipt| serde_json::to_value(receipt).unwrap_or(Value::Null))
        .unwrap_or_else(|error| {
            json!({
                "errorCode": error.code,
                "errorMessage": error.message,
                "lossReason": loss_reason,
                "lossRevision": loss_revision,
                "roleId": role_id,
                "status": "failed",
            })
        });
    crate::desktop_e2e::record_event(
        "held-key-continuity-terminal",
        window_id,
        None,
        None,
        details,
    );
}
