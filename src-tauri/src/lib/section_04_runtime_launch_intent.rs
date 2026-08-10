enum RuntimeLaunchDestination {
    Live {
        reason: &'static str,
        target: EmbeddedLaunchTargetRecord,
    },
    Dormant {
        reason: &'static str,
        saved: Box<StateGameWindowRecord>,
        target: EmbeddedLaunchTargetRecord,
    },
}

struct RuntimeLaunchEventBatch {
    entries: Vec<LogCaptureRecord>,
    queue_wait_ms: u64,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>,
    started_at: Instant,
}

pub(crate) struct RuntimeLaunchExecutionContext<'a> {
    admission_signal: &'a mut runtime_tab_menu::LaunchAdmissionSignal,
    exact_window_id: Option<String>,
    launch_log_sender: &'a tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>,
    origin: &'static str,
    queue_wait_ms: u64,
    started_at: Instant,
}

impl<'a> RuntimeLaunchExecutionContext<'a> {
    pub(crate) fn new(
        exact_window_id: Option<String>,
        origin: &'static str,
        launch_log_sender: &'a tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>,
        started_at: Instant,
        queue_wait_ms: u64,
        admission_signal: &'a mut runtime_tab_menu::LaunchAdmissionSignal,
    ) -> Self {
        Self {
            admission_signal,
            exact_window_id,
            launch_log_sender,
            origin,
            queue_wait_ms,
            started_at,
        }
    }
}

impl RuntimeLaunchEventBatch {
    #[cfg(test)]
    fn new(sender: tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>) -> Self {
        Self::with_timing(sender, Instant::now(), 0)
    }

    fn with_timing(
        sender: tokio::sync::mpsc::UnboundedSender<Vec<LogCaptureRecord>>,
        started_at: Instant,
        queue_wait_ms: u64,
    ) -> Self {
        Self {
            entries: Vec::new(),
            queue_wait_ms,
            sender,
            started_at,
        }
    }

    fn record(
        &mut self,
        event: &'static str,
        intent: &RuntimeLaunchIntentRecord,
        window_id: Option<&str>,
        reason: Option<&str>,
    ) {
        let elapsed_ms = self
            .started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let context = json!({
            "adapterSequence": intent.adapter_sequence,
            "elapsedMs": elapsed_ms,
            "intentId": intent.intent_id,
            "queueWaitMs": self.queue_wait_ms,
            "sourceId": intent.source_id,
            "sourceType": intent.source_type,
            "windowId": window_id,
            "destinationReason": reason,
        });
        self.entries.push(LogCaptureRecord {
            level: LogLevel::Info,
            source: LogSource::Browser,
            event: event.to_owned(),
            message: "The ordered runtime launch intent advanced to its next authoritative event."
                .to_owned(),
            context_raw_json: serde_json::to_string(&context).ok(),
            error: None,
        });
    }

    fn submit(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        let _ = self.sender.send(std::mem::take(&mut self.entries));
    }
}

impl Drop for RuntimeLaunchEventBatch {
    fn drop(&mut self) {
        self.submit();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LaunchAdmissionResolution {
    AwaitNativeCompletion,
    UseStableOwner(String),
    OwnershipDiverged,
}

fn resolve_launch_admission(
    completion: rion_core::BrowserLaunchAdmissionCompletion,
    disposition: &str,
    tab_id: &str,
) -> LaunchAdmissionResolution {
    if tab_id.trim().is_empty() {
        return LaunchAdmissionResolution::OwnershipDiverged;
    }
    if matches!(disposition, "existing" | "joined")
        || completion == rion_core::BrowserLaunchAdmissionCompletion::Completed
    {
        LaunchAdmissionResolution::UseStableOwner(tab_id.to_owned())
    } else {
        LaunchAdmissionResolution::AwaitNativeCompletion
    }
}

fn record_runtime_launch_event(
    events: &mut RuntimeLaunchEventBatch,
    event: &'static str,
    intent: &RuntimeLaunchIntentRecord,
    window_id: Option<&str>,
    reason: Option<&str>,
) {
    events.record(event, intent, window_id, reason);
    // Persist every transition independently. Admission and close-before-reopen waits are
    // intentionally event-bound and may remain pending for an external native callback, so a
    // terminal-only batch would erase the exact phase needed to diagnose that wait.
    events.submit();
}

fn runtime_launch_receipt(
    intent: &RuntimeLaunchIntentRecord,
    runtime: &SystemRuntimeExecutor,
    window_id: String,
    destination_reason: impl Into<String>,
    existing_tab_id: Option<String>,
    hydration_operation_id: Option<String>,
    cleanup_operation_id: Option<String>,
) -> RuntimeLaunchIntentReceiptRecord {
    let (window_generation, topology_revision) =
        runtime.live_window_identity(&window_id).unwrap_or_default();
    RuntimeLaunchIntentReceiptRecord {
        intent_id: intent.intent_id.clone(),
        status: SystemRuntimeOperationStatus::Applied,
        destination_reason: destination_reason.into(),
        window_id,
        window_generation,
        topology_revision,
        hydration_operation_id,
        cleanup_operation_id,
        existing_tab_id,
        failure_code: None,
    }
}

fn resolve_runtime_launch_destination(
    app: &AppHandle,
    state: &CoreState,
    intent: &RuntimeLaunchIntentRecord,
    exact_window_id: Option<&str>,
) -> Result<RuntimeLaunchDestination, CoreErrorPayload> {
    if let Some(window_id) = exact_window_id {
        let target = state
            .runtime
            .launch_target_for_window_id(window_id)
            .map_err(|message| shell_error("TAURI_RUNTIME_LAUNCH_ADAPTER_STALE", message))?;
        return Ok(RuntimeLaunchDestination::Live {
            reason: "authenticated-source-window",
            target,
        });
    }

    if let Some(window_id) = state.runtime.last_native_focused_live_window_id()
        && let Ok(target) = state.runtime.launch_target_for_window_id(&window_id)
    {
        return Ok(RuntimeLaunchDestination::Live {
            reason: "last-native-focused-live-window",
            target,
        });
    }
    for window_id in state.runtime.live_window_ids() {
        if let Ok(target) = state.runtime.launch_target_for_window_id(&window_id) {
            return Ok(RuntimeLaunchDestination::Live {
                reason: "first-eligible-live-window",
                target,
            });
        }
    }

    let runtime_snapshot = browser_runtime_snapshot(state)?;
    let dormant_ids = state
        .runtime
        .dormant_windows()
        .into_iter()
        .map(|window| window.id)
        .collect::<HashSet<_>>();
    let game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("TAURI_RUNTIME_LAUNCH_SAVED_INVALID", error.to_string()))
        })?;
    let mut eligible_saved = game_windows
        .into_iter()
        .filter(|saved| {
            dormant_ids.contains(&saved.id)
                && !saved_window_conflicts_with_runtime(saved, &runtime_snapshot)
        })
        .collect::<Vec<_>>();
    let source_owner_index = eligible_saved.iter().position(|saved| {
        saved_tab_for_launcher_source(saved, &intent.source_id, &intent.source_type).is_some()
    });
    if let Some(index) = source_owner_index.or((!eligible_saved.is_empty()).then_some(0)) {
        let saved = eligible_saved.remove(index);
        let reason = if source_owner_index.is_some() {
            "dormant-existing-source"
        } else {
            "first-eligible-dormant-window"
        };
        let target = launch_target_for_game_window(app, &saved.id)?;
        return Ok(RuntimeLaunchDestination::Dormant {
            reason,
            saved: Box::new(saved),
            target,
        });
    }

    let main_window = app.get_webview_window("main").ok_or_else(|| {
        shell_error(
            "TAURI_RUNTIME_LAUNCH_MAIN_WINDOW_MISSING",
            "The main window is unavailable while resolving a new Game Window.",
        )
    })?;
    Ok(RuntimeLaunchDestination::Live {
        reason: "new-game-window",
        target: new_game_window_launch_target(state, &main_window)?,
    })
}

async fn invoke_runtime_source_launch(
    state: &CoreState,
    source_id: &str,
    source_type: &str,
    target: EmbeddedLaunchTargetRecord,
    launch_preview_id: Option<String>,
    launch_tab_id: Option<String>,
    restore_role_slots: Option<Vec<rion_core::GameWindowRoleSlotRecord>>,
) -> Result<rion_core::BrowserLaunchAdmissionRecord, CoreErrorPayload> {
    let command = if source_type == "workspace" {
        CoreCommand::BrowserWorkspaceLaunch {
            workspace_id: source_id.to_owned(),
            target,
            launch_preview_id,
            launch_tab_id,
            restore_role_slots,
        }
    } else {
        CoreCommand::BrowserRoleLaunch {
            role_id: source_id.to_owned(),
            target,
            launch_preview_id,
            launch_tab_id,
            zoom_factor: None,
            restore_role_slots,
        }
    };
    let value = Arc::clone(&state.core)
        .invoke_async(command)
        .await
        .map_err(error_payload)?;
    serde_json::from_value(value).map_err(|error| {
        shell_error(
            "TAURI_RUNTIME_LAUNCH_ADMISSION_INVALID",
            format!("Core returned an invalid launch admission: {error}"),
        )
    })
}

fn statuses_for_launch_source(
    statuses: Value,
    source_id: &str,
    source_type: &str,
) -> Value {
    if source_type != "role" {
        return statuses;
    }
    let Some(items) = statuses.as_array() else {
        return statuses;
    };
    Value::Array(
        items
            .iter()
            .filter(|status| status["roleId"].as_str() == Some(source_id))
            .cloned()
            .collect(),
    )
}

fn serialized_launch_statuses(statuses: Vec<rion_core::BrowserRoleStatusRecord>) -> Value {
    serde_json::to_value(statuses).unwrap_or_else(|_| Value::Array(Vec::new()))
}

enum SavedWindowHydrationStep<'a> {
    Appended {
        preview: &'a system_runtime::LaunchPreviewHandle,
    },
    Saved {
        foreground: bool,
        tab: &'a GameWindowTabRecord,
    },
}

struct SavedWindowHydrationPlan<'a> {
    steps: Vec<SavedWindowHydrationStep<'a>>,
}

fn saved_window_hydration_plan<'a>(
    window: &'a StateGameWindowRecord,
    existing_saved_tab_id: Option<&str>,
    launch_preview: Option<&'a system_runtime::LaunchPreviewHandle>,
) -> SavedWindowHydrationPlan<'a> {
    let mut steps = Vec::new();
    if let Some(preview) = launch_preview {
        steps.push(SavedWindowHydrationStep::Appended { preview });
    }
    if let Some(tab_id) = existing_saved_tab_id
        && let Some(tab) = window.tabs.iter().find(|tab| tab.id == tab_id)
    {
        steps.push(SavedWindowHydrationStep::Saved {
            foreground: true,
            tab,
        });
    }
    SavedWindowHydrationPlan { steps }
}

async fn hydrate_appended_launch_step(
    state: &CoreState,
    target: &EmbeddedLaunchTargetRecord,
    intent: &RuntimeLaunchIntentRecord,
    preview: &system_runtime::LaunchPreviewHandle,
) -> Result<(Value, Option<String>), CoreErrorPayload> {
    let admission = invoke_runtime_source_launch(
        state,
        &intent.source_id,
        &intent.source_type,
        target.clone(),
        Some(preview.launch_preview_id.clone()),
        Some(preview.provisional_tab_id.clone()),
        None,
    )
    .await?;
    let resolution = resolve_launch_admission(
        admission.completion,
        &admission.disposition,
        &admission.tab_id,
    );
    let statuses = statuses_for_launch_source(
        serialized_launch_statuses(admission.statuses),
        &intent.source_id,
        &intent.source_type,
    );
    match resolution {
        LaunchAdmissionResolution::UseStableOwner(stable_owner) => {
            state
                .runtime
                .cancel_tab_launch_preview(&preview.launch_preview_id);
            Ok((statuses, Some(stable_owner)))
        }
        LaunchAdmissionResolution::OwnershipDiverged => Err(shell_error(
            "TAURI_RUNTIME_LAUNCH_OWNER_DIVERGED",
            "Core completed a launch without a stable live presentation owner.",
        )),
        LaunchAdmissionResolution::AwaitNativeCompletion => Ok((statuses, None)),
    }
}

async fn hydrate_saved_window_for_launch(
    app: &AppHandle,
    state: &CoreState,
    saved: &StateGameWindowRecord,
    target: &EmbeddedLaunchTargetRecord,
    intent: &RuntimeLaunchIntentRecord,
    launch_started_at: Instant,
    admission_signal: &mut runtime_tab_menu::LaunchAdmissionSignal,
) -> Result<(Value, Option<String>, String), CoreErrorPayload> {
    let hydration_operation_id = uuid::Uuid::new_v4().to_string();
    let existing_saved_tab = saved_tab_for_launcher_source(
        saved,
        &intent.source_id,
        &intent.source_type,
    )
    .cloned();
    let mut resolved_existing_tab_id = existing_saved_tab.as_ref().map(|tab| tab.id.clone());
    let mut hydrated = saved.clone();
    let mut launch_admission = system_runtime::RestoredLaunchAdmission::new(
        &intent.intent_id,
        &hydration_operation_id,
        launch_started_at,
        admission_signal,
    );
    let launch_preview = if let Some(existing) = existing_saved_tab.as_ref() {
        hydrated.active_tab_id = Some(existing.id.clone());
        state
            .runtime
            .prepare_restored_window_tabs_for_launch(
                target,
                &hydrated.tabs,
                hydrated.active_tab_id.clone(),
                &mut launch_admission,
            )
            .map_err(|message| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", message))?;
        None
    } else {
        Some(
            state
                .runtime
                .prepare_restored_window_tabs_with_launch_for_intent(
                    target,
                    &hydrated.tabs,
                    &intent.source_id,
                    &intent.source_type,
                    &mut launch_admission,
                )
                .map_err(|message| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", message))?,
        )
    };

    let mut requested_statuses = Value::Array(Vec::new());
    let plan = saved_window_hydration_plan(
        &hydrated,
        existing_saved_tab.as_ref().map(|tab| tab.id.as_str()),
        launch_preview.as_ref(),
    );
    for step in plan.steps {
        let (foreground, tab_id, result) = match step {
            SavedWindowHydrationStep::Appended { preview } => (
                true,
                preview.provisional_tab_id.as_str(),
                hydrate_appended_launch_step(state, target, intent, preview)
                    .await
                    .map(|(statuses, stable_owner)| {
                        requested_statuses = statuses;
                        if stable_owner.is_some() {
                            resolved_existing_tab_id = stable_owner;
                        }
                    }),
            ),
            SavedWindowHydrationStep::Saved { foreground, tab } => (
                foreground,
                tab.id.as_str(),
                activate_runtime_tab_on_demand(app, state, &tab.id, false)
                    .await
                    .map(|_| ()),
            ),
        };
        if let Err(error) = result {
            if foreground {
                if let Some(preview) = launch_preview.as_ref() {
                    state
                        .runtime
                        .cancel_tab_launch_preview(&preview.launch_preview_id);
                }
                state
                    .runtime
                    .discard_prepared_restored_window_tabs(&saved.id);
                return Err(error);
            }
            state
                .runtime
                .fail_prepared_restored_tab(&saved.id, tab_id, &error.code);
        } else if foreground
            && !(launch_preview.is_some() && resolved_existing_tab_id.is_some())
            && let Err(message) = state
                .runtime
                .wait_for_prepared_restored_foreground_visible(&saved.id)
                .await
        {
            if let Some(preview) = launch_preview.as_ref() {
                state
                    .runtime
                    .cancel_tab_launch_preview(&preview.launch_preview_id);
            }
            state
                .runtime
                .discard_prepared_restored_window_tabs(&saved.id);
            return Err(shell_error(
                "TAURI_RESTORE_FOREGROUND_VISIBILITY_FAILED",
                message,
            ));
        }
    }
    state
        .runtime
        .finish_prepared_restored_window_tabs(&saved.id)
        .map_err(|message| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", message))?;
    state.runtime.retire_dormant_window(&saved.id);
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|message| shell_error("TAURI_RESTORE_PERSIST_FAILED", message))?;
    Ok((
        requested_statuses,
        resolved_existing_tab_id,
        hydration_operation_id,
    ))
}

pub(crate) async fn execute_runtime_launch_intent(
    app: &AppHandle,
    intent: RuntimeLaunchIntentRecord,
    execution: RuntimeLaunchExecutionContext<'_>,
) -> Result<runtime_tab_menu::RuntimeLaunchOutcome, CoreErrorPayload> {
    let RuntimeLaunchExecutionContext {
        admission_signal,
        exact_window_id,
        launch_log_sender,
        origin,
        queue_wait_ms,
        started_at: launch_started_at,
    } = execution;
    let state = app.try_state::<CoreState>().ok_or_else(|| {
        shell_error(
            "TAURI_RUNTIME_LAUNCH_STATE_UNAVAILABLE",
            "The runtime launch actor started before application state was available.",
        )
    })?;
    let mut events = RuntimeLaunchEventBatch::with_timing(
        launch_log_sender.clone(),
        launch_started_at,
        queue_wait_ms,
    );
    record_runtime_launch_event(
        &mut events,
        "launch.intent-admitted",
        &intent,
        None,
        Some(origin),
    );
    if !matches!(intent.source_type.as_str(), "role" | "workspace") {
        return Err(shell_error(
            "TAURI_RUNTIME_LAUNCH_SOURCE_INVALID",
            "The runtime launch source type is invalid.",
        ));
    }
    if let Some(tab_id) = state
        .runtime
        .presented_stable_tab_for_launcher_source(&intent.source_id, &intent.source_type)
    {
        admission_signal.complete();
        state
            .runtime
            .cancel_active_launch_preview_for_source(&intent.source_id, &intent.source_type);
        preview_and_schedule_launcher_tab_selection(app, &state, &tab_id)
            .map_err(|message| shell_error("TAURI_RUNTIME_TAB_ACTIVATION_FAILED", message))?;
        let window_id = state
            .runtime
            .live_tab_window_id(&tab_id)
            .ok_or_else(|| shell_error("TAURI_RUNTIME_TAB_ACTIVATION_FAILED", "The live tab owner disappeared."))?;
        let receipt = runtime_launch_receipt(
            &intent,
            &state.runtime,
            window_id.clone(),
            "existing-live-source",
            Some(tab_id),
            None,
            None,
        );
        record_runtime_launch_event(
            &mut events,
            "launch.intent-terminal",
            &intent,
            Some(&window_id),
            Some("existing-live-source"),
        );
        return Ok(runtime_tab_menu::RuntimeLaunchOutcome {
            receipt,
            statuses: Value::Array(Vec::new()),
        });
    }
    if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(&intent.source_id, &intent.source_type)
    {
        if let Some(window_id) = state.runtime.live_tab_window_id(&tab_id) {
            admission_signal.complete();
            if state
                .runtime
                .authoritative_tab_activation_phase(&tab_id)
                .is_some()
            {
                activate_runtime_tab_on_demand(app, &state, &tab_id, false).await?;
            } else {
                preview_and_schedule_launcher_tab_selection(app, &state, &tab_id).map_err(
                    |message| shell_error("TAURI_RUNTIME_TAB_ACTIVATION_FAILED", message),
                )?;
            }
            let receipt = runtime_launch_receipt(
                &intent,
                &state.runtime,
                window_id.clone(),
                "existing-admitted-source",
                Some(tab_id),
                None,
                None,
            );
            record_runtime_launch_event(
                &mut events,
                "launch.intent-terminal",
                &intent,
                Some(&window_id),
                Some("existing-admitted-source"),
            );
            return Ok(runtime_tab_menu::RuntimeLaunchOutcome {
                receipt,
                statuses: Value::Array(Vec::new()),
            });
        }
        state.runtime.cancel_provisional_tab_launch(&tab_id);
    }

    let destination =
        resolve_runtime_launch_destination(app, &state, &intent, exact_window_id.as_deref())?;
    match destination {
        RuntimeLaunchDestination::Live { reason, target } => {
            let preview = state
                .runtime
                .preview_tab_launch_for_intent(
                    &target,
                    &intent.source_id,
                    &intent.source_type,
                    admission_signal,
                )
                .map_err(|error| shell_error(error.code, error.message))?;
            record_runtime_launch_event(
                &mut events,
                "launch.destination-resolved",
                &intent,
                Some(&target.window_id),
                Some(reason),
            );
            events.submit();
            let admission = match invoke_runtime_source_launch(
                &state,
                &intent.source_id,
                &intent.source_type,
                target.clone(),
                Some(preview.launch_preview_id.clone()),
                Some(preview.provisional_tab_id.clone()),
                None,
            )
            .await
            {
                Ok(admission) => admission,
                Err(error) => {
                    state.runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                    return Err(error);
                }
            };
            let resolution = resolve_launch_admission(
                admission.completion,
                &admission.disposition,
                &admission.tab_id,
            );
            let statuses = statuses_for_launch_source(
                serialized_launch_statuses(admission.statuses),
                &intent.source_id,
                &intent.source_type,
            );
            match resolution {
                LaunchAdmissionResolution::UseStableOwner(stable_owner) => {
                    state
                        .runtime
                        .cancel_tab_launch_preview(&preview.launch_preview_id);
                    preview_and_schedule_launcher_tab_selection(app, &state, &stable_owner)
                        .map_err(|message| {
                            shell_error("TAURI_RUNTIME_TAB_ACTIVATION_FAILED", message)
                        })?;
                    let window_id = state
                        .runtime
                        .live_tab_window_id(&stable_owner)
                        .ok_or_else(|| {
                            shell_error(
                                "TAURI_RUNTIME_TAB_ACTIVATION_FAILED",
                                "The authoritative live source owner disappeared.",
                            )
                        })?;
                    let receipt = runtime_launch_receipt(
                        &intent,
                        &state.runtime,
                        window_id.clone(),
                        "existing-live-owner-after-admission",
                        Some(stable_owner),
                        None,
                        None,
                    );
                    record_runtime_launch_event(
                        &mut events,
                        "launch.intent-terminal",
                        &intent,
                        Some(&window_id),
                        Some("existing-live-owner-after-admission"),
                    );
                    return Ok(runtime_tab_menu::RuntimeLaunchOutcome { receipt, statuses });
                }
                LaunchAdmissionResolution::OwnershipDiverged => {
                    state
                        .runtime
                        .cancel_tab_launch_preview(&preview.launch_preview_id);
                    return Err(shell_error(
                        "TAURI_RUNTIME_LAUNCH_OWNER_DIVERGED",
                        "Core completed a launch without a stable live presentation owner.",
                    ));
                }
                LaunchAdmissionResolution::AwaitNativeCompletion => {
                    // The identity-fenced create effect owns preview replacement or failure.
                }
            }
            let receipt = runtime_launch_receipt(
                &intent,
                &state.runtime,
                target.window_id.clone(),
                reason,
                None,
                None,
                None,
            );
            record_runtime_launch_event(
                &mut events,
                "launch.intent-terminal",
                &intent,
                Some(&target.window_id),
                Some(reason),
            );
            Ok(runtime_tab_menu::RuntimeLaunchOutcome { receipt, statuses })
        }
        RuntimeLaunchDestination::Dormant {
            reason,
            saved,
            target,
        } => {
            record_runtime_launch_event(
                &mut events,
                "launch.destination-resolved",
                &intent,
                Some(&saved.id),
                Some(reason),
            );
            let wait_runtime = Arc::clone(&state.runtime);
            let wait_window_id = saved.id.clone();
            let cleanup_operation_id = tauri::async_runtime::spawn_blocking(move || {
                wait_runtime.wait_for_window_close_before_reopen(&wait_window_id)
            })
            .await
            .map_err(|error| shell_error("TAURI_RESTORE_WINDOW_FAILED", error.to_string()))?
            .map_err(|message| shell_error("TAURI_RESTORE_WINDOW_CLOSE_PENDING", message))?;
            let (statuses, existing_tab_id, hydration_operation_id) =
                hydrate_saved_window_for_launch(
                    app,
                    &state,
                    &saved,
                    &target,
                    &intent,
                    launch_started_at,
                    admission_signal,
                )
                .await?;
            events.submit();
            record_runtime_launch_event(
                &mut events,
                "saved-window.hydration-committed",
                &intent,
                Some(&saved.id),
                Some(reason),
            );
            let receipt = runtime_launch_receipt(
                &intent,
                &state.runtime,
                saved.id.clone(),
                reason,
                existing_tab_id,
                Some(hydration_operation_id),
                cleanup_operation_id,
            );
            record_runtime_launch_event(
                &mut events,
                "launch.intent-terminal",
                &intent,
                Some(&saved.id),
                Some(reason),
            );
            Ok(runtime_tab_menu::RuntimeLaunchOutcome { receipt, statuses })
        }
    }
}
