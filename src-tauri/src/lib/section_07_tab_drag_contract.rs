const FINISHED_TAB_DRAG_LIMIT: usize = 128;
const TAB_DRAG_SESSION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
struct CompletedGameWindowTabDrag {
    receipt: SystemRuntimeOperationSummaryRecord,
    session: RuntimeTabDragSessionRecord,
}

struct TabDragRollbackFailure {
    error: CoreErrorPayload,
    error_count: usize,
}

#[cfg(test)]
fn tab_drag_rollback_error(
    error: &CoreErrorPayload,
    cleanup: &CoreErrorPayload,
) -> CoreErrorPayload {
    shell_error(
        "TAURI_TAB_DRAG_ROLLBACK_FAILED",
        format!(
            "Runtime tab drag failed ({}: {}); rollback failed ({}: {}).",
            error.code, error.message, cleanup.code, cleanup.message
        ),
    )
}

fn tab_drag_active_phase(phase: &GameWindowTabDragPhase) -> &'static str {
    match phase {
        GameWindowTabDragPhase::Previewing => "accepted",
        GameWindowTabDragPhase::Attached | GameWindowTabDragPhase::Floating => "dragging",
        GameWindowTabDragPhase::AwaitingDropIntent => "dropping",
        GameWindowTabDragPhase::Finishing => "settling",
        GameWindowTabDragPhase::Cancelled => "cancelled",
    }
}

fn tab_drag_active_record(session: &GameWindowTabDragSession) -> RuntimeTabDragSessionRecord {
    RuntimeTabDragSessionRecord {
        session_id: session.id.clone(),
        operation_id: session.operation_id.clone(),
        source_window_id: session.source_window_id.clone(),
        source_tab_id: session.tab_id.clone(),
        lifecycle_epoch: session.lifecycle_epoch,
        topology_revision: session.topology_revision,
        phase: tab_drag_active_phase(&session.phase).to_owned(),
        status: "active".to_owned(),
        started_at: session.accepted_at.clone(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        failure_code: None,
    }
}

fn tab_drag_terminal_record(
    session: &GameWindowTabDragSession,
    receipt: &SystemRuntimeOperationSummaryRecord,
) -> RuntimeTabDragSessionRecord {
    let (phase, status) = match receipt.status.as_str() {
        "applied" | "degraded" | "superseded" => ("completed", "applied"),
        "cancelled" => ("cancelled", "cancelled"),
        "failed" => ("failed", "failed"),
        _ => ("indeterminate", "indeterminate"),
    };
    RuntimeTabDragSessionRecord {
        session_id: session.id.clone(),
        operation_id: receipt.operation_id.clone(),
        source_window_id: session.source_window_id.clone(),
        source_tab_id: session.tab_id.clone(),
        lifecycle_epoch: session.lifecycle_epoch,
        topology_revision: session.topology_revision,
        phase: phase.to_owned(),
        status: status.to_owned(),
        started_at: session.accepted_at.clone(),
        updated_at: receipt.captured_at.clone(),
        failure_code: receipt.failure_code.clone(),
    }
}

fn emit_tab_drag_active(app: &AppHandle, session: &GameWindowTabDragSession) {
    let _ = app.emit("rion://runtime-tab-drag-session", tab_drag_active_record(session));
}

fn schedule_tab_drag_session_timeout(app: &AppHandle, session_id: &str) {
    let app = app.clone();
    let session_id = session_id.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TAB_DRAG_SESSION_TIMEOUT).await;
        let state = app.state::<CoreState>();
        let _lane = state.tab_drag_lane.lock().await;
        let still_active = state
            .tab_drag
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|session| session.id == session_id))
            .unwrap_or(false);
        if still_active {
            let _ = finish_failed_tab_drag(
                &app,
                &state,
                &session_id,
                shell_error(
                    "NATIVE_OPERATION_DEADLINE_EXCEEDED",
                    "The tab drag did not reach a terminal action before its deadline.",
                ),
            );
        }
    });
}

fn tab_drag_terminal(
    state: &CoreState,
    session_id: &str,
) -> Result<Option<CompletedGameWindowTabDrag>, CoreErrorPayload> {
    state
        .tab_drag_finished
        .lock()
        .map(|finished| {
            finished
                .iter()
                .find(|entry| entry.session.session_id == session_id)
                .cloned()
        })
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))
}

fn record_tab_drag_terminal(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
    receipt: SystemRuntimeOperationSummaryRecord,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    let mut finished = state
        .tab_drag_finished
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    if let Some(existing) = finished
        .iter()
        .find(|entry| entry.session.session_id == session.id)
    {
        return Ok(existing.receipt.clone());
    }
    let terminal_session = tab_drag_terminal_record(session, &receipt);
    finished.push_back(CompletedGameWindowTabDrag {
        receipt: receipt.clone(),
        session: terminal_session.clone(),
    });
    while finished.len() > FINISHED_TAB_DRAG_LIMIT {
        finished.pop_front();
    }
    drop(finished);
    let _ = app.emit("rion://runtime-tab-drag-session", terminal_session);
    let _ = app.emit("rion://runtime-tab-drag-receipt", &receipt);
    Ok(receipt)
}

fn complete_tab_drag_terminal(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
    stage: &'static str,
    status: RuntimeTabDragTerminalStatus,
    failure_code: Option<&str>,
    rollback_error_count: usize,
) -> Result<SystemRuntimeOperationSummaryRecord, CoreErrorPayload> {
    if let Some(existing) = tab_drag_terminal(state, &session.id)? {
        return Ok(existing.receipt);
    }
    let receipt = state.runtime.complete_tab_drag_operation(
        &session.operation_id,
        stage,
        status,
        failure_code,
        rollback_error_count,
    );
    record_tab_drag_terminal(app, state, session, receipt)
}

fn tab_drag_fence_error(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Option<CoreErrorPayload> {
    if state.display_topology.current_revision() != session.topology_revision {
        return Some(shell_error(
            "SYSTEM_TAB_DRAG_TOPOLOGY_STALE",
            "Display topology changed during the tab drag.",
        ));
    }
    let generation_is_current = session.snapshots.values().all(|snapshot| {
        state
            .runtime
            .tab_drag_window_generation_matches(&snapshot.window_id, snapshot.generation)
    });
    if !generation_is_current
        || !state.runtime.tab_drag_window_generation_matches(
            &session.source_window_id,
            session.source_window_generation,
        )
    {
        return Some(shell_error(
            "SYSTEM_TAB_DRAG_WINDOW_STALE",
            "A Game Window generation changed during the tab drag.",
        ));
    }
    None
}

fn serialize_tab_drag_response<T: serde::Serialize>(value: &T) -> Result<Value, CoreErrorPayload> {
    serde_json::to_value(value)
        .map_err(|error| shell_error("TAURI_TAB_DRAG_FAILED", error.to_string()))
}

fn active_tab_drag_response(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
) -> Result<Value, CoreErrorPayload> {
    if let Some(terminal) = tab_drag_terminal(state, session_id)? {
        return serialize_tab_drag_response(&terminal.receipt);
    }
    let session = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?
        .as_ref()
        .filter(|session| session.id == session_id)
        .cloned()
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_STALE", "Runtime tab drag session is stale."))?;
    emit_tab_drag_active(app, &session);
    serialize_tab_drag_response(&tab_drag_active_record(&session))
}

fn finish_failed_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
    error: CoreErrorPayload,
) -> Result<Value, CoreErrorPayload> {
    if let Some(terminal) = tab_drag_terminal(state, session_id)? {
        return serialize_tab_drag_response(&terminal.receipt);
    }
    let Some(mut session) = take_tab_drag_session(state, session_id)? else {
        return Err(error);
    };
    finish_failed_tab_drag_session(app, state, &mut session, error)
}

fn finish_failed_tab_drag_session(
    app: &AppHandle,
    state: &CoreState,
    session: &mut GameWindowTabDragSession,
    error: CoreErrorPayload,
) -> Result<Value, CoreErrorPayload> {
    session.phase = GameWindowTabDragPhase::Cancelled;
    let rollback = cancel_tab_drag_session(state, session);
    let (status, failure_code, rollback_error_count) = match rollback {
        Ok(()) => (
            RuntimeTabDragTerminalStatus::Failed,
            error.code.clone(),
            0,
        ),
        Err(cleanup) => (
            RuntimeTabDragTerminalStatus::Indeterminate,
            cleanup.error.code,
            cleanup.error_count,
        ),
    };
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        session,
        "tabDragRolledBack",
        status,
        Some(&failure_code),
        rollback_error_count,
    )?;
    serialize_tab_drag_response(&receipt)
}

fn finish_cancelled_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    mut session: GameWindowTabDragSession,
) -> Result<Value, CoreErrorPayload> {
    session.phase = GameWindowTabDragPhase::Cancelled;
    let rollback = cancel_tab_drag_session(state, &session);
    let (status, failure_code, rollback_error_count) = match rollback {
        Ok(()) => (RuntimeTabDragTerminalStatus::Cancelled, None, 0),
        Err(cleanup) => (
            RuntimeTabDragTerminalStatus::Indeterminate,
            Some(cleanup.error.code),
            cleanup.error_count,
        ),
    };
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        &session,
        "tabDragCancelled",
        status,
        failure_code.as_deref(),
        rollback_error_count,
    )?;
    serialize_tab_drag_response(&receipt)
}

fn finish_applied_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
    exact_cleanup: bool,
) -> Result<Value, CoreErrorPayload> {
    let status = if exact_cleanup {
        RuntimeTabDragTerminalStatus::Applied
    } else {
        RuntimeTabDragTerminalStatus::Degraded
    };
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        session,
        if exact_cleanup {
            "tabDragCommitted"
        } else {
            "tabDragCleanupDegraded"
        },
        status,
        (!exact_cleanup).then_some("SYSTEM_TAB_DRAG_CLEANUP_DEGRADED"),
        0,
    )?;
    serialize_tab_drag_response(&receipt)
}
