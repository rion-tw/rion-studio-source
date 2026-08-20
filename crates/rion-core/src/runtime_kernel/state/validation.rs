fn validate_state(state: &RuntimeKernelState) -> CoreResult<()> {
    validate_candidate_ownership(&state.windows, &HashSet::new())?;
    for (tab_id, activation) in &state.tab_activations {
        if activation.tab_id.as_str() != tab_id
            || !state
                .windows
                .values()
                .any(|window| window.contains_tab(tab_id))
        {
            return Err(CoreError::Internal(
                "runtime tab activation references missing topology".to_owned(),
            ));
        }
    }
    for (tab_id, tombstone) in &state.tombstones {
        if state
            .windows
            .values()
            .any(|window| window.contains_tab(tab_id))
        {
            return Err(CoreError::Internal(format!(
                "closed runtime tab {} is still present in live topology at revision {}",
                tab_id, tombstone.revision
            )));
        }
        if !state
            .operations
            .contains_key(tombstone.operation_id.as_str())
        {
            return Err(CoreError::Internal(
                "runtime tab tombstone references a missing close operation".to_owned(),
            ));
        }
    }
    for surface in state.logical_surfaces.values() {
        if state.tombstones.contains_key(surface.tab_id.as_str())
            && surface.lifecycle != RuntimeSurfaceLifecycle::Closing
        {
            return Err(CoreError::Internal(
                "closed runtime tab retained a non-teardown logical surface".to_owned(),
            ));
        }
    }
    for window in state.windows.values() {
        validate_window(window)?;
        if window.revision > state.revision {
            return Err(CoreError::Internal(
                "runtime window revision exceeds aggregate revision".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_window(window: &RuntimeLiveWindowRecord) -> CoreResult<()> {
    let tab_ids = window
        .tabs
        .iter()
        .map(|tab| &tab.id)
        .collect::<HashSet<_>>();
    if tab_ids.len() != window.tabs.len() {
        return Err(CoreError::Domain {
            code: "RUNTIME_TAB_DUPLICATE",
            message: "A runtime window contains duplicate tab identities.".to_owned(),
        });
    }
    if window
        .selected_tab_id
        .as_ref()
        .is_some_and(|tab_id| !tab_ids.contains(tab_id) || window.hidden_tab_ids.contains(tab_id))
        || window
            .hidden_tab_ids
            .iter()
            .any(|tab_id| !tab_ids.contains(tab_id))
    {
        return Err(CoreError::Domain {
            code: "RUNTIME_WINDOW_SELECTION_INVALID",
            message: "Runtime window selection or hidden membership is invalid.".to_owned(),
        });
    }
    if window
        .window_zoom_factor
        .is_some_and(|zoom_factor| !zoom_factor.is_finite() || !(0.25..=5.0).contains(&zoom_factor))
    {
        return Err(CoreError::InvalidInput(
            "runtime window zoom factor is invalid".to_owned(),
        ));
    }
    for tab in &window.tabs {
        validate_role_slots(&tab.role_slots)?;
        if tab.workspace_slots.is_empty() {
            continue;
        }
        if tab.tab_type != "workspace"
            || validate_workspace_slots(&tab.workspace_slots, &tab.role_ids)? != tab.role_slots
        {
            return Err(CoreError::InvalidInput(
                "runtime workspace slots do not match role ownership".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_role_zoom(browser_zoom_percent: Option<f64>) -> CoreResult<()> {
    if browser_zoom_percent
        .is_some_and(|percent| !percent.is_finite() || !(25.0..=500.0).contains(&percent))
    {
        return Err(CoreError::InvalidInput(
            "runtime role zoom percent is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_role_slots(role_slots: &[crate::model::GameWindowRoleSlotRecord]) -> CoreResult<()> {
    let mut slot_ids = HashSet::new();
    let mut role_ids = HashSet::new();
    for slot in role_slots {
        let rect = &slot.rect;
        if slot.slot_id.trim().is_empty()
            || slot.role_id.trim().is_empty()
            || !slot_ids.insert(slot.slot_id.as_str())
            || !role_ids.insert(slot.role_id.as_str())
            || [rect.x, rect.y, rect.width, rect.height]
                .iter()
                .any(|value| !value.is_finite())
            || rect.width <= 0.0
            || rect.height <= 0.0
        {
            return Err(CoreError::InvalidInput(
                "runtime role slot is invalid or duplicated".to_owned(),
            ));
        }
        validate_role_zoom(slot.browser_zoom_percent)?;
    }
    Ok(())
}

fn validate_workspace_slots(
    workspace_slots: &[crate::model::StateWorkspaceSlotRecord],
    expected_role_ids: &[String],
) -> CoreResult<Vec<crate::model::GameWindowRoleSlotRecord>> {
    if workspace_slots.is_empty() || workspace_slots.len() > 9 {
        return Err(CoreError::InvalidInput(
            "runtime workspace slots are empty or exceed the layout limit".to_owned(),
        ));
    }
    let mut slot_ids = HashSet::new();
    let mut role_ids = HashSet::new();
    let mut role_slots = Vec::new();
    for slot in workspace_slots {
        let rect = &slot.rect;
        let role_id = slot.role_id.as_deref();
        let web = slot.web.as_ref();
        if slot.id.trim().is_empty()
            || !slot_ids.insert(slot.id.as_str())
            || role_id.is_some_and(str::is_empty)
            || (role_id.is_some() && web.is_some())
            || web.is_some_and(|web| web.name.trim().is_empty() || web.start_url.trim().is_empty())
            || [rect.x, rect.y, rect.width, rect.height]
                .iter()
                .any(|value| !value.is_finite())
            || rect.x < 0.0
            || rect.y < 0.0
            || rect.width <= 0.0
            || rect.height <= 0.0
            || rect.x + rect.width > 1.000_001
            || rect.y + rect.height > 1.000_001
            || (role_id.is_none() && web.is_none() && slot.browser_zoom_percent.is_some())
        {
            return Err(CoreError::InvalidInput(
                "runtime workspace slot is invalid or duplicated".to_owned(),
            ));
        }
        validate_role_zoom(slot.browser_zoom_percent)?;
        if let Some(role_id) = role_id {
            if !role_ids.insert(role_id) {
                return Err(CoreError::InvalidInput(
                    "runtime workspace role slots are duplicated".to_owned(),
                ));
            }
            role_slots.push(crate::model::GameWindowRoleSlotRecord {
                slot_id: slot.id.clone(),
                role_id: role_id.to_owned(),
                rect: slot.rect.clone(),
                browser_zoom_percent: slot.browser_zoom_percent,
            });
        }
    }
    let expected = expected_role_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if role_ids != expected {
        return Err(CoreError::InvalidInput(
            "runtime workspace role slots do not match authoritative role identities".to_owned(),
        ));
    }
    Ok(role_slots)
}
