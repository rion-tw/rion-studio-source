#[derive(Clone, Copy, Debug)]
pub(crate) struct RuntimeWindowResizeSnapshot {
    content_metrics: WindowContentMetrics,
    fullscreen: bool,
    maximized: bool,
    minimized: bool,
    physical_height: u32,
    physical_width: u32,
    received_at: Instant,
    scale_factor: f64,
    sequence: u64,
    #[cfg(windows)]
    native_fast_path: WindowsLiveResizeObservation,
}

#[derive(Clone, Debug)]
struct PendingWindowResize {
    coalesced_count: u64,
    #[cfg(windows)]
    native_fast_path_counters: WindowsLiveResizeCounters,
    received_count: u64,
    snapshot: RuntimeWindowResizeSnapshot,
}

impl SystemRuntimeExecutor {
    /// Called directly from Tauri's window event callback. All Tauri window
    /// getters intentionally run here on the UI thread; the resize worker only
    /// consumes this value snapshot and never synchronously queries the window.
    pub fn observe_resize_window(
        self: &Arc<Self>,
        label: &str,
        physical_width: u32,
        physical_height: u32,
        event_scale_factor: Option<f64>,
    ) {
        if label == "main" || self.require_runtime_accepting().is_err() {
            return;
        }
        let Some(window) = self.state.lock().ok().and_then(|state| {
            state
                .display_hosts
                .values()
                .find(|host| host.window.label() == label)
                .map(|host| host.window.clone())
        }) else {
            return;
        };
        let scale_factor = event_scale_factor
            .or_else(|| window.scale_factor().ok())
            .map(normalized_scale_factor)
            .unwrap_or(1.0);
        #[cfg(windows)]
        let live_resize = windows_live_resize_observe(
            &window,
            physical_width,
            physical_height,
        );
        #[cfg(windows)]
        let (physical_width, physical_height) = if live_resize.client_width > 0
            && live_resize.client_height > 0
        {
            (live_resize.client_width, live_resize.client_height)
        } else {
            (physical_width, physical_height)
        };
        let Some(content_metrics) = snapshot_window_content_metrics(
            &window,
            physical_width,
            physical_height,
            scale_factor,
        ) else {
            return;
        };
        let snapshot = RuntimeWindowResizeSnapshot {
            content_metrics,
            fullscreen: window.is_fullscreen().unwrap_or(false),
            maximized: window.is_maximized().unwrap_or(false),
            minimized: window.is_minimized().unwrap_or(false),
            physical_height,
            physical_width,
            received_at: Instant::now(),
            scale_factor,
            sequence: WINDOW_RESIZE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            #[cfg(windows)]
            native_fast_path: live_resize,
        };
        #[cfg(target_os = "macos")]
        self.prepare_runtime_window_fullscreen(label, snapshot.fullscreen);
        self.schedule_resize_window(label.to_owned(), snapshot);
    }

    pub fn resize_window(
        &self,
        label: &str,
        snapshot: RuntimeWindowResizeSnapshot,
        settled: bool,
    ) -> bool {
        if self.require_runtime_accepting().is_err()
            || !runtime_window_resize_is_actionable(
                snapshot.physical_width,
                snapshot.physical_height,
                snapshot.minimized,
            )
        {
            return false;
        }
        let Some((window_id, toolbar_revealed)) = self.state.lock().ok().and_then(|state| {
            state.display_hosts.iter().find_map(|(window_id, host)| {
                (host.window.label() == label)
                    .then(|| (window_id.clone(), resize_toolbar_revealed(host)))
            })
        }) else {
            return false;
        };
        let presentation = if snapshot.fullscreen {
            "fullscreen"
        } else if snapshot.maximized {
            "maximized"
        } else {
            "normal"
        };
        let width = (snapshot.physical_width as f64 / snapshot.scale_factor).max(1.0);
        let height = (snapshot.physical_height as f64 / snapshot.scale_factor).max(1.0);
        let live_target = self.state.lock().ok().and_then(|mut state| {
            let host = state.display_hosts.get_mut(&window_id)?;
            host.target.presentation = presentation.to_owned();
            if !snapshot.maximized && !snapshot.fullscreen && !snapshot.minimized {
                host.target.bounds.width = width.round() as i32;
                host.target.bounds.height = height.round() as i32;
            }
            Some(host.target.clone())
        });
        if settled
            && let Some(target) = live_target
            && let Err(error) = self.update_live_window_target(&target, true)
        {
            eprintln!("Live Game Window resize commit failed: window={window_id} error={error}");
        }
        #[cfg(windows)]
        let metrics = resize_metrics_with_tab_strip(
            snapshot.content_metrics,
            self.windows_tab_strip_height_for_state(snapshot.fullscreen, toolbar_revealed),
        );
        #[cfg(not(windows))]
        let metrics = snapshot.content_metrics;
        #[cfg(not(windows))]
        let _ = toolbar_revealed;
        let selected_tab_id = self
            .presentation
            .existing(&window_id)
            .and_then(|presentation| {
                presentation
                    .lock()
                    .ok()
                    .and_then(|live| live.selected_tab_id.clone())
            });
        let hydrated_tab_ids = self
            .state
            .lock()
            .map(|state| {
                state
                    .tabs
                    .keys()
                    .filter(|tab_id| {
                        !state.optimistic_closed_tabs.contains(*tab_id)
                            && !state.close_coordinator.closing_tabs.contains(*tab_id)
                    })
                    .cloned()
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        let tab_ids = resize_projection_tab_ids(
            selected_tab_id,
            settled.then(|| self.live_tab_ids_for_window(&window_id)),
            &hydrated_tab_ids,
        );
        let mut layout_errors = Vec::new();
        for tab_id in tab_ids {
            #[cfg(windows)]
            let skip_active_bounds = snapshot.native_fast_path.native_fast_path_available && !settled;
            #[cfg(not(windows))]
            let skip_active_bounds = false;
            if let Err(error) = self.layout_runtime_tab_with_metrics(
                &tab_id,
                metrics,
                skip_active_bounds,
                settled,
            )
            {
                layout_errors.push(format!("{tab_id}: {}: {}", error.code, error.message));
            }
        }
        if !layout_errors.is_empty() {
            self.emit_runtime_shell_error(
                "TAURI_RUNTIME_WINDOW_LAYOUT_FAILED",
                layout_errors.join("; "),
                label,
            );
        }
        if settled {
            self.publish_projection();
        }
        true
    }

    pub fn schedule_resize_window(
        self: &Arc<Self>,
        label: String,
        snapshot: RuntimeWindowResizeSnapshot,
    ) {
        let should_spawn = self.state.lock().ok().is_some_and(|mut state| {
            let previous = state.pending_window_resizes.remove(&label);
            state.pending_window_resizes.insert(
                label.clone(),
                coalesce_pending_resize(previous, snapshot),
            );
            state.active_window_resize_workers.insert(label.clone())
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::clone(self);
        let worker_label = label.clone();
        self.record_resize_worker_event(&label, "started", 0, 0, 0, Duration::ZERO);
        eprintln!("Runtime resize worker started: window={worker_label}");
        if thread::Builder::new()
            .name("rion-runtime-window-resize".to_owned())
            .spawn(move || runtime.run_resize_worker(worker_label))
            .is_err()
        {
            self.clear_resize_worker(&label, None);
            self.record_resize_worker_event(
                &label,
                "spawn-failed",
                0,
                0,
                0,
                Duration::ZERO,
            );
        }
    }

    fn run_resize_worker(self: &Arc<Self>, label: String) {
        let started = Instant::now();
        let mut applied_count = 0_u64;
        let mut last_applied_sequence = 0_u64;
        let mut native_blocked_since = None;
        loop {
            let shutdown_state = RuntimeShutdownState::from_raw(
                self.shutdown_state.load(Ordering::Acquire),
            );
            if shutdown_state != RuntimeShutdownState::Accepting {
                self.clear_resize_worker(&label, None);
                break;
            }
            let Some(pending) = self
                .state
                .lock()
                .ok()
                .and_then(|state| state.pending_window_resizes.get(&label).cloned())
            else {
                self.clear_resize_worker(&label, None);
                break;
            };
            let settled = resize_snapshot_is_settled(pending.snapshot.received_at.elapsed());
            let requires_projection = pending.snapshot.sequence != last_applied_sequence || settled;
            if requires_projection && self.resize_window_projection_is_busy(&label) {
                let blocked_for = native_blocked_since
                    .get_or_insert_with(Instant::now)
                    .elapsed();
                if native_resize_should_retry(true, shutdown_state, blocked_for) {
                    thread::sleep(WINDOW_RESIZE_FRAME_INTERVAL);
                    continue;
                }
                self.emit_runtime_shell_error(
                    "TAURI_RUNTIME_WINDOW_RESIZE_TIMEOUT",
                    "Game Window resize could not enter the native geometry lane.".to_owned(),
                    &label,
                );
                self.record_resize_worker_event(
                    &label,
                    "timed-out",
                    pending.received_count,
                    pending.coalesced_count,
                    applied_count,
                    started.elapsed(),
                );
                #[cfg(windows)]
                self.record_windows_live_resize_counters(
                    &label,
                    pending.native_fast_path_counters,
                    pending.snapshot.native_fast_path,
                );
                self.clear_resize_worker(&label, None);
                break;
            }
            native_blocked_since = None;
            if pending.snapshot.sequence != last_applied_sequence || settled {
                if self.resize_window(&label, pending.snapshot, settled) {
                    applied_count = applied_count.saturating_add(1);
                }
                last_applied_sequence = pending.snapshot.sequence;
            }
            if settled
                && self.resize_pending_sequence_matches(&label, pending.snapshot.sequence)
            {
                if let Err(error) = self.persist_game_window_placement(&label) {
                    eprintln!(
                        "Runtime resize placement persistence failed: window={label} error={error}"
                    );
                }
                if self.clear_resize_worker(&label, Some(pending.snapshot.sequence)) {
                    #[cfg(windows)]
                    self.record_windows_live_resize_counters(
                        &label,
                        pending.native_fast_path_counters,
                        pending.snapshot.native_fast_path,
                    );
                    self.record_resize_worker_event(
                        &label,
                        "settled",
                        pending.received_count,
                        pending.coalesced_count,
                        applied_count,
                        started.elapsed(),
                    );
                    eprintln!(
                        "Runtime resize worker settled: window={label} received={} coalesced={} applied={} elapsedMs={}",
                        pending.received_count,
                        pending.coalesced_count,
                        applied_count,
                        started.elapsed().as_millis()
                    );
                    return;
                }
            }
            thread::sleep(WINDOW_RESIZE_FRAME_INTERVAL);
        }
        eprintln!(
            "Runtime resize worker stopped: window={label} applied={} elapsedMs={}",
            applied_count,
            started.elapsed().as_millis()
        );
        self.record_resize_worker_event(
            &label,
            "stopped",
            0,
            0,
            applied_count,
            started.elapsed(),
        );
    }

    fn resize_window_projection_is_busy(&self, label: &str) -> bool {
        self.window_id_for_label(label).is_some_and(|window_id| {
            self.native_window_mutations.is_busy(&window_id)
                || self.state.lock().ok().is_some_and(|state| {
                    state.active_geometry_windows.contains(&window_id)
                })
        })
    }

    fn resize_pending_sequence_matches(&self, label: &str, sequence: u64) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state
                .pending_window_resizes
                .get(label)
                .is_some_and(|pending| pending.snapshot.sequence == sequence)
        })
    }

    fn clear_resize_worker(&self, label: &str, sequence: Option<u64>) -> bool {
        self.state.lock().ok().is_some_and(|mut state| {
            if sequence.is_some_and(|sequence| {
                state
                    .pending_window_resizes
                    .get(label)
                    .is_some_and(|pending| pending.snapshot.sequence != sequence)
            }) {
                return false;
            }
            state.pending_window_resizes.remove(label);
            state.active_window_resize_workers.remove(label);
            true
        })
    }
}

#[cfg(any(windows, test))]
fn resize_metrics_with_tab_strip(
    mut metrics: WindowContentMetrics,
    tab_strip_height: f64,
) -> WindowContentMetrics {
    metrics.top_inset += tab_strip_height;
    metrics.height = (metrics.height - tab_strip_height).max(1.0);
    metrics
}

fn coalesce_pending_resize(
    previous: Option<PendingWindowResize>,
    snapshot: RuntimeWindowResizeSnapshot,
) -> PendingWindowResize {
    #[cfg(windows)]
    let native_fast_path_counters = previous
        .as_ref()
        .map_or(snapshot.native_fast_path.counters, |pending| {
            pending
                .native_fast_path_counters
                .saturating_add(snapshot.native_fast_path.counters)
        });
    PendingWindowResize {
        coalesced_count: previous
            .as_ref()
            .map_or(0, |pending| pending.coalesced_count.saturating_add(1)),
        #[cfg(windows)]
        native_fast_path_counters,
        received_count: previous
            .as_ref()
            .map_or(1, |pending| pending.received_count.saturating_add(1)),
        snapshot,
    }
}

fn resize_projection_tab_ids(
    selected_tab_id: Option<String>,
    settled_tab_ids: Option<Vec<String>>,
    hydrated_tab_ids: &HashSet<String>,
) -> Vec<String> {
    settled_tab_ids
        .unwrap_or_else(|| selected_tab_id.into_iter().collect())
        .into_iter()
        .filter(|tab_id| hydrated_tab_ids.contains(tab_id))
        .collect()
}

fn native_resize_should_retry(
    native_busy: bool,
    shutdown_state: RuntimeShutdownState,
    blocked_for: Duration,
) -> bool {
    native_busy
        && shutdown_state == RuntimeShutdownState::Accepting
        && blocked_for < PLATFORM_CALLBACK_TIMEOUT
}

fn resize_snapshot_is_settled(elapsed: Duration) -> bool {
    elapsed >= WINDOW_PLACEMENT_PERSIST_DEBOUNCE
}

#[cfg(windows)]
fn resize_toolbar_revealed(host: &RuntimeDisplayHost) -> bool {
    host.toolbar_revealed
}

#[cfg(not(windows))]
fn resize_toolbar_revealed(_host: &RuntimeDisplayHost) -> bool {
    false
}
