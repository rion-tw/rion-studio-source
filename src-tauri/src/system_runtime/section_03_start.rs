impl NativeWindowActor {
    fn start(window_id: &str) -> Result<Arc<Self>, String> {
        let queue = Arc::new((
            Mutex::new(NativeWindowActorState::default()),
            Condvar::new(),
        ));
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
                            &batch.request.surface_owner_revisions,
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
        Ok(Arc::new(Self { queue }))
    }

    fn dispatch(&self, request: NativePresentationRequest) -> Result<(), String> {
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
                NativeOperationStatus::Failed,
                Some("NATIVE_PRESENTATION_ACTOR_STOPPED"),
            ));
            return Ok(());
        }
        if state.applied_revision == 0
            && !state.requests.in_flight
            && state.requests.is_empty()
            && state.applied_surfaces.is_empty()
        {
            state.applied_tab_id = request.observed_previous_tab_id.clone();
            state.applied_surface_identities = presentation_owner_identities(
                &request.observed_previous_surfaces,
                &request.surface_owner_revisions,
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

    fn stop(&self) {
        let (lock, changed) = &*self.queue;
        if let Ok(mut state) = lock.lock() {
            state.stopped = true;
            let superseded = state.requests.drain().collect::<Vec<_>>();
            for superseded in superseded {
                superseded.operations.complete(NativeOperationReceipt::with_status(
                    superseded.operation,
                    "nativePresentationStopped",
                    NativeOperationStatus::Failed,
                    Some("NATIVE_PRESENTATION_ACTOR_STOPPED"),
                ));
            }
            changed.notify_all();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TabPresentationPhase {
    Reserved,
    Attaching,
    Loading,
    Ready,
    Degraded,
    Failed,
}

impl TabPresentationPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Attaching => "attaching",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone)]
struct TabPresentation {
    closable: bool,
    icon_data_url: Option<String>,
    id: String,
    phase: TabPresentationPhase,
    role_ids: Vec<String>,
    source_id: String,
    tab_type: String,
    title: String,
    #[cfg(any(windows, target_os = "macos"))]
    workspace_template: Option<String>,
}

struct ProvisionalNativeTabMove {
    relocated: bool,
    source_active_after_move: Option<String>,
    source_active_before_move: Option<String>,
    tab: TabPresentation,
    target_active_after_move: Option<String>,
    target_active_before_move: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeTabDragWindowSnapshot {
    pub(crate) active_tab_id: Option<String>,
    pub(crate) generation: u64,
    pub(crate) tab_ids: Vec<String>,
    pub(crate) window_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeLauncherPresenceTab {
    pub(crate) role_ids: Vec<String>,
    pub(crate) source_id: String,
    pub(crate) tab_id: String,
    pub(crate) tab_type: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RuntimeLauncherPresence {
    pub(crate) tabs: Vec<RuntimeLauncherPresenceTab>,
}

fn retain_live_runtime_launcher_tabs(
    presence: &mut RuntimeLauncherPresence,
    live_tab_ids: &HashSet<String>,
) {
    presence
        .tabs
        .retain(|tab| live_tab_ids.contains(&tab.tab_id));
}

#[derive(Clone)]
struct SurfacePresentationBinding {
    generation: u64,
    instance_id: String,
    webview: Webview,
}

#[derive(Clone, Default)]
struct WindowPresentationState {
    aliases: HashMap<String, String>,
    applied_tab_id: Option<String>,
    applied_revision: u64,
    host_visibility: bool,
    in_flight: bool,
    revision: u64,
    scheduled: bool,
    selected_tab_id: Option<String>,
    surface_bindings: HashMap<String, Vec<SurfacePresentationBinding>>,
    tabs: Vec<TabPresentation>,
}

impl WindowPresentationState {
    fn tab_ids(&self) -> Vec<String> {
        self.tabs.iter().map(|tab| tab.id.clone()).collect()
    }

    fn contains_tab(&self, tab_id: &str) -> bool {
        self.tabs.iter().any(|tab| tab.id == tab_id)
    }

    fn insert_tab(&mut self, tab: TabPresentation, revision: u64, select: bool) {
        let id = tab.id.clone();
        if let Some(existing) = self.tabs.iter_mut().find(|existing| existing.id == id) {
            *existing = tab;
        } else {
            self.tabs.push(tab);
        }
        if select {
            self.select(Some(id), revision);
        }
    }

    fn replace_tab_id(&mut self, provisional_id: &str, mut tab: TabPresentation, revision: u64) {
        let selected_provisional = self.selected_tab_id.as_deref() == Some(provisional_id);
        if let Some(index) = self.tabs.iter().position(|item| item.id == provisional_id) {
            self.aliases
                .insert(provisional_id.to_owned(), tab.id.clone());
            let previous_bindings = self.surface_bindings.remove(provisional_id);
            let replacement_id = tab.id.clone();
            self.tabs[index] = tab;
            if let Some(bindings) = previous_bindings {
                self.surface_bindings
                    .insert(replacement_id.clone(), bindings);
            }
            if selected_provisional {
                self.select(Some(replacement_id), revision);
            }
        } else {
            tab.phase = TabPresentationPhase::Attaching;
            self.insert_tab(tab, revision, false);
        }
    }

    fn remove_tab(&mut self, tab_id: &str, revision: u64) -> bool {
        let existed = self.tabs.iter().any(|tab| tab.id == tab_id);
        self.tabs.retain(|tab| tab.id != tab_id);
        self.surface_bindings.remove(tab_id);
        self.aliases
            .retain(|alias, target| alias != tab_id && target != tab_id);
        if self.selected_tab_id.as_deref() == Some(tab_id) {
            self.select(None, revision);
        }
        existed
    }

    fn select(&mut self, tab_id: Option<String>, revision: u64) {
        self.revision = revision;
        self.host_visibility = tab_id.is_some();
        self.selected_tab_id = tab_id;
    }

    fn update_phase(&mut self, tab_id: &str, phase: TabPresentationPhase) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.phase = phase;
        }
    }

    fn update_metadata(
        &mut self,
        tab_id: &str,
        source_id: &str,
        tab_type: &str,
        role_ids: &[String],
        title: &str,
    ) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            tab.role_ids = role_ids.to_vec();
            tab.source_id = source_id.to_owned();
            tab.tab_type = tab_type.to_owned();
            tab.title = title.to_owned();
        }
    }

    fn reorder_known_tabs(&mut self, ordered_tab_ids: &[String]) {
        let mut positions = ordered_tab_ids
            .iter()
            .enumerate()
            .map(|(index, tab_id)| (tab_id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let fallback = ordered_tab_ids.len();
        self.tabs
            .sort_by_key(|tab| positions.remove(tab.id.as_str()).unwrap_or(fallback));
    }

    fn bind_surface(&mut self, tab_id: &str, binding: SurfacePresentationBinding) -> bool {
        if !self.contains_tab(tab_id) {
            return false;
        }
        let bindings = self.surface_bindings.entry(tab_id.to_owned()).or_default();
        if let Some(existing) = bindings
            .iter_mut()
            .find(|existing| existing.instance_id == binding.instance_id)
        {
            *existing = binding;
        } else {
            bindings.push(binding);
        }
        true
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

#[derive(Clone)]
struct ProvisionalLaunch {
    cancelled: bool,
    failed: bool,
    host_created: bool,
    id: String,
    source_id: String,
    tab_type: String,
    window_id: String,
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
