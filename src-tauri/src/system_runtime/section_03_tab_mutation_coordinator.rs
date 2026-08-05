const TAB_MUTATION_LANE_CAPACITY: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeTabMutationProjectionOutcome {
    Applied,
    Superseded,
}

#[derive(Default)]
struct TabMutationCoordinator {
    lanes: Mutex<HashMap<String, Arc<TabMutationLane>>>,
}

#[derive(Default)]
struct TabMutationLane {
    gate: Arc<tokio::sync::Mutex<()>>,
    queued: AtomicUsize,
    stop_operation_id: Mutex<Option<String>>,
}

impl TabMutationLane {
    fn try_enqueue(&self) -> bool {
        let queued = self.queued.fetch_add(1, Ordering::AcqRel);
        if queued < TAB_MUTATION_LANE_CAPACITY {
            true
        } else {
            self.queued.fetch_sub(1, Ordering::AcqRel);
            false
        }
    }

    fn finish_queued(&self) {
        self.queued.fetch_sub(1, Ordering::AcqRel);
    }
}

fn classify_active_tab_stop(
    active_operation_id: Option<&str>,
) -> Option<RuntimeTabMutationAcceptance> {
    let operation_id = active_operation_id?;
    Some(RuntimeTabMutationAcceptance::ExistingStop(
        operation_id.to_owned(),
    ))
}

fn resolve_tab_stop_window_id(
    presented_window_id: Option<String>,
    tombstone_window_id: Option<String>,
) -> Option<String> {
    presented_window_id.or(tombstone_window_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeTabMutationTerminalStatus {
    Applied,
    Superseded,
    Failed,
    Indeterminate,
}

impl RuntimeTabMutationTerminalStatus {
    fn native_status(self) -> NativeOperationStatus {
        match self {
            Self::Applied => NativeOperationStatus::Applied,
            Self::Superseded => NativeOperationStatus::Superseded,
            Self::Failed => NativeOperationStatus::Failed,
            Self::Indeterminate => NativeOperationStatus::Indeterminate,
        }
    }
}

pub(crate) struct RuntimeTabMutationOperation {
    accepted_deadline: Instant,
    lane: Arc<TabMutationLane>,
    queued: bool,
    pub(crate) request: RuntimeTabMutationRequestRecord,
}

pub(crate) enum RuntimeTabMutationAcceptance {
    Accepted(Box<RuntimeTabMutationOperation>),
    ExistingStop(String),
    Superseded,
}

impl Drop for RuntimeTabMutationOperation {
    fn drop(&mut self) {
        if self.queued {
            self.lane.finish_queued();
            if self.request.mutation_kind == "stop"
                && let Ok(mut active) = self.lane.stop_operation_id.lock()
                && active.as_deref() == Some(self.request.operation_id.as_str())
            {
                *active = None;
            }
        }
    }
}

pub(crate) struct RuntimeTabMutationLease {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    pub(crate) request: RuntimeTabMutationRequestRecord,
}

impl SystemRuntimeExecutor {
    fn tab_stop_window_id(&self, tab_id: &str) -> RuntimeResult<Option<String>> {
        let presented_window_id = self
            .presentation
            .tab_window(tab_id)
            .map_err(RuntimeError::tauri)?;
        let tombstone_window_id = self
            .state
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "TAB_MUTATION_COORDINATOR_UNAVAILABLE",
                    "The runtime tab close tombstone registry is unavailable.",
                )
            })
            .map(|state| {
                state
                    .close_previews
                    .get(tab_id)
                    .map(|tombstone| tombstone.window_id.clone())
            })?;
        Ok(resolve_tab_stop_window_id(
            presented_window_id,
            tombstone_window_id,
        ))
    }

    pub(crate) fn accept_tab_stop(
        &self,
        tab_id: &str,
        topology_revision: u64,
    ) -> RuntimeResult<RuntimeTabMutationAcceptance> {
        self.require_runtime_accepting()?;
        let lane = {
            let mut lanes = self.tab_mutations.lanes.lock().map_err(|_| {
                RuntimeError::new(
                    "TAB_MUTATION_COORDINATOR_UNAVAILABLE",
                    "The tab mutation coordinator is unavailable.",
                )
            })?;
            Arc::clone(
                lanes
                    .entry(tab_id.to_owned())
                    .or_insert_with(|| Arc::new(TabMutationLane::default())),
            )
        };
        let active_stop = lane
            .stop_operation_id
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "TAB_MUTATION_COORDINATOR_UNAVAILABLE",
                    "The tab mutation stop state is unavailable.",
                )
            })?
            .clone();
        if let Some(acceptance) = classify_active_tab_stop(active_stop.as_deref()) {
            return Ok(acceptance);
        }
        let Some(source_window_id) = self.tab_stop_window_id(tab_id)? else {
            return Ok(RuntimeTabMutationAcceptance::Superseded);
        };
        let source_snapshot = match self.tab_drag_window_snapshot(&source_window_id) {
            Ok(snapshot) => snapshot,
            Err(message) if message.contains("was not found") => {
                return Ok(RuntimeTabMutationAcceptance::Superseded);
            }
            Err(message) => return Err(RuntimeError::tauri(message)),
        };
        let context = NativeOperationContext::new(
            NativeOperationSubsystem::TabMutation,
            "tab-mutation-stop",
            TAB_MUTATION_OPERATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
        .with_tab(tab_id)
        .with_window(&source_window_id)
        .with_window_generation(source_snapshot.generation)
        .with_lifecycle_epoch(self.lifecycle_epoch())
        .with_topology_revision(topology_revision)
        .with_revision(self.presentation.current_revision());
        let mut active_stop = lane.stop_operation_id.lock().map_err(|_| {
            RuntimeError::new(
                "TAB_MUTATION_COORDINATOR_UNAVAILABLE",
                "The tab mutation stop state is unavailable.",
            )
        })?;
        if let Some(acceptance) = classify_active_tab_stop(active_stop.as_deref()) {
            return Ok(acceptance);
        }
        if !lane.try_enqueue() {
            return Err(RuntimeError::new(
                "TAB_MUTATION_QUEUE_FULL",
                "The runtime tab mutation queue is full.",
            ));
        }
        if let Err(code) = self.operations.register(context.clone()) {
            lane.finish_queued();
            return Err(RuntimeError::new(
                code,
                "The native tab mutation operation registry is full or unavailable.",
            ));
        }
        *active_stop = Some(context.operation_id.clone());
        drop(active_stop);
        let request = RuntimeTabMutationRequestRecord {
            operation_id: context.operation_id,
            mutation_kind: "stop".to_owned(),
            tab_id: tab_id.to_owned(),
            source_window_id,
            source_window_generation: source_snapshot.generation,
            lifecycle_epoch: self.lifecycle_epoch(),
        };
        Ok(RuntimeTabMutationAcceptance::Accepted(Box::new(
            RuntimeTabMutationOperation {
                accepted_deadline: Instant::now() + TAB_MUTATION_OPERATION_TIMEOUT,
                lane,
                queued: true,
                request,
            },
        )))
    }

    pub(crate) async fn await_tab_mutation_turn(
        &self,
        mut operation: RuntimeTabMutationOperation,
    ) -> Result<RuntimeTabMutationLease, SystemRuntimeOperationSummaryRecord> {
        let remaining = operation
            .accepted_deadline
            .saturating_duration_since(Instant::now());
        let guard = tokio::time::timeout(remaining, Arc::clone(&operation.lane.gate).lock_owned())
            .await;
        operation.lane.finish_queued();
        operation.queued = false;
        let Ok(guard) = guard else {
            let receipt =
                self.wait_or_fallback_tab_mutation_receipt(&operation.request.operation_id);
            self.clear_terminal_tab_stop(&receipt);
            return Err(receipt);
        };
        if let Some(receipt) = self.operations.terminal(&operation.request.operation_id) {
            let summary = receipt.summary();
            self.clear_terminal_tab_stop(&summary);
            return Err(summary);
        }
        if !self.tab_mutation_identity_is_current(&operation.request) {
            return Err(self.complete_tab_mutation(
                &operation.request.operation_id,
                "tabMutationIdentitySuperseded",
                RuntimeTabMutationTerminalStatus::Superseded,
                None,
                0,
            ));
        }
        if !self
            .operations
            .mark_in_flight(&operation.request.operation_id)
        {
            let receipt =
                self.wait_or_fallback_tab_mutation_receipt(&operation.request.operation_id);
            self.clear_terminal_tab_stop(&receipt);
            return Err(receipt);
        }
        Ok(RuntimeTabMutationLease {
            _guard: guard,
            request: operation.request.clone(),
        })
    }

    pub(crate) fn complete_tab_mutation(
        &self,
        operation_id: &str,
        stage: &'static str,
        status: RuntimeTabMutationTerminalStatus,
        failure_code: Option<&str>,
        rollback_error_count: usize,
    ) -> SystemRuntimeOperationSummaryRecord {
        if let Some(receipt) = self.operations.terminal(operation_id) {
            return receipt.summary();
        }
        let Some(context) = self.operations.context(operation_id) else {
            return tab_mutation_fallback_receipt();
        };
        let receipt = NativeOperationReceipt::with_status(
            context,
            stage,
            status.native_status(),
            failure_code,
        );
        let receipt = if rollback_error_count == 0 {
            receipt
        } else {
            receipt.with_rollback_error_count(rollback_error_count)
        };
        let summary = self.operations.complete(receipt).summary();
        // A terminal stop never owns the per-tab lane. Keeping an applied or
        // quarantined operation here permanently turns every later activation or
        // relaunch into `The runtime tab is closing`.
        self.clear_terminal_tab_stop(&summary);
        summary
    }

    pub(crate) fn superseded_tab_mutation_summary(
        &self,
        mutation_kind: &str,
        tab_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        let trigger = match mutation_kind {
            "move" => "tab-mutation-move-stale",
            "moveToNewWindow" => "tab-mutation-move-to-new-window-stale",
            "hide" => "tab-mutation-hide-stale",
            "reorder" => "tab-mutation-reorder-stale",
            "stop" => "tab-mutation-stop-stale",
            _ => "tab-mutation-stale",
        };
        NativeOperationReceipt::with_status(
            NativeOperationContext::new(
                NativeOperationSubsystem::TabMutation,
                trigger,
                Duration::ZERO,
            )
            .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
            .with_lifecycle_epoch(self.lifecycle_epoch())
            .with_revision(self.presentation.current_revision())
            .with_tab(tab_id),
            "tabMutationSuperseded",
            NativeOperationStatus::Superseded,
            None,
        )
        .summary()
    }

    pub(crate) fn live_tab_mutation_summary(
        &self,
        mutation_kind: &str,
        tab_id: &str,
        status: RuntimeTabMutationTerminalStatus,
        failure_code: Option<&str>,
    ) -> SystemRuntimeOperationSummaryRecord {
        NativeOperationReceipt::with_status(
            NativeOperationContext::new(
                NativeOperationSubsystem::TabMutation,
                match mutation_kind {
                    "move" => "tab-mutation-move-live",
                    "moveToNewWindow" => "tab-mutation-move-to-new-window-live",
                    "hide" => "tab-mutation-hide-live",
                    "reorder" => "tab-mutation-reorder-live",
                    _ => "tab-mutation-live",
                },
                Duration::ZERO,
            )
            .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
            .with_lifecycle_epoch(self.lifecycle_epoch())
            .with_revision(self.presentation.current_revision())
            .with_tab(tab_id),
            match status {
                RuntimeTabMutationTerminalStatus::Applied => "tabMutationLiveCommitted",
                RuntimeTabMutationTerminalStatus::Superseded => "tabMutationLiveSuperseded",
                RuntimeTabMutationTerminalStatus::Failed => "tabMutationLiveCommitRejected",
                RuntimeTabMutationTerminalStatus::Indeterminate => {
                    "tabMutationLiveCommitIndeterminate"
                }
            },
            status.native_status(),
            failure_code,
        )
        .summary()
    }

    fn wait_or_fallback_tab_mutation_receipt(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.operations
            .wait(operation_id)
            .map(|receipt| receipt.summary())
            .unwrap_or_else(|_| tab_mutation_fallback_receipt())
    }

    pub(crate) fn wait_tab_mutation_receipt(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.wait_or_fallback_tab_mutation_receipt(operation_id)
    }

    fn tab_mutation_identity_is_current(&self, request: &RuntimeTabMutationRequestRecord) -> bool {
        if !self.application_lifecycle_epoch_matches(request.lifecycle_epoch)
            || self
                .tab_stop_window_id(&request.tab_id)
                .ok()
                .flatten()
                .as_deref()
                != Some(request.source_window_id.as_str())
            || !self.tab_drag_window_generation_matches(
                &request.source_window_id,
                request.source_window_generation,
            )
        {
            return false;
        }
        true
    }

    fn clear_terminal_tab_stop(&self, summary: &SystemRuntimeOperationSummaryRecord) {
        let Some(tab_id) = summary.tab_id.as_deref() else {
            return;
        };
        let lane = self
            .tab_mutations
            .lanes
            .lock()
            .ok()
            .and_then(|lanes| lanes.get(tab_id).cloned());
        if let Some(lane) = lane
            && let Ok(mut active) = lane.stop_operation_id.lock()
            && active.as_deref() == Some(summary.operation_id.as_str())
        {
            *active = None;
        }
    }

    pub(crate) fn tab_surface_release_confirmed(&self, tab_id: &str) -> bool {
        self.state.lock().is_ok_and(|state| {
            state
                .surface_registry
                .values()
                .chain(state.retired_surface_registry.values())
                .all(|surface| surface.tab_id.as_deref() != Some(tab_id))
        })
    }

}

fn tab_mutation_fallback_receipt() -> SystemRuntimeOperationSummaryRecord {
    NativeOperationReceipt::with_status(
        NativeOperationContext::new(
            NativeOperationSubsystem::TabMutation,
            "tab-mutation-receipt-fallback",
            Duration::ZERO,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit),
        "tabMutationReceiptUnavailable",
        NativeOperationStatus::Indeterminate,
        Some("TAB_MUTATION_RESULT_UNKNOWN"),
    )
    .summary()
}
