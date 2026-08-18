impl SystemRuntimeExecutor {
    fn allow_main_frame_navigation_after_input_fence(
        &self,
        webview_label: &str,
        role_id: &str,
        url: &Url,
    ) -> bool {
        if !matches!(url.scheme(), "about" | "http" | "https") {
            return false;
        }
        if should_release_macros_for_navigation(url) {
            let (controlled, role_closing) = self
                .state
                .lock()
                .map(|state| {
                    (
                        state
                            .controlled_navigation_webviews
                            .contains_key(webview_label),
                        state.close_coordinator.closing_roles.contains(role_id)
                            || state.close_coordinator.quarantined_roles.contains(role_id),
                    )
                })
                .unwrap_or((false, false));
            if navigation_requires_input_fence(controlled, role_closing)
                && let Err(error) = self.begin_navigation_input_fence(
                    webview_label,
                    role_id,
                    NavigationInputFenceSource::MainFrame,
                )
            {
                self.emit_navigation_input_error(
                    "SYSTEM_NAVIGATION_INPUT_FENCE_FAILED",
                    &error.message,
                    role_id,
                    webview_label,
                );
                return false;
            }
        }
        true
    }

    fn begin_navigation_input_fence(
        &self,
        webview_label: &str,
        role_id: &str,
        source: NavigationInputFenceSource,
    ) -> RuntimeResult<u64> {
        let generation = self.surface_generation_for_role(role_id).unwrap_or_default();
        let mut operation = NativeOperationContext::new(
            NativeOperationSubsystem::Navigation,
            source.trigger(),
            NAVIGATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::InputReady)
        .with_role(role_id)
        .with_surface_generation(generation);
        if let Ok(state) = self.state()
            && let Some(tab_id) = state.native_tab_id_for_role_surface(role_id)
        {
            operation.tab_id = Some(tab_id.clone());
            operation.window_id = self.presentation.tab_window(tab_id).ok().flatten();
        }
        accept_navigation_input_operation(&self.operations, &operation)?;
        let epoch_result = self
            .core
            .fence_macro_input(role_id)
            .map_err(RuntimeError::core);
        let epoch = match epoch_result {
            Ok(epoch) => epoch.input_epoch,
            Err(error) => {
                self.record_native_operation_receipt(receipt_for_runtime_result(
                    operation,
                    "navigationInputFenceFailed",
                    &Err::<(), _>(RuntimeError::new(error.code, &error.message)),
                ));
                return Err(error);
            }
        };
        if let Err(error) =
            self.install_role_input_fence(role_id, epoch, source.reason(), Some(generation))
        {
            if self.macro_input_recovery_active(role_id) {
                self.terminalize_macro_input_recovery(
                    role_id,
                    "SYSTEM_NAVIGATION_INPUT_FENCE_FAILED",
                    "Navigation input fencing failed during macro recovery. The page was left unchanged; restart this role before running another macro.",
                );
            } else {
                let _ = self
                    .core
                    .require_macro_role_restart_after_navigation_failure(role_id, epoch);
                self.publish_projection();
                self.emit_navigation_input_error(
                    "MACRO_ROLE_INPUT_RESTART_REQUIRED",
                    "Automatic input was paused because the navigation input fence could not be installed. The live page was left unchanged; restart this role before running another macro.",
                    role_id,
                    webview_label,
                );
            }
            self.record_native_operation_receipt(receipt_for_runtime_result(
                operation,
                "navigationInputFenceFailed",
                &Err::<(), _>(RuntimeError::new(error.code, &error.message)),
            ));
            return Err(error);
        }
        let baseline_document_id = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.last_completed_document_ids.get(webview_label).cloned());
        let installed = self.state.lock().is_ok_and(|mut state| {
            if !state
                .role_input_fences
                .get(role_id)
                .is_some_and(|fence| fence.input_epoch == epoch)
            {
                return false;
            }
            update_main_frame_navigation_input_fences(
                &mut state.main_frame_navigation_input_fences,
                webview_label,
                role_id,
                epoch,
                generation,
                baseline_document_id,
            );
            if let Some(fence) = state.role_input_fences.get_mut(role_id) {
                fence.navigation_operation = Some(operation.clone());
            }
            true
        });
        if !installed {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                operation,
                "navigationInputFenceSuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
            ));
            return Ok(epoch);
        }
        self.record_input_fence_event(role_id, epoch, "started");
        let app = self.app.clone();
        let core = Arc::clone(&self.core);
        let role_id = role_id.to_owned();
        let webview_label = webview_label.to_owned();
        let deadline_app = app.clone();
        let deadline_role_id = role_id.clone();
        let deadline_webview_label = webview_label.clone();
        tauri::async_runtime::spawn(async move {
            // DeadlineBound: the exact page-finished event is the only success
            // path. Elapsed time terminalizes automatic input as restart-required;
            // it never reads back page state or infers navigation success.
            tokio::time::sleep(NAVIGATION_TIMEOUT).await;
            if let Some(state) = deadline_app.try_state::<crate::CoreState>() {
                state.runtime.expire_navigation_input_fence(
                    &deadline_webview_label,
                    &deadline_role_id,
                    epoch,
                    generation,
                );
            }
        });
        tauri::async_runtime::spawn(async move {
            let drain_result = core.drain_macro_input(&role_id, epoch);
            let drained = drain_result.as_ref().is_ok_and(|record| record.current);
            if drained {
                if let Some(state) = app.try_state::<crate::CoreState>() {
                    state
                        .runtime
                        .finish_navigation_input_drain(&role_id, epoch);
                }
            } else if let Some(state) = app.try_state::<crate::CoreState>() {
                state.runtime.emit_navigation_input_error(
                    "SYSTEM_NAVIGATION_INPUT_DRAIN_FAILED",
                    &drain_result
                        .err()
                        .map(|error| error.to_string())
                        .unwrap_or_else(|| {
                            "Core rejected an obsolete navigation input drain.".to_owned()
                        }),
                    &role_id,
                    &webview_label,
                );
            }
        });
        Ok(epoch)
    }

    fn finish_navigation_input_drain(&self, role_id: &str, input_epoch: u64) {
        let current = self.state.lock().is_ok_and(|mut state| {
            let Some(fence) = state.role_input_fences.get_mut(role_id) else {
                return false;
            };
            if fence.input_epoch != input_epoch {
                return false;
            }
            fence.drained = true;
            true
        });
        if !current {
            self.record_stale_input_fence_event(role_id, input_epoch);
            return;
        }
        self.record_input_fence_event(role_id, input_epoch, "drained");
        self.try_resume_navigation_input(role_id, input_epoch);
    }

    fn finish_main_frame_navigation_page(&self, webview: &Webview, url: &Url) {
        if !matches!(url.scheme(), "http" | "https") {
            return;
        }
        let webview_label = webview.label().to_owned();
        let webview = webview.clone();
        let app = self.app.clone();
        drop(tauri::async_runtime::spawn_blocking(move || {
            let readback = read_document_instance(&webview);
            if let Some(state) = app.try_state::<crate::CoreState>() {
                state
                    .runtime
                    .complete_main_frame_navigation_page_finish(
                        &webview_label,
                        readback.as_ref().ok(),
                    );
            }
        }));
    }

    fn complete_main_frame_navigation_page_finish(
        &self,
        webview_label: &str,
        readback: Option<&DocumentInstanceReadback>,
    ) {
        let completed_document_id = readback
            .filter(|readback| {
                readback.ready_state == "complete"
                    && matches!(readback.protocol.as_str(), "http:" | "https:")
            })
            .and_then(|readback| readback.document_id.as_deref())
            .filter(|document_id| !document_id.is_empty())
            .map(str::to_owned);
        let ticket = self.state.lock().ok().and_then(|mut state| {
            let document_id = completed_document_id.as_ref()?;
            let ticket = state
                .main_frame_navigation_input_fences
                .get_mut(webview_label);
            let completed = ticket.is_none_or(|ticket| {
                ticket
                    .baseline_document_id
                    .as_deref()
                    .is_none_or(|baseline| baseline != document_id)
            });
            if !completed {
                return None;
            }
            state
                .last_completed_document_ids
                .insert(webview_label.to_owned(), document_id.clone());
            let completed = mark_main_frame_navigation_page_finished(
                &mut state.main_frame_navigation_input_fences,
                webview_label,
                "https",
            );
            if let Some((role_id, input_epoch)) = completed.as_ref() {
                let surface_generation = state
                    .role_input_fences
                    .get(role_id)
                    .filter(|fence| fence.input_epoch == *input_epoch)
                    .map(|fence| fence.surface_generation);
                if let Some(surface_generation) = surface_generation {
                    confirm_macro_recovery_document_replacement(
                        &mut state.macro_input_recoveries,
                        role_id,
                        *input_epoch,
                        surface_generation,
                    );
                }
            }
            completed
        });
        if let Some((role_id, input_epoch)) = ticket {
            self.record_input_fence_event(&role_id, input_epoch, "page-finished");
            self.try_resume_navigation_input(&role_id, input_epoch);
        }
    }

    fn try_resume_navigation_input(&self, role_id: &str, input_epoch: u64) {
        let macro_recovery = self.state.lock().ok().and_then(|state| {
            state.macro_input_recoveries.get(role_id).cloned()
        });
        if macro_recovery
            .as_ref()
            .is_some_and(|recovery| !recovery.evidence.permits_in_place_resume())
        {
            return;
        }
        let ready = self.state.lock().is_ok_and(|mut state| {
            let RuntimeState {
                role_input_fences,
                main_frame_navigation_input_fences,
                ..
            } = &mut *state;
            claim_navigation_input_resume(
                role_input_fences,
                main_frame_navigation_input_fences,
                role_id,
                input_epoch,
            )
        });
        if !ready {
            return;
        }
        let resumed = self
            .core
            .resume_macro_input(role_id, input_epoch)
            .ok()
            .is_some_and(|record| record.current);
        if !resumed {
            self.require_role_restart_after_input_fence_failure(
                role_id,
                input_epoch,
                "core-input-resume-rejected",
            );
            return;
        }
        let native_resumed = if let Some(recovery) = macro_recovery.as_ref() {
            self.resume_role_input_after_macro_recovery(
                role_id,
                input_epoch,
                recovery.surface_generation,
            )
            .unwrap_or(false)
        } else {
            self.resume_role_input(role_id, input_epoch).unwrap_or(false)
        };
        if native_resumed {
            self.record_input_fence_event(role_id, input_epoch, "resumed");
            let operation = self.state.lock().ok().and_then(|mut state| {
                if !state
                    .role_input_fences
                    .get(role_id)
                    .is_some_and(|fence| fence.input_epoch == input_epoch)
                {
                    return None;
                }
                let operation = state
                    .role_input_fences
                    .remove(role_id)
                    .and_then(|fence| fence.navigation_operation);
                state
                    .last_input_ready_epochs
                    .insert(role_id.to_owned(), input_epoch);
                state
                    .main_frame_navigation_input_fences
                    .retain(|_, ticket| ticket.role_id != role_id);
                operation
            });
            self.input_readiness.notify();
            if let Some(operation) = operation {
                self.record_native_operation_receipt(NativeOperationReceipt::applied(
                    operation,
                    "navigationInputReady",
                ));
            }
            if macro_recovery.is_some() {
                self.finish_macro_input_recovery_in_place(role_id, input_epoch);
            }
        } else {
            self.require_role_restart_after_input_fence_failure(
                role_id,
                input_epoch,
                "native-input-resume-rejected",
            );
        }
    }

    fn install_role_input_fence(
        &self,
        role_id: &str,
        input_epoch: u64,
        reason: &str,
        surface_generation: Option<u64>,
    ) -> RuntimeResult<()> {
        self.set_role_input_fence(role_id, input_epoch)?;
        let generation = surface_generation
            .or_else(|| self.surface_generation_for_role(role_id))
            .unwrap_or_default();
        let mut state = self.state()?;
        if state
            .role_input_fences
            .get(role_id)
            .is_some_and(|fence| fence.input_epoch > input_epoch)
        {
            return Ok(());
        }
        for ticket in state
            .main_frame_navigation_input_fences
            .values_mut()
            .filter(|ticket| ticket.role_id == role_id)
        {
            ticket.input_epoch = input_epoch;
            ticket.surface_generation = generation;
        }
        state.last_input_ready_epochs.remove(role_id);
        let (macro_recovery_id, pending_macro_restart_count) = state
            .macro_input_recoveries
            .get(role_id)
            .map(|recovery| {
                (
                    Some(recovery.recovery_id.clone()),
                    recovery.pending_macro_restart_count,
                )
            })
            .or_else(|| {
                state.role_input_fences.get(role_id).map(|fence| {
                    (
                        fence.macro_recovery_id.clone(),
                        fence.pending_macro_restart_count,
                    )
                })
            })
            .unwrap_or_default();
        if let Some(recovery) = state.macro_input_recoveries.get_mut(role_id) {
            recovery.input_epoch = input_epoch;
        }
        let superseded_operation = state
            .role_input_fences
            .insert(
                role_id.to_owned(),
                RoleInputFence {
                    input_epoch,
                    navigation_operation: None,
                    reason: reason.to_owned(),
                    started_at: Instant::now(),
                    drained: false,
                    surface_generation: generation,
                    recovery_scheduled: false,
                    restart_required: false,
                    macro_recovery_id,
                    pending_macro_restart_count,
                    resuming: false,
                },
            )
            .and_then(|fence| fence.navigation_operation);
        drop(state);
        self.input_readiness.notify();
        if let Some(operation) = superseded_operation {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                operation,
                "navigationInputFenceSuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
            ));
        }
        Ok(())
    }

    fn expire_navigation_input_fence(
        &self,
        webview_label: &str,
        role_id: &str,
        input_epoch: u64,
        surface_generation: u64,
    ) {
        let current = self.state.lock().ok().is_some_and(|state| {
            main_frame_navigation_deadline_is_current(
                &state.role_input_fences,
                &state.main_frame_navigation_input_fences,
                webview_label,
                role_id,
                input_epoch,
                surface_generation,
            )
        });
        if !current {
            self.record_stale_input_fence_event(role_id, input_epoch);
            return;
        }
        self.require_role_restart_after_input_fence_failure(
            role_id,
            input_epoch,
            "page-finish-deadline",
        );
    }

    fn require_role_restart_after_input_fence_failure(
        &self,
        role_id: &str,
        input_epoch: u64,
        reason: &str,
    ) {
        let restart = self.state.lock().ok().and_then(|mut state| {
            let generation =
                claim_input_fence_restart_required(&mut state.role_input_fences, role_id, input_epoch)?;
            let fence = state
                .role_input_fences
                .get_mut(role_id)?;
            fence.reason = reason.to_owned();
            Some((
                generation,
                fence.navigation_operation.clone(),
                fence.macro_recovery_id.is_some(),
            ))
        });
        let Some((_generation, operation, macro_owned)) = restart else {
            return;
        };
        if macro_owned {
            if let Some(operation) = operation {
                self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                    operation,
                    "navigationInputRecoveryManual",
                    NativeOperationStatus::Failed,
                    Some("SYSTEM_NAVIGATION_INPUT_FENCE_FAILED"),
                ));
            }
            self.terminalize_macro_input_recovery(
                role_id,
                "SYSTEM_MACRO_INPUT_RECOVERY_INPUT_UNPROVEN",
                "Automatic input recovery could not prove that the current page was safe. The page was left unchanged; restart this role before running another macro.",
            );
            return;
        }
        let restart_required = self
            .core
            .require_macro_role_restart_after_navigation_failure(role_id, input_epoch);
        if !restart_required.as_ref().is_ok_and(|current| *current) {
            let message = restart_required
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "Core rejected an obsolete navigation input epoch.".to_owned());
            self.emit_navigation_input_error(
                "SYSTEM_NAVIGATION_MACRO_TERMINAL_FAILED",
                &message,
                role_id,
                "input-fence",
            );
        }
        if let Some(operation) = operation {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                operation,
                "navigationInputRecovery",
                NativeOperationStatus::Failed,
                Some("SYSTEM_NAVIGATION_INPUT_FENCE_FAILED"),
            ));
        }
        self.record_input_fence_event_with_reason(
            role_id,
            input_epoch,
            "restart-required",
            reason,
            LogLevel::Warn,
        );
        self.publish_projection();
        self.emit_navigation_input_error(
            "MACRO_ROLE_INPUT_RESTART_REQUIRED",
            "Automatic input was paused because navigation did not reach an authoritative input-ready state. The live page was left unchanged; restart this role before running another macro.",
            role_id,
            "input-fence",
        );
    }

    fn record_input_fence_event(&self, role_id: &str, input_epoch: u64, event: &str) {
        let level = if matches!(event, "stale" | "restart-required" | "recovery-failed") {
            LogLevel::Warn
        } else {
            LogLevel::Debug
        };
        self.record_input_fence_event_with_reason(
            role_id,
            input_epoch,
            event,
            "coordinator",
            level,
        );
    }

    fn record_stale_input_fence_event(&self, role_id: &str, input_epoch: u64) {
        self.record_input_fence_event_with_reason(
            role_id,
            input_epoch,
            "stale",
            "obsolete-epoch-or-surface",
            LogLevel::Warn,
        );
    }

    fn record_input_fence_event_with_reason(
        &self,
        role_id: &str,
        input_epoch: u64,
        event: &str,
        fallback_reason: &str,
        level: LogLevel,
    ) {
        let (
            reason,
            elapsed_ms,
            surface_generation,
            operation_id,
            drained,
            pending,
            recovery_scheduled,
            recovery_id,
            pending_macro_restart_count,
        ) = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state.role_input_fences.get(role_id).map(|fence| {
                    (
                        fence.reason.clone(),
                        fence
                            .started_at
                            .elapsed()
                            .as_millis()
                            .min(u64::MAX as u128) as u64,
                        Some(fence.surface_generation),
                        fence
                            .navigation_operation
                            .as_ref()
                            .map(|operation| operation.operation_id.clone()),
                        fence.drained,
                        state
                            .main_frame_navigation_input_fences
                            .values()
                            .filter(|ticket| {
                                ticket.role_id == role_id
                                    && ticket.input_epoch == fence.input_epoch
                                    && !ticket.page_finished
                            })
                            .count()
                            .min(u32::MAX as usize) as u32,
                        fence.recovery_scheduled,
                        fence.macro_recovery_id.clone(),
                        fence.pending_macro_restart_count,
                    )
                }).or_else(|| {
                    state.macro_input_recoveries.get(role_id).map(|recovery| {
                        (
                            fallback_reason.to_owned(),
                            0,
                            None,
                            None,
                            false,
                            0,
                            false,
                            Some(recovery.recovery_id.clone()),
                            recovery.pending_macro_restart_count,
                        )
                    })
                })
            })
            .unwrap_or_else(|| {
                (
                    fallback_reason.to_owned(),
                    0,
                    None,
                    None,
                    false,
                    0,
                    false,
                    None,
                    0,
                )
            });
        let record = SystemRuntimeInputFenceEventRecord {
            captured_at: chrono::Utc::now().to_rfc3339(),
            role_id: role_id.to_owned(),
            input_epoch,
            event: event.to_owned(),
            reason: reason.clone(),
            elapsed_ms,
            surface_generation,
            drained,
            pending_page_finish_count: pending,
            recovery_scheduled,
            recovery_id: recovery_id.clone(),
            pending_macro_restart_count,
        };
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_input_fence_event(record);
        }
        #[cfg(feature = "desktop-e2e")]
        crate::desktop_e2e::record_event(
            "input-fence-event",
            None,
            surface_generation,
            None,
            json!({
                "drained": drained,
                "event": event,
                "inputEpoch": input_epoch,
                "pendingMacroRestartCount": pending_macro_restart_count,
                "reason": reason.clone(),
                "recoveryId": recovery_id.clone(),
                "roleId": role_id,
            }),
        );
        let context = json!({
            "drained": drained,
            "elapsedMs": elapsed_ms,
            "inputEpoch": input_epoch,
            "operationId": operation_id,
            "pendingPageFinishCount": pending,
            "reason": reason,
            "recoveryScheduled": recovery_scheduled,
            "recoveryId": recovery_id,
            "pendingMacroRestartCount": pending_macro_restart_count,
            "roleId": role_id,
            "surfaceGeneration": surface_generation,
        });
        let core = Arc::clone(&self.core);
        let log_event = format!("input.fence-{event}");
        tauri::async_runtime::spawn(async move {
            let _ = core
                .invoke_async(CoreCommand::LogsCapture {
                    entries: vec![LogCaptureRecord {
                        level,
                        source: LogSource::Macro,
                        event: log_event,
                        message: "Role input fence state changed.".to_owned(),
                        context_raw_json: serde_json::to_string(&context).ok(),
                        error: None,
                    }],
                })
                .await;
        });
    }

    fn emit_navigation_input_error(
        &self,
        code: &str,
        message: &str,
        role_id: &str,
        webview_label: &str,
    ) {
        let _ = self.app.emit(
            "rion://shell-error",
            json!({
                "code": code,
                "message": message,
                "roleId": role_id,
                "webviewLabel": webview_label
            }),
        );
    }

    fn discard_role_navigation_input_fences(&self, role_id: &str, reason: &str) {
        let (discarded_epoch, navigation) = self
            .state
            .lock()
            .ok()
            .map(|mut state| {
                let navigation = state
                    .native_tab_id_for_role_surface(role_id)
                    .and_then(|tab_id| state.native_resources.tabs.get(tab_id))
                    .and_then(|tab| tab.roles.get(role_id))
                    .map(|surface| Arc::clone(&surface.navigation));
                state.last_input_ready_epochs.remove(role_id);
                let discarded_epoch = state.role_input_fences.remove(role_id).map(|fence| {
                    state
                        .main_frame_navigation_input_fences
                        .retain(|_, ticket| ticket.role_id != role_id);
                    (fence.input_epoch, fence.navigation_operation)
                });
                (discarded_epoch, navigation)
            })
            .unwrap_or((None, None));
        self.input_readiness.notify();
        if let Some(navigation) = navigation {
            // Closing a launching role supersedes the pending native page wait.
            // Wake both sync and async subscribers immediately; controller
            // isolation must not leave EmbeddedLoadRoles alive until deadline.
            navigation.reset();
        }
        if let Some((input_epoch, operation)) = discarded_epoch {
            if let Some(operation) = operation {
                self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                    operation,
                    "navigationInputDiscarded",
                    NativeOperationStatus::Superseded,
                    Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                ));
            }
            self.record_input_fence_event_with_reason(
                role_id,
                input_epoch,
                "discarded",
                reason,
                LogLevel::Debug,
            );
        }
    }

}
