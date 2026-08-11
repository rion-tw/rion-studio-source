#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainWindowCommand {
    Minimize,
    Show { focus: bool },
    ToggleFullscreen,
    ToggleMaximized,
}

impl MainWindowCommand {
    fn requests_focus(self) -> bool {
        matches!(self, Self::Show { focus: true })
    }

    fn completion_scope(self) -> SystemRuntimeOperationCompletionScope {
        SystemRuntimeOperationCompletionScope::NativeAcknowledgement
    }

    fn awaits_window_state_event(self) -> bool {
        matches!(self, Self::ToggleMaximized)
    }

    fn success_stage(self) -> &'static str {
        match self {
            Self::Minimize => "mainWindowMinimized",
            Self::Show { .. } => "mainWindowShown",
            Self::ToggleFullscreen => "mainWindowFullscreenToggled",
            Self::ToggleMaximized => "mainWindowMaximizedToggled",
        }
    }
}

#[derive(Clone)]
struct MainWindowRequest {
    command: MainWindowCommand,
    focus_lease: Option<NativeFocusLease>,
    operation: NativeOperationContext,
}

#[derive(Default)]
struct MainWindowActorState {
    active_operation: Option<NativeOperationContext>,
    active_focus_operation: Option<NativeOperationContext>,
    pending_focus: Option<MainWindowRequest>,
    pending_maximize: Option<PendingMainWindowMaximize>,
    requests: VecDeque<MainWindowRequest>,
    stopped: bool,
}

#[derive(Clone)]
struct PendingMainWindowMaximize {
    expected_maximized: bool,
    request: MainWindowRequest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainWindowQueueError {
    Full,
    Stopped,
}

impl MainWindowActorState {
    fn enqueue(&mut self, request: MainWindowRequest) -> Result<(), MainWindowQueueError> {
        if self.stopped {
            return Err(MainWindowQueueError::Stopped);
        }
        if self.requests.len() >= MAIN_WINDOW_ACTOR_CAPACITY {
            return Err(MainWindowQueueError::Full);
        }
        self.requests.push_back(request);
        Ok(())
    }

    fn take_focus_operations(&mut self) -> Vec<NativeOperationContext> {
        let mut operations = Vec::new();
        let mut operation_ids = HashSet::new();
        self.requests.retain(|request| {
            if request.command.requests_focus() {
                if operation_ids.insert(request.operation.operation_id.clone()) {
                    operations.push(request.operation.clone());
                }
                false
            } else {
                true
            }
        });
        if let Some(pending) = self.pending_focus.take()
            && operation_ids.insert(pending.operation.operation_id.clone())
        {
            operations.push(pending.operation);
        }
        if let Some(active) = self.active_focus_operation.take()
            && operation_ids.insert(active.operation_id.clone())
        {
            operations.push(active);
        }
        operations
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MainWindowSemanticState {
    focused: bool,
    fullscreen: bool,
    maximized: bool,
    minimized: bool,
    visible: bool,
}

#[derive(Default)]
struct MainWindowStateProjection {
    lifecycle_epoch: AtomicU64,
    record: Mutex<Option<NativeWindowStateRecord>>,
    window_generation: u64,
}

impl MainWindowStateProjection {
    fn new(window_generation: u64) -> Self {
        Self {
            lifecycle_epoch: AtomicU64::new(0),
            record: Mutex::new(None),
            window_generation,
        }
    }

    fn capture(window: &WebviewWindow) -> Result<MainWindowSemanticState, String> {
        Ok(MainWindowSemanticState {
            focused: window.is_focused().map_err(|error| error.to_string())?,
            fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
            minimized: window.is_minimized().map_err(|error| error.to_string())?,
            visible: window.is_visible().map_err(|error| error.to_string())?,
        })
    }

    fn semantic(record: &NativeWindowStateRecord) -> MainWindowSemanticState {
        MainWindowSemanticState {
            focused: record.focused,
            fullscreen: record.fullscreen,
            maximized: record.maximized,
            minimized: record.minimized,
            visible: record.visible,
        }
    }

    fn refresh(
        &self,
        window: &WebviewWindow,
    ) -> Result<(NativeWindowStateRecord, bool), String> {
        let semantic = Self::capture(window)?;
        self.commit_observation(semantic)
    }

    fn commit_observation(
        &self,
        semantic: MainWindowSemanticState,
    ) -> Result<(NativeWindowStateRecord, bool), String> {
        let mut record = self
            .record
            .lock()
            .map_err(|_| "The main-window state projection is unavailable.".to_owned())?;
        if let Some(current) = record.as_ref()
            && Self::semantic(current) == semantic
            && current.lifecycle_epoch == self.lifecycle_epoch.load(Ordering::Acquire)
        {
            return Ok((current.clone(), false));
        }
        let revision = record
            .as_ref()
            .map(|current| current.revision.saturating_add(1))
            .unwrap_or(1);
        let next = NativeWindowStateRecord {
            revision,
            captured_at: chrono::Utc::now().to_rfc3339(),
            window_id: "main".to_owned(),
            window_generation: self.window_generation,
            lifecycle_epoch: self.lifecycle_epoch.load(Ordering::Acquire),
            visible: semantic.visible,
            minimized: semantic.minimized,
            maximized: semantic.maximized,
            fullscreen: semantic.fullscreen,
            focused: semantic.focused,
        };
        *record = Some(next.clone());
        Ok((next, true))
    }

}

struct MainWindowNativeOutcome {
    failure_code: Option<&'static str>,
    stage: &'static str,
    status: NativeOperationStatus,
}

enum MainWindowApplyResult {
    Terminal(MainWindowNativeOutcome),
    FocusSubmitted,
    MaximizeSubmitted { expected_maximized: bool },
}

struct MainWindowActor {
    app: AppHandle,
    focus_broker: Arc<NativeFocusBroker>,
    operations: Arc<NativeOperationRegistry>,
    projection: Arc<MainWindowStateProjection>,
    queue: Arc<(Mutex<MainWindowActorState>, Condvar)>,
    window: WebviewWindow,
}

impl MainWindowActor {
    fn start(
        app: AppHandle,
        window: WebviewWindow,
        operations: Arc<NativeOperationRegistry>,
        focus_broker: Arc<NativeFocusBroker>,
    ) -> Result<Arc<Self>, String> {
        let generation = WINDOW_GENERATION_SEQUENCE
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        let projection = Arc::new(MainWindowStateProjection::new(generation));
        projection.refresh(&window)?;
        let queue = Arc::new((
            Mutex::new(MainWindowActorState::default()),
            Condvar::new(),
        ));
        let worker_queue = Arc::clone(&queue);
        let worker_operations = Arc::clone(&operations);
        let worker_projection = Arc::clone(&projection);
        let worker_focus_broker = Arc::clone(&focus_broker);
        let worker_app = app.clone();
        let worker_window = window.clone();
        thread::Builder::new()
            .name("rion-main-window-actor".to_owned())
            .spawn(move || {
                loop {
                    let request = {
                        let (lock, changed) = &*worker_queue;
                        let Ok(mut state) = lock.lock() else {
                            return;
                        };
                        while state.requests.is_empty() && !state.stopped {
                            let Ok(next) = changed.wait(state) else {
                                return;
                            };
                            state = next;
                        }
                        if state.stopped {
                            return;
                        }
                        let Some(request) = state.requests.pop_front() else {
                            continue;
                        };
                        state.active_operation = Some(request.operation.clone());
                        state.active_focus_operation = request
                            .command
                            .requests_focus()
                            .then(|| request.operation.clone());
                        request
                    };
                    if !worker_operations.mark_in_flight(&request.operation.operation_id) {
                        Self::clear_active(&worker_queue, &request.operation.operation_id);
                        continue;
                    }
                    let outcome = apply_main_window_request(
                        &worker_app,
                        &worker_window,
                        &worker_focus_broker,
                        &request,
                    );
                    match outcome {
                        MainWindowApplyResult::Terminal(outcome) => {
                            worker_operations.complete(NativeOperationReceipt::with_status(
                                request.operation.clone(),
                                outcome.stage,
                                outcome.status,
                                outcome.failure_code,
                            ));
                        }
                        MainWindowApplyResult::FocusSubmitted => {
                            Self::install_pending_focus(
                                &worker_queue,
                                &worker_operations,
                                &worker_focus_broker,
                                request.clone(),
                            );
                        }
                        MainWindowApplyResult::MaximizeSubmitted { expected_maximized } => {
                            Self::install_pending_maximize(
                                &worker_queue,
                                &worker_operations,
                                request.clone(),
                                expected_maximized,
                            );
                        }
                    }
                    Self::clear_active(&worker_queue, &request.operation.operation_id);
                    if let Ok((record, changed)) = worker_projection.refresh(&worker_window)
                        && changed
                    {
                        let _ = worker_app.emit("rion://window-state", record);
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(Self {
            app,
            focus_broker,
            operations,
            projection,
            queue,
            window,
        }))
    }

    fn clear_active(queue: &Arc<(Mutex<MainWindowActorState>, Condvar)>, operation_id: &str) {
        if let Ok(mut state) = queue.0.lock()
            && state
                .active_operation
                .as_ref()
                .is_some_and(|operation| operation.operation_id == operation_id)
        {
            state.active_operation = None;
            state.active_focus_operation = None;
        }
    }

    fn install_pending_focus(
        queue: &Arc<(Mutex<MainWindowActorState>, Condvar)>,
        operations: &NativeOperationRegistry,
        focus_broker: &NativeFocusBroker,
        request: MainWindowRequest,
    ) {
        let Some(lease) = request.focus_lease.as_ref() else {
            operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowFocusLeaseMissing",
                NativeOperationStatus::Failed,
                Some("MAIN_WINDOW_FOCUS_LEASE_MISSING"),
            ));
            return;
        };
        let Ok(mut state) = queue.0.lock() else {
            operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorUnavailable",
                NativeOperationStatus::Failed,
                Some("MAIN_WINDOW_ACTOR_UNAVAILABLE"),
            ));
            return;
        };
        if state.stopped || !focus_broker.is_current(lease) {
            drop(state);
            operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowFocusSuperseded",
                NativeOperationStatus::Superseded,
                None,
            ));
            return;
        }
        if focus_broker.is_confirmed(lease) {
            drop(state);
            operations.complete(NativeOperationReceipt::applied(
                request.operation,
                "mainWindowFocused",
            ));
            return;
        }
        let replaced = state.pending_focus.replace(request);
        drop(state);
        if let Some(replaced) = replaced {
            operations.complete(NativeOperationReceipt::with_status(
                replaced.operation,
                "mainWindowFocusSuperseded",
                NativeOperationStatus::Superseded,
                None,
            ));
        }
    }

    fn install_pending_maximize(
        queue: &Arc<(Mutex<MainWindowActorState>, Condvar)>,
        operations: &NativeOperationRegistry,
        request: MainWindowRequest,
        expected_maximized: bool,
    ) {
        let Ok(mut state) = queue.0.lock() else {
            operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorUnavailable",
                NativeOperationStatus::Failed,
                Some("MAIN_WINDOW_ACTOR_UNAVAILABLE"),
            ));
            return;
        };
        if state.stopped {
            drop(state);
            operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorStopped",
                NativeOperationStatus::Cancelled,
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
            return;
        }
        let replaced = state.pending_maximize.replace(PendingMainWindowMaximize {
            expected_maximized,
            request,
        });
        drop(state);
        if let Some(replaced) = replaced {
            operations.complete(NativeOperationReceipt::with_status(
                replaced.request.operation,
                "mainWindowMaximizeSuperseded",
                NativeOperationStatus::Superseded,
                None,
            ));
        }
    }

    fn generation(&self) -> u64 {
        self.projection.window_generation
    }

    fn dispatch(&self, request: MainWindowRequest) {
        let (lock, changed) = &*self.queue;
        let Ok(mut state) = lock.lock() else {
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorUnavailable",
                NativeOperationStatus::Failed,
                Some("MAIN_WINDOW_ACTOR_UNAVAILABLE"),
            ));
            return;
        };
        let terminal_status = if request.command.requests_focus() {
            Some((
                "mainWindowFocusSuperseded",
                NativeOperationStatus::Superseded,
                None,
            ))
        } else if request.command == MainWindowCommand::Minimize {
            self.focus_broker.revoke_window("main", self.generation());
            Some((
                "mainWindowFocusCancelled",
                NativeOperationStatus::Cancelled,
                Some("MAIN_WINDOW_FOCUS_CANCELLED"),
            ))
        } else {
            None
        };
        let displaced = if terminal_status.is_some() {
            state.take_focus_operations()
        } else {
            Vec::new()
        };
        if let Err(error) = state.enqueue(request.clone()) {
            let (stage, code) = match error {
                MainWindowQueueError::Full => ("mainWindowQueueFull", "MAIN_WINDOW_QUEUE_FULL"),
                MainWindowQueueError::Stopped => {
                    ("mainWindowActorStopped", "MAIN_WINDOW_ACTOR_STOPPED")
                }
            };
            drop(state);
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                stage,
                NativeOperationStatus::Failed,
                Some(code),
            ));
            if let Some((displaced_stage, displaced_status, displaced_code)) = terminal_status {
                for operation in displaced {
                    self.operations.complete(NativeOperationReceipt::with_status(
                        operation,
                        displaced_stage,
                        displaced_status,
                        displaced_code,
                    ));
                }
            }
            return;
        }
        drop(state);
        if let Some((stage, status, code)) = terminal_status {
            for operation in displaced {
                self.operations.complete(NativeOperationReceipt::with_status(
                    operation,
                    stage,
                    status,
                    code,
                ));
            }
        }
        changed.notify_one();
    }

    fn state(&self) -> Result<NativeWindowStateRecord, String> {
        self.projection.refresh(&self.window).map(|(state, _)| state)
    }

    fn publish_state(&self) -> Result<NativeWindowStateRecord, String> {
        let (record, changed) = self.projection.refresh(&self.window)?;
        let pending = self.queue.0.lock().ok().and_then(|mut state| {
            state.pending_maximize.take_if(|pending| {
                pending.expected_maximized == record.maximized
            })
        });
        if let Some(pending) = pending {
            self.operations.complete(NativeOperationReceipt::applied(
                pending.request.operation,
                "mainWindowMaximizedToggled",
            ));
        }
        if changed {
            let _ = self.app.emit("rion://window-state", record.clone());
        }
        Ok(record)
    }

    fn advance_lifecycle_epoch(&self, epoch: u64) {
        self.projection
            .lifecycle_epoch
            .store(epoch, Ordering::Release);
        self.cancel_focus_continuations(
            "mainWindowFocusLifecycleCancelled",
            "MAIN_WINDOW_FOCUS_LIFECYCLE_CANCELLED",
        );
        self.cancel_maximize_continuation(
            "mainWindowMaximizeLifecycleCancelled",
            "MAIN_WINDOW_MAXIMIZE_LIFECYCLE_CANCELLED",
        );
    }

    fn observe_focus(&self, focused: bool) {
        if focused {
            let lease = self.focus_broker.observe_native_focus(
                "main",
                self.generation(),
                self.projection.lifecycle_epoch.load(Ordering::Acquire),
                None,
            );
            let pending = lease.as_ref().and_then(|lease| {
                self.queue.0.lock().ok().and_then(|mut state| {
                    state.pending_focus.take_if(|request| {
                        request.focus_lease.as_ref() == Some(lease)
                            && request.operation.window_generation
                                == Some(lease.window_generation)
                            && request.operation.lifecycle_epoch == Some(lease.lifecycle_epoch)
                    })
                })
            });
            if let Some(pending) = pending {
                self.operations.complete(NativeOperationReceipt::applied(
                    pending.operation,
                    "mainWindowFocused",
                ));
            }
        } else {
            self.focus_broker
                .observe_native_blur("main", self.generation());
            self.cancel_focus_continuations(
                "mainWindowFocusBlurCancelled",
                "MAIN_WINDOW_FOCUS_BLUR_CANCELLED",
            );
        }
        let _ = self.publish_state();
    }

    fn cancel_focus_continuations(&self, stage: &'static str, code: &'static str) {
        self.focus_broker.revoke_window("main", self.generation());
        let operations = self
            .queue
            .0
            .lock()
            .map(|mut state| state.take_focus_operations())
            .unwrap_or_default();
        for operation in operations {
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                stage,
                NativeOperationStatus::Cancelled,
                Some(code),
            ));
        }
    }

    fn cancel_maximize_continuation(&self, stage: &'static str, code: &'static str) {
        let pending = self
            .queue
            .0
            .lock()
            .ok()
            .and_then(|mut state| state.pending_maximize.take());
        if let Some(pending) = pending {
            self.operations.complete(NativeOperationReceipt::with_status(
                pending.request.operation,
                stage,
                NativeOperationStatus::Cancelled,
                Some(code),
            ));
        }
    }

    fn stop(&self) {
        let (lock, changed) = &*self.queue;
        let Ok(mut state) = lock.lock() else {
            return;
        };
        if state.stopped {
            return;
        }
        state.stopped = true;
        if let Some(request) = state.pending_focus.take() {
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorStopped",
                NativeOperationStatus::Cancelled,
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
        }
        if let Some(pending) = state.pending_maximize.take() {
            self.operations.complete(NativeOperationReceipt::with_status(
                pending.request.operation,
                "mainWindowActorStopped",
                NativeOperationStatus::Cancelled,
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
        }
        if let Some(operation) = state.active_operation.take() {
            let focus_active = state
                .active_focus_operation
                .take()
                .is_some_and(|focus| focus.operation_id == operation.operation_id);
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "mainWindowActorStopped",
                if focus_active {
                    NativeOperationStatus::Cancelled
                } else {
                    NativeOperationStatus::Failed
                },
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
        }
        for request in state.requests.drain(..) {
            let status = if request.command.requests_focus() {
                NativeOperationStatus::Cancelled
            } else {
                NativeOperationStatus::Failed
            };
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorStopped",
                status,
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
        }
        changed.notify_all();
    }
}

impl Drop for MainWindowActor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn apply_main_window_request(
    app: &AppHandle,
    window: &WebviewWindow,
    focus_broker: &Arc<NativeFocusBroker>,
    request: &MainWindowRequest,
) -> MainWindowApplyResult {
    let (sender, receiver) = mpsc::sync_channel(1);
    let callback_app = app.clone();
    let callback_window = window.clone();
    let callback_focus_broker = Arc::clone(focus_broker);
    let command = request.command;
    let focus_lease = request.focus_lease.clone();
    let scheduled = window.run_on_main_thread(move || {
        let result = apply_main_window_command(
            &callback_app,
            &callback_window,
            &callback_focus_broker,
            command,
            focus_lease.as_ref(),
        );
        let _ = sender.send(result);
    });
    if scheduled.is_err() {
        return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_DISPATCH_FAILED"),
            stage: "mainWindowDispatchFailed",
            status: NativeOperationStatus::Failed,
        });
    }
    receiver
        .recv()
        .unwrap_or(MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_ACTOR_STOPPED"),
            stage: "mainWindowCallbackCancelled",
            status: NativeOperationStatus::Cancelled,
        }))
}

fn apply_main_window_command(
    app: &AppHandle,
    window: &WebviewWindow,
    focus_broker: &NativeFocusBroker,
    command: MainWindowCommand,
    focus_lease: Option<&NativeFocusLease>,
) -> MainWindowApplyResult {
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    if command.requests_focus() {
        let Some(focus_lease) = focus_lease else {
            return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_FOCUS_LEASE_MISSING"),
                stage: "mainWindowFocusLeaseMissing",
                status: NativeOperationStatus::Failed,
            });
        };
        let focus_guard = focus_broker.begin_mutation(focus_lease);
        let Ok(Some(_guard)) = focus_guard else {
            return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: None,
                stage: "mainWindowFocusSuperseded",
                status: NativeOperationStatus::Superseded,
            });
        };
        if !focus_broker.mark_submitted(focus_lease) {
            return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: None,
                stage: "mainWindowFocusSuperseded",
                status: NativeOperationStatus::Superseded,
            });
        }
        let mut native_failed = false;
        #[cfg(target_os = "macos")]
        {
            native_failed |= app.show().is_err();
            let _ = crate::quick_menu_macos::activate_application();
        }
        native_failed |= request_platform_webview_window_show_foreground(window).is_err();
        return if native_failed {
            focus_broker.revoke_lease(focus_lease);
            MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_NATIVE_FAILED"),
                stage: "mainWindowNativeFailed",
                status: NativeOperationStatus::Failed,
            })
        } else {
            MainWindowApplyResult::FocusSubmitted
        };
    }
    let before = match MainWindowStateProjection::capture(window) {
        Ok(before) => before,
        Err(_) => {
            return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_STATE_UNAVAILABLE"),
                stage: "mainWindowReadbackFailed",
                status: NativeOperationStatus::Failed,
            });
        }
    };
    let mut native_failed = false;
    match command {
        MainWindowCommand::Minimize => {
            native_failed |= request_platform_webview_window_minimize(window).is_err();
        }
        MainWindowCommand::Show { focus: false } => {
            #[cfg(target_os = "macos")]
            {
                native_failed |= app.show().is_err();
            }
            if before.minimized && !cfg!(windows) {
                native_failed |= window.unminimize().is_err();
            }
            native_failed |= request_platform_webview_window_show(window).is_err();
        }
        MainWindowCommand::Show { focus: true } => unreachable!(),
        MainWindowCommand::ToggleFullscreen => {
            native_failed |= request_platform_webview_window_set_fullscreen(
                window,
                !before.fullscreen,
            )
            .is_err();
        }
        MainWindowCommand::ToggleMaximized => {
            return match request_platform_webview_window_toggle_maximized(window) {
                Ok(expected_maximized) => {
                    MainWindowApplyResult::MaximizeSubmitted { expected_maximized }
                }
                Err(_) => MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                    failure_code: Some("MAIN_WINDOW_NATIVE_FAILED"),
                    stage: "mainWindowNativeFailed",
                    status: NativeOperationStatus::Failed,
                }),
            };
        }
    }
    if native_failed {
        return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_NATIVE_FAILED"),
            stage: "mainWindowNativeFailed",
            status: NativeOperationStatus::Failed,
        });
    }
    let after = match MainWindowStateProjection::capture(window) {
        Ok(after) => after,
        Err(_) => {
            return MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_STATE_UNAVAILABLE"),
                stage: "mainWindowReadbackFailed",
                status: NativeOperationStatus::Degraded,
            });
        }
    };
    let matches_readback = main_window_readback_matches(command, &before, &after);
    MainWindowApplyResult::Terminal(MainWindowNativeOutcome {
        failure_code: (!matches_readback).then_some("MAIN_WINDOW_STATE_UNCONFIRMED"),
        stage: if matches_readback {
            command.success_stage()
        } else {
            "mainWindowReadbackUnconfirmed"
        },
        status: if matches_readback {
            NativeOperationStatus::Applied
        } else {
            NativeOperationStatus::Degraded
        },
    })
}

fn main_window_readback_matches(
    command: MainWindowCommand,
    before: &MainWindowSemanticState,
    after: &MainWindowSemanticState,
) -> bool {
    main_window_readback_matches_for_platform(command, before, after, cfg!(windows))
}

fn main_window_readback_matches_for_platform(
    command: MainWindowCommand,
    before: &MainWindowSemanticState,
    after: &MainWindowSemanticState,
    _is_windows: bool,
) -> bool {
    match command {
        MainWindowCommand::Minimize => after.minimized && after.visible,
        MainWindowCommand::Show { focus: false } => after.visible,
        MainWindowCommand::Show { focus: true } => {
            unreachable!("focused show is acknowledged only by WindowEvent::Focused")
        }
        MainWindowCommand::ToggleFullscreen => after.fullscreen != before.fullscreen,
        MainWindowCommand::ToggleMaximized => false,
    }
}

fn wait_main_window_presentation_failure(
    operations: &NativeOperationRegistry,
    operation_id: &str,
) -> Option<String> {
    match operations.wait(operation_id) {
        Ok(receipt)
            if matches!(
                receipt.status,
                NativeOperationStatus::Applied | NativeOperationStatus::Superseded
            ) =>
        {
            None
        }
        Ok(receipt) => Some(receipt.failure_code.unwrap_or_else(|| {
            format!(
                "The main-window operation completed as {}.",
                receipt.status.as_str()
            )
        })),
        Err(code) => Some(code.to_owned()),
    }
}

fn emit_main_window_presentation_failure(app: &AppHandle, cause: &str) {
    let _ = app.emit(
        "rion://shell-error",
        json!({
            "code": "MAIN_WINDOW_PRESENTATION_FAILED",
            "message": format!("The macro page could not reveal the main window: {cause}")
        }),
    );
}

fn resolve_main_window_command(
    focus_broker: &NativeFocusBroker,
    command: MainWindowCommand,
    window_generation: u64,
    lifecycle_epoch: u64,
    focus_origin: NativeFocusIntentOrigin,
) -> MainWindowCommand {
    if !matches!(command, MainWindowCommand::Show { focus: true }) {
        return command;
    }
    let admitted = focus_broker.admitted_focus(
        NativePresentationFocus::WindowAndContent,
        "main",
        window_generation,
        focus_origin,
    );
    if admitted == NativePresentationFocus::None
        || focus_broker.is_confirmed_target("main", window_generation, lifecycle_epoch)
    {
        MainWindowCommand::Show { focus: false }
    } else {
        command
    }
}

impl SystemRuntimeExecutor {
    fn submit_main_window_operation(
        &self,
        command: MainWindowCommand,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.require_runtime_accepting()?;
        let window_generation = self.main_window_actor.generation();
        let focus_origin = native_focus_intent_origin(trigger);
        let lifecycle_epoch = self.lifecycle_epoch();
        let command = resolve_main_window_command(
            &self.focus_broker,
            command,
            window_generation,
            lifecycle_epoch,
            focus_origin,
        );
        let operation = if command.requests_focus() || command.awaits_window_state_event() {
            NativeOperationContext::new_event_bound(
                NativeOperationSubsystem::Presentation,
                trigger,
            )
        } else {
            NativeOperationContext::new(
                NativeOperationSubsystem::Presentation,
                trigger,
                MAIN_WINDOW_OPERATION_TIMEOUT,
            )
        }
        .with_completion_scope(command.completion_scope())
        .with_window("main")
        .with_window_generation(window_generation)
        .with_lifecycle_epoch(lifecycle_epoch);
        self.operations.register(operation.clone()).map_err(|code| {
            RuntimeError::new(code, "The main-window operation could not be accepted.")
        })?;
        let focus_lease = matches!(command, MainWindowCommand::Show { focus: true }).then(|| {
            self.focus_broker.accept_with_origin(
                "main",
                window_generation,
                lifecycle_epoch,
                None,
                NativePresentationFocus::WindowAndContent,
                focus_origin,
            )
        });
        let operation_id = operation.operation_id.clone();
        self.main_window_actor.dispatch(MainWindowRequest {
            command,
            focus_lease,
            operation,
        });
        Ok(operation_id)
    }

    fn wait_main_window_operation(
        &self,
        operation_id: &str,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        self.operations
            .wait(operation_id)
            .map(|receipt| receipt.summary())
            .map_err(|code| RuntimeError::new(code, "The main-window receipt is unavailable."))
    }

    pub(crate) fn observe_main_window_presentation(&self, operation_id: String) {
        let operations = Arc::clone(&self.operations);
        let observer_app = self.app.clone();
        let fallback_app = self.app.clone();
        let spawn = thread::Builder::new()
            .name("rion-main-window-presentation-observer".to_owned())
            .spawn(move || {
                if let Some(cause) = wait_main_window_presentation_failure(
                    operations.as_ref(),
                    &operation_id,
                ) {
                    emit_main_window_presentation_failure(&observer_app, &cause);
                }
            });
        if let Err(error) = spawn {
            emit_main_window_presentation_failure(&fallback_app, &error.to_string());
        }
    }

    pub(crate) fn request_main_window_show(
        &self,
        focus: bool,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.submit_main_window_operation(MainWindowCommand::Show { focus }, trigger)
    }

    pub(crate) fn show_main_window(
        &self,
        focus: bool,
        trigger: &'static str,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.request_main_window_show(focus, trigger)?;
        self.wait_main_window_operation(&operation_id)
    }

    pub(crate) fn minimize_main_window(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.request_main_window_minimize(trigger)?;
        self.wait_main_window_operation(&operation_id)
    }

    pub(crate) fn request_main_window_minimize(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.submit_main_window_operation(MainWindowCommand::Minimize, trigger)
    }

    pub(crate) fn request_main_window_toggle_fullscreen(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.submit_main_window_operation(MainWindowCommand::ToggleFullscreen, trigger)
    }

    pub(crate) fn toggle_main_window_fullscreen(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.request_main_window_toggle_fullscreen(trigger)?;
        self.wait_main_window_operation(&operation_id)
    }

    pub(crate) fn toggle_main_window_maximized(
        &self,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.submit_main_window_operation(
            MainWindowCommand::ToggleMaximized,
            "renderer-toggle-maximized",
        )?;
        self.wait_main_window_operation(&operation_id)
    }

    pub(crate) fn main_window_state(&self) -> RuntimeResult<NativeWindowStateRecord> {
        self.main_window_actor.state().map_err(|message| {
            RuntimeError::new("MAIN_WINDOW_STATE_UNAVAILABLE", message)
        })
    }

    pub(crate) fn publish_main_window_state(&self) {
        let _ = self.main_window_actor.publish_state();
    }

    pub(crate) fn observe_main_window_focus(&self, focused: bool) {
        self.main_window_actor.observe_focus(focused);
    }
}
