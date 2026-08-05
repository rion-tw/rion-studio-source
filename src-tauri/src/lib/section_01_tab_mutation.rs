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
        RuntimeTabMutationAcceptance::Superseded => {
            return Ok(state
                .runtime
                .superseded_tab_mutation_summary(mutation_kind, tab_id));
        }
    };
    let lease = match state.runtime.await_tab_mutation_turn(operation).await {
        Ok(lease) => lease,
        Err(receipt) => return Ok(receipt),
    };
    let operation_id = lease.request.operation_id.clone();
    if let Err(message) = state.runtime.commit_live_tab_mutation_intent(
        mutation_kind,
        tab_id,
        target.as_ref(),
        lease.before_tab_id.as_deref(),
    ) {
        eprintln!(
            "Live tab mutation could not commit: kind={mutation_kind} tab={tab_id} error={message}"
        );
        return Ok(state.runtime.complete_tab_mutation(
            &operation_id,
            "tabMutationLiveCommitFailed",
            RuntimeTabMutationTerminalStatus::Failed,
            Some("TAB_MUTATION_LIVE_COMMIT_FAILED"),
            0,
        ));
    }
    schedule_tab_mutation_core_sink(
        state,
        lease.request,
        target,
        lease.before_tab_id,
    );
    Ok(state.runtime.complete_tab_mutation(
        &operation_id,
        "tabMutationLiveCommitted",
        RuntimeTabMutationTerminalStatus::Applied,
        None,
        0,
    ))
}

struct QueuedTabMutationSink {
    before_tab_id: Option<String>,
    request: RuntimeTabMutationRequestRecord,
    target: Option<EmbeddedLaunchTargetRecord>,
}

fn schedule_tab_mutation_core_sink(
    state: &CoreState,
    request: RuntimeTabMutationRequestRecord,
    target: Option<EmbeddedLaunchTargetRecord>,
    before_tab_id: Option<String>,
) {
    let core = Arc::clone(&state.core);
    let sender = state.tab_mutation_sink_queue.get_or_init(move || {
        let (sender, mut receiver) =
            tokio::sync::mpsc::unbounded_channel::<QueuedTabMutationSink>();
        tauri::async_runtime::spawn(async move {
            while let Some(queued) = receiver.recv().await {
                let tab_id = queued.request.tab_id.clone();
                let mutation_kind = queued.request.mutation_kind.clone();
                if let Err(error) = Arc::clone(&core)
                    .invoke_async(CoreCommand::EmbeddedTabMutation {
                        request: queued.request,
                        target: queued.target,
                        before_tab_id: queued.before_tab_id,
                    })
                    .await
                {
                    let payload = error.payload();
                    eprintln!(
                        "Background tab topology sink remains pending without live rollback: kind={mutation_kind} tab={tab_id} code={} error={}",
                        payload.code, payload.message
                    );
                }
            }
        });
        sender
    });
    if sender
        .send(QueuedTabMutationSink {
            before_tab_id,
            request,
            target,
        })
        .is_err()
    {
        eprintln!("Background tab topology sink queue is unavailable; live topology was retained.");
    }
}

fn tab_stop_terminal_outcome(native_release_confirmed: bool) -> (
    &'static str,
    RuntimeTabMutationTerminalStatus,
    Option<&'static str>,
) {
    let stage = if native_release_confirmed {
        "tabStopIsolated"
    } else {
        "tabStopIsolatedReleasePending"
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
        RuntimeTabMutationAcceptance::Superseded => {
            return Ok(state
                .runtime
                .superseded_tab_mutation_summary("stop", tab_id));
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
        Err(message) if stale_live_tab_action_error(&message) => {
            return Ok(state.runtime.complete_tab_mutation(
                &operation_id,
                "tabStopSupersededBeforePreview",
                RuntimeTabMutationTerminalStatus::Superseded,
                None,
                0,
            ));
        }
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
    match result {
        Ok(_) => {}
        Err(error) => {
            let payload = error.payload();
            if payload.code == "RUNTIME_TAB_NOT_FOUND" {
                state.runtime.resolve_tab_close_preview(tab_id, true);
                return Ok(state.runtime.complete_tab_mutation(
                    &operation_id,
                    "tabStopAlreadyAbsent",
                    RuntimeTabMutationTerminalStatus::Superseded,
                    None,
                    0,
                ));
            }
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
    }
    state.runtime.resolve_tab_close_preview(tab_id, true);
    let native_release_confirmed = state.runtime.tab_surface_release_confirmed(tab_id);
    let (stage, status, failure_code) = tab_stop_terminal_outcome(native_release_confirmed);
    Ok(state.runtime.complete_tab_mutation(
        &operation_id,
        stage,
        status,
        failure_code,
        0,
    ))
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
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedTabDragTopologyCommit {
            request,
            target,
            source_before_tab_ids,
            source_after_tab_ids,
            target_before_tab_ids,
            target_after_tab_ids,
        })
        .await
        .map_err(error_payload)?;
    Ok(RuntimeTabMutationProjectionOutcome::Applied)
}
