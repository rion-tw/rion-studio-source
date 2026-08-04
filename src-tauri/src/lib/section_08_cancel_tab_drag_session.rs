async fn finish_deferred_tab_drag_session(
    app: &AppHandle,
    state: &CoreState,
    session_id: &str,
) -> Result<Value, CoreErrorPayload> {
    if let Some(terminal) = tab_drag_terminal(state, session_id)? {
        return serialize_tab_drag_response(&terminal.receipt);
    }
    let Some(mut session) = take_tab_drag_session(state, session_id)? else {
        return active_tab_drag_response(app, state, session_id);
    };
    if session.source_cancelled {
        record_tab_drag_lifecycle(
            state,
            &session,
            "tab.drag-cancelled",
            "The deferred native tab drag ended without applying topology changes.",
        );
        return finish_cancelled_tab_drag(app, state, session);
    }
    if session.source_drop_accepted && session.drop_window_id.is_none() {
        return finish_failed_tab_drag_session(
            app,
            state,
            &mut session,
            shell_error(
                "TAURI_TAB_DRAG_STALE",
                "The accepted drop target did not report its destination.",
            ),
        );
    }
    session.phase = GameWindowTabDragPhase::Finishing;
    if let Some(error) = tab_drag_fence_error(state, &session) {
        return finish_failed_tab_drag_session(app, state, &mut session, error);
    }
    record_tab_drag_lifecycle(
        state,
        &session,
        "tab.drag-terminal-frozen",
        "The latest native drag destination was frozen before durable topology commit.",
    );
    if !state
        .runtime
        .mark_tab_drag_native_submitted(&session.operation_id)
    {
        return finish_failed_tab_drag_session(
            app,
            state,
            &mut session,
            shell_error(
                "SYSTEM_TAB_DRAG_OPERATION_EXPIRED",
                "The tab drag expired before its native commit started.",
            ),
        );
    }
    record_tab_drag_lifecycle(
        state,
        &session,
        "tab.drag-native-commit-started",
        "The native drag ended; tab topology commit is starting.",
    );
    if let Err(error) = apply_deferred_tab_drag_destination(app, state, &mut session) {
        record_tab_drag_lifecycle(
            state,
            &session,
            "tab.drag-native-commit-failed",
            "The deferred native tab topology commit failed and rollback was requested.",
        );
        return finish_failed_tab_drag_session(app, state, &mut session, error);
    }
    finish_visible_tab_drag_and_schedule_projection(app, state, &session)
}

fn record_tab_drag_lifecycle(
    state: &CoreState,
    session: &GameWindowTabDragSession,
    event: &'static str,
    message: &'static str,
) {
    let core = Arc::clone(&state.core);
    let context_raw_json = serde_json::to_string(&json!({
        "dropAccepted": session.source_drop_accepted,
        "beforeTabId": session.drop_before_tab_id,
        "orderedTabIds": session.drop_ordered_tab_ids,
        "eventSequence": session.last_event_sequence,
        "frozenSourceTabOrder": session.snapshots.get(&session.source_window_id).map(|snapshot| &snapshot.tab_ids),
        "frozenTargetTabOrder": session.drop_window_id.as_ref().and_then(|window_id| session.snapshots.get(window_id)).map(|snapshot| &snapshot.tab_ids),
        "intentGeneration": session.intent_generation,
        "hoverWindowId": session.hover_window_id,
        "nativeChangesApplied": session.native_changes_applied,
        "projectionRevision": session.topology_revision,
        "sessionId": session.id,
        "singleTab": session.single_tab,
        "sourceWindowId": session.source_window_id,
        "tabId": session.tab_id,
        "targetWindowId": session.drop_window_id,
    }))
    .ok();
    tauri::async_runtime::spawn(async move {
        let _ = core
            .invoke_async(CoreCommand::LogsCapture {
                entries: vec![LogCaptureRecord {
                    level: LogLevel::Debug,
                    source: LogSource::Browser,
                    event: event.to_owned(),
                    message: message.to_owned(),
                    context_raw_json,
                    error: None,
                }],
            })
            .await;
    });
}

fn apply_deferred_tab_drag_destination(
    app: &AppHandle,
    state: &CoreState,
    session: &mut GameWindowTabDragSession,
) -> Result<(), CoreErrorPayload> {
    session.native_changes_applied = true;
    if let Some(target_window_id) = session.drop_window_id.clone() {
        let before_tab_id = session.drop_before_tab_id.clone();
        let ordered_tab_ids = session.drop_ordered_tab_ids.clone().ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                "Drop topology order was not frozen before native commit.",
            )
        })?;
        state
            .runtime
            .commit_live_tab_drag_destination(
                &session.source_window_id,
                &target_window_id,
                &session.tab_id,
                &ordered_tab_ids,
            )
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        let materialized = attach_tab_drag_session(
            state,
            session,
            &target_window_id,
            before_tab_id.as_deref(),
            Some(&ordered_tab_ids),
        );
        if let Err(error) = materialized {
            eprintln!(
                "Committed tab drag surface will retry in place: tab={} target={} error={}",
                session.tab_id, target_window_id, error.message
            );
            state.runtime.schedule_tab_surface_move_retry(
                session.tab_id.clone(),
                target_window_id.clone(),
            );
            session.current_window_id = target_window_id;
            session.phase = GameWindowTabDragPhase::Attached;
        }
        return Ok(());
    }

    if session.single_tab {
        state
            .runtime
            .begin_tab_drag_window_motion(&session.source_window_id);
    } else {
        let anchor = session.window_anchor.unwrap_or((
            session.tab_width * session.grab_ratio_x,
            session.tab_height * session.grab_ratio_y,
        ));
        let target = tab_drag_target_for_screen(
            app,
            &session.original_target,
            &session.provisional_window_id,
            session.latest_screen_x,
            session.latest_screen_y,
            anchor,
        )?;
        session.target = target.clone();
        state
            .runtime
            .prepare_provisional_game_window(&target, &session.title)
            .and_then(|_| state.runtime.position_provisional_game_window(&target))
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
        state
            .runtime
            .commit_live_tab_drag_destination(
                &session.source_window_id,
                &session.provisional_window_id,
                &session.tab_id,
                std::slice::from_ref(&session.tab_id),
            )
            .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    }
    let materialized = float_tab_drag_session(
        app,
        state,
        session,
        session.latest_screen_x,
        session.latest_screen_y,
    );
    if let Err(error) = materialized {
        if session.single_tab {
            return Err(error);
        }
        eprintln!(
            "Committed detached tab surface will retry in place: tab={} target={} error={}",
            session.tab_id, session.provisional_window_id, error.message
        );
        state.runtime.schedule_tab_surface_move_retry(
            session.tab_id.clone(),
            session.provisional_window_id.clone(),
        );
        let _ = state
            .runtime
            .show_tab_drag_window(&session.provisional_window_id);
        session.current_window_id = session.provisional_window_id.clone();
        session.phase = GameWindowTabDragPhase::Floating;
    }
    Ok(())
}

fn schedule_windows_tab_drag_intent_timeout(app: &AppHandle, session_id: &str) {
    let app = app.clone();
    let session_id = session_id.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let state = app.state::<CoreState>();
        let _lane = state.tab_drag_lane.lock().await;
        let timed_out = state
            .tab_drag
            .lock()
            .ok()
            .and_then(|current| current.as_ref().cloned())
            .is_some_and(|session| {
                session.id == session_id
                    && session.source_end_received
                    && session.source_drop_accepted
                    && session.drop_window_id.is_none()
            });
        if !timed_out {
            return;
        }
        eprintln!(
            "Runtime tab drag {session_id} cancelled because its accepted WebView2 drop intent was not delivered."
        );
        let _ = finish_failed_tab_drag(
            &app,
            &state,
            &session_id,
            shell_error(
                "TAURI_TAB_DRAG_STALE",
                "The accepted WebView2 drop intent was not delivered before its deadline.",
            ),
        );
    });
}

fn cancel_tab_drag_session(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<(), TabDragRollbackFailure> {
    if !session.native_changes_applied {
        return Ok(());
    }
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
    release_tab_drag_window_motion_suppression(state, session, None);
    if session.hover_window_id.is_some()
        && let Err(message) = state
            .runtime
            .show_tab_drag_window(&session.source_window_id)
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
        let error_count = errors.len();
        Err(TabDragRollbackFailure {
            error: shell_error("TAURI_TAB_DRAG_ROLLBACK_FAILED", errors.join("; ")),
            error_count,
        })
    }
}

fn release_tab_drag_window_motion_suppression(
    state: &CoreState,
    session: &GameWindowTabDragSession,
    persist_window_id: Option<&str>,
) {
    let mut window_ids = session.snapshots.keys().cloned().collect::<HashSet<_>>();
    window_ids.insert(session.source_window_id.clone());
    window_ids.insert(session.provisional_window_id.clone());
    window_ids.insert(session.current_window_id.clone());
    for window_id in window_ids {
        if let Err(message) = state
            .runtime
            .release_tab_drag_cursor_lease(&window_id, &session.id)
        {
            eprintln!(
                "Runtime tab drag cursor lease could not be released: window={window_id} error={message}"
            );
        }
        if let Err(message) = state.runtime.finish_tab_drag_window_motion(
            &window_id,
            persist_window_id == Some(window_id.as_str()),
        ) {
            eprintln!(
                "Runtime tab drag placement suppression could not be released: window={window_id} error={message}"
            );
        }
    }
}

fn tab_drag_mutation_request(
    session: &GameWindowTabDragSession,
    mutation_kind: &str,
    final_snapshot: &RuntimeTabDragWindowSnapshot,
    target_window_id: Option<&str>,
    expected_tab_order: &[String],
) -> RuntimeTabMutationRequestRecord {
    RuntimeTabMutationRequestRecord {
        operation_id: session.operation_id.clone(),
        mutation_kind: mutation_kind.to_owned(),
        tab_id: session.tab_id.clone(),
        source_window_id: session.source_window_id.clone(),
        source_window_generation: session.source_window_generation,
        target_window_id: target_window_id.map(str::to_owned),
        target_window_generation: target_window_id.map(|_| final_snapshot.generation),
        lifecycle_epoch: session.lifecycle_epoch,
        topology_revision: session.topology_revision,
        presentation_revision: session.latest_move_revision,
        reorder_target_index: None,
        expected_tab_order: expected_tab_order.to_vec(),
        expected_active_tab_id: final_snapshot.active_tab_id.clone(),
    }
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
) -> Result<RuntimeTabMoveResultRecord, CoreErrorPayload> {
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
    let receipt =
        execute_tab_mutation(state, "moveToNewWindow", tab_id, Some(target), None).await?;
    Ok(RuntimeTabMoveResultRecord {
        target_window_id: window_id,
        receipt,
    })
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
