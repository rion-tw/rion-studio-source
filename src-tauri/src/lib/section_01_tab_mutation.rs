async fn execute_tab_mutation(
    state: &CoreState,
    mutation_kind: &str,
    tab_id: &str,
    target: Option<EmbeddedLaunchTargetRecord>,
    before_tab_id: Option<String>,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    let target_window_id = target.as_ref().map(|target| target.window_id.as_str());
    let acceptance = state
        .runtime
        .accept_tab_mutation(
            mutation_kind,
            tab_id,
            target_window_id,
            before_tab_id.as_deref(),
            state.display_topology.current_revision(),
        )
        .map_err(|error| shell_error(error.code, error.message))?;
    let operation = match acceptance {
        RuntimeTabMutationAcceptance::Accepted(operation) => *operation,
        RuntimeTabMutationAcceptance::ExistingStop(operation_id) => {
            let runtime = Arc::clone(&state.runtime);
            return tauri::async_runtime::spawn_blocking(move || {
                runtime.wait_tab_mutation_receipt(&operation_id)
            })
            .await
            .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()));
        }
    };
    let lease = match state.runtime.await_tab_mutation_turn(operation).await {
        Ok(lease) => lease,
        Err(receipt) => return Ok(receipt),
    };
    let operation_id = lease.request.operation_id.clone();
    let commit = execute_tab_mutation_commit(
        state,
        lease.request,
        target,
        lease.before_tab_id,
    )
    .await;
    let (stage, status, failure_code, rollback_error_count) = match commit {
        Ok(true) => (
            "tabMutationConverged",
            RuntimeTabMutationTerminalStatus::Applied,
            None,
            0,
        ),
        Ok(false) => (
            "tabMutationChromeUnconfirmed",
            RuntimeTabMutationTerminalStatus::Degraded,
            Some("TAB_MUTATION_CHROME_NOT_CONFIRMED"),
            0,
        ),
        Err(error) if error.code == "CORE_OPERATION_COMPENSATION_FAILED" => (
            "tabMutationCompensationFailed",
            RuntimeTabMutationTerminalStatus::Indeterminate,
            Some("TAB_MUTATION_COMPENSATION_FAILED"),
            1,
        ),
        Err(error)
            if matches!(
                error.code.as_str(),
                "CORE_EFFECT_TIMEOUT" | "CORE_EFFECT_RESULT_UNKNOWN"
            ) => (
            "tabMutationResultUnknown",
            RuntimeTabMutationTerminalStatus::Indeterminate,
            Some("TAB_MUTATION_RESULT_UNKNOWN"),
            0,
        ),
        Err(_) => (
            "tabMutationCoreCommitFailed",
            RuntimeTabMutationTerminalStatus::Failed,
            Some("TAB_MUTATION_CORE_COMMIT_FAILED"),
            0,
        ),
    };
    Ok(state.runtime.complete_tab_mutation(
        &operation_id,
        stage,
        status,
        failure_code,
        rollback_error_count,
    ))
}

fn tab_stop_terminal_outcome(
    chrome_converged: bool,
    native_release_confirmed: bool,
) -> (
    &'static str,
    RuntimeTabMutationTerminalStatus,
    Option<&'static str>,
) {
    if !chrome_converged {
        return (
            "tabStopChromeUnconfirmed",
            RuntimeTabMutationTerminalStatus::Degraded,
            Some("TAB_MUTATION_CHROME_NOT_CONFIRMED"),
        );
    }
    if !native_release_confirmed {
        return (
            "tabStopReleasePending",
            RuntimeTabMutationTerminalStatus::Degraded,
            None,
        );
    }
    (
        "tabStopConverged",
        RuntimeTabMutationTerminalStatus::Applied,
        None,
    )
}

async fn execute_tab_stop(
    state: &CoreState,
    tab_id: &str,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    let acceptance = state
        .runtime
        .accept_tab_mutation(
            "stop",
            tab_id,
            None,
            None,
            state.display_topology.current_revision(),
        )
        .map_err(|error| shell_error(error.code, error.message))?;
    let operation = match acceptance {
        RuntimeTabMutationAcceptance::Accepted(operation) => *operation,
        RuntimeTabMutationAcceptance::ExistingStop(operation_id) => {
            let runtime = Arc::clone(&state.runtime);
            return tauri::async_runtime::spawn_blocking(move || {
                runtime.wait_tab_mutation_receipt(&operation_id)
            })
            .await
            .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()));
        }
    };
    let lease = match state.runtime.await_tab_mutation_turn(operation).await {
        Ok(lease) => lease,
        Err(receipt) => return Ok(receipt),
    };
    let operation_id = lease.request.operation_id.clone();

    if state.runtime.cancel_provisional_tab_launch(tab_id) {
        let converged = tab_stop_projection_converged(state, lease.request).await?;
        return Ok(state.runtime.complete_tab_mutation(
            &operation_id,
            if converged {
                "provisionalTabStopConverged"
            } else {
                "provisionalTabStopChromeUnconfirmed"
            },
            if converged {
                RuntimeTabMutationTerminalStatus::Applied
            } else {
                RuntimeTabMutationTerminalStatus::Degraded
            },
            (!converged).then_some("TAB_MUTATION_CHROME_NOT_CONFIRMED"),
            0,
        ));
    }

    let intent = match state.runtime.preview_tab_close(tab_id) {
        Ok(intent) => intent,
        Err(_) => {
            return Ok(state.runtime.complete_tab_mutation(
                &operation_id,
                "tabStopPreviewFailed",
                RuntimeTabMutationTerminalStatus::Failed,
                Some("TAB_MUTATION_CORE_COMMIT_FAILED"),
                0,
            ));
        }
    };
    let result = Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedTabStop {
            request: lease.request.clone(),
            source_id: intent.source_id,
            tab_type: intent.tab_type,
        })
        .await;
    let snapshot = match result {
        Ok(value) => match serde_json::from_value::<BrowserRuntimeSnapshot>(value) {
            Ok(snapshot) if snapshot.tabs.iter().all(|tab| tab.id != tab_id) => snapshot,
            Ok(_) | Err(_) => {
                state.runtime.resolve_tab_close_preview(tab_id, false);
                return Ok(state.runtime.complete_tab_mutation(
                    &operation_id,
                    "tabStopReadbackUnknown",
                    RuntimeTabMutationTerminalStatus::Indeterminate,
                    Some("TAB_MUTATION_RESULT_UNKNOWN"),
                    0,
                ));
            }
        },
        Err(error) => {
            let payload = error.payload();
            state.runtime.resolve_tab_close_preview(tab_id, false);
            let failure_code = if payload.code == "SYSTEM_SURFACE_RELEASE_UNVERIFIED" {
                "SYSTEM_SURFACE_RELEASE_UNVERIFIED"
            } else {
                "TAB_MUTATION_RESULT_UNKNOWN"
            };
            return Ok(state.runtime.complete_tab_mutation(
                &operation_id,
                "tabStopQuarantined",
                RuntimeTabMutationTerminalStatus::Indeterminate,
                Some(failure_code),
                0,
            ));
        }
    };
    state.runtime.resolve_tab_close_preview(tab_id, true);
    state.runtime.publish_projection();
    let runtime = Arc::clone(&state.runtime);
    let request = lease.request;
    let converged = tauri::async_runtime::spawn_blocking(move || {
        runtime.tab_mutation_projection_converged(&request, &snapshot)
    })
    .await
    .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))?;
    let native_release_confirmed = state.runtime.tab_surface_release_confirmed(tab_id);
    let (stage, status, failure_code) =
        tab_stop_terminal_outcome(converged, native_release_confirmed);
    Ok(state.runtime.complete_tab_mutation(
        &operation_id,
        stage,
        status,
        failure_code,
        0,
    ))
}

async fn tab_stop_projection_converged(
    state: &CoreState,
    request: RuntimeTabMutationRequestRecord,
) -> Result<bool, CoreErrorPayload> {
    state.runtime.publish_projection();
    let snapshot = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<BrowserRuntimeSnapshot>(value)
                .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))
        })?;
    let runtime = Arc::clone(&state.runtime);
    tauri::async_runtime::spawn_blocking(move || {
        runtime.tab_mutation_projection_converged(&request, &snapshot)
    })
    .await
    .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))
}

async fn execute_tab_mutation_commit(
    state: &CoreState,
    request: RuntimeTabMutationRequestRecord,
    target: Option<EmbeddedLaunchTargetRecord>,
    before_tab_id: Option<String>,
) -> Result<bool, CoreErrorPayload> {
    let value = Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedTabMutation {
            request: request.clone(),
            target,
            before_tab_id,
        })
        .await
        .map_err(error_payload)?;
    let snapshot = serde_json::from_value::<BrowserRuntimeSnapshot>(value)
        .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))?;
    let persisted = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))
        })?;
    if !tab_mutation_persistence_converged(&request, &snapshot, &persisted) {
        return Err(shell_error(
            "TAB_MUTATION_RESULT_UNKNOWN",
            "The saved Game Window topology did not match the committed runtime.",
        ));
    }
    state.runtime.publish_projection();
    let runtime = Arc::clone(&state.runtime);
    tauri::async_runtime::spawn_blocking(move || {
        runtime.tab_mutation_projection_converged(&request, &snapshot)
    })
    .await
    .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))
}

fn tab_mutation_persistence_converged(
    request: &RuntimeTabMutationRequestRecord,
    snapshot: &BrowserRuntimeSnapshot,
    persisted: &[StateGameWindowRecord],
) -> bool {
    let Some(runtime_tab) = snapshot.tabs.iter().find(|tab| tab.id == request.tab_id) else {
        return request.mutation_kind == "stop";
    };
    if request.mutation_kind == "hide" && !runtime_tab.hidden {
        return false;
    }
    let persisted_owner = persisted.iter().find_map(|window| {
        window
            .tabs
            .iter()
            .find(|tab| tab.id == request.tab_id)
            .map(|tab| (window, tab))
    });
    match persisted_owner {
        Some((window, tab)) => {
            window.id == runtime_tab.window_id
                && (request.mutation_kind != "hide" || tab.hidden)
                && snapshot
                    .windows
                    .iter()
                    .find(|runtime_window| runtime_window.window_id == window.id)
                    .is_none_or(|runtime_window| {
                        let persisted_live_order = window
                            .tabs
                            .iter()
                            .filter(|saved| {
                                runtime_window
                                    .tab_ids
                                    .iter()
                                    .any(|tab_id| tab_id == &saved.id)
                            })
                            .map(|saved| saved.id.as_str())
                            .collect::<Vec<_>>();
                        let runtime_order = runtime_window
                            .tab_ids
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>();
                        persisted_live_order == runtime_order
                    })
        }
        None => persisted.iter().all(|window| window.id != runtime_tab.window_id),
    }
}
