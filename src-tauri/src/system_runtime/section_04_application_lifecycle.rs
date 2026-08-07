#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApplicationLifecyclePhase {
    Active = 0,
    Suspending = 1,
    Suspended = 2,
    Resuming = 3,
    Degraded = 4,
}

impl ApplicationLifecyclePhase {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Suspending,
            2 => Self::Suspended,
            3 => Self::Resuming,
            4 => Self::Degraded,
            _ => Self::Active,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Suspending => "suspending",
            Self::Suspended => "suspended",
            Self::Resuming => "resuming",
            Self::Degraded => "degraded",
        }
    }
}

#[derive(Clone)]
struct ApplicationLifecycleSignal {
    reason: String,
    suspended: bool,
}

#[derive(Clone)]
struct DeferredSurfaceRecovery {
    generation: u64,
    parent_operation_id: Option<String>,
    reason: String,
    retry_terminal: bool,
    role_id: String,
}

const DEFERRED_SURFACE_RECOVERY_CAPACITY: usize = 32;

struct ApplicationLifecycleCoordinator {
    changed: watch::Sender<u64>,
    deferred_surface_recoveries: Mutex<HashMap<String, DeferredSurfaceRecovery>>,
    phase: AtomicU8,
    navigation_waiters: Mutex<Vec<Weak<NavigationTracker>>>,
    record: Mutex<ApplicationLifecycleStatusRecord>,
    role_input_epochs: Mutex<HashMap<String, u64>>,
    suspended: AtomicBool,
}

impl ApplicationLifecycleCoordinator {
    fn new() -> Self {
        Self::new_for_platform(current_runtime_platform())
    }

    fn new_for_platform(platform: &'static str) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            changed,
            deferred_surface_recoveries: Mutex::new(HashMap::new()),
            phase: AtomicU8::new(ApplicationLifecyclePhase::Active as u8),
            navigation_waiters: Mutex::new(Vec::new()),
            record: Mutex::new(ApplicationLifecycleStatusRecord {
                revision: 1,
                captured_at: chrono::Utc::now().to_rfc3339(),
                lifecycle_epoch: 0,
                state: "active".to_owned(),
                reason: "startup".to_owned(),
                platform: platform.to_owned(),
            }),
            role_input_epochs: Mutex::new(HashMap::new()),
            suspended: AtomicBool::new(false),
        }
    }

    fn current(&self) -> ApplicationLifecycleStatusRecord {
        self.record
            .lock()
            .map(|record| record.clone())
            .unwrap_or_else(|_| ApplicationLifecycleStatusRecord {
                revision: 0,
                captured_at: chrono::Utc::now().to_rfc3339(),
                lifecycle_epoch: APPLICATION_LIFECYCLE_EPOCH.load(Ordering::Acquire),
                state: "degraded".to_owned(),
                reason: "lifecycle-state-unavailable".to_owned(),
                platform: current_runtime_platform().to_owned(),
            })
    }

    fn transition(
        &self,
        phase: ApplicationLifecyclePhase,
        epoch: u64,
        reason: &str,
    ) -> ApplicationLifecycleStatusRecord {
        self.phase.store(phase as u8, Ordering::Release);
        let Ok(mut record) = self.record.lock() else {
            return self.current();
        };
        record.revision = record.revision.wrapping_add(1).max(1);
        record.captured_at = chrono::Utc::now().to_rfc3339();
        record.lifecycle_epoch = epoch;
        record.state = phase.as_str().to_owned();
        record.reason = reason.to_owned();
        let next = record.clone();
        drop(record);
        self.changed.send_replace(epoch);
        self.notify_navigation_waiters();
        next
    }

    fn epoch(&self) -> u64 {
        self.record
            .lock()
            .map(|record| record.lifecycle_epoch)
            .unwrap_or_else(|_| APPLICATION_LIFECYCLE_EPOCH.load(Ordering::Acquire))
    }

    fn accepts_native_work(&self) -> bool {
        !self.suspended.load(Ordering::Acquire)
            && matches!(
                ApplicationLifecyclePhase::from_raw(self.phase.load(Ordering::Acquire)),
                ApplicationLifecyclePhase::Active | ApplicationLifecyclePhase::Degraded
            )
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn register_navigation_waiter(&self, navigation: &Arc<NavigationTracker>) {
        if let Ok(mut waiters) = self.navigation_waiters.lock() {
            waiters.retain(|waiter| waiter.strong_count() > 0);
            waiters.push(Arc::downgrade(navigation));
        }
    }

    fn notify_navigation_waiters(&self) {
        let waiters = self
            .navigation_waiters
            .lock()
            .map(|mut waiters| {
                let live = waiters.iter().filter_map(Weak::upgrade).collect::<Vec<_>>();
                waiters.retain(|waiter| waiter.strong_count() > 0);
                live
            })
            .unwrap_or_default();
        for waiter in waiters {
            waiter.wake();
        }
    }

    fn defer_surface_recovery(
        &self,
        role_id: String,
        reason: String,
        generation: u64,
        parent_operation_id: Option<String>,
        retry_terminal: bool,
    ) -> bool {
        let Ok(mut deferred) = self.deferred_surface_recoveries.lock() else {
            return false;
        };
        if deferred
            .get(&role_id)
            .is_some_and(|existing| existing.generation > generation)
        {
            return true;
        }
        if !deferred.contains_key(&role_id)
            && deferred.len() >= DEFERRED_SURFACE_RECOVERY_CAPACITY
        {
            return false;
        }
        deferred.insert(
            role_id.clone(),
            DeferredSurfaceRecovery {
                generation,
                parent_operation_id,
                reason,
                retry_terminal,
                role_id,
            },
        );
        true
    }

    fn take_deferred_surface_recoveries(&self) -> Vec<DeferredSurfaceRecovery> {
        self.deferred_surface_recoveries
            .lock()
            .map(|mut deferred| deferred.drain().map(|(_, recovery)| recovery).collect())
            .unwrap_or_default()
    }

    fn replace_role_input_epochs(&self, epochs: HashMap<String, u64>) {
        if let Ok(mut stored) = self.role_input_epochs.lock() {
            *stored = epochs;
        }
    }

    fn remember_role_input_epoch(&self, role_id: &str, input_epoch: u64) {
        if let Ok(mut epochs) = self.role_input_epochs.lock() {
            epochs.insert(role_id.to_owned(), input_epoch);
        }
    }

    fn role_input_epochs(&self) -> HashMap<String, u64> {
        self.role_input_epochs
            .lock()
            .map(|epochs| epochs.clone())
            .unwrap_or_default()
    }
}

impl SystemRuntimeExecutor {
    fn application_lifecycle_epoch_matches(&self, expected_epoch: u64) -> bool {
        self.application_lifecycle.accepts_native_work()
            && self.lifecycle_epoch() == expected_epoch
    }

    fn require_application_lifecycle_epoch(&self, expected_epoch: u64) -> RuntimeResult<()> {
        if self.application_lifecycle_epoch_matches(expected_epoch) {
            Ok(())
        } else {
            Err(RuntimeError::new(
                "SYSTEM_LIFECYCLE_STALE",
                "The native operation was accepted before the current application lifecycle epoch.",
            ))
        }
    }

    async fn wait_role_navigation_for_lifecycle(
        &self,
        pending: &PendingRoleNavigation,
        operation: NativeOperationContext,
    ) -> NativeOperationReceipt {
        let mut lifecycle_changed = self.application_lifecycle.subscribe();
        let navigation_wait = pending
            .navigation
            .wait_operation_async(operation.clone());
        tokio::pin!(navigation_wait);
        loop {
            tokio::select! {
                receipt = &mut navigation_wait => {
                    if !self.application_lifecycle_epoch_matches(pending.lifecycle_epoch) {
                        pending.navigation.reset();
                        return self.operations.terminal(&operation.operation_id).unwrap_or_else(|| {
                            NativeOperationReceipt::with_status(
                                operation,
                                "applicationLifecycleInterrupted",
                                NativeOperationStatus::Indeterminate,
                                Some("SYSTEM_LIFECYCLE_INDETERMINATE"),
                            )
                        });
                    }
                    return self.operations.terminal(&operation.operation_id).unwrap_or(receipt);
                }
                changed = lifecycle_changed.changed() => {
                    if changed.is_err()
                        || !self.application_lifecycle_epoch_matches(pending.lifecycle_epoch)
                    {
                        pending.navigation.reset();
                        return self.operations.terminal(&operation.operation_id).unwrap_or_else(|| {
                            NativeOperationReceipt::with_status(
                                operation,
                                "applicationLifecycleInterrupted",
                                NativeOperationStatus::Indeterminate,
                                Some("SYSTEM_LIFECYCLE_INDETERMINATE"),
                            )
                        });
                    }
                }
            }
        }
    }

    fn start_application_lifecycle_actor(self: &Arc<Self>) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel::<ApplicationLifecycleSignal>();
        self.lifecycle_sender
            .set(sender)
            .map_err(|_| "The application lifecycle actor was already started.".to_owned())?;
        let runtime = Arc::downgrade(self);
        thread::Builder::new()
            .name("rion-application-lifecycle".to_owned())
            .spawn(move || {
                while let Ok(signal) = receiver.recv() {
                    let Some(runtime) = runtime.upgrade() else {
                        return;
                    };
                    runtime.process_application_lifecycle_signal(signal);
                }
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn enqueue_application_lifecycle_signal(
        &self,
        suspended: bool,
        reason: impl Into<String>,
    ) -> bool {
        self.lifecycle_sender.get().is_some_and(|sender| {
            sender
                .send(ApplicationLifecycleSignal {
                    reason: reason.into(),
                    suspended,
                })
                .is_ok()
        })
    }

    pub(crate) fn application_lifecycle_status(&self) -> ApplicationLifecycleStatusRecord {
        self.application_lifecycle.current()
    }

    pub(crate) fn lifecycle_epoch(&self) -> u64 {
        self.application_lifecycle.epoch()
    }

    fn emit_application_lifecycle(&self, record: &ApplicationLifecycleStatusRecord) {
        let _ = self.app.emit("rion://application-lifecycle", record.clone());
    }

    fn transition_application_lifecycle(
        &self,
        phase: ApplicationLifecyclePhase,
        epoch: u64,
        reason: &str,
    ) -> ApplicationLifecycleStatusRecord {
        let record = self.application_lifecycle.transition(phase, epoch, reason);
        self.emit_application_lifecycle(&record);
        record
    }

    fn process_application_lifecycle_signal(self: &Arc<Self>, signal: ApplicationLifecycleSignal) {
        if signal.suspended {
            self.suspend_application_runtime(&signal.reason);
        } else {
            self.resume_application_runtime(&signal.reason);
        }
    }

    fn suspend_application_runtime(&self, reason: &str) {
        if self.application_lifecycle.suspended.swap(true, Ordering::AcqRel) {
            self.emit_application_lifecycle(&self.application_lifecycle.current());
            return;
        }
        let epoch = self.lifecycle_epoch().saturating_add(1);
        set_application_lifecycle_epoch(epoch);
        self.main_window_actor.advance_lifecycle_epoch(epoch);
        self.focus_broker.revoke_all();
        self.transition_application_lifecycle(ApplicationLifecyclePhase::Suspending, epoch, reason);
        self.operations.interrupt_for_lifecycle();
        self.cancel_pending_surface_continuations(
            None,
            "SYSTEM_SURFACE_LIFECYCLE_CANCELLED",
            "Application suspension ended the pending native close continuation.",
        );
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Power,
            "applicationSuspend",
            POWER_LIFECYCLE_OPERATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::LifecycleTransition)
        .with_lifecycle_epoch(epoch);
        let registered = self.operations.register(operation.clone()).is_ok();
        if registered {
            self.operations.mark_in_flight(&operation.operation_id);
        }
        let mut failures = Vec::new();
        let role_ids = self
            .state
            .lock()
            .map(|state| state.role_tabs.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        self.application_lifecycle
            .replace_role_input_epochs(HashMap::new());
        for role_id in role_ids {
            match self.fence_role_for_application_suspend(&role_id) {
                Ok(_) => {}
                Err(error) => failures.push(error.code.to_owned()),
            }
        }
        if self
            .core
            .invoke(CoreCommand::BrowserRuntimeSuspend { suspended: true })
            .is_err()
        {
            failures.push("SYSTEM_LIFECYCLE_CORE_SUSPEND_FAILED".to_owned());
        }
        if self.persist_all_game_window_placements().is_err()
            || self.persist_restore_session(false).is_err()
        {
            failures.push("SYSTEM_LIFECYCLE_PERSIST_FAILED".to_owned());
        }
        let degraded = !failures.is_empty();
        self.transition_application_lifecycle(
            if degraded {
                ApplicationLifecyclePhase::Degraded
            } else {
                ApplicationLifecyclePhase::Suspended
            },
            epoch,
            reason,
        );
        let receipt = NativeOperationReceipt::with_status(
            operation,
            "applicationSuspended",
            if degraded {
                NativeOperationStatus::Degraded
            } else {
                NativeOperationStatus::Applied
            },
            degraded.then_some("SYSTEM_LIFECYCLE_SUSPEND_DEGRADED"),
        );
        if registered {
            self.operations.complete(receipt);
        } else {
            self.operations.record_untracked(receipt);
        }
    }

    fn fence_role_for_application_suspend(&self, role_id: &str) -> RuntimeResult<u64> {
        let fenced = self
            .core
            .invoke(CoreCommand::MacroInputFence {
                role_id: role_id.to_owned(),
            })
            .map_err(RuntimeError::core)
            .and_then(|value| {
                serde_json::from_value::<MacroInputEpochRecord>(value).map_err(|error| {
                    RuntimeError::new("TAURI_CORE_RESULT_INVALID", error.to_string())
                })
            })?;
        self.application_lifecycle
            .remember_role_input_epoch(role_id, fenced.input_epoch);
        self.install_role_input_fence(role_id, fenced.input_epoch, "application-suspend", None)?;
        let drained = self
            .core
            .invoke(CoreCommand::MacroInputDrain {
                role_id: role_id.to_owned(),
                input_epoch: fenced.input_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if !drained {
            return Err(RuntimeError::new(
                "SYSTEM_LIFECYCLE_INPUT_DRAIN_FAILED",
                "Automatic input did not drain before application suspension.",
            ));
        }
        if let Ok(mut state) = self.state.lock()
            && let Some(fence) = state.role_input_fences.get_mut(role_id)
            && fence.input_epoch == fenced.input_epoch
        {
            fence.drained = true;
        }
        self.clear_role_keys(role_id);
        Ok(fenced.input_epoch)
    }

    fn resume_application_runtime(self: &Arc<Self>, reason: &str) {
        if !self.application_lifecycle.suspended.load(Ordering::Acquire) {
            self.emit_application_lifecycle(&self.application_lifecycle.current());
            return;
        }
        let epoch = self.lifecycle_epoch();
        self.transition_application_lifecycle(ApplicationLifecyclePhase::Resuming, epoch, reason);
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Power,
            "applicationResume",
            POWER_LIFECYCLE_OPERATION_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::LifecycleTransition)
        .with_lifecycle_epoch(epoch);
        let registered = self.operations.register(operation.clone()).is_ok();
        if registered {
            self.operations.mark_in_flight(&operation.operation_id);
        }
        let mut degraded = self
            .core
            .invoke(CoreCommand::BrowserRuntimeSuspend { suspended: false })
            .is_err();
        for (role_id, input_epoch) in self.application_lifecycle.role_input_epochs() {
            degraded |= !self.resume_role_after_application_wake(&role_id, input_epoch);
        }
        self.application_lifecycle.suspended.store(false, Ordering::Release);
        self.application_lifecycle.replace_role_input_epochs(HashMap::new());
        self.publish_projection();
        self.publish_main_window_state();
        let final_phase = if degraded {
            ApplicationLifecyclePhase::Degraded
        } else {
            ApplicationLifecyclePhase::Active
        };
        self.transition_application_lifecycle(final_phase, epoch, reason);
        let live_window_ids = self
            .presentation
            .snapshot_states()
            .map(|windows| windows.into_keys().collect::<Vec<_>>())
            .unwrap_or_default();
        for window_id in live_window_ids {
            self.reconcile_surface_membership(&window_id, "application-resume");
        }
        let receipt = NativeOperationReceipt::with_status(
            operation,
            "applicationResumed",
            if degraded {
                NativeOperationStatus::Degraded
            } else {
                NativeOperationStatus::Applied
            },
            degraded.then_some("SYSTEM_LIFECYCLE_RESUME_DEGRADED"),
        );
        if registered {
            self.operations.complete(receipt);
        } else {
            self.operations.record_untracked(receipt);
        }
        for recovery in self
            .application_lifecycle
            .take_deferred_surface_recoveries()
        {
            self.schedule_surface_recovery_internal(
                recovery.role_id,
                recovery.reason,
                recovery.generation,
                recovery.parent_operation_id,
                recovery.retry_terminal,
            );
        }
        if let Some(state) = self.app.try_state::<crate::CoreState>() {
            let _ = crate::request_display_topology(&self.app, &state, "application-resume");
            crate::cancel_stale_tab_drag_after_lifecycle(&self.app, &state);
        }
    }

    fn resume_role_after_application_wake(&self, role_id: &str, input_epoch: u64) -> bool {
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
            return false;
        }
        let core_resumed = self
            .core
            .invoke(CoreCommand::MacroInputResume {
                role_id: role_id.to_owned(),
                input_epoch,
            })
            .ok()
            .and_then(|value| serde_json::from_value::<MacroInputEpochRecord>(value).ok())
            .is_some_and(|record| record.current);
        if !core_resumed {
            if let Ok(mut state) = self.state.lock()
                && let Some(fence) = state.role_input_fences.get_mut(role_id)
                && fence.input_epoch == input_epoch
            {
                fence.resuming = false;
            }
            return false;
        }
        if !self.resume_role_input(role_id, input_epoch).unwrap_or(false) {
            self.quarantine_role_input(
                role_id,
                &RuntimeError::new(
                    "SYSTEM_LIFECYCLE_INPUT_RESUME_FAILED",
                    "Native automatic input did not resume after application wake.",
                ),
            );
            return false;
        }
        self.record_input_fence_event(role_id, input_epoch, "resumed");
        if let Ok(mut state) = self.state.lock()
            && state
                .role_input_fences
                .get(role_id)
                .is_some_and(|fence| fence.input_epoch == input_epoch)
        {
            state.role_input_fences.remove(role_id);
            state
                .last_input_ready_epochs
                .insert(role_id.to_owned(), input_epoch);
            state
                .main_frame_navigation_input_fences
                .retain(|_, ticket| ticket.role_id != role_id);
        }
        self.input_readiness.notify();
        true
    }
}
