fn seed_dormant_tabs(
    state: &mut RuntimeKernelState,
    window_id: &str,
    tab_ids: Vec<String>,
) -> CoreResult<RuntimeCommit> {
    let Some(window) = state.windows.get(window_id) else {
        return Ok(superseded_commit(state, None, vec![window_id.to_owned()]));
    };
    if tab_ids
        .iter()
        .any(|tab_id| !window.contains_tab(tab_id.as_str()))
    {
        return Err(CoreError::Domain {
            code: "RUNTIME_DORMANT_TAB_OUTSIDE_WINDOW",
            message: "A dormant tab is outside its restored runtime window.".to_owned(),
        });
    }
    let window_generation = RuntimeWindowGeneration(window.window_generation);
    let mut changed = false;
    for tab_id in tab_ids {
        // SeedDormantTabs is submitted only after the native executor has filtered out tabs
        // with materialized content. A same-generation logical surface can still be left by
        // crash-recovery admission before a hidden/background tab has any native WebView. The
        // explicit dormant seed is therefore the authoritative correction, rather than the
        // logical-surface generation alone being treated as proof of materialization.
        changed |= state.logical_surfaces.remove(&tab_id).is_some();
        let tab_id_value = RuntimeTabId::new(tab_id.clone()).map_err(CoreError::InvalidInput)?;
        let record = RuntimeTabActivationRecord {
            attempt_id: OperationId::new(format!("dormant:{tab_id}"))
                .map_err(CoreError::InvalidInput)?,
            native_operation_id: None,
            owner_window_id: window_id.to_owned(),
            phase: RuntimeTabActivationPhaseRecord::Dormant,
            tab_id: tab_id_value,
            window_generation,
        };
        changed |= state.tab_activations.get(&tab_id) != Some(&record);
        state.tab_activations.insert(tab_id, record);
    }
    if changed {
        let revision = next_revision(state);
        if let Some(window) = state.windows.get_mut(window_id) {
            window.revision = revision;
        }
    }
    Ok(basic_commit(state, false, vec![window_id.to_owned()]))
}

fn activate_tab(
    state: &mut RuntimeKernelState,
    expected_revision: Option<u64>,
    activation_attempt_id: OperationId,
    tab_id: RuntimeTabId,
    window_id: String,
) -> CoreResult<RuntimeCommit> {
    let Some(window) = state.windows.get(&window_id) else {
        return Ok(superseded_commit(
            state,
            Some(activation_attempt_id.as_str().to_owned()),
            vec![window_id],
        ));
    };
    if expected_revision.is_some_and(|expected| expected != window.revision)
        || !window.contains_tab(tab_id.as_str())
        || window.hidden_tab_ids.contains(tab_id.as_str())
    {
        return Ok(superseded_commit(
            state,
            Some(activation_attempt_id.as_str().to_owned()),
            vec![window_id],
        ));
    }
    let window_generation = RuntimeWindowGeneration(window.window_generation);
    let should_launch = state
        .tab_activations
        .get(tab_id.as_str())
        .is_some_and(|activation| {
            matches!(
                activation.phase,
                RuntimeTabActivationPhaseRecord::Dormant | RuntimeTabActivationPhaseRecord::Failed
            )
        });
    let selection_changed = window.selected_tab_id.as_deref() != Some(tab_id.as_str());
    let revision = if selection_changed || should_launch {
        next_revision(state)
    } else {
        state.revision
    };
    if selection_changed {
        state
            .windows
            .get_mut(&window_id)
            .expect("activation candidate was validated")
            .select(Some(tab_id.as_str().to_owned()), revision);
    }
    let desired_effects = if should_launch {
        state.tab_activations.insert(
            tab_id.as_str().to_owned(),
            RuntimeTabActivationRecord {
                attempt_id: activation_attempt_id.clone(),
                native_operation_id: None,
                owner_window_id: window_id.clone(),
                phase: RuntimeTabActivationPhaseRecord::Activating,
                tab_id: tab_id.clone(),
                window_generation,
            },
        );
        if let Some(window) = state.windows.get_mut(&window_id) {
            window.revision = revision;
        }
        vec![RuntimeDesiredEffect::ActivateTab {
            activation_attempt_id: activation_attempt_id.clone(),
            tab_id,
            window_id: window_id.clone(),
        }]
    } else {
        Vec::new()
    };
    Ok(RuntimeCommit {
        desired_effects,
        membership_changed: false,
        operation_id: Some(activation_attempt_id.as_str().to_owned()),
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: Vec::new(),
        window_ids: vec![window_id],
        browser_result: None,
    })
}

fn set_tab_activation_phase(
    state: &mut RuntimeKernelState,
    activation_attempt_id: OperationId,
    tab_id: RuntimeTabId,
    phase: RuntimeTabActivationPhaseRecord,
) -> CoreResult<RuntimeCommit> {
    let window_ids = state
        .windows
        .iter()
        .find_map(|(window_id, window)| {
            window
                .contains_tab(tab_id.as_str())
                .then(|| vec![window_id.clone()])
        })
        .unwrap_or_default();
    let Some(current) = state.tab_activations.get(tab_id.as_str()) else {
        return Ok(superseded_commit(state, None, window_ids));
    };
    if current.attempt_id != activation_attempt_id {
        return Ok(superseded_commit(state, None, window_ids));
    }
    if current.phase == phase {
        return Ok(RuntimeCommit {
            desired_effects: Vec::new(),
            membership_changed: false,
            operation_id: None,
            revision: state.revision,
            status: RuntimeCommitStatus::Duplicate,
            terminal_events: Vec::new(),
            window_ids,
            browser_result: None,
        });
    }
    if !tab_activation_transition_allowed(current.phase, phase) {
        return Ok(superseded_commit(state, None, window_ids));
    }
    state
        .tab_activations
        .get_mut(tab_id.as_str())
        .expect("activation phase candidate was validated")
        .phase = phase;
    let revision = next_revision(state);
    for window_id in &window_ids {
        if let Some(window) = state.windows.get_mut(window_id) {
            window.revision = revision;
        }
    }
    Ok(RuntimeCommit {
        desired_effects: Vec::new(),
        membership_changed: false,
        operation_id: None,
        revision,
        status: RuntimeCommitStatus::Applied,
        terminal_events: Vec::new(),
        window_ids,
        browser_result: None,
    })
}

fn tab_activation_transition_allowed(
    current: RuntimeTabActivationPhaseRecord,
    next: RuntimeTabActivationPhaseRecord,
) -> bool {
    match current {
        RuntimeTabActivationPhaseRecord::Dormant | RuntimeTabActivationPhaseRecord::Failed => false,
        RuntimeTabActivationPhaseRecord::Activating => matches!(
            next,
            RuntimeTabActivationPhaseRecord::Attaching
                | RuntimeTabActivationPhaseRecord::Loading
                | RuntimeTabActivationPhaseRecord::Ready
                | RuntimeTabActivationPhaseRecord::Degraded
                | RuntimeTabActivationPhaseRecord::Failed
        ),
        RuntimeTabActivationPhaseRecord::Attaching => matches!(
            next,
            RuntimeTabActivationPhaseRecord::Loading
                | RuntimeTabActivationPhaseRecord::Ready
                | RuntimeTabActivationPhaseRecord::Degraded
                | RuntimeTabActivationPhaseRecord::Failed
        ),
        RuntimeTabActivationPhaseRecord::Loading => matches!(
            next,
            RuntimeTabActivationPhaseRecord::Ready
                | RuntimeTabActivationPhaseRecord::Degraded
                | RuntimeTabActivationPhaseRecord::Failed
        ),
        RuntimeTabActivationPhaseRecord::Ready => {
            matches!(next, RuntimeTabActivationPhaseRecord::Degraded)
        }
        RuntimeTabActivationPhaseRecord::Degraded => {
            matches!(next, RuntimeTabActivationPhaseRecord::Ready)
        }
    }
}
