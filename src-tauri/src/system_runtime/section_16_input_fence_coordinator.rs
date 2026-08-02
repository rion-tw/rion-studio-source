impl SystemRuntimeExecutor {
    fn allow_navigation_after_macro_release(
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
                state.controlled_navigation_webviews.contains(webview_label)
            });
            if !controlled
                && let Err(error) = self.begin_navigation_input_fence(
                    webview_label,
                    role_id,
                    Some(url.as_str()),
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
        _expected_url: Option<&str>,
    ) -> RuntimeResult<u64> {
        let epoch = serde_json::from_value::<MacroInputEpochRecord>(
            self.core
                .invoke(CoreCommand::MacroInputFence {
                    role_id: role_id.to_owned(),
                })
                .map_err(RuntimeError::core)?,
        )
        .map_err(|error| RuntimeError::new("SYSTEM_NAVIGATION_INPUT_FENCE_FAILED", error.to_string()))?
        .input_epoch;
        let generation = self.surface_generation_for_role(role_id).unwrap_or_default();
        if let Err(error) =
            self.install_role_input_fence(role_id, epoch, "navigation", Some(generation))
        {
            if let Some(state) = self.app.try_state::<crate::CoreState>() {
                state.runtime.schedule_surface_recovery(
                    role_id.to_owned(),
                    "navigation-native-input-fence-failed".to_owned(),
                    generation,
                );
            }
            return Err(error);
        }
        let baseline_document_id = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.last_completed_document_ids.get(webview_label).cloned());
        if let Ok(mut state) = self.state.lock() {
            update_navigation_input_fences(
                &mut state.navigation_input_fences,
                webview_label,
                role_id,
                epoch,
                generation,
                baseline_document_id,
            );
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

    #[cfg(windows)]
    fn current_navigation_input_epoch(
        &self,
        webview_label: &str,
        role_id: &str,
    ) -> Option<u64> {
        self.state.lock().ok().and_then(|state| {
            state
                .navigation_input_fences
                .get(webview_label)
                .filter(|ticket| ticket.role_id == role_id)
                .map(|ticket| ticket.input_epoch)
        })
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

    fn finish_navigation_page(&self, webview: &Webview, url: &Url) {
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
                    .complete_navigation_page_finish(&webview_label, readback.as_ref().ok());
            }
        }));
    }

    fn complete_navigation_page_finish(
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
            let ticket = state.navigation_input_fences.get_mut(webview_label);
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
            mark_navigation_page_finished(
                &mut state.navigation_input_fences,
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
                navigation_input_fences,
                ..
            } = &mut *state;
            claim_navigation_input_resume(
                role_input_fences,
                navigation_input_fences,
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
            if let Ok(mut state) = self.state.lock()
                && state
                    .role_input_fences
                    .get(role_id)
                    .is_some_and(|fence| fence.input_epoch == input_epoch)
            {
                state.role_input_fences.remove(role_id);
                state
                    .navigation_input_fences
                    .retain(|_, ticket| ticket.role_id != role_id);
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
            .navigation_input_fences
            .values_mut()
            .filter(|ticket| ticket.role_id == role_id)
        {
            ticket.input_epoch = input_epoch;
            ticket.surface_generation = generation;
        }
        state.role_input_fences.insert(
            role_id.to_owned(),
            RoleInputFence {
                input_epoch,
                reason: reason.to_owned(),
                started_at: Instant::now(),
                drained: false,
                surface_generation: generation,
                recovery_scheduled: false,
                reconciling: false,
                resuming: false,
            },
        );
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
            let fence = state.role_input_fences.get(role_id)?;
            if fence.input_epoch != input_epoch
                || fence.surface_generation != surface_generation
                || fence.recovery_scheduled
            {
                return None;
            }
            let ticket = state.navigation_input_fences.get(webview_label)?;
            if ticket.role_id != role_id
                || ticket.input_epoch != input_epoch
                || ticket.surface_generation != surface_generation
                || ticket.page_finished
            {
                return None;
            }
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
            let Some(ticket) = state.navigation_input_fences.get_mut(webview_label) else {
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
        let generation = self.state.lock().ok().and_then(|mut state| {
            claim_input_fence_recovery(&mut state.role_input_fences, role_id, input_epoch)
        });
        let Some(generation) = generation else {
            return;
        };
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
                state.runtime.schedule_surface_recovery(
                    role_id.to_owned(),
                    "input-fence-timeout".to_owned(),
                    generation,
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
        let (reason, elapsed_ms, surface_generation, drained, pending, recovery_scheduled) = self
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
                        fence.drained,
                        state
                            .navigation_input_fences
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
                (fallback_reason.to_owned(), 0, None, false, 0, false)
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
            let input_epoch = state.role_input_fences.remove(role_id)?.input_epoch;
            state
                .navigation_input_fences
                .retain(|_, ticket| ticket.role_id != role_id);
            Some(input_epoch)
        });
        if let Some(input_epoch) = discarded_epoch {
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

fn update_navigation_input_fences(
    tickets: &mut HashMap<String, NavigationInputFence>,
    webview_label: &str,
    role_id: &str,
    input_epoch: u64,
    surface_generation: u64,
    baseline_document_id: Option<String>,
) {
    for ticket in tickets
        .values_mut()
        .filter(|ticket| ticket.role_id == role_id)
    {
        ticket.input_epoch = input_epoch;
    }
    tickets.insert(
        webview_label.to_owned(),
        NavigationInputFence {
            role_id: role_id.to_owned(),
            input_epoch,
            surface_generation,
            baseline_document_id,
            page_finished: false,
        },
    );
}

fn claim_input_fence_recovery(
    fences: &mut HashMap<String, RoleInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> Option<u64> {
    let fence = fences.get_mut(role_id)?;
    if fence.input_epoch != input_epoch || fence.recovery_scheduled {
        return None;
    }
    fence.recovery_scheduled = true;
    fence.reconciling = false;
    fence.resuming = false;
    Some(fence.surface_generation)
}

fn mark_navigation_page_finished(
    tickets: &mut HashMap<String, NavigationInputFence>,
    webview_label: &str,
    scheme: &str,
) -> Option<(String, u64)> {
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let ticket = tickets.get_mut(webview_label)?;
    ticket.page_finished = true;
    Some((ticket.role_id.clone(), ticket.input_epoch))
}

fn navigation_input_is_ready(
    fences: &HashMap<String, RoleInputFence>,
    tickets: &HashMap<String, NavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> bool {
    let Some(fence) = fences
        .get(role_id)
        .filter(|fence| {
            fence.input_epoch == input_epoch && fence.drained && !fence.recovery_scheduled
        })
    else {
        return false;
    };
    tickets
        .values()
        .filter(|ticket| ticket.role_id == role_id)
        .all(|ticket| {
            ticket.input_epoch == fence.input_epoch
                && ticket.surface_generation == fence.surface_generation
                && ticket.page_finished
        })
}

fn claim_navigation_input_resume(
    fences: &mut HashMap<String, RoleInputFence>,
    tickets: &HashMap<String, NavigationInputFence>,
    role_id: &str,
    input_epoch: u64,
) -> bool {
    if !navigation_input_is_ready(fences, tickets, role_id, input_epoch) {
        return false;
    }
    let Some(fence) = fences.get_mut(role_id) else {
        return false;
    };
    if fence.resuming {
        return false;
    }
    fence.resuming = true;
    true
}

fn read_document_instance(webview: &Webview) -> RuntimeResult<DocumentInstanceReadback> {
    let raw = evaluate_system_webview(
        webview,
        r#"JSON.stringify({
  documentId: typeof globalThis.__rionStudioDocumentInstanceId === "string"
    ? globalThis.__rionStudioDocumentInstanceId
    : null,
  readyState: document.readyState,
  protocol: location.protocol
})"#,
    )?;
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_INPUT_FENCE_READBACK_INVALID",
            format!("System WebView returned invalid input-fence readback JSON: {error}"),
        )
    })?;
    let value = if let Some(nested) = value.as_str() {
        serde_json::from_str::<Value>(nested).map_err(|error| {
            RuntimeError::new(
                "SYSTEM_INPUT_FENCE_READBACK_INVALID",
                format!("System WebView returned invalid nested input-fence readback JSON: {error}"),
            )
        })?
    } else {
        value
    };
    serde_json::from_value(value).map_err(|error| {
        RuntimeError::new(
            "SYSTEM_INPUT_FENCE_READBACK_INVALID",
            format!("System WebView returned an invalid input-fence readback: {error}"),
        )
    })
}

fn document_instance_proves_completed_navigation(
    readback: &DocumentInstanceReadback,
    baseline_document_id: Option<&str>,
) -> bool {
    let Some(document_id) = readback.document_id.as_deref().filter(|value| !value.is_empty()) else {
        return false;
    };
    baseline_document_id.is_some_and(|baseline| baseline != document_id)
        && readback.ready_state == "complete"
        && matches!(readback.protocol.as_str(), "http:" | "https:")
}
