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

async fn record_runtime_launch_event(
    core: &Arc<AppCore>,
    event: &'static str,
    intent: &RuntimeLaunchIntentRecord,
    window_id: Option<&str>,
    reason: Option<&str>,
) {
    let context = json!({
        "adapterSequence": intent.adapter_sequence,
        "intentId": intent.intent_id,
        "sourceId": intent.source_id,
        "sourceType": intent.source_type,
        "windowId": window_id,
        "destinationReason": reason,
    });
    let _ = core
        .invoke_async(CoreCommand::LogsCapture {
            entries: vec![LogCaptureRecord {
                level: LogLevel::Info,
                source: LogSource::Browser,
                event: event.to_owned(),
                message: "The ordered runtime launch intent advanced to its next authoritative event."
                    .to_owned(),
                context_raw_json: serde_json::to_string(&context).ok(),
                error: None,
            }],
        })
        .await;
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
    for saved in game_windows {
        if dormant_ids.contains(&saved.id)
            && !saved_window_conflicts_with_runtime(&saved, &runtime_snapshot)
        {
            let target = launch_target_for_game_window(app, &saved.id)?;
            return Ok(RuntimeLaunchDestination::Dormant {
                reason: "first-eligible-dormant-window",
                saved: Box::new(saved),
                target,
            });
        }
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
    restore_role_slots: Option<Vec<rion_core::GameWindowRoleSlotRecord>>,
) -> Result<Value, CoreErrorPayload> {
    let command = if source_type == "workspace" {
        CoreCommand::BrowserWorkspaceLaunch {
            workspace_id: source_id.to_owned(),
            target,
            launch_preview_id,
            restore_role_slots,
        }
    } else {
        CoreCommand::BrowserRoleLaunch {
            role_id: source_id.to_owned(),
            target,
            launch_preview_id,
            zoom_factor: None,
            restore_role_slots,
        }
    };
    Arc::clone(&state.core)
        .invoke_async(command)
        .await
        .map_err(error_payload)
}

async fn hydrate_saved_window_for_launch(
    state: &CoreState,
    saved: &StateGameWindowRecord,
    target: &EmbeddedLaunchTargetRecord,
    intent: &RuntimeLaunchIntentRecord,
) -> Result<(Value, Option<String>, String), CoreErrorPayload> {
    let hydration_operation_id = uuid::Uuid::new_v4().to_string();
    let existing_saved_tab = saved
        .tabs
        .iter()
        .find(|tab| tab.source_id == intent.source_id && tab.tab_type == intent.source_type)
        .cloned();
    let mut hydrated = saved.clone();
    let launch_preview = if let Some(existing) = existing_saved_tab.as_ref() {
        hydrated.active_tab_id = Some(existing.id.clone());
        state
            .runtime
            .prepare_restored_window_tabs(
                target,
                &hydrated.tabs,
                hydrated.active_tab_id.clone(),
            )
            .map_err(|message| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", message))?;
        None
    } else {
        Some(
            state
                .runtime
                .prepare_restored_window_tabs_with_launch(
                    target,
                    &hydrated.tabs,
                    &intent.source_id,
                    &intent.source_type,
                )
                .map_err(|message| shell_error("TAURI_RESTORE_TAB_ORDER_FAILED", message))?,
        )
    };

    let mut requested_statuses = Value::Array(Vec::new());
    for tab in restore_tabs_in_owner_priority(&hydrated) {
        if let Some(native_tab_id) = state
            .runtime
            .native_tab_for_source(&tab.source_id, &tab.tab_type)
        {
            if state.runtime.live_tab_window_id(&native_tab_id).as_deref()
                != Some(saved.id.as_str())
            {
                if let Some(preview) = launch_preview.as_ref() {
                    state.runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                }
                state.runtime.discard_prepared_restored_window_tabs(&saved.id);
                return Err(shell_error(
                    "TAURI_RESTORE_SOURCE_CONFLICT",
                    "A saved source acquired a different live owner before hydration committed.",
                ));
            }
            continue;
        }
        state
            .runtime
            .prepare_restored_tab_role_slots(&tab.id, &tab.role_slots)
            .map_err(|message| shell_error("TAURI_RESTORE_LAYOUT_PREPARE_FAILED", message))?;
        let result = invoke_runtime_source_launch(
            state,
            &tab.source_id,
            &tab.tab_type,
            target.clone(),
            None,
            Some(tab.role_slots.clone()),
        )
        .await;
        let statuses = match result {
            Ok(statuses) => statuses,
            Err(error) => {
                state.runtime.discard_prepared_tab_role_slots(&tab.id);
                if let Some(preview) = launch_preview.as_ref() {
                    state.runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                }
                state.runtime.discard_prepared_restored_window_tabs(&saved.id);
                return Err(error);
            }
        };
        if existing_saved_tab
            .as_ref()
            .is_some_and(|existing| existing.id == tab.id)
        {
            requested_statuses = statuses;
        }
        if tab.audio_muted {
            let _ = state.runtime.restore_tab_audio_muted(&tab.source_id, true);
        }
    }

    if let Some(preview) = launch_preview.as_ref() {
        requested_statuses = match invoke_runtime_source_launch(
            state,
            &intent.source_id,
            &intent.source_type,
            target.clone(),
            Some(preview.launch_preview_id.clone()),
            None,
        )
        .await
        {
            Ok(statuses) => statuses,
            Err(error) => {
                state.runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                state.runtime.discard_prepared_restored_window_tabs(&saved.id);
                return Err(error);
            }
        };
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
    let _ = state.runtime.reveal_live_runtime_window(
        &saved.id,
        "saved-window-hydration-committed",
    );
    let existing_tab_id = existing_saved_tab.map(|tab| tab.id);
    Ok((requested_statuses, existing_tab_id, hydration_operation_id))
}

pub(crate) async fn execute_runtime_launch_intent(
    app: &AppHandle,
    intent: RuntimeLaunchIntentRecord,
    exact_window_id: Option<String>,
    origin: &'static str,
) -> Result<runtime_tab_menu::RuntimeLaunchOutcome, CoreErrorPayload> {
    let state = app.try_state::<CoreState>().ok_or_else(|| {
        shell_error(
            "TAURI_RUNTIME_LAUNCH_STATE_UNAVAILABLE",
            "The runtime launch actor started before application state was available.",
        )
    })?;
    record_runtime_launch_event(&state.core, "launch.intent-admitted", &intent, None, Some(origin))
        .await;
    if !matches!(intent.source_type.as_str(), "role" | "workspace") {
        return Err(shell_error(
            "TAURI_RUNTIME_LAUNCH_SOURCE_INVALID",
            "The runtime launch source type is invalid.",
        ));
    }
    if let Some(tab_id) = state
        .runtime
        .presented_tab_for_launcher_source(&intent.source_id, &intent.source_type)
    {
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
            &state.core,
            "launch.intent-terminal",
            &intent,
            Some(&window_id),
            Some("existing-live-source"),
        )
        .await;
        return Ok(runtime_tab_menu::RuntimeLaunchOutcome {
            receipt,
            statuses: Value::Array(Vec::new()),
        });
    }

    let destination = resolve_runtime_launch_destination(app, &state, exact_window_id.as_deref())?;
    match destination {
        RuntimeLaunchDestination::Live { reason, target } => {
            record_runtime_launch_event(
                &state.core,
                "launch.destination-resolved",
                &intent,
                Some(&target.window_id),
                Some(reason),
            )
            .await;
            let preview = state
                .runtime
                .preview_tab_launch(&target, &intent.source_id, &intent.source_type)
                .map_err(|error| shell_error(error.code, error.message))?;
            let statuses = match invoke_runtime_source_launch(
                &state,
                &intent.source_id,
                &intent.source_type,
                target.clone(),
                Some(preview.launch_preview_id.clone()),
                None,
            )
            .await
            {
                Ok(statuses) => statuses,
                Err(error) => {
                    state.runtime.cancel_tab_launch_preview(&preview.launch_preview_id);
                    return Err(error);
                }
            };
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
                &state.core,
                "launch.intent-terminal",
                &intent,
                Some(&target.window_id),
                Some(reason),
            )
            .await;
            Ok(runtime_tab_menu::RuntimeLaunchOutcome { receipt, statuses })
        }
        RuntimeLaunchDestination::Dormant {
            reason,
            saved,
            target,
        } => {
            record_runtime_launch_event(
                &state.core,
                "launch.destination-resolved",
                &intent,
                Some(&saved.id),
                Some(reason),
            )
            .await;
            let wait_runtime = Arc::clone(&state.runtime);
            let wait_window_id = saved.id.clone();
            let cleanup_operation_id = tauri::async_runtime::spawn_blocking(move || {
                wait_runtime.wait_for_window_close_before_reopen(&wait_window_id)
            })
            .await
            .map_err(|error| shell_error("TAURI_RESTORE_WINDOW_FAILED", error.to_string()))?
            .map_err(|message| shell_error("TAURI_RESTORE_WINDOW_CLOSE_PENDING", message))?;
            let (statuses, existing_tab_id, hydration_operation_id) =
                hydrate_saved_window_for_launch(&state, &saved, &target, &intent).await?;
            record_runtime_launch_event(
                &state.core,
                "saved-window.hydration-committed",
                &intent,
                Some(&saved.id),
                Some(reason),
            )
            .await;
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
                &state.core,
                "launch.intent-terminal",
                &intent,
                Some(&saved.id),
                Some(reason),
            )
            .await;
            Ok(runtime_tab_menu::RuntimeLaunchOutcome { receipt, statuses })
        }
    }
}
