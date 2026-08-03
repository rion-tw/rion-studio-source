fn all_selection() -> PortableDataSelectionRecord {
    PortableDataSelectionRecord {
        games: true,
        roles: true,
        launch_workspaces: true,
        game_windows: true,
        macros: true,
        preferences: true,
    }
}

fn normalize_selection(mut selection: PortableDataSelectionRecord) -> PortableDataSelectionRecord {
    if selection.launch_workspaces || selection.game_windows || selection.macros {
        selection.roles = true;
    }
    if selection.game_windows {
        selection.launch_workspaces = true;
    }
    if selection.roles {
        selection.games = true;
    }
    selection
}

fn effective_selection(
    data: &PortableDataRecord,
    selection: &PortableDataSelectionRecord,
) -> PortableDataSelectionRecord {
    PortableDataSelectionRecord {
        games: selection.games && !data.games.is_empty(),
        roles: selection.roles && !data.roles.is_empty(),
        launch_workspaces: selection.launch_workspaces && !data.launch_workspaces.is_empty(),
        game_windows: selection.game_windows && !data.game_windows.is_empty(),
        macros: selection.macros && !data.macros.is_empty(),
        preferences: selection.preferences && data.preferences.is_some(),
    }
}

fn ensure_selected_content(
    data: &PortableDataRecord,
    selection: &PortableDataSelectionRecord,
) -> CoreResult<()> {
    let effective = effective_selection(data, selection);
    if effective.games
        || effective.roles
        || effective.launch_workspaces
        || effective.game_windows
        || effective.macros
        || effective.preferences
    {
        Ok(())
    } else {
        Err(CoreError::Domain {
            code: "PORTABLE_SELECTION_EMPTY",
            message: "Select at least one available data category.".to_owned(),
        })
    }
}

fn validate_preferences(preferences: Option<&PortablePreferencesRecord>) -> CoreResult<()> {
    let Some(preferences) = preferences else {
        return Ok(());
    };
    if preferences
        .language
        .as_deref()
        .is_some_and(|language| !matches!(language, "en" | "zh-TW" | "zh-CN" | "ja"))
        || preferences
            .theme_mode
            .as_deref()
            .is_some_and(|theme| !matches!(theme, "system" | "light" | "dark"))
    {
        return Err(invalid("portable preferences are invalid"));
    }
    if let Some(settings) = &preferences.game_browser_settings {
        validate_game_browser_settings(settings)?;
    }
    if let Some(settings) = &preferences.macro_settings {
        validate_macro_settings(settings)?;
    }
    Ok(())
}

fn processed_count(summary: &crate::model::PortableImportOperationSummaryRecord) -> u32 {
    summary.create + summary.update + summary.unchanged
}

fn warning(
    code: &str,
    item_name: Option<String>,
    replacement_name: Option<String>,
    count: Option<u32>,
) -> PortableImportWarningRecord {
    PortableImportWarningRecord {
        code: code.to_owned(),
        item_name,
        replacement_name,
        count,
    }
}

fn reserve_import_name(name: &str, used: &mut HashSet<String>) -> CoreResult<String> {
    let normalized = name.trim();
    if used.insert(normalize_name_key(normalized)) {
        return Ok(normalized.to_owned());
    }
    for index in 1..10_000 {
        let suffix = if index == 1 {
            " (Imported)".to_owned()
        } else {
            format!(" (Imported {index})")
        };
        let max_base = 80_usize.saturating_sub(suffix.chars().count()).max(1);
        let base = normalized.chars().take(max_base).collect::<String>();
        let candidate = format!("{}{suffix}", base.trim());
        if used.insert(normalize_name_key(&candidate)) {
            return Ok(candidate);
        }
    }
    Err(CoreError::Domain {
        code: "PORTABLE_NAME_CONFLICT",
        message: "Unable to create a unique imported name.".to_owned(),
    })
}

fn builtin_by_key(key: &str) -> Option<&'static BuiltinGame> {
    BUILTIN_GAMES.iter().find(|game| game.key == key)
}

fn portable_game(game: &StateGameRecord) -> PortableGameRecord {
    PortableGameRecord {
        id: game.id.clone(),
        inferred: None,
        source: game.source.clone(),
        builtin_key: game.builtin_key.clone(),
        name: game.name.clone(),
        icon_image_data_url: game.icon_image_data_url.clone(),
        cover_image_data_url: game.cover_image_data_url.clone(),
        default_launch_url: game.default_launch_url.clone(),
    }
}

fn portable_role(role: &StateRoleRecord) -> PortableRoleRecord {
    PortableRoleRecord {
        id: role.id.clone(),
        game_id: Some(role.game_id.clone()),
        game_recovered: None,
        name: role.name.clone(),
        launch_url: role.launch_url.clone(),
        notes: role.notes.clone(),
        cover_image_data_url: role.cover_image_data_url.clone(),
        cover_image_dominant_color: role.cover_image_dominant_color.clone(),
    }
}

fn portable_workspace(workspace: &StateLaunchWorkspaceRecord) -> PortableLaunchWorkspaceRecord {
    PortableLaunchWorkspaceRecord {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        template: workspace.template.clone(),
        slots: workspace.slots.clone(),
    }
}

fn portable_game_window(window: &StateGameWindowRecord) -> PortableGameWindowRecord {
    PortableGameWindowRecord {
        id: window.id.clone(),
        name: window.name.clone(),
        target_display: window.target_display.clone(),
        placement: window.placement.clone(),
        tabs: window.tabs.clone(),
        active_tab_id: window.active_tab_id.clone(),
    }
}

fn portable_macro(macro_record: &StateMacroRecord) -> PortableMacroRecord {
    let mut role_ids = macro_record.role_ids.clone();
    role_ids.sort();
    let mut shortcut_source_scope = macro_record.shortcut_source_scope.clone();
    if let MacroShortcutSourceScope::SelectedRoles { role_ids } = &mut shortcut_source_scope {
        role_ids.sort();
    }
    PortableMacroRecord {
        id: macro_record.id.clone(),
        enabled: macro_record.enabled,
        activation_mode: macro_record
            .activation_mode
            .clone()
            .unwrap_or_else(|| "toggle".to_owned()),
        name: macro_record.name.clone(),
        role_ids,
        shortcut_source_scope,
        trigger: macro_record.trigger.clone(),
        repeat: macro_record.repeat.clone(),
        steps: macro_record.steps.clone(),
    }
}

fn game_equivalent(left: &StateGameRecord, right: &StateGameRecord) -> CoreResult<bool> {
    json_equal(&portable_game(left), &portable_game(right))
}

fn role_equivalent(left: &StateRoleRecord, right: &StateRoleRecord) -> CoreResult<bool> {
    json_equal(&portable_role(left), &portable_role(right))
}

fn workspace_equivalent(
    left: &StateLaunchWorkspaceRecord,
    right: &StateLaunchWorkspaceRecord,
) -> CoreResult<bool> {
    json_equal(&portable_workspace(left), &portable_workspace(right))
}

fn game_window_equivalent(
    left: &StateGameWindowRecord,
    right: &StateGameWindowRecord,
) -> CoreResult<bool> {
    json_equal(&portable_game_window(left), &portable_game_window(right))
}

fn macro_equivalent(left: &StateMacroRecord, right: &StateMacroRecord) -> CoreResult<bool> {
    json_equal(&portable_macro(left), &portable_macro(right))
}

fn json_equal<T: serde::Serialize>(left: &T, right: &T) -> CoreResult<bool> {
    let left =
        serde_json::to_value(left).map_err(|error| CoreError::Internal(error.to_string()))?;
    let right =
        serde_json::to_value(right).map_err(|error| CoreError::Internal(error.to_string()))?;
    Ok(left == right)
}

fn role_identity(game_id: &str, name: &str) -> String {
    format!("{game_id}\0{}", normalize_name_key(name))
}

fn assert_unique_role_names(roles: &[StateRoleRecord]) -> CoreResult<()> {
    let mut seen = HashSet::new();
    if roles
        .iter()
        .any(|role| !seen.insert(role_identity(&role.game_id, &role.name)))
    {
        Err(role_name_conflict())
    } else {
        Ok(())
    }
}

fn role_name_conflict() -> CoreError {
    CoreError::Domain {
        code: "PORTABLE_ROLE_NAME_CONFLICT",
        message: "Multiple roles share a name in the same game. Rename or remove duplicates before importing."
            .to_owned(),
    }
}

fn role_game_missing() -> CoreError {
    CoreError::Domain {
        code: "PORTABLE_ROLE_GAME_MISSING",
        message: "Imported role game is unavailable.".to_owned(),
    }
}

fn import_expired() -> CoreError {
    CoreError::Domain {
        code: "PORTABLE_IMPORT_EXPIRED",
        message: "Portable import session expired. Choose the JSON file again.".to_owned(),
    }
}

fn template_slot_count(template: &str) -> CoreResult<usize> {
    match template {
        "single" => Ok(1),
        "two_columns" => Ok(2),
        "three_columns" | "main_left_stack_right" | "main_right_stack_left" => Ok(3),
        "quad" | "four_columns" => Ok(4),
        "main_center_side_stacks" | "three_top_two_bottom" | "two_top_three_bottom" => Ok(5),
        "six_grid" => Ok(6),
        "eight_grid" => Ok(8),
        "nine_grid" => Ok(9),
        _ => Err(invalid("portable workspace template is invalid")),
    }
}

fn default_rects(template: &str) -> CoreResult<Vec<StateNormalizedRectRecord>> {
    let rect = |x, y, width, height| StateNormalizedRectRecord {
        x,
        y,
        width,
        height,
    };
    Ok(match template {
        "single" => vec![rect(0.0, 0.0, 1.0, 1.0)],
        "two_columns" => equal_columns(2),
        "three_columns" => equal_columns(3),
        "main_left_stack_right" => vec![
            rect(0.0, 0.0, 0.5, 1.0),
            rect(0.5, 0.0, 0.5, 0.5),
            rect(0.5, 0.5, 0.5, 0.5),
        ],
        "main_right_stack_left" => vec![
            rect(0.5, 0.0, 0.5, 1.0),
            rect(0.0, 0.0, 0.5, 0.5),
            rect(0.0, 0.5, 0.5, 0.5),
        ],
        "main_center_side_stacks" => vec![
            rect(0.3, 0.0, 0.4, 1.0),
            rect(0.0, 0.0, 0.3, 0.5),
            rect(0.0, 0.5, 0.3, 0.5),
            rect(0.7, 0.0, 0.3, 0.5),
            rect(0.7, 0.5, 0.3, 0.5),
        ],
        "three_top_two_bottom" => split_rows(3, 2),
        "two_top_three_bottom" => split_rows(2, 3),
        "quad" => grid_rects(2, 2),
        "four_columns" => equal_columns(4),
        "six_grid" => grid_rects(3, 2),
        "eight_grid" => grid_rects(4, 2),
        "nine_grid" => grid_rects(3, 3),
        _ => return Err(invalid("portable workspace template is invalid")),
    })
}

fn equal_columns(columns: usize) -> Vec<StateNormalizedRectRecord> {
    let width = 1.0 / columns as f64;
    (0..columns)
        .map(|index| StateNormalizedRectRecord {
            x: index as f64 * width,
            y: 0.0,
            width,
            height: 1.0,
        })
        .collect()
}

fn grid_rects(columns: usize, rows: usize) -> Vec<StateNormalizedRectRecord> {
    let width = 1.0 / columns as f64;
    let height = 1.0 / rows as f64;
    (0..rows)
        .flat_map(|row| {
            (0..columns).map(move |column| StateNormalizedRectRecord {
                x: column as f64 * width,
                y: row as f64 * height,
                width,
                height,
            })
        })
        .collect()
}

fn split_rows(top: usize, bottom: usize) -> Vec<StateNormalizedRectRecord> {
    let row = |count: usize, y: f64| {
        let width = 1.0 / count as f64;
        (0..count)
            .map(|index| StateNormalizedRectRecord {
                x: index as f64 * width,
                y,
                width,
                height: 0.5,
            })
            .collect::<Vec<_>>()
    };
    row(top, 0.0).into_iter().chain(row(bottom, 0.5)).collect()
}

fn macro_identity(name: &str, role_ids: &[String]) -> String {
    let mut role_ids = role_ids.to_vec();
    role_ids.sort();
    format!("{}\0{}", normalize_name_key(name), role_ids.join("\0"))
}

fn resolution_conflict_id(resolution: &PortableMacroConflictResolutionRecord) -> &str {
    match resolution {
        PortableMacroConflictResolutionRecord::Update { conflict_id, .. }
        | PortableMacroConflictResolutionRecord::Copy { conflict_id }
        | PortableMacroConflictResolutionRecord::Skip { conflict_id } => conflict_id,
    }
}

fn portable_conflict(
    conflict_id: &str,
    source: &PortableMacroRecord,
    role_ids: &[String],
    candidates: &[StateMacroRecord],
    roles: &[StateRoleRecord],
) -> PortableMacroConflictRecord {
    let role_names = roles
        .iter()
        .map(|role| (role.id.as_str(), role.name.as_str()))
        .collect::<HashMap<_, _>>();
    let names = |ids: &[String]| {
        ids.iter()
            .map(|id| {
                role_names
                    .get(id.as_str())
                    .copied()
                    .unwrap_or(id)
                    .to_owned()
            })
            .collect()
    };
    PortableMacroConflictRecord {
        id: conflict_id.to_owned(),
        macro_id: source.id.clone(),
        name: source.name.clone(),
        role_names: names(role_ids),
        candidates: candidates
            .iter()
            .map(|candidate| PortableMacroConflictCandidateRecord {
                id: candidate.id.clone(),
                name: candidate.name.clone(),
                role_names: names(&candidate.role_ids),
                step_count: candidate.steps.len() as u32,
                trigger: candidate.trigger.clone(),
                updated_at: candidate.updated_at.clone(),
            })
            .collect(),
    }
}

fn remap_macro_step(
    step: MacroStepDefinition,
    id_map: &HashMap<String, String>,
) -> CoreResult<MacroStepDefinition> {
    match step {
        MacroStepDefinition::Macro {
            id,
            macro_id,
            call_mode,
        } => Ok(MacroStepDefinition::Macro {
            id,
            macro_id: id_map
                .get(&macro_id)
                .cloned()
                .ok_or_else(|| CoreError::Domain {
                    code: "PORTABLE_MACRO_DEPENDENCY_INVALID",
                    message: "Imported macro dependencies are invalid.".to_owned(),
                })?,
            call_mode,
        }),
        other => Ok(other),
    }
}

fn validate_macro_records(macros: &[StateMacroRecord]) -> CoreResult<()> {
    let values = macros
        .iter()
        .map(|macro_record| {
            serde_json::to_value(macro_record)
                .map_err(|error| CoreError::Internal(error.to_string()))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    validate_macro_graph(&values)
}

fn macro_depends_on(macros: &[StateMacroRecord], source_id: &str, target_id: &str) -> bool {
    fn visit(
        by_id: &HashMap<&str, &StateMacroRecord>,
        current: &str,
        target: &str,
        visited: &mut HashSet<String>,
    ) -> bool {
        if !visited.insert(current.to_owned()) {
            return false;
        }
        by_id.get(current).is_some_and(|macro_record| {
            macro_record.steps.iter().any(|step| match step {
                MacroStepDefinition::Macro { macro_id, .. } => {
                    macro_id == target || visit(by_id, macro_id, target, visited)
                }
                _ => false,
            })
        })
    }
    let by_id = macros
        .iter()
        .map(|macro_record| (macro_record.id.as_str(), macro_record))
        .collect::<HashMap<_, _>>();
    visit(&by_id, source_id, target_id, &mut HashSet::new())
}

fn triggers_equal(left: &MacroTrigger, right: &MacroTrigger) -> bool {
    left.code == right.code
        && left.ctrl == right.ctrl
        && left.alt == right.alt
        && left.shift == right.shift
        && left.meta == right.meta
}

fn is_overlay_trigger(trigger: &MacroTrigger) -> bool {
    trigger.code == "KeyM" && trigger.ctrl && !trigger.alt && trigger.shift && !trigger.meta
}

fn roles_overlap(left: &[String], right: &[String]) -> bool {
    let right = right.iter().collect::<HashSet<_>>();
    left.iter().any(|role_id| right.contains(role_id))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidInput(message.into())
}

fn portable_macro_dependency_invalid() -> CoreError {
    CoreError::Domain {
        code: "PORTABLE_MACRO_DEPENDENCY_INVALID",
        message: "Imported macro dependencies are invalid.".to_owned(),
    }
}
