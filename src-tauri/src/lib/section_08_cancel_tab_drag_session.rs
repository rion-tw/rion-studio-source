fn cancel_tab_drag_session(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    let mut errors = Vec::new();
    if session.single_tab {
        if state.runtime.tab_window_id(&session.tab_id).as_deref()
            != Some(session.source_window_id.as_str())
            && let Err(message) = state
                .runtime
                .provisionally_move_tab(&session.tab_id, &session.source_window_id)
        {
            errors.push(message);
        }
    } else if let Err(message) = state.runtime.cancel_provisional_tab_move(
        &session.tab_id,
        &session.source_window_id,
        &session.provisional_window_id,
    ) {
        errors.push(message);
    }
    for snapshot in session.snapshots.values() {
        if let Err(message) = state.runtime.restore_tab_drag_window_snapshot(snapshot) {
            errors.push(message);
        }
    }
    if session.single_tab
        && let Err(message) = state
            .runtime
            .relocate_game_window(session.original_target.clone())
    {
        errors.push(message);
    }
    if session.single_tab
        && let Err(message) = state
            .runtime
            .finish_tab_drag_window_motion(&session.source_window_id, false)
    {
        errors.push(message);
    }
    if let Err(message) = state
        .runtime
        .make_provisional_game_window_interactive(&session.source_window_id)
    {
        errors.push(message);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(shell_error(
            "TAURI_TAB_DRAG_ROLLBACK_FAILED",
            errors.join("; "),
        ))
    }
}

async fn commit_tab_drag_session(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    let final_window_id = state
        .runtime
        .tab_window_id(&session.tab_id)
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_FAILED", "Dragged tab was not found."))?;
    let final_snapshot = state
        .runtime
        .tab_drag_window_snapshot(&final_window_id)
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    let before_tab_id = tab_drag_before_tab_id(&final_snapshot.tab_ids, &session.tab_id);
    if final_window_id == session.source_window_id {
        let original_order = session
            .snapshots
            .get(&session.source_window_id)
            .map(|snapshot| snapshot.tab_ids.as_slice())
            .unwrap_or_default();
        if tab_drag_order_changed(original_order, &final_snapshot.tab_ids) {
            Arc::clone(&state.core)
                .invoke_async(CoreCommand::EmbeddedTabReorder {
                    tab_id: session.tab_id.clone(),
                    before_tab_id,
                })
                .await
                .map_err(error_payload)?;
        }
    } else if final_window_id == session.provisional_window_id && !session.single_tab {
        Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedTabMoveOrdered {
                tab_id: session.tab_id.clone(),
                target: session.target.clone(),
                before_tab_id: None,
            })
            .await
            .map_err(error_payload)?;
    } else {
        let target = state
            .runtime
            .launch_target_for_window_id(&final_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_INVALID", message))?;
        Arc::clone(&state.core)
            .invoke_async(CoreCommand::EmbeddedTabMoveOrdered {
                tab_id: session.tab_id.clone(),
                target,
                before_tab_id,
            })
            .await
            .map_err(error_payload)?;
    }
    if session.single_tab {
        state
            .runtime
            .finish_tab_drag_window_motion(
                &session.source_window_id,
                final_window_id == session.source_window_id && session.window_was_moved,
            )
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    if !session.single_tab && final_window_id != session.provisional_window_id {
        state
            .runtime
            .discard_provisional_game_window(&session.provisional_window_id);
    } else if session.single_tab && final_window_id != session.source_window_id {
        state
            .runtime
            .discard_provisional_game_window(&session.source_window_id);
    }
    if let Err(message) = state
        .runtime
        .make_provisional_game_window_interactive(&final_window_id)
    {
        eprintln!("Runtime tab drag committed but focus restoration failed: {message}");
    }
    Ok(())
}

fn tab_drag_before_tab_id(tab_ids: &[String], tab_id: &str) -> Option<String> {
    tab_ids
        .iter()
        .position(|candidate| candidate == tab_id)
        .and_then(|index| tab_ids.get(index + 1))
        .cloned()
}

fn tab_drag_order_changed(original: &[String], current: &[String]) -> bool {
    original != current
}

fn tab_drag_target_for_screen(
    app: &AppHandle,
    source: &EmbeddedLaunchTargetRecord,
    provisional_window_id: &str,
    screen_x: f64,
    screen_y: f64,
    anchor: (f64, f64),
) -> Result<EmbeddedLaunchTargetRecord, CoreErrorPayload> {
    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let primary = app
        .primary_monitor()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let monitor = monitor_near_screen_point(&monitors, screen_x, screen_y)
        .or(primary)
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let (_, work_area) = display_target_and_work_area(&monitor, None);
    let (screen_x, screen_y) =
        logical_tab_drag_screen_point(screen_x, screen_y, monitor.scale_factor(), cfg!(windows));
    let bounds = anchored_tab_drag_bounds(&source.bounds, screen_x, screen_y, anchor);
    Ok(EmbeddedLaunchTargetRecord {
        window_id: provisional_window_id.to_owned(),
        display_id: monitor_id(&monitor),
        scale_factor: monitor.scale_factor().max(f64::EPSILON),
        work_area,
        bounds,
        presentation: "normal".to_owned(),
    })
}

fn logical_tab_drag_screen_point(
    screen_x: f64,
    screen_y: f64,
    scale_factor: f64,
    physical_coordinates: bool,
) -> (f64, f64) {
    if physical_coordinates {
        let scale = scale_factor.max(f64::EPSILON);
        (screen_x / scale, screen_y / scale)
    } else {
        (screen_x, screen_y)
    }
}

fn anchored_tab_drag_bounds(
    source: &StatePixelBoundsRecord,
    screen_x: f64,
    screen_y: f64,
    anchor: (f64, f64),
) -> StatePixelBoundsRecord {
    StatePixelBoundsRecord {
        x: (screen_x - anchor.0).round() as i32,
        y: (screen_y - anchor.1).round() as i32,
        width: source.width,
        height: source.height,
    }
}

pub(crate) async fn move_game_window_tab_to_new_window(
    app: &AppHandle,
    state: &CoreState,
    tab_id: &str,
    screen_point: Option<(f64, f64)>,
) -> Result<Value, CoreErrorPayload> {
    let runtime = state
        .core
        .invoke(CoreCommand::BrowserRuntimeSnapshot)
        .map_err(error_payload)?;
    let source_window_id = runtime["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["id"].as_str() == Some(tab_id)))
        .and_then(|tab| tab["windowId"].as_str())
        .ok_or_else(|| shell_error("TAURI_RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found."))?;
    let source = state
        .runtime
        .launch_target_for_window_id(source_window_id)
        .map_err(|message| shell_error("TAURI_RUNTIME_WINDOW_NOT_FOUND", message))?;

    let monitors = app
        .available_monitors()
        .map_err(|error| shell_error("SHELL_DISPLAY_FAILED", error.to_string()))?;
    let monitor = screen_point
        .and_then(|(x, y)| monitor_near_screen_point(&monitors, x, y))
        .or_else(|| {
            monitors
                .iter()
                .find(|monitor| monitor_id(monitor) == source.display_id)
                .cloned()
        })
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| shell_error("SHELL_DISPLAY_NOT_FOUND", "Display was not found."))?;
    let (_, work_area) = display_target_and_work_area(&monitor, None);
    let mut bounds = source.bounds.clone();
    if let Some((x, y)) = screen_point {
        bounds.x = (x - f64::from(bounds.width) / 2.0).round() as i32;
        bounds.y = (y - 28.0).round() as i32;
    } else {
        bounds.x = bounds.x.saturating_add(24);
        bounds.y = bounds.y.saturating_add(24);
    }
    bounds = clamp_window_bounds(&bounds, &work_area);

    let window_id = uuid::Uuid::new_v4().to_string();
    let target = EmbeddedLaunchTargetRecord {
        window_id: window_id.clone(),
        display_id: monitor_id(&monitor),
        scale_factor: monitor.scale_factor().max(f64::EPSILON),
        work_area: work_area.clone(),
        bounds: bounds.clone(),
        presentation: "normal".to_owned(),
    };
    Arc::clone(&state.core)
        .invoke_async(CoreCommand::EmbeddedTabMoveOrdered {
            tab_id: tab_id.to_owned(),
            target,
            before_tab_id: None,
        })
        .await
        .map_err(error_payload)?;
    Ok(json!({ "windowId": window_id }))
}

fn next_game_window_name(windows: &[StateGameWindowRecord], language: &str) -> String {
    let stem = match language {
        "zh-TW" => "遊戲視窗",
        "zh-CN" => "游戏窗口",
        "ja" => "ゲームウィンドウ",
        _ => "Game Window",
    };
    let existing = windows
        .iter()
        .map(|window| window.name.to_lowercase())
        .collect::<HashSet<_>>();
    (1..)
        .map(|number| format!("{stem} {number}"))
        .find(|candidate| !existing.contains(&candidate.to_lowercase()))
        .expect("a finite Game Window collection always has a free numeric name")
}

fn monitor_near_screen_point(
    monitors: &[tauri::Monitor],
    x: f64,
    y: f64,
) -> Option<tauri::Monitor> {
    let drag_rect = |monitor: &tauri::Monitor| {
        let scale = if cfg!(windows) {
            1.0
        } else {
            monitor.scale_factor()
        };
        let position = monitor.position();
        let size = monitor.size();
        (
            position.x as f64 / scale,
            position.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        )
    };
    let rects = monitors.iter().map(drag_rect).collect::<Vec<_>>();
    nearest_drag_rect_index(&rects, x, y).map(|index| monitors[index].clone())
}

fn nearest_drag_rect_index(rects: &[(f64, f64, f64, f64)], x: f64, y: f64) -> Option<usize> {
    rects
        .iter()
        .position(|(left, top, width, height)| {
            x >= *left && x < left + width && y >= *top && y < top + height
        })
        .or_else(|| {
            rects
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    let distance = |(left, top, width, height): &(f64, f64, f64, f64)| {
                        (x - (left + width / 2.0)).powi(2) + (y - (top + height / 2.0)).powi(2)
                    };
                    distance(left).total_cmp(&distance(right))
                })
                .map(|(index, _)| index)
        })
}

fn display_target_and_work_area(
    monitor: &tauri::Monitor,
    primary_id: Option<i64>,
) -> (DisplayTargetRecord, StatePixelBoundsRecord) {
    let id = monitor_id(monitor);
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    let work_area = monitor.work_area();
    (
        DisplayTargetRecord {
            id,
            fingerprint: Some(DisplayFingerprintRecord {
                label: monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("Display {id}")),
                bounds: StatePixelBoundsRecord {
                    x: (position.x as f64 / scale).round() as i32,
                    y: (position.y as f64 / scale).round() as i32,
                    width: (size.width as f64 / scale).round() as i32,
                    height: (size.height as f64 / scale).round() as i32,
                },
                resolution: StateResolutionRecord {
                    width: size.width,
                    height: size.height,
                },
                scale_factor: scale,
                is_primary: primary_id == Some(id),
                is_internal: false,
            }),
        },
        StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / scale).round() as i32,
            y: (work_area.position.y as f64 / scale).round() as i32,
            width: (work_area.size.width as f64 / scale).round() as i32,
            height: (work_area.size.height as f64 / scale).round() as i32,
        },
    )
}

fn remap_window_bounds(
    bounds: &StatePixelBoundsRecord,
    old_work_area: &StatePixelBoundsRecord,
    new_work_area: &StatePixelBoundsRecord,
) -> StatePixelBoundsRecord {
    if old_work_area.width <= 0 || old_work_area.height <= 0 {
        return clamp_window_bounds(bounds, new_work_area);
    }
    let relative_x = (bounds.x - old_work_area.x) as f64 / old_work_area.width as f64;
    let relative_y = (bounds.y - old_work_area.y) as f64 / old_work_area.height as f64;
    let relative_width = bounds.width as f64 / old_work_area.width as f64;
    let relative_height = bounds.height as f64 / old_work_area.height as f64;
    clamp_window_bounds(
        &StatePixelBoundsRecord {
            x: new_work_area.x + (relative_x * new_work_area.width as f64).round() as i32,
            y: new_work_area.y + (relative_y * new_work_area.height as f64).round() as i32,
            width: (relative_width * new_work_area.width as f64).round() as i32,
            height: (relative_height * new_work_area.height as f64).round() as i32,
        },
        new_work_area,
    )
}

fn clamp_window_bounds(
    bounds: &StatePixelBoundsRecord,
    work_area: &StatePixelBoundsRecord,
) -> StatePixelBoundsRecord {
    let width = bounds
        .width
        .max(640.min(work_area.width))
        .min(work_area.width.max(1));
    let height = bounds
        .height
        .max(480.min(work_area.height))
        .min(work_area.height.max(1));
    let max_x = work_area.x + (work_area.width - width).max(0);
    let max_y = work_area.y + (work_area.height - height).max(0);
    StatePixelBoundsRecord {
        x: bounds.x.clamp(work_area.x, max_x),
        y: bounds.y.clamp(work_area.y, max_y),
        width,
        height,
    }
}
