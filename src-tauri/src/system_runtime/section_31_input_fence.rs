impl SystemRuntimeExecutor {
    fn quarantine_role_input(&self, role_id: &str, error: &RuntimeError) {
        let newly_quarantined = self.role_input_lane(role_id).is_ok_and(|lane| {
            lane.normal_enabled.store(false, Ordering::Release);
            !lane.quarantined.swap(true, Ordering::AcqRel)
        });
        if newly_quarantined {
            let _ = self.app.emit(
                "rion://shell-error",
                json!({
                    "code": "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                    "message": "Automatic input was disabled because native key or pointer cleanup could not be verified. Restart this role before running another macro.",
                    "reason": error.message,
                    "roleId": role_id
                }),
            );
            let app = self.app.clone();
            let core = Arc::clone(&self.core);
            let role_id = role_id.to_owned();
            tauri::async_runtime::spawn(async move {
                let fenced = core
                    .invoke_async(CoreCommand::MacroInputFence {
                        role_id: role_id.clone(),
                    })
                    .await
                    .ok()
                    .and_then(|value| {
                        serde_json::from_value::<MacroInputEpochRecord>(value).ok()
                    });
                let Some(fenced) = fenced else {
                    return;
                };
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    let _ = state
                        .runtime
                        .set_role_input_fence(&role_id, fenced.input_epoch);
                }
                let _ = core
                    .invoke_async(CoreCommand::MacroInputDrain {
                        role_id,
                        input_epoch: fenced.input_epoch,
                    })
                    .await;
            });
        }
    }

    fn set_role_input_fence(&self, role_id: &str, input_epoch: u64) -> RuntimeResult<()> {
        let lane = self.role_input_lane(role_id)?;
        lane.epoch.fetch_max(input_epoch, Ordering::AcqRel);
        lane.normal_enabled.store(false, Ordering::Release);
        Ok(())
    }

    fn advance_role_input_fence_local(&self, role_id: &str) -> RuntimeResult<u64> {
        let lane = self.role_input_lane(role_id)?;
        lane.normal_enabled.store(false, Ordering::Release);
        Ok(lane.epoch.fetch_add(1, Ordering::AcqRel).saturating_add(1))
    }

    fn set_role_input_surface(
        &self,
        role_id: &str,
        surface_generation: u64,
        normal_enabled: bool,
        advance_input_epoch: bool,
    ) -> RuntimeResult<()> {
        let lane = self.role_input_lane(role_id)?;
        if advance_input_epoch {
            lane.epoch.fetch_add(1, Ordering::AcqRel);
        }
        lane.surface_generation
            .store(surface_generation, Ordering::Release);
        lane.quarantined.store(false, Ordering::Release);
        lane.normal_enabled
            .store(normal_enabled, Ordering::Release);
        Ok(())
    }

    fn resume_role_input(&self, role_id: &str, input_epoch: u64) -> RuntimeResult<bool> {
        let lane = self.role_input_lane(role_id)?;
        let current = lane.epoch.load(Ordering::Acquire) == input_epoch;
        let resumable = current && !lane.quarantined.load(Ordering::Acquire);
        if resumable {
            lane.normal_enabled.store(true, Ordering::Release);
        }
        Ok(resumable)
    }

    fn with_input_context_lane<T>(
        &self,
        context: &InputDispatchContext,
        operation: impl FnOnce() -> RuntimeResult<T>,
    ) -> RuntimeResult<T> {
        let _guard = context.lane.sequence.lock().map_err(|_| {
            RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_FAILED",
                "The role input lane is unavailable.",
            )
        })?;
        context.ensure_current()?;
        operation()
    }
}
