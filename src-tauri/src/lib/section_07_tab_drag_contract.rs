const FINISHED_TAB_DRAG_LIMIT: usize = 128;

fn accept_ordered_tab_drag_event(
    state: &CoreState,
    session_id: &str,
    intent_generation: u64,
    event_sequence: u64,
) -> Result<bool, CoreErrorPayload> {
    let mut current = state
        .tab_drag
        .lock()
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))?;
    let Some(session) = current.as_mut().filter(|session| session.id == session_id) else {
        return Ok(true);
    };
    if session.intent_generation != intent_generation
        || event_sequence <= session.last_event_sequence
    {
        return Ok(false);
    }
    session.last_event_sequence = event_sequence;
    Ok(true)
}

fn superseded_tab_drag_terminal_action(action_type: &str) -> bool {
    matches!(
        action_type,
        "tabDragDrop" | "tabDragEnd" | "tabDragSourceEnd" | "tabDragCancel"
    )
}

fn superseded_tab_drag_response(
    session_id: &str,
    event_sequence: u64,
    intent_generation: u64,
) -> Value {
    json!({
        "eventSequence": event_sequence,
        "intentGeneration": intent_generation,
        "sessionId": session_id,
        "status": "superseded",
    })
}

fn active_tab_drag_session_id(
    state: &CoreState,
) -> Result<Option<String>, CoreErrorPayload> {
    state
        .tab_drag
        .lock()
        .map(|session| session.as_ref().map(|session| session.id.clone()))
        .map_err(|_| shell_error("TAURI_TAB_DRAG_FAILED", "Tab drag state lock was poisoned."))
}

fn tab_drag_defers_native_mutations(is_windows: bool, is_macos: bool) -> bool {
    let _ = is_macos;
    is_windows
}

#[derive(Clone)]
struct CompletedGameWindowTabDrag {
    receipt: SystemRuntimeOperationSummaryRecord,
    session: RuntimeTabDragSessionRecord,
}

fn tab_drag_active_phase(phase: &GameWindowTabDragPhase) -> &'static str {
    match phase {
        GameWindowTabDragPhase::Previewing => "accepted",
        GameWindowTabDragPhase::Attached | GameWindowTabDragPhase::Floating => "dragging",
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
        phase: phase.to_owned(),
        status: status.to_owned(),
        started_at: session.accepted_at.clone(),
        updated_at: receipt.captured_at.clone(),
        failure_code: receipt.failure_code.clone(),
    }
}

fn emit_tab_drag_active(app: &AppHandle, session: &GameWindowTabDragSession) {
    let _ = app.emit(
        "rion://runtime-tab-drag-session",
        tab_drag_active_record(session),
    );
}

fn cancel_stale_tab_drag_after_lifecycle(app: &AppHandle, state: &CoreState) {
    let session_id = state
        .tab_drag
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.id.clone()));
    let Some(session_id) = session_id else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<CoreState>();
        let _lane = state.tab_drag_lane.lock().await;
        let current = state
            .tab_drag
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|session| session.id.clone()));
        if current.as_deref() != Some(session_id.as_str()) {
            return;
        }
        let _ = finish_failed_tab_drag(
            &app,
            &state,
            &session_id,
            shell_error(
                "SYSTEM_TAB_DRAG_LIFECYCLE_STALE",
                "The application lifecycle changed during the tab drag.",
            ),
        );
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
    state.runtime.complete_tab_drag_intent(&session.id);
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
    if !tab_drag_lifecycle_is_current(state.runtime.lifecycle_epoch(), session.lifecycle_epoch) {
        return Some(shell_error(
            "SYSTEM_TAB_DRAG_LIFECYCLE_STALE",
            "The application lifecycle changed during the tab drag.",
        ));
    }
    None
}

fn tab_drag_lifecycle_is_current(current_epoch: u64, accepted_epoch: u64) -> bool {
    current_epoch == accepted_epoch
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
        .cloned();
    let Some(session) = session else {
        return Ok(superseded_tab_drag_response(session_id, 0, 0));
    };
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

fn finish_superseded_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
) -> Result<Value, CoreErrorPayload> {
    if let Some(terminal) = tab_drag_terminal(state, session_id)? {
        return serialize_tab_drag_response(&terminal.receipt);
    }
    let Some(session) = take_tab_drag_session(state, session_id)? else {
        return Ok(superseded_tab_drag_response(session_id, 0, 0));
    };
    record_tab_drag_lifecycle(
        state,
        &session,
        "tab.drag-terminal-superseded",
        "An older drag terminal skipped native cleanup because a newer intent owns the tab.",
    );
    release_tab_drag_window_motion_suppression(state, &session, None);
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        &session,
        "tabDragSuperseded",
        RuntimeTabDragTerminalStatus::Superseded,
        None,
        0,
    )?;
    serialize_tab_drag_response(&receipt)
}

fn finish_failed_tab_drag_session(
    app: &AppHandle,
    state: &CoreState,
    session: &mut GameWindowTabDragSession,
    error: CoreErrorPayload,
) -> Result<Value, CoreErrorPayload> {
    session.phase = GameWindowTabDragPhase::Cancelled;
    if session.intent_generation > 0
        && !state
            .runtime
            .tab_drag_projection_is_latest(&session.id, session.intent_generation)
    {
        record_tab_drag_lifecycle(
            state,
            session,
            "tab.drag-cleanup-superseded",
            "An older drag failure only released gesture resources because a newer intent owns the tab.",
        );
        release_tab_drag_window_motion_suppression(state, session, None);
        let receipt = complete_tab_drag_terminal(
            app,
            state,
            session,
            "tabDragSuperseded",
            RuntimeTabDragTerminalStatus::Superseded,
            None,
            0,
        )?;
        return serialize_tab_drag_response(&receipt);
    }
    if state.runtime.live_tab_window_id(&session.tab_id).is_some() {
        record_tab_drag_lifecycle(
            state,
            session,
            "tab.drag-live-commit-retained",
            "A post-commit native failure retained the live destination for background repair.",
        );
        release_tab_drag_window_motion_suppression(state, session, None);
        let receipt = complete_tab_drag_terminal(
            app,
            state,
            session,
            "tabDragLiveCommittedNativeRetryPending",
            RuntimeTabDragTerminalStatus::Applied,
            None,
            0,
        )?;
        return serialize_tab_drag_response(&receipt);
    }
    finish_cancelled_tab_drag_gesture(state, session);
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        session,
        "tabDragSupersededAfterTabRetired",
        RuntimeTabDragTerminalStatus::Superseded,
        Some(&error.code),
        0,
    )?;
    serialize_tab_drag_response(&receipt)
}

fn finish_cancelled_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    mut session: GameWindowTabDragSession,
) -> Result<Value, CoreErrorPayload> {
    session.phase = GameWindowTabDragPhase::Cancelled;
    finish_cancelled_tab_drag_gesture(state, &session);
    let receipt = complete_tab_drag_terminal(
        app,
        state,
        &session,
        "tabDragCancelled",
        RuntimeTabDragTerminalStatus::Cancelled,
        None,
        0,
    )?;
    serialize_tab_drag_response(&receipt)
}

fn finish_applied_tab_drag(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
    outcome: RuntimeTabMutationProjectionOutcome,
) -> Result<Value, CoreErrorPayload> {
    let outcome = if session.intent_generation > 0
        && !state
            .runtime
            .tab_drag_projection_is_latest(&session.id, session.intent_generation)
    {
        RuntimeTabMutationProjectionOutcome::Superseded
    } else {
        outcome
    };
    if outcome == RuntimeTabMutationProjectionOutcome::Superseded {
        record_tab_drag_lifecycle(
            state,
            session,
            "tab.drag-projection-superseded",
            "An older drag projection was fenced because a newer user intent exists.",
        );
    }
    let (stage, status, failure_code) = match outcome {
        RuntimeTabMutationProjectionOutcome::Applied => (
            "tabDragCommitted",
            RuntimeTabDragTerminalStatus::Applied,
            None,
        ),
        RuntimeTabMutationProjectionOutcome::Superseded => (
            "tabDragSuperseded",
            RuntimeTabDragTerminalStatus::Superseded,
            None,
        ),
    };
    let receipt = complete_tab_drag_terminal(app, state, session, stage, status, failure_code, 0)?;
    serialize_tab_drag_response(&receipt)
}
