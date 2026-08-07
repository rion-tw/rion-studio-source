impl PresentationRegistry {
    fn next_revision(&self) -> u64 {
        self.live
            .next_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1)
    }

    fn current_revision(&self) -> u64 {
        self.live.next_revision.load(Ordering::Acquire)
    }

    fn assign_surface_owner(
        &self,
        surface_label: &str,
        instance_id: &str,
        window_id: &str,
    ) -> Result<u64, String> {
        let revision = self
            .next_surface_owner_revision
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        self.surface_owners
            .lock()
            .map_err(|_| "The native surface ownership registry is unavailable.".to_owned())?
            .insert(
                surface_label.to_owned(),
                SurfacePresentationOwner {
                    instance_id: instance_id.to_owned(),
                    revision,
                    window_id: window_id.to_owned(),
                },
            );
        Ok(revision)
    }

    fn surface_owner_revisions(&self, surface_labels: &HashSet<String>) -> HashMap<String, u64> {
        self.surface_owners
            .lock()
            .ok()
            .map(|owners| {
                surface_labels
                    .iter()
                    .map(|label| {
                        (
                            label.clone(),
                            owners
                                .get(label)
                                .map(|owner| owner.revision)
                                .unwrap_or_default(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn coordinator(&self, window_id: &str) -> Result<Arc<Mutex<LiveWindowRecord>>, String> {
        let mut windows = self
            .live
            .windows
            .lock()
            .map_err(|_| "The runtime tab presentation registry is unavailable.".to_owned())?;
        Ok(Arc::clone(
            windows
                .entry(window_id.to_owned())
                .or_insert_with(|| {
                    Arc::new(Mutex::new(LiveWindowRecord {
                        window_id: window_id.to_owned(),
                        ..LiveWindowRecord::default()
                    }))
                }),
        ))
    }

    fn projection_coordinator(
        &self,
        window_id: &str,
    ) -> Result<Arc<Mutex<NativeTabProjectionState>>, String> {
        let mut windows = self
            .projection
            .windows
            .lock()
            .map_err(|_| "The native tab projection registry is unavailable.".to_owned())?;
        Ok(Arc::clone(
            windows
                .entry(window_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(NativeTabProjectionState::default()))),
        ))
    }

    fn set_window_generation(&self, window_id: &str, generation: u64) -> Result<(), String> {
        let coordinator = self.coordinator(window_id)?;
        let mut state = coordinator
            .lock()
            .map_err(|_| "The live runtime tab state is unavailable.".to_owned())?;
        state.window_id = window_id.to_owned();
        state.window_generation = state.window_generation.max(generation);
        Ok(())
    }

    fn existing(&self, window_id: &str) -> Option<Arc<Mutex<LiveWindowRecord>>> {
        self.live
            .windows
            .lock()
            .ok()
            .and_then(|windows| windows.get(window_id).cloned())
    }

    fn resolve_tab_alias(&self, tab_id: &str) -> Option<String> {
        self.live.windows.lock().ok().and_then(|windows| {
            windows.values().find_map(|window| {
                window
                    .lock()
                    .ok()
                    .and_then(|selection| selection.aliases.get(tab_id).cloned())
            })
        })
    }

    fn selected_tabs(&self) -> HashMap<String, String> {
        self.live
            .windows
            .lock()
            .ok()
            .map(|windows| {
                windows
                    .iter()
                    .filter_map(|(window_id, state)| {
                        state
                            .lock()
                            .ok()
                            .and_then(|state| state.selected_tab_id.clone())
                            .map(|tab_id| (window_id.clone(), tab_id))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn window_contains_tab(&self, window_id: &str, tab_id: &str) -> bool {
        self.existing(window_id)
            .and_then(|state| state.lock().ok().map(|state| state.contains_tab(tab_id)))
            .unwrap_or(false)
    }

    fn tab(&self, window_id: &str, tab_id: &str) -> Option<LiveTabRecord> {
        self.existing(window_id).and_then(|state| {
            state
                .lock()
                .ok()
                .and_then(|state| state.tabs.iter().find(|tab| tab.id == tab_id).cloned())
        })
    }

    fn surfaces(&self, window_id: &str, tab_id: Option<&str>) -> Vec<Webview> {
        self.projection_coordinator(window_id)
            .ok()
            .and_then(|projection| {
                projection
                    .lock()
                    .ok()
                    .map(|projection| projection.surfaces(tab_id))
            })
            .unwrap_or_default()
    }

    fn bind_surface(
        &self,
        window_id: &str,
        tab_id: &str,
        binding: SurfacePresentationBinding,
    ) -> bool {
        if !self.window_contains_tab(window_id, tab_id) {
            return false;
        }
        self.projection_coordinator(window_id)
            .ok()
            .and_then(|projection| {
                projection.lock().ok().map(|mut projection| {
                    projection.bind_surface(tab_id, binding);
                })
            })
            .is_some()
    }

    fn replace_tab_projection(&self, window_id: &str, provisional_id: &str, tab_id: &str) {
        if let Ok(projection) = self.projection_coordinator(window_id)
            && let Ok(mut projection) = projection.lock()
        {
            projection.replace_tab_id(provisional_id, tab_id);
        }
        self.statuses.replace_tab_id(provisional_id, tab_id);
    }

    fn tab_window(&self, tab_id: &str) -> Result<Option<String>, String> {
        let windows = self
            .live
            .windows
            .lock()
            .map_err(|_| "The runtime tab presentation registry is unavailable.".to_owned())?
            .iter()
            .map(|(window_id, state)| (window_id.clone(), Arc::clone(state)))
            .collect::<Vec<_>>();
        let mut owner = None;
        for (window_id, state) in windows {
            let state = state
                .lock()
                .map_err(|_| "A runtime tab presentation state is unavailable.".to_owned())?;
            if !state.contains_tab(tab_id) {
                continue;
            }
            if owner.is_some() {
                return Err(format!(
                    "Runtime tab {tab_id} exists in more than one presentation window."
                ));
            }
            owner = Some(window_id);
        }
        Ok(owner)
    }

    fn snapshot_states(&self) -> Result<HashMap<String, LiveWindowRecord>, String> {
        let windows = self
            .live
            .windows
            .lock()
            .map_err(|_| "The runtime tab presentation registry is unavailable.".to_owned())?
            .iter()
            .map(|(window_id, state)| (window_id.clone(), Arc::clone(state)))
            .collect::<Vec<_>>();
        windows
            .into_iter()
            .map(|(window_id, state)| {
                state
                    .lock()
                    .map(|state| (window_id, state.clone()))
                    .map_err(|_| "A runtime tab presentation state is unavailable.".to_owned())
            })
            .collect()
    }

    fn tab_for_source(&self, source_id: &str, tab_type: &str) -> Option<String> {
        self.live.windows.lock().ok().and_then(|windows| {
            windows.values().find_map(|window| {
                window.lock().ok().and_then(|state| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.source_id == source_id && tab.tab_type == tab_type)
                        .map(|tab| tab.id.clone())
                })
            })
        })
    }

    fn tab_for_launcher_source(&self, source_id: &str, tab_type: &str) -> Option<String> {
        let mut windows = self.snapshot_states().ok()?.into_iter().collect::<Vec<_>>();
        windows.sort_by(|left, right| left.0.cmp(&right.0));
        windows.into_iter().find_map(|(_, window)| {
            window.tabs.into_iter().find_map(|tab| {
                let matches = if tab_type == "workspace" {
                    tab.tab_type == "workspace" && tab.source_id == source_id
                } else {
                    tab.role_ids.iter().any(|role_id| role_id == source_id)
                        || (tab.tab_type == "role" && tab.source_id == source_id)
                };
                matches.then_some(tab.id)
            })
        })
    }

    fn launcher_presence(&self) -> Result<RuntimeLauncherPresence, String> {
        let mut windows = self.snapshot_states()?.into_iter().collect::<Vec<_>>();
        windows.sort_by(|left, right| left.0.cmp(&right.0));
        let launcher_windows = windows
            .iter()
            .filter_map(|(window_id, window)| {
                if window.tabs.is_empty() {
                    return None;
                }
                let title = window.persisted_name.clone().or_else(|| {
                    window
                        .selected_tab_id
                        .as_deref()
                        .and_then(|active_tab_id| {
                            window
                                .tabs
                                .iter()
                                .find(|tab| tab.id == active_tab_id)
                        })
                        .or_else(|| window.tabs.first())
                        .map(|tab| tab.title.clone())
                });
                Some(RuntimeLauncherPresenceWindow {
                    persisted: window.persisted_name.is_some(),
                    title: title.unwrap_or_else(|| RION_STUDIO_APP_NAME.to_owned()),
                    window_id: window_id.clone(),
                })
            })
            .collect::<Vec<_>>();
        let mut tabs = windows
            .into_iter()
            .flat_map(|(_, window)| {
                window
                    .tabs
                    .into_iter()
                    .map(|tab| RuntimeLauncherPresenceTab {
                        role_ids: tab.role_ids,
                        source_id: tab.source_id,
                        tab_id: tab.id,
                        tab_type: tab.tab_type,
                    })
            })
            .collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.tab_id.cmp(&right.tab_id));
        Ok(RuntimeLauncherPresence {
            tabs,
            windows: launcher_windows,
        })
    }

    fn actor(
        &self,
        window_id: &str,
        window_generation: u64,
    ) -> Result<Arc<NativeWindowActor>, String> {
        let mut actors = self
            .actors
            .lock()
            .map_err(|_| "The native window actor registry is unavailable.".to_owned())?;
        if let Some(actor) = actors.get(window_id)
            && actor.matches_generation(window_generation)
        {
            return Ok(Arc::clone(actor));
        }
        if let Some(stale) = actors.remove(window_id) {
            stale.stop();
        }
        let actor = NativeWindowActor::start(window_id, window_generation)?;
        actors.insert(window_id.to_owned(), Arc::clone(&actor));
        Ok(actor)
    }

    fn applied_window_visibility(&self, window_id: &str) -> Option<bool> {
        self.actors
            .lock()
            .ok()
            .and_then(|actors| actors.get(window_id).cloned())
            .and_then(|actor| actor.applied_window_visibility())
    }

    fn record_externally_applied_presentation(
        &self,
        window_id: &str,
        revision: u64,
        tab_id: Option<&str>,
        surfaces: &[Webview],
    ) {
        let surface_labels = presentation_surface_labels(surfaces);
        let surface_owner_revisions = self.surface_owner_revisions(&surface_labels);
        let surface_identities =
            presentation_owner_identities(surfaces, &surface_owner_revisions);
        if let Ok(projection) = self.projection_coordinator(window_id)
            && let Ok(mut projection) = projection.lock()
            && revision >= projection.applied_revision
        {
            projection.applied_revision = revision;
            projection.applied_tab_id = tab_id.map(str::to_owned);
        }
        let actor = self
            .actors
            .lock()
            .ok()
            .and_then(|actors| actors.get(window_id).cloned());
        if let Some(actor) = actor {
            actor.record_externally_applied_presentation(
                revision,
                tab_id.map(str::to_owned),
                surface_identities,
                surfaces.to_vec(),
            );
        }
    }

    fn unbind_surface(&self, instance_id: &str, surface_label: &str) -> Option<String> {
        if let Ok(mut owners) = self.surface_owners.lock()
            && owners
                .get(surface_label)
                .is_some_and(|owner| owner.instance_id == instance_id)
        {
            owners.remove(surface_label);
        }
        let windows = self
            .projection
            .windows
            .lock()
            .ok()
            .map(|windows| {
                windows
                    .iter()
                    .map(|(window_id, projection)| (window_id.clone(), Arc::clone(projection)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (window_id, window) in windows {
            if let Ok(mut projection) = window.lock()
                && projection.unbind_surface(instance_id)
            {
                if let Some(actor) = self
                    .actors
                    .lock()
                    .ok()
                    .and_then(|actors| actors.get(&window_id).cloned())
                {
                    actor.forget_surface(instance_id, surface_label);
                }
                return Some(window_id);
            }
        }
        None
    }

    fn remove(&self, window_id: &str) {
        let removed_tab_ids = self
            .existing(window_id)
            .and_then(|window| window.lock().ok().map(|window| window.all_tab_ids()))
            .unwrap_or_default();
        if let Ok(mut windows) = self.live.windows.lock() {
            windows.remove(window_id);
        }
        if let Ok(mut windows) = self.projection.windows.lock() {
            windows.remove(window_id);
        }
        self.statuses.remove_many(&removed_tab_ids);
        if let Ok(mut actors) = self.actors.lock()
            && let Some(actor) = actors.remove(window_id)
        {
            actor.stop();
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    active_geometry_windows: HashSet<String>,
    #[cfg(not(windows))]
    active_window_resize_workers: HashSet<String>,
    allow_window_close_labels: HashSet<String>,
    audible_webviews: HashMap<String, bool>,
    auto_restore_attempted: bool,
    close_coordinator: CloseCoordinator,
    controlled_navigation_webviews: HashMap<String, u32>,
    dormant_windows: Vec<RuntimeRestoreWindowRecord>,
    launch_attempt_generations: HashMap<String, String>,
    main_frame_navigation_input_fences: HashMap<String, MainFrameNavigationInputFence>,
    role_input_fences: HashMap<String, RoleInputFence>,
    last_completed_document_ids: HashMap<String, String>,
    last_input_ready_epochs: HashMap<String, u64>,
    pending_macro_page_request: Option<Value>,
    close_previews: HashMap<String, TabCloseTombstone>,
    completed_failed_launch_cleanups: HashSet<(String, String)>,
    failed_launch_diagnostics: HashMap<String, RuntimeErrorDiagnostic>,
    optimistic_closed_tabs: HashSet<String>,
    pending_restore_role_slots: HashMap<String, Vec<GameWindowRoleSlotRecord>>,
    pending_window_tab_restores: HashMap<String, PendingWindowTabRestore>,
    pending_role_zoom_writes: HashMap<(String, String), u64>,
    #[cfg(not(windows))]
    pending_window_resizes: HashMap<String, PendingWindowResize>,
    native_tab_hosts: HashMap<String, String>,
    quarantined_window_hosts: HashSet<String>,
    retiring_window_cleanup_failed: HashSet<String>,
    retiring_window_revisions: HashMap<String, u64>,
    retiring_window_tabs: HashMap<String, HashSet<String>>,
    window_closes: WindowCloseLedger,
    overlay_capabilities: HashMap<String, String>,
    overlay_ready_webviews: HashSet<String>,
    popup_roles: HashMap<String, String>,
    active_provisional_launches: HashMap<String, String>,
    provisional_launches: HashMap<String, ProvisionalLaunch>,
    role_placeholder_identities: HashMap<String, RuntimeRolePlaceholderIdentity>,
    automatic_launch_retries: HashMap<String, u8>,
    retryable_failed_launches: HashSet<String>,
    recovery_required: bool,
    recovery_interrupted_window_ids: Vec<String>,
    recovery_session_generation: u32,
    recovery_budgets: HashMap<String, RecoveryBudget>,
    recovery_generations: HashMap<String, u64>,
    recovering_roles: HashSet<String>,
    #[cfg(target_os = "macos")]
    content_layout_revisions: HashMap<String, u64>,
    #[cfg(target_os = "macos")]
    ready_surface_viewports: HashMap<String, ReadySurfaceViewportState>,
    role_tabs: HashMap<String, String>,
    saved_window_names: HashMap<String, String>,
    session_import_backups: HashMap<String, NativeSessionBackup>,
    surface_registry: HashMap<String, ManagedSurface>,
    tab_drag_cursor_leases: HashMap<String, TabDragCursorLease>,
    tab_drag_placement_suppressed_windows: HashSet<String>,
    retired_surface_registry: HashMap<String, ManagedSurface>,
    display_hosts: HashMap<String, RuntimeDisplayHost>,
    tabs: HashMap<String, RuntimeTab>,
}

struct InputReadinessRegistry {
    changed: watch::Sender<u64>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct ReadySurfaceViewportState {
    applied_layout_revision: u64,
    applied_page_revision: u64,
    instance_id: String,
    page_revision: u64,
    tab_id: String,
    window_id: String,
}

struct PendingWindowActivation {
    trigger: &'static str,
    window_generation: u64,
    window_id: String,
}

impl InputReadinessRegistry {
    fn new() -> Self {
        let (changed, _) = watch::channel(0);
        Self { changed }
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn notify(&self) {
        self.changed.send_modify(|revision| {
            *revision = revision.wrapping_add(1).max(1);
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingWindowTabRestore {
    active_tab_id: Option<String>,
    host_created: bool,
    ordered_tab_ids: Vec<String>,
    reserved_tab_ids: HashSet<String>,
    successful_tab_ids: HashSet<String>,
    terminal_tab_ids: HashSet<String>,
    visible_tab_ids: Vec<String>,
}

#[derive(Clone)]
struct TabCloseTombstone {
    revision: u64,
    retirement_revision: Option<u64>,
    slot_owners: Vec<(String, String, Option<u64>)>,
    source_id: String,
    tab_type: String,
    window_id: String,
}

pub(crate) struct RuntimeTabCloseIntent {
    pub(crate) source_id: String,
    pub(crate) tab_type: String,
}

#[derive(Clone)]
struct NativeSessionBackup {
    cookies: Vec<Cookie<'static>>,
    local_storage: Vec<(String, String)>,
    storage_touched: bool,
}

struct RoleSessionTransferRequest<'a> {
    role_id: &'a str,
    launch_url: &'a str,
    webview2_user_data_dir: &'a str,
    webkit_data_store_identifier: &'a str,
    replace_existing: bool,
    payload: SessionTransferPayloadRecord,
    backup_transaction_id: Option<&'a str>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionBackup {
    payload: SessionTransferPayloadRecord,
    storage_touched: bool,
}

struct RuntimeWebViewConfiguration {
    #[cfg(windows)]
    additional_browser_arguments: String,
    document_start_script: String,
    macos_high_refresh_rate: bool,
    overlay_document_start_script_template: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceDiagnosticReadback {
    document_visibility_state: String,
    document_has_focus: bool,
    viewport_width: f64,
    viewport_height: f64,
    device_pixel_ratio: f64,
    hardware_concurrency: u32,
    frame_count: u32,
    observed_duration_ms: f64,
    average_fps: Option<f64>,
    #[serde(default)]
    frame_intervals_ms: Vec<f64>,
    p50_frame_interval_ms: Option<f64>,
    p95_frame_interval_ms: Option<f64>,
    p99_frame_interval_ms: Option<f64>,
    longest_frame_interval_ms: Option<f64>,
    long_task_count: Option<u32>,
    long_task_total_duration_ms: Option<f64>,
    longest_task_ms: Option<f64>,
    graphics: StateWebGraphicsRecord,
}

struct PerformanceDiagnosticSurface {
    high_refresh_rate_status: HighRefreshRateDiagnosticStatus,
    origin: Option<String>,
    role_id: String,
    webview: Webview,
}

struct PerformanceDiagnosticWindow {
    focused: bool,
    surfaces: Vec<PerformanceDiagnosticSurface>,
    window: Window,
    window_id: String,
}

struct PlatformPerformanceEnvironment {
    system_low_power_mode_enabled: Option<bool>,
    system_thermal_state: Option<String>,
}

#[derive(Clone)]
struct RuntimeShortcutModifierHandoff {
    modifier_codes: Vec<String>,
    #[cfg(windows)]
    source_role_id: Option<String>,
    source_tab_id: String,
    #[cfg(windows)]
    source_webview_label: Option<String>,
    started_at: Instant,
    window_id: String,
}

struct RoleInputDispatchLane {
    epoch: AtomicU64,
    normal_enabled: AtomicBool,
    quarantined: AtomicBool,
    sequence: Mutex<()>,
    surface_generation: AtomicU64,
}

impl Default for RoleInputDispatchLane {
    fn default() -> Self {
        Self {
            epoch: AtomicU64::new(0),
            normal_enabled: AtomicBool::new(true),
            quarantined: AtomicBool::new(false),
            sequence: Mutex::new(()),
            surface_generation: AtomicU64::new(0),
        }
    }
}

#[derive(Clone)]
struct InputDispatchContext {
    deadline: Instant,
    input_epoch: u64,
    intent: String,
    lane: Arc<RoleInputDispatchLane>,
    surface_generation: u64,
}

impl InputDispatchContext {
    fn is_cleanup(&self) -> bool {
        self.intent == "cleanup"
    }

    fn ensure_current(&self) -> RuntimeResult<()> {
        if self.lane.epoch.load(Ordering::Acquire) != self.input_epoch {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete role input epoch.",
            ));
        }
        if self.lane.surface_generation.load(Ordering::Acquire) != self.surface_generation {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action belongs to an obsolete System WebView surface.",
            ));
        }
        if !self.is_cleanup() && !self.lane.normal_enabled.load(Ordering::Acquire) {
            return Err(RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_QUARANTINED",
                "Automatic input is disabled for this role until it is restarted.",
            ));
        }
        if !self.is_cleanup() && Instant::now() >= self.deadline {
            return Err(RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action deadline expired.",
            ));
        }
        Ok(())
    }

    fn remaining(&self, maximum: Duration) -> Duration {
        if self.is_cleanup() {
            return maximum;
        }
        self.deadline
            .saturating_duration_since(Instant::now())
            .min(maximum)
    }
}

#[derive(Clone)]
struct NativeInputSubmissionGuard {
    context: InputDispatchContext,
    state: Arc<AtomicU8>,
}

impl NativeInputSubmissionGuard {
    fn new(context: &InputDispatchContext) -> Self {
        Self {
            context: context.clone(),
            state: Arc::new(AtomicU8::new(0)),
        }
    }

    fn claim(&self) -> bool {
        self.context.ensure_current().is_ok()
            && self
                .state
                .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    fn timeout_error(&self) -> RuntimeError {
        match self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => RuntimeError::new(
                "BROWSER_ACTION_DEADLINE",
                "Browser action expired before native input submission.",
            ),
            Err(2) => RuntimeError::new(
                "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
                "Native input was submitted but did not confirm before its deadline.",
            ),
            Err(_) => RuntimeError::new(
                "BROWSER_ACTION_STALE",
                "Browser action was cancelled before native input submission.",
            ),
        }
    }
}

pub struct SystemRuntimeExecutor {
    app: AppHandle,
    close_effect_senders: OnceLock<Vec<mpsc::SyncSender<ConcurrentRuntimeWork>>>,
    configuration: RuntimeWebViewConfiguration,
    core: Arc<AppCore>,
    critical_activity_sequence: AtomicU64,
    effect_sender: OnceLock<Sender<SystemRuntimeWork>>,
    lifecycle_sender: OnceLock<Sender<ApplicationLifecycleSignal>>,
    diagnostics: Mutex<RuntimeDiagnosticsState>,
    health: RuntimeHealth,
    focus_broker: Arc<NativeFocusBroker>,
    language: Mutex<String>,
    resolved_theme: Mutex<String>,
    last_performance_diagnostics: Mutex<Option<BrowserPerformanceDiagnosticsRecord>>,
    launch_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    input_effect_sender: OnceLock<mpsc::SyncSender<ConcurrentRuntimeWork>>,
    input_effect_lanes: Mutex<HashMap<String, mpsc::SyncSender<ConcurrentRuntimeWork>>>,
    last_critical_activity: Mutex<Instant>,
    main_window_actor: Arc<MainWindowActor>,
    application_lifecycle: Arc<ApplicationLifecycleCoordinator>,
    input_dispatch_lanes: Mutex<HashMap<String, Arc<RoleInputDispatchLane>>>,
    input_readiness: InputReadinessRegistry,
    native_creation_lanes: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    native_creation_slots: NativeCreationGate,
    operations: Arc<NativeOperationRegistry>,
    native_window_mutations: Arc<NativeWindowMutationRegistry>,
    optional_hydration_sender: OnceLock<mpsc::SyncSender<OptionalHydrationWork>>,
    optional_idle_changed: Condvar,
    pending_window_activation: Mutex<Option<PendingWindowActivation>>,
    presentation: Arc<PresentationRegistry>,
    surface_recoveries: SurfaceRecoveryRegistry,
    tab_close_changed: Condvar,
    tab_drag_intents: Arc<TabDragIntentCoordinator>,
    tab_mutations: Arc<TabMutationCoordinator>,
    #[cfg(windows)]
    tab_chrome_projections: Arc<TabChromeProjectionCoordinator>,
    prewarm_state: AtomicU8,
    retiring_tab_senders: OnceLock<Vec<mpsc::Sender<(String, String)>>>,
    restore_persist_requested: AtomicU64,
    restore_persist_running: AtomicBool,
    restore_persist_changed: Condvar,
    restore_persist_signal: Mutex<()>,
    runtime_projection: RevisionedJsonProjection,
    shortcut_modifier_handoffs: Mutex<HashMap<String, RuntimeShortcutModifierHandoff>>,
    self_weak: OnceLock<std::sync::Weak<SystemRuntimeExecutor>>,
    shutdown_operation: OnceLock<NativeOperationContext>,
    shutdown_state: Arc<AtomicU8>,
    state: Mutex<RuntimeState>,
    window_state_persistence: WindowStatePersistCoordinator,
    user_data_dir: PathBuf,
}

struct RuntimeHealth(AtomicBool);

impl RuntimeHealth {
    fn new() -> Self {
        Self(AtomicBool::new(true))
    }

    fn is_healthy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn mark_unhealthy(&self) {
        self.0.store(false, Ordering::Release);
    }

}

enum SystemRuntimeWork {
    Effect {
        action_name: &'static str,
        effect: Box<CoreEffectRequest>,
        presentation_revision: u64,
        persist_runtime: bool,
    },
    RecoverSurface {
        allowed: bool,
        reason: String,
        transaction: Box<SurfaceRecoveryTransaction>,
    },
}

struct ConcurrentRuntimeWork {
    action_name: &'static str,
    effect: CoreEffectRequest,
    persist_runtime: bool,
    presentation_revision: u64,
}

struct OptionalHydrationWork {
    tab_id: String,
}
