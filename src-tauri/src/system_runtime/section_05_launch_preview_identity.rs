fn launch_source_key(tab_type: &str, source_id: &str) -> String {
    format!("{tab_type}:{source_id}")
}

fn launch_preview_handle(provisional: &ProvisionalLaunch) -> LaunchPreviewHandle {
    LaunchPreviewHandle {
        launch_preview_id: provisional.launch_preview_id.clone(),
        provisional_tab_id: provisional.id.clone(),
        source_key: launch_source_key(&provisional.tab_type, &provisional.source_id),
    }
}

fn launch_completion_phase(failed: bool) -> TabRuntimePhase {
    if failed {
        TabRuntimePhase::Failed
    } else {
        TabRuntimePhase::Reserved
    }
}

fn settle_provisional_launch_completion(
    state: &mut RuntimeState,
    launch_preview_id: Option<&str>,
    failed: bool,
) -> Option<(LaunchPreviewHandle, ProvisionalLaunch, TabRuntimePhase)> {
    let provisional = state
        .provisional_launches
        .get_mut(launch_preview_id?)?;
    if provisional.cancelled {
        return None;
    }
    provisional.failed = failed;
    Some((
        launch_preview_handle(provisional),
        provisional.clone(),
        launch_completion_phase(failed),
    ))
}

fn insert_provisional_launch(state: &mut RuntimeState, provisional: ProvisionalLaunch) {
    let launch_preview_id = provisional.launch_preview_id.clone();
    let source_key = launch_source_key(&provisional.tab_type, &provisional.source_id);
    let source_has_newer_attempt = state
        .active_provisional_launches
        .get(&source_key)
        .and_then(|active| state.provisional_launches.get(active))
        .is_some_and(|active| !active.cancelled && active.launch_preview_id != launch_preview_id);
    if !source_has_newer_attempt {
        state
            .active_provisional_launches
            .insert(source_key, launch_preview_id.clone());
    }
    state
        .provisional_launches
        .insert(launch_preview_id, provisional);
}

fn clear_active_provisional_launch(
    state: &mut RuntimeState,
    source_key: &str,
    launch_preview_id: &str,
) {
    if state
        .active_provisional_launches
        .get(source_key)
        .is_some_and(|active| active == launch_preview_id)
    {
        state.active_provisional_launches.remove(source_key);
    }
}

fn active_provisional_launch<'a>(
    state: &'a RuntimeState,
    source_id: &str,
    tab_type: &str,
) -> Option<&'a ProvisionalLaunch> {
    let launch_preview_id = state
        .active_provisional_launches
        .get(&launch_source_key(tab_type, source_id))?;
    state
        .provisional_launches
        .get(launch_preview_id)
        .filter(|launch| !launch.cancelled)
}

fn cancel_provisional_launch_state(
    state: &mut RuntimeState,
    tab_id: &str,
) -> Option<ProvisionalLaunch> {
    let launch_preview_id = state
        .provisional_launches
        .iter()
        .find_map(|(launch_preview_id, launch)| {
            (launch.id == tab_id && !launch.cancelled).then(|| launch_preview_id.clone())
        })?;
    let provisional = state.provisional_launches.get_mut(&launch_preview_id)?;
    provisional.cancelled = true;
    let provisional = provisional.clone();
    let source_key = launch_source_key(&provisional.tab_type, &provisional.source_id);
    clear_active_provisional_launch(state, &source_key, &launch_preview_id);
    state.automatic_launch_retries.remove(&launch_preview_id);
    Some(provisional)
}

fn take_provisional_launch_attempt(
    state: &mut RuntimeState,
    launch_preview_id: &str,
    window_id: &str,
    source_id: &str,
    tab_type: &str,
) -> RuntimeResult<ProvisionalLaunch> {
    let provisional = state
        .provisional_launches
        .get(launch_preview_id)
        .cloned()
        .ok_or_else(|| {
            RuntimeError::new(
                "LAUNCH_PREVIEW_STALE",
                "The launch effect no longer owns a provisional runtime tab.",
            )
        })?;
    if provisional.window_id != window_id
        || provisional.source_id != source_id
        || provisional.tab_type != tab_type
    {
        return Err(RuntimeError::new(
            "LAUNCH_PREVIEW_STALE",
            "The launch effect does not match its provisional runtime tab.",
        ));
    }
    state.provisional_launches.remove(launch_preview_id);
    let source_key = launch_source_key(tab_type, source_id);
    clear_active_provisional_launch(state, &source_key, launch_preview_id);
    if provisional.cancelled {
        return Err(RuntimeError::new(
            "LAUNCH_CANCELLED",
            "The provisional runtime tab was closed before native attachment began.",
        ));
    }
    Ok(provisional)
}

fn renew_provisional_launch(
    state: &mut RuntimeState,
    launch_preview_id: &str,
    require_failed: bool,
) -> Option<LaunchPreviewHandle> {
    let mut provisional = state.provisional_launches.remove(launch_preview_id)?;
    if provisional.cancelled || (require_failed && !provisional.failed) {
        state
            .provisional_launches
            .insert(launch_preview_id.to_owned(), provisional);
        return None;
    }
    let source_key = launch_source_key(&provisional.tab_type, &provisional.source_id);
    clear_active_provisional_launch(state, &source_key, launch_preview_id);
    state.automatic_launch_retries.remove(launch_preview_id);
    provisional.cancelled = false;
    provisional.failed = false;
    provisional.launch_preview_id = uuid::Uuid::new_v4().to_string();
    let handle = launch_preview_handle(&provisional);
    insert_provisional_launch(state, provisional);
    Some(handle)
}

fn renew_failed_provisional_launch(
    state: &mut RuntimeState,
    launch_preview_id: &str,
) -> Option<LaunchPreviewHandle> {
    renew_provisional_launch(state, launch_preview_id, true)
}

fn automatic_launch_retry_is_current(state: &RuntimeState, launch_preview_id: &str) -> bool {
    state
        .automatic_launch_retries
        .get(launch_preview_id)
        .copied()
        == Some(1)
        && state
            .provisional_launches
            .get(launch_preview_id)
            .is_some_and(|launch| !launch.cancelled)
}
