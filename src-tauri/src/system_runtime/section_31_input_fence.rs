impl SystemRuntimeExecutor {
    #[cfg(feature = "desktop-e2e")]
    pub(crate) fn desktop_e2e_inject_page_finish_failure(
        &self,
        role_id: &str,
    ) -> Result<Value, String> {
        let (webview_label, generation) = self
            .state
            .lock()
            .map_err(|_| "The desktop E2E runtime state is unavailable.".to_owned())?
            .native_resources
            .tabs
            .values()
            .find_map(|tab| {
                tab.roles.get(role_id).map(|surface| {
                    (surface.webview.label().to_owned(), surface.generation)
                })
            })
            .ok_or_else(|| "The desktop E2E role has no live surface.".to_owned())?;
        let input_epoch = self
            .begin_navigation_input_fence(
                &webview_label,
                role_id,
                NavigationInputFenceSource::MainFrame,
            )
            .map_err(|error| error.message)?;
        self.expire_navigation_input_fence(
            &webview_label,
            role_id,
            input_epoch,
            generation,
        );
        Ok(json!({
            "generation": generation,
            "inputEpoch": input_epoch,
            "roleId": role_id,
            "status": "injected"
        }))
    }

    fn quarantine_role_input(&self, role_id: &str, error: &RuntimeError) {
        self.require_live_role_restart(
            role_id,
            "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
            &error.message,
            "trusted-input-quarantined",
        );
    }

    fn require_live_role_restart(
        &self,
        role_id: &str,
        failure_code: &str,
        failure_message: &str,
        reason: &'static str,
    ) {
        if let Ok(lane) = self.role_input_lane(role_id) {
            lane.normal_enabled.store(false, Ordering::Release);
            lane.quarantined.store(true, Ordering::Release);
        }
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let failure_code = failure_code.to_owned();
        let failure_message = failure_message.to_owned();
        tauri::async_runtime::spawn(async move {
            let Some(fenced) = core.fence_macro_input(&role_id).ok() else {
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.emit_navigation_input_error(
                        &failure_code,
                        &failure_message,
                        &role_id,
                        reason,
                    );
                }
                return;
            };
            let installed = app.try_state::<crate::CoreState>().is_some_and(|state| {
                let generation = state.runtime.surface_generation_for_role(&role_id);
                state
                    .runtime
                    .install_role_input_fence(
                        &role_id,
                        fenced.input_epoch,
                        reason,
                        generation,
                    )
                    .is_ok()
            });
            let drained = core
                .drain_macro_input(&role_id, fenced.input_epoch)
                .ok()
                .is_some_and(|record| record.current);
            let restart_required = core
                .require_macro_role_restart_after_navigation_failure(
                    &role_id,
                    fenced.input_epoch,
                )
                .unwrap_or(false);
            if let Some(state) = app.try_state::<crate::CoreState>() {
                if installed
                    && let Ok(mut runtime_state) = state.runtime.state.lock()
                    && let Some(fence) = runtime_state.role_input_fences.get_mut(&role_id)
                    && fence.input_epoch == fenced.input_epoch
                {
                    fence.drained = drained;
                    fence.restart_required = restart_required;
                    fence.resuming = false;
                }
                if restart_required {
                    state.runtime.record_input_fence_event_with_reason(
                        &role_id,
                        fenced.input_epoch,
                        "restart-required",
                        reason,
                        LogLevel::Warn,
                    );
                }
                state.runtime.publish_projection();
                state.runtime.emit_navigation_input_error(
                    "MACRO_ROLE_INPUT_RESTART_REQUIRED",
                    &format!(
                        "{failure_message} The live page was left unchanged; restart this role before running another macro."
                    ),
                    &role_id,
                    reason,
                );
            }
        });
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

    fn fence_and_drain_role_input_lane(&self, role_id: &str) -> RuntimeResult<u64> {
        let lane = self.role_input_lane(role_id)?;
        fence_and_drain_input_lane(&lane, || {
            self.cancel_macro_key_observations_for_role(role_id);
        })
    }

    fn set_role_input_surface(
        &self,
        role_id: &str,
        surface_generation: u64,
        normal_enabled: bool,
        advance_input_epoch: bool,
    ) -> RuntimeResult<()> {
        self.cancel_macro_key_observations_for_role(role_id);
        if let Ok(mut state) = self.state.lock() {
            let obsolete = state
                .automatic_input_contexts
                .get(role_id)
                .is_some_and(|context| context.surface_generation != surface_generation);
            if obsolete || advance_input_epoch {
                state.automatic_input_contexts.remove(role_id);
            }
        }
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
        if let Ok(mut state) = self.state.lock() {
            state.automatic_input_contexts.remove(role_id);
        }
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

    fn resume_role_input_after_macro_recovery(
        &self,
        role_id: &str,
        input_epoch: u64,
        surface_generation: u64,
    ) -> RuntimeResult<bool> {
        let lane = self.role_input_lane(role_id)?;
        Ok(resume_input_lane_after_macro_recovery(
            &lane,
            input_epoch,
            surface_generation,
        ))
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

fn fence_and_drain_input_lane(
    lane: &RoleInputDispatchLane,
    after_fence: impl FnOnce(),
) -> RuntimeResult<u64> {
    lane.normal_enabled.store(false, Ordering::Release);
    let input_epoch = lane.epoch.fetch_add(1, Ordering::AcqRel).saturating_add(1);
    after_fence();
    let _guard = lane.sequence.lock().map_err(|_| {
        RuntimeError::new(
            "SYSTEM_TRUSTED_INPUT_FAILED",
            "The role input lane is unavailable.",
        )
    })?;
    Ok(input_epoch)
}

fn resume_input_lane_after_macro_recovery(
    lane: &RoleInputDispatchLane,
    input_epoch: u64,
    surface_generation: u64,
) -> bool {
    let current = lane.epoch.load(Ordering::Acquire) == input_epoch
        && lane.surface_generation.load(Ordering::Acquire) == surface_generation;
    if !current {
        return false;
    }
    lane.quarantined.store(false, Ordering::Release);
    lane.normal_enabled.store(true, Ordering::Release);
    true
}

fn retire_role_input_lane(lane: &RoleInputDispatchLane) {
    // Keep the epoch monotonic across an immediate relaunch, but remove every
    // native-owner fence once exact surface isolation is acknowledged.
    lane.surface_generation.store(0, Ordering::Release);
    lane.quarantined.store(false, Ordering::Release);
    lane.normal_enabled.store(true, Ordering::Release);
}
