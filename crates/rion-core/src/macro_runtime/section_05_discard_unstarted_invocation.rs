fn validate_shortcut_source(request: &MacroStartRequest) -> CoreResult<()> {
    let Some(source_role_id) = request.source_role_id.as_deref() else {
        return Ok(());
    };
    let definition = request
        .macros
        .iter()
        .find(|definition| definition.id == request.macro_id)
        .ok_or_else(|| CoreError::InvalidInput("macro was not found".to_owned()))?;
    if crate::domain::macro_shortcut_source_contains(
        &definition.shortcut_source_scope,
        &definition.role_ids,
        source_role_id,
    ) {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "macro shortcut is not available to the requested role".to_owned(),
        ))
    }
}

fn begin_macro_start_attempt(shared: &Arc<Shared>, request: &MacroStartRequest) -> String {
    let active_role_ids = request
        .active_role_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let role_ids = request
        .macros
        .iter()
        .find(|definition| definition.id == request.macro_id)
        .map(|definition| assigned_active_roles(definition, &active_role_ids))
        .unwrap_or_default();
    begin_macro_start_attempt_for_roles(
        shared,
        &request.macro_id,
        request.source_role_id.clone(),
        role_ids,
    )
}

fn begin_macro_start_attempt_for_roles(
    shared: &Arc<Shared>,
    macro_id: &str,
    source_role_id: Option<String>,
    mut role_ids: Vec<String>,
) -> String {
    let attempt_number = shared
        .next_start_attempt_id
        .fetch_add(1, Ordering::Relaxed);
    let attempt_id = format!("macro-start-attempt-{attempt_number}");
    role_ids.sort();
    let record = MacroStartAttemptDiagnosticRecord {
        attempt_id: attempt_id.clone(),
        macro_id: macro_id.to_owned(),
        source_role_id,
        role_ids,
        focus_request_ids: Vec::new(),
        requested_at: Utc::now().to_rfc3339(),
        completed_at: None,
        stage: "requested".to_owned(),
        outcome: "pending".to_owned(),
        error_code: None,
        cause_code: None,
        failed_role_id: None,
        failed_request_id: None,
    };
    if let Ok(mut inner) = shared.inner.lock() {
        inner.recent_start_attempts.push_back(record);
        while inner.recent_start_attempts.len() > MAX_RECENT_START_ATTEMPTS {
            inner.recent_start_attempts.pop_front();
        }
    }
    attempt_id
}

fn finish_macro_start_attempt(
    shared: &Arc<Shared>,
    attempt_id: &str,
    focus_request_ids: Vec<String>,
    outcome: &str,
    error: Option<&CoreError>,
) {
    let Ok(mut inner) = shared.inner.lock() else {
        return;
    };
    let Some(record) = inner
        .recent_start_attempts
        .iter_mut()
        .find(|record| record.attempt_id == attempt_id)
    else {
        return;
    };
    record.focus_request_ids = focus_request_ids;
    record.completed_at = Some(Utc::now().to_rfc3339());
    record.stage = if outcome == "running" {
        "admitted".to_owned()
    } else {
        "terminal".to_owned()
    };
    record.outcome = outcome.to_owned();
    if let Some(error) = error {
        record.error_code = Some(error.code().to_owned());
        record.cause_code = error.cause_code().map(str::to_owned);
        record.failed_role_id = error.failed_role_id().map(str::to_owned);
        record.failed_request_id = error.failed_request_id().map(str::to_owned);
    }
}

fn mark_macro_start_attempt_focus_admission(
    shared: &Arc<Shared>,
    attempt_id: &str,
    focus_request_ids: &[String],
) {
    let Ok(mut inner) = shared.inner.lock() else {
        return;
    };
    let Some(record) = inner
        .recent_start_attempts
        .iter_mut()
        .find(|record| record.attempt_id == attempt_id)
    else {
        return;
    };
    record.focus_request_ids = focus_request_ids.to_vec();
    record.stage = "focusAdmission".to_owned();
}

fn macro_input_core_error(failure: MacroActionFailure) -> CoreError {
    let code = match failure.cause_code.as_str() {
        "SYSTEM_RUNTIME_NOT_ACTIVE" => "MACRO_RUNTIME_NOT_ACTIVE",
        "SYSTEM_AUTOMATION_SURFACE_WAKE_FAILED" => "MACRO_INPUT_WAKE_FAILED",
        "SYSTEM_AUTOMATION_SURFACE_WAKE_INDETERMINATE" => {
            "MACRO_INPUT_WAKE_INDETERMINATE"
        }
        _ => "MACRO_INPUT_FAILED",
    };
    CoreError::MacroInput(Box::new(MacroInputError {
        code,
        cause_code: failure.cause_code,
        failed_request_id: failure.request_id,
        failed_role_id: failure.role_id,
        focus_request_ids: failure.focus_request_ids,
        message: failure.message,
    }))
}

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
    control.execution_finished.store(true, Ordering::Release);
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
}

fn record_execution_outcome(
    control: &Arc<InvocationControl>,
    execution_result: &Result<(), String>,
) {
    if let Ok(mut outcome) = control.outcome.lock() {
        *outcome = Some(execution_result.clone());
    }
    control.execution_finished.store(true, Ordering::Release);
    if let Some(owner) = control
        .owner_signal
        .lock()
        .ok()
        .and_then(|owner| owner.as_ref().and_then(Weak::upgrade))
    {
        let _owner_guard = owner.wake.0.lock().ok();
        owner.wake.1.notify_all();
    }
}

fn wait_for_owned_children(control: &Arc<InvocationControl>) -> Result<bool, String> {
    let mut children = control
        .children
        .0
        .lock()
        .map_err(|_| "macro child registry lock poisoned".to_owned())?;
    loop {
        if control.cancelled.load(Ordering::Acquire)
            || control.stop_after_first_iteration.load(Ordering::Acquire)
        {
            return Ok(false);
        }
        if children.pending_starts == 0 && children.ids.is_empty() {
            return Ok(true);
        }
        children = control
            .children
            .1
            .wait(children)
            .map_err(|_| "macro child registry lock poisoned".to_owned())?;
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

fn macro_run_lock(shared: &Arc<Shared>, macro_id: &str) -> CoreResult<Arc<Mutex<()>>> {
    let mut locks = shared
        .macro_run_locks
        .lock()
        .map_err(|_| CoreError::Internal("macro run lock registry poisoned".to_owned()))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(macro_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(macro_id.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn cancel_control(control: &InvocationControl) {
    let _wake = control.wake.0.lock().ok();
    control.cancelled.store(true, Ordering::Release);
    control.wake.1.notify_all();
    drop(_wake);
    control.start_ready.1.notify_all();
    control.first_iteration_roles.1.notify_all();
    control.children.1.notify_all();
    if let Ok(barriers) = control.barriers.lock() {
        for barrier in barriers.values() {
            if let Ok(_state) = barrier.state.lock() {
                barrier.ready.notify_all();
            }
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
        let shortcut_source_role_ids = crate::domain::macro_shortcut_source_role_ids(
            &definition.shortcut_source_scope,
            &definition.role_ids,
        );
        if definition.id.trim().is_empty()
            || definition.name.trim().is_empty()
            || !ids.insert(definition.id.clone())
            || definition.steps.len() > 100
            || definition.role_ids.iter().any(|id| id.trim().is_empty())
            || shortcut_source_role_ids
                .iter()
                .any(|id| id.trim().is_empty())
            || shortcut_source_role_ids.iter().collect::<HashSet<_>>().len()
                != shortcut_source_role_ids.len()
            || (definition.trigger.is_some()
                && matches!(
                    definition.shortcut_source_scope,
                    crate::model::MacroShortcutSourceScope::SelectedRoles { ref role_ids }
                        if role_ids.is_empty()
                ))
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
