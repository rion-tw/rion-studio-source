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
        Ok(RuntimeTabMutationProjectionOutcome::Applied) => (
            "tabMutationConverged",
            RuntimeTabMutationTerminalStatus::Applied,
            None,
            0,
        ),
        Ok(RuntimeTabMutationProjectionOutcome::Superseded) => (
            "tabMutationSuperseded",
            RuntimeTabMutationTerminalStatus::Superseded,
            None,
            0,
        ),
        Ok(RuntimeTabMutationProjectionOutcome::Degraded) => (
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
    let stage = match (chrome_converged, native_release_confirmed) {
        (true, true) => "tabStopConverged",
        (true, false) => "tabStopIsolatedReleasePending",
        (false, true) => "tabStopChromeReconcilePending",
        (false, false) => "tabStopIsolatedReleaseAndChromeReconcilePending",
    };
    (stage, RuntimeTabMutationTerminalStatus::Applied, None)
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
        state.runtime.publish_projection();
        return Ok(state.runtime.complete_tab_mutation(
            &operation_id,
            "provisionalTabStopCommitted",
            RuntimeTabMutationTerminalStatus::Applied,
            None,
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
    let converged = matches!(
        state
            .runtime
            .tab_mutation_presentation_outcome(&lease.request, &snapshot),
        RuntimeTabMutationProjectionOutcome::Applied
    );
    state.runtime.schedule_tab_mutation_projection_diagnostic(lease.request, snapshot);
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

async fn execute_tab_mutation_commit(
    state: &CoreState,
    request: RuntimeTabMutationRequestRecord,
    target: Option<EmbeddedLaunchTargetRecord>,
    before_tab_id: Option<String>,
) -> Result<RuntimeTabMutationProjectionOutcome, CoreErrorPayload> {
    let target_window_id = target.as_ref().map(|target| target.window_id.clone());
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
    state.runtime.publish_projection();
    state
        .runtime
        .schedule_live_window_state_persistence(&request.source_window_id);
    if let Some(target_window_id) = target_window_id.as_deref()
        && target_window_id != request.source_window_id
    {
        state
            .runtime
            .schedule_live_window_state_persistence(target_window_id);
    }
    state
        .runtime
        .schedule_tab_mutation_projection_diagnostic(request, snapshot);
    Ok(RuntimeTabMutationProjectionOutcome::Applied)
}

#[allow(clippy::too_many_arguments)]
async fn execute_tab_drag_topology_commit(
    state: &CoreState,
    request: RuntimeTabMutationRequestRecord,
    target: Option<EmbeddedLaunchTargetRecord>,
    source_before_tab_ids: Vec<String>,
    source_after_tab_ids: Vec<String>,
    target_before_tab_ids: Vec<String>,
    target_after_tab_ids: Vec<String>,
) -> Result<RuntimeTabMutationProjectionOutcome, CoreErrorPayload> {
    let target_window_id = target.as_ref().map(|target| target.window_id.clone());
    let value = Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedTabDragTopologyCommit {
            request: request.clone(),
            target,
            source_before_tab_ids,
            source_after_tab_ids: source_after_tab_ids.clone(),
            target_before_tab_ids,
            target_after_tab_ids,
        })
        .await
        .map_err(error_payload)?;
    let snapshot = serde_json::from_value::<BrowserRuntimeSnapshot>(value)
        .map_err(|error| shell_error("TAB_MUTATION_RESULT_UNKNOWN", error.to_string()))?;
    state.runtime.publish_projection();
    state
        .runtime
        .schedule_live_window_state_persistence(&request.source_window_id);
    if let Some(target_window_id) = target_window_id.as_deref()
        && target_window_id != request.source_window_id
    {
        state
            .runtime
            .schedule_live_window_state_persistence(target_window_id);
    }
    state
        .runtime
        .schedule_tab_mutation_projection_diagnostic(request, snapshot);
    Ok(RuntimeTabMutationProjectionOutcome::Applied)
}
