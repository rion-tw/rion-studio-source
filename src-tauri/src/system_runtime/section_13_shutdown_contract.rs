impl SystemRuntimeExecutor {
    pub fn close_all(&self) -> SystemRuntimeOperationSummaryRecord {
        self.close_all_until(system_runtime_shutdown_deadline())
    }

    pub(crate) fn close_all_until(
        &self,
        deadline: Instant,
    ) -> SystemRuntimeOperationSummaryRecord {
        let operation = self
            .shutdown_operation
            .get_or_init(|| {
                NativeOperationContext::new(
                    NativeOperationSubsystem::Shutdown,
                    "closeAll",
                    SURFACE_RECLAMATION_TIMEOUT,
                )
                .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeAcknowledgement)
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
        let destructive_drain = self.destructive_native_work.begin_shutdown_and_wait(
            deadline,
            || {
                self.shutdown_state
                    .compare_exchange(
                        RuntimeShutdownState::Accepting as u8,
                        RuntimeShutdownState::Draining as u8,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
            },
        );
        if !destructive_drain.starts_shutdown {
            return self.shutdown_receipt_or_indeterminate(&operation);
        }
        self.notify_optional_idle_changed();
        self.operations.mark_in_flight(&operation.operation_id);
        self.main_window_actor.stop();
        self.focus_broker.revoke_all();
        let cancelled_surface_closes = self.cancel_pending_surface_continuations(
            None,
            "SYSTEM_SURFACE_SHUTDOWN_CANCELLED",
            "Application shutdown ended the pending native close continuation.",
        );
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

        let isolation_errors = self.isolate_shutdown_surfaces(&surfaces, deadline);
        let platform = current_runtime_platform();
        let unreleased_count = surfaces
            .iter()
            .filter(|surface| {
                !surface
                    .lifecycle
                    .release_is_complete(
                        platform,
                        application_shutdown_release_boundary(surface.release_boundary),
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
        let (state, status, stage, failure_code) = if !destructive_drain.native_work_drained {
            (
                RuntimeShutdownState::Indeterminate,
                NativeOperationStatus::Indeterminate,
                "shutdownDestructiveNativeWorkUnverified",
                Some("SYSTEM_SHUTDOWN_DESTRUCTIVE_WORK_UNVERIFIED"),
            )
        } else if cancelled_surface_closes > 0 {
            (
                RuntimeShutdownState::Indeterminate,
                NativeOperationStatus::Indeterminate,
                "shutdownSurfaceContinuationCancelled",
                Some("SYSTEM_SHUTDOWN_DRAIN_INCOMPLETE"),
            )
        } else if !native_creation_idle
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
            .map(|state| state.native_role_ids())
            .map_err(|_| ())
    }

    fn shutdown_surface_snapshot(&self) -> Result<(Vec<ManagedSurface>, Vec<String>), ()> {
        let state = self.state.lock().map_err(|_| ())?;
        let surfaces = state
            .native_resources.surface_registry
            .values()
            .chain(state.native_resources.retired_surface_registry.values())
            .cloned()
            .collect::<Vec<_>>();
        let role_ids = state.native_role_ids();
        for tab in state.native_resources.tabs.values() {
            for role in tab.roles.values() {
                role.navigation.reset();
            }
        }
        Ok((surfaces, role_ids))
    }

    fn isolate_shutdown_surfaces(
        &self,
        surfaces: &[ManagedSurface],
        deadline: Instant,
    ) -> usize {
        let tasks = surfaces
            .iter()
            .filter(|surface| surface.phase != ManagedSurfacePhase::Retired)
            .map(|surface| {
                let instance_id = surface.instance_id.clone();
                let task_instance_id = instance_id.clone();
                ShutdownSurfaceIsolationTask::new(
                    instance_id,
                    Box::pin(async move {
                        if surface.kind == ManagedSurfaceKind::Divider {
                            self.close_managed_surface_event_bound(
                                &surface.instance_id,
                                &surface.instance_id,
                            )
                            .await
                        } else {
                            self.close_managed_surface_with_release_boundary_event_bound(
                                &surface.instance_id,
                                surface
                                    .role_id
                                    .as_deref()
                                    .unwrap_or(surface.instance_id.as_str()),
                                Some(application_shutdown_release_boundary(
                                    surface.release_boundary,
                                )),
                                application_shutdown_defers_navigation_to_preflight(),
                            )
                            .await
                        }
                        .inspect_err(|error| {
                            eprintln!(
                                "Native surface shutdown failed (surface={task_instance_id}): {}",
                                error.message
                            );
                        })
                    }),
                )
            })
            .collect::<Vec<_>>();
        let outcome = tauri::async_runtime::block_on(
            await_shutdown_surface_isolation_until(tasks, deadline),
        );
        if !outcome.incomplete_instance_ids.is_empty() {
            let incomplete = outcome
                .incomplete_instance_ids
                .iter()
                .filter_map(|instance_id| {
                    surfaces
                        .iter()
                        .find(|surface| surface.instance_id == *instance_id)
                        .cloned()
                })
                .collect::<Vec<_>>();
            self.cancel_surface_continuations_inner(
                incomplete,
                "SYSTEM_SHUTDOWN_SURFACE_DEADLINE_ELAPSED",
                "Application shutdown reached its native surface reclamation deadline.",
                true,
            );
        }
        outcome
            .error_count
            .saturating_add(outcome.incomplete_instance_ids.len())
    }

    fn take_shutdown_hosts(&self) -> Result<ShutdownHostSnapshot, ()> {
        let mut state = self.state.lock().map_err(|_| ())?;
        let tabs = std::mem::take(&mut state.native_resources.tabs);
        let display_hosts = std::mem::take(&mut state.native_resources.display_hosts);
        let popup_labels = std::mem::take(&mut state.popup_roles)
            .into_keys()
            .collect::<Vec<_>>();
        state.audible_webviews.clear();
        self.presentation.statuses.clear();
        state.overlay_capabilities.clear();
        state.overlay_ready_webviews.clear();
        state.main_frame_navigation_input_fences.clear();
        state.role_input_fences.clear();
        state.last_input_ready_epochs.clear();
        self.input_readiness.notify();
        state.controlled_navigation_webviews.clear();
        state.native_resources.surface_registry.clear();
        state.native_resources.retired_surface_registry.clear();
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
            self.cancel_pending_window_activation(&window_id);
            self.notify_optional_idle_changed();
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

struct ShutdownSurfaceIsolationTask<'a> {
    instance_id: String,
    future: Option<
        std::pin::Pin<Box<dyn std::future::Future<Output = RuntimeResult<()>> + 'a>>,
    >,
}

impl<'a> ShutdownSurfaceIsolationTask<'a> {
    fn new(
        instance_id: String,
        future: std::pin::Pin<
            Box<dyn std::future::Future<Output = RuntimeResult<()>> + 'a>,
        >,
    ) -> Self {
        Self {
            instance_id,
            future: Some(future),
        }
    }
}

struct ShutdownSurfaceIsolationBatch<'a> {
    error_count: usize,
    tasks: Vec<ShutdownSurfaceIsolationTask<'a>>,
}

impl std::future::Future for ShutdownSurfaceIsolationBatch<'_> {
    type Output = usize;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        let mut pending = 0;
        for task in &mut this.tasks {
            let Some(future) = task.future.as_mut() else {
                continue;
            };
            match future.as_mut().poll(context) {
                std::task::Poll::Ready(result) => {
                    if result.is_err() {
                        this.error_count = this.error_count.saturating_add(1);
                    }
                    task.future = None;
                }
                std::task::Poll::Pending => pending += 1,
            }
        }
        if pending == 0 {
            std::task::Poll::Ready(this.error_count)
        } else {
            std::task::Poll::Pending
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ShutdownSurfaceIsolationOutcome {
    error_count: usize,
    incomplete_instance_ids: Vec<String>,
}

async fn await_shutdown_surface_isolation_until(
    tasks: Vec<ShutdownSurfaceIsolationTask<'_>>,
    deadline: Instant,
) -> ShutdownSurfaceIsolationOutcome {
    let mut batch = ShutdownSurfaceIsolationBatch {
        error_count: 0,
        tasks,
    };
    if tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), &mut batch)
        .await
        .is_ok()
    {
        return ShutdownSurfaceIsolationOutcome {
            error_count: batch.error_count,
            incomplete_instance_ids: Vec::new(),
        };
    }
    let incomplete_instance_ids = batch
        .tasks
        .iter()
        .filter(|task| task.future.is_some())
        .map(|task| task.instance_id.clone())
        .collect();
    ShutdownSurfaceIsolationOutcome {
        error_count: batch.error_count,
        incomplete_instance_ids,
    }
}

fn application_shutdown_release_boundary(
    boundary: SurfaceReleaseBoundary,
) -> SurfaceReleaseBoundary {
    match boundary {
        SurfaceReleaseBoundary::DedicatedStore => SurfaceReleaseBoundary::SharedBrowserProcess,
        SurfaceReleaseBoundary::SharedBrowserProcess => boundary,
    }
}

fn application_shutdown_defers_navigation_to_preflight() -> bool {
    false
}

pub(crate) fn system_runtime_shutdown_deadline() -> Instant {
    Instant::now() + SURFACE_RECLAMATION_TIMEOUT
}

pub(crate) fn shutdown_receipt_allows_clean_exit(status: &SystemRuntimeOperationStatus) -> bool {
    matches!(
        status,
        SystemRuntimeOperationStatus::Applied | SystemRuntimeOperationStatus::Degraded
    )
}

struct ShutdownHostSnapshot {
    display_hosts: HashMap<String, RuntimeDisplayHost>,
    pending_window_closes: Vec<WindowCloseTransaction>,
    popup_labels: Vec<String>,
    tabs: HashMap<String, RuntimeTab>,
}
