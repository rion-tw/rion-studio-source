impl SystemRuntimeExecutor {
    fn schedule_surface_recovery(
        self: &Arc<Self>,
        role_id: String,
        reason: String,
        generation: u64,
    ) -> bool {
        self.schedule_surface_recovery_with_parent(role_id, reason, generation, None)
    }

    fn schedule_surface_recovery_with_parent(
        self: &Arc<Self>,
        role_id: String,
        reason: String,
        generation: u64,
        parent_operation_id: Option<String>,
    ) -> bool {
        self.schedule_surface_recovery_internal(
            role_id,
            reason,
            generation,
            parent_operation_id,
            false,
        )
    }

    fn schedule_surface_recovery_internal(
        self: &Arc<Self>,
        role_id: String,
        reason: String,
        generation: u64,
        parent_operation_id: Option<String>,
        retry_terminal: bool,
    ) -> bool {
        if !self.health.is_healthy() {
            return false;
        }
        if !self.application_lifecycle.accepts_native_work() {
            return self.application_lifecycle.defer_surface_recovery(
                role_id,
                reason,
                generation,
                parent_operation_id,
                retry_terminal,
            );
        }
        if retry_terminal {
            self.surface_recoveries
                .release_terminal_key_for_retry(&role_id, generation);
        }
        let claim = {
            let Ok(mut state) = self.state.lock() else {
                return false;
            };
            if state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id)
            {
                return false;
            }
            let Some(tab_id) = state.role_tabs.get(&role_id).cloned() else {
                return false;
            };
            let Some((surface_generation, window_id)) = state.tabs.get(&tab_id).and_then(|tab| {
                tab.roles
                    .get(&role_id)
                    .map(|surface| (surface.generation, tab.window_id.clone()))
            })
            else {
                return false;
            };
            if !surface_generation_is_current(surface_generation, generation) {
                return false;
            }
            if let Some(record) = self.surface_recoveries.existing(&role_id, generation) {
                drop(state);
                self.emit_surface_recovery_attempt(&record);
                return true;
            }
            if !claim_surface_recovery(
                surface_generation,
                generation,
                &mut state.recovering_roles,
                &role_id,
            ) {
                return false;
            }
            let now = Instant::now();
            let budget = state
                .recovery_budgets
                .entry(role_id.clone())
                .or_insert(RecoveryBudget {
                    attempts: 0,
                    window_started: now,
                });
            (window_id, budget.claim(now))
        };
        let (window_id, allowed) = claim;
        let mut context = NativeOperationContext::new(
            NativeOperationSubsystem::Recovery,
            "surfaceProcessFailure",
            SURFACE_RECOVERY_OPERATION_TIMEOUT,
        )
        .with_role(role_id.clone())
        .with_window(window_id.clone())
        .with_surface_generation(generation)
        .with_lifecycle_epoch(self.lifecycle_epoch());
        if let Some(parent_operation_id) = parent_operation_id {
            context = context.with_parent_operation_id(parent_operation_id);
        }
        if let Err(failure_code) = self.operations.register(context.clone()) {
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.emit_runtime_shell_error(
                failure_code,
                "System WebView recovery could not reserve an operation receipt.".to_owned(),
                &window_id,
            );
            return false;
        }
        let (transaction, initial_record) = match self.surface_recoveries.begin(
            context.clone(),
            role_id.clone(),
            window_id.clone(),
            generation,
            context.lifecycle_epoch.unwrap_or_default(),
        ) {
            SurfaceRecoveryBegin::Started(transaction, record) => (transaction, record),
            SurfaceRecoveryBegin::Existing(record) => {
                self.operations.complete(NativeOperationReceipt::with_status(
                    context,
                    "surfaceRecoveryDuplicate",
                    NativeOperationStatus::Superseded,
                    None,
                ));
                if let Ok(mut state) = self.state.lock() {
                    state.recovering_roles.remove(&role_id);
                }
                self.emit_surface_recovery_attempt(&record);
                return true;
            }
            SurfaceRecoveryBegin::Full => {
                self.operations.complete(NativeOperationReceipt::with_status(
                    context,
                    "surfaceRecoveryRegistryFull",
                    NativeOperationStatus::Failed,
                    Some("SYSTEM_SURFACE_RECOVERY_REGISTRY_FULL"),
                ));
                if let Ok(mut state) = self.state.lock() {
                    state.recovering_roles.remove(&role_id);
                }
                self.emit_runtime_shell_error(
                    "SYSTEM_SURFACE_RECOVERY_REGISTRY_FULL",
                    "The System WebView recovery registry is full. Restart Rion Studio to recover safely."
                        .to_owned(),
                    &window_id,
                );
                return false;
            }
        };
        self.emit_surface_recovery_attempt(&initial_record);
        let queued = self.effect_sender.get().ok_or(()).and_then(|sender| {
            sender
                .send(SystemRuntimeWork::RecoverSurface {
                    allowed,
                    reason: reason.clone(),
                    transaction: transaction.clone(),
                })
                .map_err(|_| ())
        });
        if queued.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                *transaction,
                "surfaceRecoveryQueueUnavailable",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RECOVERY_QUEUE_UNAVAILABLE"),
                true,
            );
            let _ = self.app.emit(
                "rion://shell-error",
                json!({
                    "code": "SYSTEM_SURFACE_RECOVERY_QUEUE_UNAVAILABLE",
                    "message": "The System WebView recovery queue is unavailable. Restart Rion Studio to recover safely.",
                    "roleId": role_id,
                    "reason": reason
                }),
            );
            false
        } else {
            true
        }
    }
}
