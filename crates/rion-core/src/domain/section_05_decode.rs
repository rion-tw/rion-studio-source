fn decode<T: for<'de> Deserialize<'de>>(value: &Value, label: &str) -> CoreResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| CoreError::InvalidInput(format!("invalid {label}: {error}")))
}

fn validate_game(game: GameRecord) -> CoreResult<()> {
    non_empty(&game.id, "game id")?;
    non_empty(&game.name, "game name")?;
    one_of(&game.source, &["builtin", "custom"], "game source")?;
    http_url(&game.default_launch_url, "game launch URL")?;
    timestamps(&game.created_at, &game.updated_at, "game")
}

fn validate_role(role: RoleRecord) -> CoreResult<()> {
    non_empty(&role.id, "role id")?;
    non_empty(&role.game_id, "role gameId")?;
    non_empty(&role.name, "role name")?;
    if role.notes.len() > 20_000 {
        return Err(CoreError::InvalidInput(
            "role notes are too long".to_owned(),
        ));
    }
    http_url(&role.launch_url, "role launch URL")?;
    timestamps(&role.created_at, &role.updated_at, "role")
}

fn validate_workspace(workspace: WorkspaceRecord) -> CoreResult<()> {
    non_empty(&workspace.id, "workspace id")?;
    non_empty(&workspace.name, "workspace name")?;
    one_of(
        &workspace.template,
        &[
            "single",
            "two_columns",
            "three_columns",
            "main_left_stack_right",
            "main_right_stack_left",
            "main_center_side_stacks",
            "three_top_two_bottom",
            "two_top_three_bottom",
            "quad",
            "four_columns",
            "six_grid",
            "eight_grid",
            "nine_grid",
        ],
        "workspace template",
    )?;
    if workspace.slots.len() > 9 {
        return Err(CoreError::InvalidInput(
            "workspace cannot contain more than nine slots".to_owned(),
        ));
    }
    let mut slot_ids = HashSet::new();
    let mut role_ids = HashSet::new();
    for slot in workspace.slots {
        non_empty(&slot.id, "workspace slot id")?;
        if !slot_ids.insert(slot.id) {
            return Err(CoreError::InvalidInput(
                "workspace slot ids must be unique".to_owned(),
            ));
        }
        if let Some(role_id) = slot.role_id
            && (!role_ids.insert(role_id.clone()) || role_id.trim().is_empty())
        {
            return Err(CoreError::InvalidInput(
                "workspace role assignments must be unique".to_owned(),
            ));
        }
        let rect = slot.rect;
        if ![rect.x, rect.y, rect.width, rect.height]
            .into_iter()
            .all(f64::is_finite)
            || rect.x < 0.0
            || rect.y < 0.0
            || rect.width <= 0.0
            || rect.height <= 0.0
            || rect.x + rect.width > 1.000_001
            || rect.y + rect.height > 1.000_001
        {
            return Err(CoreError::InvalidInput(
                "workspace slot rectangle is invalid".to_owned(),
            ));
        }
    }
    timestamps(&workspace.created_at, &workspace.updated_at, "workspace")
}

fn validate_macro(macro_record: MacroRecord) -> CoreResult<()> {
    non_empty(&macro_record.id, "macro id")?;
    non_empty(&macro_record.name, "macro name")?;
    if let Some(mode) = macro_record.activation_mode {
        one_of(&mode, &["toggle", "while_held"], "macro activation mode")?;
    }
    if macro_record.role_ids.iter().any(|id| id.trim().is_empty())
        || macro_record.role_ids.iter().collect::<HashSet<_>>().len() != macro_record.role_ids.len()
    {
        return Err(CoreError::InvalidInput(
            "macro role assignments are invalid".to_owned(),
        ));
    }
    let shortcut_role_ids = macro_shortcut_source_role_ids(
        &macro_record.shortcut_source_scope,
        &macro_record.role_ids,
    );
    if shortcut_role_ids.iter().any(|id| id.trim().is_empty())
        || shortcut_role_ids.iter().collect::<HashSet<_>>().len() != shortcut_role_ids.len()
    {
        return Err(CoreError::InvalidInput(
            "macro shortcut source assignments are invalid".to_owned(),
        ));
    }
    if let ValidatedMacroRepeat::Loop { interval_ms } = macro_record.repeat
        && interval_ms > 86_400_000
    {
        return Err(CoreError::InvalidInput(
            "macro loop interval is out of range".to_owned(),
        ));
    }
    let mut step_ids = HashSet::new();
    let step_count = macro_record.steps.len();
    for step in macro_record.steps {
        let id = match &step {
            MacroStep::Key { id, .. }
            | MacroStep::Click { id, .. }
            | MacroStep::Delay { id, .. }
            | MacroStep::Macro { id, .. } => id,
        };
        non_empty(id, "macro step id")?;
        if !step_ids.insert(id.clone()) {
            return Err(CoreError::InvalidInput(
                "macro step ids must be unique".to_owned(),
            ));
        }
        match step {
            MacroStep::Key {
                code,
                action,
                duration_ms,
                ..
            } => {
                non_empty(&code, "macro key code")?;
                let action = action.as_deref().unwrap_or("tap");
                one_of(
                    action,
                    &["tap", "hold_for_duration", "hold_until_stop"],
                    "macro key action",
                )?;
                match (action, duration_ms) {
                    ("hold_for_duration", Some(20..=86_400_000)) | (_, None) => {}
                    ("hold_for_duration", _) => {
                        return Err(CoreError::InvalidInput(
                            "macro key hold duration is out of range".to_owned(),
                        ));
                    }
                    (_, Some(_)) => {
                        return Err(CoreError::InvalidInput(
                            "macro key hold duration is only valid for timed holds".to_owned(),
                        ));
                    }
                }
            }
            MacroStep::Click {
                unit,
                x_percent,
                y_percent,
                x_px,
                y_px,
                x_reference_px,
                y_reference_px,
                ..
            } => {
                let coordinates = match unit.as_deref().unwrap_or("percent") {
                    "percent" => [x_percent, y_percent],
                    "px" => [x_px, y_px],
                    "reference-px" => [x_reference_px, y_reference_px],
                    _ => {
                        return Err(CoreError::InvalidInput(
                            "macro click unit is invalid".to_owned(),
                        ));
                    }
                };
                if coordinates
                    .into_iter()
                    .any(|value| value.is_none_or(|value| !value.is_finite()))
                {
                    return Err(CoreError::InvalidInput(
                        "macro click coordinates are invalid".to_owned(),
                    ));
                }
            }
            MacroStep::Delay { ms, .. } if ms > 86_400_000 => {
                return Err(CoreError::InvalidInput(
                    "macro delay is out of range".to_owned(),
                ));
            }
            MacroStep::Macro {
                macro_id,
                call_mode,
                ..
            } => {
                non_empty(&macro_id, "called macro id")?;
                if let Some(mode) = call_mode {
                    one_of(&mode, &["wait", "trigger"], "macro call mode")?;
                }
            }
            MacroStep::Delay { .. } => {}
        }
    }
    if step_count > 100 {
        return Err(CoreError::InvalidInput(
            "macro contains too many steps".to_owned(),
        ));
    }
    timestamps(&macro_record.created_at, &macro_record.updated_at, "macro")
}

fn non_empty(value: &str, label: &str) -> CoreResult<()> {
    if value.trim().is_empty() {
        Err(CoreError::InvalidInput(format!("{label} is required")))
    } else {
        Ok(())
    }
}

fn one_of(value: &str, accepted: &[&str], label: &str) -> CoreResult<()> {
    if accepted.contains(&value) {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!("{label} is invalid")))
    }
}

fn http_url(value: &str, label: &str) -> CoreResult<()> {
    let url =
        Url::parse(value).map_err(|_| CoreError::InvalidInput(format!("{label} is invalid")))?;
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!("{label} is invalid")))
    }
}

fn timestamps(created_at: &str, updated_at: &str, label: &str) -> CoreResult<()> {
    if chrono::DateTime::parse_from_rfc3339(created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(updated_at).is_err()
    {
        return Err(CoreError::InvalidInput(format!(
            "{label} timestamps are invalid"
        )));
    }
    Ok(())
}
