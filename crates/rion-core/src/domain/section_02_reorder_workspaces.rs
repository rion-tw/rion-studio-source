pub fn reorder_workspaces(
    workspaces: &mut Vec<StateLaunchWorkspaceRecord>,
    ordered_ids: &[String],
) -> CoreResult<()> {
    if ordered_ids.len() != workspaces.len()
        || ordered_ids.iter().collect::<HashSet<_>>().len() != workspaces.len()
        || ordered_ids
            .iter()
            .any(|id| !workspaces.iter().any(|workspace| &workspace.id == id))
    {
        return Err(domain(
            "WORKSPACE_ORDER_INVALID",
            "Launch workspace order is invalid.",
        ));
    }
    let by_id = workspaces
        .drain(..)
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect::<std::collections::HashMap<_, _>>();
    *workspaces = ordered_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    Ok(())
}

pub fn delete_workspace(
    workspaces: &mut Vec<StateLaunchWorkspaceRecord>,
    id: &str,
) -> CoreResult<()> {
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.id != id);
    if original_len == workspaces.len() {
        return Err(domain("WORKSPACE_NOT_FOUND", "Launch workspace not found."));
    }
    Ok(())
}

pub fn create_game_window(
    game_windows: &mut Vec<StateGameWindowRecord>,
    input: GameWindowCreateInputRecord,
) -> CoreResult<StateGameWindowRecord> {
    if game_windows.len() >= 32 {
        return Err(domain(
            "GAME_WINDOW_LIMIT_REACHED",
            "No more than 32 game windows can be saved.",
        ));
    }
    let name = normalize_name(
        &input.name,
        "GAME_WINDOW_NAME_REQUIRED",
        "GAME_WINDOW_NAME_TOO_LONG",
    )?;
    ensure_unique_game_window_name(game_windows, &name, None)?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if game_windows.iter().any(|window| window.id == id) {
        return Err(domain(
            "GAME_WINDOW_ID_CONFLICT",
            "Game window id is already in use.",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let game_window = normalize_game_window(StateGameWindowRecord {
        id,
        name,
        target_display: input.target_display,
        placement: input.placement,
        tabs: Vec::new(),
        active_tab_id: None,
        created_at: now.clone(),
        updated_at: now,
    })?;
    let mut candidate = game_windows.clone();
    candidate.push(game_window.clone());
    validate_game_window_collection(&candidate)?;
    game_windows.push(game_window.clone());
    Ok(game_window)
}

pub fn update_game_window(
    game_windows: &mut [StateGameWindowRecord],
    id: &str,
    input: GameWindowUpdateInputRecord,
) -> CoreResult<StateGameWindowRecord> {
    let index = game_windows
        .iter()
        .position(|window| window.id == id)
        .ok_or_else(|| domain("GAME_WINDOW_NOT_FOUND", "Game window not found."))?;
    let current = game_windows[index].clone();
    let name = input
        .name
        .as_deref()
        .map(|name| {
            normalize_name(
                name,
                "GAME_WINDOW_NAME_REQUIRED",
                "GAME_WINDOW_NAME_TOO_LONG",
            )
        })
        .transpose()?
        .unwrap_or_else(|| current.name.clone());
    ensure_unique_game_window_name(game_windows, &name, Some(id))?;
    let tabs = input.tabs.unwrap_or_else(|| current.tabs.clone());
    let active_tab_id = input.active_tab_id.unwrap_or_else(|| {
        current
            .active_tab_id
            .filter(|active| tabs.iter().any(|tab| &tab.id == active))
    });
    let game_window = normalize_game_window(StateGameWindowRecord {
        id: current.id,
        name,
        target_display: input.target_display.unwrap_or(current.target_display),
        placement: input.placement.unwrap_or(current.placement),
        tabs,
        active_tab_id,
        created_at: current.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
    })?;
    let mut candidate = game_windows.to_vec();
    candidate[index] = game_window.clone();
    validate_game_window_collection(&candidate)?;
    game_windows[index] = game_window.clone();
    Ok(game_window)
}

pub fn save_runtime_game_window(
    game_windows: &mut Vec<StateGameWindowRecord>,
    input: GameWindowSaveRuntimeInputRecord,
) -> CoreResult<StateGameWindowRecord> {
    if let Some(existing) = game_windows
        .iter()
        .find(|window| window.id == input.window_id)
    {
        return Ok(existing.clone());
    }

    let GameWindowSaveRuntimeInputRecord {
        window_id,
        name,
        target_display,
        placement,
        tabs,
        active_tab_id,
    } = input;
    let mut candidate = game_windows.clone();
    create_game_window(
        &mut candidate,
        GameWindowCreateInputRecord {
            id: Some(window_id.clone()),
            name,
            target_display,
            placement,
        },
    )?;
    let saved = update_game_window(
        &mut candidate,
        &window_id,
        GameWindowUpdateInputRecord {
            tabs: Some(tabs),
            active_tab_id: Some(active_tab_id),
            ..GameWindowUpdateInputRecord::default()
        },
    )?;
    *game_windows = candidate;
    Ok(saved)
}

pub fn reorder_game_windows(
    game_windows: &mut Vec<StateGameWindowRecord>,
    ordered_ids: &[String],
) -> CoreResult<()> {
    if ordered_ids.len() != game_windows.len()
        || ordered_ids.iter().collect::<HashSet<_>>().len() != game_windows.len()
        || ordered_ids
            .iter()
            .any(|id| !game_windows.iter().any(|window| &window.id == id))
    {
        return Err(domain(
            "GAME_WINDOW_ORDER_INVALID",
            "Game window order is invalid.",
        ));
    }
    let by_id = game_windows
        .drain(..)
        .map(|window| (window.id.clone(), window))
        .collect::<HashMap<_, _>>();
    *game_windows = ordered_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    Ok(())
}

pub fn delete_game_window(
    game_windows: &mut Vec<StateGameWindowRecord>,
    id: &str,
) -> CoreResult<()> {
    let original_len = game_windows.len();
    game_windows.retain(|window| window.id != id);
    if original_len == game_windows.len() {
        return Err(domain("GAME_WINDOW_NOT_FOUND", "Game window not found."));
    }
    Ok(())
}

pub fn delete_game_window_if_unchanged(
    game_windows: &mut Vec<StateGameWindowRecord>,
    id: &str,
    updated_at: &str,
) -> bool {
    let Some(index) = game_windows
        .iter()
        .position(|window| window.id == id && window.updated_at == updated_at)
    else {
        return false;
    };
    game_windows.remove(index);
    true
}

pub fn validate_game_window_collection(game_windows: &[StateGameWindowRecord]) -> CoreResult<()> {
    if game_windows.len() > 32 {
        return Err(domain(
            "GAME_WINDOW_LIMIT_REACHED",
            "No more than 32 game windows can be saved.",
        ));
    }
    let mut names = HashSet::new();
    let mut window_ids = HashSet::new();
    let mut tab_count = 0usize;
    for window in game_windows {
        normalize_game_window(window.clone())?;
        if !window_ids.insert(window.id.clone()) {
            return Err(domain(
                "GAME_WINDOW_ID_DUPLICATE",
                "Game window id is already in use.",
            ));
        }
        if !names.insert(window.name.to_lowercase()) {
            return Err(domain(
                "GAME_WINDOW_NAME_DUPLICATE",
                "A game window with this name already exists.",
            ));
        }
        let mut source_keys = HashSet::new();
        for tab in &window.tabs {
            tab_count += 1;
            let source_key = format!("{}:{}", tab.tab_type, tab.source_id);
            if !source_keys.insert(source_key) {
                return Err(domain(
                    "GAME_WINDOW_TAB_CONFLICT",
                    "A saved game window cannot contain the same tab source twice.",
                ));
            }
        }
    }
    if tab_count > 256 {
        return Err(domain(
            "GAME_WINDOW_TAB_LIMIT_REACHED",
            "No more than 256 game-window tabs can be saved.",
        ));
    }
    Ok(())
}

fn ensure_unique_game_window_name(
    game_windows: &[StateGameWindowRecord],
    name: &str,
    except_id: Option<&str>,
) -> CoreResult<()> {
    if game_windows.iter().any(|window| {
        Some(window.id.as_str()) != except_id && window.name.eq_ignore_ascii_case(name)
    }) {
        return Err(domain(
            "GAME_WINDOW_NAME_DUPLICATE",
            "A game window with this name already exists.",
        ));
    }
    Ok(())
}

fn normalize_game_window(mut window: StateGameWindowRecord) -> CoreResult<StateGameWindowRecord> {
    window.id = Uuid::parse_str(window.id.trim())
        .map_err(|_| domain("GAME_WINDOW_ID_INVALID", "Game window id is invalid."))?
        .to_string();
    window.name = normalize_name(
        &window.name,
        "GAME_WINDOW_NAME_REQUIRED",
        "GAME_WINDOW_NAME_TOO_LONG",
    )?;
    window.target_display = validate_display_target(window.target_display)?;
    window.placement = normalize_game_window_placement(window.placement)?;
    let mut tab_ids = HashSet::new();
    for tab in &mut window.tabs {
        tab.id = Uuid::parse_str(tab.id.trim())
            .map_err(|_| domain("GAME_WINDOW_TAB_INVALID", "Game window tab is invalid."))?
            .to_string();
        if !tab_ids.insert(tab.id.clone())
            || !matches!(tab.tab_type.as_str(), "role" | "workspace")
            || tab.source_id.trim().is_empty()
            || tab.source_id.len() > 128
        {
            return Err(domain(
                "GAME_WINDOW_TAB_INVALID",
                "Game window tab is invalid.",
            ));
        }
        tab.source_id = tab.source_id.trim().to_owned();
        tab.name = tab.name.trim().chars().take(256).collect();
        if tab.name.is_empty() {
            tab.name = tab.source_id.clone();
        }
        let mut role_ids = HashSet::new();
        let mut slot_ids = HashSet::new();
        for slot in &mut tab.role_slots {
            slot.slot_id = slot.slot_id.trim().to_owned();
            slot.role_id = slot.role_id.trim().to_owned();
            let rect = &slot.rect;
            if slot.slot_id.is_empty()
                || slot.slot_id.len() > 256
                || !slot_ids.insert(slot.slot_id.clone())
                || slot.role_id.is_empty()
                || slot.role_id.len() > 128
                || !role_ids.insert(slot.role_id.clone())
                || !rect.x.is_finite()
                || !rect.y.is_finite()
                || !rect.width.is_finite()
                || !rect.height.is_finite()
                || rect.x < 0.0
                || rect.y < 0.0
                || rect.width <= 0.0
                || rect.height <= 0.0
                || rect.x + rect.width > 1.000_001
                || rect.y + rect.height > 1.000_001
                || slot.browser_zoom_percent.is_some_and(|percent| {
                    !percent.is_finite() || !(25.0..=500.0).contains(&percent)
                })
            {
                return Err(domain(
                    "GAME_WINDOW_TAB_LAYOUT_INVALID",
                    "Game window tab role slots are invalid or duplicated.",
                ));
            }
        }
        if tab.role_slots.is_empty()
            || (tab.tab_type == "role"
                && (tab.role_slots.len() != 1
                    || tab.role_slots[0].role_id != tab.source_id))
        {
            return Err(domain(
                "GAME_WINDOW_TAB_INVALID",
                "A role tab must contain exactly its source role.",
            ));
        }
    }
    window.active_tab_id = if window.tabs.is_empty() {
        None
    } else {
        window
            .active_tab_id
            .filter(|active| {
                window
                    .tabs
                    .iter()
                    .any(|tab| &tab.id == active && !tab.hidden)
            })
            .or_else(|| {
                window
                    .tabs
                    .iter()
                    .find(|tab| !tab.hidden)
                    .map(|tab| tab.id.clone())
            })
    };
    Ok(window)
}

fn normalize_game_window_placement(
    mut placement: GameWindowPlacementRecord,
) -> CoreResult<GameWindowPlacementRecord> {
    if placement.saved_work_area.width <= 0
        || placement.saved_work_area.height <= 0
        || placement.normal_bounds.width <= 0
        || placement.normal_bounds.height <= 0
        || !matches!(
            placement.presentation.as_str(),
            "normal" | "maximized" | "fullscreen"
        )
    {
        return Err(domain(
            "GAME_WINDOW_PLACEMENT_INVALID",
            "Game window placement is invalid.",
        ));
    }
    let area = &placement.saved_work_area;
    placement.normal_bounds.width = placement
        .normal_bounds
        .width
        .max(640.min(area.width))
        .min(area.width);
    placement.normal_bounds.height = placement
        .normal_bounds
        .height
        .max(480.min(area.height))
        .min(area.height);
    let max_x = area
        .x
        .saturating_add(area.width.saturating_sub(placement.normal_bounds.width));
    let max_y = area
        .y
        .saturating_add(area.height.saturating_sub(placement.normal_bounds.height));
    placement.normal_bounds.x = placement.normal_bounds.x.clamp(area.x, max_x);
    placement.normal_bounds.y = placement.normal_bounds.y.clamp(area.y, max_y);
    Ok(placement)
}

pub fn clear_workspace_role(workspaces: &mut [StateLaunchWorkspaceRecord], role_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    for workspace in workspaces {
        let mut changed = false;
        for slot in &mut workspace.slots {
            if slot.role_id.as_deref() == Some(role_id) {
                slot.role_id = None;
                changed = true;
            }
        }
        if changed {
            workspace.updated_at = now.clone();
        }
    }
}

pub fn set_workspace_role_browser_zoom(
    workspaces: &mut [StateLaunchWorkspaceRecord],
    workspace_id: &str,
    role_id: &str,
    browser_zoom_percent: f64,
) -> CoreResult<Option<StateLaunchWorkspaceRecord>> {
    let Some(workspace) = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
    else {
        return Ok(None);
    };
    let Some(slot) = workspace
        .slots
        .iter_mut()
        .find(|slot| slot.role_id.as_deref() == Some(role_id))
    else {
        return Ok(None);
    };
    let browser_zoom_percent = normalize_workspace_slot_zoom(browser_zoom_percent)?;
    if slot.browser_zoom_percent != Some(browser_zoom_percent) {
        slot.browser_zoom_percent = Some(browser_zoom_percent);
        workspace.updated_at = chrono::Utc::now().to_rfc3339();
    }
    Ok(Some(workspace.clone()))
}

pub fn create_macro(
    macros: &mut Vec<StateMacroRecord>,
    input: MacroCreateInputRecord,
) -> CoreResult<StateMacroRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let trigger = input.trigger.map(normalize_macro_trigger).transpose()?;
    let shortcut_source_scope = normalize_macro_shortcut_source_scope(
        input.shortcut_source_scope,
        trigger.is_some(),
    )?;
    let macro_record = StateMacroRecord {
        id: Uuid::new_v4().to_string(),
        enabled: input.enabled.unwrap_or(true),
        activation_mode: Some(normalize_macro_activation_mode(
            input.activation_mode.as_deref(),
        )?),
        name: normalize_name(&input.name, "MACRO_NAME_REQUIRED", "MACRO_NAME_TOO_LONG")?,
        role_ids: normalize_macro_role_ids(input.role_ids)?,
        shortcut_source_scope,
        trigger,
        repeat: normalize_macro_repeat(input.repeat)?,
        steps: normalize_macro_steps(input.steps)?,
        created_at: now.clone(),
        updated_at: now,
    };
    validate_macro_candidate(macros, &macro_record, None)?;
    let mut next = macros.clone();
    next.push(macro_record.clone());
    validate_macro_records_graph(&next)?;
    macros.push(macro_record.clone());
    Ok(macro_record)
}

pub fn update_macro(
    macros: &mut [StateMacroRecord],
    id: &str,
    input: MacroUpdateInputRecord,
) -> CoreResult<StateMacroRecord> {
    let index = macros
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| domain("MACRO_NOT_FOUND", "Macro not found."))?;
    let current = macros[index].clone();
    let trigger = if input.set_trigger {
        input.trigger.map(normalize_macro_trigger).transpose()?
    } else {
        current.trigger.clone()
    };
    let shortcut_source_scope = normalize_macro_shortcut_source_scope(
        input
            .shortcut_source_scope
            .or_else(|| Some(current.shortcut_source_scope.clone())),
        trigger.is_some(),
    )?;
    let macro_record = StateMacroRecord {
        id: current.id.clone(),
        enabled: input.enabled.unwrap_or(current.enabled),
        activation_mode: input
            .activation_mode
            .as_deref()
            .map(|mode| normalize_macro_activation_mode(Some(mode)))
            .transpose()?
            .map(Some)
            .unwrap_or(current.activation_mode.clone()),
        name: input
            .name
            .as_deref()
            .map(|name| normalize_name(name, "MACRO_NAME_REQUIRED", "MACRO_NAME_TOO_LONG"))
            .transpose()?
            .unwrap_or_else(|| current.name.clone()),
        role_ids: input
            .role_ids
            .map(normalize_macro_role_ids)
            .transpose()?
            .unwrap_or_else(|| current.role_ids.clone()),
        shortcut_source_scope,
        trigger,
        repeat: input
            .repeat
            .map(|repeat| normalize_macro_repeat(Some(repeat)))
            .transpose()?
            .unwrap_or_else(|| current.repeat.clone()),
        steps: input
            .steps
            .map(normalize_macro_steps)
            .transpose()?
            .unwrap_or_else(|| current.steps.clone()),
        created_at: current.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    validate_macro_candidate(macros, &macro_record, Some(id))?;
    let mut next = macros.to_vec();
    next[index] = macro_record.clone();
    validate_macro_records_graph(&next)?;
    macros[index] = macro_record.clone();
    Ok(macro_record)
}

pub fn delete_macro(macros: &mut Vec<StateMacroRecord>, id: &str) -> CoreResult<()> {
    if !macros.iter().any(|item| item.id == id) {
        return Err(domain("MACRO_NOT_FOUND", "Macro not found."));
    }
    let referrers = macro_referrer_names(macros, id, &HashSet::new());
    if !referrers.is_empty() {
        return Err(domain(
            "MACRO_IN_USE",
            &format!("Macro is used by: {}.", referrers.join(", ")),
        ));
    }
    macros.retain(|item| item.id != id);
    Ok(())
}

type MacroBulkDeleteResult = (Vec<String>, Vec<(String, String, Vec<String>)>);

pub fn delete_macros(macros: &mut Vec<StateMacroRecord>, ids: &[String]) -> MacroBulkDeleteResult {
    let requested = ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let existing = macros
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let mut deletable = requested
        .iter()
        .filter(|id| existing.contains(*id))
        .cloned()
        .collect::<HashSet<_>>();
    loop {
        let before = deletable.len();
        for id in deletable.clone() {
            if !macro_referrer_names(macros, &id, &deletable).is_empty() {
                deletable.remove(&id);
            }
        }
        if deletable.len() == before {
            break;
        }
    }
    let deleted = requested
        .iter()
        .filter(|id| deletable.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let skipped = requested
        .iter()
        .filter(|id| !deletable.contains(*id))
        .map(|id| {
            if existing.contains(id) {
                (
                    id.clone(),
                    "in_use".to_owned(),
                    macro_referrer_names(macros, id, &deletable),
                )
            } else {
                (id.clone(), "not_found".to_owned(), Vec::new())
            }
        })
        .collect();
    macros.retain(|item| !deletable.contains(&item.id));
    (deleted, skipped)
}

pub fn clear_macro_role(macros: &mut [StateMacroRecord], role_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    for macro_record in macros {
        let before = macro_record.clone();
        macro_record.role_ids.retain(|id| id != role_id);
        let removed_last_selected_source = if let MacroShortcutSourceScope::SelectedRoles {
            role_ids,
        } = &mut macro_record.shortcut_source_scope
        {
            let was_source = role_ids.iter().any(|id| id == role_id);
            role_ids.retain(|id| id != role_id);
            was_source && role_ids.is_empty()
        } else {
            false
        };
        if removed_last_selected_source {
            macro_record.trigger = None;
            macro_record.shortcut_source_scope = MacroShortcutSourceScope::AllExecutionRoles;
            if macro_record.activation_mode.as_deref() == Some("while_held") {
                macro_record.activation_mode = Some("toggle".to_owned());
            }
        }
        if macro_record.role_ids != before.role_ids
            || macro_record.shortcut_source_scope != before.shortcut_source_scope
            || macro_record.trigger != before.trigger
            || macro_record.activation_mode != before.activation_mode
        {
            macro_record.updated_at = now.clone();
        }
    }
}

fn normalize_workspace_template(value: Option<&str>) -> CoreResult<String> {
    let value = value.unwrap_or("two_columns");
    if matches!(
        value,
        "single"
            | "two_columns"
            | "three_columns"
            | "main_left_stack_right"
            | "main_right_stack_left"
            | "main_center_side_stacks"
            | "three_top_two_bottom"
            | "two_top_three_bottom"
            | "quad"
            | "four_columns"
            | "six_grid"
            | "eight_grid"
            | "nine_grid"
    ) {
        Ok(value.to_owned())
    } else {
        Err(domain(
            "WORKSPACE_TEMPLATE_INVALID",
            "Launch workspace layout is invalid.",
        ))
    }
}

fn workspace_template_slot_count(template: &str) -> usize {
    match template {
        "single" => 1,
        "two_columns" => 2,
        "three_columns" | "main_left_stack_right" | "main_right_stack_left" => 3,
        "quad" | "four_columns" => 4,
        "main_center_side_stacks" | "three_top_two_bottom" | "two_top_three_bottom" => 5,
        "six_grid" => 6,
        "eight_grid" => 8,
        "nine_grid" => 9,
        _ => unreachable!("workspace template was normalized"),
    }
}
