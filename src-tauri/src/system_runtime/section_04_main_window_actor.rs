#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainWindowCommand {
    Hide,
    Show { focus: bool },
    StartDragging,
    ToggleFullscreen,
    ToggleMaximized,
}

impl MainWindowCommand {
    fn completion_scope(self) -> SystemRuntimeOperationCompletionScope {
        if matches!(self, Self::StartDragging) {
            SystemRuntimeOperationCompletionScope::NativeSubmission
        } else {
            SystemRuntimeOperationCompletionScope::NativeAcknowledgement
        }
    }

    fn success_stage(self) -> &'static str {
        match self {
            Self::Hide => "mainWindowHidden",
            Self::Show { .. } => "mainWindowShown",
            Self::StartDragging => "mainWindowDragSubmitted",
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
    requests: VecDeque<MainWindowRequest>,
    stopped: bool,
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
                    worker_operations.complete(NativeOperationReceipt::with_status(
                        request.operation.clone(),
                        outcome.stage,
                        outcome.status,
                        outcome.failure_code,
                    ));
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
        if let Err(error) = state.enqueue(request.clone()) {
            let (stage, code) = match error {
                MainWindowQueueError::Full => ("mainWindowQueueFull", "MAIN_WINDOW_QUEUE_FULL"),
                MainWindowQueueError::Stopped => {
                    ("mainWindowActorStopped", "MAIN_WINDOW_ACTOR_STOPPED")
                }
            };
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                stage,
                NativeOperationStatus::Failed,
                Some(code),
            ));
            return;
        }
        changed.notify_one();
    }

    fn state(&self) -> Result<NativeWindowStateRecord, String> {
        self.projection.refresh(&self.window).map(|(state, _)| state)
    }

    fn publish_state(&self) -> Result<NativeWindowStateRecord, String> {
        let (record, changed) = self.projection.refresh(&self.window)?;
        if changed {
            let _ = self.app.emit("rion://window-state", record.clone());
        }
        Ok(record)
    }

    fn advance_lifecycle_epoch(&self, epoch: u64) {
        self.projection
            .lifecycle_epoch
            .store(epoch, Ordering::Release);
    }

    fn observe_focus(&self, focused: bool) {
        if focused {
            self.focus_broker.observe_native_focus(
                "main",
                self.generation(),
                self.projection.lifecycle_epoch.load(Ordering::Acquire),
                None,
            );
        } else {
            self.focus_broker
                .observe_native_blur("main", self.generation());
        }
        let _ = self.publish_state();
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
        if let Some(operation) = state.active_operation.take() {
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "mainWindowActorStopped",
                NativeOperationStatus::Failed,
                Some("MAIN_WINDOW_ACTOR_STOPPED"),
            ));
        }
        for request in state.requests.drain(..) {
            self.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "mainWindowActorStopped",
                NativeOperationStatus::Failed,
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
) -> MainWindowNativeOutcome {
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
        return MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_DISPATCH_FAILED"),
            stage: "mainWindowDispatchFailed",
            status: NativeOperationStatus::Failed,
        };
    }
    receiver
        .recv_timeout(request.operation.remaining())
        .unwrap_or(MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_OPERATION_INDETERMINATE"),
            stage: "mainWindowCallbackTimeout",
            status: NativeOperationStatus::Indeterminate,
        })
}

fn apply_main_window_command(
    app: &AppHandle,
    window: &WebviewWindow,
    focus_broker: &NativeFocusBroker,
    command: MainWindowCommand,
    focus_lease: Option<&NativeFocusLease>,
) -> MainWindowNativeOutcome {
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    let before = match MainWindowStateProjection::capture(window) {
        Ok(before) => before,
        Err(_) => {
            return MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_STATE_UNAVAILABLE"),
                stage: "mainWindowReadbackFailed",
                status: NativeOperationStatus::Failed,
            };
        }
    };
    let mut native_failed = false;
    let mut focus_superseded = false;
    match command {
        MainWindowCommand::Hide => {
            #[cfg(windows)]
            {
                native_failed |= window.minimize().is_err();
            }
            #[cfg(not(windows))]
            {
                native_failed |= window.hide().is_err();
            }
        }
        MainWindowCommand::Show { focus } => {
            #[cfg(target_os = "macos")]
            {
                native_failed |= app.show().is_err();
            }
            if before.minimized {
                native_failed |= window.unminimize().is_err();
            }
            native_failed |= window.show().is_err();
            if focus {
                let focus_guard = focus_lease
                    .map(|lease| focus_broker.begin_mutation(lease))
                    .transpose();
                match focus_guard {
                    Ok(Some(Some(_guard))) => {
                        #[cfg(target_os = "macos")]
                        {
                            let _ = crate::quick_menu_macos::activate_application();
                        }
                        native_failed |= window.set_focus().is_err();
                        if let Some(lease) = focus_lease
                            && !focus_broker.confirm(lease)
                        {
                            focus_superseded = true;
                        }
                    }
                    Ok(Some(None)) => focus_superseded = true,
                    Ok(None) => native_failed = true,
                    Err(_) => native_failed = true,
                }
            }
        }
        MainWindowCommand::StartDragging => native_failed |= window.start_dragging().is_err(),
        MainWindowCommand::ToggleFullscreen => {
            native_failed |= window.set_fullscreen(!before.fullscreen).is_err();
        }
        MainWindowCommand::ToggleMaximized => {
            native_failed |= if before.maximized {
                window.unmaximize().is_err()
            } else {
                window.maximize().is_err()
            };
        }
    }
    if native_failed {
        return MainWindowNativeOutcome {
            failure_code: Some("MAIN_WINDOW_NATIVE_FAILED"),
            stage: "mainWindowNativeFailed",
            status: NativeOperationStatus::Failed,
        };
    }
    if focus_superseded {
        return MainWindowNativeOutcome {
            failure_code: None,
            stage: "mainWindowFocusSuperseded",
            status: NativeOperationStatus::Superseded,
        };
    }
    let after = match MainWindowStateProjection::capture(window) {
        Ok(after) => after,
        Err(_) => {
            return MainWindowNativeOutcome {
                failure_code: Some("MAIN_WINDOW_STATE_UNAVAILABLE"),
                stage: "mainWindowReadbackFailed",
                status: NativeOperationStatus::Degraded,
            };
        }
    };
    let matches_readback = main_window_readback_matches(command, &before, &after);
    MainWindowNativeOutcome {
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
    }
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
    is_windows: bool,
) -> bool {
    match command {
        MainWindowCommand::Hide => {
            if is_windows {
                after.minimized
            } else {
                !after.visible
            }
        }
        MainWindowCommand::Show { focus } => after.visible && (!focus || after.focused),
        MainWindowCommand::StartDragging => true,
        MainWindowCommand::ToggleFullscreen => after.fullscreen != before.fullscreen,
        MainWindowCommand::ToggleMaximized => after.maximized != before.maximized,
    }
}

impl SystemRuntimeExecutor {
    fn submit_main_window_operation(
        &self,
        command: MainWindowCommand,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.require_runtime_accepting()?;
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Presentation,
            trigger,
            MAIN_WINDOW_OPERATION_TIMEOUT,
        )
        .with_completion_scope(command.completion_scope())
        .with_window("main")
        .with_window_generation(self.main_window_actor.generation())
        .with_lifecycle_epoch(self.lifecycle_epoch());
        self.operations.register(operation.clone()).map_err(|code| {
            RuntimeError::new(code, "The main-window operation could not be accepted.")
        })?;
        let focus_lease = matches!(command, MainWindowCommand::Show { focus: true }).then(|| {
            self.focus_broker.accept(
                "main",
                self.main_window_actor.generation(),
                self.lifecycle_epoch(),
                None,
                NativePresentationFocus::WindowAndContent,
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

    pub(crate) fn hide_main_window(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.request_main_window_hide(trigger)?;
        self.wait_main_window_operation(&operation_id)
    }

    pub(crate) fn request_main_window_hide(
        &self,
        trigger: &'static str,
    ) -> RuntimeResult<String> {
        self.submit_main_window_operation(MainWindowCommand::Hide, trigger)
    }

    pub(crate) fn start_main_window_drag(
        &self,
    ) -> RuntimeResult<SystemRuntimeOperationSummaryRecord> {
        let operation_id = self.submit_main_window_operation(
            MainWindowCommand::StartDragging,
            "renderer-start-dragging",
        )?;
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
