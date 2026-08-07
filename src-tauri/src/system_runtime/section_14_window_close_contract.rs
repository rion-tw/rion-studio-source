fn state_window_generation_matches(
    state: &Mutex<RuntimeState>,
    window_id: &str,
    label: &str,
    generation: Option<u64>,
) -> bool {
    state.lock().ok().is_some_and(|state| {
        state.display_hosts.get(window_id).is_some_and(|host| {
            host.window.label() == label && Some(host.generation) == generation
        })
    })
}

fn window_close_failure_status(
    native_submitted: bool,
    exact_host_live: bool,
) -> NativeOperationStatus {
    if native_submitted && !exact_host_live {
        NativeOperationStatus::Indeterminate
    } else {
        NativeOperationStatus::Failed
    }
}

fn window_close_in_progress(state: &RuntimeState, window_id: &str) -> bool {
    if state.retiring_window_tabs.contains_key(window_id)
        || state
            .retiring_native_window_hosts
            .values()
            .any(|host| host.window_id == window_id)
        || state.close_previews.values().any(|preview| {
            preview.window_id == window_id && preview.retirement_revision.is_some()
        })
    {
        return true;
    }
    let Some(generation) = state
        .display_hosts
        .get(window_id)
        .map(|host| host.generation)
    else {
        return false;
    };
    state
        .window_closes
        .contains_window_generation(window_id, generation)
}

impl SystemRuntimeExecutor {
    pub(crate) fn live_window_tab_ids(&self, window_id: &str) -> Result<Vec<String>, String> {
        self.presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window state was not found.".to_owned())?
            .lock()
            .map(|state| state.all_tab_ids())
            .map_err(|_| "Live runtime window state is unavailable.".to_owned())
    }

    fn current_window_close_in_progress(&self, window_id: &str) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| window_close_in_progress(&state, window_id))
    }

    pub(crate) fn wait_for_window_close_before_reopen(
        &self,
        window_id: &str,
    ) -> Result<(), String> {
        let operation_id = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .window_closes
            .operation_id_for_window(window_id);
        if let Some(operation_id) = operation_id {
            let receipt = self.wait_window_close_operation(&operation_id);
            if !matches!(
                receipt.status,
                SystemRuntimeOperationStatus::Applied
                    | SystemRuntimeOperationStatus::Superseded
                    | SystemRuntimeOperationStatus::Cancelled
                    | SystemRuntimeOperationStatus::Degraded
            ) {
                return Err(format!(
                    "The previous native window generation did not finish closing ({}).",
                    receipt.status.as_str()
                ));
            }
        }
        let deadline = Instant::now() + SURFACE_RECLAMATION_TIMEOUT;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
        while window_close_in_progress(&state, window_id) {
            let now = Instant::now();
            if now >= deadline {
                return Err(
                    "The previous native window generation is still releasing its role surfaces."
                        .to_owned(),
                );
            }
            let (next, timeout) = self
                .tab_close_changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| "System runtime state lock poisoned.".to_owned())?;
            state = next;
            if timeout.timed_out() && window_close_in_progress(&state, window_id) {
                return Err(
                    "The previous native window generation is still releasing its role surfaces."
                        .to_owned(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn begin_window_close_requested(
        &self,
        label: &str,
    ) -> RuntimeResult<RuntimeWindowCloseRequest> {
        let (window_id, window, pending_operation_id) = {
            let mut state = self.state()?;
            if state.allow_window_close_labels.remove(label) {
                return Ok(RuntimeWindowCloseRequest::PassThrough);
            }
            let Some((window_id, host)) = state.display_hosts.iter().find(|(_, host)| {
                host.window.label() == label
            }) else {
                return Ok(RuntimeWindowCloseRequest::PassThrough);
            };
            (
                window_id.clone(),
                host.window.clone(),
                state.window_closes.pending_operation_id(label),
            )
        };
        if let Some(operation_id) = pending_operation_id
            && self.operations.terminal(&operation_id).is_none()
        {
            return Ok(RuntimeWindowCloseRequest::Pending);
        }
        let accepted = self.accept_window_close_operation(
            &window_id,
            "os-close-requested",
        )?;
        Ok(RuntimeWindowCloseRequest::Start {
            operation_id: accepted.operation_id,
            window_id,
            window: Box::new(window),
        })
    }

    pub(crate) fn begin_window_close_operation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> RuntimeResult<RuntimeWindowCloseOperation> {
        self.require_runtime_accepting()?;
        self.accept_window_close_operation(window_id, trigger)
    }

    fn accept_window_close_operation(
        &self,
        window_id: &str,
        trigger: &'static str,
    ) -> RuntimeResult<RuntimeWindowCloseOperation> {
        let mut state = self.state()?;
        let host = state.display_hosts.get(window_id).map(|host| {
            (host.window.label().to_owned(), host.generation)
        });
        if let Some((label, _)) = host.as_ref()
            && let Some(operation_id) = state.window_closes.pending_operation_id(label)
        {
            if self.operations.terminal(&operation_id).is_none() {
                return Ok(RuntimeWindowCloseOperation {
                    label: Some(label.clone()),
                    native_expected: true,
                    operation_id,
                    should_execute: false,
                });
            }
            state.window_closes.remove(&operation_id);
        }
        let native_expected = host.is_some();
        let mut context = NativeOperationContext::new(
            NativeOperationSubsystem::WindowLifecycle,
            trigger,
            WINDOW_CLOSE_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::StateCommit)
        .with_window(window_id)
        .with_lifecycle_epoch(self.lifecycle_epoch());
        if let Some((_, generation)) = host.as_ref() {
            context = context.with_window_generation(*generation);
        }
        self.operations.register(context.clone()).map_err(|code| {
            RuntimeError::new(code, "The native close operation registry is full or unavailable.")
        })?;
        let transaction = WindowCloseTransaction {
            context: context.clone(),
            generation: host.as_ref().map(|(_, generation)| *generation),
            label: host.as_ref().map(|(label, _)| label.clone()),
            native_submitted: false,
            window_id: window_id.to_owned(),
        };
        if let Err(code) = state.window_closes.insert(transaction) {
            drop(state);
            self.operations.complete(NativeOperationReceipt::with_status(
                context.clone(),
                "windowCloseAcceptanceConflict",
                NativeOperationStatus::Failed,
                Some(code),
            ));
            return Err(RuntimeError::new(
                code,
                "A native close operation is already pending for this window.",
            ));
        }
        Ok(RuntimeWindowCloseOperation {
            label: host.map(|(label, _)| label),
            native_expected,
            operation_id: context.operation_id,
            should_execute: true,
        })
    }

    pub(crate) fn mark_window_close_native_submitted(
        &self,
        operation_id: &str,
    ) -> RuntimeResult<()> {
        let mut state = self.state()?;
        let transaction = state
            .window_closes
            .get_mut(operation_id)
            .ok_or_else(|| RuntimeError::new(
                "SYSTEM_WINDOW_CLOSE_NOT_FOUND",
                "The accepted native close operation no longer exists.",
            ))?;
        transaction.native_submitted = true;
        if !self.operations.mark_in_flight(operation_id) {
            return Err(RuntimeError::new(
                "SYSTEM_WINDOW_CLOSE_NOT_FOUND",
                "The accepted native close operation is already terminal.",
            ));
        }
        Ok(())
    }

    pub(crate) fn commit_visible_window_close(
        &self,
        operation_id: &str,
        window_id: &str,
    ) -> RuntimeResult<(Vec<String>, SystemRuntimeOperationSummaryRecord)> {
        let tab_ids = self.live_window_tab_ids(window_id).unwrap_or_default();
        for tab_id in &tab_ids {
            if self.cancel_provisional_tab_launch_with_presentation(tab_id, false) {
                continue;
            }
            if let Err(message) = self.preview_tab_close_with_presentation(tab_id, false) {
                eprintln!(
                    "Late tab close intent was retired while closing its window: window={window_id} tab={tab_id} error={message}"
                );
            }
        }
        let native_window = {
            let mut state = self.state()?;
            let native_window = state.display_hosts.get_mut(window_id).map(|host| {
                let retirement_revision = WINDOW_RETIREMENT_SEQUENCE
                    .fetch_add(1, Ordering::AcqRel)
                    .saturating_add(1);
                host.retirement_revision = retirement_revision;
                (host.window.clone(), retirement_revision)
            });
            if native_window.is_some() && !tab_ids.is_empty() {
                state.quarantined_window_hosts.remove(window_id);
                state.retiring_window_cleanup_failed.remove(window_id);
                state
                    .retiring_window_tabs
                    .insert(window_id.to_owned(), tab_ids.iter().cloned().collect());
                if let Some((_, retirement_revision)) = native_window.as_ref() {
                    state
                        .retiring_window_revisions
                        .insert(window_id.to_owned(), *retirement_revision);
                }
            }
            native_window.map(|(window, _)| window)
        };
        if native_window.is_some() {
            self.mark_window_close_native_submitted(operation_id)?;
        }
        if let Some(window) = native_window {
            if tab_ids.is_empty() {
                self.remove_empty_display_host(window_id, true);
            } else if let Err(error) = request_platform_window_hide(&window) {
                // The live close has committed and cannot be rolled back. Keep the
                // native parent alive so its child WebViews can still finish blank
                // isolation; cleanup will destroy the exact host afterward.
                eprintln!(
                    "Native Game Window hide submission failed before cleanup: window={window_id} error={} ",
                    error.message
                );
            }
        }
        self.presentation.remove(window_id);
        self.cancel_pending_window_activation(window_id);
        self.notify_optional_idle_changed();
        self.schedule_retiring_window_tab_cleanup(window_id, &tab_ids);
        let receipt = self.complete_window_close_state_commit(operation_id);
        self.publish_launcher_presence();
        Ok((tab_ids, receipt))
    }

    fn schedule_retiring_window_tab_cleanup(&self, window_id: &str, tab_ids: &[String]) {
        let Some(senders) = self.retiring_tab_senders.get() else {
            eprintln!("Live tab close executor was unavailable during window retirement.");
            return;
        };
        for tab_id in tab_ids {
            let index = close_effect_shard_index(tab_id, senders.len());
            if let Err(error) = senders[index].send((window_id.to_owned(), tab_id.clone())) {
                eprintln!(
                    "Live tab native cleanup could not be queued: tab={tab_id} error={error}"
                );
            }
        }
    }

    pub(crate) fn complete_window_close_state_commit(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.finish_window_close_operation(
            operation_id,
            "windowStateCommitted",
            NativeOperationStatus::Applied,
            None,
        )
    }

    pub(crate) fn current_window_close_summary(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        if let Some(receipt) = self.operations.terminal(operation_id) {
            return receipt.summary();
        }
        let context = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .window_closes
                    .get(operation_id)
                    .map(|transaction| transaction.context.clone())
            })
            .unwrap_or_else(|| {
                NativeOperationContext::new(
                    NativeOperationSubsystem::WindowLifecycle,
                    "window-close-superseded",
                    Duration::ZERO,
                )
            });
        NativeOperationReceipt::with_status(
            context,
            "windowCloseAlreadyAccepted",
            NativeOperationStatus::Superseded,
            None,
        )
        .summary()
    }

    pub(crate) fn cancel_window_close_operation(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.finish_window_close_operation(
            operation_id,
            "windowCloseCancelled",
            NativeOperationStatus::Cancelled,
            None,
        )
    }

    pub(crate) fn fail_window_close_operation(
        &self,
        operation_id: &str,
        stage: &'static str,
        failure_code: &'static str,
    ) -> SystemRuntimeOperationSummaryRecord {
        let status = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.window_closes.get(operation_id).cloned())
            .map(|transaction| {
                let exact_host_live = transaction.label.as_ref().is_some_and(|label| {
                    state_window_generation_matches(
                        &self.state,
                        &transaction.window_id,
                        label,
                        transaction.generation,
                    )
                });
                window_close_failure_status(transaction.native_submitted, exact_host_live)
            })
            .unwrap_or(NativeOperationStatus::Failed);
        self.finish_window_close_operation(operation_id, stage, status, Some(failure_code))
    }

    pub(crate) fn wait_window_close_operation(
        &self,
        operation_id: &str,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.operations
            .wait(operation_id)
            .unwrap_or_else(|code| {
                let fallback = NativeOperationContext::new(
                    NativeOperationSubsystem::WindowLifecycle,
                    "window-close-receipt-fallback",
                    Duration::ZERO,
                )
                .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeDestroyed);
                NativeOperationReceipt::with_status(
                    fallback,
                    "windowCloseReceiptUnavailable",
                    NativeOperationStatus::Indeterminate,
                    Some(code),
                )
            })
            .summary()
    }

    pub(crate) fn complete_window_destroyed(&self, label: &str) {
        let (transaction, focus_identity, destroyed_window_id, retired_identity) = self
            .state
            .lock()
            .ok()
            .map(|mut state| {
                #[cfg(not(windows))]
                {
                    state.pending_window_resizes.remove(label);
                    state.active_window_resize_workers.remove(label);
                }
                let live_focus_identity = state.display_hosts.iter().find_map(|(window_id, host)| {
                    (host.window.label() == label)
                        .then(|| (window_id.clone(), host.generation))
                });
                let destroyed_window_id = live_focus_identity
                    .as_ref()
                    .map(|(window_id, _)| window_id.clone());
                let retired_focus_identity = state
                    .retiring_native_window_hosts
                    .remove(label)
                    .map(|host| (host.window_id, host.generation));
                state.allow_window_close_labels.remove(label);
                (
                    state.window_closes.take_destroyed(label),
                    live_focus_identity.or(retired_focus_identity.clone()),
                    destroyed_window_id,
                    retired_focus_identity,
                )
            })
            .unwrap_or_default();
        self.tab_close_changed.notify_all();
        if let Some((window_id, generation)) = retired_identity.as_ref() {
            self.record_presentation_event(
                LogLevel::Debug,
                "native.window-destroyed",
                "The retired native window generation emitted its authoritative destroyed event.",
                window_id,
                None,
                *generation,
                "window-destroyed",
                0,
            );
        }
        if let Some(window_id) = destroyed_window_id.as_deref() {
            self.cancel_pending_surface_continuations(
                Some(window_id),
                "SYSTEM_SURFACE_WINDOW_DESTROYED",
                "Native window destruction ended the pending surface close continuation.",
            );
        }
        if let Some((window_id, generation)) = focus_identity {
            self.cancel_pending_window_activation(&window_id);
            self.focus_broker.revoke_window(&window_id, generation);
        }
        if let Some(transaction) = transaction {
            self.operations.complete(NativeOperationReceipt::with_status(
                transaction.context,
                "windowDestroyed",
                NativeOperationStatus::Applied,
                None,
            ));
        }
        self.forget_popup(label);
    }

    fn finish_window_close_operation(
        &self,
        operation_id: &str,
        stage: &'static str,
        status: NativeOperationStatus,
        failure_code: Option<&str>,
    ) -> SystemRuntimeOperationSummaryRecord {
        let transaction = self.state.lock().ok().and_then(|mut state| {
            state.window_closes.remove(operation_id)
        });
        let Some(transaction) = transaction else {
            return self.wait_window_close_operation(operation_id);
        };
        self.operations
            .complete(NativeOperationReceipt::with_status(
                transaction.context,
                stage,
                status,
                failure_code,
            ))
            .summary()
    }

}
