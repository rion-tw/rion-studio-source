#[derive(Default)]
struct WindowStatePersistCoordinator {
    lanes: Mutex<HashMap<String, WindowStatePersistLane>>,
    snapshots: Mutex<WindowStatePersistSnapshots>,
}

#[derive(Default)]
struct WindowStatePersistSnapshots {
    inputs: HashMap<String, GameWindowRuntimeSnapshotCommitInputRecord>,
    tabs: HashMap<String, GameWindowTabRecord>,
}

struct WindowStatePersistLane {
    active: bool,
    failure_count: u32,
    immediate: bool,
    input: Option<GameWindowRuntimeSnapshotCommitInputRecord>,
    revision: u64,
    window_generation: u64,
}

impl WindowStatePersistCoordinator {
    fn seed(&self, windows: &[StateGameWindowRecord]) {
        let Ok(mut snapshots) = self.snapshots.lock() else {
            return;
        };
        for window in windows {
            for tab in &window.tabs {
                snapshots.tabs.insert(tab.id.clone(), tab.clone());
            }
            snapshots.inputs.insert(
                window.id.clone(),
                GameWindowRuntimeSnapshotCommitInputRecord {
                    snapshot: RuntimeWindowTabSnapshotRecord {
                        window_id: window.id.clone(),
                        window_generation: 0,
                        revision: 0,
                        tabs: window.tabs.clone(),
                        active_tab_id: window.active_tab_id.clone(),
                    },
                    name: window.name.clone(),
                    target_display: window.target_display.clone(),
                    placement: window.placement.clone(),
                },
            );
        }
    }

    fn cached_target_display(
        &self,
        window_id: &str,
        display_id: i64,
    ) -> Option<DisplayTargetRecord> {
        self.snapshots
            .lock()
            .ok()?
            .inputs
            .get(window_id)
            .map(|input| input.target_display.clone())
            .filter(|target| target.id == display_id)
    }

    fn remember(&self, input: &GameWindowRuntimeSnapshotCommitInputRecord) {
        let Ok(mut snapshots) = self.snapshots.lock() else {
            return;
        };
        for tab in &input.snapshot.tabs {
            snapshots.tabs.insert(tab.id.clone(), tab.clone());
        }
        snapshots
            .inputs
            .insert(input.snapshot.window_id.clone(), input.clone());
    }

    fn freeze_cached(
        &self,
        window_id: &str,
        live: &LiveWindowTabState,
    ) -> Option<GameWindowRuntimeSnapshotCommitInputRecord> {
        let snapshots = self.snapshots.lock().ok()?;
        let mut input = snapshots.inputs.get(window_id)?.clone();
        let tabs = live
            .tabs
            .iter()
            .map(|tab| {
                snapshots.tabs.get(&tab.id).cloned().map(|mut snapshot| {
                    snapshot.hidden = live.tab_is_hidden(&tab.id);
                    snapshot
                })
            })
            .collect::<Option<Vec<_>>>()?;
        input.snapshot.window_generation = live.window_generation;
        input.snapshot.revision = live.revision;
        input.snapshot.tabs = tabs;
        input.snapshot.active_tab_id = live
            .selected_tab_id
            .clone()
            .filter(|tab_id| live.contains_tab(tab_id));
        Some(input)
    }

    fn request(
        &self,
        runtime: &Arc<SystemRuntimeExecutor>,
        window_id: &str,
        window_generation: u64,
        revision: u64,
        immediate: bool,
        input: GameWindowRuntimeSnapshotCommitInputRecord,
    ) {
        self.remember(&input);
        let should_spawn = self.lanes.lock().ok().is_some_and(|mut lanes| {
            let lane = lanes
                .entry(window_id.to_owned())
                .or_insert(WindowStatePersistLane {
                    active: false,
                    failure_count: 0,
                    immediate,
                    input: None,
                    revision,
                    window_generation,
                });
            let newer = window_generation > lane.window_generation
                || (window_generation == lane.window_generation && revision >= lane.revision);
            if newer {
                if window_generation != lane.window_generation || revision > lane.revision {
                    lane.failure_count = 0;
                    lane.input = None;
                }
                lane.window_generation = window_generation;
                lane.revision = revision;
                lane.input = Some(input);
            }
            lane.immediate |= immediate;
            if lane.active {
                false
            } else {
                lane.active = true;
                true
            }
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::downgrade(runtime);
        let window_id = window_id.to_owned();
        let worker_window_id = window_id.clone();
        let spawn = thread::Builder::new()
            .name(format!("rion-window-state-persist-{window_id}"))
            .spawn(move || run_window_state_persist_worker(runtime, worker_window_id));
        if spawn.is_err()
            && let Ok(mut lanes) = self.lanes.lock()
            && let Some(lane) = lanes.get_mut(&window_id)
        {
            lane.active = false;
        }
    }

    fn pending(&self, window_id: &str) -> Option<(u64, u64)> {
        self.lanes.lock().ok().and_then(|lanes| {
            lanes
                .get(window_id)
                .map(|lane| (lane.window_generation, lane.revision))
        })
    }
}

fn run_window_state_persist_worker(
    runtime: std::sync::Weak<SystemRuntimeExecutor>,
    window_id: String,
) {
    loop {
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        let (window_generation, revision, immediate, retained_input, failure_count) = runtime
            .window_state_persistence
            .lanes
            .lock()
            .ok()
            .and_then(|mut lanes| {
                let lane = lanes.get_mut(&window_id)?;
                let snapshot = (
                    lane.window_generation,
                    lane.revision,
                    lane.immediate,
                    lane.input.clone(),
                    lane.failure_count,
                );
                lane.immediate = false;
                Some(snapshot)
            })
            .unwrap_or((0, 0, false, None, 0));
        if revision == 0 {
            retire_window_state_persist_lane(&runtime, &window_id, window_generation, revision);
            return;
        }
        let delay = if immediate {
            Duration::ZERO
        } else if failure_count == 0 {
            WINDOW_STATE_PERSIST_DEBOUNCE
        } else {
            window_state_persist_retry_delay(failure_count)
        };
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let Some((current_generation, current_revision)) = runtime
            .window_state_persistence
            .pending(&window_id)
        else {
            return;
        };
        if current_generation != window_generation || current_revision != revision {
            continue;
        }
        let Some(input) = retained_input else {
            retire_window_state_persist_lane(&runtime, &window_id, window_generation, revision);
            return;
        };
        if input.snapshot.window_generation != window_generation
            || input.snapshot.revision != revision
        {
            runtime.window_state_persistence.request(
                &runtime,
                &window_id,
                input.snapshot.window_generation,
                input.snapshot.revision,
                false,
                input,
            );
            continue;
        }
        let result = runtime
            .core
            .invoke(CoreCommand::GameWindowRuntimeSnapshotCommit {
                input: input.clone(),
            })
            .and_then(|value| {
                serde_json::from_value::<RuntimeWindowPersistenceReceiptRecord>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            });
        match result {
            Ok(receipt) if matches!(receipt.status.as_str(), "applied" | "superseded") => {
                if retire_window_state_persist_lane(
                    &runtime,
                    &window_id,
                    input.snapshot.window_generation,
                    input.snapshot.revision,
                ) {
                    return;
                }
            }
            Ok(receipt) => record_window_state_persist_failure(
                &runtime,
                &window_id,
                input.snapshot.window_generation,
                input.snapshot.revision,
                format!("Unexpected persistence status {}.", receipt.status),
            ),
            Err(error) => record_window_state_persist_failure(
                &runtime,
                &window_id,
                input.snapshot.window_generation,
                input.snapshot.revision,
                error.to_string(),
            ),
        }
    }
}

fn retire_window_state_persist_lane(
    runtime: &SystemRuntimeExecutor,
    window_id: &str,
    window_generation: u64,
    revision: u64,
) -> bool {
    runtime
        .window_state_persistence
        .lanes
        .lock()
        .ok()
        .is_none_or(|mut lanes| {
            let current = lanes.get(window_id).map(|lane| {
                (lane.window_generation, lane.revision)
            });
            if current == Some((window_generation, revision)) {
                lanes.remove(window_id);
                true
            } else {
                false
            }
        })
}

fn record_window_state_persist_failure(
    runtime: &SystemRuntimeExecutor,
    window_id: &str,
    window_generation: u64,
    revision: u64,
    message: String,
) {
    let failure_count = runtime
        .window_state_persistence
        .lanes
        .lock()
        .ok()
        .and_then(|mut lanes| {
            let lane = lanes.get_mut(window_id)?;
            if lane.window_generation != window_generation || lane.revision != revision {
                return None;
            }
            lane.failure_count = lane.failure_count.saturating_add(1);
            Some(lane.failure_count)
        });
    let Some(failure_count) = failure_count else {
        return;
    };
    eprintln!(
        "Live Game Window snapshot persistence failed: window={window_id} generation={window_generation} revision={revision} attempt={failure_count} error={message}"
    );
    if failure_count == 4 {
        let _ = runtime.app.emit(
            "rion://shell-error",
            json!({
                "code": "TAURI_RUNTIME_WINDOW_STATE_PERSIST_FAILED",
                "message": message,
                "revision": revision,
                "windowGeneration": window_generation,
                "windowId": window_id,
            }),
        );
    }
}

fn window_state_persist_retry_delay(failure_count: u32) -> Duration {
    match failure_count {
        0 => WINDOW_STATE_PERSIST_DEBOUNCE,
        1 => Duration::from_millis(250),
        2 => Duration::from_secs(1),
        3 => Duration::from_secs(5),
        count => Duration::from_secs(5_u64.saturating_mul(1_u64 << (count - 4).min(3))).min(Duration::from_secs(30)),
    }
}

impl SystemRuntimeExecutor {
    pub(crate) fn touch_live_window_state(&self, window_id: &str) -> Result<u64, String> {
        let coordinator = self.presentation.coordinator(window_id)?;
        let revision = self.presentation.next_revision();
        coordinator
            .lock()
            .map_err(|_| "Live runtime window state is unavailable.".to_owned())?
            .revision = revision;
        Ok(revision)
    }

    pub(crate) fn runtime_window_snapshot_commit_input(
        &self,
        window_id: &str,
    ) -> Result<Option<GameWindowRuntimeSnapshotCommitInputRecord>, String> {
        let name = self
            .state
            .lock()
            .map_err(|_| "System runtime state lock poisoned.".to_owned())?
            .saved_window_names
            .get(window_id)
            .cloned();
        let Some(name) = name else {
            return Ok(None);
        };
        let live = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window identity was not found while saving.".to_owned())?
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .clone();
        let window_generation = live.window_generation;
        let revision = live.revision;
        if window_generation == 0 || revision == 0 {
            return Err("Live runtime window identity is not ready for persistence.".to_owned());
        }
        let fresh = self.runtime_game_window_save_input(window_id, name.clone()).map(|input| {
            GameWindowRuntimeSnapshotCommitInputRecord {
            snapshot: RuntimeWindowTabSnapshotRecord {
                window_id: input.window_id,
                window_generation,
                revision,
                tabs: input.tabs,
                active_tab_id: input.active_tab_id,
            },
            name: input.name,
            target_display: input.target_display,
            placement: input.placement,
            }
        });
        match fresh {
            Ok(input) => {
                self.window_state_persistence.remember(&input);
                Ok(Some(input))
            }
            Err(fresh_error) => self
                .window_state_persistence
                .freeze_cached(window_id, &live)
                .map(Some)
                .ok_or(fresh_error),
        }
    }

    pub(crate) fn schedule_live_window_state_persistence(&self, window_id: &str) {
        // Window teardown owns one frozen, pre-close snapshot. Late close,
        // selection, geometry, and native readback callbacks are projections of
        // teardown and have no authority to replace the saved window definition.
        if self.current_window_close_in_progress(window_id) {
            return;
        }
        // Restore launches are accepted concurrently. Core projection can settle after native
        // reservations, so partial launch snapshots must not replace the saved definition.
        // The restore contract schedules one authoritative snapshot after every create reaches
        // a successful terminal state and the saved order is re-applied.
        if self.pending_window_tab_restore(window_id).is_some() {
            return;
        }
        let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        let input = match self.runtime_window_snapshot_commit_input(window_id) {
            Ok(Some(input)) => input,
            Ok(None) => return,
            Err(error) => {
                // A late lifecycle callback can outlive its memory snapshot.
                // Persistence is projection-only, so it retires silently and
                // never re-queries or restores a window that no longer exists.
                eprintln!(
                    "Late Live Game Window snapshot intent was retired: window={window_id} error={error}"
                );
                return;
            }
        };
        self.window_state_persistence.request(
            &runtime,
            window_id,
            input.snapshot.window_generation,
            input.snapshot.revision,
            false,
            input,
        );
    }

    pub(crate) fn flush_live_window_state(&self, window_id: &str) -> Result<(), String> {
        let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return Err("The live window persistence runtime is unavailable.".to_owned());
        };
        let Some(input) = self.runtime_window_snapshot_commit_input(window_id)? else {
            return Ok(());
        };
        self.window_state_persistence.request(
            &runtime,
            window_id,
            input.snapshot.window_generation,
            input.snapshot.revision,
            true,
            input,
        );
        Ok(())
    }

    pub(crate) fn flush_all_live_window_states(&self) {
        let window_ids = self
            .presentation
            .snapshot_states()
            .map(|windows| windows.into_keys().collect::<Vec<_>>())
            .unwrap_or_default();
        for window_id in window_ids {
            if let Err(message) = self.flush_live_window_state(&window_id) {
                eprintln!("Final live window snapshot flush failed for {window_id}: {message}");
            }
        }
    }
}

#[cfg(test)]
mod window_state_persistence_tests {
    use super::*;

    fn saved_window() -> StateGameWindowRecord {
        serde_json::from_value(json!({
            "id": "window-a",
            "name": "Window A",
            "targetDisplay": { "id": 7 },
            "placement": {
                "normalBounds": { "x": 10, "y": 20, "width": 900, "height": 600 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [{
                "id": "tab-a", "tabType": "role", "sourceId": "role-a", "name": "A",
                "roleSlots": [{
                    "slotId": "slot-a", "roleId": "role-a",
                    "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 }
                }],
                "hidden": false, "audioMuted": false
            }, {
                "id": "tab-b", "tabType": "role", "sourceId": "role-b", "name": "B",
                "roleSlots": [{
                    "slotId": "slot-b", "roleId": "role-b",
                    "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 }
                }],
                "hidden": false, "audioMuted": true
            }],
            "activeTabId": "tab-a",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    fn live_tab(id: &str, source_id: &str) -> TabPresentation {
        TabPresentation {
            closable: true,
            icon_data_url: None,
            id: id.to_owned(),
            phase: TabPresentationPhase::Ready,
            role_ids: vec![source_id.to_owned()],
            source_id: source_id.to_owned(),
            tab_type: "role".to_owned(),
            title: source_id.to_owned(),
            #[cfg(any(windows, target_os = "macos"))]
            workspace_template: None,
        }
    }

    #[test]
    fn persistence_retry_backoff_is_bounded() {
        assert_eq!(window_state_persist_retry_delay(1), Duration::from_millis(250));
        assert_eq!(window_state_persist_retry_delay(2), Duration::from_secs(1));
        assert_eq!(window_state_persist_retry_delay(3), Duration::from_secs(5));
        assert_eq!(window_state_persist_retry_delay(20), Duration::from_secs(30));
    }

    #[test]
    fn frozen_memory_snapshot_keeps_latest_ui_order_after_native_host_retires() {
        let coordinator = WindowStatePersistCoordinator::default();
        coordinator.seed(&[saved_window()]);
        let live = LiveWindowTabState {
            revision: 19,
            selected_tab_id: Some("tab-b".to_owned()),
            tabs: vec![live_tab("tab-b", "role-b"), live_tab("tab-a", "role-a")],
            window_generation: 4,
            window_id: "window-a".to_owned(),
            ..LiveWindowTabState::default()
        };

        let frozen = coordinator.freeze_cached("window-a", &live).unwrap();

        assert_eq!(frozen.snapshot.window_generation, 4);
        assert_eq!(frozen.snapshot.revision, 19);
        assert_eq!(frozen.snapshot.active_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            frozen
                .snapshot
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            vec!["tab-b", "tab-a"]
        );
        assert!(frozen.snapshot.tabs[0].audio_muted);
        assert_eq!(
            coordinator.cached_target_display("window-a", 7).unwrap().id,
            7
        );
    }
}
