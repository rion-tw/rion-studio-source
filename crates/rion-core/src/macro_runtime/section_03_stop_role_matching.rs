impl MacroRuntime {
    fn stop_role_matching(&self, role_id: &str, macro_id: Option<&str>) -> CoreResult<()> {
        if let Some(macro_id) = macro_id {
            self.cancel_input_restarts_for_macros(&HashSet::from([macro_id.to_owned()]))?;
        } else {
            self.cancel_input_recovery_for_role(role_id)?;
        }
        let controls = {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            inner
                .invocations
                .values()
                .filter(|control| {
                    control.role_ids.contains(role_id)
                        && macro_id.is_none_or(|macro_id| {
                            control
                                .macro_ids
                                .lock()
                                .is_ok_and(|ids| ids.contains(macro_id))
                        })
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        cancel_and_wait_all(&controls)
    }

    fn emit_statuses(&self) {
        emit_statuses(&self.shared, true);
    }

}
fn execute_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    roles: &[String],
    ancestry: &mut Vec<String>,
    root: bool,
    single_iteration: bool,
) -> Result<(), String> {
    let role_id = roles
        .first()
        .ok_or_else(|| "macro step has no execution role".to_owned())?;
    check_role_cancelled(context, role_id)?;
    if ancestry.iter().any(|id| id == macro_id) {
        return Err("macro dependency cycle detected while running".to_owned());
    }
    let definition = context
        .macros
        .get(macro_id)
        .ok_or_else(|| format!("called macro was not found: {macro_id}"))?;
    if !definition.enabled {
        return Err(DISABLED_MACRO_MESSAGE.to_owned());
    }
    let assigned_roles = if root {
        roles.to_vec()
    } else {
        assigned_active_roles(definition, &context.active_role_ids)
    };
    if assigned_roles.is_empty() {
        return Err(UNAVAILABLE_ROLE_MESSAGE.to_owned());
    }
    let roles = active_execution_roles(context, &assigned_roles);
    if roles.is_empty() {
        return Ok(());
    }
    ancestry.push(macro_id.to_owned());
    if let Ok(mut ids) = context.control.macro_ids.lock() {
        ids.insert(macro_id.to_owned());
    }
    if !root {
        add_running_statuses(shared, context, macro_id, &roles);
    }
    let execution = (|| {
        if !root {
            perform_actions(
                shared,
                context,
                roles
                    .iter()
                    .map(|role_id| (role_id.as_str(), BrowserAction::Focus))
                    .collect(),
                false,
            )?;
        }
        let ancestry = ancestry.clone();
        let results = thread::scope(|scope| {
            roles
                .iter()
                .map(|role_id| {
                    let role_id = role_id.clone();
                    let ancestry = ancestry.clone();
                    let roles = roles.clone();
                    scope.spawn(move || {
                        let result = execute_macro_role(
                            shared,
                            context,
                            definition,
                            &role_id,
                            &roles,
                            ancestry,
                            single_iteration,
                        );
                        if result.is_err() && !context.control.cancelled.load(Ordering::Acquire) {
                            if let Ok(mut failed_role_id) = context.control.failed_role_id.lock()
                                && failed_role_id.is_none()
                            {
                                *failed_role_id = Some(role_id);
                            }
                            cancel_control(&context.control);
                        }
                        result
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|worker| {
                    worker
                        .join()
                        .unwrap_or_else(|_| Err("macro role worker panicked".to_owned()))
                })
                .collect::<Vec<_>>()
        });
        let mut first_error = None;
        for result in results {
            if let Err(error) = result {
                let is_cancellation = error == "macro run cancelled";
                if first_error.is_none()
                    || first_error
                        .as_deref()
                        .is_some_and(|current| current == "macro run cancelled" && !is_cancellation)
                {
                    first_error = Some(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    })();
    if execution.is_ok() {
        emit_statuses(shared, true);
    }
    ancestry.pop();
    if !root && execution.is_ok() {
        remove_macro_statuses(shared, &context.control.id, macro_id);
    }
    execution
}

fn execute_macro_role(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    definition: &MacroDefinition,
    role_id: &str,
    invocation_role_ids: &[String],
    ancestry: Vec<String>,
    single_iteration: bool,
) -> Result<(), String> {
    let mut held_keys = Vec::new();
    let role_ids = [role_id.to_owned()];
    let execution = (|| {
        wait_cancelable_for_role(context, role_id, context.settings.startup_delay_ms)?;
        let mut iteration = 0_u32;
        loop {
            check_role_cancelled(context, role_id)?;
            for step in &definition.steps {
                check_role_cancelled(context, role_id)?;
                execute_step(
                    shared,
                    context,
                    definition,
                    &role_ids,
                    invocation_role_ids,
                    step,
                    iteration,
                    &ancestry,
                    &mut held_keys,
                )?;
            }
            iteration = iteration.saturating_add(1);
            update_iteration(shared, context, &definition.id, &role_ids, iteration);
            if iteration == 1 {
                wait_for_first_iteration(context, role_id, invocation_role_ids.len())?;
            }
            if context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
                || single_iteration
                || matches!(definition.repeat, MacroRepeat::Once)
            {
                break;
            }
            let MacroRepeat::Loop { interval_ms } = definition.repeat else {
                break;
            };
            wait_cancelable_for_role(context, role_id, interval_ms)?;
        }
        if matches!(definition.repeat, MacroRepeat::Once)
            && !held_keys.is_empty()
            && !single_iteration
            && !context
                .control
                .stop_after_first_iteration
                .load(Ordering::Acquire)
        {
            wait_until_role_cancelled(context, role_id)?;
        }
        Ok(())
    })();
    release_held_keys(shared, context, &mut held_keys);
    execution
}

#[allow(clippy::too_many_arguments)]
fn execute_step(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    definition: &MacroDefinition,
    roles: &[String],
    invocation_role_ids: &[String],
    step: &MacroStepDefinition,
    iteration: u32,
    ancestry: &[String],
    held_keys: &mut Vec<HeldKey>,
) -> Result<(), String> {
    let role_id = roles
        .first()
        .ok_or_else(|| "macro step has no execution role".to_owned())?;
    check_role_cancelled(context, role_id)?;
    match step {
        MacroStepDefinition::Key {
            id,
            code,
            modifiers,
            action,
            duration_ms,
            ..
        } => {
            let input_sequences = input_sequence_role_locks(shared, roles)?;
            let _input_sequence_guards = input_sequences
                .iter()
                .map(|sequence| {
                    sequence
                        .lock()
                        .map_err(|_| "macro input sequence lock poisoned".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let modifiers = modifiers.as_deref().unwrap_or_default();
            let hold_until_stop = action.as_deref() == Some("hold_until_stop");
            let key_hold_ms = if action.as_deref() == Some("hold_for_duration") {
                duration_ms.ok_or_else(|| "timed macro key hold has no duration".to_owned())?
            } else {
                context.settings.key_hold_ms
            };
            let owner_id_for = |role_id: &str| {
                format!(
                    "{}:{}:{}:{}",
                    context.control.id, role_id, definition.id, id
                )
            };
            let roles_to_hold = roles
                .iter()
                .filter(|role_id| {
                    !hold_until_stop
                        || !held_keys
                            .iter()
                            .any(|held| held.owner_id == owner_id_for(role_id))
                })
                .collect::<Vec<_>>();
            let holds = roles_to_hold
                .iter()
                .map(|role_id| {
                    (
                        role_id.as_str(),
                        BrowserAction::Key {
                            phase: "hold".to_owned(),
                            key: code.clone(),
                            code: Some(code.clone()),
                            modifiers: modifiers.to_vec(),
                            owner_id: owner_id_for(role_id),
                            suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                context, role_id, code, modifiers,
                            ),
                        },
                    )
                })
                .collect::<Vec<_>>();
            if let Err(error) = perform_actions(shared, context, holds, false) {
                let _ = perform_actions(
                    shared,
                    context,
                    roles_to_hold
                        .iter()
                        .map(|role_id| {
                            (
                                role_id.as_str(),
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id: owner_id_for(role_id),
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                );
                return Err(error);
            }
            for role_id in &roles_to_hold {
                let owner_id = owner_id_for(role_id);
                if hold_until_stop {
                    let held = HeldKey {
                        code: code.clone(),
                        modifiers: modifiers.to_vec(),
                        owner_id: owner_id.clone(),
                        role_id: (*role_id).clone(),
                    };
                    if register_held_key(shared, context, held.clone())? {
                        held_keys.push(held);
                    } else {
                        perform_actions(
                            shared,
                            context,
                            vec![(
                                role_id,
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id,
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )],
                            true,
                        )?;
                    }
                }
            }
            if !hold_until_stop {
                let timing_result = wait_cancelable_for_role(context, role_id, key_hold_ms);
                let release_result = perform_actions(
                    shared,
                    context,
                    roles
                        .iter()
                        .map(|role_id| {
                            (
                                role_id.as_str(),
                                BrowserAction::Key {
                                    phase: "release".to_owned(),
                                    key: code.clone(),
                                    code: Some(code.clone()),
                                    modifiers: modifiers.to_vec(),
                                    owner_id: owner_id_for(role_id),
                                    suppress_overlay_shortcut: should_suppress_overlay_shortcut(
                                        context, role_id, code, modifiers,
                                    ),
                                },
                            )
                        })
                        .collect(),
                    true,
                );
                timing_result?;
                release_result?;
            }
            wait_cancelable_for_role(context, role_id, context.settings.post_input_delay_ms)
        }
        MacroStepDefinition::Click {
            id,
            button,
            anchor,
            position,
        } => {
            let input_sequences = input_sequence_role_locks(shared, roles)?;
            let _input_sequence_guards = input_sequences
                .iter()
                .map(|sequence| {
                    sequence
                        .lock()
                        .map_err(|_| "macro input sequence lock poisoned".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let (unit, x, y) = match position {
                crate::model::MacroClickDefinition::Percent {
                    x_percent,
                    y_percent,
                    ..
                } => ("percent", *x_percent, *y_percent),
                crate::model::MacroClickDefinition::Pixels { x_px, y_px, .. } => {
                    ("px", *x_px, *y_px)
                }
                crate::model::MacroClickDefinition::ReferencePixels {
                    x_reference_px,
                    y_reference_px,
                    ..
                } => ("reference-px", *x_reference_px, *y_reference_px),
            };
            perform_actions(
                shared,
                context,
                roles
                    .iter()
                    .map(|role_id| {
                        (
                            role_id.as_str(),
                            BrowserAction::Click {
                                anchor: anchor.clone(),
                                unit: unit.to_owned(),
                                x,
                                y,
                                button: button.as_deref().unwrap_or("left").to_owned(),
                            },
                        )
                    })
                    .collect(),
                false,
            )?;
            for role_id in roles {
                mark_click(shared, context, &definition.id, role_id, id);
            }
            wait_cancelable_for_role(context, role_id, context.settings.post_input_delay_ms)
        }
        MacroStepDefinition::Delay { ms, .. } => wait_cancelable_for_role(context, role_id, *ms),
        MacroStepDefinition::Macro {
            macro_id,
            call_mode,
            ..
        } if call_mode.as_deref() == Some("trigger") => {
            spawn_triggered_macro(shared, context, macro_id.clone(), ancestry.to_owned());
            Ok(())
        }
        MacroStepDefinition::Macro { id, macro_id, .. } => run_synchronous_child_at_barrier(
            shared,
            context,
            macro_id,
            ancestry.to_owned(),
            &format!("{}:{iteration}:{id}", definition.id),
            role_id,
            invocation_role_ids,
        ),
    }
}

fn run_synchronous_child_at_barrier(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
    barrier_key: &str,
    role_id: &str,
    invocation_role_ids: &[String],
) -> Result<(), String> {
    let barrier = {
        let mut barriers = context
            .control
            .barriers
            .lock()
            .map_err(|_| "macro barrier registry lock poisoned".to_owned())?;
        Arc::clone(barriers.entry(barrier_key.to_owned()).or_insert_with(|| {
            Arc::new(InvocationBarrier {
                ready: Condvar::new(),
                state: Mutex::new(InvocationBarrierState::default()),
            })
        }))
    };
    let should_start = {
        let mut state = barrier
            .state
            .lock()
            .map_err(|_| "macro barrier lock poisoned".to_owned())?;
        state.arrived_role_ids.insert(role_id.to_owned());
        let should_start =
            !state.started && state.arrived_role_ids.len() == invocation_role_ids.len();
        if should_start {
            state.started = true;
        }
        should_start
    };
    if should_start {
        let outcome = run_synchronous_child(shared, context, macro_id, ancestry);
        if let Ok(mut state) = barrier.state.lock() {
            state.outcome = Some(outcome.clone());
            barrier.ready.notify_all();
        }
    }
    let mut state = barrier
        .state
        .lock()
        .map_err(|_| "macro barrier lock poisoned".to_owned())?;
    let outcome = loop {
        if let Some(outcome) = &state.outcome {
            break outcome.clone();
        }
        if context.control.cancelled.load(Ordering::Acquire) {
            break Err("macro run cancelled".to_owned());
        }
        state = barrier
            .ready
            .wait(state)
            .map_err(|_| "macro barrier lock poisoned".to_owned())?;
    };
    state.departed_role_ids.insert(role_id.to_owned());
    let should_remove = state.departed_role_ids.len() >= invocation_role_ids.len();
    drop(state);
    if should_remove
        && let Ok(mut barriers) = context.control.barriers.lock()
        && barriers
            .get(barrier_key)
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &barrier))
    {
        barriers.remove(barrier_key);
    }
    outcome
}

fn run_synchronous_child(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: &str,
    ancestry: Vec<String>,
) -> Result<(), String> {
    let child = start_child_invocation(
        shared,
        context,
        macro_id,
        ancestry,
        true,
        &context.control,
        false,
    )?
    .ok_or_else(|| {
        let name = context
            .macros
            .get(macro_id)
            .map(|definition| definition.name.as_str())
            .unwrap_or(macro_id);
        format!("Called macro \"{name}\" is already running.")
    })?;
    loop {
        let wake = context
            .control
            .wake
            .0
            .lock()
            .map_err(|_| "macro wait lock poisoned".to_owned())?;
        if context.control.cancelled.load(Ordering::Acquire) {
            drop(wake);
            cancel_control(&child);
            let wait_result = wait_finished(&child);
            remove_owned_child(&context.control, &child.id);
            wait_result.map_err(|error| error.to_string())?;
            return Err("macro run cancelled".to_owned());
        }
        if child.execution_finished.load(Ordering::Acquire) {
            break;
        }
        drop(
            context
                .control
                .wake
                .1
                .wait(wake)
                .map_err(|_| "macro wait lock poisoned".to_owned())?,
        );
    }
    match child
        .outcome
        .lock()
        .map_err(|_| "child macro outcome lock poisoned".to_owned())?
        .clone()
        .unwrap_or_else(|| Err("child macro outcome is unavailable".to_owned()))
    {
        Ok(()) => Ok(()),
        Err(_error)
            if child.cancelled.load(Ordering::Acquire)
                && child
                    .failed_role_id
                    .lock()
                    .is_ok_and(|failed_role_id| failed_role_id.is_none()) =>
        {
            let message = "Cancelled because a called macro was stopped.".to_owned();
            if let Ok(mut cancellation_error) = context.control.cancellation_error.lock() {
                *cancellation_error = Some(message.clone());
            }
            Err(message)
        }
        Err(error) => Err(error),
    }
}

fn spawn_triggered_macro(
    shared: &Arc<Shared>,
    context: &ExecutionContext,
    macro_id: String,
    ancestry: Vec<String>,
) {
    if let Ok(mut children) = context.control.children.0.lock() {
        children.pending_starts = children.pending_starts.saturating_add(1);
    } else {
        return;
    }
    let shared = Arc::clone(shared);
    let context = context.clone();
    let pending_control = Arc::clone(&context.control);
    let spawn = thread::Builder::new()
        .name("rion-macro-trigger".to_owned())
        .spawn(move || {
            let started = start_child_invocation(
                &shared,
                &context,
                &macro_id,
                ancestry,
                false,
                &context.control,
                true,
            );
            finish_pending_child_start(&context.control);
            let Ok(Some(child)) = started else {
                return;
            };
            if context.control.cancelled.load(Ordering::Acquire)
                || (context.control.terminating.load(Ordering::Acquire)
                    && !context.control.finished_naturally.load(Ordering::Acquire))
            {
                cancel_control(&child);
            }
            let _ = wait_finished(&child);
        });
    finish_pending_child_start_after_spawn(&pending_control, &spawn);
}

fn finish_pending_child_start(control: &InvocationControl) {
    if let Ok(mut children) = control.children.0.lock() {
        children.pending_starts = children.pending_starts.saturating_sub(1);
        control.children.1.notify_all();
    }
}

fn finish_pending_child_start_after_spawn<T, E>(control: &InvocationControl, spawn: &Result<T, E>) {
    if spawn.is_err() {
        finish_pending_child_start(control);
    }
}
