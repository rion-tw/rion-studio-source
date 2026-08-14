fn select_non_conflicting_saved_windows(
    game_windows: &[StateGameWindowRecord],
    last_focused_window_id: Option<&str>,
) -> Vec<StateGameWindowRecord> {
    let mut ordered = game_windows.iter().collect::<Vec<_>>();
    if let Some(last_focused_window_id) = last_focused_window_id
        && let Some(index) = ordered
            .iter()
            .position(|window| window.id == last_focused_window_id)
    {
        let focused = ordered.remove(index);
        ordered.insert(0, focused);
    }
    let mut claimed_sources = HashSet::new();
    ordered
        .into_iter()
        .filter(|window| {
            let sources = window
                .tabs
                .iter()
                .flat_map(game_window_tab_source_keys)
                .collect::<HashSet<_>>();
            if sources
                .iter()
                .any(|source| claimed_sources.contains(source))
            {
                return false;
            }
            claimed_sources.extend(sources);
            true
        })
        .cloned()
        .collect()
}

fn game_window_tab_source_keys(tab: &GameWindowTabRecord) -> HashSet<String> {
    let mut keys = HashSet::from([format!("{}:{}", tab.tab_type, tab.source_id)]);
    keys.extend(
        tab.role_slots
            .iter()
            .map(|slot| format!("role:{}", slot.role_id)),
    );
    keys
}

fn saved_tab_for_launcher_source<'a>(
    window: &'a StateGameWindowRecord,
    source_id: &str,
    source_type: &str,
) -> Option<&'a GameWindowTabRecord> {
    let source_key = format!("{source_type}:{source_id}");
    window
        .tabs
        .iter()
        .find(|tab| game_window_tab_source_keys(tab).contains(&source_key))
}

fn select_auto_restore_saved_windows(
    game_windows: &[StateGameWindowRecord],
    last_focused_window_id: Option<&str>,
    snapshot: &BrowserRuntimeSnapshot,
) -> Vec<StateGameWindowRecord> {
    let eligible = game_windows
        .iter()
        .filter(|saved| !saved_window_conflicts_with_runtime(saved, snapshot))
        .cloned()
        .collect::<Vec<_>>();
    select_non_conflicting_saved_windows(&eligible, last_focused_window_id)
}

fn order_selected_saved_windows_for_restore(
    mut selected: Vec<StateGameWindowRecord>,
    focus_window_id: Option<&str>,
) -> Vec<StateGameWindowRecord> {
    if let Some(focus_window_id) = focus_window_id
        && let Some(index) = selected
            .iter()
            .position(|window| window.id == focus_window_id)
    {
        let focused = selected.remove(index);
        selected.push(focused);
    }
    selected
}

fn saved_window_foreground_tab(
    window: &StateGameWindowRecord,
) -> Option<&GameWindowTabRecord> {
    window
        .active_tab_id
        .as_ref()
        .and_then(|active| {
            window
                .tabs
                .iter()
                .find(|tab| &tab.id == active && !tab.hidden)
        })
        .or_else(|| window.tabs.iter().find(|tab| !tab.hidden))
}

fn saved_window_conflicts_with_runtime(
    saved: &StateGameWindowRecord,
    snapshot: &BrowserRuntimeSnapshot,
) -> bool {
    let desired_sources = saved
        .tabs
        .iter()
        .flat_map(game_window_tab_source_keys)
        .collect::<HashSet<_>>();
    snapshot.tabs.iter().any(|tab| {
        if tab.window_id == saved.id {
            return false;
        }
        let exact_source = format!("{}:{}", tab.tab_type, tab.source_id);
        desired_sources.contains(&exact_source)
            || tab
                .slots
                .iter()
                .any(|slot| desired_sources.contains(&format!("role:{}", slot.role_id)))
    })
}

fn saved_window_duplicates_runtime_tab_source(
    saved: &StateGameWindowRecord,
    snapshot: &BrowserRuntimeSnapshot,
) -> bool {
    let desired_sources = saved
        .tabs
        .iter()
        .map(|tab| format!("{}:{}", tab.tab_type, tab.source_id))
        .collect::<HashSet<_>>();
    snapshot.tabs.iter().any(|tab| {
        tab.window_id != saved.id
            && desired_sources.contains(&format!("{}:{}", tab.tab_type, tab.source_id))
    })
}

fn replace_restore_progress(
    state: &CoreState,
    window_ids: Vec<String>,
) -> Result<(), CoreErrorPayload> {
    state
        .core
        .update_runtime_restore_session(|session| {
            session.schema_version = 2;
            session.updated_at = chrono::Utc::now().to_rfc3339();
            session.clean_exit = false;
            session.restore_in_progress_window_ids = window_ids;
            session.windows.clear();
        })
        .map(|_| ())
        .map_err(error_payload)
}

fn discard_saved_game_windows(
    state: &CoreState,
    args: &[Value],
) -> Result<Value, CoreErrorPayload> {
    let input = args
        .first()
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "all" }));
    let scope = input["scope"].as_str().ok_or_else(|| {
        shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window discard scope is invalid.",
        )
    })?;
    if !matches!(scope, "all" | "window") {
        return Err(shell_error(
            "TAURI_SHELL_INPUT_INVALID",
            "Saved Game Window discard scope is invalid.",
        ));
    }
    let requested_window_id = if scope == "window" {
        Some(input["windowId"].as_str().ok_or_else(|| {
            shell_error(
                "TAURI_SHELL_INPUT_INVALID",
                "Saved Game Window ID is required.",
            )
        })?)
    } else {
        None
    };
    // Discarding crash recovery retires only the previous runtime session.
    // Permanent Game Window definitions remain reusable; clearing their tabs
    // here made a recovery choice indistinguishable from deleting saved state.
    replace_restore_progress(state, Vec::new())?;
    let requested_window_ids = requested_window_id
        .map(|window_id| HashSet::from([window_id.to_owned()]));
    let discarded_window_ids = state
        .runtime
        .discard_dormant_window_recovery(requested_window_ids.as_ref());
    state
        .runtime
        .persist_restore_session(false)
        .map_err(|error| shell_error("TAURI_RESTORE_PERSIST_FAILED", error))?;
    Ok(json!({
        "discardedWindowIds": discarded_window_ids
    }))
}

fn string_argument(args: &[Value], index: usize, label: &str) -> Result<String, CoreErrorPayload> {
    args.get(index)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| shell_error("TAURI_SHELL_INPUT_INVALID", format!("{label} is required.")))
}

pub(crate) fn new_game_window_launch_target(
    state: &CoreState,
    main_window: &WebviewWindow,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    game_window_launch_target_internal(state, main_window)
}

fn game_window_launch_target_internal(
    state: &CoreState,
    main_window: &WebviewWindow,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let game_windows = state
        .core
        .invoke(CoreCommand::GameWindowsList)
        .map_err(error_payload)
        .and_then(|value| {
            serde_json::from_value::<Vec<StateGameWindowRecord>>(value)
                .map_err(|error| shell_error("SHELL_GAME_WINDOW_INVALID", error.to_string()))
        })?;
    let mut target = default_display_launch_target(main_window, None)?;
    let display_id = target.display_id;
    let work_area = target.work_area.clone();
    let existing_on_display = game_windows
        .iter()
        .filter(|window| window.target_display.id == display_id)
        .count() as i32;
    let width = if work_area.width >= 960 {
        ((work_area.width as f64 * 0.8).round() as i32).max(960)
    } else {
        work_area.width
    }
    .min(work_area.width)
    .max(640.min(work_area.width));
    let height = if work_area.height >= 640 {
        ((work_area.height as f64 * 0.8).round() as i32).max(640)
    } else {
        work_area.height
    }
    .min(work_area.height)
    .max(480.min(work_area.height));
    let cascade = (existing_on_display * 24).min(240);
    let max_x = work_area.x + (work_area.width - width).max(0);
    let max_y = work_area.y + (work_area.height - height).max(0);
    let x = (work_area.x + (work_area.width - width) / 2 + cascade).min(max_x);
    let y = (work_area.y + (work_area.height - height) / 2 + cascade).min(max_y);
    target.bounds = StatePixelBoundsRecord {
        x,
        y,
        width,
        height,
    };
    Ok(target)
}

fn default_display_launch_target(
    window: &WebviewWindow,
    requested_display_id: Option<i64>,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let monitors = window
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let monitor = if let Some(display_id) = requested_display_id {
        monitors
            .iter()
            .find(|monitor| monitor_id(monitor) == display_id)
            .cloned()
    } else {
        window
            .current_monitor()
            .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?
            .or_else(|| window.primary_monitor().ok().flatten())
            .or_else(|| monitors.first().cloned())
    }
    .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    Ok(EmbeddedLaunchTargetRecord {
        window_id: uuid::Uuid::new_v4().to_string(),
        persisted_name: None,
        display_id: monitor_id(&monitor),
        scale_factor,
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        bounds: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        presentation: "normal".to_owned(),
    })
}

fn embedded_target_for_monitor(monitor: &tauri::Monitor) -> EmbeddedLaunchTargetRecord {
    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    EmbeddedLaunchTargetRecord {
        window_id: uuid::Uuid::new_v4().to_string(),
        persisted_name: None,
        display_id: monitor_id(monitor),
        scale_factor,
        work_area: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        bounds: StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale_factor).round() as i32,
            y: (work_area.position.y as f64 / scale_factor).round() as i32,
            width: (work_area.size.width as f64 / scale_factor).round() as i32,
            height: (work_area.size.height as f64 / scale_factor).round() as i32,
        },
        presentation: "normal".to_owned(),
    }
}

pub(crate) fn launch_target_for_game_window(
    app: &AppHandle,
    window_id: &str,
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let state = app
        .try_state::<CoreState>()
        .ok_or_else(|| shell_error("SHELL_STATE_UNAVAILABLE", "App state is unavailable."))?;
    let record = game_window_record(&state.core, window_id)?;
    let resolution = resolve_game_window_launch_target(app, &record)?;
    if let Some(remap) = resolution.remap {
        persist_game_window_display_remap(
            app,
            &state,
            window_id,
            resolution.target.display_id,
            remap,
        )?;
    }
    Ok(resolution.target)
}

struct GameWindowLaunchResolution {
    target: EmbeddedLaunchTargetRecord,
    remap: Option<GameWindowUpdateInputRecord>,
}

fn resolve_game_window_launch_target(
    app: &AppHandle,
    record: &StateGameWindowRecord,
) -> Result<GameWindowLaunchResolution, CoreErrorPayload> {
    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary_monitor = app
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let current_monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten());
    resolve_game_window_launch_target_from_inventory(
        record,
        &monitors,
        primary_monitor.as_ref(),
        current_monitor.as_ref(),
    )
}

fn resolve_game_window_launch_target_from_inventory(
    record: &StateGameWindowRecord,
    monitors: &[tauri::Monitor],
    primary_monitor: Option<&tauri::Monitor>,
    current_monitor: Option<&tauri::Monitor>,
) -> Result<GameWindowLaunchResolution, CoreErrorPayload> {
    let primary_id = primary_monitor.map(monitor_id);
    let exact = monitors.iter().find(|monitor| {
        monitor_id(monitor) == record.target_display.id
            && record
                .target_display
                .fingerprint
                .as_ref()
                .is_none_or(|saved| {
                    display_fingerprint_matches(
                        saved,
                        &display_target_and_work_area(monitor, primary_id)
                            .0
                            .fingerprint
                            .expect("native monitor targets include fingerprints"),
                    )
                })
    });
    let selected = exact
        .cloned()
        .or_else(|| {
            record
                .target_display
                .fingerprint
                .as_ref()
                .and_then(|saved| {
                    monitors
                        .iter()
                        .max_by_key(|monitor| {
                            let current = display_target_and_work_area(monitor, primary_id)
                                .0
                                .fingerprint
                                .expect("native monitor targets include fingerprints");
                            display_fingerprint_score(saved, &current)
                        })
                        .cloned()
                })
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| primary_id == Some(monitor_id(monitor)))
                .cloned()
        })
        .or_else(|| primary_monitor.cloned())
        .or_else(|| current_monitor.cloned())
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let remapped = exact.is_none();
    let mut target = embedded_target_for_monitor(&selected);
    target.window_id = record.id.clone();
    target.persisted_name = Some(record.name.clone());
    target.presentation = record.placement.presentation.clone();
    let remap = if remapped {
        target.bounds = remap_window_bounds(
            &record.placement.normal_bounds,
            &record.placement.saved_work_area,
            &target.work_area,
        );
        Some(GameWindowUpdateInputRecord {
            target_display: Some(DisplayTargetRecord {
                id: target.display_id,
                fingerprint: display_target_and_work_area(&selected, primary_id)
                    .0
                    .fingerprint,
            }),
            placement: Some(GameWindowPlacementRecord {
                normal_bounds: target.bounds.clone(),
                saved_work_area: target.work_area.clone(),
                presentation: target.presentation.clone(),
            }),
            ..GameWindowUpdateInputRecord::default()
        })
    } else {
        target.bounds = clamp_window_bounds(&record.placement.normal_bounds, &target.work_area);
        None
    };
    Ok(GameWindowLaunchResolution { target, remap })
}

fn persist_game_window_display_remap(
    app: &AppHandle,
    state: &CoreState,
    window_id: &str,
    display_id: i64,
    input: GameWindowUpdateInputRecord,
) -> Result<(), CoreErrorPayload> {
    state
        .core
        .invoke(CoreCommand::GameWindowUpdate {
            id: window_id.to_owned(),
            input,
        })
        .map_err(error_payload)?;
    let _ = app.emit(
        "rion://game-window-display-remapped",
        json!({ "windowId": window_id, "displayId": display_id }),
    );
    Ok(())
}

fn display_fingerprint_matches(
    saved: &DisplayFingerprintRecord,
    current: &DisplayFingerprintRecord,
) -> bool {
    saved.label == current.label
        && saved.bounds.x == current.bounds.x
        && saved.bounds.y == current.bounds.y
        && saved.bounds.width == current.bounds.width
        && saved.bounds.height == current.bounds.height
        && saved.resolution.width == current.resolution.width
        && saved.resolution.height == current.resolution.height
        && (saved.scale_factor - current.scale_factor).abs() < 0.001
        && saved.is_primary == current.is_primary
        && saved.is_internal == current.is_internal
}

fn display_fingerprint_score(
    saved: &DisplayFingerprintRecord,
    current: &DisplayFingerprintRecord,
) -> u16 {
    u16::from(saved.is_internal == current.is_internal) * 100
        + u16::from(saved.is_primary == current.is_primary) * 80
        + u16::from(
            saved.resolution.width == current.resolution.width
                && saved.resolution.height == current.resolution.height,
        ) * 60
        + u16::from((saved.scale_factor - current.scale_factor).abs() < 0.001) * 30
        + u16::from(saved.label == current.label) * 20
        + u16::from(
            saved.bounds.width == current.bounds.width
                && saved.bounds.height == current.bounds.height,
        ) * 10
}
