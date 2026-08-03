#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeOperationPhase {
    Queued,
    InFlight,
}

#[derive(Clone)]
struct ActiveNativeOperation {
    context: NativeOperationContext,
    phase: NativeOperationPhase,
}

#[derive(Default)]
struct NativeOperationRegistryState {
    active: HashMap<String, ActiveNativeOperation>,
    terminal: HashMap<String, NativeOperationReceipt>,
    terminal_order: VecDeque<String>,
}

#[derive(Default)]
struct NativeOperationRegistry {
    state: Mutex<NativeOperationRegistryState>,
    changed: Condvar,
}

impl NativeOperationRegistry {
    fn start_deadline_worker(registry: &Arc<Self>) -> Result<(), String> {
        let registry = Arc::downgrade(registry);
        thread::Builder::new()
            .name("rion-native-operation-deadlines".to_owned())
            .spawn(move || {
                loop {
                    let Some(registry) = registry.upgrade() else {
                        return;
                    };
                    registry.expire_due_operations();
                    drop(registry);
                    thread::sleep(Duration::from_millis(25));
                }
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn register(&self, context: NativeOperationContext) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE")?;
        if state.active.contains_key(&context.operation_id)
            || state.terminal.contains_key(&context.operation_id)
        {
            return Err("SYSTEM_NATIVE_OPERATION_ID_CONFLICT");
        }
        if state.active.len() >= ACTIVE_NATIVE_OPERATION_CAPACITY {
            return Err("SYSTEM_NATIVE_OPERATION_REGISTRY_FULL");
        }
        state.active.insert(
            context.operation_id.clone(),
            ActiveNativeOperation {
                context,
                phase: NativeOperationPhase::Queued,
            },
        );
        Ok(())
    }

    fn mark_in_flight(&self, operation_id: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(operation) = state.active.get_mut(operation_id) else {
            return false;
        };
        operation.phase = NativeOperationPhase::InFlight;
        true
    }

    fn complete(&self, receipt: NativeOperationReceipt) -> NativeOperationReceipt {
        let Ok(mut state) = self.state.lock() else {
            return receipt;
        };
        if let Some(existing) = state.terminal.get(&receipt.context.operation_id) {
            return existing.clone();
        }
        if !state.active.contains_key(&receipt.context.operation_id) {
            return receipt;
        }
        if let Some(operation) = state.active.get(&receipt.context.operation_id).cloned()
            && operation.context.deadline <= Instant::now()
        {
            let timeout_receipt = match operation.phase {
                NativeOperationPhase::Queued => NativeOperationReceipt::with_status(
                    operation.context,
                    "nativeOperationQueuedTimeout",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_OPERATION_DEADLINE_EXCEEDED"),
                ),
                NativeOperationPhase::InFlight => NativeOperationReceipt::with_status(
                    operation.context,
                    "nativeOperationInFlightTimeout",
                    NativeOperationStatus::Indeterminate,
                    Some("NATIVE_OPERATION_INDETERMINATE"),
                ),
            };
            state.active.remove(&receipt.context.operation_id);
            Self::insert_terminal(&mut state, timeout_receipt.clone());
            self.changed.notify_all();
            return timeout_receipt;
        }
        state.active.remove(&receipt.context.operation_id);
        Self::insert_terminal(&mut state, receipt.clone());
        self.changed.notify_all();
        receipt
    }

    fn record_untracked(&self, receipt: NativeOperationReceipt) -> NativeOperationReceipt {
        let Ok(mut state) = self.state.lock() else {
            return receipt;
        };
        if let Some(existing) = state.terminal.get(&receipt.context.operation_id) {
            return existing.clone();
        }
        if state.active.contains_key(&receipt.context.operation_id) {
            drop(state);
            return self.complete(receipt);
        }
        Self::insert_terminal(&mut state, receipt.clone());
        self.changed.notify_all();
        receipt
    }

    fn wait(&self, operation_id: &str) -> Result<NativeOperationReceipt, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE")?;
        loop {
            if let Some(receipt) = state.terminal.get(operation_id) {
                return Ok(receipt.clone());
            }
            let Some(operation) = state.active.get(operation_id).cloned() else {
                return Err("SYSTEM_NATIVE_OPERATION_NOT_FOUND");
            };
            let remaining = operation
                .context
                .deadline
                .saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let receipt = match operation.phase {
                    NativeOperationPhase::Queued => NativeOperationReceipt::with_status(
                        operation.context,
                        "nativeOperationQueuedTimeout",
                        NativeOperationStatus::Failed,
                        Some("NATIVE_OPERATION_DEADLINE_EXCEEDED"),
                    ),
                    NativeOperationPhase::InFlight => NativeOperationReceipt::with_status(
                        operation.context,
                        "nativeOperationInFlightTimeout",
                        NativeOperationStatus::Indeterminate,
                        Some("NATIVE_OPERATION_INDETERMINATE"),
                    ),
                };
                state.active.remove(operation_id);
                Self::insert_terminal(&mut state, receipt.clone());
                self.changed.notify_all();
                return Ok(receipt);
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| "SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE")?;
            state = next;
        }
    }

    fn fail_active(
        &self,
        operation_id: &str,
        stage: &'static str,
        failure_code: &'static str,
    ) -> Result<NativeOperationReceipt, &'static str> {
        let context = {
            let state = self
                .state
                .lock()
                .map_err(|_| "SYSTEM_NATIVE_OPERATION_REGISTRY_UNAVAILABLE")?;
            if let Some(receipt) = state.terminal.get(operation_id) {
                return Ok(receipt.clone());
            }
            state
                .active
                .get(operation_id)
                .map(|operation| operation.context.clone())
                .ok_or("SYSTEM_NATIVE_OPERATION_NOT_FOUND")?
        };
        Ok(self.complete(NativeOperationReceipt::with_status(
            context,
            stage,
            NativeOperationStatus::Failed,
            Some(failure_code),
        )))
    }

    fn recent_summaries(&self) -> Vec<SystemRuntimeOperationSummaryRecord> {
        self.expire_due_operations();
        let Ok(state) = self.state.lock() else {
            return Vec::new();
        };
        state
            .terminal_order
            .iter()
            .rev()
            .filter_map(|operation_id| state.terminal.get(operation_id))
            .map(NativeOperationReceipt::summary)
            .collect()
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.active.len())
            .unwrap_or_default()
    }

    fn insert_terminal(state: &mut NativeOperationRegistryState, receipt: NativeOperationReceipt) {
        let operation_id = receipt.context.operation_id.clone();
        while state.terminal_order.len() >= RECENT_NATIVE_OPERATION_CAPACITY {
            let eviction_index = state
                .terminal_order
                .iter()
                .position(|candidate| {
                    state.terminal.get(candidate).is_none_or(|receipt| {
                        receipt.context.subsystem != NativeOperationSubsystem::Shutdown
                    })
                })
                .unwrap_or(0);
            if let Some(expired) = state.terminal_order.remove(eviction_index) {
                state.terminal.remove(&expired);
            }
        }
        state.terminal_order.push_back(operation_id.clone());
        state.terminal.insert(operation_id, receipt);
    }

    fn expire_due_operations(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let now = Instant::now();
        let expired = state
            .active
            .iter()
            .filter(|(_, operation)| operation.context.deadline <= now)
            .map(|(operation_id, operation)| (operation_id.clone(), operation.clone()))
            .collect::<Vec<_>>();
        let expired_any = !expired.is_empty();
        for (operation_id, operation) in expired {
            state.active.remove(&operation_id);
            let receipt = match operation.phase {
                NativeOperationPhase::Queued => NativeOperationReceipt::with_status(
                    operation.context,
                    "nativeOperationQueuedTimeout",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_OPERATION_DEADLINE_EXCEEDED"),
                ),
                NativeOperationPhase::InFlight => NativeOperationReceipt::with_status(
                    operation.context,
                    "nativeOperationInFlightTimeout",
                    NativeOperationStatus::Indeterminate,
                    Some("NATIVE_OPERATION_INDETERMINATE"),
                ),
            };
            Self::insert_terminal(&mut state, receipt);
        }
        if expired_any {
            self.changed.notify_all();
        }
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn wait_native_operation_summary(
        &self,
        operation_id: &str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.operations
            .wait(operation_id)
            .map(|receipt| receipt.summary())
            .map_err(str::to_owned)
    }

    pub(crate) fn fail_native_operation_summary(
        &self,
        operation_id: &str,
        stage: &'static str,
        failure_code: &'static str,
    ) -> Result<SystemRuntimeOperationSummaryRecord, String> {
        self.operations
            .fail_active(operation_id, stage, failure_code)
            .map(|receipt| receipt.summary())
            .map_err(str::to_owned)
    }
}
