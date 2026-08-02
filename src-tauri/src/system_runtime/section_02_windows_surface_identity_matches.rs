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
    Releasing,
    Released,
    Retired,
}

pub(crate) enum RuntimeWindowCloseRequest {
    PassThrough,
    Pending,
    Start {
        window_id: String,
        window: Box<Window>,
    },
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
            Self::Releasing => "releasing",
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
    close_started_at: Option<Instant>,
    generation: u64,
    instance_id: String,
    kind: ManagedSurfaceKind,
    lifecycle: Arc<SurfaceLifecycleTracker>,
    native_lifecycle_lane: Arc<Mutex<()>>,
    phase: ManagedSurfacePhase,
    role_id: Option<String>,
    tab_id: Option<String>,
    webview: Webview,
    window_id: String,
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

fn provisional_move_failure_message(original: String, rollback_errors: &[String]) -> String {
    if rollback_errors.is_empty() {
        original
    } else {
        format!(
            "SYSTEM_PROVISIONAL_MOVE_ROLLBACK_FAILED: {original} Compensation failed: {}. Restart Rion Studio to recover safely.",
            rollback_errors.join("; ")
        )
    }
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
    audio_muted: bool,
    dividers: Vec<RuntimeDivider>,
    window_id: String,
    roles: HashMap<String, RoleSurface>,
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
    target: EmbeddedLaunchTargetRecord,
    window: Window,
    zoom_factor: f64,
    #[cfg(windows)]
    tab_strip: Webview,
    #[cfg(windows)]
    toolbar_revealed: bool,
    #[cfg(target_os = "macos")]
    tabs_controller: crate::runtime_tabs_macos::MacRuntimeTabsController,
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeTabHostPlan {
    active: bool,
    window_id: String,
    focus: bool,
    moved: bool,
    tab_id: String,
}

fn resolved_runtime_window_selection(
    snapshot: &BrowserRuntimeSnapshot,
    window_id: &str,
    previous: &WindowPresentationState,
    focus_tab_id: Option<&str>,
    presentation_revision: u64,
) -> Option<String> {
    let visible_in_window = |tab_id: &str| {
        snapshot
            .tabs
            .iter()
            .any(|tab| tab.id == tab_id && tab.window_id == window_id && !tab.hidden)
    };
    let snapshot_tab = |tab_id: &str| snapshot.tabs.iter().find(|tab| tab.id == tab_id);
    let desired_active = snapshot
        .windows
        .iter()
        .find(|window| window.window_id == window_id)
        .and_then(|window| window.active_tab_id.as_deref())
        .filter(|tab_id| visible_in_window(tab_id))
        .map(str::to_owned);
    let superseded = previous.revision > presentation_revision;

    if !superseded
        && let Some(focus_tab_id) = focus_tab_id.filter(|tab_id| visible_in_window(tab_id))
    {
        return Some(focus_tab_id.to_owned());
    }

    let Some(selected_tab_id) = previous.selected_tab_id.as_deref() else {
        return if superseded { None } else { desired_active };
    };
    let Some(selected_snapshot) = snapshot_tab(selected_tab_id) else {
        // A provisional or closing presentation is newer than Core metadata and remains
        // authoritative until its own transaction commits or rolls back.
        return Some(selected_tab_id.to_owned());
    };
    if selected_snapshot.window_id == window_id && !selected_snapshot.hidden {
        Some(selected_tab_id.to_owned())
    } else {
        desired_active
    }
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

#[derive(Default)]
struct PresentationRegistry {
    actors: Mutex<HashMap<String, Arc<NativeWindowActor>>>,
    next_revision: AtomicU64,
    next_surface_owner_revision: AtomicU64,
    surface_owners: Arc<Mutex<HashMap<String, SurfacePresentationOwner>>>,
    windows: Mutex<HashMap<String, Arc<Mutex<WindowPresentationState>>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SurfacePresentationOwner {
    instance_id: String,
    revision: u64,
    window_id: String,
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

struct NativePresentationRequest {
    active_webview: Option<Webview>,
    coordinator: Arc<Mutex<WindowPresentationState>>,
    core: Arc<AppCore>,
    focus: NativePresentationFocus,
    next_surface_identities: HashSet<(String, u64)>,
    next_surfaces: Vec<Webview>,
    observed_previous_tab_id: Option<String>,
    observed_previous_surfaces: Vec<Webview>,
    requested_at: Instant,
    revision: u64,
    surface_owner_revisions: HashMap<String, u64>,
    surface_owners: Arc<Mutex<HashMap<String, SurfacePresentationOwner>>>,
    tab_id: Option<String>,
    trigger: &'static str,
    window: Window,
    window_id: String,
    window_visibility: Option<bool>,
}

struct NativePresentationBatch {
    first_requested_at: Instant,
    first_revision: u64,
    request: NativePresentationRequest,
    request_count: u32,
}

struct NativePresentationOutcome {
    applied: bool,
    focus_applied: bool,
    hidden_surface_count: usize,
    hide_ms: u64,
    main_queue_wait_ms: u64,
    main_thread_ms: u64,
    no_op: bool,
    shown_surface_count: usize,
    show_ms: u64,
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

struct LatestOnlyPresentationQueue<T> {
    in_flight: bool,
    pending: Option<T>,
}

impl<T> Default for LatestOnlyPresentationQueue<T> {
    fn default() -> Self {
        Self {
            in_flight: false,
            pending: None,
        }
    }
}

impl<T> LatestOnlyPresentationQueue<T> {
    fn replace(&mut self, value: T) {
        self.pending = Some(value);
    }

    fn begin_latest(&mut self) -> Option<T> {
        if self.in_flight {
            return None;
        }
        let latest = self.pending.take()?;
        self.in_flight = true;
        Some(latest)
    }

    fn finish(&mut self) {
        self.in_flight = false;
    }
}

#[derive(Default)]
struct NativeWindowActorState {
    applied_revision: u64,
    applied_surface_identities: HashSet<(String, u64)>,
    applied_surfaces: Vec<Webview>,
    applied_tab_id: Option<String>,
    applied_window_visibility: Option<bool>,
    burst_first_requested_at: Option<Instant>,
    burst_first_revision: u64,
    burst_request_count: u32,
    requests: LatestOnlyPresentationQueue<NativePresentationRequest>,
    stopped: bool,
}

struct NativeWindowActor {
    queue: Arc<(Mutex<NativeWindowActorState>, Condvar)>,
}
