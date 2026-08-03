#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeTabDragOperation {
    pub(crate) accepted_at: String,
    pub(crate) operation_id: String,
    pub(crate) window_generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeTabDragTerminalStatus {
    Applied,
    Superseded,
    Degraded,
    Cancelled,
    Failed,
    Indeterminate,
}

impl RuntimeTabDragTerminalStatus {
    fn native_status(self) -> NativeOperationStatus {
        match self {
            Self::Applied => NativeOperationStatus::Applied,
            Self::Superseded => NativeOperationStatus::Superseded,
            Self::Degraded => NativeOperationStatus::Degraded,
            Self::Cancelled => NativeOperationStatus::Cancelled,
            Self::Failed => NativeOperationStatus::Failed,
            Self::Indeterminate => NativeOperationStatus::Indeterminate,
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn accept_tab_drag_operation(
        &self,
        session_id: &str,
        source_window_id: &str,
        source_tab_id: &str,
        lifecycle_epoch: u64,
        topology_revision: u64,
    ) -> RuntimeResult<RuntimeTabDragOperation> {
        self.require_runtime_accepting()?;
        let window_generation = self
            .state()?
            .display_hosts
            .get(source_window_id)
            .map(|host| host.generation)
            .ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_TAB_DRAG_WINDOW_NOT_FOUND",
                    "The source Game Window is unavailable.",
                )
            })?;
        let context = NativeOperationContext::new(
            NativeOperationSubsystem::Drag,
            "runtime-tab-drag",
            TAB_DRAG_OPERATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::DragCommitted)
        .with_session_id(session_id)
        .with_window(source_window_id)
        .with_window_generation(window_generation)
        .with_tab(source_tab_id)
        .with_lifecycle_epoch(lifecycle_epoch)
        .with_topology_revision(topology_revision);
        self.operations.register(context.clone()).map_err(|code| {
            RuntimeError::new(
                code,
                "The native tab drag operation registry is full or unavailable.",
            )
        })?;
        self.tab_drag_intents
            .bind_operation(session_id, &context.operation_id);
        Ok(RuntimeTabDragOperation {
            accepted_at: context.accepted_at,
            operation_id: context.operation_id,
            window_generation,
        })
    }

    pub(crate) fn stamp_native_tab_drag_action(
        &self,
        action_type: &str,
        session_id: Option<&str>,
        tab_id: Option<&str>,
        source_window_id: Option<&str>,
        target_window_id: Option<&str>,
    ) -> NativeTabDragActionStamp {
        self.tab_drag_intents.stamp_action(
            action_type,
            session_id,
            tab_id,
            source_window_id,
            target_window_id,
        )
    }

    pub(crate) fn tab_drag_intent_is_latest(&self, session_id: &str, generation: u64) -> bool {
        self.tab_drag_intents.is_latest(session_id, generation)
    }

    pub(crate) fn tab_drag_projection_is_latest(&self, session_id: &str, generation: u64) -> bool {
        self.tab_drag_intents
            .projection_is_latest(session_id, generation)
    }

    pub(crate) fn newer_tab_drag_intent_started_in(
        &self,
        session_id: &str,
        generation: u64,
        window_id: &str,
    ) -> bool {
        self.tab_drag_intents
            .newer_intent_started_in(session_id, generation, window_id)
    }

    pub(crate) fn complete_tab_drag_intent(&self, session_id: &str) {
        self.tab_drag_intents.complete(session_id);
    }

    pub(crate) fn record_tab_drag_projection_mismatch(
        &self,
        request: &RuntimeTabMutationRequestRecord,
    ) {
        let window_id = request
            .target_window_id
            .as_deref()
            .unwrap_or(&request.source_window_id);
        let observed = self
            .presentation
            .existing(window_id)
            .and_then(|state| state.lock().ok().map(|state| state.clone()));
        let context = json!({
            "expectedActiveTabId": request.expected_active_tab_id,
            "expectedTabOrder": request.expected_tab_order,
            "nativeExactReadback": false,
            "observedActiveTabId": observed.as_ref().and_then(|state| state.selected_tab_id.as_deref()),
            "observedTabOrder": observed.map(|state| state.tab_ids()).unwrap_or_default(),
            "operationId": request.operation_id,
            "presentationRevision": request.presentation_revision,
            "tabId": request.tab_id,
            "windowId": window_id,
        });
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level: LogLevel::Warn,
                        source: LogSource::Browser,
                        event: "tab.drag-projection-degraded".to_owned(),
                        message: "Native tab topology did not match the frozen drag projection."
                            .to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    pub(crate) fn mark_tab_drag_native_submitted(&self, operation_id: &str) -> bool {
        self.operations.mark_in_flight(operation_id)
    }

    pub(crate) fn complete_tab_drag_operation(
        &self,
        operation_id: &str,
        stage: &'static str,
        status: RuntimeTabDragTerminalStatus,
        failure_code: Option<&str>,
        rollback_error_count: usize,
    ) -> SystemRuntimeOperationSummaryRecord {
        if let Some(receipt) = self.operations.terminal(operation_id) {
            return receipt.summary();
        }
        let Some(context) = self.operations.context(operation_id) else {
            return NativeOperationReceipt::with_status(
                NativeOperationContext::new(
                    NativeOperationSubsystem::Drag,
                    "runtime-tab-drag-receipt-fallback",
                    Duration::ZERO,
                )
                .with_completion_scope(SystemRuntimeOperationCompletionScope::DragCommitted),
                "tabDragReceiptUnavailable",
                NativeOperationStatus::Indeterminate,
                Some("SYSTEM_TAB_DRAG_RECEIPT_UNAVAILABLE"),
            )
            .summary();
        };
        self.operations
            .complete(
                NativeOperationReceipt::with_status(
                    context,
                    stage,
                    status.native_status(),
                    failure_code,
                )
                .with_rollback_error_count(rollback_error_count),
            )
            .summary()
    }
}
