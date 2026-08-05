struct PreparedTabDragProjection {
    request: RuntimeTabMutationRequestRecord,
    source_after_tab_ids: Vec<String>,
    source_before_tab_ids: Vec<String>,
    target: Option<EmbeddedLaunchTargetRecord>,
    target_after_tab_ids: Vec<String>,
    target_before_tab_ids: Vec<String>,
}

struct QueuedTabDragProjection {
    prepared: PreparedTabDragProjection,
    session: GameWindowTabDragSession,
}

fn prepare_tab_drag_projection(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<Option<PreparedTabDragProjection>, CoreErrorPayload> {
    let final_window_id = session.current_window_id.clone();
    let final_snapshot = state
        .runtime
        .tab_drag_window_snapshot(&final_window_id)
        .map_err(|message| shell_error("TAURI_TAB_DRAG_FAILED", message))?;
    let source_snapshot = session
        .snapshots
        .get(&session.source_window_id)
        .ok_or_else(|| shell_error("TAURI_TAB_DRAG_STALE", "Source drag topology was not frozen."))?;
    let same_window = final_window_id == session.source_window_id;
    let source_before_tab_ids = source_snapshot.tab_ids.clone();
    let source_after_tab_ids = if same_window {
        session
            .drop_ordered_tab_ids
            .clone()
            .unwrap_or_else(|| source_before_tab_ids.clone())
    } else {
        source_before_tab_ids
            .iter()
            .filter(|tab_id| tab_id.as_str() != session.tab_id)
            .cloned()
            .collect()
    };
    let target_before_tab_ids = if same_window {
        source_before_tab_ids.clone()
    } else {
        session
            .snapshots
            .get(&final_window_id)
            .map(|snapshot| snapshot.tab_ids.clone())
            .unwrap_or_default()
    };
    let target_after_tab_ids = if same_window {
        source_after_tab_ids.clone()
    } else if final_window_id == session.provisional_window_id {
        vec![session.tab_id.clone()]
    } else {
        session.drop_ordered_tab_ids.clone().ok_or_else(|| {
            shell_error(
                "TAURI_TAB_DRAG_INVALID",
                "Cross-window drag did not freeze its final tab order.",
            )
        })?
    };
    let mutation = if final_window_id == session.source_window_id {
        if tab_drag_order_changed(&source_before_tab_ids, &source_after_tab_ids) {
            Some((
                tab_drag_mutation_request(
                    session,
                    "reorder",
                    &final_snapshot,
                    None,
                    &target_after_tab_ids,
                ),
                None,
            ))
        } else {
            None
        }
    } else if final_window_id == session.provisional_window_id && !session.single_tab {
        Some((
            tab_drag_mutation_request(
                session,
                "moveToNewWindow",
                &final_snapshot,
                Some(&final_window_id),
                &target_after_tab_ids,
            ),
            Some(session.target.clone()),
        ))
    } else {
        let target = state
            .runtime
            .launch_target_for_window_id(&final_window_id)
            .map_err(|message| shell_error("TAURI_TAB_DRAG_INVALID", message))?;
        Some((
            tab_drag_mutation_request(
                session,
                "move",
                &final_snapshot,
                Some(&final_window_id),
                &target_after_tab_ids,
            ),
            Some(target),
        ))
    };
    Ok(mutation.map(|(request, target)| PreparedTabDragProjection {
        request,
        source_after_tab_ids,
        source_before_tab_ids,
        target,
        target_after_tab_ids,
        target_before_tab_ids,
    }))
}

fn complete_visible_tab_drag(
    state: &CoreState,
    session: &GameWindowTabDragSession,
) {
    let final_window_id = session.current_window_id.as_str();
    let persisted_motion_window = (session.single_tab
        && final_window_id == session.source_window_id
        && session.window_was_moved)
        .then_some(final_window_id);
    release_tab_drag_window_motion_suppression(state, session, persisted_motion_window);
    if let Err(message) = state
        .runtime
        .make_provisional_game_window_interactive(final_window_id)
    {
        // Pointer passthrough and the live destination are already committed.
        // Focus/interactivity repair is diagnostic background work and cannot
        // retain the gesture lane or roll topology back.
        eprintln!(
            "Committed tab drag window interactivity remains pending: window={final_window_id} error={message}"
        );
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
}

fn finish_visible_tab_drag_and_schedule_projection(
    app: &AppHandle,
    state: &CoreState,
    session: &GameWindowTabDragSession,
) -> Result<Value, CoreErrorPayload> {
    let prepared = match prepare_tab_drag_projection(state, session) {
        Ok(prepared) => prepared,
        Err(error) => {
            record_tab_drag_lifecycle(
                state,
                session,
                "tab.drag-core-sink-prepare-failed",
                "The visible drag committed, but its background Core sink input could not be prepared.",
            );
            eprintln!(
                "Runtime tab drag Core sink input could not be prepared: session={} code={} error={}",
                session.id, error.code, error.message
            );
            None
        }
    };
    complete_visible_tab_drag(state, session);
    record_tab_drag_lifecycle(
        state,
        session,
        "tab.drag-visible-committed",
        "The visible tab destination committed and released the gesture lane.",
    );
    let response = finish_applied_tab_drag(
        app,
        state,
        session,
        RuntimeTabMutationProjectionOutcome::Applied,
    )?;
    if let Some(prepared) = prepared {
        schedule_tab_drag_projection(app, session.clone(), prepared);
    }
    Ok(response)
}

fn schedule_tab_drag_projection(
    app: &AppHandle,
    session: GameWindowTabDragSession,
    prepared: PreparedTabDragProjection,
) {
    let state = app.state::<CoreState>();
    let sender = state.tab_drag_projection_queue.get_or_init(|| {
        let (sender, mut receiver) =
            tokio::sync::mpsc::unbounded_channel::<QueuedTabDragProjection>();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(queued) = receiver.recv().await {
                process_tab_drag_projection(&app, queued).await;
            }
        });
        sender
    });
    if sender
        .send(QueuedTabDragProjection { prepared, session })
        .is_err()
    {
        eprintln!("Runtime tab drag background Core sink queue is unavailable.");
    }
}

async fn process_tab_drag_projection(app: &AppHandle, queued: QueuedTabDragProjection) {
    let state = app.state::<CoreState>();
    if queued.session.intent_generation > 0
        && !state.runtime.tab_drag_projection_is_latest(
            &queued.session.id,
            queued.session.intent_generation,
        )
    {
        record_tab_drag_lifecycle(
            &state,
            &queued.session,
            "tab.drag-core-sink-superseded",
            "A newer live gesture superseded this queued Core sink update.",
        );
        return;
    }
    match execute_tab_drag_topology_commit(
        &state,
        queued.prepared.request,
        queued.prepared.target,
        queued.prepared.source_before_tab_ids,
        queued.prepared.source_after_tab_ids,
        queued.prepared.target_before_tab_ids,
        queued.prepared.target_after_tab_ids,
    )
    .await
    {
        Ok(_) => record_tab_drag_lifecycle(
            &state,
            &queued.session,
            "tab.drag-core-sink-committed",
            "The serialized background Core sink accepted the visible tab destination.",
        ),
        Err(error) => {
            record_tab_drag_lifecycle(
                &state,
                &queued.session,
                "tab.drag-core-sink-failed",
                "The visible drag stayed committed while its serialized Core sink failed.",
            );
            eprintln!(
                "Runtime tab drag background Core sink failed: session={} code={} error={}",
                queued.session.id, error.code, error.message
            );
        }
    }
}
