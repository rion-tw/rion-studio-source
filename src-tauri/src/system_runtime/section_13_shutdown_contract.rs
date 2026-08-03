impl SystemRuntimeExecutor {
    pub(crate) fn shutdown_is_terminal(&self) -> bool {
        matches!(
            RuntimeShutdownState::from_raw(self.shutdown_state.load(Ordering::Acquire)),
            RuntimeShutdownState::Closed | RuntimeShutdownState::Indeterminate
        )
    }

    pub fn close_all(&self) -> SystemRuntimeOperationSummaryRecord {
        let operation = self
            .shutdown_operation
            .get_or_init(|| {
                NativeOperationContext::new(
                    NativeOperationSubsystem::Shutdown,
                    "closeAll",
                    SURFACE_RECLAMATION_TIMEOUT,
                )
                .with_completion_scope("nativeAcknowledgement")
            })
            .clone();
        match self.operations.register(operation.clone()) {
            Ok(()) => {}
            Err("SYSTEM_NATIVE_OPERATION_ID_CONFLICT") => {
                return self.shutdown_receipt_or_indeterminate(&operation);
            }
            Err(code) => {
                return self
                    .operations
                    .record_untracked(NativeOperationReceipt::with_status(
                        operation,
                        "shutdownRegistrationFailed",
                        NativeOperationStatus::Failed,
                        Some(code),
                    ))
                    .summary();
            }
        }
        if self
            .shutdown_state
            .compare_exchange(
                RuntimeShutdownState::Accepting as u8,
                RuntimeShutdownState::Draining as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return self.shutdown_receipt_or_indeterminate(&operation);
        }
        self.operations.mark_in_flight(&operation.operation_id);
        self.main_window_actor.stop();
        self.focus_broker.revoke_all();
        let deadline = operation.deadline;
        let initial_role_ids = match self.shutdown_role_ids() {
            Ok(role_ids) => role_ids,
            Err(()) => {
                self.finish_shutdown_indeterminate(operation, "shutdownStateUnavailable");
                return self.shutdown_receipt_or_indeterminate(
                    self.shutdown_operation.get().expect("shutdown operation exists"),
                );
            }
        };
        for role_id in &initial_role_ids {
            self.clear_role_keys(role_id);
            self.discard_role_navigation_input_fences(role_id, "runtime-shutdown");
        }
        let native_creation_idle = self.native_creation_slots.wait_for_idle(deadline);
        let native_window_mutations_idle = self.native_window_mutations.wait_for_idle(deadline);
        let (surfaces, role_ids) = match self.shutdown_surface_snapshot() {
            Ok(snapshot) => snapshot,
            Err(()) => {
                self.finish_shutdown_indeterminate(operation, "shutdownStateUnavailable");
                return self.shutdown_receipt_or_indeterminate(
                    self.shutdown_operation.get().expect("shutdown operation exists"),
                );
            }
        };
        for role_id in &role_ids {
            self.clear_role_keys(role_id);
            self.discard_role_navigation_input_fences(role_id, "runtime-shutdown");
        }

        let isolation_errors = self.isolate_shutdown_surfaces(&surfaces);
        let platform = current_runtime_platform();
        let unreleased_count = surfaces
            .iter()
            .filter(|surface| {
                !surface.lifecycle.wait_for_controller_release(
                    platform,
                    deadline.saturating_duration_since(Instant::now()),
                )
            })
            .count();
        let hosts = match self.take_shutdown_hosts() {
            Ok(snapshot) => snapshot,
            Err(()) => {
                self.finish_shutdown_indeterminate(operation, "shutdownCommitUnavailable");
                return self.shutdown_receipt_or_indeterminate(
                    self.shutdown_operation.get().expect("shutdown operation exists"),
                );
            }
        };
        for transaction in &hosts.pending_window_closes {
            self.operations.complete(NativeOperationReceipt::with_status(
                transaction.context.clone(),
                "windowCloseInterruptedByShutdown",
                NativeOperationStatus::Failed,
                Some("SYSTEM_RUNTIME_SHUTTING_DOWN"),
            ));
        }
        drop(hosts.tabs);
        let close_error_count =
            self.close_shutdown_hosts(hosts.display_hosts, hosts.popup_labels);
        let (state, status, stage, failure_code) = if !native_creation_idle
            || !native_window_mutations_idle
        {
            (
                RuntimeShutdownState::Indeterminate,
                NativeOperationStatus::Indeterminate,
                "shutdownNativeWorkUnverified",
                Some("SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE"),
            )
        } else if isolation_errors > 0 {
            (
                RuntimeShutdownState::Indeterminate,
                NativeOperationStatus::Indeterminate,
                "shutdownIsolationUnverified",
                Some("SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE"),
            )
        } else if unreleased_count > 0 || close_error_count > 0 {
            (
                RuntimeShutdownState::Closed,
                NativeOperationStatus::Degraded,
                "shutdownReleaseIncomplete",
                Some("SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE"),
            )
        } else {
            (
                RuntimeShutdownState::Closed,
                NativeOperationStatus::Applied,
                "shutdownClosed",
                None,
            )
        };
        self.shutdown_state.store(state as u8, Ordering::Release);
        if state == RuntimeShutdownState::Indeterminate {
            self.health.mark_unhealthy();
        }
        self.operations.complete(NativeOperationReceipt::with_status(
            operation,
            stage,
            status,
            failure_code,
        ));
        self.shutdown_receipt_or_indeterminate(
            self.shutdown_operation.get().expect("shutdown operation exists"),
        )
    }

    fn shutdown_receipt_or_indeterminate(
        &self,
        operation: &NativeOperationContext,
    ) -> SystemRuntimeOperationSummaryRecord {
        self.operations
            .wait(&operation.operation_id)
            .unwrap_or_else(|code| {
                NativeOperationReceipt::with_status(
                    operation.clone(),
                    "shutdownReceiptUnavailable",
                    NativeOperationStatus::Indeterminate,
                    Some(code),
                )
            })
            .summary()
    }

    fn shutdown_role_ids(&self) -> Result<Vec<String>, ()> {
        self.state
            .lock()
            .map(|state| state.role_tabs.keys().cloned().collect())
            .map_err(|_| ())
    }

    fn shutdown_surface_snapshot(&self) -> Result<(Vec<ManagedSurface>, Vec<String>), ()> {
        let state = self.state.lock().map_err(|_| ())?;
        let surfaces = state
            .surface_registry
            .values()
            .chain(state.retired_surface_registry.values())
            .cloned()
            .collect::<Vec<_>>();
        let role_ids = state.role_tabs.keys().cloned().collect::<Vec<_>>();
        for tab in state.tabs.values() {
            for role in tab.roles.values() {
                role.navigation.reset();
            }
        }
        Ok((surfaces, role_ids))
    }

    fn isolate_shutdown_surfaces(&self, surfaces: &[ManagedSurface]) -> usize {
        let errors = Mutex::new(Vec::<String>::new());
        thread::scope(|scope| {
            let handles = surfaces
                .iter()
                .map(|surface| {
                    let errors = &errors;
                    scope.spawn(move || {
                        let result = if surface.phase == ManagedSurfacePhase::Retired {
                            Ok(())
                        } else if surface.kind == ManagedSurfaceKind::Divider {
                            self.close_managed_divider(&surface.instance_id)
                        } else {
                            self.close_managed_surface_and_wait(
                                &surface.instance_id,
                                surface
                                    .role_id
                                    .as_deref()
                                    .unwrap_or(surface.instance_id.as_str()),
                            )
                        };
                        if let Err(error) = result
                            && let Ok(mut errors) = errors.lock()
                        {
                            errors.push(format!("{}: {}", surface.instance_id, error.message));
                        }
                    })
                })
                .collect::<Vec<_>>();
            for handle in handles {
                if handle.join().is_err()
                    && let Ok(mut errors) = errors.lock()
                {
                    errors.push("native surface shutdown worker panicked".to_owned());
                }
            }
        });
        errors.into_inner().map(|errors| errors.len()).unwrap_or(1)
    }

    fn take_shutdown_hosts(&self) -> Result<ShutdownHostSnapshot, ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        let tabs = std::mem::take(&mut state.tabs);
        let display_hosts = std::mem::take(&mut state.display_hosts);
        let popup_labels = std::mem::take(&mut state.popup_roles)
            .into_keys()
            .collect::<Vec<_>>();
        state.audible_webviews.clear();
        state.launch_phases.clear();
        state.overlay_capabilities.clear();
        state.overlay_ready_webviews.clear();
        state.role_tabs.clear();
        state.main_frame_navigation_input_fences.clear();
        state.role_input_fences.clear();
        state.last_input_ready_epochs.clear();
        state.controlled_navigation_webviews.clear();
        state.surface_registry.clear();
        state.retired_surface_registry.clear();
        state.recovering_roles.clear();
        let pending_window_closes = state.window_closes.drain();
        state.allow_window_close_labels.extend(
            display_hosts
                .values()
                .map(|host| host.window.label().to_owned()),
        );
        Ok(ShutdownHostSnapshot {
            display_hosts,
            pending_window_closes,
            popup_labels,
            tabs,
        })
    }

    fn close_shutdown_hosts(
        &self,
        display_hosts: HashMap<String, RuntimeDisplayHost>,
        popup_labels: Vec<String>,
    ) -> usize {
        let mut errors = 0;
        for (window_id, host) in display_hosts {
            self.unregister_runtime_launcher_window(&window_id);
            self.presentation.remove(&window_id);
            self.native_window_mutations.forget(&window_id);
            if host.window.close().is_err() {
                errors += 1;
            }
        }
        for label in popup_labels {
            if let Some(window) = self.app.get_webview_window(&label)
                && window.close().is_err()
            {
                errors += 1;
            }
        }
        errors
    }

    fn finish_shutdown_indeterminate(
        &self,
        operation: NativeOperationContext,
        stage: &'static str,
    ) {
        self.shutdown_state.store(
            RuntimeShutdownState::Indeterminate as u8,
            Ordering::Release,
        );
        self.health.mark_unhealthy();
        self.operations.complete(NativeOperationReceipt::with_status(
            operation,
            stage,
            NativeOperationStatus::Indeterminate,
            Some("SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE"),
        ));
    }
}

struct ShutdownHostSnapshot {
    display_hosts: HashMap<String, RuntimeDisplayHost>,
    pending_window_closes: Vec<WindowCloseTransaction>,
    popup_labels: Vec<String>,
    tabs: HashMap<String, RuntimeTab>,
}
