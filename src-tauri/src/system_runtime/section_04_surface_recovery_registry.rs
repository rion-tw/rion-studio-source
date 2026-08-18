const ACTIVE_SURFACE_RECOVERY_CAPACITY: usize = 32;
const RECENT_SURFACE_RECOVERY_CAPACITY: usize = 40;
static SURFACE_RECOVERY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
struct VerifiedProcessTermination {
    reason: String,
}

impl VerifiedProcessTermination {
    fn authoritative(reason: String) -> Self {
        Self { reason }
    }
}

#[derive(Clone, Debug)]
struct SurfaceRecoveryTransaction {
    context: NativeOperationContext,
    role_id: String,
    surface_generation: u64,
    termination: VerifiedProcessTermination,
    window_id: String,
}

#[derive(Default)]
struct SurfaceRecoveryRegistryState {
    active_count: usize,
    by_operation: HashMap<String, SurfaceRecoveryAttemptRecord>,
    by_surface: HashMap<(String, u64), String>,
    cancelled_operations: HashSet<String>,
    navigation_by_operation: HashMap<String, Weak<NavigationTracker>>,
    terminal_order: VecDeque<String>,
}

#[derive(Default)]
struct SurfaceRecoveryRegistry {
    state: Mutex<SurfaceRecoveryRegistryState>,
}

enum SurfaceRecoveryBegin {
    Existing(SurfaceRecoveryAttemptRecord),
    Full,
    Started(Box<SurfaceRecoveryTransaction>, SurfaceRecoveryAttemptRecord),
}

impl SurfaceRecoveryRegistry {
    fn begin(
        &self,
        context: NativeOperationContext,
        role_id: String,
        window_id: String,
        surface_generation: u64,
        lifecycle_epoch: u64,
        termination: VerifiedProcessTermination,
    ) -> SurfaceRecoveryBegin {
        let Ok(mut state) = self.state.lock() else {
            return SurfaceRecoveryBegin::Full;
        };
        let key = (role_id.clone(), surface_generation);
        if let Some(operation_id) = state.by_surface.get(&key)
            && let Some(record) = state.by_operation.get(operation_id)
        {
            return SurfaceRecoveryBegin::Existing(record.clone());
        }
        if state.active_count >= ACTIVE_SURFACE_RECOVERY_CAPACITY {
            return SurfaceRecoveryBegin::Full;
        }
        let sequence = SURFACE_RECOVERY_SEQUENCE.fetch_add(1, Ordering::AcqRel);
        let attempt_id = format!("surface-recovery-{sequence}");
        let record = SurfaceRecoveryAttemptRecord {
            attempt_id: attempt_id.clone(),
            operation_id: context.operation_id.clone(),
            parent_operation_id: context.parent_operation_id.clone(),
            role_id: role_id.clone(),
            window_id: window_id.clone(),
            surface_generation,
            lifecycle_epoch,
            phase: "fencing".to_owned(),
            status: "active".to_owned(),
            started_at: context.accepted_at.clone(),
            updated_at: context.accepted_at.clone(),
            failure_code: None,
        };
        let transaction = SurfaceRecoveryTransaction {
            context,
            role_id,
            surface_generation,
            termination,
            window_id,
        };
        state.active_count = state.active_count.saturating_add(1);
        state
            .by_surface
            .insert(key, transaction.context.operation_id.clone());
        state.by_operation.insert(
            transaction.context.operation_id.clone(),
            record.clone(),
        );
        SurfaceRecoveryBegin::Started(Box::new(transaction), record)
    }

    fn existing(&self, role_id: &str, generation: u64) -> Option<SurfaceRecoveryAttemptRecord> {
        let state = self.state.lock().ok()?;
        let operation_id = state
            .by_surface
            .get(&(role_id.to_owned(), generation))?;
        state.by_operation.get(operation_id).cloned()
    }

    fn release_terminal_key_for_retry(&self, role_id: &str, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let key = (role_id.to_owned(), generation);
        let Some(operation_id) = state.by_surface.get(&key).cloned() else {
            return;
        };
        if state
            .by_operation
            .get(&operation_id)
            .is_some_and(|record| record.status != "active")
        {
            state.by_surface.remove(&key);
        }
    }

    fn update_phase(
        &self,
        operation_id: &str,
        phase: &'static str,
    ) -> Option<SurfaceRecoveryAttemptRecord> {
        let mut state = self.state.lock().ok()?;
        let record = state.by_operation.get_mut(operation_id)?;
        if record.status != "active" {
            return Some(record.clone());
        }
        record.phase = phase.to_owned();
        record.updated_at = chrono::Utc::now().to_rfc3339();
        Some(record.clone())
    }

    fn attach_navigation(
        &self,
        operation_id: &str,
        navigation: &Arc<NavigationTracker>,
    ) -> bool {
        let cancelled = self.state.lock().ok().is_some_and(|mut state| {
            let Some(record) = state.by_operation.get(operation_id) else {
                return false;
            };
            if record.status != "active" {
                return false;
            }
            let cancelled = state.cancelled_operations.contains(operation_id);
            state
                .navigation_by_operation
                .insert(operation_id.to_owned(), Arc::downgrade(navigation));
            cancelled
        });
        if cancelled {
            navigation.cancel_for_owner_close();
        }
        cancelled
    }

    fn cancel_active_for_role(&self, role_id: &str) -> usize {
        let navigations = self
            .state
            .lock()
            .ok()
            .map(|mut state| {
                let operation_ids = state
                    .by_operation
                    .iter()
                    .filter(|(_, record)| record.role_id == role_id && record.status == "active")
                    .map(|(operation_id, _)| operation_id.clone())
                    .collect::<Vec<_>>();
                let mut navigations = Vec::new();
                for operation_id in operation_ids {
                    state.cancelled_operations.insert(operation_id.clone());
                    if let Some(navigation) = state
                        .navigation_by_operation
                        .get(&operation_id)
                        .and_then(Weak::upgrade)
                    {
                        navigations.push(navigation);
                    }
                }
                navigations
            })
            .unwrap_or_default();
        for navigation in &navigations {
            navigation.cancel_for_owner_close();
        }
        navigations.len()
    }

    fn operation_was_cancelled(&self, operation_id: &str) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| state.cancelled_operations.contains(operation_id))
    }

    fn complete(
        &self,
        operation_id: &str,
        phase: &'static str,
        status: &'static str,
        failure_code: Option<String>,
    ) -> Option<SurfaceRecoveryAttemptRecord> {
        let mut state = self.state.lock().ok()?;
        let existing = state.by_operation.get(operation_id)?;
        if existing.status != "active" {
            return Some(existing.clone());
        }
        let record = state.by_operation.get_mut(operation_id)?;
        record.phase = phase.to_owned();
        record.status = status.to_owned();
        record.failure_code = failure_code;
        record.updated_at = chrono::Utc::now().to_rfc3339();
        let completed = record.clone();
        state.navigation_by_operation.remove(operation_id);
        state.active_count = state.active_count.saturating_sub(1);
        while state.terminal_order.len() >= RECENT_SURFACE_RECOVERY_CAPACITY {
            if let Some(expired_operation_id) = state.terminal_order.pop_front()
                && let Some(expired) = state.by_operation.remove(&expired_operation_id)
            {
                state.cancelled_operations.remove(&expired_operation_id);
                state.navigation_by_operation.remove(&expired_operation_id);
                let key = (expired.role_id, expired.surface_generation);
                if state.by_surface.get(&key) == Some(&expired_operation_id) {
                    state.by_surface.remove(&key);
                }
            }
        }
        state.terminal_order.push_back(operation_id.to_owned());
        Some(completed)
    }
}

impl SystemRuntimeExecutor {
    fn emit_surface_recovery_attempt(&self, record: &SurfaceRecoveryAttemptRecord) {
        let _ = self.app.emit("rion://surface-recovery-attempt", record.clone());
    }

    fn update_surface_recovery_phase(
        &self,
        transaction: &SurfaceRecoveryTransaction,
        phase: &'static str,
    ) {
        if let Some(record) = self
            .surface_recoveries
            .update_phase(&transaction.context.operation_id, phase)
        {
            self.emit_surface_recovery_attempt(&record);
        }
    }

    fn complete_surface_recovery(
        &self,
        transaction: SurfaceRecoveryTransaction,
        stage: &'static str,
        native_status: NativeOperationStatus,
        failure_code: Option<&str>,
        restart_required: bool,
    ) -> NativeOperationReceipt {
        if restart_required
            && let Ok(mut state) = self.state.lock()
        {
            state.runtime_restart_required = true;
        }
        let role_id = transaction.role_id.clone();
        let receipt = self.operations.complete(NativeOperationReceipt::with_status(
            transaction.context,
            stage,
            native_status,
            failure_code,
        ));
        let attempt_status = if restart_required {
            "restartRequired"
        } else {
            match receipt.status {
                NativeOperationStatus::Applied => "applied",
                NativeOperationStatus::Degraded => "degraded",
                NativeOperationStatus::Indeterminate => "indeterminate",
                NativeOperationStatus::Superseded
                | NativeOperationStatus::Cancelled
                | NativeOperationStatus::Failed => "failed",
            }
        };
        let phase = if matches!(receipt.status, NativeOperationStatus::Applied | NativeOperationStatus::Degraded) {
            "completed"
        } else {
            "blocked"
        };
        if let Some(record) = self.surface_recoveries.complete(
            &receipt.context.operation_id,
            phase,
            attempt_status,
            receipt.failure_code.clone(),
        ) {
            self.emit_surface_recovery_attempt(&record);
        }
        self.finish_macro_input_recovery_after_surface(&role_id, &receipt);
        receipt
    }

    fn retry_surface_recovery_after_lifecycle(
        self: &Arc<Self>,
        transaction: SurfaceRecoveryTransaction,
        stage: &'static str,
    ) {
        let role_id = transaction.role_id.clone();
        let generation = transaction.surface_generation;
        let parent_operation_id = transaction.context.parent_operation_id.clone();
        let termination = transaction.termination.clone();
        if let Ok(mut state) = self.state.lock() {
            state.recovering_roles.remove(&role_id);
        }
        self.complete_surface_recovery(
            transaction,
            stage,
            NativeOperationStatus::Failed,
            Some("SYSTEM_LIFECYCLE_STALE"),
            false,
        );
        self.schedule_terminated_surface_recovery_internal(
            role_id,
            termination,
            generation,
            parent_operation_id,
            true,
        );
    }
}

fn surface_recovery_requires_restart(destructive_started: bool) -> bool {
    destructive_started
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SurfaceRecoveryFailureOutcome {
    native_status: NativeOperationStatus,
    restart_required: bool,
    stage: &'static str,
}

fn surface_recovery_failure_outcome(
    error_code: &str,
    destructive_started: bool,
    owner_closed: bool,
) -> SurfaceRecoveryFailureOutcome {
    if owner_closed {
        return SurfaceRecoveryFailureOutcome {
            native_status: NativeOperationStatus::Cancelled,
            restart_required: false,
            stage: "surfaceRecoveryCancelled",
        };
    }
    let restart_required = surface_recovery_requires_restart(destructive_started);
    SurfaceRecoveryFailureOutcome {
        native_status: if restart_required {
            NativeOperationStatus::Indeterminate
        } else if error_code == "SYSTEM_SURFACE_RECOVERY_STALE" {
            NativeOperationStatus::Superseded
        } else {
            NativeOperationStatus::Failed
        },
        restart_required,
        stage: if restart_required {
            "surfaceRecoveryIndeterminate"
        } else {
            "surfaceRecoveryFailed"
        },
    }
}

fn surface_recovery_target_is_current(
    active_window_id: &str,
    expected_window_id: &str,
    active_generation: u64,
    expected_generation: u64,
) -> bool {
    active_window_id == expected_window_id && active_generation == expected_generation
}
