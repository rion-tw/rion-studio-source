#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct TabChromeRendererIdentity {
    last_intent_sequence: u64,
    lifecycle_epoch: u64,
    renderer_instance_id: String,
    webview_label: String,
    window_generation: u64,
    window_id: String,
}

#[cfg(any(windows, test))]
#[derive(Clone)]
struct TabChromeSemanticProjection {
    fingerprint: String,
    revision: u64,
}

#[cfg(any(windows, test))]
#[derive(Clone)]
struct TabChromeProjectionDelivery {
    acknowledgement: Option<RuntimeTabChromeAcknowledgementRecord>,
    active_tab_id: Option<String>,
    renderer_instance_id: String,
    revision: u64,
    tab_order: Vec<String>,
    terminal_status: Option<NativeOperationStatus>,
    topology_revision: u64,
}

#[cfg(any(windows, test))]
pub(crate) enum RuntimeTabIntentAdmission {
    Accepted {
        window_generation: u64,
        window_id: String,
    },
    Superseded {
        failure_code: &'static str,
        window_generation: u64,
        window_id: String,
    },
}

#[cfg(any(windows, test))]
fn tab_intent_source_identity_is_current(
    host_generation: u64,
    host_webview_label: &str,
    renderer_generation: u64,
    renderer_webview_label: &str,
) -> bool {
    host_generation == renderer_generation && host_webview_label == renderer_webview_label
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct TabChromeProjectionCoordinatorState {
    deliveries: HashMap<String, TabChromeProjectionDelivery>,
    renderers: HashMap<String, TabChromeRendererIdentity>,
    semantic: HashMap<String, TabChromeSemanticProjection>,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct TabChromeProjectionCoordinator {
    changed: Condvar,
    next_revision: AtomicU64,
    state: Mutex<TabChromeProjectionCoordinatorState>,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TabChromeProjectionWaitOutcome {
    Applied,
    Failed,
    Superseded,
    Timeout,
}

#[cfg(any(windows, test))]
fn query_tab_chrome_window_state_unlocked<State, Snapshot, Output>(
    state: &Mutex<State>,
    snapshot: impl FnOnce(&State) -> RuntimeResult<Snapshot>,
    query: impl FnOnce(Snapshot) -> RuntimeResult<Output>,
) -> RuntimeResult<Output> {
    let snapshot = {
        let state = state.lock().map_err(|_| {
            RuntimeError::new(
                "TAURI_RUNTIME_STATE_FAILED",
                "System runtime state lock poisoned.",
            )
        })?;
        snapshot(&state)?
    };
    query(snapshot)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsTabChromeRevealSignal {
    ProjectionApplied,
    RendererReady,
    VisibilityRequested,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsTabChromeRevealState {
    cloaked: bool,
    pending_focus_sequence: Option<u64>,
    projection_applied: bool,
    renderer_ready: bool,
    visibility_requested: bool,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct WindowsTabChromeRevealDecision {
    defer_focus: bool,
    focus_sequence: Option<u64>,
    reveal: bool,
}

#[cfg(any(windows, test))]
impl WindowsTabChromeRevealState {
    fn new(cloaked: bool) -> Self {
        Self {
            cloaked,
            pending_focus_sequence: None,
            projection_applied: false,
            renderer_ready: false,
            visibility_requested: false,
        }
    }

    fn observe(
        &mut self,
        signal: WindowsTabChromeRevealSignal,
    ) -> WindowsTabChromeRevealDecision {
        match signal {
            WindowsTabChromeRevealSignal::ProjectionApplied => self.projection_applied = true,
            WindowsTabChromeRevealSignal::RendererReady => self.renderer_ready = true,
            WindowsTabChromeRevealSignal::VisibilityRequested => {
                self.visibility_requested = true;
            }
        }
        self.finish_observation(false)
    }

    fn request_presentation(
        &mut self,
        focus_sequence: Option<u64>,
    ) -> WindowsTabChromeRevealDecision {
        let defer_focus = self.cloaked && focus_sequence.is_some();
        if defer_focus {
            self.pending_focus_sequence = focus_sequence;
        }
        let mut decision = self.observe(WindowsTabChromeRevealSignal::VisibilityRequested);
        decision.defer_focus = defer_focus;
        decision
    }

    fn finish_observation(&mut self, defer_focus: bool) -> WindowsTabChromeRevealDecision {
        let reveal = self.cloaked
            && self.visibility_requested
            && self.renderer_ready
            && self.projection_applied;
        if reveal {
            self.cloaked = false;
        }
        WindowsTabChromeRevealDecision {
            defer_focus,
            focus_sequence: reveal
                .then(|| self.pending_focus_sequence.take())
                .flatten(),
            reveal,
        }
    }

    fn restore_failed_reveal(&mut self, focus_sequence: Option<u64>) {
        self.cloaked = true;
        if focus_sequence.is_some() {
            self.pending_focus_sequence = focus_sequence;
        }
    }
}

#[cfg(any(windows, test))]
impl TabChromeProjectionCoordinator {
    fn register_renderer(
        &self,
        webview_label: &str,
        ready: &RuntimeTabChromeReadyRecord,
    ) -> Result<(), &'static str> {
        if ready.renderer_instance_id.is_empty()
            || ready.window_id.is_empty()
            || ready.window_generation == 0
        {
            return Err("TAB_CHROME_READY_INVALID");
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TAB_CHROME_PROJECTION_COORDINATOR_UNAVAILABLE")?;
        let replacement = state
            .renderers
            .get(&ready.window_id)
            .is_some_and(|current| {
                current.renderer_instance_id != ready.renderer_instance_id
                    || current.webview_label != webview_label
            });
        let last_intent_sequence = state
            .renderers
            .get(&ready.window_id)
            .filter(|current| {
                current.renderer_instance_id == ready.renderer_instance_id
                    && current.webview_label == webview_label
            })
            .map(|current| current.last_intent_sequence)
            .unwrap_or_default();
        state.renderers.insert(
            ready.window_id.clone(),
            TabChromeRendererIdentity {
                last_intent_sequence,
                lifecycle_epoch: ready.lifecycle_epoch,
                renderer_instance_id: ready.renderer_instance_id.clone(),
                webview_label: webview_label.to_owned(),
                window_generation: ready.window_generation,
                window_id: ready.window_id.clone(),
            },
        );
        if replacement {
            state.deliveries.remove(&ready.window_id);
            self.changed.notify_all();
        }
        Ok(())
    }

    fn admit_intent(
        &self,
        webview_label: &str,
        intent: &RuntimeTabIntentRecord,
    ) -> Result<RuntimeTabIntentAdmission, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TAB_CHROME_PROJECTION_COORDINATOR_UNAVAILABLE")?;
        let Some(renderer) = state
            .renderers
            .values_mut()
            .find(|renderer| renderer.webview_label == webview_label)
        else {
            return Ok(RuntimeTabIntentAdmission::Superseded {
                failure_code: "TAB_INTENT_ADAPTER_REPLACED",
                window_generation: 0,
                window_id: String::new(),
            });
        };
        let window_generation = renderer.window_generation;
        let window_id = renderer.window_id.clone();
        if intent.intent_kind != "stop"
            || intent.intent_id.is_empty()
            || intent.renderer_instance_id != renderer.renderer_instance_id
            || intent.adapter_sequence == 0
        {
            return Ok(RuntimeTabIntentAdmission::Superseded {
                failure_code: "TAB_INTENT_ADAPTER_STALE",
                window_generation,
                window_id,
            });
        }
        if intent.adapter_sequence <= renderer.last_intent_sequence {
            return Ok(RuntimeTabIntentAdmission::Superseded {
                failure_code: "TAB_INTENT_SEQUENCE_SUPERSEDED",
                window_generation,
                window_id,
            });
        }
        renderer.last_intent_sequence = intent.adapter_sequence;
        Ok(RuntimeTabIntentAdmission::Accepted {
            window_generation,
            window_id,
        })
    }

    fn renderer(&self, window_id: &str) -> Option<TabChromeRendererIdentity> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.renderers.get(window_id).cloned())
    }

    fn resolve_projection(
        &self,
        mut projection: RuntimeTabChromeProjectionRecord,
    ) -> Result<RuntimeTabChromeProjectionRecord, &'static str> {
        let mut semantic_projection = projection.clone();
        semantic_projection.renderer_instance_id = None;
        semantic_projection.projection_revision = 0;
        let fingerprint = serde_json::to_string(&semantic_projection)
            .map_err(|_| "TAB_CHROME_PROJECTION_SERIALIZE_FAILED")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TAB_CHROME_PROJECTION_COORDINATOR_UNAVAILABLE")?;
        let revision = state
            .semantic
            .get(&projection.window_id)
            .filter(|current| current.fingerprint == fingerprint)
            .map(|current| current.revision)
            .unwrap_or_else(|| {
                self.next_revision
                    .fetch_add(1, Ordering::AcqRel)
                    .saturating_add(1)
            });
        state.semantic.insert(
            projection.window_id.clone(),
            TabChromeSemanticProjection {
                fingerprint,
                revision,
            },
        );
        projection.projection_revision = revision;
        Ok(projection)
    }

    fn claim_delivery(&self, projection: &RuntimeTabChromeProjectionRecord) -> bool {
        let Some(renderer_instance_id) = projection.renderer_instance_id.as_deref() else {
            return false;
        };
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if !state
            .renderers
            .get(&projection.window_id)
            .is_some_and(|renderer| {
                renderer.renderer_instance_id == renderer_instance_id
                    && renderer.window_generation == projection.window_generation
                    && renderer.lifecycle_epoch == projection.lifecycle_epoch
            })
        {
            return false;
        }
        if state
            .deliveries
            .get(&projection.window_id)
            .is_some_and(|delivery| {
                delivery.renderer_instance_id == renderer_instance_id
                    && delivery.revision == projection.projection_revision
            })
        {
            return false;
        }
        state.deliveries.insert(
            projection.window_id.clone(),
            TabChromeProjectionDelivery {
                acknowledgement: None,
                active_tab_id: projection.active_tab_id.clone(),
                renderer_instance_id: renderer_instance_id.to_owned(),
                revision: projection.projection_revision,
                tab_order: projection.tab_order.clone(),
                terminal_status: None,
                topology_revision: projection.topology_revision,
            },
        );
        self.changed.notify_all();
        true
    }

    fn acknowledge(
        &self,
        webview_label: &str,
        acknowledgement: RuntimeTabChromeAcknowledgementRecord,
    ) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "TAB_CHROME_PROJECTION_COORDINATOR_UNAVAILABLE")?;
        let renderer = state
            .renderers
            .values()
            .find(|renderer| renderer.webview_label == webview_label)
            .cloned()
            .ok_or("TAB_CHROME_RENDERER_NOT_FOUND")?;
        if renderer.renderer_instance_id != acknowledgement.renderer_instance_id {
            return Err("TAB_CHROME_RENDERER_INSTANCE_STALE");
        }
        let delivery = state
            .deliveries
            .get_mut(&renderer.window_id)
            .ok_or("TAB_CHROME_PROJECTION_NOT_PENDING")?;
        if delivery.renderer_instance_id != acknowledgement.renderer_instance_id
            || delivery.revision != acknowledgement.projection_revision
            || delivery.topology_revision != acknowledgement.topology_revision
        {
            return Err("TAB_CHROME_PROJECTION_STALE");
        }
        if !matches!(acknowledgement.status.as_str(), "applied" | "superseded" | "failed") {
            return Err("TAB_CHROME_PROJECTION_STATUS_INVALID");
        }
        if acknowledgement.status == "applied"
            && (delivery.tab_order != acknowledgement.observed_tab_order
                || delivery.active_tab_id != acknowledgement.observed_active_tab_id)
        {
            return Err("TAB_CHROME_PROJECTION_READBACK_MISMATCH");
        }
        if delivery.acknowledgement.is_none() {
            delivery.acknowledgement = Some(acknowledgement);
            self.changed.notify_all();
        }
        Ok(())
    }

    fn wait(
        &self,
        window_id: &str,
        renderer_instance_id: &str,
        revision: u64,
        timeout: Duration,
    ) -> TabChromeProjectionWaitOutcome {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.state.lock() else {
            return TabChromeProjectionWaitOutcome::Failed;
        };
        loop {
            if !state.renderers.get(window_id).is_some_and(|renderer| {
                renderer.renderer_instance_id == renderer_instance_id
            }) {
                return TabChromeProjectionWaitOutcome::Superseded;
            }
            let Some(delivery) = state.deliveries.get(window_id) else {
                return TabChromeProjectionWaitOutcome::Superseded;
            };
            if delivery.renderer_instance_id != renderer_instance_id
                || delivery.revision != revision
            {
                return TabChromeProjectionWaitOutcome::Superseded;
            }
            if let Some(acknowledgement) = delivery.acknowledgement.as_ref() {
                return match acknowledgement.status.as_str() {
                    "applied" => TabChromeProjectionWaitOutcome::Applied,
                    "superseded" => TabChromeProjectionWaitOutcome::Superseded,
                    _ => TabChromeProjectionWaitOutcome::Failed,
                };
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return TabChromeProjectionWaitOutcome::Timeout;
            }
            let Ok((next, wait)) = self.changed.wait_timeout(state, remaining) else {
                return TabChromeProjectionWaitOutcome::Failed;
            };
            state = next;
            if wait.timed_out() {
                return TabChromeProjectionWaitOutcome::Timeout;
            }
        }
    }

    fn finish(
        &self,
        window_id: &str,
        renderer_instance_id: &str,
        revision: u64,
        status: NativeOperationStatus,
    ) {
        if let Ok(mut state) = self.state.lock()
            && let Some(delivery) = state.deliveries.get_mut(window_id)
            && delivery.renderer_instance_id == renderer_instance_id
            && delivery.revision == revision
            && delivery.terminal_status.is_none()
        {
            delivery.terminal_status = Some(status);
            self.changed.notify_all();
        }
    }

    #[cfg(test)]
    fn last_status(&self, window_id: &str, revision: u64) -> Option<NativeOperationStatus> {
        self.state.lock().ok().and_then(|state| {
            state.deliveries.get(window_id).and_then(|delivery| {
                (delivery.revision == revision)
                    .then_some(delivery.terminal_status)
                    .flatten()
            })
        })
    }

    #[cfg(test)]
    fn wait_for_projection_status(
        &self,
        window_id: &str,
        expected_tab_order: &[String],
        expected_active_tab_id: Option<&str>,
        timeout: Duration,
    ) -> Option<NativeOperationStatus> {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        loop {
            if let Some(delivery) = state.deliveries.get(window_id)
                && delivery.tab_order == expected_tab_order
                && delivery.active_tab_id.as_deref() == expected_active_tab_id
                && let Some(status) = delivery.terminal_status
            {
                return Some(status);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let Ok((next, wait)) = self.changed.wait_timeout(state, remaining) else {
                return None;
            };
            state = next;
            if wait.timed_out() {
                return None;
            }
        }
    }
}

#[cfg(windows)]
impl SystemRuntimeExecutor {
    fn observe_windows_tab_chrome_reveal(
        &self,
        window_id: &str,
        window_generation: u64,
        signal: WindowsTabChromeRevealSignal,
    ) {
        let decision = self.state.lock().ok().and_then(|mut state| {
            let host = state.native_resources.display_hosts.get_mut(window_id)?;
            if host.generation != window_generation {
                return None;
            }
            Some(host.tab_chrome_reveal.observe(signal))
        });
        self.tab_chrome_changed.notify_all();
        if let Some(decision) = decision {
            self.apply_windows_tab_chrome_reveal_decision(
                window_id,
                window_generation,
                decision,
            );
        }
    }

    fn prepare_windows_tab_chrome_presentation(
        &self,
        window_id: &str,
        window_generation: u64,
        focus_lease: Option<&NativeFocusLease>,
    ) -> bool {
        let decision = self.state.lock().ok().and_then(|mut state| {
            let host = state.native_resources.display_hosts.get_mut(window_id)?;
            if host.generation != window_generation {
                return None;
            }
            Some(
                host.tab_chrome_reveal
                    .request_presentation(focus_lease.map(|lease| lease.sequence)),
            )
        });
        let Some(decision) = decision else {
            return false;
        };
        self.apply_windows_tab_chrome_reveal_decision(
            window_id,
            window_generation,
            decision,
        );
        decision.defer_focus
    }

    fn wait_for_windows_tab_chrome_content(
        &self,
        window_id: &str,
        window_generation: u64,
    ) -> RuntimeResult<()> {
        let deadline = Instant::now() + WINDOWS_TAB_CHROME_ACK_TIMEOUT;
        let mut state = self.state()?;
        loop {
            let host = state.native_resources.display_hosts.get(window_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                    "The runtime host retired before its tab chrome became ready.",
                )
            })?;
            if host.generation != window_generation {
                return Err(RuntimeError::new(
                    "SYSTEM_RUNTIME_PRESENTATION_SUPERSEDED",
                    "A newer runtime host generation replaced the tab chrome bootstrap.",
                ));
            }
            if host.tab_chrome_reveal.projection_applied {
                return Ok(());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(RuntimeError::new(
                    "WINDOWS_TAB_CHROME_BOOTSTRAP_TIMEOUT",
                    "The Windows tab chrome did not become ready before role WebView creation.",
                ));
            }
            let (next, timeout) = self
                .tab_chrome_changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .map_err(|_| {
                    RuntimeError::new(
                        "SYSTEM_RUNTIME_PRESENTATION_UNAVAILABLE",
                        "The Windows tab chrome readiness coordinator is unavailable.",
                    )
                })?;
            state = next;
            if timeout.timed_out()
                && !state.native_resources.display_hosts.get(window_id).is_some_and(|host| {
                    host.generation == window_generation
                        && host.tab_chrome_reveal.projection_applied
                })
            {
                return Err(RuntimeError::new(
                    "WINDOWS_TAB_CHROME_BOOTSTRAP_TIMEOUT",
                    "The Windows tab chrome did not become ready before role WebView creation.",
                ));
            }
        }
    }

    fn apply_windows_tab_chrome_reveal_decision(
        &self,
        window_id: &str,
        window_generation: u64,
        decision: WindowsTabChromeRevealDecision,
    ) {
        if !decision.reveal {
            return;
        }
        let window = self.state.lock().ok().and_then(|state| {
            state
                .native_resources.display_hosts
                .get(window_id)
                .filter(|host| host.generation == window_generation)
                .map(|host| host.window.clone())
        });
        let Some(window) = window else {
            return;
        };
        let Some(runtime) = self.self_weak.get().cloned() else {
            self.restore_windows_tab_chrome_reveal(
                window_id,
                window_generation,
                decision.focus_sequence,
            );
            return;
        };
        let reveal_window = window.clone();
        let reveal_window_id = window_id.to_owned();
        let scheduling = window.run_on_main_thread(move || {
            let Some(runtime) = runtime.upgrade() else {
                return;
            };
            if let Err(error) = runtime.reveal_windows_runtime_window_with_focus(
                &reveal_window_id,
                window_generation,
                decision.focus_sequence,
                &reveal_window,
            ) {
                runtime.restore_windows_tab_chrome_reveal(
                    &reveal_window_id,
                    window_generation,
                    decision.focus_sequence,
                );
                eprintln!(
                    "Windows runtime window could not be revealed after tab chrome paint: {error:?}"
                );
                return;
            }
            // The initialization show happens while DWM-cloaked. Register the host only after
            // reveal so Windows contributes it to the application's grouped taskbar previews.
            if let Err(error) = register_windows_runtime_window_with_taskbar(&reveal_window) {
                runtime.restore_windows_tab_chrome_reveal(
                    &reveal_window_id,
                    window_generation,
                    decision.focus_sequence,
                );
                eprintln!(
                    "Windows runtime window could not be registered with the taskbar after tab chrome paint: {error:?}"
                );
            }
        });
        if let Err(error) = scheduling {
            self.restore_windows_tab_chrome_reveal(
                window_id,
                window_generation,
                decision.focus_sequence,
            );
            eprintln!("Windows runtime window reveal could not reach the UI thread: {error}");
        }
    }

    fn retire_failed_windows_tab_chrome_host(
        &self,
        window_id: &str,
        window_generation: u64,
    ) {
        let host = self.state.lock().ok().and_then(|mut state| {
            let has_attached_content = state.window_has_attached_tab_handles(window_id);
            if has_attached_content
                || !state.native_resources.display_hosts.get(window_id).is_some_and(|host| {
                    host.generation == window_generation && host.tab_chrome_reveal.cloaked
                })
            {
                return None;
            }
            let host = state.native_resources.display_hosts.remove(window_id)?;
            state
                .allow_window_close_labels
                .insert(host.window.label().to_owned());
            Some(host)
        });
        let Some(host) = host else {
            return;
        };
        self.presentation.remove(window_id);
        self.focus_broker
            .revoke_window(window_id, window_generation);
        self.cancel_pending_window_activation(window_id);
        self.unregister_runtime_launcher_window(window_id);
        let _ = request_platform_window_hide(&host.window);
        let _ = host.window.close();
        self.publish_launcher_presence();
    }

    fn restore_windows_tab_chrome_reveal(
        &self,
        window_id: &str,
        window_generation: u64,
        focus_sequence: Option<u64>,
    ) {
        if let Ok(mut state) = self.state.lock()
            && let Some(host) = state.native_resources.display_hosts.get_mut(window_id)
            && host.generation == window_generation
        {
            host.tab_chrome_reveal
                .restore_failed_reveal(focus_sequence);
        }
    }

    fn reveal_windows_runtime_window_with_focus(
        &self,
        window_id: &str,
        window_generation: u64,
        focus_sequence: Option<u64>,
        window: &Window,
    ) -> RuntimeResult<()> {
        let lease = focus_sequence.and_then(|sequence| {
            self.focus_broker
                .current_lease_for(sequence, window_id, window_generation)
        });
        let focus_guard = lease.as_ref().and_then(|lease| {
            match self.focus_broker.begin_mutation(lease) {
                Ok(guard) => guard,
                Err(error) => {
                    eprintln!("Windows runtime reveal focus broker failed: {error}");
                    None
                }
            }
        });
        let prepare_focus = lease.as_ref().is_some_and(|lease| {
            focus_guard.is_some() && self.focus_broker.is_current(lease)
        });
        if prepare_focus
            && let Err(error) = prepare_platform_window_foreground(window)
        {
            eprintln!(
                "Windows runtime window could not prepare its foreground Z-order before reveal: {}",
                error.message
            );
        }

        set_windows_runtime_window_cloaked(window, false)?;

        let submit_focus = lease.as_ref().is_some_and(|lease| {
            focus_guard.is_some()
                && self.focus_broker.is_current(lease)
                && self.focus_broker.mark_submitted(lease)
        });
        if submit_focus {
            if let Err(error) = request_platform_window_show_foreground(window) {
                eprintln!(
                    "Windows runtime window could not enter the foreground during reveal: {}",
                    error.message
                );
            } else if platform_window_is_focused(window).unwrap_or(false)
                && let Some(lease) = lease.as_ref()
            {
                let _ = self.focus_broker.confirm(lease);
            }
        }
        Ok(())
    }

    fn display_records_for_tab_chrome(&self) -> Vec<DisplayInfoRecord> {
        self.app
            .try_state::<crate::CoreState>()
            .and_then(|state| state.display_topology.inner.projection.current())
            .and_then(|projection| {
                serde_json::from_value::<Vec<DisplayInfoRecord>>(projection["displays"].clone())
                    .ok()
            })
            .unwrap_or_default()
    }

    fn build_tab_chrome_projection(
        &self,
        snapshot: &BrowserRuntimeSnapshot,
        renderer: &TabChromeRendererIdentity,
    ) -> RuntimeResult<RuntimeTabChromeProjectionRecord> {
        let metadata = self.projection_metadata();
        let preferences = metadata.window_preferences;
        let roles = metadata.roles;
        let games = metadata.games;
        let role_names = roles
            .iter()
            .map(|role| (role.id.as_str(), role.name.as_str()))
            .collect::<HashMap<_, _>>();
        let role_icons = roles
            .iter()
            .filter_map(|role| {
                games
                    .iter()
                    .find(|game| game.id == role.game_id)
                    .and_then(|game| game.icon_image_data_url.clone())
                    .map(|icon| (role.id.as_str(), icon))
            })
            .collect::<HashMap<_, _>>();
        let presentation = self
            .presentation
            .existing(&renderer.window_id)
            .map(|state| state.record)
            .ok_or_else(|| {
                RuntimeError::new(
                    "TAB_CHROME_PRESENTATION_NOT_FOUND",
                    "The authoritative tab presentation was not found.",
                )
            })?;
        if renderer.lifecycle_epoch != self.lifecycle_epoch() {
            return Err(RuntimeError::new(
                "TAB_CHROME_RENDERER_INSTANCE_STALE",
                "The runtime tab-strip renderer belongs to an obsolete window generation.",
            ));
        }
        let phases = presentation
            .tabs
            .iter()
            .map(|presented| {
                (
                    presented.id.clone(),
                    self.presentation
                        .statuses
                        .presentation_phase(&presented.id),
                )
            })
            .collect::<HashMap<_, _>>();
        let persisted_window_name = presentation
            .persisted_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| RION_STUDIO_APP_NAME.to_owned());
        // The tab-chrome renderer can report ready while WebView2 is still completing a child
        // controller attachment. Keep this critical section to pure Rust snapshots: Tauri window
        // getters synchronously rendezvous with the platform UI thread and must never run while
        // the runtime-state mutex is held.
        let (items, display_id, toolbar_revealed, window_name, fullscreen, window_maximized) =
            query_tab_chrome_window_state_unlocked(
                &self.state,
                |state| {
                    let host = state.native_resources.display_hosts.get(&renderer.window_id).ok_or_else(|| {
                        RuntimeError::new(
                            "TAB_CHROME_WINDOW_NOT_FOUND",
                            "The runtime tab-strip window was not found.",
                        )
                    })?;
                    if host.generation != renderer.window_generation {
                        return Err(RuntimeError::new(
                            "TAB_CHROME_RENDERER_INSTANCE_STALE",
                            "The runtime tab-strip renderer belongs to an obsolete window generation.",
                        ));
                    }
                    let items = presentation
                        .tabs
                        .iter()
                        .filter_map(|presented| {
                            let core_tab = snapshot.tabs.iter().find(|tab| tab.id == presented.id);
                            if presentation.hidden_tab_ids.contains(&presented.id)
                                || state.tab_close_pending(&presented.id)
                            {
                                return None;
                            }
                            let live = state.native_resources.tabs.get(&presented.id);
                            let role_ids = core_tab
                                .map(|tab| {
                                    tab.slots
                                        .iter()
                                        .map(|slot| slot.role_id.clone())
                                        .collect()
                                })
                                .unwrap_or_else(|| presented.role_ids.clone());
                            let icon_data_url = presented.icon_data_url.clone().or_else(|| {
                                role_ids
                                    .first()
                                    .and_then(|role_id| role_icons.get(role_id.as_str()))
                                    .cloned()
                            });
                            let phase = phases
                                .get(&presented.id)
                                .copied()
                                .unwrap_or(TabRuntimePhase::Failed);
                            Some(RuntimeTabChromeItemRecord {
                                id: presented.id.clone(),
                                name: presented.title.clone(),
                                tab_type: presented.tab_type.clone(),
                                hidden: false,
                                audible: live
                                    .is_some_and(|tab| runtime_tab_is_audible(state, tab)),
                                muted: presented.audio_muted,
                                loading: matches!(
                                    phase,
                                    TabRuntimePhase::Reserved
                                        | TabRuntimePhase::Attaching
                                        | TabRuntimePhase::Loading
                                ),
                                degraded: phase == TabRuntimePhase::Degraded,
                                closable: presented.closable,
                                source_id: presented.source_id.clone(),
                                phase: phase.as_str().to_owned(),
                                role_names: role_ids
                                    .iter()
                                    .filter_map(|role_id| {
                                        role_names.get(role_id.as_str()).copied()
                                    })
                                    .map(str::to_owned)
                                    .collect(),
                                role_ids,
                                icon_data_url,
                                workspace_template: presented.workspace_template.clone(),
                            })
                        })
                        .collect::<Vec<_>>();
                    Ok((
                        items,
                        host.window.clone(),
                        host.target.display_id.max(0) as u64,
                        host.toolbar_revealed,
                        persisted_window_name.clone(),
                    ))
                },
                |(items, window, display_id, toolbar_revealed, window_name)| {
                    let fullscreen = window.is_fullscreen().unwrap_or(false);
                    let window_maximized = window.is_maximized().unwrap_or(false);
                    Ok((
                        items,
                        display_id,
                        toolbar_revealed,
                        window_name,
                        fullscreen,
                        window_maximized,
                    ))
                },
            )?;
        let tab_order = items.iter().map(|tab| tab.id.clone()).collect::<Vec<_>>();
        let active_tab_id = presentation
            .selected_tab_id
            .filter(|tab_id| tab_order.contains(tab_id));
        let toolbar_visible = !fullscreen
            || preferences.always_show_toolbar_in_full_screen
            || toolbar_revealed;
        let language = self
            .language
            .lock()
            .map(|language| language.clone())
            .unwrap_or_else(|_| "en".to_owned());
        let theme = self
            .resolved_theme
            .lock()
            .map(|theme| theme.clone())
            .unwrap_or_else(|_| "light".to_owned());
        Ok(RuntimeTabChromeProjectionRecord {
            renderer_instance_id: Some(renderer.renderer_instance_id.clone()),
            window_id: renderer.window_id.clone(),
            window_generation: renderer.window_generation,
            lifecycle_epoch: renderer.lifecycle_epoch,
            projection_revision: 0,
            topology_revision: self.presentation.current_revision(),
            tabs: items,
            tab_order,
            active_tab_id,
            display_id,
            displays: self.display_records_for_tab_chrome(),
            window_name,
            window_maximized,
            fullscreen,
            window_fullscreen: fullscreen,
            toolbar_visible,
            always_hide_tab_close_button: preferences.always_hide_tab_close_button,
            always_show_toolbar_in_full_screen: preferences.always_show_toolbar_in_full_screen,
            language,
            theme,
        })
    }

    fn eval_windows_tab_chrome_projection(
        tab_strip: &Webview,
        projection: &RuntimeTabChromeProjectionRecord,
    ) -> RuntimeResult<()> {
        let payload = serde_json::to_string(projection).map_err(RuntimeError::tauri)?;
        tab_strip
            .eval(format!(
                "globalThis.__rionApplyRuntimeTabChromeProjection?.({payload});"
            ))
            .map_err(RuntimeError::tauri)
    }

    fn dispatch_windows_tab_chrome_projection(
        &self,
        tab_strip: Webview,
        projection: RuntimeTabChromeProjectionRecord,
    ) {
        if !self.tab_chrome_projections.claim_delivery(&projection) {
            return;
        }
        let Some(renderer_instance_id) = projection.renderer_instance_id.clone() else {
            return;
        };
        let operation = NativeOperationContext::new_for_platform(
            NativeOperationSubsystem::Projection,
            "tabChromeProjection",
            Duration::from_secs(5),
            "windows",
        )
        .with_revision(projection.projection_revision)
        .with_window(&projection.window_id)
        .with_window_generation(projection.window_generation)
        .with_lifecycle_epoch(projection.lifecycle_epoch);
        if self.operations.register(operation.clone()).is_err() {
            self.tab_chrome_projections.finish(
                &projection.window_id,
                &renderer_instance_id,
                projection.projection_revision,
                NativeOperationStatus::Failed,
            );
            return;
        }
        self.operations.mark_in_flight(&operation.operation_id);
        if Self::eval_windows_tab_chrome_projection(&tab_strip, &projection).is_err() {
            self.tab_chrome_projections.finish(
                &projection.window_id,
                &renderer_instance_id,
                projection.projection_revision,
                NativeOperationStatus::Failed,
            );
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "tabChromeProjectionDispatchFailed",
                NativeOperationStatus::Failed,
                Some("TAB_CHROME_PROJECTION_DISPATCH_FAILED"),
            ));
            self.retire_failed_windows_tab_chrome_host(
                &projection.window_id,
                projection.window_generation,
            );
            return;
        }
        let coordinator = Arc::clone(&self.tab_chrome_projections);
        let operations = Arc::clone(&self.operations);
        let worker_operation = operation.clone();
        let worker_projection = projection.clone();
        let worker_renderer_instance_id = renderer_instance_id.clone();
        let runtime = self.self_weak.get().cloned();
        let worker = thread::Builder::new()
            .name(format!(
                "rion-tab-chrome-projection-{}",
                projection.projection_revision
            ))
            .spawn(move || {
                let outcome = coordinator.wait(
                    &worker_projection.window_id,
                    &worker_renderer_instance_id,
                    worker_projection.projection_revision,
                    WINDOWS_TAB_CHROME_ACK_TIMEOUT,
                );
                let (status, stage, failure_code) = match outcome {
                    TabChromeProjectionWaitOutcome::Applied => {
                        (NativeOperationStatus::Applied, "tabChromeProjectionConverged", None)
                    }
                    TabChromeProjectionWaitOutcome::Superseded => (
                        NativeOperationStatus::Superseded,
                        "tabChromeProjectionSuperseded",
                        None,
                    ),
                    TabChromeProjectionWaitOutcome::Failed => (
                        NativeOperationStatus::Failed,
                        "tabChromeProjectionRejected",
                        Some("TAB_CHROME_PROJECTION_REJECTED"),
                    ),
                    TabChromeProjectionWaitOutcome::Timeout => (
                        NativeOperationStatus::Failed,
                        "tabChromeProjectionTimeout",
                        Some("TAB_CHROME_PROJECTION_TIMEOUT"),
                    ),
                };
                if matches!(outcome, TabChromeProjectionWaitOutcome::Applied)
                    && !worker_projection.tab_order.is_empty()
                    && let Some(runtime) = runtime.as_ref().and_then(|runtime| runtime.upgrade())
                {
                    runtime.observe_windows_tab_chrome_reveal(
                        &worker_projection.window_id,
                        worker_projection.window_generation,
                        WindowsTabChromeRevealSignal::ProjectionApplied,
                    );
                }
                if matches!(
                    outcome,
                    TabChromeProjectionWaitOutcome::Failed
                        | TabChromeProjectionWaitOutcome::Timeout
                ) && let Some(runtime) = runtime.as_ref().and_then(|runtime| runtime.upgrade())
                {
                    runtime.retire_failed_windows_tab_chrome_host(
                        &worker_projection.window_id,
                        worker_projection.window_generation,
                    );
                }
                coordinator.finish(
                    &worker_projection.window_id,
                    &worker_renderer_instance_id,
                    worker_projection.projection_revision,
                    status,
                );
                operations.complete(NativeOperationReceipt::with_status(
                    worker_operation,
                    stage,
                    status,
                    failure_code,
                ));
            });
        if worker.is_err() {
            self.tab_chrome_projections.finish(
                &projection.window_id,
                &renderer_instance_id,
                projection.projection_revision,
                NativeOperationStatus::Indeterminate,
            );
            self.operations.complete(NativeOperationReceipt::with_status(
                operation,
                "tabChromeProjectionWorkerFailed",
                NativeOperationStatus::Indeterminate,
                Some("TAB_MUTATION_RESULT_UNKNOWN"),
            ));
        }
    }

    fn sync_windows_tab_chrome_projections(&self, snapshot: &BrowserRuntimeSnapshot) {
        let targets = self
            .state
            .lock()
            .ok()
            .map(|state| {
                state
                    .native_resources.display_hosts
                    .iter()
                    .map(|(window_id, host)| (window_id.clone(), host.tab_strip.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (window_id, tab_strip) in targets {
            let Some(renderer) = self.tab_chrome_projections.renderer(&window_id) else {
                continue;
            };
            let Ok(projection) = self.build_tab_chrome_projection(snapshot, &renderer) else {
                continue;
            };
            let Ok(projection) = self.tab_chrome_projections.resolve_projection(projection) else {
                continue;
            };
            self.dispatch_windows_tab_chrome_projection(tab_strip, projection);
        }
    }

    pub(crate) fn register_tab_chrome_renderer(
        &self,
        webview_label: &str,
        ready: RuntimeTabChromeReadyRecord,
    ) -> Result<(), String> {
        let (window_id, window_generation) = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state.native_resources.display_hosts.iter().find_map(|(window_id, host)| {
                    (host.tab_strip.label() == webview_label)
                        .then(|| (window_id.clone(), host.generation))
                })
            })
            .ok_or_else(|| "The runtime tab-strip renderer is unauthorized.".to_owned())?;
        if ready.window_id != window_id
            || ready.window_generation != window_generation
            || ready.lifecycle_epoch != self.lifecycle_epoch()
        {
            return Err("The runtime tab-strip renderer identity is stale.".to_owned());
        }
        self.tab_chrome_projections
            .register_renderer(webview_label, &ready)
            .map_err(str::to_owned)?;
        self.observe_windows_tab_chrome_reveal(
            &window_id,
            window_generation,
            WindowsTabChromeRevealSignal::RendererReady,
        );
        self.publish_projection();
        Ok(())
    }

    pub(crate) fn acknowledge_tab_chrome_projection(
        &self,
        webview_label: &str,
        acknowledgement: RuntimeTabChromeAcknowledgementRecord,
    ) -> Result<(), String> {
        self.tab_chrome_projections
            .acknowledge(webview_label, acknowledgement)
            .map_err(str::to_owned)
    }

    pub(crate) fn admit_runtime_tab_intent(
        &self,
        webview_label: &str,
        intent: &RuntimeTabIntentRecord,
    ) -> Result<RuntimeTabIntentAdmission, String> {
        let admission = self
            .tab_chrome_projections
            .admit_intent(webview_label, intent)
            .map_err(str::to_owned)?;
        let (window_id, window_generation) = match &admission {
            RuntimeTabIntentAdmission::Accepted {
                window_generation,
                window_id,
            }
            | RuntimeTabIntentAdmission::Superseded {
                window_generation,
                window_id,
                ..
            } => (window_id.clone(), *window_generation),
        };
        let source_is_current = self.state.lock().ok().is_some_and(|state| {
            state.native_resources.display_hosts.get(&window_id).is_some_and(|host| {
                tab_intent_source_identity_is_current(
                    host.generation,
                    host.tab_strip.label(),
                    window_generation,
                    webview_label,
                )
            })
        });
        let tab_belongs_to_source = self
            .live_tab_window_id(&intent.tab_id)
            .as_deref()
            == Some(window_id.as_str());
        let admission = if matches!(admission, RuntimeTabIntentAdmission::Accepted { .. })
            && (!source_is_current || !tab_belongs_to_source)
        {
            RuntimeTabIntentAdmission::Superseded {
                failure_code: if source_is_current {
                    "TAB_INTENT_TAB_OWNER_STALE"
                } else {
                    "TAB_INTENT_WINDOW_GENERATION_STALE"
                },
                window_generation,
                window_id: window_id.clone(),
            }
        } else {
            admission
        };
        let (level, event, message, trigger) = match &admission {
            RuntimeTabIntentAdmission::Accepted { .. } => (
                LogLevel::Debug,
                "tab.intent-admitted",
                "The runtime tab intent passed adapter, generation, and ownership fences.",
                "typed-tab-intent",
            ),
            RuntimeTabIntentAdmission::Superseded { failure_code, .. } => (
                LogLevel::Warn,
                "tab.intent-superseded",
                "The runtime tab intent was rejected before the live topology commit.",
                *failure_code,
            ),
        };
        self.record_presentation_event(
            level,
            event,
            message,
            &window_id,
            Some(&intent.tab_id),
            self.live_topology_revision(),
            trigger,
            0,
        );
        Ok(admission)
    }
}
