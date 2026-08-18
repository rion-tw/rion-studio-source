impl AppCore {
    pub fn macro_input_diagnostics(&self) -> CoreResult<MacroInputDiagnosticsRecord> {
        self.macro_runtime.input_diagnostics()
    }

    pub fn role_ownership_transfer_active(&self, role_id: &str) -> CoreResult<bool> {
        self.macro_runtime.role_ownership_transfer_active(role_id)
    }

    pub fn ensure_macro_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
    ) -> CoreResult<crate::MacroInputRecoveryTicket> {
        self.macro_runtime
            .ensure_input_recovery(recovery_id, role_id)
    }

    pub fn complete_macro_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
    ) -> CoreResult<crate::MacroInputRecoveryCompletion> {
        let (macros, settings) =
            self.with_runtime(|runtime| runtime.state.macro_configuration())?;
        let active_role_ids = self.macro_active_role_ids()?;
        let tickets = self
            .macro_runtime
            .input_recovery_group_tickets(recovery_id)?;
        if !tickets.iter().any(|ticket| {
            ticket.recovery_id == recovery_id && ticket.role_id == role_id
        }) {
            return Ok(crate::MacroInputRecoveryCompletion {
                deferred_count: 0,
                restarted_count: 0,
                skipped_count: 0,
            });
        }
        let diagnostics = self.macro_runtime.input_diagnostics()?;
        let deferred = tickets.iter().any(|ticket| {
            diagnostics.roles.iter().any(|role| {
                role.role_id == ticket.role_id
                    && (role.stopping || role.quiesced || role.restart_required)
            })
        });
        if deferred {
            return Ok(crate::MacroInputRecoveryCompletion {
                deferred_count: tickets
                    .iter()
                    .map(|ticket| ticket.pending_macro_restart_count)
                    .sum(),
                restarted_count: 0,
                skipped_count: 0,
            });
        }
        let intents = self
            .macro_runtime
            .take_input_recovery_group(recovery_id)?;
        if intents.is_empty() {
            return Ok(crate::MacroInputRecoveryCompletion {
                deferred_count: 0,
                restarted_count: 0,
                skipped_count: 0,
            });
        }
        let mut restarted_count = 0_u32;
        let mut skipped_count = 0_u32;
        for intent in intents {
            let request = crate::model::MacroStartRequest {
                macros: macros.clone(),
                settings: settings.clone(),
                macro_id: intent.macro_id,
                source_role_id: intent.source_role_id,
                active_role_ids: active_role_ids.clone(),
            };
            if self.macro_runtime.start(request).is_ok() {
                restarted_count = restarted_count.saturating_add(1);
            } else {
                skipped_count = skipped_count.saturating_add(1);
            }
        }
        Ok(crate::MacroInputRecoveryCompletion {
            deferred_count: 0,
            restarted_count,
            skipped_count,
        })
    }

    pub fn fail_macro_input_recovery(
        &self,
        recovery_id: &str,
        role_id: &str,
        message: &str,
    ) -> CoreResult<bool> {
        self.macro_runtime
            .fail_input_recovery(recovery_id, role_id, message)
    }

    pub fn macro_input_recovery_for_role(
        &self,
        role_id: &str,
    ) -> CoreResult<Option<crate::MacroInputRecoveryTicket>> {
        self.macro_runtime.input_recovery_for_role(role_id)
    }

    fn release_macro_role(&self, role_id: String) -> CoreResult<Value> {
        self.macro_runtime.release_role(&role_id)?;
        Ok(json!({ "released": true }))
    }

    fn macro_input_fence(&self, role_id: String) -> CoreResult<Value> {
        serde_json::to_value(self.fence_macro_input(&role_id)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn macro_input_drain(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        serde_json::to_value(self.drain_macro_input(&role_id, input_epoch)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    fn macro_input_resume(&self, role_id: String, input_epoch: u64) -> CoreResult<Value> {
        serde_json::to_value(self.resume_macro_input(&role_id, input_epoch)?)
            .map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub fn fence_macro_input(&self, role_id: &str) -> CoreResult<MacroInputEpochRecord> {
        let input_epoch = self.macro_runtime.fence_role_input(role_id)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current: true,
        })
    }

    pub fn require_macro_role_restart_after_navigation_failure(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<bool> {
        self.macro_runtime
            .require_role_restart_after_navigation_failure(role_id, input_epoch)
    }

    pub fn terminalize_macro_runs_after_process_termination(
        &self,
        role_id: &str,
    ) -> CoreResult<()> {
        self.macro_runtime
            .terminalize_role_after_process_termination(role_id)
    }

    pub fn drain_macro_input(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<MacroInputEpochRecord> {
        let current = self.macro_runtime.drain_role_input(role_id, input_epoch)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current,
        })
    }

    pub fn resume_macro_input(
        &self,
        role_id: &str,
        input_epoch: u64,
    ) -> CoreResult<MacroInputEpochRecord> {
        let current = self.macro_runtime.resume_role_input(role_id, input_epoch)?;
        Ok(MacroInputEpochRecord {
            role_id: role_id.to_owned(),
            input_epoch,
            current,
        })
    }

}
