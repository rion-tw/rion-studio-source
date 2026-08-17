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
                let fenced = core.fence_macro_input(&role_id).ok();
                let Some(fenced) = fenced else {
                    return;
                };
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    let generation = state.runtime.surface_generation_for_role(&role_id);
                    let _ = state.runtime.install_role_input_fence(
                        &role_id,
                        fenced.input_epoch,
                        "trusted-input-quarantined",
                        generation,
                    );
                }
                let drained = core
                    .drain_macro_input(&role_id, fenced.input_epoch)
                    .ok()
                    .is_some_and(|record| record.current);
                if drained
                    && let Some(state) = app.try_state::<crate::CoreState>()
                    && let Ok(mut runtime_state) = state.runtime.state.lock()
                    && let Some(fence) = runtime_state.role_input_fences.get_mut(&role_id)
                    && fence.input_epoch == fenced.input_epoch
                {
                    fence.drained = true;
                }
            });
        }
    }

    fn set_role_input_fence(&self, role_id: &str, input_epoch: u64) -> RuntimeResult<()> {
        self.cancel_macro_key_observations_for_role(role_id);
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
        self.cancel_macro_key_observations_for_role(role_id);
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

    fn retire_role_input_surface(&self, role_id: &str) -> RuntimeResult<()> {
        self.cancel_macro_key_observations_for_role(role_id);
        let lane = self
            .input_dispatch_lanes
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    "SYSTEM_TRUSTED_INPUT_FAILED",
                    "The role input coordinator is unavailable.",
                )
            })?
            .get(role_id)
            .cloned();
        if let Some(lane) = lane {
            retire_role_input_lane(&lane);
        }
        if let Ok(mut state) = self.state.lock() {
            state.macro_input_recoveries.remove(role_id);
        }
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

fn retire_role_input_lane(lane: &RoleInputDispatchLane) {
    // Keep the epoch monotonic across an immediate relaunch, but remove every
    // native-owner fence once exact surface isolation is acknowledged.
    lane.surface_generation.store(0, Ordering::Release);
    lane.quarantined.store(false, Ordering::Release);
    lane.normal_enabled.store(true, Ordering::Release);
}
