impl NativeWindowActor {
    fn start(window_id: &str, generation: u64) -> Result<Arc<Self>, String> {
        let queue = Arc::new((
            Mutex::new(NativeWindowActorState::default()),
            Condvar::new(),
        ));
        let liveness = Arc::new(AtomicBool::new(true));
        let worker_queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name(format!("rion-native-window-{window_id}"))
            .spawn(move || {
                loop {
                    let batch = {
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
                        let mut observed_revision = state
                            .requests
                            .back()
                            .map(|request| request.revision)
                            .unwrap_or(0);
                        loop {
                            let Ok((next, timeout)) =
                                changed.wait_timeout(state, NATIVE_PRESENTATION_COALESCE_INTERVAL)
                            else {
                                return;
                            };
                            state = next;
                            if state.stopped {
                                return;
                            }
                            let latest_revision = state
                                .requests
                                .back()
                                .map(|request| request.revision)
                                .unwrap_or(0);
                            if latest_revision != observed_revision {
                                observed_revision = latest_revision;
                                continue;
                            }
                            if timeout.timed_out() {
                                break;
                            }
                        }
                        let Some(request) = state.requests.begin_next() else {
                            continue;
                        };
                        if let Ok(mut coordinator) = request.coordinator.lock() {
                            coordinator.scheduled = false;
                            coordinator.in_flight = true;
                        }
                        Some(NativePresentationBatch {
                            first_requested_at: state
                                .burst_first_requested_at
                                .take()
                                .unwrap_or(request.requested_at),
                            first_revision: std::mem::take(&mut state.burst_first_revision),
                            request,
                            request_count: std::mem::take(&mut state.burst_request_count).max(1),
                        })
                    };
                    let Some(batch) = batch else {
                        continue;
                    };
                    if !batch
                        .request
                        .operations
                        .mark_in_flight(&batch.request.operation.operation_id)
                    {
                        let (lock, changed) = &*worker_queue;
                        if let Ok(mut state) = lock.lock() {
                            state.requests.finish();
                            if let Ok(mut coordinator) = batch.request.coordinator.lock() {
                                coordinator.in_flight = false;
                                coordinator.scheduled = !state.requests.is_empty();
                            }
                            changed.notify_one();
                        }
                        continue;
                    }
                    let previous = worker_queue
                        .0
                        .lock()
                        .ok()
                        .map(|state| {
                            (
                                state.applied_tab_id.clone(),
                                state.applied_surface_identities.clone(),
                                state.applied_surfaces.clone(),
                                state.applied_window_visibility,
                            )
                        })
                        .unwrap_or_default();
                    let plan = batch.request.plan();
                    let (outcome, receipt) = TauriNativePresentationAdapter.apply(
                        &plan,
                        &batch.request,
                        &previous.0,
                        &previous.1,
                        previous.2,
                        previous.3,
                    );
                    let (lock, changed) = &*worker_queue;
                    let Ok(mut state) = lock.lock() else {
                        return;
                    };
                    if outcome.applied {
                        state.applied_revision = batch.request.revision;
                        if let Some(window_visibility) = batch.request.window_visibility {
                            state.applied_window_visibility = Some(window_visibility);
                        }
                    }
                    if outcome.presentation_applied {
                        state.applied_tab_id = batch.request.tab_id.clone();
                        state.applied_surface_identities = presentation_owner_identities(
                            &batch.request.next_surfaces,
                            &batch.request.surface_owner_tokens,
                        );
                        state.applied_surfaces = batch.request.next_surfaces.clone();
                    }
                    state.last_receipt = Some(receipt.clone());
                    batch
                        .request
                        .operations
                        .complete(receipt.operation.clone());
                    state.requests.finish();
                    let has_pending = !state.requests.is_empty();
                    if let Ok(mut coordinator) = batch.request.coordinator.lock() {
                        coordinator.in_flight = false;
                        coordinator.scheduled = has_pending;
                        if outcome.presentation_applied {
                            coordinator.applied_revision = batch.request.revision;
                            coordinator.applied_tab_id = batch.request.tab_id.clone();
                        }
                    }
                    changed.notify_one();
                    drop(state);
                    capture_presentation_batch_events(&batch, &outcome, &receipt);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(Self {
            generation,
            liveness,
            queue,
        }))
    }

    fn matches_generation(&self, generation: u64) -> bool {
        self.generation == generation && self.liveness.load(Ordering::Acquire)
    }

    fn liveness(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.liveness)
    }

    fn dispatch(&self, mut request: NativePresentationRequest) -> Result<(), String> {
        let (lock, changed) = &*self.queue;
        let mut state = match lock.lock() {
            Ok(state) => state,
            Err(_) => {
                request.operations.complete(NativeOperationReceipt::with_status(
                    request.operation,
                    "nativePresentationActorUnavailable",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_PRESENTATION_ACTOR_UNAVAILABLE"),
                ));
                return Ok(());
            }
        };
        if state.stopped {
            request.operations.complete(NativeOperationReceipt::with_status(
                request.operation,
                "nativePresentationStopped",
                NativeOperationStatus::Superseded,
                None,
            ));
            return Ok(());
        }
        // The actor can know about covered surfaces that the live selected-tab
        // snapshot cannot see after an external AppKit reparent. Fence those
        // surfaces too, otherwise the next selection would correctly target a
        // tab but skip hiding the covered destination presentation.
        if let Ok(surface_owners) = request.surface_owners.lock() {
            for surface in &state.applied_surfaces {
                if let Some(owner) = surface_owners.get(surface.label()) {
                    request
                        .surface_owner_tokens
                        .entry(surface.label().to_owned())
                        .or_insert_with(|| owner.clone());
                }
            }
        }
        if state.applied_revision == 0
            && !state.requests.in_flight
            && state.requests.is_empty()
            && state.applied_surfaces.is_empty()
        {
            state.applied_tab_id = request.observed_previous_tab_id.clone();
            state.applied_surface_identities = presentation_owner_identities(
                &request.observed_previous_surfaces,
                &request.surface_owner_tokens,
            );
            state.applied_surfaces = request.observed_previous_surfaces.clone();
        }
        let queue_was_empty = state.requests.is_empty();
        let requested_at = request.requested_at;
        let revision = request.revision;
        let coordinator = Arc::clone(&request.coordinator);
        let ordered = request.window_mode.is_some() || request.window_visibility.is_some();
        let superseded = if ordered {
            if let Err(rejected) = state.requests.enqueue_ordered(request) {
                rejected.operations.complete(NativeOperationReceipt::with_status(
                    rejected.operation,
                    "nativePresentationQueueFull",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_PRESENTATION_QUEUE_FULL"),
                ));
                return Ok(());
            }
            None
        } else {
            match state.requests.enqueue_latest(request) {
                Ok(superseded) => superseded,
                Err(rejected) => {
                    rejected.operations.complete(NativeOperationReceipt::with_status(
                        rejected.operation,
                        "nativePresentationQueueFull",
                        NativeOperationStatus::Failed,
                        Some("NATIVE_PRESENTATION_QUEUE_FULL"),
                    ));
                    return Ok(());
                }
            }
        };
        if queue_was_empty {
            state.burst_first_requested_at = Some(requested_at);
            state.burst_first_revision = revision;
            state.burst_request_count = 1;
        } else {
            state.burst_request_count = state.burst_request_count.saturating_add(1);
        }
        if let Ok(mut coordinator) = coordinator.lock() {
            coordinator.scheduled = true;
        }
        if let Some(superseded) = superseded {
            superseded.operations.complete(NativeOperationReceipt::with_status(
                superseded.operation,
                "nativePresentationQueued",
                NativeOperationStatus::Superseded,
                None,
            ));
        }
        changed.notify_one();
        Ok(())
    }

    fn wait_until_applied(&self, revision: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (lock, changed) = &*self.queue;
        let Ok(mut state) = lock.lock() else {
            return false;
        };
        while state.applied_revision < revision && !state.stopped {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, wait)) = changed.wait_timeout(state, remaining) else {
                return false;
            };
            state = next;
            if wait.timed_out() && state.applied_revision < revision {
                return false;
            }
        }
        state.applied_revision >= revision
    }

    fn applied_window_visibility(&self) -> Option<bool> {
        self.queue
            .0
            .lock()
            .ok()
            .and_then(|state| state.applied_window_visibility)
    }

    fn forget_surface(&self, instance_id: &str, surface_label: &str) {
        let (lock, changed) = &*self.queue;
        if let Ok(mut state) = lock.lock() {
            state
                .applied_surface_identities
                .retain(|(applied_instance_id, _)| applied_instance_id != instance_id);
            state
                .applied_surfaces
                .retain(|surface| surface.label() != surface_label);
            changed.notify_all();
        }
    }

    fn stop(&self) {
        self.liveness.store(false, Ordering::Release);
        let (lock, changed) = &*self.queue;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            let superseded = state.requests.drain().collect::<Vec<_>>();
            for superseded in superseded {
                superseded.operations.complete(NativeOperationReceipt::with_status(
                    superseded.operation,
                    "nativePresentationStopped",
                    NativeOperationStatus::Superseded,
                    None,
                ));
            }
            changed.notify_all();
        }
    }
}

#[cfg(test)]
impl NativeWindowActorState {
    fn record_externally_applied_presentation(
        &mut self,
        revision: u64,
        tab_id: Option<String>,
        surface_identities: HashSet<(String, u64)>,
        surfaces: Vec<Webview>,
    ) {
        if self.stopped || revision < self.applied_revision {
            return;
        }
        self.applied_revision = revision;
        self.applied_tab_id = tab_id;
        let replaced_instance_ids = surface_identities
            .iter()
            .map(|(instance_id, _)| instance_id.clone())
            .collect::<HashSet<_>>();
        self.applied_surface_identities
            .retain(|(instance_id, _)| !replaced_instance_ids.contains(instance_id));
        self.applied_surface_identities.extend(surface_identities);
        let mut retained_labels = self
            .applied_surfaces
            .iter()
            .map(|surface| surface.label().to_owned())
            .collect::<HashSet<_>>();
        self.applied_surfaces.extend(
            surfaces
                .into_iter()
                .filter(|surface| retained_labels.insert(surface.label().to_owned())),
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TabRuntimePhase {
    Dormant,
    Activating,
    Reserved,
    Attaching,
    Loading,
    Ready,
    Degraded,
    Failed,
}

impl TabRuntimePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dormant => "dormant",
            Self::Activating | Self::Reserved => "activating",
            Self::Attaching => "attaching",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
        }
    }

    #[cfg(windows)]
    fn as_record(self) -> RuntimeTabActivationPhaseRecord {
        match self {
            Self::Dormant => RuntimeTabActivationPhaseRecord::Dormant,
            Self::Activating | Self::Reserved => RuntimeTabActivationPhaseRecord::Activating,
            Self::Attaching => RuntimeTabActivationPhaseRecord::Attaching,
            Self::Loading => RuntimeTabActivationPhaseRecord::Loading,
            Self::Ready => RuntimeTabActivationPhaseRecord::Ready,
            Self::Degraded => RuntimeTabActivationPhaseRecord::Degraded,
            Self::Failed => RuntimeTabActivationPhaseRecord::Failed,
        }
    }

    fn from_record(phase: RuntimeTabActivationPhaseRecord) -> Self {
        match phase {
            RuntimeTabActivationPhaseRecord::Dormant => Self::Dormant,
            RuntimeTabActivationPhaseRecord::Activating => Self::Activating,
            RuntimeTabActivationPhaseRecord::Attaching => Self::Attaching,
            RuntimeTabActivationPhaseRecord::Loading => Self::Loading,
            RuntimeTabActivationPhaseRecord::Ready => Self::Ready,
            RuntimeTabActivationPhaseRecord::Degraded => Self::Degraded,
            RuntimeTabActivationPhaseRecord::Failed => Self::Failed,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeTabDragWindowSnapshot {
    pub(crate) generation: u64,
    pub(crate) tab_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeLauncherPresenceTab {
    pub(crate) role_ids: Vec<String>,
    pub(crate) source_id: String,
    pub(crate) tab_id: String,
    pub(crate) tab_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeLauncherPresenceWindow {
    pub(crate) persisted: bool,
    pub(crate) title: String,
    pub(crate) window_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RuntimeLauncherPresence {
    pub(crate) tabs: Vec<RuntimeLauncherPresenceTab>,
    pub(crate) windows: Vec<RuntimeLauncherPresenceWindow>,
}

fn retain_live_runtime_launcher_tabs(
    presence: &mut RuntimeLauncherPresence,
    live_tab_ids: &HashSet<String>,
) {
    presence
        .tabs
        .retain(|tab| live_tab_ids.contains(&tab.tab_id));
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LiveTabRuntimeStatus {
    failure_code: Option<String>,
    launch_phase: Option<LaunchPhase>,
    presentation_phase: TabRuntimePhase,
}

#[derive(Default)]
struct TabRuntimeStatusStore {
    tabs: Mutex<HashMap<String, LiveTabRuntimeStatus>>,
}

impl NativeTabProjectionState {
    fn bind_surface(&mut self, tab_id: &str, binding: SurfacePresentationBinding) {
        let bindings = self
            .surface_bindings
            .entry(tab_id.to_owned())
            .or_default();
        if let Some(existing) = bindings
            .iter_mut()
            .find(|existing| existing.instance_id == binding.instance_id)
        {
            *existing = binding;
        } else {
            bindings.push(binding);
        }
    }

    fn unbind_surface(&mut self, instance_id: &str) -> bool {
        let mut removed = false;
        self.surface_bindings.retain(|_, bindings| {
            let previous_len = bindings.len();
            bindings.retain(|binding| binding.instance_id != instance_id);
            removed |= previous_len != bindings.len();
            !bindings.is_empty()
        });
        removed
    }

    fn surfaces(&self, tab_id: Option<&str>) -> Vec<Webview> {
        tab_id
            .and_then(|tab_id| self.surface_bindings.get(tab_id))
            .map(|bindings| {
                bindings
                    .iter()
                    .filter(|binding| !binding.instance_id.is_empty())
                    .map(|binding| binding.webview.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn surface_identities(&self, tab_id: Option<&str>) -> HashSet<(String, u64)> {
        tab_id
            .and_then(|tab_id| self.surface_bindings.get(tab_id))
            .map(|bindings| {
                bindings
                    .iter()
                    .map(|binding| (binding.instance_id.clone(), binding.generation))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl TabRuntimeStatusStore {
    fn presentation_phase(&self, tab_id: &str) -> TabRuntimePhase {
        self.tabs
            .lock()
            .ok()
            .and_then(|tabs| tabs.get(tab_id).cloned())
            .map(|status| status.presentation_phase)
            .unwrap_or(TabRuntimePhase::Ready)
    }

    fn permits_content_surface(&self, tab_id: &str) -> bool {
        matches!(
            self.presentation_phase(tab_id),
            TabRuntimePhase::Ready | TabRuntimePhase::Degraded
        )
    }

    fn launch_phases(&self) -> Vec<LaunchPhase> {
        self.tabs
            .lock()
            .ok()
            .map(|tabs| {
                tabs.values()
                    .filter_map(|status| status.launch_phase)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn launch_phase(&self, tab_id: &str) -> Option<LaunchPhase> {
        self.tabs
            .lock()
            .ok()?
            .get(tab_id)
            .and_then(|status| status.launch_phase)
    }

    fn failure_code(&self, tab_id: &str) -> Option<String> {
        self.tabs
            .lock()
            .ok()?
            .get(tab_id)
            .and_then(|status| status.failure_code.clone())
    }

    fn set_presentation_phase(&self, tab_id: &str, phase: TabRuntimePhase) {
        if let Ok(mut tabs) = self.tabs.lock() {
            tabs.entry(tab_id.to_owned())
                .and_modify(|status| {
                    status.presentation_phase = phase;
                    if phase != TabRuntimePhase::Failed {
                        status.failure_code = None;
                    }
                })
                .or_insert(LiveTabRuntimeStatus {
                    failure_code: None,
                    launch_phase: None,
                    presentation_phase: phase,
                });
        }
    }

    fn set_failure(&self, tab_id: &str, failure_code: &str) {
        if let Ok(mut tabs) = self.tabs.lock() {
            tabs.entry(tab_id.to_owned())
                .and_modify(|status| {
                    status.failure_code = Some(failure_code.to_owned());
                    status.presentation_phase = TabRuntimePhase::Failed;
                })
                .or_insert(LiveTabRuntimeStatus {
                    failure_code: Some(failure_code.to_owned()),
                    launch_phase: None,
                    presentation_phase: TabRuntimePhase::Failed,
                });
        }
    }

    fn set_launch_phase(&self, tab_id: &str, phase: LaunchPhase) -> bool {
        let presentation_phase = match phase {
            LaunchPhase::Attaching => TabRuntimePhase::Attaching,
            LaunchPhase::Navigating => TabRuntimePhase::Loading,
            LaunchPhase::EssentialReady
            | LaunchPhase::OptionalHydrating
            | LaunchPhase::Ready => TabRuntimePhase::Ready,
            LaunchPhase::Degraded => TabRuntimePhase::Degraded,
        };
        self.tabs.lock().ok().is_some_and(|mut tabs| {
            let previous = tabs.insert(
                tab_id.to_owned(),
                LiveTabRuntimeStatus {
                    failure_code: None,
                    launch_phase: Some(phase),
                    presentation_phase,
                },
            );
            previous.is_none_or(|previous| previous.launch_phase != Some(phase))
        })
    }

    fn remove(&self, tab_id: &str) {
        if let Ok(mut tabs) = self.tabs.lock() {
            tabs.remove(tab_id);
        }
    }

    fn remove_many(&self, tab_ids: &[String]) {
        if let Ok(mut tabs) = self.tabs.lock() {
            for tab_id in tab_ids {
                tabs.remove(tab_id);
            }
        }
    }

    fn clear(&self) {
        if let Ok(mut tabs) = self.tabs.lock() {
            tabs.clear();
        }
    }
}

#[derive(Clone, Debug)]
struct ProvisionalLaunch {
    cancelled: bool,
    failed: bool,
    host_created: bool,
    id: String,
    launch_preview_id: String,
    source_id: String,
    tab_type: String,
    window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LaunchPreviewHandle {
    pub(crate) launch_preview_id: String,
    pub(crate) provisional_tab_id: String,
    pub(crate) source_key: String,
}

#[derive(Clone, Debug)]
struct RuntimeErrorDiagnostic {
    native_code: Option<String>,
    setup_stage: &'static str,
}

struct RoleSurfaceSetupFailure {
    error: RuntimeError,
    lifecycle: Option<Arc<SurfaceLifecycleTracker>>,
}
