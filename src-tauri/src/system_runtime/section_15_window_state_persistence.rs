#[derive(Default)]
struct WindowStatePersistCoordinator {
    lanes: Mutex<HashMap<String, WindowStatePersistLane>>,
    snapshots: Mutex<WindowStatePersistSnapshots>,
    worker_active: Mutex<bool>,
}

#[derive(Default)]
struct WindowStatePersistSnapshots {
    inputs: HashMap<String, GameWindowRuntimeSnapshotCommitInputRecord>,
}

struct WindowStatePersistLane {
    failure_count: u32,
    immediate: bool,
    input: GameWindowRuntimeSnapshotCommitInputRecord,
    last_error: Option<String>,
    revision: u64,
    window_generation: u64,
}

impl WindowStatePersistCoordinator {
    fn seed(&self, windows: &[StateGameWindowRecord]) {
        let Ok(mut snapshots) = self.snapshots.lock() else {
            return;
        };
        for window in windows {
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
        snapshots
            .inputs
            .insert(input.snapshot.window_id.clone(), input.clone());
    }

    #[cfg(test)]
    fn materialize_live_snapshot(
        &self,
        window_id: &str,
        live: &LiveWindowRecord,
    ) -> Option<GameWindowRuntimeSnapshotCommitInputRecord> {
        let snapshots = self.snapshots.lock().ok()?;
        let mut input = snapshots.inputs.get(window_id)?.clone();
        input.snapshot.window_generation = live.window_generation;
        input.snapshot.revision = live.revision;
        input.snapshot.tabs = SystemRuntimeExecutor::live_game_window_tabs(live);
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
        let accepted = self.lanes.lock().ok().is_some_and(|mut lanes| {
            let newer = lanes.get(window_id).is_none_or(|lane| {
                window_generation > lane.window_generation
                    || (window_generation == lane.window_generation && revision >= lane.revision)
            });
            if !newer {
                return false;
            }
            let failure_count = lanes
                .get(window_id)
                .filter(|lane| {
                    lane.window_generation == window_generation && lane.revision == revision
                })
                .map_or(0, |lane| lane.failure_count);
            let last_error = lanes
                .get(window_id)
                .filter(|lane| {
                    lane.window_generation == window_generation && lane.revision == revision
                })
                .and_then(|lane| lane.last_error.clone());
            lanes.insert(
                window_id.to_owned(),
                WindowStatePersistLane {
                    failure_count,
                    immediate,
                    input,
                    last_error,
                    revision,
                    window_generation,
                },
            );
            true
        });
        if !accepted {
            return;
        }
        let should_spawn = self.worker_active.lock().ok().is_some_and(|mut active| {
            if *active {
                false
            } else {
                *active = true;
                true
            }
        });
        if !should_spawn {
            return;
        }
        let runtime = Arc::downgrade(runtime);
        if thread::Builder::new()
            .name("rion-window-state-persist".to_owned())
            .spawn(move || run_window_state_persist_worker(runtime))
            .is_err()
            && let Ok(mut active) = self.worker_active.lock()
        {
            *active = false;
        }
    }

}

fn run_window_state_persist_worker(runtime: std::sync::Weak<SystemRuntimeExecutor>) {
    loop {
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        let delay = runtime
            .window_state_persistence
            .lanes
            .lock()
            .ok()
            .and_then(|lanes| {
                if lanes.is_empty() {
                    None
                } else if lanes.values().any(|lane| lane.immediate) {
                    Some(Duration::ZERO)
                } else {
                    let failure_count = lanes
                        .values()
                        .map(|lane| lane.failure_count)
                        .min()
                        .unwrap_or_default();
                    Some(window_state_persist_retry_delay(failure_count))
                }
            });
        let Some(delay) = delay else {
            if let Ok(mut active) = runtime.window_state_persistence.worker_active.lock() {
                *active = false;
            }
            // A request can arrive between observing the empty map and retiring
            // the worker. Re-arm once so no latest snapshot is stranded.
            let should_continue = runtime
                .window_state_persistence
                .lanes
                .lock()
                .is_ok_and(|lanes| !lanes.is_empty())
                && runtime
                    .window_state_persistence
                    .worker_active
                    .lock()
                    .is_ok_and(|mut active| {
                        if *active {
                            false
                        } else {
                            *active = true;
                            true
                        }
                    });
            if should_continue {
                continue;
            }
            return;
        };
        if !delay.is_zero() {
            thread::sleep(delay);
        }
        let inputs = runtime
            .window_state_persistence
            .lanes
            .lock()
            .map(|mut lanes| {
                for lane in lanes.values_mut() {
                    lane.immediate = false;
                }
                lanes
                    .values()
                    .map(|lane| lane.input.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if inputs.is_empty() {
            continue;
        }
        let requested = inputs
            .iter()
            .map(|input| {
                (
                    input.snapshot.window_id.clone(),
                    input.snapshot.window_generation,
                    input.snapshot.revision,
                )
            })
            .collect::<Vec<_>>();
        let result = runtime
            .core
            .invoke(CoreCommand::GameWindowRuntimeSnapshotBatchCommit {
                input: GameWindowRuntimeSnapshotBatchCommitInputRecord { inputs },
            })
            .and_then(|value| {
                serde_json::from_value::<RuntimeWindowPersistenceBatchReceiptRecord>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            });
        match result {
            Ok(batch) => {
                let receipt_keys = batch
                    .receipts
                    .iter()
                    .filter(|receipt| {
                        matches!(receipt.status.as_str(), "applied" | "superseded")
                    })
                    .map(|receipt| {
                        (
                            receipt.window_id.as_str(),
                            receipt.window_generation,
                            receipt.revision,
                        )
                    })
                    .collect::<HashSet<_>>();
                for (window_id, window_generation, revision) in &requested {
                    if receipt_keys.contains(&(
                        window_id.as_str(),
                        *window_generation,
                        *revision,
                    )) {
                        retire_window_state_persist_lane(
                            &runtime,
                            window_id,
                            *window_generation,
                            *revision,
                        );
                    } else {
                        record_window_state_persist_failure(
                            &runtime,
                            window_id,
                            *window_generation,
                            *revision,
                            "The persistence batch omitted the requested revision.".to_owned(),
                        );
                    }
                }
            }
            Err(error) => {
                let message = error.to_string();
                for (window_id, window_generation, revision) in requested {
                    record_window_state_persist_failure(
                        &runtime,
                        &window_id,
                        window_generation,
                        revision,
                        message.clone(),
                    );
                }
            }
        }
    }
}

fn retire_window_state_persist_lane(
    runtime: &SystemRuntimeExecutor,
    window_id: &str,
    window_generation: u64,
    revision: u64,
) {
    if let Ok(mut lanes) = runtime.window_state_persistence.lanes.lock()
        && lanes.get(window_id).is_some_and(|lane| {
            lane.window_generation == window_generation && lane.revision == revision
        })
    {
        lanes.remove(window_id);
    }
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
            lane.last_error = Some(message.clone());
            Some(lane.failure_count)
        });
    let Some(failure_count) = failure_count else {
        return;
    };
    eprintln!(
        "Live Game Window snapshot persistence failed: window={window_id} generation={window_generation} revision={revision} attempt={failure_count} error={message}"
    );
}

fn window_state_persist_retry_delay(failure_count: u32) -> Duration {
    match failure_count {
        0 => WINDOW_STATE_PERSIST_DEBOUNCE,
        1 => Duration::from_millis(250),
        2 => Duration::from_secs(1),
        3 => Duration::from_secs(5),
        count => Duration::from_secs(
            5_u64.saturating_mul(1_u64 << (count - 4).min(3)),
        )
        .min(Duration::from_secs(30)),
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
        let live = self
            .presentation
            .existing(window_id)
            .ok_or_else(|| "Live runtime window identity was not found while saving.".to_owned())?
            .lock()
            .map_err(|_| "Live runtime window state is unavailable while saving.".to_owned())?
            .clone();
        let Some(name) = live.persisted_name.clone() else {
            return Ok(None);
        };
        let window_generation = live.window_generation;
        let revision = live.revision;
        if window_generation == 0 || revision == 0 {
            return Err("Live runtime window identity is not ready for persistence.".to_owned());
        }
        let target_display = live
            .target_display
            .clone()
            .ok_or_else(|| "Live runtime window target display is not initialized.".to_owned())?;
        let placement = live
            .placement
            .clone()
            .ok_or_else(|| "Live runtime window placement is not initialized.".to_owned())?;
        let input = GameWindowRuntimeSnapshotCommitInputRecord {
            snapshot: RuntimeWindowTabSnapshotRecord {
                window_id: window_id.to_owned(),
                window_generation,
                revision,
                tabs: Self::live_game_window_tabs(&live),
                active_tab_id: live
                    .selected_tab_id
                    .clone()
                    .filter(|tab_id| live.contains_tab(tab_id)),
            },
            name,
            target_display,
            placement,
        };
        self.window_state_persistence.remember(&input);
        Ok(Some(input))
    }

    pub(crate) fn schedule_live_window_state_persistence(&self, window_id: &str) {
        // Window teardown owns the final pre-close live revision. Late close,
        // selection, geometry, and native readback callbacks are projections of
        // teardown and have no authority to replace the saved window definition.
        if self.current_window_close_in_progress(window_id) {
            return;
        }
        // Restore launches are accepted concurrently. Native surfaces can settle after chrome
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

    pub(crate) fn wait_for_final_window_state_flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let pending = self
                .window_state_persistence
                .lanes
                .lock()
                .map(|lanes| {
                    lanes
                        .values()
                        .map(|lane| {
                            (
                                lane.input.snapshot.window_id.clone(),
                                lane.window_generation,
                                lane.revision,
                                lane.failure_count,
                                lane.last_error.clone(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if pending.is_empty() {
                return true;
            }
            if Instant::now() >= deadline {
                for (window_id, generation, revision, attempts, error) in pending {
                    eprintln!(
                        "Final Live Game Window snapshot remains dirty: window={window_id} generation={generation} revision={revision} attempts={attempts} error={}",
                        error.as_deref().unwrap_or("persistence worker still pending")
                    );
                }
                return false;
            }
            thread::sleep(Duration::from_millis(10));
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

    fn live_tab(id: &str, source_id: &str) -> LiveTabRecord {
        LiveTabRecord {
            audio_muted: source_id == "role-b",
            closable: true,
            icon_data_url: None,
            id: id.to_owned(),
            persistable: true,
            role_ids: vec![source_id.to_owned()],
            role_slots: vec![GameWindowRoleSlotRecord {
                slot_id: format!("slot-{source_id}"),
                role_id: source_id.to_owned(),
                rect: StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                browser_zoom_percent: None,
            }],
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
    fn live_memory_snapshot_keeps_latest_ui_order_after_native_host_retires() {
        let coordinator = WindowStatePersistCoordinator::default();
        coordinator.seed(&[saved_window()]);
        let live = LiveWindowRecord {
            revision: 19,
            selected_tab_id: Some("tab-b".to_owned()),
            tabs: vec![live_tab("tab-b", "role-b"), live_tab("tab-a", "role-a")],
            window_generation: 4,
            window_id: "window-a".to_owned(),
            ..LiveWindowRecord::default()
        };

        let snapshot = coordinator
            .materialize_live_snapshot("window-a", &live)
            .unwrap();

        assert_eq!(snapshot.snapshot.window_generation, 4);
        assert_eq!(snapshot.snapshot.revision, 19);
        assert_eq!(snapshot.snapshot.active_tab_id.as_deref(), Some("tab-b"));
        assert_eq!(
            snapshot
                .snapshot
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            vec!["tab-b", "tab-a"]
        );
        assert!(snapshot.snapshot.tabs[0].audio_muted);
        assert_eq!(
            coordinator.cached_target_display("window-a", 7).unwrap().id,
            7
        );
    }
}
