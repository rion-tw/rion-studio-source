fn intent_trace_identity(intent: &RuntimeIntent) -> (&'static str, &'static str) {
    match intent {
        RuntimeIntent::BrowserRuntime(_) => ("browserRuntime", "appCore"),
        RuntimeIntent::CommitTopology(input) => {
            ("commitTopology", normalized_event_source(&input.source))
        }
        RuntimeIntent::CommitPlacement(input) => {
            ("commitPlacement", normalized_event_source(&input.source))
        }
        RuntimeIntent::InitializeWindowContext(_) => ("initializeWindowContext", "executor"),
        RuntimeIntent::EnsureWindow { .. } => ("ensureWindow", "executor"),
        RuntimeIntent::SetWindowGeneration { .. } => ("setWindowGeneration", "nativeEvent"),
        RuntimeIntent::SetPersistedName { .. } => ("setPersistedName", "command"),
        RuntimeIntent::SetTabAudioMuted { .. } => ("setTabAudioMuted", "command"),
        RuntimeIntent::SetRoleZoom { .. } => ("setRoleZoom", "command"),
        RuntimeIntent::ReplaceTabRoleSlots { .. } => ("replaceTabRoleSlots", "command"),
        RuntimeIntent::ReplaceTabWorkspaceSlots { .. } => {
            ("replaceTabWorkspaceSlots", "command")
        }
        RuntimeIntent::SetWindowZoomFactor { .. } => ("setWindowZoomFactor", "command"),
        RuntimeIntent::SeedDormantTabs { .. } => ("seedDormantTabs", "restore"),
        RuntimeIntent::BeginTabActivation { .. } => ("beginTabActivation", "appCore"),
        RuntimeIntent::ActivateTab { .. } => ("activateTab", "command"),
        RuntimeIntent::SetTabActivationPhase { .. } => ("setTabActivationPhase", "nativeEvent"),
        RuntimeIntent::ReplaceWindow { source, .. } => {
            ("replaceWindow", normalized_event_source(source))
        }
        RuntimeIntent::RemoveWindow { .. } => ("removeWindow", "nativeEvent"),
        RuntimeIntent::BeginOperation(_) => ("beginOperation", "appCore"),
        RuntimeIntent::CloseTab { .. } => ("closeTab", "command"),
        RuntimeIntent::NativeEvent(_) => ("nativeEvent", "nativeEvent"),
        RuntimeIntent::FailEventStream { source, .. } => {
            ("failEventStream", normalized_event_source(source))
        }
        RuntimeIntent::TerminalizeOperation { .. } => ("terminalizeOperation", "appCore"),
    }
}

fn normalized_event_source(source: &str) -> &'static str {
    match source {
        "appKit" => "appKit",
        "html" => "html",
        "nativeEventStream" => "nativeEventStream",
        "restore" => "restore",
        _ => "command",
    }
}

#[derive(Default)]
struct RuntimeTraceContext {
    attempt_id: Option<String>,
    phase: Option<String>,
    surface_generation: Option<u64>,
    tab_id: Option<String>,
    window_generation: Option<u64>,
}

fn intent_trace_context(intent: &RuntimeIntent) -> RuntimeTraceContext {
    match intent {
        RuntimeIntent::BeginOperation(operation) => RuntimeTraceContext {
            attempt_id: operation
                .attempt_id
                .as_ref()
                .map(|attempt| attempt.as_str().to_owned()),
            phase: Some(format!("{:?}", operation.phase).to_lowercase()),
            surface_generation: Some(operation.surface_generation.0),
            tab_id: operation.tab_id.as_ref().map(|tab| tab.as_str().to_owned()),
            window_generation: Some(operation.window_generation.0),
        },
        RuntimeIntent::BeginTabActivation {
            operation_id,
            tab_id,
            ..
        } => RuntimeTraceContext {
            attempt_id: Some(operation_id.as_str().to_owned()),
            phase: Some("activating".to_owned()),
            tab_id: Some(tab_id.as_str().to_owned()),
            ..RuntimeTraceContext::default()
        },
        RuntimeIntent::ActivateTab { tab_id, .. }
        | RuntimeIntent::SetTabActivationPhase { tab_id, .. } => RuntimeTraceContext {
            tab_id: Some(tab_id.as_str().to_owned()),
            ..RuntimeTraceContext::default()
        },
        RuntimeIntent::CloseTab {
            attempt_id,
            surface_generation,
            tab_id,
            window_generation,
            ..
        } => RuntimeTraceContext {
            attempt_id: attempt_id
                .as_ref()
                .map(|attempt| attempt.as_str().to_owned()),
            phase: Some("pending".to_owned()),
            surface_generation: Some(surface_generation.0),
            tab_id: Some(tab_id.as_str().to_owned()),
            window_generation: Some(window_generation.0),
        },
        RuntimeIntent::NativeEvent(event) => RuntimeTraceContext {
            attempt_id: Some(event.attempt_id.as_str().to_owned()),
            phase: Some(event.event_kind.clone()),
            surface_generation: Some(event.surface_generation.0),
            tab_id: Some(event.tab_id.as_str().to_owned()),
            window_generation: Some(event.window_generation.0),
        },
        RuntimeIntent::TerminalizeOperation { phase, .. } => RuntimeTraceContext {
            phase: Some(format!("{phase:?}").to_lowercase()),
            ..RuntimeTraceContext::default()
        },
        RuntimeIntent::FailEventStream { .. } => RuntimeTraceContext {
            phase: Some("indeterminate".to_owned()),
            ..RuntimeTraceContext::default()
        },
        RuntimeIntent::SetTabAudioMuted { tab_id, .. }
        | RuntimeIntent::SetRoleZoom { tab_id, .. }
        | RuntimeIntent::ReplaceTabRoleSlots { tab_id, .. }
        | RuntimeIntent::ReplaceTabWorkspaceSlots { tab_id, .. } => RuntimeTraceContext {
            tab_id: Some(tab_id.clone()),
            ..RuntimeTraceContext::default()
        },
        _ => RuntimeTraceContext::default(),
    }
}

fn record_trace(
    state: &mut RuntimeKernelState,
    commit: &RuntimeCommit,
    intent_kind: &str,
    event_source: &str,
    context: RuntimeTraceContext,
) {
    let status = match commit.status {
        RuntimeCommitStatus::Applied => "applied",
        RuntimeCommitStatus::Duplicate => "duplicate",
        RuntimeCommitStatus::Superseded => "superseded",
    };
    state.trace.push_back(RuntimeOperationTraceRecord {
        attempt_id: context.attempt_id,
        event_source: event_source.to_owned(),
        intent_kind: intent_kind.to_owned(),
        operation_id: commit.operation_id.clone(),
        phase: context.phase.unwrap_or_else(|| "terminal".to_owned()),
        revision: commit.revision,
        status: status.to_owned(),
        surface_generation: context.surface_generation,
        tab_id: context.tab_id,
        window_generation: context.window_generation,
        window_ids: commit.window_ids.clone(),
    });
    while state.trace.len() > RETAINED_OPERATION_TRACES {
        state.trace.pop_front();
    }
}
