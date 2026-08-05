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
    mutation_kind: &str,
) -> Option<RuntimeTabMutationAcceptance> {
    let operation_id = active_operation_id?;
    if mutation_kind == "stop" {
        return Some(RuntimeTabMutationAcceptance::ExistingStop(
            operation_id.to_owned(),
        ));
    }
    // The close gesture already removed this tab from the live topology. Any
    // queued reorder/hide/move callback belongs to the older UI revision and is
    // therefore a harmless no-op, not a user-visible lifecycle failure.
    Some(RuntimeTabMutationAcceptance::Superseded)
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
    pub(crate) before_tab_id: Option<String>,
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
    pub(crate) before_tab_id: Option<String>,
    pub(crate) request: RuntimeTabMutationRequestRecord,
}

impl SystemRuntimeExecutor {
    pub(crate) fn accept_tab_mutation(
        &self,
        mutation_kind: &str,
        tab_id: &str,
        target_window_id: Option<&str>,
        before_tab_id: Option<&str>,
        topology_revision: u64,
    ) -> RuntimeResult<RuntimeTabMutationAcceptance> {
        self.require_runtime_accepting()?;
        if !matches!(
            mutation_kind,
            "move" | "moveToNewWindow" | "hide" | "reorder" | "stop"
        ) {
            return Err(RuntimeError::new(
                "TAB_MUTATION_KIND_INVALID",
                "The tab mutation kind is invalid.",
            ));
        }
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
        if let Some(acceptance) = classify_active_tab_stop(active_stop.as_deref(), mutation_kind) {
            return Ok(acceptance);
        }
        let Some(source_window_id) = self
            .presentation
            .tab_window(tab_id)
            .map_err(RuntimeError::tauri)?
        else {
            return Ok(RuntimeTabMutationAcceptance::Superseded);
        };
        let source_snapshot = match self.tab_drag_window_snapshot(&source_window_id) {
            Ok(snapshot) => snapshot,
            Err(message) if message.contains("was not found") => {
                return Ok(RuntimeTabMutationAcceptance::Superseded);
            }
            Err(message) => return Err(RuntimeError::tauri(message)),
        };
        let target_snapshot = target_window_id
            .filter(|window_id| *window_id != source_window_id)
            .and_then(|window_id| self.tab_drag_window_snapshot(window_id).ok());
        let target_window_generation = target_snapshot.as_ref().map(|target| target.generation);
        let (expected_tab_order, expected_active_tab_id, reorder_target_index) =
            expected_tab_mutation_projection(
                mutation_kind,
                tab_id,
                &source_snapshot,
                target_snapshot.as_ref(),
                before_tab_id,
            );
        let trigger = match mutation_kind {
            "move" => "tab-mutation-move",
            "moveToNewWindow" => "tab-mutation-move-to-new-window",
            "hide" => "tab-mutation-hide",
            "reorder" => "tab-mutation-reorder",
            "stop" => "tab-mutation-stop",
            _ => unreachable!(),
        };
        let context = NativeOperationContext::new(
            NativeOperationSubsystem::TabMutation,
            trigger,
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
        if let Some(acceptance) = classify_active_tab_stop(active_stop.as_deref(), mutation_kind) {
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
        if mutation_kind == "stop" {
            *active_stop = Some(context.operation_id.clone());
        }
        drop(active_stop);
        let request = RuntimeTabMutationRequestRecord {
            operation_id: context.operation_id,
            mutation_kind: mutation_kind.to_owned(),
            tab_id: tab_id.to_owned(),
            source_window_id,
            source_window_generation: source_snapshot.generation,
            target_window_id: target_window_id.map(str::to_owned),
            target_window_generation,
            lifecycle_epoch: self.lifecycle_epoch(),
            topology_revision,
            presentation_revision: self.presentation.current_revision(),
            reorder_target_index,
            expected_tab_order,
            expected_active_tab_id,
        };
        Ok(RuntimeTabMutationAcceptance::Accepted(Box::new(
            RuntimeTabMutationOperation {
                accepted_deadline: Instant::now() + TAB_MUTATION_OPERATION_TIMEOUT,
                before_tab_id: before_tab_id.map(str::to_owned),
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
            before_tab_id: operation.before_tab_id.clone(),
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
                .presentation
                .tab_window(&request.tab_id)
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
        match (
            request.target_window_id.as_deref(),
            request.target_window_generation,
        ) {
            (Some(window_id), Some(generation)) => {
                self.tab_drag_window_generation_matches(window_id, generation)
            }
            _ => true,
        }
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

fn expected_tab_mutation_projection(
    mutation_kind: &str,
    tab_id: &str,
    source: &RuntimeTabDragWindowSnapshot,
    target: Option<&RuntimeTabDragWindowSnapshot>,
    before_tab_id: Option<&str>,
) -> (Vec<String>, Option<String>, Option<u64>) {
    let mut order = if matches!(mutation_kind, "move" | "moveToNewWindow") {
        target.map(|target| target.tab_ids.clone()).unwrap_or_default()
    } else {
        source.tab_ids.clone()
    };
    order.retain(|candidate| candidate != tab_id);
    let insertion = before_tab_id
        .and_then(|before| order.iter().position(|candidate| candidate == before))
        .unwrap_or(order.len());
    if !matches!(mutation_kind, "hide" | "stop") {
        order.insert(insertion, tab_id.to_owned());
    }
    let active = match mutation_kind {
        "move" | "moveToNewWindow" => Some(tab_id.to_owned()),
        "stop" if source.active_tab_id.as_deref() == Some(tab_id) => {
            successor_tab_after_close(&source.tab_ids, tab_id, |_| true)
        }
        "hide" if source.active_tab_id.as_deref() == Some(tab_id) => {
            order.first().cloned()
        }
        _ => source.active_tab_id.clone(),
    };
    (order, active, before_tab_id.map(|_| insertion as u64))
}
