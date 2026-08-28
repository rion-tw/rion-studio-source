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

impl SystemRuntimeExecutor {
    pub(crate) fn restore_held_keys_after_input_context_loss(
        &self,
        role_id: &str,
        loss_reason: &str,
        loss_revision: u64,
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
        let result = self.with_input_context_lane(&context, || {
            if !held_key_continuity_should_reassert(
                loss_reason,
                self.held_key_continuity_tab_selected(role_id),
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

fn held_key_continuity_should_reassert(loss_reason: &str, tab_selected: Option<bool>) -> bool {
    loss_reason != "blur" || tab_selected != Some(false)
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
