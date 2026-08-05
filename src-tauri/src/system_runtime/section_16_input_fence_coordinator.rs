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
            let controlled = self.state.lock().is_ok_and(|state| {
                state
                    .controlled_navigation_webviews
                    .contains_key(webview_label)
            });
            if !controlled
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
            && let Some(tab_id) = state.role_tabs.get(role_id)
        {
            operation.tab_id = Some(tab_id.clone());
            operation.window_id = self.presentation.tab_window(tab_id).ok().flatten();
        }
        accept_navigation_input_operation(&self.operations, &operation)?;
        let epoch_result = self
            .core
            .invoke(CoreCommand::MacroInputFence {
                role_id: role_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<MacroInputEpochRecord>(value).map_err(|error| {
                    RuntimeError::new(
                        "SYSTEM_NAVIGATION_INPUT_FENCE_FAILED",
                        error.to_string(),
                    )
                })
            });
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
            if let Some(state) = self.app.try_state::<crate::CoreState>() {
                state.runtime.schedule_surface_recovery(
                    role_id.to_owned(),
                    "navigation-native-input-fence-failed".to_owned(),
                    generation,
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
        let watchdog_app = app.clone();
        let watchdog_role_id = role_id.clone();
        let watchdog_webview_label = webview_label.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(NAVIGATION_TIMEOUT).await;
            if let Some(state) = watchdog_app.try_state::<crate::CoreState>() {
                state.runtime.reconcile_navigation_input_fence(
                    &watchdog_webview_label,
                    &watchdog_role_id,
                    epoch,
                    generation,
                );
            }
        });
        tauri::async_runtime::spawn(async move {
            let drain_result = core
                .invoke_async(CoreCommand::MacroInputDrain {
                    role_id: role_id.clone(),
                    input_epoch: epoch,
                })
                .await;
            let drained = drain_result
                .as_ref()
                .ok()
                .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value.clone()).ok())
                .is_some_and(|record| record.current);
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
            mark_main_frame_navigation_page_finished(
                &mut state.main_frame_navigation_input_fences,
                webview_label,
                "https",
            )
        });
        if let Some((role_id, input_epoch)) = ticket {
            self.record_input_fence_event(&role_id, input_epoch, "page-finished");
            self.try_resume_navigation_input(&role_id, input_epoch);
        }
    }

    fn try_resume_navigation_input(&self, role_id: &str, input_epoch: u64) {
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
            .invoke(CoreCommand::MacroInputResume {
                role_id: role_id.to_owned(),
                input_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if !resumed {
            self.schedule_input_fence_recovery(
                role_id,
                input_epoch,
                "core-input-resume-rejected",
            );
            return;
        }
        if self.resume_role_input(role_id, input_epoch).unwrap_or(false) {
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
            if let Some(operation) = operation {
                self.record_native_operation_receipt(NativeOperationReceipt::applied(
                    operation,
                    "navigationInputReady",
                ));
            }
        } else {
            self.schedule_input_fence_recovery(
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
                    reconciling: false,
                    resuming: false,
                },
            )
            .and_then(|fence| fence.navigation_operation);
        drop(state);
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

    fn reconcile_navigation_input_fence(
        &self,
        webview_label: &str,
        role_id: &str,
        input_epoch: u64,
        surface_generation: u64,
    ) {
        let snapshot = self.state.lock().ok().and_then(|mut state| {
            if !main_frame_navigation_needs_reconciliation(
                &state.role_input_fences,
                &state.main_frame_navigation_input_fences,
                webview_label,
                role_id,
                input_epoch,
                surface_generation,
            ) {
                return None;
            }
            let ticket = state.main_frame_navigation_input_fences.get(webview_label)?;
            let baseline_document_id = ticket.baseline_document_id.clone();
            let webview = state
                .surface_registry
                .values()
                .find(|surface| {
                    surface.webview.label() == webview_label
                        && surface.role_id.as_deref() == Some(role_id)
                        && surface.generation == surface_generation
                        && surface.phase == ManagedSurfacePhase::Live
                })
                .map(|surface| surface.webview.clone());
            if let Some(fence) = state.role_input_fences.get_mut(role_id) {
                fence.reconciling = true;
            }
            Some((webview, baseline_document_id))
        });
        let Some((webview, baseline_document_id)) = snapshot else {
            self.record_stale_input_fence_event(role_id, input_epoch);
            return;
        };
        let Some(webview) = webview else {
            self.schedule_input_fence_recovery(role_id, input_epoch, "live-webview-missing");
            return;
        };
        let app = self.app.clone();
        let role_id = role_id.to_owned();
        let webview_label = webview_label.to_owned();
        drop(tauri::async_runtime::spawn_blocking(move || {
            let readback = read_document_instance(&webview);
            if let Some(state) = app.try_state::<crate::CoreState>() {
                state.runtime.finish_navigation_reconciliation(
                    &webview_label,
                    &role_id,
                    input_epoch,
                    surface_generation,
                    baseline_document_id.as_deref(),
                    readback.as_ref().ok(),
                );
            }
        }));
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_navigation_reconciliation(
        &self,
        webview_label: &str,
        role_id: &str,
        input_epoch: u64,
        surface_generation: u64,
        baseline_document_id: Option<&str>,
        readback: Option<&DocumentInstanceReadback>,
    ) {
        let reconciled_document_id = readback
            .filter(|readback| {
                document_instance_proves_completed_navigation(readback, baseline_document_id)
            })
            .and_then(|readback| readback.document_id.clone());
        let current = self.state.lock().is_ok_and(|mut state| {
            let Some(fence) = state.role_input_fences.get_mut(role_id) else {
                return false;
            };
            if fence.input_epoch != input_epoch
                || fence.surface_generation != surface_generation
                || fence.recovery_scheduled
            {
                return false;
            }
            fence.reconciling = false;
            let Some(ticket) = state
                .main_frame_navigation_input_fences
                .get_mut(webview_label)
            else {
                return false;
            };
            if ticket.role_id != role_id
                || ticket.input_epoch != input_epoch
                || ticket.surface_generation != surface_generation
            {
                return false;
            }
            if let Some(document_id) = reconciled_document_id.as_ref() {
                ticket.page_finished = true;
                state
                    .last_completed_document_ids
                    .insert(webview_label.to_owned(), document_id.clone());
            }
            true
        });
        if !current {
            self.record_stale_input_fence_event(role_id, input_epoch);
            return;
        }
        if reconciled_document_id.is_some() {
            self.record_input_fence_event_with_reason(
                role_id,
                input_epoch,
                "reconciled",
                "document-complete",
                LogLevel::Warn,
            );
            self.try_resume_navigation_input(role_id, input_epoch);
        } else {
            self.schedule_input_fence_recovery(role_id, input_epoch, "document-unverified");
        }
    }

    fn schedule_input_fence_recovery(&self, role_id: &str, input_epoch: u64, reason: &str) {
        let recovery = self.state.lock().ok().and_then(|mut state| {
            let generation =
                claim_input_fence_recovery(&mut state.role_input_fences, role_id, input_epoch)?;
            let operation = state
                .role_input_fences
                .get(role_id)
                .and_then(|fence| fence.navigation_operation.clone());
            Some((generation, operation))
        });
        let Some((generation, operation)) = recovery else {
            return;
        };
        let parent_operation_id = operation
            .as_ref()
            .map(|operation| operation.operation_id.clone());
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
            "recovery-scheduled",
            reason,
            LogLevel::Warn,
        );
        let scheduled = self
            .app
            .try_state::<crate::CoreState>()
            .is_some_and(|state| {
                state.runtime.schedule_surface_recovery_with_parent(
                    role_id.to_owned(),
                    "input-fence-timeout".to_owned(),
                    generation,
                    parent_operation_id,
                )
            });
        if !scheduled {
            let _ = self.core.invoke(CoreCommand::EmbeddedSystemSurfaceFailed {
                role_id: role_id.to_owned(),
                reason: Some("input-fence-recovery-unavailable".to_owned()),
            });
            self.record_input_fence_event_with_reason(
                role_id,
                input_epoch,
                "recovery-failed",
                "recovery-not-queued",
                LogLevel::Warn,
            );
            self.emit_navigation_input_error(
                "SYSTEM_INPUT_FENCE_RECOVERY_FAILED",
                "Automatic input recovery could not be scheduled. Restart this role to recover safely.",
                role_id,
                "input-fence",
            );
        }
    }

    fn record_input_fence_event(&self, role_id: &str, input_epoch: u64, event: &str) {
        let level = if matches!(event, "stale" | "reconciled" | "recovery-scheduled" | "recovery-failed") {
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
                    )
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
        };
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            diagnostics.push_input_fence_event(record);
        }
        let context = json!({
            "drained": drained,
            "elapsedMs": elapsed_ms,
            "inputEpoch": input_epoch,
            "operationId": operation_id,
            "pendingPageFinishCount": pending,
            "reason": reason,
            "recoveryScheduled": recovery_scheduled,
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
        let discarded_epoch = self.state.lock().ok().and_then(|mut state| {
            state.last_input_ready_epochs.remove(role_id);
            let fence = state.role_input_fences.remove(role_id)?;
            state
                .main_frame_navigation_input_fences
                .retain(|_, ticket| ticket.role_id != role_id);
            Some((fence.input_epoch, fence.navigation_operation))
        });
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
