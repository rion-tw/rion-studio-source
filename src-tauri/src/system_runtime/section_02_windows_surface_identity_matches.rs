#[cfg(any(windows, test))]
fn windows_surface_identity_matches(
    expected_controller: u64,
    actual_controller: u64,
    expected_process_id: u32,
    actual_process_id: u32,
) -> bool {
    expected_controller != 0
        && expected_controller == actual_controller
        && expected_process_id != 0
        && expected_process_id == actual_process_id
}

#[cfg(any(windows, test))]
fn windows_surface_navigation_matches(
    expected_navigation_id: u64,
    reported_navigation_id: u64,
) -> bool {
    expected_navigation_id != 0 && expected_navigation_id == reported_navigation_id
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsSurfaceNavigationCompletion {
    Failed,
    Isolated,
    Stale,
}

#[cfg(any(windows, test))]
fn windows_surface_navigation_completion(
    expected_navigation_id: u64,
    reported_navigation_id: u64,
    succeeded: bool,
) -> WindowsSurfaceNavigationCompletion {
    if !windows_surface_navigation_matches(expected_navigation_id, reported_navigation_id) {
        WindowsSurfaceNavigationCompletion::Stale
    } else if succeeded {
        WindowsSurfaceNavigationCompletion::Isolated
    } else {
        WindowsSurfaceNavigationCompletion::Failed
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedSurfaceKind {
    Divider,
    Popup,
    Recovery,
    Role,
}

impl ManagedSurfaceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Divider => "divider",
            Self::Popup => "popup",
            Self::Recovery => "recovery",
            Self::Role => "role",
        }
    }

    const fn release_boundary(self) -> SurfaceReleaseBoundary {
        match self {
            Self::Role => SurfaceReleaseBoundary::DedicatedStore,
            Self::Divider | Self::Popup | Self::Recovery => {
                SurfaceReleaseBoundary::SharedBrowserProcess
            }
        }
    }
}

const fn managed_surface_close_priority(kind: ManagedSurfaceKind) -> u8 {
    match kind {
        ManagedSurfaceKind::Popup => 0,
        ManagedSurfaceKind::Recovery => 1,
        ManagedSurfaceKind::Role => 2,
        ManagedSurfaceKind::Divider => 3,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedSurfacePhase {
    Live,
    CloseRequested,
    Isolating,
    Isolated,
    Provisional,
    Quarantined,
    Released,
    Retired,
}

pub(crate) enum RuntimeWindowCloseRequest {
    PassThrough,
    Pending,
    Start {
        operation_id: String,
        window_id: String,
        window: Box<Window>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeWindowCloseOperation {
    pub(crate) label: Option<String>,
    pub(crate) native_expected: bool,
    pub(crate) operation_id: String,
    pub(crate) should_execute: bool,
}

impl RuntimeWindowCloseOperation {
    pub(crate) const fn is_state_only_delete(&self, delete: bool) -> bool {
        delete && !self.native_expected
    }
}

impl ManagedSurfacePhase {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::CloseRequested => "closeRequested",
            Self::Isolating => "isolating",
            Self::Isolated => "isolated",
            Self::Provisional => "provisional",
            Self::Quarantined => "quarantined",
            Self::Released => "released",
            Self::Retired => "retired",
        }
    }
}

impl ManagedSurfacePhase {
    const fn blocks_role_relaunch(self) -> bool {
        matches!(
            self,
            Self::Live
                | Self::CloseRequested
                | Self::Isolating
                | Self::Provisional
                | Self::Quarantined
        )
    }
}

#[derive(Clone)]
struct ManagedSurface {
    close_operation_id: Option<String>,
    generation: u64,
    instance_id: String,
    kind: ManagedSurfaceKind,
    lifecycle: Arc<SurfaceLifecycleTracker>,
    native_lifecycle_lane: Arc<Mutex<()>>,
    phase: ManagedSurfacePhase,
    release_boundary: SurfaceReleaseBoundary,
    role_id: Option<String>,
    tab_id: Option<String>,
    webview: Webview,
    window_generation: u64,
    window_id: String,
}

fn destroyed_host_surface_identity_matches(
    surface_window_id: &str,
    surface_window_generation: u64,
    destroyed_window_id: &str,
    destroyed_window_generation: u64,
) -> bool {
    surface_window_id == destroyed_window_id
        && surface_window_generation == destroyed_window_generation
}

fn destroyed_host_surface_close_is_pending(
    has_close_operation: bool,
    phase: ManagedSurfacePhase,
) -> bool {
    has_close_operation
        || matches!(
            phase,
            ManagedSurfacePhase::CloseRequested
                | ManagedSurfacePhase::Isolating
                | ManagedSurfacePhase::Isolated
        )
}

fn next_surface_instance_id(label: &str) -> String {
    let sequence = SURFACE_INSTANCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{label}:{sequence}")
}

fn surface_generation_is_current(active: u64, reported: u64) -> bool {
    active == reported
}

fn surface_recovery_swap_is_current(
    active_label: &str,
    expected_label: &str,
    active_generation: u64,
    expected_generation: u64,
) -> bool {
    active_label == expected_label
        && surface_generation_is_current(active_generation, expected_generation)
}

fn surface_close_commit_is_current(
    active_tab_id: &str,
    expected_tab_id: &str,
    active_label: &str,
    closed_label: &str,
) -> bool {
    active_tab_id == expected_tab_id && active_label == closed_label
}

#[derive(Debug, PartialEq, Eq)]
struct ReversibleFanoutFailure {
    apply_error: String,
    rollback_errors: Vec<String>,
}

fn rollback_reversible_fanout<T>(
    items: &[T],
    mut rollback: impl FnMut(usize, &T) -> Result<(), String>,
) -> Vec<String> {
    (0..items.len())
        .rev()
        .filter_map(|index| rollback(index, &items[index]).err())
        .collect()
}

fn apply_reversible_fanout<T>(
    items: &[T],
    mut apply: impl FnMut(usize, &T) -> Result<(), String>,
    mut rollback: impl FnMut(usize, &T) -> Result<(), String>,
) -> Result<(), ReversibleFanoutFailure> {
    for (index, item) in items.iter().enumerate() {
        if let Err(apply_error) = apply(index, item) {
            let rollback_errors = (0..=index)
                .rev()
                .filter_map(|rollback_index| rollback(rollback_index, &items[rollback_index]).err())
                .collect();
            return Err(ReversibleFanoutFailure {
                apply_error,
                rollback_errors,
            });
        }
    }
    Ok(())
}

fn reversible_fanout_runtime_error(
    apply_code: &'static str,
    operation: &str,
    failure: &ReversibleFanoutFailure,
) -> RuntimeError {
    if failure.rollback_errors.is_empty() {
        RuntimeError::new(apply_code, failure.apply_error.clone())
    } else {
        RuntimeError::new(
            "SYSTEM_NATIVE_MUTATION_ROLLBACK_FAILED",
            format!(
                "{operation} failed: {} Compensation also failed: {}. Restart Rion Studio to recover safely.",
                failure.apply_error,
                failure.rollback_errors.join("; ")
            ),
        )
        .with_rollback_error_count(failure.rollback_errors.len())
    }
}

fn finalize_persisted_effect_result(
    mut result: CoreEffectResult,
    persist_runtime: bool,
    persistence_error: Option<String>,
) -> CoreEffectResult {
    if result.ok
        && persist_runtime
        && let Some(message) = persistence_error
    {
        result.ok = false;
        result.value_json = None;
        result.error = Some(rion_core::CoreErrorPayload {
            code: "SYSTEM_RUNTIME_PERSIST_FAILED".to_owned(),
            message: format!(
                "The native runtime changed, but its restore session could not be persisted: {message}"
            ),
        });
    }
    result
}

fn successor_tab_after_close(
    ordered_tab_ids: &[String],
    closing_tab_id: &str,
    mut selectable: impl FnMut(&str) -> bool,
) -> Option<String> {
    let closing_index = ordered_tab_ids
        .iter()
        .position(|tab_id| tab_id == closing_tab_id)?;
    ordered_tab_ids
        .iter()
        .skip(closing_index + 1)
        .chain(ordered_tab_ids[..closing_index].iter().rev())
        .find(|tab_id| selectable(tab_id))
        .cloned()
}

fn claim_surface_recovery(
    active_generation: u64,
    reported_generation: u64,
    recovering_roles: &mut HashSet<String>,
    role_id: &str,
) -> bool {
    surface_generation_is_current(active_generation, reported_generation)
        && recovering_roles.insert(role_id.to_owned())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SurfaceFailureTarget {
    Role {
        role_id: String,
        generation: u64,
    },
    Popup {
        label: String,
        role_id: String,
        generation: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceFailureScope {
    Renderer,
    #[cfg(any(windows, test))]
    Browser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceFailureAction {
    RecoverRole,
    ClosePopup,
}

fn surface_failure_action(
    target: &SurfaceFailureTarget,
    scope: SurfaceFailureScope,
) -> SurfaceFailureAction {
    if matches!(target, SurfaceFailureTarget::Popup { .. })
        && scope == SurfaceFailureScope::Renderer
    {
        SurfaceFailureAction::ClosePopup
    } else {
        SurfaceFailureAction::RecoverRole
    }
}

struct RuntimeTab {
    active_divider_resize: Option<ActiveDividerResize>,
    dividers: Vec<RuntimeDivider>,
    roles: HashMap<String, RoleSurface>,
    slots: HashMap<String, RuntimeRoleSlot>,
    workspace_id: Option<String>,
    workspace_appearance: WorkspaceAppearanceSettingsRecord,
    #[cfg(any(windows, target_os = "macos"))]
    workspace_template: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchPhase {
    Attaching,
    Navigating,
    EssentialReady,
    OptionalHydrating,
    Ready,
    Degraded,
}

impl LaunchPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attaching => "attaching",
            Self::Navigating => "navigating",
            Self::EssentialReady => "essentialReady",
            Self::OptionalHydrating => "optionalHydrating",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
        }
    }

    fn blocks_optional_idle(self) -> bool {
        matches!(self, Self::Attaching | Self::Navigating)
    }
}

struct RuntimeDisplayHost {
    generation: u64,
    last_placement_observation_sequence: u64,
    placement_observation_lane: Arc<Mutex<()>>,
    retirement_revision: u64,
    target: EmbeddedLaunchTargetRecord,
    window: Window,
    #[cfg(windows)]
    last_geometry_receipt_revision: u64,
    #[cfg(windows)]
    initial_placement_fence: Option<ObservedWindowPresentation>,
    #[cfg(windows)]
    tab_strip: Webview,
    #[cfg(windows)]
    toolbar_revealed: bool,
    #[cfg(windows)]
    tab_chrome_reveal: WindowsTabChromeRevealState,
    #[cfg(windows)]
    tab_failure_status: Option<RuntimeTabFailureStatusSurface>,
    #[cfg(windows)]
    tab_failure_status_creating: bool,
    #[cfg(target_os = "macos")]
    tabs_controller: crate::runtime_tabs_macos::MacRuntimeTabsController,
}

#[cfg(windows)]
struct RuntimeTabFailureStatusSurface {
    webview: Webview,
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeTabHostPlan {
    active: bool,
    window_id: String,
    focus: bool,
    moved: bool,
    tab_id: String,
}

fn resolve_runtime_tab_host_plan(
    snapshot: &BrowserRuntimeSnapshot,
    live_windows: &HashMap<String, String>,
    focus_window_ids: &[String],
    focus_tab_id: Option<&str>,
) -> Vec<RuntimeTabHostPlan> {
    let active_tabs = snapshot
        .windows
        .iter()
        .filter_map(|window| {
            window
                .active_tab_id
                .as_ref()
                .map(|tab_id| (window.window_id.as_str(), tab_id.as_str()))
        })
        .collect::<HashMap<_, _>>();
    snapshot
        .tabs
        .iter()
        .filter_map(|tab| {
            let live_window_id = live_windows.get(&tab.id)?;
            let active = !tab.hidden
                && active_tabs.get(tab.window_id.as_str()).copied() == Some(tab.id.as_str());
            Some(RuntimeTabHostPlan {
                active,
                window_id: tab.window_id.clone(),
                focus: focus_tab_id == Some(tab.id.as_str())
                    || (active && focus_window_ids.contains(&tab.window_id)),
                moved: live_window_id != &tab.window_id,
                tab_id: tab.id.clone(),
            })
        })
        .collect()
}

fn runtime_tab_is_audible(state: &RuntimeState, tab: &RuntimeTab) -> bool {
    tab.roles.values().any(|surface| {
        state
            .audible_webviews
            .get(surface.webview.label())
            .copied()
            .unwrap_or(false)
    }) || state.popup_roles.iter().any(|(label, role_id)| {
        tab.roles.contains_key(role_id)
            && state.audible_webviews.get(label).copied().unwrap_or(false)
    })
}

struct RuntimeDivider {
    descriptor: WorkspaceDividerDescriptor,
    index: u32,
    surface_instance_id: String,
    webview: Webview,
}

#[derive(Clone)]
struct ActiveDividerResize {
    divider_index: u32,
    role_ids: Vec<String>,
    snapped_position: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividerPointerPayload {
    phase: String,
    screen_position: Option<f64>,
}

struct RecoveryBudget {
    attempts: u8,
    window_started: Instant,
}

impl RecoveryBudget {
    fn claim(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_started) > SURFACE_RECOVERY_WINDOW {
            self.attempts = 0;
            self.window_started = now;
        }
        if self.attempts >= SURFACE_RECOVERY_LIMIT {
            return false;
        }
        self.attempts += 1;
        true
    }
}

#[derive(Default)]
struct CloseCoordinator {
    closing_roles: HashSet<String>,
    closing_tabs: HashSet<String>,
    closing_webviews: HashSet<String>,
    quarantined_roles: HashSet<String>,
}

struct LiveWindowTabStore {
    authority_barrier: Option<Arc<RwLock<()>>>,
    kernel: Arc<RuntimeKernel>,
}

impl Default for LiveWindowTabStore {
    fn default() -> Self {
        Self {
            authority_barrier: None,
            kernel: Arc::new(RuntimeKernel::default()),
        }
    }
}

#[derive(Clone)]
struct LiveWindowHandle {
    record: LiveWindowRecord,
}

impl std::ops::Deref for LiveWindowHandle {
    type Target = LiveWindowRecord;

    fn deref(&self) -> &Self::Target {
        &self.record
    }
}

#[derive(Clone)]
struct LiveWindowTopologyCommit {
    active_tab_id: Option<String>,
    hidden_tab_ids: HashSet<String>,
    tabs: Vec<LiveTabRecord>,
    ui_sequence: u64,
    window_generation: u64,
    window_id: String,
}

struct LiveTopologyCommitInput {
    commit_id: String,
    source: &'static str,
    primary_window_id: String,
    windows: Vec<LiveWindowTopologyCommit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveTopologyCommitStatus {
    Applied,
    Superseded,
}

struct LiveTopologyCommitReceipt {
    membership_changed: bool,
    revision: u64,
    status: LiveTopologyCommitStatus,
    window_ids: Vec<String>,
}

struct LiveWindowPlacementCommitInput {
    placement: GameWindowPlacementRecord,
    placement_sequence: u64,
    target_display: DisplayTargetRecord,
    window_generation: u64,
    window_id: String,
}

struct LiveWindowPlacementCommitReceipt {
    revision: u64,
    status: LiveTopologyCommitStatus,
}

struct PresentationRegistry {
    actors: Mutex<HashMap<String, Arc<NativeWindowActor>>>,
    next_surface_owner_revision: AtomicU64,
    surface_owners: Arc<Mutex<HashMap<String, SurfacePresentationOwner>>>,
    #[cfg(windows)]
    tab_chrome_acknowledgements: Mutex<HashMap<String, u64>>,
    #[cfg(windows)]
    tab_chrome_changed: Condvar,
    live: LiveWindowTabStore,
    projection: NativeTabProjectionStore,
    statuses: TabRuntimeStatusStore,
}

impl PresentationRegistry {
    fn new(kernel: Arc<RuntimeKernel>, authority_barrier: Arc<RwLock<()>>) -> Self {
        Self {
            actors: Mutex::new(HashMap::new()),
            next_surface_owner_revision: AtomicU64::new(0),
            surface_owners: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(windows)]
            tab_chrome_acknowledgements: Mutex::new(HashMap::new()),
            #[cfg(windows)]
            tab_chrome_changed: Condvar::new(),
            live: LiveWindowTabStore {
                authority_barrier: Some(authority_barrier),
                kernel,
            },
            projection: NativeTabProjectionStore::default(),
            statuses: TabRuntimeStatusStore::default(),
        }
    }
}

impl Default for PresentationRegistry {
    fn default() -> Self {
        Self {
            actors: Mutex::new(HashMap::new()),
            next_surface_owner_revision: AtomicU64::new(0),
            surface_owners: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(windows)]
            tab_chrome_acknowledgements: Mutex::new(HashMap::new()),
            #[cfg(windows)]
            tab_chrome_changed: Condvar::new(),
            live: LiveWindowTabStore::default(),
            projection: NativeTabProjectionStore::default(),
            statuses: TabRuntimeStatusStore::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SurfacePresentationOwner {
    instance_id: String,
    owner_epoch: u64,
    window_generation: u64,
    window_id: String,
}

fn surface_owner_matches_binding(
    owner: &SurfacePresentationOwner,
    instance_id: &str,
    window_id: &str,
    window_generation: u64,
) -> bool {
    owner.instance_id == instance_id
        && owner.window_id == window_id
        && owner.window_generation == window_generation
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ClosePreflightPlan {
    ReusePreview {
        revision: u64,
        selected_tab_id: Option<String>,
    },
    PresentSuccessor {
        tab_id: String,
    },
    HideWindow,
}

fn close_preflight_plan(
    closing_tab_present: bool,
    preview_revision: u64,
    preview_selected_tab_id: Option<String>,
    fallback_successor_tab_id: Option<String>,
) -> ClosePreflightPlan {
    if !closing_tab_present && preview_revision > 0 {
        return ClosePreflightPlan::ReusePreview {
            revision: preview_revision,
            selected_tab_id: preview_selected_tab_id,
        };
    }
    fallback_successor_tab_id.map_or(ClosePreflightPlan::HideWindow, |tab_id| {
        ClosePreflightPlan::PresentSuccessor { tab_id }
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativePresentationPlan {
    focus: NativePresentationFocus,
    operation: NativeOperationContext,
    revision: u64,
    surface_identities: HashSet<(String, u64)>,
    tab_id: Option<String>,
    window_id: String,
    window_mode: Option<NativeWindowMode>,
    window_visibility: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativePresentationReceipt {
    applied_surface_mutation_count: usize,
    applied_revision: Option<u64>,
    focused: Option<bool>,
    operation: NativeOperationReceipt,
    planned_surface_mutation_count: usize,
    skipped_surface_mutation_count: usize,
    status: NativePresentationStatus,
    supersede_reason: Option<&'static str>,
    surface_identities: HashSet<(String, u64)>,
    visible: Option<bool>,
    window_id: String,
}

impl NativePresentationReceipt {
    fn from_outcome(plan: &NativePresentationPlan, outcome: &NativePresentationOutcome) -> Self {
        let native_truth_mismatch = plan
            .window_visibility
            .zip(outcome.window_visible_after)
            .is_some_and(|(expected, actual)| expected != actual)
            || (outcome.presentation_applied
                && plan.focus.focuses_window()
                && outcome.window_focused_after == Some(false));
        let deadline_exceeded = plan.operation.remaining().is_zero();
        let status = if !outcome.visibility_errors.is_empty() {
            NativePresentationStatus::Failed
        } else if !outcome.applied
            || outcome.focus_superseded
            || outcome.skipped_surface_count > 0
        {
            NativePresentationStatus::Superseded
        } else if native_truth_mismatch || deadline_exceeded {
            NativePresentationStatus::Degraded
        } else {
            NativePresentationStatus::Applied
        };
        let operation_stage = if plan.window_mode.is_some() {
            "nativePresentationModeSubmitted"
        } else {
            "nativePresentation"
        };
        let supersede_reason = if status != NativePresentationStatus::Superseded {
            None
        } else if outcome.skipped_surface_count > 0 {
            Some("surfaceOwnerTokenMismatch")
        } else if outcome.focus_superseded {
            Some("focusLeaseSuperseded")
        } else if !outcome.applied {
            Some("presentationIntentSuperseded")
        } else {
            None
        };
        Self {
            applied_surface_mutation_count: outcome
                .hidden_surface_count
                .saturating_add(outcome.shown_surface_count),
            applied_revision: outcome.presentation_applied.then_some(plan.revision),
            focused: outcome.window_focused_after,
            operation: NativeOperationReceipt::with_status(
                plan.operation.clone(),
                operation_stage,
                status,
                if !outcome.visibility_errors.is_empty() {
                    Some("NATIVE_PRESENTATION_FAILED")
                } else if outcome.skipped_surface_count > 0 {
                    Some("NATIVE_SURFACE_OWNER_SUPERSEDED")
                } else if deadline_exceeded {
                    Some("NATIVE_PRESENTATION_DEADLINE_EXCEEDED")
                } else {
                    None
                },
            ),
            planned_surface_mutation_count: outcome.planned_surface_mutation_count,
            skipped_surface_mutation_count: outcome.skipped_surface_count,
            status,
            supersede_reason,
            surface_identities: if outcome.presentation_applied {
                plan.surface_identities.clone()
            } else {
                HashSet::new()
            },
            visible: outcome.window_visible_after,
            window_id: plan.window_id.clone(),
        }
    }
}

trait NativePresentationAdapter {
    fn apply(
        &self,
        plan: &NativePresentationPlan,
        request: &NativePresentationRequest,
        previous_tab_id: &Option<String>,
        previous_surface_identities: &HashSet<(String, u64)>,
        previous_surfaces: Vec<Webview>,
        previous_window_visibility: Option<bool>,
    ) -> (NativePresentationOutcome, NativePresentationReceipt);
}

struct TauriNativePresentationAdapter;

impl NativePresentationAdapter for TauriNativePresentationAdapter {
    fn apply(
        &self,
        plan: &NativePresentationPlan,
        request: &NativePresentationRequest,
        previous_tab_id: &Option<String>,
        previous_surface_identities: &HashSet<(String, u64)>,
        previous_surfaces: Vec<Webview>,
        previous_window_visibility: Option<bool>,
    ) -> (NativePresentationOutcome, NativePresentationReceipt) {
        let outcome = apply_native_presentation_batch(
            request,
            previous_tab_id,
            previous_surface_identities,
            previous_surfaces,
            previous_window_visibility,
        );
        let receipt = NativePresentationReceipt::from_outcome(plan, &outcome);
        (outcome, receipt)
    }
}

struct NativePresentationRequest {
    active_webview: Option<Webview>,
    actor_liveness: Arc<AtomicBool>,
    coordinator: Arc<Mutex<NativeTabProjectionState>>,
    core: Arc<AppCore>,
    desired_projection: Arc<RwLock<Option<RuntimeNativeProjection>>>,
    defer_window_focus_until_reveal: bool,
    focus: NativePresentationFocus,
    focus_broker: Arc<NativeFocusBroker>,
    focus_lease: Option<NativeFocusLease>,
    next_surface_identities: HashSet<(String, u64)>,
    next_surfaces: Vec<Webview>,
    native_window_mutations: Arc<NativeWindowMutationRegistry>,
    observed_previous_tab_id: Option<String>,
    observed_previous_surfaces: Vec<Webview>,
    operation: NativeOperationContext,
    launch_latency_trace: Option<RuntimeLaunchLatencyTrace>,
    operations: Arc<NativeOperationRegistry>,
    requested_at: Instant,
    revision: u64,
    expected_lifecycle_epoch: u64,
    surface_owner_tokens: HashMap<String, SurfacePresentationOwner>,
    surface_owners: Arc<Mutex<HashMap<String, SurfacePresentationOwner>>>,
    shutdown_state: Arc<AtomicU8>,
    application_lifecycle: Arc<ApplicationLifecycleCoordinator>,
    tab_id: Option<String>,
    trigger: &'static str,
    window: Window,
    window_generation: u64,
    window_id: String,
    window_mode: Option<NativeWindowMode>,
    window_visibility: Option<bool>,
}

impl NativePresentationRequest {
    fn plan(&self) -> NativePresentationPlan {
        NativePresentationPlan {
            focus: self.focus,
            operation: self.operation.clone(),
            revision: self.revision,
            surface_identities: self.next_surface_identities.clone(),
            tab_id: self.tab_id.clone(),
            window_id: self.window_id.clone(),
            window_mode: self.window_mode,
            window_visibility: self.window_visibility,
        }
    }
}

struct NativePresentationBatch {
    first_requested_at: Instant,
    first_revision: u64,
    request: NativePresentationRequest,
    request_count: u32,
}

struct NativePresentationOutcome {
    applied: bool,
    presentation_applied: bool,
    focus_applied: bool,
    focus_superseded: bool,
    hidden_surface_count: usize,
    hide_ms: u64,
    main_queue_wait_ms: u64,
    main_thread_ms: u64,
    no_op: bool,
    planned_surface_mutation_count: usize,
    shown_surface_count: usize,
    show_ms: u64,
    skipped_surface_count: usize,
    visibility_errors: Vec<String>,
    webview_focus_ms: u64,
    window_focused_after: Option<bool>,
    window_focus_applied: bool,
    window_focus_ms: u64,
    window_restore_applied: bool,
    window_visible_after: Option<bool>,
    window_visibility_ms: u64,
    window_was_minimized: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativePresentationMutationPlan {
    apply_content_focus: bool,
    apply_window_focus: bool,
    presentation_changed: bool,
    requires_ui_thread: bool,
}

#[derive(Default)]
struct NativeWindowActorState {
    applied_revision: u64,
    applied_surface_identities: HashSet<(String, u64)>,
    applied_surfaces: Vec<Webview>,
    applied_tab_id: Option<String>,
    applied_window_visibility: Option<bool>,
    last_receipt: Option<NativePresentationReceipt>,
    burst_first_requested_at: Option<Instant>,
    burst_first_revision: u64,
    burst_request_count: u32,
    requests: NativePresentationQueue<NativePresentationRequest>,
    stopped: bool,
}

struct NativeWindowActor {
    generation: u64,
    liveness: Arc<AtomicBool>,
    queue: Arc<(Mutex<NativeWindowActorState>, Condvar)>,
}
