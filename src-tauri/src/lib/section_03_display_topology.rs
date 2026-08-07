#[derive(Clone, Default)]
struct DisplayTopologyCoordinator {
    inner: Arc<DisplayTopologyCoordinatorInner>,
}

#[derive(Default)]
struct DisplayTopologyCoordinatorInner {
    committed_semantic: Mutex<Option<Value>>,
    projection: native_projection::RevisionedJsonProjection,
    reconcile_gate: Mutex<()>,
    worker: Mutex<DisplayTopologyWorkerState>,
}

#[derive(Default)]
struct DisplayTopologyWorkerState {
    cause: String,
    requested_revision: u64,
    worker_running: bool,
}

struct NativeDisplayInventory {
    current_monitor: Option<tauri::Monitor>,
    monitors: Vec<tauri::Monitor>,
    primary_monitor: Option<tauri::Monitor>,
    records: Vec<rion_core::DisplayInfoRecord>,
}

struct DisplayTopologyRemapPlan {
    target: EmbeddedLaunchTargetRecord,
}

impl DisplayTopologyCoordinator {
    fn current_revision(&self) -> u64 {
        self.inner.projection.current_revision()
    }

    fn request(&self, app: AppHandle, cause: &str) -> Result<(), String> {
        let should_spawn = {
            let mut state = self
                .inner
                .worker
                .lock()
                .map_err(|_| "display topology coordinator is unavailable".to_owned())?;
            state.requested_revision = state.requested_revision.wrapping_add(1).max(1);
            state.cause = cause.to_owned();
            if state.worker_running {
                false
            } else {
                state.worker_running = true;
                true
            }
        };
        if !should_spawn {
            return Ok(());
        }
        let coordinator = self.clone();
        match thread::Builder::new()
            .name("rion-display-topology-reconcile".to_owned())
            .spawn(move || coordinator.run_worker(app))
        {
            Ok(_) => Ok(()),
            Err(error) => {
                if let Ok(mut state) = self.inner.worker.lock() {
                    state.worker_running = false;
                }
                Err(error.to_string())
            }
        }
    }

    fn run_worker(&self, app: AppHandle) {
        loop {
            let (requested_revision, cause) = match self.inner.worker.lock() {
                Ok(state) => (state.requested_revision, state.cause.clone()),
                Err(_) => return,
            };
            let result = app
                .try_state::<CoreState>()
                .ok_or_else(|| {
                    shell_error(
                        "SHELL_STATE_UNAVAILABLE",
                        "App state is unavailable during display reconciliation.",
                    )
                })
                .and_then(|state| {
                    let window = app.get_webview_window("main").ok_or_else(|| {
                        shell_error(
                            "SHELL_WINDOW_NOT_FOUND",
                            "The main window is unavailable during display reconciliation.",
                        )
                    })?;
                    self.reconcile(&app, &state, &window, &cause)
                });
            if let Err(error) = result {
                reveal_shell_error(&app, error);
            }
            let mut state = match self.inner.worker.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.requested_revision == requested_revision {
                state.worker_running = false;
                return;
            }
        }
    }

    fn reconcile(
        &self,
        app: &AppHandle,
        state: &CoreState,
        window: &WebviewWindow,
        cause: &str,
    ) -> Result<Value, CoreErrorPayload> {
        let _gate = self.inner.reconcile_gate.lock().map_err(|_| {
            shell_error(
                "SHELL_DISPLAY_RECONCILE_UNAVAILABLE",
                "The display topology reconciliation lane is unavailable.",
            )
        })?;
        let inventory = capture_display_inventory(window)?;
        let semantic = inventory.semantic_value();
        if self
            .inner
            .committed_semantic
            .lock()
            .ok()
            .is_some_and(|committed| committed.as_ref() == Some(&semantic))
        {
            return self.inner.projection.current().ok_or_else(|| {
                shell_error(
                    "SHELL_DISPLAY_STATE_INVALID",
                    "The committed display topology projection is unavailable.",
                )
            });
        }

        let game_windows = state
            .core
            .invoke(CoreCommand::GameWindowsList)
            .and_then(|value| {
                serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                    .map_err(|error| rion_core::CoreError::Internal(error.to_string()))
            })
            .map_err(error_payload)?;
        let plans = game_windows
            .iter()
            .map(|game_window| {
                resolve_game_window_launch_target_from_inventory(
                    game_window,
                    &inventory.monitors,
                    inventory.primary_monitor.as_ref(),
                    inventory.current_monitor.as_ref(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|resolution| resolution.remap.is_some())
            .map(|resolution| DisplayTopologyRemapPlan {
                target: resolution.target,
            })
            .collect::<Vec<_>>();
        let topology_revision = self.inner.projection.current_revision().saturating_add(1);
        let targets = plans
            .iter()
            .map(|plan| plan.target.clone())
            .collect::<Vec<_>>();
        let core = Arc::clone(&state.core);
        let committed_targets = Mutex::new(Vec::new());
        let receipt = state
            .runtime
            .reconcile_display_topology_targets(topology_revision, targets, |applied| {
                if applied.is_empty() {
                    return Ok(());
                }
                let updates = applied
                    .iter()
                    .map(|target| {
                        let target_display = inventory
                            .display_target(target.display_id)
                            .ok_or_else(|| {
                                "SYSTEM_DISPLAY_TOPOLOGY_READBACK_DISPLAY_MISSING".to_owned()
                            })?;
                        Ok(GameWindowDisplayRemapRecord {
                            window_id: target.window_id.clone(),
                            input: GameWindowUpdateInputRecord {
                                target_display: Some(target_display),
                                placement: Some(GameWindowPlacementRecord {
                                    normal_bounds: target.bounds.clone(),
                                    saved_work_area: target.work_area.clone(),
                                    presentation: target.presentation.clone(),
                                }),
                                ..GameWindowUpdateInputRecord::default()
                            },
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                core.invoke(CoreCommand::GameWindowsDisplayRemap { updates })
                    .map(|_| ())
                    .map_err(|error| error.to_string())?;
                *committed_targets
                    .lock()
                    .map_err(|_| "SYSTEM_DISPLAY_TOPOLOGY_COMMIT_CAPTURE_FAILED".to_owned())? =
                    applied.to_vec();
                Ok(())
            })
            .map_err(|code| {
                shell_error(
                    &code,
                    "The display topology operation could not be accepted.",
                )
            })?;
        if !matches!(receipt.status.as_str(), "applied" | "degraded") {
            let code = receipt
                .failure_code
                .as_deref()
                .unwrap_or("SYSTEM_DISPLAY_TOPOLOGY_RECONCILE_FAILED");
            return Err(shell_error(
                code,
                "The display topology changed, but game windows could not be reconciled safely.",
            ));
        }

        if let Err(error) = state.runtime.persist_restore_session(false) {
            reveal_shell_error(
                app,
                shell_error("TAURI_RESTORE_PERSIST_FAILED", error),
            );
        }
        let payload = json!({
            "cause": cause,
            "primaryDisplayId": inventory.primary_id().map(|id| id.to_string()),
            "displays": inventory.records
        });
        let topology = self
            .inner
            .projection
            .resolve_object_ignoring(payload, &["cause"]);
        if topology["revision"].as_u64() != Some(topology_revision) {
            return Err(shell_error(
                "SHELL_DISPLAY_REVISION_MISMATCH",
                "The display topology revision changed before its transaction committed.",
            ));
        }
        if let Ok(mut committed) = self.inner.committed_semantic.lock() {
            *committed = Some(semantic);
        }
        let committed_targets = committed_targets
            .lock()
            .map(|targets| targets.clone())
            .unwrap_or_default();
        for target in &committed_targets {
            let _ = app.emit(
                "rion://game-window-display-remapped",
                json!({
                    "windowId": target.window_id,
                    "displayId": target.display_id
                }),
            );
        }
        let _ = app.emit("rion://display-topology", &topology);
        Ok(topology)
    }
}

impl NativeDisplayInventory {
    fn primary_id(&self) -> Option<i64> {
        self.primary_monitor.as_ref().map(monitor_id)
    }

    fn semantic_value(&self) -> Value {
        json!({
            "primaryDisplayId": self.primary_id().map(|id| id.to_string()),
            "displays": self.records
        })
    }

    fn display_target(&self, display_id: i64) -> Option<DisplayTargetRecord> {
        let primary_id = self.primary_id();
        self.monitors
            .iter()
            .find(|monitor| monitor_id(monitor) == display_id)
            .map(|monitor| display_target_and_work_area(monitor, primary_id).0)
    }
}

fn monitor_id(monitor: &tauri::Monitor) -> i64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    monitor.name().hash(&mut hasher);
    monitor.position().x.hash(&mut hasher);
    monitor.position().y.hash(&mut hasher);
    monitor.size().width.hash(&mut hasher);
    monitor.size().height.hash(&mut hasher);
    safe_display_id(hasher.finish())
}

fn safe_display_id(hash: u64) -> i64 {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    (hash % MAX_SAFE_INTEGER) as i64
}

fn capture_display_inventory(
    window: &WebviewWindow,
) -> Result<NativeDisplayInventory, CoreErrorPayload> {
    let primary_monitor = window
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_id = primary_monitor.as_ref().map(monitor_id);
    let current_monitor = window.current_monitor().ok().flatten();
    let monitors = window
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let mut records = monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let scale_factor = monitor.scale_factor().max(f64::EPSILON);
            let work_area = monitor.work_area();
            let id = monitor_id(monitor);
            rion_core::DisplayInfoRecord {
                id,
                label: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {id}")),
                bounds: StatePixelBoundsRecord {
                    x: (position.x as f64 / scale_factor).round() as i32,
                    y: (position.y as f64 / scale_factor).round() as i32,
                    width: (size.width as f64 / scale_factor).round() as i32,
                    height: (size.height as f64 / scale_factor).round() as i32,
                },
                work_area: StatePixelBoundsRecord {
                    x: (work_area.position.x as f64 / scale_factor).round() as i32,
                    y: (work_area.position.y as f64 / scale_factor).round() as i32,
                    width: (work_area.size.width as f64 / scale_factor).round() as i32,
                    height: (work_area.size.height as f64 / scale_factor).round() as i32,
                },
                resolution: StateResolutionRecord {
                    width: size.width,
                    height: size.height,
                },
                scale_factor,
                is_primary: primary_id == Some(id),
                is_internal: false,
            }
        })
        .collect::<Vec<_>>();
    records.sort_by_key(|display| display.id);
    Ok(NativeDisplayInventory {
        current_monitor,
        monitors,
        primary_monitor,
        records,
    })
}

fn display_topology(
    state: &CoreState,
    window: &WebviewWindow,
    cause: &str,
) -> Result<Value, CoreErrorPayload> {
    state
        .display_topology
        .reconcile(window.app_handle(), state, window, cause)
}

fn request_display_topology(
    app: &AppHandle,
    state: &CoreState,
    cause: &str,
) -> Result<(), String> {
    state.display_topology.request(app.clone(), cause)
}

fn start_display_watcher(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<CoreState>() {
        request_display_topology(&app, &state, "startup")?;
    }
    Ok(())
}
