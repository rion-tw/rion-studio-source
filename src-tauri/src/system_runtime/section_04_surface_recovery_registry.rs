const ACTIVE_SURFACE_RECOVERY_CAPACITY: usize = 32;
const RECENT_SURFACE_RECOVERY_CAPACITY: usize = 40;
static SURFACE_RECOVERY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
struct SurfaceRecoveryTransaction {
    context: NativeOperationContext,
    role_id: String,
    surface_generation: u64,
    window_id: String,
}

#[derive(Default)]
struct SurfaceRecoveryRegistryState {
    active_count: usize,
    by_operation: HashMap<String, SurfaceRecoveryAttemptRecord>,
    by_surface: HashMap<(String, u64), String>,
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
        state.active_count = state.active_count.saturating_sub(1);
        while state.terminal_order.len() >= RECENT_SURFACE_RECOVERY_CAPACITY {
            if let Some(expired_operation_id) = state.terminal_order.pop_front()
                && let Some(expired) = state.by_operation.remove(&expired_operation_id)
            {
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
        receipt
    }
}

fn surface_recovery_requires_restart(destructive_started: bool) -> bool {
    destructive_started
}

fn surface_recovery_target_is_current(
    active_window_id: &str,
    expected_window_id: &str,
    active_generation: u64,
    expected_generation: u64,
) -> bool {
    active_window_id == expected_window_id && active_generation == expected_generation
}
