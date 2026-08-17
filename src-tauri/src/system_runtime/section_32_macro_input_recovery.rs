fn should_project_surface_failure_to_core(macro_input_recovery_active: bool) -> bool {
    !macro_input_recovery_active
}

impl SystemRuntimeExecutor {
    #[cfg(feature = "desktop-e2e")]
    pub(crate) fn desktop_e2e_arm_indeterminate_macro_input(
        &self,
        role_id: &str,
    ) -> Result<Value, String> {
        if self.surface_generation_for_role(role_id).is_none() {
            return Err("The desktop E2E macro input role has no live surface.".to_owned());
        }
        self.state
            .lock()
            .map_err(|_| "The desktop E2E runtime state is unavailable.".to_owned())?
            .desktop_e2e_indeterminate_macro_input_roles
            .insert(role_id.to_owned());
        Ok(json!({ "armed": true, "roleId": role_id }))
    }

    #[cfg(feature = "desktop-e2e")]
    fn desktop_e2e_take_indeterminate_macro_input(&self, role_id: &str) -> bool {
        self.state.lock().is_ok_and(|mut state| {
            state
                .desktop_e2e_indeterminate_macro_input_roles
                .remove(role_id)
        })
    }

    fn schedule_macro_input_recovery(
        &self,
        role_id: &str,
        recovery_id: &str,
        error: &RuntimeError,
    ) {
        let lane_disabled = self.role_input_lane(role_id).is_ok_and(|lane| {
            lane.normal_enabled.store(false, Ordering::Release);
            lane.quarantined.store(true, Ordering::Release);
            true
        });
        if !lane_disabled {
            return;
        }
        let scheduled = self.state.lock().is_ok_and(|mut state| {
            if state.macro_input_recoveries.contains_key(role_id) {
                return false;
            }
            state.macro_input_recoveries.insert(
                role_id.to_owned(),
                MacroInputRecoveryRuntimeState {
                    input_epoch: 0,
                    pending_macro_restart_count: 0,
                    recovery_id: recovery_id.to_owned(),
                },
            );
            true
        });
        if !scheduled {
            return;
        }
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": "SYSTEM_TRUSTED_INPUT_RECOVERING",
                "message": "Native input acknowledgement was lost. Rion Studio is rebuilding this role and will restart eligible macros when the new page is ready.",
                "reason": error.message,
                "roleId": role_id
            }),
        );
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let requested_recovery_id = recovery_id.to_owned();
        tauri::async_runtime::spawn(async move {
            let ticket = core
                .ensure_macro_input_recovery(&requested_recovery_id, &role_id)
                .ok();
            let Some(ticket) = ticket else {
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.terminalize_macro_input_recovery(
                        &role_id,
                        "SYSTEM_MACRO_INPUT_RECOVERY_FENCE_FAILED",
                        "Automatic input recovery could not establish a Core input fence.",
                    );
                }
                return;
            };
            let Some(state) = app.try_state::<crate::CoreState>() else {
                let _ = core.fail_macro_input_recovery(
                    &ticket.recovery_id,
                    &role_id,
                    "Rion Studio stopped before automatic input recovery could start.",
                );
                return;
            };
            let runtime = Arc::clone(&state.runtime);
            let generation = runtime.surface_generation_for_role(&role_id);
            let Some(generation) = generation else {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_SURFACE_MISSING",
                    "The role surface disappeared before automatic input recovery could start.",
                );
                return;
            };
            if runtime
                .install_role_input_fence(
                    &role_id,
                    ticket.input_epoch,
                    "trusted-input-indeterminate",
                    Some(generation),
                )
                .is_err()
            {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_FENCE_FAILED",
                    "Automatic input recovery could not install the native input fence.",
                );
                return;
            }
            if let Ok(mut runtime_state) = runtime.state.lock() {
                runtime_state.macro_input_recoveries.insert(
                    role_id.clone(),
                    MacroInputRecoveryRuntimeState {
                        input_epoch: ticket.input_epoch,
                        pending_macro_restart_count: ticket.pending_macro_restart_count,
                        recovery_id: ticket.recovery_id.clone(),
                    },
                );
                if let Some(fence) = runtime_state.role_input_fences.get_mut(&role_id)
                    && fence.input_epoch == ticket.input_epoch
                {
                    fence.macro_recovery_id = Some(ticket.recovery_id.clone());
                    fence.pending_macro_restart_count = ticket.pending_macro_restart_count;
                }
            }
            runtime.record_input_fence_event_with_reason(
                &role_id,
                ticket.input_epoch,
                "recovery-scheduled",
                "trusted-input-indeterminate",
                LogLevel::Warn,
            );
            let drained = core
                .drain_macro_input(&role_id, ticket.input_epoch)
                .ok()
                .is_some_and(|record| record.current);
            if !drained {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_DRAIN_FAILED",
                    "Automatic input recovery could not confirm that prior macro input drained.",
                );
                return;
            }
            if let Ok(mut runtime_state) = runtime.state.lock()
                && let Some(fence) = runtime_state.role_input_fences.get_mut(&role_id)
                && fence.input_epoch == ticket.input_epoch
            {
                fence.drained = true;
                fence.recovery_scheduled = true;
            }
            runtime.record_input_fence_event(&role_id, ticket.input_epoch, "drained");
            if !runtime.schedule_surface_recovery(
                role_id.clone(),
                "trusted-input-indeterminate".to_owned(),
                generation,
            ) {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_UNAVAILABLE",
                    "The role could not be queued for automatic page recovery.",
                );
            }
        });
    }

    fn finish_macro_input_recovery_after_surface(
        &self,
        role_id: &str,
        receipt: &NativeOperationReceipt,
    ) {
        if receipt.failure_code.as_deref() == Some("SYSTEM_LIFECYCLE_STALE") {
            return;
        }
        let recovery = self.state.lock().ok().and_then(|state| {
            state.macro_input_recoveries.get(role_id).cloned()
        });
        let Some(recovery) = recovery else {
            return;
        };
        if receipt.status == NativeOperationStatus::Applied {
            self.record_input_fence_event_with_reason(
                role_id,
                recovery.input_epoch,
                "macro-restart-claimed",
                "trusted-input-indeterminate",
                LogLevel::Debug,
            );
            if let Ok(mut state) = self.state.lock()
                && state
                    .macro_input_recoveries
                    .get(role_id)
                    .is_some_and(|active| active.recovery_id == recovery.recovery_id)
            {
                state.macro_input_recoveries.remove(role_id);
            }
            let app = self.app.clone();
            let core = Arc::clone(&self.core);
            let role_id = role_id.to_owned();
            tauri::async_runtime::spawn(async move {
                let recovery_id = recovery.recovery_id.clone();
                let restart_role_id = role_id.clone();
                let completion = tauri::async_runtime::spawn_blocking(move || {
                    core.complete_macro_input_recovery(&recovery_id, &restart_role_id)
                })
                .await;
                match completion {
                    Ok(Ok(completion)) if completion.skipped_count == 0 => {
                        #[cfg(feature = "desktop-e2e")]
                        crate::desktop_e2e::record_event(
                            "macro-input-recovery-terminal",
                            None,
                            None,
                            None,
                            json!({
                                "restartedCount": completion.restarted_count,
                                "roleId": role_id,
                                "skippedCount": completion.skipped_count,
                                "status": "applied"
                            }),
                        );
                    }
                    Ok(Ok(completion)) => {
                        #[cfg(feature = "desktop-e2e")]
                        crate::desktop_e2e::record_event(
                            "macro-input-recovery-terminal",
                            None,
                            None,
                            None,
                            json!({
                                "restartedCount": completion.restarted_count,
                                "roleId": role_id,
                                "skippedCount": completion.skipped_count,
                                "status": "partial"
                            }),
                        );
                        let _ = app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_MACRO_INPUT_RECOVERY_PARTIAL",
                                "message": "The role recovered, but one or more macros could not be restarted with the current configuration.",
                                "restartedCount": completion.restarted_count,
                                "roleId": role_id,
                                "skippedCount": completion.skipped_count
                            }),
                        );
                    }
                    Ok(Err(error)) => {
                        #[cfg(feature = "desktop-e2e")]
                        crate::desktop_e2e::record_event(
                            "macro-input-recovery-terminal",
                            None,
                            None,
                            None,
                            json!({
                                "failureCode": error.code(),
                                "roleId": role_id,
                                "status": "failed"
                            }),
                        );
                        let _ = app.emit(
                            "rion://shell-error",
                            json!({
                                "code": error.code(),
                                "message": error.to_string(),
                                "roleId": role_id
                            }),
                        );
                    }
                    Err(error) => {
                        #[cfg(feature = "desktop-e2e")]
                        crate::desktop_e2e::record_event(
                            "macro-input-recovery-terminal",
                            None,
                            None,
                            None,
                            json!({
                                "failureCode": "SYSTEM_MACRO_INPUT_RECOVERY_WORKER_FAILED",
                                "roleId": role_id,
                                "status": "failed"
                            }),
                        );
                        let _ = app.emit(
                            "rion://shell-error",
                            json!({
                                "code": "SYSTEM_MACRO_INPUT_RECOVERY_WORKER_FAILED",
                                "message": error.to_string(),
                                "roleId": role_id
                            }),
                        );
                    }
                }
            });
        } else {
            if let Ok(mut state) = self.state.lock() {
                state.macro_input_recoveries.remove(role_id);
            }
            let core = Arc::clone(&self.core);
            let role_id = role_id.to_owned();
            let failure_code = receipt
                .failure_code
                .clone()
                .unwrap_or_else(|| "SYSTEM_MACRO_INPUT_RECOVERY_FAILED".to_owned());
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = core.fail_macro_input_recovery(
                    &recovery.recovery_id,
                    &role_id,
                    "Automatic input recovery failed. Restart this role before running another macro.",
                );
                let _ = app.emit(
                    "rion://shell-error",
                    json!({
                        "code": "MACRO_ROLE_INPUT_RESTART_REQUIRED",
                        "failureCode": failure_code,
                        "message": "Automatic input recovery failed. Restart this role before running another macro.",
                        "roleId": role_id
                    }),
                );
            });
        }
    }

    fn terminalize_macro_input_recovery(&self, role_id: &str, code: &str, message: &str) {
        let recovery = self.state.lock().ok().and_then(|state| {
            state.macro_input_recoveries.get(role_id).cloned()
        });
        let Some(recovery) = recovery else {
            return;
        };
        let _ = self.core.fail_macro_input_recovery(
            &recovery.recovery_id,
            role_id,
            "Automatic input recovery failed. Restart this role before running another macro.",
        );
        self.record_input_fence_event_with_reason(
            role_id,
            recovery.input_epoch,
            "recovery-failed",
            code,
            LogLevel::Warn,
        );
        if let Ok(mut state) = self.state.lock() {
            state.macro_input_recoveries.remove(role_id);
        }
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": "MACRO_ROLE_INPUT_RESTART_REQUIRED",
                "failureCode": code,
                "message": message,
                "roleId": role_id
            }),
        );
    }
}
