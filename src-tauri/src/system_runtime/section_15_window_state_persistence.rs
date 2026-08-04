#[derive(Default)]
struct WindowStatePersistCoordinator {
    lanes: Mutex<HashMap<String, WindowStatePersistLane>>,
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
    fn request(
        &self,
        runtime: &Arc<SystemRuntimeExecutor>,
        window_id: &str,
        window_generation: u64,
        revision: u64,
        immediate: bool,
        input: Option<GameWindowRuntimeSnapshotCommitInputRecord>,
    ) {
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
                if input.is_some() {
                    lane.input = input;
                }
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
        let input = match retained_input {
            Some(input) => Some(input),
            None => match runtime.runtime_window_snapshot_commit_input(&window_id) {
                Ok(input) => input,
                Err(message) => {
                    record_window_state_persist_failure(
                        &runtime,
                        &window_id,
                        window_generation,
                        revision,
                        message,
                    );
                    continue;
                }
            },
        };
        let Some(input) = input else {
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
                None,
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

    pub(crate) fn live_window_identity(&self, window_id: &str) -> Option<(u64, u64)> {
        self.presentation.existing(window_id).and_then(|state| {
            state
                .lock()
                .ok()
                .map(|state| (state.window_generation, state.revision))
        })
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
        let (window_generation, revision) = self
            .live_window_identity(window_id)
            .ok_or_else(|| "Live runtime window identity was not found while saving.".to_owned())?;
        if window_generation == 0 || revision == 0 {
            return Err("Live runtime window identity is not ready for persistence.".to_owned());
        }
        let input = self.runtime_game_window_save_input(window_id, name)?;
        Ok(Some(GameWindowRuntimeSnapshotCommitInputRecord {
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
        }))
    }

    pub(crate) fn schedule_live_window_state_persistence(&self, window_id: &str) {
        let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        let Some((window_generation, revision)) = self.live_window_identity(window_id) else {
            return;
        };
        self.window_state_persistence.request(
            &runtime,
            window_id,
            window_generation,
            revision,
            false,
            None,
        );
    }

    pub(crate) fn flush_live_window_state(&self, window_id: &str) -> Result<(), String> {
        let Some(runtime) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return Err("The live window persistence runtime is unavailable.".to_owned());
        };
        let Some(input) = self.runtime_window_snapshot_commit_input(window_id)? else {
            return Ok(());
        };
        let result = self
            .core
            .invoke(CoreCommand::GameWindowRuntimeSnapshotCommit {
                input: input.clone(),
            })
            .and_then(|value| {
                serde_json::from_value::<RuntimeWindowPersistenceReceiptRecord>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            });
        if result.as_ref().is_ok_and(|receipt| {
            matches!(receipt.status.as_str(), "applied" | "superseded")
        }) {
            let _ = retire_window_state_persist_lane(
                self,
                window_id,
                input.snapshot.window_generation,
                input.snapshot.revision,
            );
            return Ok(());
        }
        self.window_state_persistence.request(
            &runtime,
            window_id,
            input.snapshot.window_generation,
            input.snapshot.revision,
            true,
            Some(input),
        );
        Err(result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "The live window snapshot commit was rejected.".to_owned()))
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

    #[test]
    fn persistence_retry_backoff_is_bounded() {
        assert_eq!(window_state_persist_retry_delay(1), Duration::from_millis(250));
        assert_eq!(window_state_persist_retry_delay(2), Duration::from_secs(1));
        assert_eq!(window_state_persist_retry_delay(3), Duration::from_secs(5));
        assert_eq!(window_state_persist_retry_delay(20), Duration::from_secs(30));
    }
}
