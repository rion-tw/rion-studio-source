fn discard_unstarted_invocation(shared: &Arc<Shared>, control: &Arc<InvocationControl>) {
    if let Ok(mut inner) = shared.inner.lock() {
        inner.invocations.remove(&control.id);
        let prefix = format!("{}|", control.id);
        inner.statuses.retain(|key, _| !key.starts_with(&prefix));
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    if let Ok(mut outcome) = control.outcome.lock() {
        *outcome = Some(Err("macro invocation did not start".to_owned()));
    }
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn detach_owned_children(control: &Arc<InvocationControl>) {
    if let Ok(mut children) = control.children.0.lock() {
        children.ids.clear();
        control.children.1.notify_all();
    }
}

fn cancel_owned_children(shared: &Arc<Shared>, control: &Arc<InvocationControl>) {
    let child_controls = {
        let mut children = match control.children.0.lock() {
            Ok(children) => children,
            Err(_) => return,
        };
        while children.pending_starts > 0 {
            children = match control.children.1.wait(children) {
                Ok(children) => children,
                Err(_) => return,
            };
        }
        let ids = std::mem::take(&mut children.ids);
        let inner = match shared.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        ids.into_iter()
            .filter_map(|id| inner.invocations.get(&id).cloned())
            .collect::<Vec<_>>()
    };
    let _ = cancel_and_wait_all(&child_controls);
}

fn add_running_statuses(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            inner.statuses.insert(
                status_key(&context.control.id, role_id, macro_id),
                MacroRunStatus {
                    role_id: role_id.clone(),
                    macro_id: macro_id.to_owned(),
                    state: "running".to_owned(),
                    iteration: Some(0),
                    last_click: None,
                    started_at: now.clone(),
                    updated_at: now.clone(),
                    error: None,
                },
            );
        }
    }
    emit_statuses(shared, true);
}

fn update_iteration(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    iteration: u32,
) {
    let now = Utc::now().to_rfc3339();
    if let Ok(mut inner) = shared.inner.lock() {
        for role_id in roles {
            if let Some(status) =
                inner
                    .statuses
                    .get_mut(&status_key(&context.control.id, role_id, macro_id))
            {
                status.iteration = Some(iteration);
                status.updated_at = now.clone();
            }
        }
    }
    emit_presentation_statuses(shared);
}

fn mark_click(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    role_id: &str,
    step_id: &str,
) {
    if let Ok(mut inner) = shared.inner.lock()
        && let Some(status) =
            inner
                .statuses
                .get_mut(&status_key(&context.control.id, role_id, macro_id))
    {
        status.last_click = Some(MacroLastClick {
            sequence: status
                .last_click
                .as_ref()
                .map_or(1, |click| click.sequence.saturating_add(1)),
            step_id: step_id.to_owned(),
        });
        status.updated_at = Utc::now().to_rfc3339();
    }
    emit_presentation_statuses(shared);
}

fn remove_macro_statuses(shared: &Arc<Shared>, invocation_id: &str, macro_id: &str) {
    if let Ok(mut inner) = shared.inner.lock() {
        let prefix = format!("{invocation_id}|");
        inner
            .statuses
            .retain(|key, status| !(key.starts_with(&prefix) && status.macro_id == macro_id));
    }
    emit_statuses(shared, true);
}

fn emit_statuses(shared: &Arc<Shared>, reliable: bool) {
    let mut statuses = shared
        .inner
        .lock()
        .map(|inner| inner.statuses.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    statuses.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.role_id.cmp(&right.role_id))
    });
    (shared.events)(vec![CoreEvent::MacroStatuses { reliable, statuses }]);
}

fn emit_presentation_statuses(shared: &Arc<Shared>) {
    let now = Instant::now();
    let should_emit = shared
        .last_presentation_status_emit
        .lock()
        .map(|mut last| {
            if last.is_some_and(|last| now.duration_since(last) < PRESENTATION_STATUS_MIN_INTERVAL)
            {
                return false;
            }
            *last = Some(now);
            true
        })
        .unwrap_or(false);
    if should_emit {
        emit_statuses(shared, false);
    }
}

fn cancel_control(control: &InvocationControl) {
    let _wake = control.wake.0.lock().ok();
    control.cancelled.store(true, Ordering::Release);
    control.wake.1.notify_all();
    drop(_wake);
    control.start_ready.1.notify_all();
    control.first_iteration_roles.1.notify_all();
    if let Ok(barriers) = control.barriers.lock() {
        for barrier in barriers.values() {
            barrier.ready.notify_all();
        }
    }
}

fn mark_invocation_ready(control: &InvocationControl) {
    if let Ok(mut ready) = control.start_ready.0.lock() {
        *ready = true;
        control.start_ready.1.notify_all();
    }
}

fn wait_for_invocation_ready(control: &InvocationControl) -> Result<(), String> {
    let mut ready = control
        .start_ready
        .0
        .lock()
        .map_err(|_| "macro start gate lock poisoned".to_owned())?;
    while !*ready && !control.cancelled.load(Ordering::Acquire) {
        ready = control
            .start_ready
            .1
            .wait(ready)
            .map_err(|_| "macro start gate lock poisoned".to_owned())?;
    }
    if control.cancelled.load(Ordering::Acquire) {
        Err("macro run cancelled".to_owned())
    } else {
        Ok(())
    }
}

fn cancel_and_wait_all(controls: &[Arc<InvocationControl>]) -> CoreResult<()> {
    for control in controls {
        cancel_control(control);
    }
    let mut first_error = None;
    for control in controls {
        if let Err(error) = wait_finished(control)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn wait_finished(control: &InvocationControl) -> CoreResult<()> {
    wait_finished_with_timeout(control, INVOCATION_STOP_TIMEOUT)
}

fn wait_finished_with_timeout(control: &InvocationControl, timeout: Duration) -> CoreResult<()> {
    let finished = control
        .finished
        .0
        .lock()
        .map_err(|_| CoreError::Internal("macro completion lock poisoned".to_owned()))?;
    let (finished, _) = control
        .finished
        .1
        .wait_timeout_while(finished, timeout, |finished| !*finished)
        .map_err(|_| CoreError::Internal("macro completion lock poisoned".to_owned()))?;
    if !*finished {
        return Err(CoreError::Domain {
            code: "MACRO_STOP_TIMEOUT",
            message: format!(
                "Macro invocation {} did not stop within {} seconds.",
                control.id,
                timeout.as_secs_f64()
            ),
        });
    }
    drop(finished);
    let worker = control
        .worker
        .lock()
        .map_err(|_| CoreError::Internal("macro worker lock poisoned".to_owned()))?
        .take();
    if let Some(worker) = worker
        && worker.thread().id() != thread::current().id()
    {
        worker
            .join()
            .map_err(|_| CoreError::Internal("macro worker panicked".to_owned()))?;
    }
    Ok(())
}

fn assigned_active_roles(
    definition: &MacroDefinition,
    active_role_ids: &HashSet<String>,
) -> Vec<String> {
    definition
        .role_ids
        .iter()
        .filter(|role_id| active_role_ids.contains(*role_id))
        .cloned()
        .collect()
}

fn collect_invocation_macro_ids(
    root_id: &str,
    macros: &HashMap<String, MacroDefinition>,
) -> HashSet<String> {
    let mut collected = HashSet::new();
    let mut pending = vec![root_id.to_owned()];
    while let Some(macro_id) = pending.pop() {
        if !collected.insert(macro_id.clone()) {
            continue;
        }
        let Some(definition) = macros.get(&macro_id) else {
            continue;
        };
        pending.extend(definition.steps.iter().filter_map(|step| match step {
            MacroStepDefinition::Macro { macro_id, .. } => Some(macro_id.clone()),
            _ => None,
        }));
    }
    collected
}

fn validate_start_request(request: &MacroStartRequest) -> CoreResult<()> {
    if request.macro_id.trim().is_empty() || request.macros.is_empty() {
        return Err(CoreError::InvalidInput(
            "macro start request is invalid".to_owned(),
        ));
    }
    if request.macros.len() > 2_000 || request.active_role_ids.len() > 128 {
        return Err(CoreError::InvalidInput(
            "macro start request exceeds runtime limits".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for definition in &request.macros {
        if definition.id.trim().is_empty()
            || definition.name.trim().is_empty()
            || !ids.insert(definition.id.clone())
            || definition.steps.len() > 100
            || definition.role_ids.iter().any(|id| id.trim().is_empty())
        {
            return Err(CoreError::InvalidInput(
                "macro definition is invalid".to_owned(),
            ));
        }
    }
    validate_macro_dependencies(&request.macros)
}

fn validate_macro_dependencies(macros: &[MacroDefinition]) -> CoreResult<()> {
    let by_id = macros
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<HashMap<_, _>>();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a MacroDefinition>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> CoreResult<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(CoreError::InvalidInput(
                "macro dependency cycle detected".to_owned(),
            ));
        }
        let definition = by_id
            .get(id)
            .ok_or_else(|| CoreError::InvalidInput("macro dependency is missing".to_owned()))?;
        for dependency in definition.steps.iter().filter_map(|step| match step {
            MacroStepDefinition::Macro { macro_id, .. } => Some(macro_id.as_str()),
            _ => None,
        }) {
            if !by_id.contains_key(dependency) {
                return Err(CoreError::InvalidInput(
                    "macro dependency is missing".to_owned(),
                ));
            }
            visit(dependency, by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in by_id.keys().copied() {
        visit(id, &by_id, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn validate_press_id(press_id: &str) -> CoreResult<()> {
    if press_id.trim().is_empty() || press_id.len() > 160 {
        Err(CoreError::InvalidInput(
            "macro shortcut press id is invalid".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn validate_result(result: &BrowserActionResult) -> CoreResult<()> {
    if result.request_id.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "browser action result requires requestId".to_owned(),
        ));
    }
    if result.ok && (result.error_code.is_some() || result.error_message.is_some()) {
        return Err(CoreError::InvalidInput(
            "successful browser action result cannot contain an error".to_owned(),
        ));
    }
    if !result.ok
        && (result.error_code.as_deref().is_none_or(str::is_empty)
            || result.error_message.as_deref().is_none_or(str::is_empty))
    {
        return Err(CoreError::InvalidInput(
            "failed browser action result requires an error code and message".to_owned(),
        ));
    }
    Ok(())
}

fn status_key(invocation_id: &str, role_id: &str, macro_id: &str) -> String {
    format!("{invocation_id}|{role_id}|{macro_id}")
}

fn lease_key(role_id: &str, macro_id: &str) -> String {
    format!("{role_id}|{macro_id}")
}

fn early_release_key(role_id: &str, macro_id: &str, press_id: &str) -> String {
    format!("{role_id}|{macro_id}|{press_id}")
}

fn trim_early_releases(releases: &mut HashMap<String, String>) {
    while releases.len() > 256 {
        let Some(key) = releases.keys().next().cloned() else {
            break;
        };
        releases.remove(&key);
    }
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
