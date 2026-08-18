impl SystemRuntimeExecutor {
    fn record_popup_contract_outcome(
        &self,
        role_id: Option<&str>,
        stage: &'static str,
        status: NativeOperationStatus,
        failure_code: Option<&str>,
    ) {
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Popup,
            "newWindow",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::PolicyDecision);
        if let Some(role_id) = role_id {
            operation = operation.with_role(role_id);
            operation.surface_generation = self.surface_generation_for_role(role_id);
        }
        self.record_native_operation_receipt(NativeOperationReceipt::with_status(
            operation,
            stage,
            status,
            failure_code,
        ));
    }

    pub(crate) fn forget_popup(&self, window_label: &str) {
        let (role_id, released_surfaces, role_closing, active_epoch) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let released_surfaces = state
                .native_resources.surface_registry
                .values()
                .filter(|surface| {
                    surface.kind == ManagedSurfaceKind::Popup
                        && surface.webview.label() == window_label
                })
                .map(|surface| (surface.instance_id.clone(), Arc::clone(&surface.lifecycle)))
                .collect::<Vec<_>>();
            let role_id = state.popup_roles.remove(window_label);
            let role_closing = role_id.as_ref().is_some_and(|role_id| {
                state.close_coordinator.closing_roles.contains(role_id)
                    || state.close_coordinator.quarantined_roles.contains(role_id)
            });
            state.main_frame_navigation_input_fences.remove(window_label);
            state.last_completed_document_ids.remove(window_label);
            let active_epoch = role_id.as_ref().and_then(|role_id| {
                state
                    .role_input_fences
                    .get(role_id)
                    .map(|fence| fence.input_epoch)
            });
            state.audible_webviews.remove(window_label);
            state.overlay_capabilities.remove(window_label);
            state
                .close_coordinator
                .closing_webviews
                .remove(window_label);
            (role_id, released_surfaces, role_closing, active_epoch)
        };
        for (instance_id, lifecycle) in released_surfaces {
            lifecycle.mark_controller_released();
            #[cfg(windows)]
            lifecycle.mark_native_surface_released();
            if lifecycle.release_is_complete(
                current_runtime_platform(),
                SurfaceReleaseBoundary::SharedBrowserProcess,
            ) {
                let _ = self.remove_managed_surface(&instance_id);
            }
        }
        let Some(role_id) = role_id else {
            return;
        };
        if role_closing {
            self.discard_role_navigation_input_fences(&role_id, "role-closing");
        } else if let Some(input_epoch) = active_epoch {
            self.try_resume_navigation_input(&role_id, input_epoch);
        } else if let Err(error) = self.fence_closed_popup_input(window_label, &role_id) {
            self.emit_navigation_input_error(
                "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                &error.message,
                &role_id,
                window_label,
            );
        }
        self.publish_projection();
    }

    fn fence_closed_popup_input(&self, window_label: &str, role_id: &str) -> RuntimeResult<()> {
        let local_epoch = self.advance_role_input_fence_local(role_id)?;
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let window_label = window_label.to_owned();
        tauri::async_runtime::spawn(async move {
            let fenced = core.fence_macro_input(&role_id).ok();
            let Some(fenced) = fenced else {
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state.runtime.emit_navigation_input_error(
                        "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                        "Popup close could not establish the Core input fence.",
                        &role_id,
                        &window_label,
                    );
                    state.runtime.record_input_fence_event_with_reason(
                        &role_id,
                        local_epoch,
                        "restart-required",
                        "popup-close-core-fence-failed",
                        LogLevel::Warn,
                    );
                    if state.runtime.macro_input_recovery_active(&role_id) {
                        state.runtime.terminalize_macro_input_recovery(
                            &role_id,
                            "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                            "Popup input fencing failed during macro recovery. The page was left unchanged; restart this role before running another macro.",
                        );
                    } else {
                        state.runtime.require_live_role_restart(
                            &role_id,
                            "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                            "Popup close could not establish the Core input fence.",
                            "popup-close-input-fence-failed",
                        );
                    }
                }
                return;
            };
            if let Some(state) = app.try_state::<crate::CoreState>() {
                if state
                    .runtime
                    .install_role_input_fence(&role_id, fenced.input_epoch, "popup-close", None)
                    .is_err()
                {
                    if state.runtime.macro_input_recovery_active(&role_id) {
                        state.runtime.terminalize_macro_input_recovery(
                            &role_id,
                            "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                            "Popup input fencing failed during macro recovery. The page was left unchanged; restart this role before running another macro.",
                        );
                    } else {
                        state.runtime.require_live_role_restart(
                            &role_id,
                            "SYSTEM_POPUP_INPUT_FENCE_FAILED",
                            "Popup close could not establish the native input fence.",
                            "popup-close-native-fence-failed",
                        );
                    }
                    return;
                }
                state
                    .runtime
                    .record_input_fence_event(&role_id, fenced.input_epoch, "started");
            }
            let drained = core
                .drain_macro_input(&role_id, fenced.input_epoch)
                .ok()
                .is_some_and(|record| record.current);
            if drained && let Some(state) = app.try_state::<crate::CoreState>() {
                state
                    .runtime
                    .finish_navigation_input_drain(&role_id, fenced.input_epoch);
            }
        });
        Ok(())
    }

    fn begin_controlled_navigation(&self, webview_label: &str) -> RuntimeResult<()> {
        begin_controlled_navigation_scope(
            &mut self.state()?.controlled_navigation_webviews,
            webview_label,
        );
        Ok(())
    }

    fn finish_controlled_navigations(&self, webview_labels: &[String]) {
        if let Ok(mut state) = self.state.lock() {
            for label in webview_labels {
                finish_controlled_navigation_scope(
                    &mut state.controlled_navigation_webviews,
                    label,
                );
            }
        }
    }

    fn register_popup(
        &self,
        webview: &Webview,
        lifecycle: &Arc<SurfaceLifecycleTracker>,
        window_label: String,
        role_id: String,
        generation: u64,
    ) -> RuntimeResult<()> {
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Popup,
            "registerPopup",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_role(&role_id)
        .with_surface_generation(generation);
        let result = (|| {
            let tab_id = self
                .state()?
                .native_tab_id_for_role_surface(&role_id)
                .cloned()
                .ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role was not found while registering its popup.",
                    )
            })?;
            let window_id = self.resolve_live_tab_window_id(&tab_id)?;
            let window_zoom = self.runtime_window_zoom_factor(&window_id);
            let (tab_id, window_id, projected_role_zoom) = {
                let mut state = self.state()?;
                let tab = state.native_resources.tabs.get(&tab_id).ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_TAB_NOT_FOUND",
                        "Runtime tab was not found while registering its popup.",
                    )
                })?;
                let role_zoom = tab
                    .roles
                    .get(&role_id)
                    .map(|role| role.zoom_factor)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            "TAURI_RUNTIME_ROLE_NOT_FOUND",
                            "Runtime role surface was not found while registering its popup.",
                        )
                    })?;
                state
                    .popup_roles
                    .insert(window_label.clone(), role_id.clone());
                (
                    tab_id,
                    window_id,
                    role_zoom,
                )
            };
            let (role_zoom, _) = self.runtime_role_zoom_contract(
                &window_id,
                &tab_id,
                &role_id,
                projected_role_zoom,
            );
            let effective_zoom = effective_zoom_factor(role_zoom, window_zoom);
            operation.tab_id = Some(tab_id.clone());
            operation.window_id = Some(window_id.clone());
            if let Err(error) = self.register_managed_surface(
                webview,
                lifecycle,
                ManagedSurfaceKind::Popup,
                ManagedSurfacePhase::Live,
                Some(&role_id),
                Some(&tab_id),
                &window_id,
                generation,
            ) {
                if let Ok(mut state) = self.state.lock() {
                    state.popup_roles.remove(&window_label);
                }
                return Err(error);
            }
            webview
                .set_zoom(effective_zoom)
                .map_err(RuntimeError::tauri)
        })();
        let receipt = match result.as_ref() {
            Ok(()) => NativeOperationReceipt::applied(operation, "popupRegistered"),
            Err(error) => NativeOperationReceipt::with_status(
                operation,
                "popupRegistrationFailed",
                NativeOperationStatus::Failed,
                Some(error.code),
            ),
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn recover_system_surface(
        self: &Arc<Self>,
        transaction: SurfaceRecoveryTransaction,
        reason: String,
        allowed: bool,
    ) {
        let role_id = transaction.role_id.clone();
        let lifecycle_epoch = transaction.context.lifecycle_epoch.unwrap_or_default();
        let current_owner = self.state.lock().ok().and_then(|state| {
            let tab_id = state.native_tab_id_for_role_surface(&role_id)?.clone();
            let generation = state.native_resources.tabs.get(&tab_id)?.roles.get(&role_id)?.generation;
            Some((tab_id, generation))
        });
        let transaction_is_current = current_owner.is_some_and(|(tab_id, generation)| {
            self.presentation.tab_window(&tab_id).ok().flatten().is_some_and(|window_id| {
                surface_recovery_target_is_current(
                    &window_id,
                    &transaction.window_id,
                    generation,
                    transaction.surface_generation,
                )
            })
        });
        if !transaction_is_current {
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoverySuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_SURFACE_RECOVERY_STALE"),
                false,
            );
            return;
        }
        if !self.operations.mark_in_flight(&transaction.context.operation_id) {
            if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                self.retry_surface_recovery_after_lifecycle(
                    transaction,
                    "surfaceRecoveryLifecycleCancelled",
                );
                return;
            }
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryCancelled",
                NativeOperationStatus::Cancelled,
                Some("SYSTEM_LIFECYCLE_SUSPENDED"),
                false,
            );
            return;
        }
        if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
            self.retry_surface_recovery_after_lifecycle(
                transaction,
                "surfaceRecoveryLifecycleCancelled",
            );
            return;
        }
        if self.state.lock().ok().is_some_and(|mut state| {
            let fenced = state.close_coordinator.closing_roles.contains(&role_id)
                || state.close_coordinator.quarantined_roles.contains(&role_id);
            if fenced {
                state.recovering_roles.remove(&role_id);
            }
            fenced
        }) {
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryFenced",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RELEASE_UNVERIFIED"),
                true,
            );
            return;
        }
        if !allowed {
            self.report_system_surface_state_async(
                role_id.clone(),
                Some(reason.clone()),
                false,
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
                state.close_coordinator.quarantined_roles.insert(role_id.clone());
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryBudgetExhausted",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RECOVERY_EXHAUSTED"),
                true,
            );
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_EXHAUSTED",
                "System WebView recovery was stopped after two failures within 60 seconds.",
                &role_id,
                "recovery",
            );
            return;
        }
        self.update_surface_recovery_phase(&transaction, "fencing");
        let recovery_epoch = self
            .core
            .fence_macro_input(&role_id)
            .ok()
            .map(|record| record.input_epoch);
        let Some(recovery_epoch) = recovery_epoch else {
            if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                self.retry_surface_recovery_after_lifecycle(
                    transaction,
                    "surfaceRecoveryLifecycleInterrupted",
                );
                return;
            }
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED",
                "System WebView recovery could not establish an input fence.",
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryInputFenceFailed",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED"),
                false,
            );
            return;
        };
        if let Err(error) = self.install_role_input_fence(
            &role_id,
            recovery_epoch,
            "surface-recovery",
            None,
        ) {
            if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                self.retry_surface_recovery_after_lifecycle(
                    transaction,
                    "surfaceRecoveryLifecycleInterrupted",
                );
                return;
            }
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED",
                &error.message,
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryInputFenceFailed",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RECOVERY_INPUT_FENCE_FAILED"),
                false,
            );
            return;
        }
        let macro_input_recovery_active = self.state.lock().ok().is_some_and(|state| {
            state.macro_input_recoveries.contains_key(&role_id)
        });
        if should_project_surface_failure_to_core(macro_input_recovery_active)
            && let Err(error) = self
                .core
                .terminalize_macro_runs_after_process_termination(&role_id)
        {
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_MACRO_TERMINAL_FAILED",
                &error.to_string(),
                &role_id,
                "recovery",
            );
        }
        self.record_input_fence_event(&role_id, recovery_epoch, "started");
        let drained = self
            .core
            .drain_macro_input(&role_id, recovery_epoch)
            .ok()
            .is_some_and(|record| record.current);
        if !drained {
            if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
                self.retry_surface_recovery_after_lifecycle(
                    transaction,
                    "surfaceRecoveryLifecycleInterrupted",
                );
                return;
            }
            self.emit_navigation_input_error(
                "SYSTEM_SURFACE_RECOVERY_INPUT_DRAIN_FAILED",
                "System WebView recovery could not confirm that macro input drained.",
                &role_id,
                "recovery",
            );
            if let Ok(mut state) = self.state.lock() {
                state.recovering_roles.remove(&role_id);
            }
            self.complete_surface_recovery(
                transaction,
                "surfaceRecoveryInputDrainFailed",
                NativeOperationStatus::Failed,
                Some("SYSTEM_SURFACE_RECOVERY_INPUT_DRAIN_FAILED"),
                false,
            );
            return;
        }
        if !self.application_lifecycle_epoch_matches(lifecycle_epoch) {
            self.retry_surface_recovery_after_lifecycle(
                transaction,
                "surfaceRecoveryLifecycleInterrupted",
            );
            return;
        }
        if let Ok(mut state) = self.state.lock()
            && let Some(fence) = state.role_input_fences.get_mut(&role_id)
            && fence.input_epoch == recovery_epoch
        {
            fence.drained = true;
            fence.recovery_scheduled = true;
        }
        self.record_input_fence_event(&role_id, recovery_epoch, "drained");
        self.clear_role_keys(&role_id);
        if should_project_surface_failure_to_core(macro_input_recovery_active) {
            self.report_system_surface_state_async(role_id.clone(), Some(reason.clone()), false);
        }
        let mut destructive_started = false;
        let result = self
            .rebuild_role_surface(&transaction, &mut destructive_started)
            .and_then(|()| self.require_application_lifecycle_epoch(lifecycle_epoch));
        match result {
            Ok(()) => {
                let replacement_generation = self.surface_generation_for_role(&role_id);
                if let Ok(mut state) = self.state.lock()
                    && let Some(fence) = state.role_input_fences.get_mut(&role_id)
                    && fence.input_epoch == recovery_epoch
                {
                    if let Some(generation) = replacement_generation {
                        fence.surface_generation = generation;
                    }
                    fence.drained = true;
                    fence.recovery_scheduled = false;
                    fence.resuming = false;
                    state
                        .main_frame_navigation_input_fences
                        .retain(|_, ticket| ticket.role_id != role_id);
                }
                self.report_system_surface_state_async(role_id.clone(), None, true);
                self.try_resume_navigation_input(&role_id, recovery_epoch);
                let resumed = self.state.lock().ok().is_some_and(|state| {
                    !state.role_input_fences.contains_key(&role_id)
                });
                if !resumed {
                    self.record_input_fence_event_with_reason(
                        &role_id,
                        recovery_epoch,
                        "recovery-failed",
                        "input-resume-unconfirmed",
                        LogLevel::Warn,
                    );
                    self.emit_navigation_input_error(
                        "SYSTEM_SURFACE_RECOVERY_INPUT_RESUME_FAILED",
                        "The recovered page remains visible, but automatic input is disabled until the role restarts.",
                        &role_id,
                        "recovery",
                    );
                    self.complete_surface_recovery(
                        transaction.clone(),
                        "surfaceRecoveryInputResumeDegraded",
                        NativeOperationStatus::Degraded,
                        Some("SYSTEM_SURFACE_RECOVERY_INPUT_RESUME_FAILED"),
                        false,
                    );
                } else {
                    self.update_surface_recovery_phase(&transaction, "inputReady");
                    self.complete_surface_recovery(
                        transaction.clone(),
                        "surfaceRecoveryInputReady",
                        NativeOperationStatus::Applied,
                        None,
                        false,
                    );
                }
                self.publish_projection();
            }
            Err(error) => {
                let owner_closed = error.code == "SYSTEM_SURFACE_RECOVERY_CANCELLED"
                    || self
                        .surface_recoveries
                        .operation_was_cancelled(&transaction.context.operation_id);
                let failure_outcome = surface_recovery_failure_outcome(
                    error.code,
                    destructive_started,
                    owner_closed,
                );
                if owner_closed {
                    self.clear_role_keys(&role_id);
                    self.discard_role_navigation_input_fences(
                        &role_id,
                        "surface-recovery-owner-closed",
                    );
                    self.complete_surface_recovery(
                        transaction.clone(),
                        failure_outcome.stage,
                        failure_outcome.native_status,
                        Some("SYSTEM_SURFACE_RECOVERY_CANCELLED"),
                        failure_outcome.restart_required,
                    );
                    if let Ok(mut state) = self.state.lock() {
                        state.recovering_roles.remove(&role_id);
                    }
                    return;
                }
                self.record_input_fence_event_with_reason(
                    &role_id,
                    recovery_epoch,
                    "recovery-failed",
                    error.code,
                    LogLevel::Warn,
                );
                let _ = self.app.emit(
                    "rion://shell-error",
                    json!({
                        "code": error.code,
                        "message": error.message,
                        "roleId": role_id,
                        "reason": reason
                    }),
                );
                if error.code == "SYSTEM_LIFECYCLE_STALE"
                    && !failure_outcome.restart_required
                {
                    self.retry_surface_recovery_after_lifecycle(
                        transaction.clone(),
                        "surfaceRecoveryLifecycleInterrupted",
                    );
                    return;
                }
                if failure_outcome.restart_required
                    && let Ok(mut state) = self.state.lock()
                {
                    state.close_coordinator.quarantined_roles.insert(role_id.clone());
                }
                self.complete_surface_recovery(
                    transaction.clone(),
                    failure_outcome.stage,
                    failure_outcome.native_status,
                    Some(error.code),
                    failure_outcome.restart_required,
                );
            }
        }
        if let Ok(mut state) = self.state.lock() {
            state.recovering_roles.remove(&role_id);
        }
    }

}

fn begin_controlled_navigation_scope(scopes: &mut HashMap<String, u32>, webview_label: &str) {
    let depth = scopes.entry(webview_label.to_owned()).or_default();
    *depth = depth.saturating_add(1);
}

fn finish_controlled_navigation_scope(scopes: &mut HashMap<String, u32>, webview_label: &str) {
    let Some(depth) = scopes.get_mut(webview_label) else {
        return;
    };
    if *depth <= 1 {
        scopes.remove(webview_label);
    } else {
        *depth -= 1;
    }
}
