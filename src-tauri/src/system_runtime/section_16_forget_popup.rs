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
        .with_completion_scope("policyDecision");
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
                .surface_registry
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
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "other"
        };
        for (instance_id, lifecycle) in released_surfaces {
            lifecycle.mark_controller_released();
            #[cfg(windows)]
            lifecycle.mark_native_surface_released();
            if lifecycle.wait_for_controller_release(platform, Duration::ZERO) {
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
            let fenced = core
                .invoke_async(CoreCommand::MacroInputFence {
                    role_id: role_id.clone(),
                })
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok());
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
                        "recovery-scheduled",
                        "popup-close-core-fence-failed",
                        LogLevel::Warn,
                    );
                    if let Some(generation) = state.runtime.surface_generation_for_role(&role_id) {
                        state.runtime.schedule_surface_recovery(
                            role_id.clone(),
                            "popup-close-input-fence-failed".to_owned(),
                            generation,
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
                    if let Some(generation) = state.runtime.surface_generation_for_role(&role_id) {
                        state.runtime.schedule_surface_recovery(
                            role_id.clone(),
                            "popup-close-native-fence-failed".to_owned(),
                            generation,
                        );
                    }
                    return;
                }
                state
                    .runtime
                    .record_input_fence_event(&role_id, fenced.input_epoch, "started");
            }
            let drained = core
                .invoke_async(CoreCommand::MacroInputDrain {
                    role_id: role_id.clone(),
                    input_epoch: fenced.input_epoch,
                })
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
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
            let (tab_id, window_id, effective_zoom) = {
                let mut state = self.state()?;
                let tab_id = state.role_tabs.get(&role_id).cloned().ok_or_else(|| {
                    RuntimeError::new(
                        "TAURI_RUNTIME_ROLE_NOT_FOUND",
                        "Runtime role was not found while registering its popup.",
                    )
                })?;
                let tab = state.tabs.get(&tab_id).ok_or_else(|| {
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
                let window_id = tab.window_id.clone();
                let window_zoom = state
                    .display_hosts
                    .get(&window_id)
                    .map(|host| host.zoom_factor)
                    .unwrap_or(1.0);
                state
                    .popup_roles
                    .insert(window_label.clone(), role_id.clone());
                (
                    tab_id,
                    window_id,
                    effective_zoom_factor(role_zoom, window_zoom),
                )
            };
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
        if !self.health.is_healthy() {
            return false;
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
        .with_lifecycle_epoch(0);
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
            0,
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

    fn recover_system_surface(
        &self,
        transaction: SurfaceRecoveryTransaction,
        reason: String,
        allowed: bool,
    ) {
        let role_id = transaction.role_id.clone();
        let transaction_is_current = self.state.lock().ok().is_some_and(|state| {
            state.role_tabs.get(&role_id).is_some_and(|tab_id| {
                state.tabs.get(tab_id).is_some_and(|tab| {
                    tab.roles.get(&role_id).is_some_and(|surface| {
                        surface_recovery_target_is_current(
                            &tab.window_id,
                            &transaction.window_id,
                            surface.generation,
                            transaction.surface_generation,
                        )
                    })
                })
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
        self.operations
            .mark_in_flight(&transaction.context.operation_id);
        if !allowed {
            let _ = self.core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id: role_id.clone(),
                reason: Some(reason.clone()),
            });
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
            .invoke(CoreCommand::MacroInputFence {
                role_id: role_id.clone(),
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .map(|record| record.input_epoch);
        let Some(recovery_epoch) = recovery_epoch else {
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
        self.record_input_fence_event(&role_id, recovery_epoch, "started");
        let drained = self
            .core
            .invoke(CoreCommand::MacroInputDrain {
                role_id: role_id.clone(),
                input_epoch: recovery_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if !drained {
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
        if let Ok(mut state) = self.state.lock()
            && let Some(fence) = state.role_input_fences.get_mut(&role_id)
            && fence.input_epoch == recovery_epoch
        {
            fence.drained = true;
            fence.recovery_scheduled = true;
        }
        self.record_input_fence_event(&role_id, recovery_epoch, "drained");
        self.clear_role_keys(&role_id);
        let _ = self.core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
            role_id: role_id.clone(),
            reason: Some(reason.clone()),
        });
        let mut destructive_started = false;
        let result = self.rebuild_role_surface(&transaction, &mut destructive_started);
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
                    fence.reconciling = false;
                    fence.resuming = false;
                    state
                        .main_frame_navigation_input_fences
                        .retain(|_, ticket| ticket.role_id != role_id);
                }
                let recovered = self
                    .core
                    .invoke(CoreCommand::EmbeddedSystemSurfaceRecovered {
                        role_id: role_id.clone(),
                    })
                    .is_ok();
                if recovered {
                    self.try_resume_navigation_input(&role_id, recovery_epoch);
                }
                let resumed = self.state.lock().ok().is_some_and(|state| {
                    !state.role_input_fences.contains_key(&role_id)
                });
                if !recovered || !resumed {
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
                let restart_required = surface_recovery_requires_restart(destructive_started);
                if restart_required
                    && let Ok(mut state) = self.state.lock()
                {
                    state.close_coordinator.quarantined_roles.insert(role_id.clone());
                }
                self.complete_surface_recovery(
                    transaction.clone(),
                    if restart_required {
                        "surfaceRecoveryIndeterminate"
                    } else {
                        "surfaceRecoveryFailed"
                    },
                    if restart_required {
                        NativeOperationStatus::Indeterminate
                    } else if error.code == "SYSTEM_SURFACE_RECOVERY_STALE" {
                        NativeOperationStatus::Superseded
                    } else {
                        NativeOperationStatus::Failed
                    },
                    Some(error.code),
                    restart_required,
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
