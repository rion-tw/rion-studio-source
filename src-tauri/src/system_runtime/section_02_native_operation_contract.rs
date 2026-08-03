const SYSTEM_RUNTIME_CONTRACT_VERSION: u32 = 5;
const ACTIVE_NATIVE_OPERATION_CAPACITY: usize = 256;
const RECENT_NATIVE_OPERATION_CAPACITY: usize = 80;
static NATIVE_OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static APPLICATION_LIFECYCLE_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeOperationSubsystem {
    SurfaceLifecycle,
    Navigation,
    Input,
    Presentation,
    TabActivation,
    Geometry,
    Popup,
    Security,
    Session,
    Audio,
    Zoom,
    Metadata,
    Performance,
    Capability,
    Shutdown,
    DisplayTopology,
    WindowLifecycle,
    Focus,
    Drag,
    Recovery,
    Power,
}

impl NativeOperationSubsystem {
    const fn as_str(self) -> &'static str {
        match self {
            Self::SurfaceLifecycle => "surfaceLifecycle",
            Self::Navigation => "navigation",
            Self::Input => "input",
            Self::Presentation => "presentation",
            Self::TabActivation => "tabActivation",
            Self::Geometry => "geometry",
            Self::Popup => "popup",
            Self::Security => "security",
            Self::Session => "session",
            Self::Audio => "audio",
            Self::Zoom => "zoom",
            Self::Metadata => "metadata",
            Self::Performance => "performance",
            Self::Capability => "capability",
            Self::Shutdown => "shutdown",
            Self::DisplayTopology => "displayTopology",
            Self::WindowLifecycle => "windowLifecycle",
            Self::Focus => "focus",
            Self::Drag => "drag",
            Self::Recovery => "recovery",
            Self::Power => "power",
        }
    }

    const fn default_completion_scope(self) -> &'static str {
        match self {
            Self::SurfaceLifecycle
            | Self::Presentation
            | Self::Geometry
            | Self::Security
            | Self::Audio
            | Self::Zoom
            | Self::Shutdown
            | Self::DisplayTopology
            | Self::WindowLifecycle
            | Self::Focus => "nativeAcknowledgement",
            Self::TabActivation => "tabActivationConverged",
            Self::Drag => "dragCommitted",
            Self::Recovery => "inputReady",
            Self::Power => "lifecycleTransition",
            Self::Navigation => "pageFinished",
            Self::Input | Self::Metadata => "nativeSubmission",
            Self::Popup | Self::Session => "stateCommit",
            Self::Performance | Self::Capability => "runtimeProbe",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeOperationStatus {
    Applied,
    Superseded,
    Cancelled,
    Degraded,
    Failed,
    Indeterminate,
}

impl NativeOperationStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
            Self::Indeterminate => "indeterminate",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeOperationContext {
    accepted_at: String,
    completion_scope: &'static str,
    deadline: Instant,
    deadline_at: String,
    lifecycle_epoch: Option<u64>,
    operation_id: String,
    parent_operation_id: Option<String>,
    platform: &'static str,
    revision: Option<u64>,
    role_id: Option<String>,
    started_at: Instant,
    subsystem: NativeOperationSubsystem,
    surface_generation: Option<u64>,
    session_id: Option<String>,
    tab_id: Option<String>,
    timeout: Duration,
    trigger: &'static str,
    topology_revision: Option<u64>,
    window_generation: Option<u64>,
    window_id: Option<String>,
}

impl NativeOperationContext {
    fn new(
        subsystem: NativeOperationSubsystem,
        trigger: &'static str,
        timeout: Duration,
    ) -> Self {
        Self::new_for_platform(
            subsystem,
            trigger,
            timeout,
            current_runtime_platform(),
        )
    }

    fn new_for_platform(
        subsystem: NativeOperationSubsystem,
        trigger: &'static str,
        timeout: Duration,
        platform: &'static str,
    ) -> Self {
        Self::new_at_for_platform(subsystem, trigger, timeout, platform, Instant::now())
    }

    fn new_at_for_platform(
        subsystem: NativeOperationSubsystem,
        trigger: &'static str,
        timeout: Duration,
        platform: &'static str,
        started_at: Instant,
    ) -> Self {
        let sequence = NATIVE_OPERATION_SEQUENCE.fetch_add(1, Ordering::AcqRel);
        let accepted_at = chrono::Utc::now();
        let deadline_at = accepted_at
            + chrono::Duration::from_std(timeout).unwrap_or(chrono::Duration::MAX);
        Self {
            accepted_at: accepted_at.to_rfc3339(),
            completion_scope: subsystem.default_completion_scope(),
            deadline: started_at + timeout,
            deadline_at: deadline_at.to_rfc3339(),
            lifecycle_epoch: match APPLICATION_LIFECYCLE_EPOCH.load(Ordering::Acquire) {
                0 => None,
                epoch => Some(epoch),
            },
            operation_id: format!("native-{}-{sequence}", subsystem.as_str()),
            parent_operation_id: None,
            platform,
            revision: None,
            role_id: None,
            started_at,
            subsystem,
            surface_generation: None,
            session_id: None,
            tab_id: None,
            timeout,
            trigger,
            topology_revision: None,
            window_generation: None,
            window_id: None,
        }
    }

    fn with_completion_scope(mut self, completion_scope: &'static str) -> Self {
        self.completion_scope = completion_scope;
        self
    }

    fn with_parent_operation_id(mut self, operation_id: impl Into<String>) -> Self {
        self.parent_operation_id = Some(operation_id.into());
        self
    }

    fn with_revision(mut self, revision: u64) -> Self {
        self.revision = Some(revision);
        self
    }

    fn with_window_generation(mut self, generation: u64) -> Self {
        self.window_generation = Some(generation);
        self
    }

    fn with_lifecycle_epoch(mut self, epoch: u64) -> Self {
        self.lifecycle_epoch = Some(epoch);
        self
    }

    fn with_topology_revision(mut self, revision: u64) -> Self {
        self.topology_revision = Some(revision);
        self
    }

    fn with_role(mut self, role_id: impl Into<String>) -> Self {
        self.role_id = Some(role_id.into());
        self
    }

    fn with_surface_generation(mut self, generation: u64) -> Self {
        self.surface_generation = Some(generation);
        self
    }

    fn with_tab(mut self, tab_id: impl Into<String>) -> Self {
        self.tab_id = Some(tab_id.into());
        self
    }

    fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    fn with_window(mut self, window_id: impl Into<String>) -> Self {
        self.window_id = Some(window_id.into());
        self
    }

    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

fn set_application_lifecycle_epoch(epoch: u64) {
    APPLICATION_LIFECYCLE_EPOCH.store(epoch, Ordering::Release);
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeOperationReceipt {
    completed_at: String,
    context: NativeOperationContext,
    elapsed_ms: u64,
    failure_code: Option<String>,
    rollback_error_count: Option<u32>,
    stage: &'static str,
    status: NativeOperationStatus,
}

impl NativeOperationReceipt {
    fn completion_scope(&self) -> &'static str {
        self.context.completion_scope
    }

    fn applied(context: NativeOperationContext, stage: &'static str) -> Self {
        let elapsed_ms = context
            .started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        let deadline_exceeded = context.remaining().is_zero();
        Self {
            completed_at: chrono::Utc::now().to_rfc3339(),
            context,
            elapsed_ms,
            failure_code: deadline_exceeded
                .then(|| "NATIVE_OPERATION_DEADLINE_EXCEEDED".to_owned()),
            rollback_error_count: None,
            stage,
            status: if deadline_exceeded {
                NativeOperationStatus::Degraded
            } else {
                NativeOperationStatus::Applied
            },
        }
    }

    fn with_status(
        context: NativeOperationContext,
        stage: &'static str,
        status: NativeOperationStatus,
        failure_code: Option<&str>,
    ) -> Self {
        let elapsed_ms = context
            .started_at
            .elapsed()
            .as_millis()
            .min(u64::MAX as u128) as u64;
        Self {
            completed_at: chrono::Utc::now().to_rfc3339(),
            context,
            elapsed_ms,
            failure_code: failure_code.map(str::to_owned),
            rollback_error_count: None,
            stage,
            status,
        }
    }

    fn with_rollback_error_count(mut self, rollback_error_count: usize) -> Self {
        self.rollback_error_count = Some(rollback_error_count.min(u32::MAX as usize) as u32);
        self
    }

    fn summary(&self) -> SystemRuntimeOperationSummaryRecord {
        SystemRuntimeOperationSummaryRecord {
            accepted_at: self.context.accepted_at.clone(),
            captured_at: self.completed_at.clone(),
            deadline_at: self.context.deadline_at.clone(),
            platform: self.context.platform.to_owned(),
            subsystem: self.context.subsystem.as_str().to_owned(),
            status: self.status.as_str().to_owned(),
            stage: self.stage.to_owned(),
            completion_scope: self.completion_scope().to_owned(),
            operation_id: self.context.operation_id.clone(),
            trigger: self.context.trigger.to_owned(),
            elapsed_ms: self.elapsed_ms,
            timeout_ms: self
                .context
                .timeout
                .as_millis()
                .min(u64::MAX as u128) as u64,
            revision: self.context.revision,
            topology_revision: self.context.topology_revision,
            window_generation: self.context.window_generation,
            lifecycle_epoch: self.context.lifecycle_epoch,
            surface_generation: self.context.surface_generation,
            role_id: self.context.role_id.clone(),
            tab_id: self.context.tab_id.clone(),
            window_id: self.context.window_id.clone(),
            parent_operation_id: self.context.parent_operation_id.clone(),
            session_id: self.context.session_id.clone(),
            failure_code: self.failure_code.clone(),
            rollback_error_count: self.rollback_error_count,
        }
    }
}

type NativePresentationStatus = NativeOperationStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativePresentationFocus {
    None,
    ContentOnly,
    WindowAndContent,
}

impl NativePresentationFocus {
    fn focuses_content(self) -> bool {
        matches!(self, Self::ContentOnly | Self::WindowAndContent)
    }

    fn focuses_window(self) -> bool {
        matches!(self, Self::WindowAndContent)
    }

    fn diagnostic_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ContentOnly => "content-only",
            Self::WindowAndContent => "window-and-content",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeWindowMode {
    Fullscreen,
    Maximized,
    Minimized,
    ToggleFullscreen,
    ToggleMaximized,
}

impl NativeWindowMode {
    fn from_presentation(presentation: &str) -> Option<Self> {
        match presentation {
            "fullscreen" => Some(Self::Fullscreen),
            "maximized" => Some(Self::Maximized),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeWindowPresentationTransition {
    focus: NativePresentationFocus,
    mode: Option<NativeWindowMode>,
    previous_visibility: Option<bool>,
    requested_visibility: Option<bool>,
}

impl NativeWindowPresentationTransition {
    fn new(
        previous_visibility: Option<bool>,
        requested_visibility: Option<bool>,
        mode: Option<NativeWindowMode>,
        focus: NativePresentationFocus,
    ) -> Self {
        Self {
            focus,
            mode,
            previous_visibility,
            requested_visibility,
        }
    }
}

struct PendingRoleNavigation {
    lifecycle_epoch: u64,
    navigation: Arc<NavigationTracker>,
    operation: Option<NativeOperationContext>,
    role_id: String,
    surface: Webview,
}

impl NavigationTracker {
    fn adopt_current_navigation(&self, context: &NativeOperationContext) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        state.active_operation_id = Some(context.operation_id.clone());
        if state.finished {
            self.async_changed.send_replace(true);
        }
        Ok(())
    }

    fn begin_operation(&self, context: &NativeOperationContext) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        state.active_operation_id = Some(context.operation_id.clone());
        state.finished = false;
        state.started = false;
        self.async_changed.send_replace(false);
        Ok(())
    }

    fn operation_active(&self) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.active_operation_id.is_some() && !state.finished
        })
    }

    fn operation_state(
        &self,
        context: &NativeOperationContext,
    ) -> Result<NavigationOperationState, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "navigation tracker lock poisoned".to_owned())?;
        if state.active_operation_id.as_deref() != Some(context.operation_id.as_str()) {
            Ok(NavigationOperationState::Superseded)
        } else if state.finished {
            Ok(NavigationOperationState::Finished)
        } else {
            Ok(NavigationOperationState::Pending)
        }
    }

    fn wait_operation(&self, context: NativeOperationContext) -> NativeOperationReceipt {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => {
                return NativeOperationReceipt::with_status(
                    context,
                    "navigationTracker",
                    NativeOperationStatus::Failed,
                    Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                );
            }
        };
        loop {
            if state.active_operation_id.as_deref() != Some(context.operation_id.as_str()) {
                return NativeOperationReceipt::with_status(
                    context,
                    "navigationSuperseded",
                    NativeOperationStatus::Superseded,
                    Some("SYSTEM_NAVIGATION_SUPERSEDED"),
                );
            }
            if state.finished {
                return NativeOperationReceipt::applied(context, "pageFinished");
            }
            let remaining = context.remaining();
            if remaining.is_zero() {
                return NativeOperationReceipt::with_status(
                    context,
                    "navigationDeadline",
                    NativeOperationStatus::Failed,
                    Some("TAURI_NAVIGATION_FAILED"),
                );
            }
            let (next, timeout) = match self.changed.wait_timeout(state, remaining) {
                Ok(next) => next,
                Err(_) => {
                    return NativeOperationReceipt::with_status(
                        context,
                        "navigationTracker",
                        NativeOperationStatus::Failed,
                        Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
                    );
                }
            };
            state = next;
            if timeout.timed_out() && !state.finished {
                return NativeOperationReceipt::with_status(
                    context,
                    "navigationDeadline",
                    NativeOperationStatus::Failed,
                    Some("TAURI_NAVIGATION_FAILED"),
                );
            }
        }
    }

    async fn wait_operation_async(
        &self,
        context: NativeOperationContext,
    ) -> NativeOperationReceipt {
        let mut changed = self.async_changed.subscribe();
        let wait = async {
            loop {
                match self.operation_state(&context) {
                    Ok(NavigationOperationState::Finished) => return Ok(true),
                    Ok(NavigationOperationState::Superseded) => return Ok(false),
                    Ok(NavigationOperationState::Pending) => {}
                    Err(error) => return Err(error),
                }
                changed
                    .changed()
                    .await
                    .map_err(|_| "System WebView navigation tracker stopped.".to_owned())?;
            }
        };
        match tokio::time::timeout(context.remaining(), wait).await {
            Ok(Ok(true)) => NativeOperationReceipt::applied(context, "pageFinished"),
            Ok(Ok(false)) => NativeOperationReceipt::with_status(
                context,
                "navigationSuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_NAVIGATION_SUPERSEDED"),
            ),
            Ok(Err(_)) => NativeOperationReceipt::with_status(
                context,
                "navigationTracker",
                NativeOperationStatus::Failed,
                Some("SYSTEM_NAVIGATION_TRACKER_UNAVAILABLE"),
            ),
            Err(_) => NativeOperationReceipt::with_status(
                context,
                "navigationDeadline",
                NativeOperationStatus::Failed,
                Some("TAURI_NAVIGATION_FAILED"),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NavigationOperationState {
    Finished,
    Pending,
    Superseded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PopupContractDecision {
    Create,
    DenyMissingOwner,
    DenyUnsupportedScheme,
}

fn popup_contract_decision(role_present: bool, scheme: &str) -> PopupContractDecision {
    if !role_present {
        PopupContractDecision::DenyMissingOwner
    } else if !matches!(scheme, "about" | "http" | "https") {
        PopupContractDecision::DenyUnsupportedScheme
    } else {
        PopupContractDecision::Create
    }
}

fn receipt_for_runtime_result<T>(
    context: NativeOperationContext,
    stage: &'static str,
    result: &RuntimeResult<T>,
) -> NativeOperationReceipt {
    match result.as_ref() {
        Ok(_) => NativeOperationReceipt::applied(context, stage),
        Err(error) => {
            let rollback_failed = error.code == "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"
                || error.code.contains("_ROLLBACK_")
                || error.code.ends_with("_ROLLBACK_FAILED");
            let receipt = NativeOperationReceipt::with_status(
                context,
                stage,
                if rollback_failed {
                    NativeOperationStatus::Indeterminate
                } else {
                    NativeOperationStatus::Failed
                },
                Some(error.code),
            );
            if let Some(count) = error.rollback_error_count {
                receipt.with_rollback_error_count(count as usize)
            } else {
                receipt
            }
        }
    }
}

fn receipt_for_string_result<T>(
    context: NativeOperationContext,
    stage: &'static str,
    failure_code: &'static str,
    result: &Result<T, String>,
) -> NativeOperationReceipt {
    match result.as_ref() {
        Ok(_) => NativeOperationReceipt::applied(context, stage),
        Err(message)
            if message.contains("ROLLBACK_FAILED")
                || message
                    .to_ascii_lowercase()
                    .contains("compensation also failed") =>
        {
            NativeOperationReceipt::with_status(
                context,
                stage,
                NativeOperationStatus::Indeterminate,
                Some("SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED"),
            )
        }
        Err(_) => NativeOperationReceipt::with_status(
            context,
            stage,
            NativeOperationStatus::Failed,
            Some(failure_code),
        ),
    }
}
