fn start_child_invocation(
    shared: &Arc<Shared>,
    parent_context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
    single_iteration: bool,
    owner: &Arc<InvocationControl>,
    ignore_duplicate: bool,
) -> Result<Option<Arc<InvocationControl>>, String> {
    if ancestry.iter().any(|id| id == macro_id) {
        return Err("macro dependency cycle detected while running".to_owned());
    }
    let definition = parent_context
        .macros
        .get(macro_id)
        .ok_or_else(|| format!("called macro was not found: {macro_id}"))?;
    if !definition.enabled {
        return Err(DISABLED_MACRO_MESSAGE.to_owned());
    }
    let roles = assigned_active_roles(definition, &parent_context.active_role_ids);
    if roles.is_empty() {
        return Err(UNAVAILABLE_ROLE_MESSAGE.to_owned());
    }
    let invocation_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let invocation_id = format!("macro-invocation-{invocation_number}");
    let child = new_invocation_control(
        invocation_id.clone(),
        macro_id.to_owned(),
        roles.iter().cloned().collect(),
    );
    {
        let mut inner = shared
            .inner
            .lock()
            .map_err(|_| "macro runtime lock poisoned".to_owned())?;
        let duplicate = inner.invocations.values().any(|control| {
            control
                .macro_ids
                .lock()
                .is_ok_and(|ids| ids.contains(macro_id))
        });
        if duplicate {
            return if ignore_duplicate {
                Ok(None)
            } else {
                Err(format!(
                    "Called macro \"{}\" is already running.",
                    definition.name
                ))
            };
        }
        if inner.mutating_macro_ids.contains(macro_id) {
            return Err("called macro is being changed".to_owned());
        }
        if roles
            .iter()
            .any(|role_id| inner.stopping_role_ids.contains(role_id))
        {
            return Err(STOPPING_ROLE_MESSAGE.to_owned());
        }
        if roles
            .iter()
            .any(|role_id| inner.restart_required_role_ids.contains(role_id))
        {
            return Err(INPUT_RESTART_REQUIRED_ROLE_MESSAGE.to_owned());
        }
        if roles
            .iter()
            .any(|role_id| inner.recovering_role_ids.contains(role_id))
        {
            return Err(INPUT_RECOVERING_ROLE_MESSAGE.to_owned());
        }
        if roles
            .iter()
            .any(|role_id| inner.quiesced_role_ids.contains(role_id))
        {
            return Err(INPUT_FENCED_ROLE_MESSAGE.to_owned());
        }
        if inner.invocations.len() >= MAX_ACTIVE_INVOCATIONS {
            return Err("too many macro invocations are active".to_owned());
        }
        inner
            .invocations
            .insert(invocation_id.clone(), Arc::clone(&child));
    }
    register_owned_child(owner, &child);
    let attempt_id = begin_macro_start_attempt_for_roles(shared, macro_id, None, roles.clone());
    if let Ok(mut child_attempt_id) = child.start_attempt_id.lock() {
        *child_attempt_id = Some(attempt_id.clone());
    }
    let mut focus_failure = None;
    let start_result = (|| {
        if let Err(failure) = perform_actions_with_control(
            shared,
            &child,
            roles
                .iter()
                .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
                .collect(),
            false,
        ) {
            let message = failure.message.clone();
            focus_failure = Some(failure);
            return Err(message);
        }
        let started_at = Utc::now().to_rfc3339();
        {
            let mut inner = shared
                .inner
                .lock()
                .map_err(|_| "macro runtime lock poisoned".to_owned())?;
            for role_id in &roles {
                inner.statuses.insert(
                    status_key(&invocation_id, role_id, macro_id),
                    MacroRunStatus {
                        role_id: role_id.clone(),
                        macro_id: macro_id.to_owned(),
                        state: "running".to_owned(),
                        iteration: Some(0),
                        last_click: None,
                        started_at: started_at.clone(),
                        updated_at: started_at.clone(),
                        error: None,
                    },
                );
            }
        }
        emit_statuses(shared, true);
        let shared_for_run = Arc::clone(shared);
        let child_for_run = Arc::clone(&child);
        let mut child_ancestry = ancestry;
        let child_macro_id = macro_id.to_owned();
        let child_context = ExecutionContext {
            active_role_ids: Arc::clone(&parent_context.active_role_ids),
            control: Arc::clone(&child),
            macros: Arc::clone(&parent_context.macros),
            settings: parent_context.settings.clone(),
            waiter: Arc::clone(&parent_context.waiter),
        };
        let worker = thread::Builder::new()
            .name(format!("rion-macro-child-{invocation_number}"))
            .spawn(move || {
                let result = execute_macro(
                    &shared_for_run,
                    &child_context,
                    &child_macro_id,
                    &roles,
                    &mut child_ancestry,
                    true,
                    single_iteration,
                );
                finish_invocation(&shared_for_run, &child_for_run, result);
            })
            .map_err(|error| error.to_string())?;
        *child
            .worker
            .lock()
            .map_err(|_| "macro worker lock poisoned".to_owned())? = Some(worker);
        Ok(())
    })();
    if let Err(error) = start_result {
        let diagnostic_error = focus_failure
            .map(macro_input_core_error)
            .unwrap_or_else(|| CoreError::Internal(error.clone()));
        finish_macro_start_attempt(
            shared,
            &attempt_id,
            diagnostic_error.focus_request_ids().to_vec(),
            "failed",
            Some(&diagnostic_error),
        );
        remove_owned_child(owner, &child.id);
        discard_unstarted_invocation(shared, &child);
        return Err(error);
    }
    let focus_request_ids = child
        .focus_request_ids
        .lock()
        .map(|request_ids| request_ids.clone())
        .unwrap_or_default();
    finish_macro_start_attempt(
        shared,
        &attempt_id,
        focus_request_ids,
        "running",
        None,
    );
    Ok(Some(child))
}

fn register_owned_child(owner: &Arc<InvocationControl>, child: &Arc<InvocationControl>) {
    if owner.finished_naturally.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut children) = owner.children.0.lock() {
        children.ids.insert(child.id.clone());
        owner.children.1.notify_all();
    }
    if let Ok(mut owner_signal) = child.owner_signal.lock() {
        *owner_signal = Some(Arc::downgrade(owner));
    }
}

fn remove_owned_child(owner: &Arc<InvocationControl>, child_id: &str) {
    if let Ok(mut children) = owner.children.0.lock() {
        children.ids.remove(child_id);
        owner.children.1.notify_all();
    }
}

fn input_sequence_role_lock(shared: &Arc<Shared>, role_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = shared
        .input_sequence_role_locks
        .lock()
        .map_err(|_| "macro input sequence registry lock poisoned".to_owned())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(role_id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(role_id.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn input_sequence_role_locks(
    shared: &Arc<Shared>,
    role_ids: &[String],
) -> Result<Vec<Arc<Mutex<()>>>, String> {
    let mut ordered_role_ids = role_ids.to_vec();
    ordered_role_ids.sort();
    ordered_role_ids.dedup();
    ordered_role_ids
        .iter()
        .map(|role_id| input_sequence_role_lock(shared, role_id))
        .collect()
}

fn action_role_locks(
    shared: &Arc<Shared>,
    role_ids: &[String],
) -> Result<Vec<Arc<Mutex<()>>>, String> {
    let mut locks = shared
        .action_role_locks
        .lock()
        .map_err(|_| "macro role action registry lock poisoned".to_owned())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    Ok(role_ids
        .iter()
        .map(|role_id| {
            if let Some(lock) = locks.get(role_id).and_then(Weak::upgrade) {
                return lock;
            }
            let lock = Arc::new(Mutex::new(()));
            locks.insert(role_id.clone(), Arc::downgrade(&lock));
            lock
        })
        .collect())
}

fn perform_action(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    role_id: &str,
    action: BrowserAction,
    allow_cancelled: bool,
) -> Result<(), String> {
    perform_actions(shared, context, vec![(role_id, action)], allow_cancelled)
}

fn perform_actions(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    mut actions: Vec<(&str, BrowserAction)>,
    allow_cancelled: bool,
) -> Result<(), String> {
    if !allow_cancelled {
        actions.retain(|(role_id, _)| !is_role_cancelled(&context.control, role_id));
    }
    perform_actions_with_control(shared, &context.control, actions, allow_cancelled)
        .map(|_| ())
        .map_err(|failure| failure.message)
}

fn perform_actions_with_control(
    shared: &Arc<Shared>,
    control: &Arc<InvocationControl>,
    actions: Vec<(&str, BrowserAction)>,
    allow_cancelled: bool,
) -> Result<Vec<String>, MacroActionFailure> {
    if !allow_cancelled && control.cancelled.load(Ordering::Acquire) {
        return Err(MacroActionFailure::internal("macro run cancelled"));
    }
    if actions.is_empty() {
        return Ok(Vec::new());
    }
    let cancel_pending_wait = actions
        .iter()
        .all(|(_, action)| matches!(action, BrowserAction::Focus));
    let mut role_ids = actions
        .iter()
        .map(|(role_id, _)| (*role_id).to_owned())
        .collect::<Vec<_>>();
    role_ids.sort();
    role_ids.dedup();
    let role_locks = action_role_locks(shared, &role_ids)?;
    let _role_guards = role_locks
        .iter()
        .map(|lock| {
            lock.lock()
                .map_err(|_| "macro role action lock poisoned".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut pending_actions = Vec::with_capacity(actions.len());
    let action_metadata = {
        let mut inner = shared
            .inner
            .lock()
            .map_err(|_| "macro runtime lock poisoned".to_owned())?;
        while !allow_cancelled
            && !control.cancelled.load(Ordering::Acquire)
            && role_ids
                .iter()
                .any(|role_id| inner.transferring_role_ids.contains(role_id))
        {
            inner = shared
                .role_transfer_changed
                .wait(inner)
                .map_err(|_| "macro role transfer lock poisoned".to_owned())?;
        }
        if !allow_cancelled && control.cancelled.load(Ordering::Acquire) {
            return Err(MacroActionFailure::internal("macro run cancelled"));
        }
        actions
            .iter()
            .map(|(role_id, _)| {
                if !allow_cancelled && inner.stopping_role_ids.contains(*role_id) {
                    return Err(STOPPING_ROLE_MESSAGE.to_owned());
                }
                if !allow_cancelled && inner.quiesced_role_ids.contains(*role_id) {
                    return Err(INPUT_FENCED_ROLE_MESSAGE.to_owned());
                }
                Ok((
                    inner.input_epochs.get(*role_id).copied().unwrap_or_default(),
                    if allow_cancelled { "cleanup" } else { "normal" },
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let requests = {
        let mut pending = shared
            .pending
            .lock()
            .map_err(|_| "macro action result lock poisoned".to_owned())?;
        if pending.len().saturating_add(actions.len()) > MAX_PENDING_ACTIONS {
            return Err("macro browser action queue is full".to_owned().into());
        }
        actions
            .into_iter()
            .zip(action_metadata)
            .map(|((role_id, action), (input_epoch, intent))| {
                let request_number = shared.next_id.fetch_add(1, Ordering::Relaxed);
                let request_id = format!("browser-action-{request_number}");
                let (sender, receiver) = mpsc::sync_channel(1);
                pending.insert(
                    request_id.clone(),
                    PendingMacroAction {
                        result: sender,
                        role_id: role_id.to_owned(),
                        signal: Arc::downgrade(control),
                    },
                );
                pending_actions.push((request_id.clone(), role_id.to_owned(), receiver));
                BrowserActionRequest {
                    request_id,
                    role_id: role_id.to_owned(),
                    origin: "macro".to_owned(),
                    input_epoch,
                    intent: intent.to_owned(),
                    scheduled_at_ms: epoch_millis(),
                    deadline_ms: epoch_millis()
                        .saturating_add(shared.action_timeout.as_millis() as u64),
                    action,
                }
            })
            .collect::<Vec<_>>()
    };
    let focus_request_ids = pending_actions
        .iter()
        .map(|(request_id, _, _)| request_id.clone())
        .collect::<Vec<_>>();
    if cancel_pending_wait
        && let Ok(mut request_ids) = control.focus_request_ids.lock()
    {
        *request_ids = focus_request_ids.clone();
    }
    if cancel_pending_wait
        && let Ok(attempt_id) = control.start_attempt_id.lock()
        && let Some(attempt_id) = attempt_id.as_deref()
    {
        mark_macro_start_attempt_focus_admission(shared, attempt_id, &focus_request_ids);
    }
    (shared.events)(vec![CoreEvent::BrowserActions { actions: requests }]);
    let deadline = std::time::Instant::now() + shared.action_timeout;
    let mut outcome = Ok(());
    for (request_id, role_id, receiver) in &pending_actions {
        let mut signal_guard = control
            .wake
            .0
            .lock()
            .map_err(|_| "macro wait lock poisoned".to_owned())?;
        loop {
            if cancel_pending_wait && !allow_cancelled && control.cancelled.load(Ordering::Acquire)
            {
                outcome = Err(MacroActionFailure {
                    cause_code: "MACRO_RUN_CANCELLED".to_owned(),
                    focus_request_ids: focus_request_ids.clone(),
                    message: "macro run cancelled".to_owned(),
                    request_id: Some(request_id.clone()),
                    role_id: Some(role_id.clone()),
                });
                break;
            }
            match receiver.try_recv() {
                Ok(result) if result.ok => break,
                Ok(result) => {
                    record_action_failure(
                        control,
                        role_id,
                        MacroActionFailure {
                            cause_code: result
                                .error_code
                                .unwrap_or_else(|| "MACRO_INPUT_FAILED".to_owned()),
                            focus_request_ids: focus_request_ids.clone(),
                            message: result
                            .error_message
                                .unwrap_or_else(|| "browser action failed".to_owned()),
                            request_id: Some(request_id.clone()),
                            role_id: Some(role_id.clone()),
                        },
                        &mut outcome,
                    );
                    break;
                }
                Err(TryRecvError::Empty) if Instant::now() < deadline => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let (next_guard, _) = control
                        .wake
                        .1
                        .wait_timeout(signal_guard, remaining)
                        .map_err(|_| "macro wait lock poisoned".to_owned())?;
                    signal_guard = next_guard;
                }
                Err(TryRecvError::Empty) => {
                    record_action_failure(
                        control,
                        role_id,
                        MacroActionFailure {
                            cause_code: "MACRO_INPUT_TIMEOUT".to_owned(),
                            focus_request_ids: focus_request_ids.clone(),
                            message: format!(
                                "Macro input timed out after {} ms.",
                                ACTION_TIMEOUT.as_millis()
                            ),
                            request_id: Some(request_id.clone()),
                            role_id: Some(role_id.clone()),
                        },
                        &mut outcome,
                    );
                    break;
                }
                Err(TryRecvError::Disconnected) => {
                    record_action_failure(
                        control,
                        role_id,
                        MacroActionFailure {
                            cause_code: "MACRO_INPUT_RESULT_CHANNEL_CLOSED".to_owned(),
                            focus_request_ids: focus_request_ids.clone(),
                            message: "macro browser action result channel closed".to_owned(),
                            request_id: Some(request_id.clone()),
                            role_id: Some(role_id.clone()),
                        },
                        &mut outcome,
                    );
                    break;
                }
            }
        }
        drop(signal_guard);
    }
    if let Ok(mut pending) = shared.pending.lock() {
        for (request_id, _, _) in &pending_actions {
            pending.remove(request_id);
        }
    }
    if outcome.is_ok() && !allow_cancelled && control.cancelled.load(Ordering::Acquire) {
        return Err(MacroActionFailure {
            cause_code: "MACRO_RUN_CANCELLED".to_owned(),
            focus_request_ids,
            message: "macro run cancelled".to_owned(),
            request_id: None,
            role_id: None,
        });
    }
    outcome.map(|()| focus_request_ids)
}

fn record_action_failure(
    control: &InvocationControl,
    role_id: &str,
    mut failure: MacroActionFailure,
    outcome: &mut Result<(), MacroActionFailure>,
) {
    if outcome.is_ok() && !control.cancelled.load(Ordering::Acquire) {
        if let Ok(mut failed_role_id) = control.failed_role_id.lock()
            && failed_role_id.is_none()
        {
            *failed_role_id = Some(role_id.to_owned());
        }
        if failure.role_id.is_none() {
            failure.role_id = Some(role_id.to_owned());
        }
        *outcome = Err(failure);
    }
}

fn release_held_keys(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    held_keys: &mut Vec<HeldKey>,
) {
    while let Some(held) = held_keys.pop() {
        let registered = shared
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.held_keys.remove(&held.owner_id))
            .is_some();
        if !registered {
            continue;
        }
        let Ok(input_sequence) = input_sequence_role_lock(shared, &held.role_id) else {
            continue;
        };
        let Ok(_input_sequence_guard) = input_sequence.lock() else {
            continue;
        };
        let suppress_overlay_shortcut =
            should_suppress_overlay_shortcut(context, &held.role_id, &held.code, &held.modifiers);
        let _ = perform_action(
            shared,
            context,
            &held.role_id,
            BrowserAction::Key {
                phase: "release".to_owned(),
                key: held.code.clone(),
                code: Some(held.code),
                modifiers: held.modifiers,
                owner_id: held.owner_id,
                suppress_overlay_shortcut,
            },
            true,
        );
    }
}

fn should_suppress_overlay_shortcut(
    context: &ExecutionContext,
    role_id: &str,
    code: &str,
    modifiers: &[String],
) -> bool {
    should_suppress_overlay_shortcut_for_macros(&context.macros, role_id, code, modifiers)
}

fn should_suppress_overlay_shortcut_for_macros(
    macros: &HashMap<String, MacroDefinition>,
    role_id: &str,
    code: &str,
    modifiers: &[String],
) -> bool {
    let ctrl = modifiers.iter().any(|modifier| modifier == "ctrl");
    let alt = modifiers.iter().any(|modifier| modifier == "alt");
    let shift = modifiers.iter().any(|modifier| modifier == "shift");
    let meta = modifiers.iter().any(|modifier| modifier == "meta");
    let primary = modifiers.iter().any(|modifier| modifier == "primary");
    macros.values().any(|definition| {
        if !definition.enabled || !definition.role_ids.iter().any(|id| id == role_id) {
            return false;
        }
        let Some(crate::model::MacroTrigger::Keyboard {
            code: trigger_code,
            ctrl: trigger_ctrl,
            alt: trigger_alt,
            shift: trigger_shift,
            meta: trigger_meta,
        }) = &definition.trigger else {
            return false;
        };
        if trigger_code != code || *trigger_alt != alt || *trigger_shift != shift {
            return false;
        }
        if primary {
            (*trigger_ctrl == ctrl && *trigger_meta) || (*trigger_ctrl && *trigger_meta == meta)
        } else {
            *trigger_ctrl == ctrl && *trigger_meta == meta
        }
    })
}

fn register_held_key(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    held: HeldKey,
) -> Result<bool, String> {
    let mut inner = shared
        .inner
        .lock()
        .map_err(|_| "macro runtime lock poisoned".to_owned())?;
    if is_role_cancelled(&context.control, &held.role_id) {
        return Ok(false);
    }
    inner.held_keys.insert(held.owner_id.clone(), held);
    Ok(true)
}

fn active_execution_roles(context: &ExecutionContext, roles: &[String]) -> Vec<String> {
    roles
        .iter()
        .filter(|role_id| !is_role_cancelled(&context.control, role_id))
        .cloned()
        .collect()
}

fn is_role_cancelled(control: &InvocationControl, role_id: &str) -> bool {
    control
        .cancelled_role_ids
        .lock()
        .is_ok_and(|role_ids| role_ids.contains(role_id))
}

fn wait_for_first_iteration(
    context: &ExecutionContext,
    role_id: &str,
    expected_roles: usize,
) -> Result<(), String> {
    let mut completed_roles = context
        .control
        .first_iteration_roles
        .0
        .lock()
        .map_err(|_| "macro first-iteration barrier lock poisoned".to_owned())?;
    completed_roles.insert(role_id.to_owned());
    if completed_roles.len() == expected_roles {
        context
            .control
            .first_iteration_completed
            .store(true, Ordering::Release);
        context.control.first_iteration_roles.1.notify_all();
    }
    while !context
        .control
        .first_iteration_completed
        .load(Ordering::Acquire)
        && !context.control.cancelled.load(Ordering::Acquire)
    {
        completed_roles = context
            .control
            .first_iteration_roles
            .1
            .wait(completed_roles)
            .map_err(|_| "macro first-iteration barrier lock poisoned".to_owned())?;
    }
    check_role_cancelled(context, role_id)
}

fn wait_cancelable_for_role(
    context: &ExecutionContext,
    role_id: &str,
    duration_ms: u32,
) -> Result<(), String> {
    check_role_cancelled(context, role_id)?;
    (context.waiter)(&context.control, role_id, duration_ms)?;
    check_role_cancelled(context, role_id)
}

fn default_wait(
    control: &Arc<InvocationControl>,
    role_id: &str,
    duration_ms: u32,
) -> Result<(), String> {
    if duration_ms == 0 {
        thread::yield_now();
        return Ok(());
    }
    let guard = control
        .wake
        .0
        .lock()
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    let _ = control
        .wake
        .1
        .wait_timeout_while(guard, Duration::from_millis(u64::from(duration_ms)), |_| {
            !control.cancelled.load(Ordering::Acquire) && !is_role_cancelled(control, role_id)
        })
        .map_err(|_| "macro wait lock poisoned".to_owned())?;
    Ok(())
}

fn wait_until_role_cancelled(context: &ExecutionContext, role_id: &str) -> Result<(), String> {
    while check_role_cancelled(context, role_id).is_ok() {
        let guard = context
            .control
            .wake
            .0
            .lock()
            .map_err(|_| "macro wait lock poisoned".to_owned())?;
        drop(
            context
                .control
                .wake
                .1
                .wait_while(guard, |_| {
                    !context.control.cancelled.load(Ordering::Acquire)
                        && !is_role_cancelled(&context.control, role_id)
                })
                .map_err(|_| "macro wait lock poisoned".to_owned())?,
        );
    }
    Err("macro run cancelled".to_owned())
}

fn check_role_cancelled(context: &ExecutionContext, role_id: &str) -> Result<(), String> {
    if context.control.cancelled.load(Ordering::Acquire)
        || is_role_cancelled(&context.control, role_id)
    {
        Err("macro run cancelled".to_owned())
    } else {
        Ok(())
    }
}

fn finish_invocation(
    shared: &Arc<Shared>,
    control: &Arc<InvocationControl>,
    execution_result: Result<(), String>,
) {
    record_execution_outcome(control, &execution_result);
    let mut terminal_result = execution_result;
    if terminal_result.is_err()
        || control.cancelled.load(Ordering::Acquire)
        || control.stop_after_first_iteration.load(Ordering::Acquire)
    {
        control.terminating.store(true, Ordering::Release);
        cancel_owned_children(shared, control);
    } else {
        match wait_for_owned_children(control) {
            Ok(true) => control.finished_naturally.store(true, Ordering::Release),
            Ok(false) => {
                control.terminating.store(true, Ordering::Release);
                cancel_owned_children(shared, control);
                if control.cancelled.load(Ordering::Acquire) {
                    terminal_result = Err("macro run cancelled".to_owned());
                }
            }
            Err(error) => {
                terminal_result = Err(error);
                control.terminating.store(true, Ordering::Release);
                cancel_owned_children(shared, control);
            }
        }
    }
    if let Ok(mut inner) = shared.inner.lock() {
        let cancelled = control.cancelled.load(Ordering::Acquire);
        let cancellation_error = control
            .cancellation_error
            .lock()
            .ok()
            .and_then(|error| error.clone());
        let prefix = format!("{}|", control.id);
        if let Some(error) = cancellation_error
            && terminal_result.is_err()
        {
            let now = Utc::now().to_rfc3339();
            for (key, status) in &mut inner.statuses {
                if key.starts_with(&prefix) {
                    status.state = "cancelled".to_owned();
                    status.updated_at = now.clone();
                    status.error = Some(error.clone());
                }
            }
        } else if let Err(ref error) = terminal_result
            && (!cancelled
                || control
                    .failed_role_id
                    .lock()
                    .is_ok_and(|role_id| role_id.is_some()))
        {
            let now = Utc::now().to_rfc3339();
            let failed_role_id = control
                .failed_role_id
                .lock()
                .ok()
                .and_then(|role_id| role_id.clone());
            for (key, status) in &mut inner.statuses {
                if key.starts_with(&prefix) {
                    let is_failed_role = failed_role_id
                        .as_ref()
                        .is_none_or(|role_id| role_id == &status.role_id);
                    status.state = if is_failed_role {
                        "failed".to_owned()
                    } else {
                        "cancelled".to_owned()
                    };
                    status.updated_at = now.clone();
                    status.error = Some(if is_failed_role {
                        error.clone()
                    } else {
                        SIBLING_FAILURE_MESSAGE.to_owned()
                    });
                }
            }
        } else if cancelled || terminal_result.is_ok() {
            inner.statuses.retain(|key, _| !key.starts_with(&prefix));
        }
        inner.invocations.remove(&control.id);
        inner
            .held_keys
            .retain(|owner_id, _| !owner_id.starts_with(&format!("{}:", control.id)));
        inner
            .leases
            .retain(|_, lease| lease.invocation_id != control.id);
    }
    emit_statuses(shared, true);
    if let Ok(mut finished) = control.finished.0.lock() {
        *finished = true;
        control.finished.1.notify_all();
    }
    if let Some(owner) = control
        .owner_signal
        .lock()
        .ok()
        .and_then(|owner| owner.as_ref().and_then(Weak::upgrade))
    {
        remove_owned_child(&owner, &control.id);
        let _owner_guard = owner.wake.0.lock().ok();
        owner.wake.1.notify_all();
    }
}

fn new_invocation_control(
    id: String,
    macro_id: String,
    role_ids: HashSet<String>,
) -> Arc<InvocationControl> {
    Arc::new(InvocationControl {
        barriers: Mutex::new(HashMap::new()),
        cancelled: AtomicBool::new(false),
        cancellation_error: Mutex::new(None),
        cancelled_role_ids: Mutex::new(HashSet::new()),
        children: (Mutex::new(ChildInvocations::default()), Condvar::new()),
        execution_finished: AtomicBool::new(false),
        failed_role_id: Mutex::new(None),
        first_iteration_completed: AtomicBool::new(false),
        first_iteration_roles: (Mutex::new(HashSet::new()), Condvar::new()),
        focus_request_ids: Mutex::new(Vec::new()),
        start_attempt_id: Mutex::new(None),
        finished: (Mutex::new(false), Condvar::new()),
        finished_naturally: AtomicBool::new(false),
        id,
        macro_ids: Mutex::new(HashSet::from([macro_id])),
        outcome: Mutex::new(None),
        owner_signal: Mutex::new(None),
        restart_intent: Mutex::new(None),
        role_ids,
        start_ready: (Mutex::new(false), Condvar::new()),
        stop_after_first_iteration: AtomicBool::new(false),
        terminating: AtomicBool::new(false),
        wake: (Mutex::new(()), Condvar::new()),
        worker: Mutex::new(None),
    })
}
