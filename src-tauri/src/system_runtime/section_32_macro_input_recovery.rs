fn should_project_surface_failure_to_core(macro_input_recovery_active: bool) -> bool {
    !macro_input_recovery_active
}

fn macro_input_recovery_evidence(
    cleanup_confirmed: bool,
    tickets: &HashMap<String, MainFrameNavigationInputFence>,
    role_id: &str,
    surface_generation: u64,
) -> MacroInputRecoveryEvidence {
    if cleanup_confirmed {
        return MacroInputRecoveryEvidence::CleanupConfirmed;
    }
    let mut matching = tickets.values().filter(|ticket| {
        ticket.role_id == role_id && ticket.surface_generation == surface_generation
    });
    if matching.clone().any(|ticket| ticket.page_finished) {
        MacroInputRecoveryEvidence::DocumentReplaced
    } else if matching.next().is_some() {
        MacroInputRecoveryEvidence::DocumentReplacementPending
    } else {
        MacroInputRecoveryEvidence::Unproven
    }
}

fn confirm_macro_recovery_document_replacement(
    recoveries: &mut HashMap<String, MacroInputRecoveryRuntimeState>,
    role_id: &str,
    input_epoch: u64,
    surface_generation: u64,
) -> bool {
    let Some(recovery) = recoveries.get_mut(role_id) else {
        return false;
    };
    if recovery.input_epoch != input_epoch
        || recovery.surface_generation != surface_generation
        || recovery.evidence != MacroInputRecoveryEvidence::DocumentReplacementPending
    {
        return false;
    }
    recovery.evidence = MacroInputRecoveryEvidence::DocumentReplaced;
    true
}

impl SystemRuntimeExecutor {
    #[cfg(feature = "desktop-e2e")]
    pub(crate) fn desktop_e2e_arm_indeterminate_macro_input(
        &self,
        role_id: &str,
        cleanup_confirmed: bool,
    ) -> Result<Value, String> {
        if self.surface_generation_for_role(role_id).is_none() {
            return Err("The desktop E2E macro input role has no live surface.".to_owned());
        }
        self.state
            .lock()
            .map_err(|_| "The desktop E2E runtime state is unavailable.".to_owned())?
            .desktop_e2e_indeterminate_macro_input_roles
            .insert(role_id.to_owned(), cleanup_confirmed);
        Ok(json!({
            "armed": true,
            "cleanupConfirmed": cleanup_confirmed,
            "roleId": role_id
        }))
    }

    #[cfg(feature = "desktop-e2e")]
    fn desktop_e2e_take_indeterminate_macro_input(&self, role_id: &str) -> Option<bool> {
        self.state.lock().ok().and_then(|mut state| {
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
        let generation = self.surface_generation_for_role(role_id);
        let Some(generation) = generation else {
            return;
        };
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
            let evidence = macro_input_recovery_evidence(
                error.input_neutrality_confirmed(),
                &state.main_frame_navigation_input_fences,
                role_id,
                generation,
            );
            state.macro_input_recoveries.insert(
                role_id.to_owned(),
                MacroInputRecoveryRuntimeState {
                    evidence,
                    input_epoch: 0,
                    pending_macro_restart_count: 0,
                    recovery_id: recovery_id.to_owned(),
                    surface_generation: generation,
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
                "message": "Native input acknowledgement was lost. Rion Studio paused automatic input and will resume eligible macros only after the current page is proven safe.",
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
            let current_generation = runtime.surface_generation_for_role(&role_id);
            if current_generation != Some(generation) {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_SURFACE_CHANGED",
                    "The role surface changed before in-place input recovery could start.",
                );
                return;
            }
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
                let refreshed_evidence = runtime_state
                    .macro_input_recoveries
                    .get(&role_id)
                    .map(|recovery| recovery.evidence)
                    .filter(|evidence| *evidence == MacroInputRecoveryEvidence::CleanupConfirmed)
                    .unwrap_or_else(|| {
                        macro_input_recovery_evidence(
                            false,
                            &runtime_state.main_frame_navigation_input_fences,
                            &role_id,
                            generation,
                        )
                    });
                let Some(recovery) = runtime_state.macro_input_recoveries.get_mut(&role_id) else {
                    return;
                };
                if recovery.recovery_id != ticket.recovery_id
                    || recovery.surface_generation != generation
                {
                    return;
                }
                recovery.evidence = refreshed_evidence;
                recovery.input_epoch = ticket.input_epoch;
                recovery.pending_macro_restart_count = ticket.pending_macro_restart_count;
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
            }
            runtime.record_input_fence_event(&role_id, ticket.input_epoch, "drained");
            let evidence = runtime.state.lock().ok().and_then(|state| {
                state
                    .macro_input_recoveries
                    .get(&role_id)
                    .map(|recovery| recovery.evidence)
            });
            if evidence == Some(MacroInputRecoveryEvidence::Unproven) {
                runtime.terminalize_macro_input_recovery(
                    &role_id,
                    "SYSTEM_MACRO_INPUT_RECOVERY_NEUTRALITY_UNPROVEN",
                    "Automatic input could not prove that the page returned to a neutral input state. The page was left unchanged; restart this role before running another macro.",
                );
                return;
            }
            runtime.try_resume_navigation_input(&role_id, ticket.input_epoch);
        });
    }

    fn macro_input_recovery_active(&self, role_id: &str) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.macro_input_recoveries.contains_key(role_id)
        })
    }

    fn finish_macro_input_recovery_in_place(&self, role_id: &str, input_epoch: u64) {
        self.finish_macro_input_recovery(role_id, Some(input_epoch), "in-place");
    }

    fn finish_macro_input_recovery_after_surface(
        &self,
        role_id: &str,
        receipt: &NativeOperationReceipt,
    ) {
        if receipt.failure_code.as_deref() == Some("SYSTEM_LIFECYCLE_STALE") {
            return;
        }
        if receipt.status == NativeOperationStatus::Applied {
            self.finish_macro_input_recovery(role_id, None, "surface-rebuild");
            return;
        }
        let failure_code = receipt
            .failure_code
            .as_deref()
            .unwrap_or("SYSTEM_MACRO_INPUT_RECOVERY_FAILED");
        self.terminalize_macro_input_recovery(
            role_id,
            failure_code,
            "Automatic input recovery failed. Restart this role before running another macro.",
        );
    }

    fn finish_macro_input_recovery(
        &self,
        role_id: &str,
        expected_input_epoch: Option<u64>,
        recovery_method: &'static str,
    ) {
        let recovery = self.state.lock().ok().and_then(|mut state| {
            let recovery = state.macro_input_recoveries.get(role_id)?.clone();
            if expected_input_epoch.is_some_and(|epoch| recovery.input_epoch != epoch) {
                return None;
            }
            if recovery_method == "in-place" && !recovery.evidence.permits_in_place_resume() {
                return None;
            }
            state.macro_input_recoveries.remove(role_id);
            Some(recovery)
        });
        let Some(recovery) = recovery else {
            return;
        };
        self.record_input_fence_event_with_reason(
            role_id,
            recovery.input_epoch,
            "macro-restart-claimed",
            recovery_method,
            LogLevel::Debug,
        );
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
                        Some(recovery.surface_generation),
                        None,
                        json!({
                            "recoveryMethod": recovery_method,
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
                        Some(recovery.surface_generation),
                        None,
                        json!({
                            "recoveryMethod": recovery_method,
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
                        Some(recovery.surface_generation),
                        None,
                        json!({
                            "failureCode": error.code(),
                            "recoveryMethod": recovery_method,
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
                        Some(recovery.surface_generation),
                        None,
                        json!({
                            "failureCode": "SYSTEM_MACRO_INPUT_RECOVERY_WORKER_FAILED",
                            "recoveryMethod": recovery_method,
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
        if let Ok(mut state) = self.state.lock() {
            state.macro_input_recoveries.remove(role_id);
        }
        self.require_live_role_restart(
            role_id,
            code,
            message,
            "macro-input-recovery-unproven",
        );
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "macro-input-recovery-terminal",
            None,
            Some(recovery.surface_generation),
            None,
            json!({
                "failureCode": code,
                "recoveryMethod": "manual-restart-required",
                "roleId": role_id,
                "status": "failed"
            }),
        );
    }
}
