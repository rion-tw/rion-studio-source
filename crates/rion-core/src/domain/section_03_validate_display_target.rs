pub fn validate_display_target(mut target: DisplayTargetRecord) -> CoreResult<DisplayTargetRecord> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if target.id == -1 || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&target.id) {
        return Err(display_target_error());
    }
    if let Some(fingerprint) = &mut target.fingerprint {
        fingerprint.label = fingerprint.label.trim().to_owned();
        let bounds = &fingerprint.bounds;
        if bounds.width <= 0
            || bounds.height <= 0
            || fingerprint.resolution.width == 0
            || fingerprint.resolution.height == 0
            || !fingerprint.scale_factor.is_finite()
            || fingerprint.scale_factor <= 0.0
        {
            return Err(display_target_error());
        }
    }
    Ok(target)
}

fn display_target_error() -> CoreError {
    domain("DISPLAY_TARGET_INVALID", "Display target is invalid.")
}

fn workspace_slot_to_input(slot: StateWorkspaceSlotRecord) -> WorkspaceSlotInputRecord {
    WorkspaceSlotInputRecord {
        id: Some(slot.id),
        role_id: slot.role_id,
        browser_zoom_percent: slot.browser_zoom_percent,
        rect: Some(slot.rect),
    }
}

fn normalize_workspace_slots(
    template: &str,
    input: Vec<WorkspaceSlotInputRecord>,
) -> CoreResult<Vec<StateWorkspaceSlotRecord>> {
    if input.len() > 9 {
        return Err(domain(
            "WORKSPACE_TOO_MANY_SLOTS",
            "Launch workspace can contain at most 9 slots.",
        ));
    }
    let count = workspace_template_slot_count(template);
    if input.iter().skip(count).any(|slot| {
        slot.role_id
            .as_deref()
            .is_some_and(|role_id| !role_id.trim().is_empty())
    }) {
        return Err(domain(
            "WORKSPACE_SLOT_OUTSIDE_LAYOUT",
            "Launch workspace role is outside the selected layout.",
        ));
    }
    let defaults = default_workspace_rects(template);
    let mut roles = HashSet::new();
    let mut slots = (0..count)
        .map(|index| {
            let source = input.get(index).cloned().unwrap_or_default();
            let role_id = source.role_id.and_then(|role_id| {
                let role_id = role_id.trim().to_owned();
                (!role_id.is_empty()).then_some(role_id)
            });
            if let Some(role_id) = &role_id
                && !roles.insert(role_id.clone())
            {
                return Err(domain(
                    "WORKSPACE_ROLE_DUPLICATE",
                    "A role can only appear once in a launch workspace.",
                ));
            }
            let browser_zoom_percent = if role_id.is_some() {
                source
                    .browser_zoom_percent
                    .map(normalize_workspace_slot_zoom)
                    .transpose()?
            } else {
                None
            };
            Ok(StateWorkspaceSlotRecord {
                id: source
                    .id
                    .map(|id| id.trim().to_owned())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| format!("slot-{}", index + 1)),
                role_id,
                browser_zoom_percent,
                rect: normalize_workspace_rect(source.rect, defaults[index].clone())?,
            })
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let rects = normalize_workspace_rect_edges(
        slots
            .iter()
            .map(|slot| slot.rect.clone())
            .collect::<Vec<_>>(),
    );
    for (slot, rect) in slots.iter_mut().zip(rects) {
        slot.rect = rect;
    }
    Ok(slots)
}

fn normalize_workspace_slot_zoom(value: f64) -> CoreResult<f64> {
    if value.is_finite() && value.fract() == 0.0 && (25.0..=300.0).contains(&value) {
        Ok(value)
    } else {
        Err(domain(
            "WORKSPACE_BROWSER_ZOOM_INVALID",
            "Launch workspace role browser zoom is invalid.",
        ))
    }
}

fn normalize_workspace_rect(
    value: Option<StateNormalizedRectRecord>,
    fallback: StateNormalizedRectRecord,
) -> CoreResult<StateNormalizedRectRecord> {
    let value = value.unwrap_or(fallback);
    if [value.x, value.y, value.width, value.height]
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
        || value.width < 0.12
        || value.height < 0.12
        || value.x + value.width > 1.0001
        || value.y + value.height > 1.0001
    {
        Err(domain(
            "WORKSPACE_RECT_INVALID",
            "Launch workspace slot rectangle is invalid.",
        ))
    } else {
        Ok(value)
    }
}

fn default_workspace_rects(template: &str) -> Vec<StateNormalizedRectRecord> {
    fn rect(x: f64, y: f64, width: f64, height: f64) -> StateNormalizedRectRecord {
        StateNormalizedRectRecord {
            x,
            y,
            width,
            height,
        }
    }
    fn columns(count: usize) -> Vec<StateNormalizedRectRecord> {
        (0..count)
            .map(|index| rect(index as f64 / count as f64, 0.0, 1.0 / count as f64, 1.0))
            .collect()
    }
    fn grid(columns: usize, rows: usize) -> Vec<StateNormalizedRectRecord> {
        (0..columns * rows)
            .map(|index| {
                rect(
                    (index % columns) as f64 / columns as f64,
                    (index / columns) as f64 / rows as f64,
                    1.0 / columns as f64,
                    1.0 / rows as f64,
                )
            })
            .collect()
    }
    fn split(top: usize, bottom: usize) -> Vec<StateNormalizedRectRecord> {
        columns(top)
            .into_iter()
            .map(|mut value| {
                value.height = 0.5;
                value
            })
            .chain(columns(bottom).into_iter().map(|mut value| {
                value.y = 0.5;
                value.height = 0.5;
                value
            }))
            .collect()
    }
    match template {
        "single" => vec![rect(0.0, 0.0, 1.0, 1.0)],
        "two_columns" => columns(2),
        "three_columns" => columns(3),
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
        "three_top_two_bottom" => split(3, 2),
        "two_top_three_bottom" => split(2, 3),
        "quad" => grid(2, 2),
        "four_columns" => columns(4),
        "six_grid" => grid(3, 2),
        "eight_grid" => grid(4, 2),
        "nine_grid" => grid(3, 3),
        _ => unreachable!("workspace template was normalized"),
    }
}

fn normalize_workspace_rect_edges(
    rects: Vec<StateNormalizedRectRecord>,
) -> Vec<StateNormalizedRectRecord> {
    let edges = rects
        .iter()
        .map(|rect| [rect.x, rect.x + rect.width, rect.y, rect.y + rect.height])
        .collect::<Vec<_>>();
    let mut parents = (0..edges.len() * 4).collect::<Vec<_>>();
    fn find(parents: &mut [usize], mut index: usize) -> usize {
        let mut root = index;
        while parents[root] != root {
            root = parents[root];
        }
        while parents[index] != index {
            let parent = parents[index];
            parents[index] = root;
            index = parent;
        }
        root
    }
    fn union(parents: &mut [usize], left: usize, right: usize) {
        let left = find(parents, left);
        let right = find(parents, right);
        if left != right {
            parents[right] = left;
        }
    }
    for left_index in 0..edges.len() {
        for right_index in left_index + 1..edges.len() {
            let left = edges[left_index];
            let right = edges[right_index];
            let vertical_overlap = left[3].min(right[3]) - left[2].max(right[2]);
            let horizontal_overlap = left[1].min(right[1]) - left[0].max(right[0]);
            if vertical_overlap > 0.0 {
                if (left[1] - right[0]).abs() <= 0.0001 + f64::EPSILON {
                    union(&mut parents, left_index * 4 + 1, right_index * 4);
                }
                if (right[1] - left[0]).abs() <= 0.0001 + f64::EPSILON {
                    union(&mut parents, right_index * 4 + 1, left_index * 4);
                }
            }
            if horizontal_overlap > 0.0 {
                if (left[3] - right[2]).abs() <= 0.0001 + f64::EPSILON {
                    union(&mut parents, left_index * 4 + 3, right_index * 4 + 2);
                }
                if (right[3] - left[2]).abs() <= 0.0001 + f64::EPSILON {
                    union(&mut parents, right_index * 4 + 3, left_index * 4 + 2);
                }
            }
        }
    }
    let mut values = edges
        .iter()
        .flat_map(|edge| edge.iter().map(|value| (value * 10_000.0).round() as i64))
        .collect::<Vec<_>>();
    let mut groups = std::collections::HashMap::<usize, Vec<usize>>::new();
    for index in 0..values.len() {
        groups
            .entry(find(&mut parents, index))
            .or_default()
            .push(index);
    }
    for group in groups.values().filter(|group| group.len() > 1) {
        let preferred = group
            .iter()
            .copied()
            .filter(|index| index % 4 == 0 || index % 4 == 2)
            .collect::<Vec<_>>();
        let candidates = if preferred.is_empty() {
            group
        } else {
            &preferred
        };
        let average = candidates.iter().map(|index| values[*index]).sum::<i64>() as f64
            / candidates.len() as f64;
        let normalized = average.round() as i64;
        for index in group {
            values[*index] = normalized;
        }
    }
    (0..rects.len())
        .map(|index| {
            let offset = index * 4;
            let left = values[offset];
            let right = values[offset + 1];
            let top = values[offset + 2];
            let bottom = values[offset + 3];
            StateNormalizedRectRecord {
                x: left as f64 / 10_000.0,
                y: top as f64 / 10_000.0,
                width: (right - left) as f64 / 10_000.0,
                height: (bottom - top) as f64 / 10_000.0,
            }
        })
        .collect()
}

fn normalize_macro_activation_mode(value: Option<&str>) -> CoreResult<String> {
    let value = value.unwrap_or("toggle");
    if matches!(value, "toggle" | "while_held") {
        Ok(value.to_owned())
    } else {
        Err(domain(
            "MACRO_ACTIVATION_MODE_INVALID",
            "Macro activation mode is invalid.",
        ))
    }
}

fn normalize_macro_role_ids(role_ids: Vec<String>) -> CoreResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for role_id in role_ids {
        let role_id = role_id.trim().to_owned();
        if role_id.is_empty() {
            return Err(domain(
                "MACRO_ROLE_ID_INVALID",
                "Macro role assignment is invalid.",
            ));
        }
        if seen.insert(role_id.clone()) {
            normalized.push(role_id);
        }
    }
    Ok(normalized)
}

fn normalize_macro_shortcut_source_scope(
    scope: Option<MacroShortcutSourceScope>,
    has_trigger: bool,
) -> CoreResult<MacroShortcutSourceScope> {
    if !has_trigger {
        return Ok(MacroShortcutSourceScope::AllExecutionRoles);
    }
    match scope.unwrap_or_default() {
        MacroShortcutSourceScope::AllExecutionRoles => {
            Ok(MacroShortcutSourceScope::AllExecutionRoles)
        }
        MacroShortcutSourceScope::SelectedRoles { role_ids } => {
            let role_ids = normalize_macro_role_ids(role_ids)?;
            if role_ids.is_empty() {
                return Err(domain(
                    "MACRO_SHORTCUT_SOURCE_REQUIRED",
                    "A shortcut with selected source roles requires at least one role.",
                ));
            }
            Ok(MacroShortcutSourceScope::SelectedRoles { role_ids })
        }
    }
}

pub(crate) fn macro_shortcut_source_role_ids<'a>(
    scope: &'a MacroShortcutSourceScope,
    execution_role_ids: &'a [String],
) -> &'a [String] {
    match scope {
        MacroShortcutSourceScope::AllExecutionRoles => execution_role_ids,
        MacroShortcutSourceScope::SelectedRoles { role_ids } => role_ids,
    }
}

pub(crate) fn macro_shortcut_source_contains(
    scope: &MacroShortcutSourceScope,
    execution_role_ids: &[String],
    role_id: &str,
) -> bool {
    macro_shortcut_source_role_ids(scope, execution_role_ids)
        .iter()
        .any(|candidate| candidate == role_id)
}

fn normalize_macro_trigger(mut trigger: MacroTrigger) -> CoreResult<MacroTrigger> {
    trigger.code = normalize_macro_code(&trigger.code, "Macro shortcut key is invalid.")?;
    Ok(trigger)
}

fn normalize_macro_repeat(repeat: Option<MacroRepeat>) -> CoreResult<MacroRepeat> {
    match repeat.unwrap_or(MacroRepeat::Once) {
        MacroRepeat::Once => Ok(MacroRepeat::Once),
        MacroRepeat::Loop { interval_ms } if interval_ms <= 86_400_000 => {
            Ok(MacroRepeat::Loop { interval_ms })
        }
        MacroRepeat::Loop { .. } => Err(domain(
            "MACRO_TIME_INVALID",
            "Macro interval must be between 0 and 86400000 ms.",
        )),
    }
}

fn normalize_macro_steps(steps: Vec<MacroStepInputRecord>) -> CoreResult<Vec<MacroStepDefinition>> {
    if steps.is_empty() {
        return Err(domain(
            "MACRO_STEPS_REQUIRED",
            "Macro must contain at least one step.",
        ));
    }
    if steps.len() > 100 {
        return Err(domain(
            "MACRO_STEPS_TOO_MANY",
            "Macro can contain at most 100 steps.",
        ));
    }
    let mut ids = HashSet::new();
    steps
        .into_iter()
        .map(|step| normalize_macro_step(step, &mut ids))
        .collect()
}

fn normalize_macro_step(
    step: MacroStepInputRecord,
    ids: &mut HashSet<String>,
) -> CoreResult<MacroStepDefinition> {
    let normalize_id = |id: Option<String>, ids: &mut HashSet<String>| {
        let candidate = id.map(|id| id.trim().to_owned()).unwrap_or_default();
        let id = if candidate.is_empty() || ids.contains(&candidate) {
            Uuid::new_v4().to_string()
        } else {
            candidate
        };
        ids.insert(id.clone());
        id
    };
    match step {
        MacroStepInputRecord::Key {
            id,
            code,
            modifiers,
            action,
            duration_ms,
            label,
        } => {
            let code = normalize_macro_code(&code, "Macro key step is invalid.")?;
            let modifiers = normalize_macro_modifiers(modifiers, &code)?;
            let action = action.unwrap_or_else(|| "tap".to_owned());
            if !matches!(
                action.as_str(),
                "tap" | "hold_for_duration" | "hold_until_stop"
            ) {
                return Err(domain(
                    "MACRO_KEY_ACTION_INVALID",
                    "Macro key action is invalid.",
                ));
            }
            match (action.as_str(), duration_ms) {
                ("hold_for_duration", Some(20..=86_400_000)) => {}
                ("hold_for_duration", _) => {
                    return Err(domain(
                        "MACRO_KEY_DURATION_INVALID",
                        "Macro key hold duration must be between 20 and 86400000 ms.",
                    ));
                }
                (_, None) => {}
                (_, Some(_)) => {
                    return Err(domain(
                        "MACRO_KEY_DURATION_UNEXPECTED",
                        "Macro key hold duration is only valid for timed holds.",
                    ));
                }
            }
            Ok(MacroStepDefinition::Key {
                id: normalize_id(id, ids),
                code,
                modifiers: (!modifiers.is_empty()).then_some(modifiers),
                action: Some(action),
                duration_ms,
                label: label.and_then(|label| {
                    let label = label.trim();
                    (!label.is_empty()).then(|| label.chars().take(48).collect())
                }),
            })
        }
        MacroStepInputRecord::Click {
            id,
            unit,
            anchor,
            x_percent,
            y_percent,
            x_px,
            y_px,
            x_reference_px,
            y_reference_px,
        } => {
            let unit = unit.unwrap_or_else(|| "percent".to_owned());
            let anchor = normalize_macro_click_anchor(anchor)?;
            let id = normalize_id(id, ids);
            match unit.as_str() {
                "percent" => Ok(MacroStepDefinition::Click {
                    id,
                    anchor,
                    position: crate::model::MacroClickDefinition::Percent {
                        unit: None,
                        x_percent: normalize_macro_percent(x_percent)?,
                        y_percent: normalize_macro_percent(y_percent)?,
                    },
                }),
                "px" => Ok(MacroStepDefinition::Click {
                    id,
                    anchor,
                    position: crate::model::MacroClickDefinition::Pixels {
                        unit: "px".to_owned(),
                        x_px: normalize_macro_pixel(x_px)?,
                        y_px: normalize_macro_pixel(y_px)?,
                    },
                }),
                "reference-px" => Ok(MacroStepDefinition::Click {
                    id,
                    anchor,
                    position: crate::model::MacroClickDefinition::ReferencePixels {
                        unit: "reference-px".to_owned(),
                        x_reference_px: normalize_macro_pixel(x_reference_px)?,
                        y_reference_px: normalize_macro_pixel(y_reference_px)?,
                    },
                }),
                _ => Err(domain("MACRO_STEP_INVALID", "Macro click unit is invalid.")),
            }
        }
        MacroStepInputRecord::Delay { id, ms } => {
            if ms > 86_400_000 {
                return Err(domain(
                    "MACRO_TIME_INVALID",
                    "Macro delay must be between 0 and 86400000 ms.",
                ));
            }
            Ok(MacroStepDefinition::Delay {
                id: normalize_id(id, ids),
                ms,
            })
        }
        MacroStepInputRecord::Macro {
            id,
            macro_id,
            call_mode,
        } => {
            let macro_id = macro_id.trim().to_owned();
            if macro_id.is_empty() || macro_id.len() > 128 {
                return Err(domain(
                    "MACRO_STEP_TARGET_INVALID",
                    "Macro step target is invalid.",
                ));
            }
            let call_mode = call_mode.unwrap_or_else(|| "wait".to_owned());
            if !matches!(call_mode.as_str(), "wait" | "trigger") {
                return Err(domain(
                    "MACRO_CALL_MODE_INVALID",
                    "Macro call mode is invalid.",
                ));
            }
            Ok(MacroStepDefinition::Macro {
                id: normalize_id(id, ids),
                macro_id,
                call_mode: Some(call_mode),
            })
        }
    }
}

fn normalize_macro_code(code: &str, message: &str) -> CoreResult<String> {
    let code = code.trim();
    if code.is_empty() || code.len() > 48 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        Err(domain("MACRO_KEY_CODE_INVALID", message))
    } else {
        Ok(code.to_owned())
    }
}

fn normalize_macro_modifiers(modifiers: Vec<String>, code: &str) -> CoreResult<Vec<String>> {
    const ORDER: [&str; 5] = ["primary", "ctrl", "alt", "shift", "meta"];
    if modifiers
        .iter()
        .any(|modifier| !ORDER.contains(&modifier.as_str()))
    {
        return Err(domain(
            "MACRO_KEY_MODIFIERS_INVALID",
            "Macro key modifiers are invalid.",
        ));
    }
    let modifiers = ORDER
        .iter()
        .filter(|modifier| modifiers.iter().any(|value| value == **modifier))
        .map(|modifier| (*modifier).to_owned())
        .collect::<Vec<_>>();
    if modifiers.iter().any(|modifier| modifier == "primary")
        && modifiers
            .iter()
            .any(|modifier| matches!(modifier.as_str(), "ctrl" | "meta"))
    {
        return Err(domain(
            "MACRO_KEY_PRIMARY_CONFLICT",
            "Primary cannot be combined with Ctrl or Meta.",
        ));
    }
    if !modifiers.is_empty()
        && matches!(
            code,
            "AltLeft"
                | "AltRight"
                | "ControlLeft"
                | "ControlRight"
                | "MetaLeft"
                | "MetaRight"
                | "ShiftLeft"
                | "ShiftRight"
        )
    {
        return Err(domain(
            "MACRO_KEY_COMBINATION_INVALID",
            "A key combination requires a non-modifier main key.",
        ));
    }
    Ok(modifiers)
}

fn normalize_macro_click_anchor(anchor: Option<String>) -> CoreResult<Option<String>> {
    let Some(anchor) = anchor else {
        return Ok(None);
    };
    if anchor == "top-left" {
        return Ok(None);
    }
    if matches!(
        anchor.as_str(),
        "top-center"
            | "top-right"
            | "center-left"
            | "center"
            | "center-right"
            | "bottom-left"
            | "bottom-center"
            | "bottom-right"
    ) {
        Ok(Some(anchor))
    } else {
        Err(domain(
            "MACRO_STEP_INVALID",
            "Macro click anchor is invalid.",
        ))
    }
}

fn normalize_macro_percent(value: Option<f64>) -> CoreResult<f64> {
    let value = value.ok_or_else(|| {
        domain(
            "MACRO_CLICK_PERCENT_INVALID",
            "Macro click offset must be between -100 and 100.",
        )
    })?;
    if !value.is_finite() || !(-100.0..=100.0).contains(&value) {
        Err(domain(
            "MACRO_CLICK_PERCENT_INVALID",
            "Macro click offset must be between -100 and 100.",
        ))
    } else {
        Ok((value * 100.0).round() / 100.0)
    }
}

fn normalize_macro_pixel(value: Option<f64>) -> CoreResult<f64> {
    let value = value.ok_or_else(|| {
        domain(
            "MACRO_STEP_INVALID",
            "Macro click offset must be a safe pixel integer.",
        )
    })?;
    let rounded = value.round();
    if !value.is_finite() || rounded.abs() > 9_007_199_254_740_991.0 {
        Err(domain(
            "MACRO_STEP_INVALID",
            "Macro click offset must be a safe pixel integer.",
        ))
    } else {
        Ok(rounded)
    }
}

fn ensure_unique_workspace_name(
    workspaces: &[StateLaunchWorkspaceRecord],
    name: &str,
    current_id: Option<&str>,
) -> CoreResult<()> {
    if workspaces.iter().any(|workspace| {
        Some(workspace.id.as_str()) != current_id
            && workspace.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(domain(
            "WORKSPACE_NAME_DUPLICATE",
            "A launch workspace with this name already exists.",
        ));
    }
    Ok(())
}

fn validate_macro_candidate(
    macros: &[StateMacroRecord],
    candidate: &StateMacroRecord,
    current_id: Option<&str>,
) -> CoreResult<()> {
    validate_collection_record(
        StateCollection::Macros,
        &serde_json::to_value(candidate).map_err(|error| CoreError::Internal(error.to_string()))?,
    )?;
    if candidate.activation_mode.as_deref() == Some("while_held") && candidate.trigger.is_none() {
        return Err(domain(
            "MACRO_WHILE_HELD_TRIGGER_REQUIRED",
            "A tap-or-hold macro requires a shortcut.",
        ));
    }
    if candidate
        .trigger
        .as_ref()
        .is_some_and(is_reserved_macro_trigger)
    {
        return Err(domain(
            "MACRO_TRIGGER_RESERVED",
            "Macro shortcut is reserved by Rion Studio.",
        ));
    }
    if let Some(trigger) = &candidate.trigger
        && macros.iter().any(|item| {
            let candidate_source_role_ids = macro_shortcut_source_role_ids(
                &candidate.shortcut_source_scope,
                &candidate.role_ids,
            );
            let item_source_role_ids = macro_shortcut_source_role_ids(
                &item.shortcut_source_scope,
                &item.role_ids,
            );
            Some(item.id.as_str()) != current_id
                && item.trigger.as_ref().is_some_and(|other| {
                    serde_json::to_value(other).ok() == serde_json::to_value(trigger).ok()
                })
                && item_source_role_ids
                    .iter()
                    .any(|id| candidate_source_role_ids.contains(id))
        })
    {
        return Err(domain(
            "MACRO_TRIGGER_CONFLICT",
            "Macro shortcut conflicts with another macro for an overlapping source role.",
        ));
    }
    Ok(())
}
