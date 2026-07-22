use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::StateCollection,
    model::{
        BrowserCdnCompatibilityRecord, BrowserFontSettingsRecord, BrowserGraphicsSettingsRecord,
        BrowserNetworkSettingsRecord, BrowserProxySettingsRecord, GameBrowserSettingsRecord,
        GameCreateInputRecord, GameUpdateInputRecord, LegalAcceptanceRecord,
        MacroBadgePositionRecord, MacroCreateInputRecord, MacroRepeat, MacroSettingsRecord,
        MacroStepDefinition, MacroStepInputRecord, MacroTrigger, MacroUpdateInputRecord,
        RoleCreateInputRecord, RoleGameAssignmentRecord, RoleUpdateInputRecord,
        RuntimeWindowPreferencesRecord, StateCompatibilityReportRecord, StateGameRecord,
        StateLaunchWorkspaceRecord, StateMacroRecord, StateNormalizedRectRecord, StateRoleRecord,
        StateWorkspaceDisplayTargetRecord, StateWorkspaceResourcePolicyRecord,
        StateWorkspaceSlotRecord, WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord,
        WorkspaceDisplayInfoRecord, WorkspaceSlotInputRecord, WorkspaceUpdateInputRecord,
    },
};

const DEFAULT_LAUNCH_URL: &str = "https://universe.flyff.com/play";
const MAX_IMAGE_DATA_URL_LENGTH: usize = 2_000_128;
const MAX_ROLE_COVER_DATA_URL_LENGTH: usize = 1_500_000;

pub fn default_game_browser_settings() -> GameBrowserSettingsRecord {
    GameBrowserSettingsRecord {
        fonts: BrowserFontSettingsRecord {
            mode: "default".to_owned(),
            families: HashMap::new(),
        },
        graphics: BrowserGraphicsSettingsRecord::aggressive_default(),
        launch_mode: "auto".to_owned(),
        macro_badge_position: MacroBadgePositionRecord {
            horizontal_align: "center".to_owned(),
            horizontal_margin_px: 8,
            top_px: 128,
        },
        network: BrowserNetworkSettingsRecord {
            cdn_compatibility: BrowserCdnCompatibilityRecord {
                mode: "auto".to_owned(),
            },
            proxy: BrowserProxySettingsRecord {
                mode: "system".to_owned(),
                server: String::new(),
            },
        },
        workspace: WorkspaceAppearanceSettingsRecord {
            background: "material".to_owned(),
            gap: 4,
        },
    }
}

pub fn default_macro_settings() -> MacroSettingsRecord {
    MacroSettingsRecord {
        startup_delay_ms: 100,
        key_hold_ms: 30,
        post_input_delay_ms: 30,
        default_loop_delay_ms: 1_000,
    }
}

pub fn default_runtime_window_preferences() -> RuntimeWindowPreferencesRecord {
    RuntimeWindowPreferencesRecord {
        always_show_toolbar_in_full_screen: false,
    }
}

pub fn create_game(
    games: &mut Vec<StateGameRecord>,
    input: GameCreateInputRecord,
) -> CoreResult<StateGameRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let game = StateGameRecord {
        id: Uuid::new_v4().to_string(),
        source: "custom".to_owned(),
        builtin_key: None,
        name: normalize_name(&input.name, "GAME_NAME_REQUIRED", "GAME_NAME_TOO_LONG")?,
        icon_image_data_url: normalize_image(
            input.icon_image_data_url,
            MAX_IMAGE_DATA_URL_LENGTH,
            "GAME_ICON_INVALID",
        )?,
        cover_image_data_url: normalize_image(
            input.cover_image_data_url,
            MAX_IMAGE_DATA_URL_LENGTH,
            "GAME_COVER_INVALID",
        )?,
        default_launch_url: normalize_http_url(&input.default_launch_url, "GAME_URL_INVALID")?,
        browser_launch_mode: normalize_game_launch_mode(input.browser_launch_mode.as_deref())?,
        created_at: now.clone(),
        updated_at: now,
    };
    ensure_unique_game_name(games, &game.name, None)?;
    games.push(game.clone());
    Ok(game)
}

pub fn update_game(
    games: &mut [StateGameRecord],
    id: &str,
    input: GameUpdateInputRecord,
) -> CoreResult<StateGameRecord> {
    let index = games
        .iter()
        .position(|game| game.id == id)
        .ok_or_else(|| domain("GAME_NOT_FOUND", "Game not found."))?;
    let current = games[index].clone();
    if current.source == "builtin"
        && (input
            .name
            .as_ref()
            .is_some_and(|name| name.trim() != current.name)
            || input.set_icon_image_data_url
            || input.set_cover_image_data_url)
    {
        return Err(domain(
            "GAME_BUILTIN_FIELD_PROTECTED",
            "Built-in game fields cannot be changed.",
        ));
    }
    let name = input
        .name
        .as_deref()
        .map(|value| normalize_name(value, "GAME_NAME_REQUIRED", "GAME_NAME_TOO_LONG"))
        .transpose()?
        .unwrap_or_else(|| current.name.clone());
    ensure_unique_game_name(games, &name, Some(id))?;
    let updated = StateGameRecord {
        name,
        default_launch_url: input
            .default_launch_url
            .as_deref()
            .map(|value| normalize_http_url(value, "GAME_URL_INVALID"))
            .transpose()?
            .unwrap_or_else(|| current.default_launch_url.clone()),
        icon_image_data_url: if input.set_icon_image_data_url {
            normalize_image(
                input.icon_image_data_url,
                MAX_IMAGE_DATA_URL_LENGTH,
                "GAME_ICON_INVALID",
            )?
        } else {
            current.icon_image_data_url.clone()
        },
        cover_image_data_url: if input.set_cover_image_data_url {
            normalize_image(
                input.cover_image_data_url,
                MAX_IMAGE_DATA_URL_LENGTH,
                "GAME_COVER_INVALID",
            )?
        } else {
            current.cover_image_data_url.clone()
        },
        browser_launch_mode: input
            .browser_launch_mode
            .as_deref()
            .map(|value| normalize_game_launch_mode(Some(value)))
            .transpose()?
            .unwrap_or_else(|| current.browser_launch_mode.clone()),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..current
    };
    games[index] = updated.clone();
    Ok(updated)
}

pub fn reset_builtin_game(games: &mut [StateGameRecord], id: &str) -> CoreResult<StateGameRecord> {
    let game = games
        .iter_mut()
        .find(|game| game.id == id)
        .ok_or_else(|| domain("GAME_NOT_BUILTIN", "Only built-in games can be reset."))?;
    let (builtin_key, name, default_launch_url) = builtin_definition(id)
        .ok_or_else(|| domain("GAME_NOT_BUILTIN", "Only built-in games can be reset."))?;
    if game.source != "builtin" {
        return Err(domain(
            "GAME_NOT_BUILTIN",
            "Only built-in games can be reset.",
        ));
    }
    *game = StateGameRecord {
        id: id.to_owned(),
        source: "builtin".to_owned(),
        builtin_key: Some(builtin_key.to_owned()),
        name: name.to_owned(),
        icon_image_data_url: None,
        cover_image_data_url: None,
        default_launch_url: default_launch_url.to_owned(),
        browser_launch_mode: "inherit".to_owned(),
        created_at: game.created_at.clone(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    Ok(game.clone())
}

pub fn delete_game(
    games: &mut Vec<StateGameRecord>,
    roles: &[StateRoleRecord],
    id: &str,
) -> CoreResult<()> {
    let game = games
        .iter()
        .find(|game| game.id == id)
        .ok_or_else(|| domain("GAME_NOT_FOUND", "Game not found."))?;
    if game.source == "builtin" {
        return Err(domain(
            "GAME_BUILTIN_DELETE_FORBIDDEN",
            "Built-in games cannot be deleted.",
        ));
    }
    if roles.iter().any(|role| role.game_id == id) {
        return Err(domain(
            "GAME_IN_USE",
            "Move or delete assigned roles before deleting this game.",
        ));
    }
    games.retain(|game| game.id != id);
    Ok(())
}

pub fn create_role(
    games: &[StateGameRecord],
    roles: &mut Vec<StateRoleRecord>,
    input: RoleCreateInputRecord,
) -> CoreResult<StateRoleRecord> {
    let game_id = normalize_game_id(&input.game_id)?;
    ensure_game_exists(games, &game_id)?;
    let name = normalize_name(&input.name, "ROLE_NAME_REQUIRED", "ROLE_NAME_TOO_LONG")?;
    ensure_unique_role_name(roles, &game_id, &name, None)?;
    let cover = normalize_image(
        input.cover_image_data_url,
        MAX_ROLE_COVER_DATA_URL_LENGTH,
        "ROLE_COVER_IMAGE_INVALID",
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let role = StateRoleRecord {
        id: Uuid::new_v4().to_string(),
        game_id,
        name,
        launch_url: normalize_http_url(
            input.launch_url.as_deref().unwrap_or(DEFAULT_LAUNCH_URL),
            "ROLE_LAUNCH_URL_INVALID",
        )?,
        notes: input.notes.unwrap_or_default().trim().to_owned(),
        browser_session_source: Some("embedded".to_owned()),
        cover_image_dominant_color: if cover.is_some() {
            normalize_color(input.cover_image_dominant_color)?
        } else {
            None
        },
        cover_image_data_url: cover,
        created_at: now.clone(),
        updated_at: now,
    };
    if role.notes.len() > 20_000 {
        return Err(domain("ROLE_NOTES_TOO_LONG", "Role notes are too long."));
    }
    roles.push(role.clone());
    Ok(role)
}

pub fn update_role(
    games: &[StateGameRecord],
    roles: &mut [StateRoleRecord],
    id: &str,
    input: RoleUpdateInputRecord,
) -> CoreResult<StateRoleRecord> {
    let index = roles
        .iter()
        .position(|role| role.id == id)
        .ok_or_else(|| domain("ROLE_NOT_FOUND", "Role not found."))?;
    let current = roles[index].clone();
    let game_id = input
        .game_id
        .as_deref()
        .map(normalize_game_id)
        .transpose()?
        .unwrap_or_else(|| current.game_id.clone());
    ensure_game_exists(games, &game_id)?;
    let name = input
        .name
        .as_deref()
        .map(|value| normalize_name(value, "ROLE_NAME_REQUIRED", "ROLE_NAME_TOO_LONG"))
        .transpose()?
        .unwrap_or_else(|| current.name.clone());
    ensure_unique_role_name(roles, &game_id, &name, Some(id))?;
    let cover = if input.set_cover_image_data_url {
        normalize_image(
            input.cover_image_data_url,
            MAX_ROLE_COVER_DATA_URL_LENGTH,
            "ROLE_COVER_IMAGE_INVALID",
        )?
    } else {
        current.cover_image_data_url.clone()
    };
    let color = if cover.is_none() {
        if input.set_cover_image_dominant_color {
            let _ = normalize_color(input.cover_image_dominant_color)?;
        }
        None
    } else if input.set_cover_image_dominant_color {
        normalize_color(input.cover_image_dominant_color)?
    } else if input.set_cover_image_data_url {
        None
    } else {
        current.cover_image_dominant_color.clone()
    };
    let notes = input
        .notes
        .map_or_else(|| current.notes.clone(), |value| value.trim().to_owned());
    if notes.len() > 20_000 {
        return Err(domain("ROLE_NOTES_TOO_LONG", "Role notes are too long."));
    }
    let role = StateRoleRecord {
        game_id,
        name,
        launch_url: input
            .launch_url
            .as_deref()
            .map(|value| normalize_http_url(value, "ROLE_LAUNCH_URL_INVALID"))
            .transpose()?
            .unwrap_or_else(|| current.launch_url.clone()),
        notes,
        cover_image_data_url: cover,
        cover_image_dominant_color: color,
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..current
    };
    roles[index] = role.clone();
    Ok(role)
}

pub fn reorder_roles(roles: &mut Vec<StateRoleRecord>, ordered_ids: &[String]) -> CoreResult<()> {
    if ordered_ids.len() != roles.len()
        || ordered_ids.iter().collect::<HashSet<_>>().len() != roles.len()
        || ordered_ids
            .iter()
            .any(|id| !roles.iter().any(|role| &role.id == id))
    {
        return Err(domain("ROLE_ORDER_INVALID", "Role order is invalid."));
    }
    let by_id = roles
        .drain(..)
        .map(|role| (role.id.clone(), role))
        .collect::<std::collections::HashMap<_, _>>();
    *roles = ordered_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    Ok(())
}

pub fn set_role_browser_session_source(
    roles: &mut [StateRoleRecord],
    id: &str,
    source: &str,
) -> CoreResult<StateRoleRecord> {
    if !matches!(source, "embedded" | "chrome-profile") {
        return Err(domain(
            "ROLE_SESSION_SOURCE_INVALID",
            "Role browser session source is invalid.",
        ));
    }
    let role = roles
        .iter_mut()
        .find(|role| role.id == id)
        .ok_or_else(|| domain("ROLE_NOT_FOUND", "Role not found."))?;
    role.browser_session_source = Some(source.to_owned());
    role.updated_at = chrono::Utc::now().to_rfc3339();
    Ok(role.clone())
}

pub fn assign_role_game_ids(
    games: &[StateGameRecord],
    roles: &mut [StateRoleRecord],
    assignments: &[RoleGameAssignmentRecord],
) -> CoreResult<()> {
    for assignment in assignments {
        let game_id = normalize_game_id(&assignment.game_id)?;
        ensure_game_exists(games, &game_id)?;
        if let Some(role) = roles.iter_mut().find(|role| role.id == assignment.role_id) {
            role.game_id = game_id;
            role.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }
    let mut keys = HashSet::new();
    for role in roles {
        if !keys.insert((role.game_id.clone(), role.name.to_lowercase())) {
            return Err(domain(
                "ROLE_NAME_DUPLICATE",
                "A role with this name already exists.",
            ));
        }
    }
    Ok(())
}

pub fn create_workspace(
    workspaces: &mut Vec<StateLaunchWorkspaceRecord>,
    input: WorkspaceCreateInputRecord,
) -> CoreResult<StateLaunchWorkspaceRecord> {
    let name = normalize_name(
        &input.name,
        "WORKSPACE_NAME_REQUIRED",
        "WORKSPACE_NAME_TOO_LONG",
    )?;
    ensure_unique_workspace_name(workspaces, &name, None)?;
    let template = normalize_workspace_template(input.template.as_deref())?;
    let slots = normalize_workspace_slots(&template, input.slots.unwrap_or_default())?;
    let target_display = input
        .target_display
        .map(validate_workspace_target_display)
        .transpose()?;
    let now = chrono::Utc::now().to_rfc3339();
    let workspace = StateLaunchWorkspaceRecord {
        id: Uuid::new_v4().to_string(),
        name,
        template: template.clone(),
        browser_launch_mode: normalize_workspace_launch_mode(input.browser_launch_mode.as_deref())?,
        browser_zoom_mode: normalize_workspace_zoom_mode(input.browser_zoom_mode.as_deref())?,
        browser_zoom_percent: normalize_workspace_zoom_percent(
            input.browser_zoom_percent,
            default_workspace_zoom_percent(&template),
        )?,
        resource_policy: normalize_workspace_resource_policy(input.resource_policy)?,
        target_display,
        slots,
        created_at: now.clone(),
        updated_at: now,
    };
    workspaces.push(workspace.clone());
    Ok(workspace)
}

pub fn update_workspace(
    workspaces: &mut [StateLaunchWorkspaceRecord],
    id: &str,
    input: WorkspaceUpdateInputRecord,
) -> CoreResult<StateLaunchWorkspaceRecord> {
    let index = workspaces
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| domain("WORKSPACE_NOT_FOUND", "Launch workspace not found."))?;
    let current = workspaces[index].clone();
    let name = input
        .name
        .as_deref()
        .map(|name| normalize_name(name, "WORKSPACE_NAME_REQUIRED", "WORKSPACE_NAME_TOO_LONG"))
        .transpose()?
        .unwrap_or_else(|| current.name.clone());
    ensure_unique_workspace_name(workspaces, &name, Some(id))?;
    let template = input
        .template
        .as_deref()
        .map(|template| normalize_workspace_template(Some(template)))
        .transpose()?
        .unwrap_or_else(|| current.template.clone());
    let slots = if let Some(slots) = input.slots {
        normalize_workspace_slots(&template, slots)?
    } else if template != current.template {
        normalize_workspace_slots(
            &template,
            current
                .slots
                .iter()
                .take(workspace_template_slot_count(&template))
                .cloned()
                .map(workspace_slot_to_input)
                .collect(),
        )?
    } else {
        current.slots.clone()
    };
    let target_display = if input.set_target_display {
        input
            .target_display
            .map(validate_workspace_target_display)
            .transpose()?
    } else {
        current.target_display.clone()
    };
    let workspace = StateLaunchWorkspaceRecord {
        id: current.id.clone(),
        name,
        template,
        browser_launch_mode: input
            .browser_launch_mode
            .as_deref()
            .map(|mode| normalize_workspace_launch_mode(Some(mode)))
            .transpose()?
            .unwrap_or_else(|| current.browser_launch_mode.clone()),
        browser_zoom_mode: input
            .browser_zoom_mode
            .as_deref()
            .map(|mode| normalize_workspace_zoom_mode(Some(mode)))
            .transpose()?
            .unwrap_or_else(|| current.browser_zoom_mode.clone()),
        browser_zoom_percent: normalize_workspace_zoom_percent(
            input.browser_zoom_percent,
            current.browser_zoom_percent,
        )?,
        resource_policy: input
            .resource_policy
            .map(|policy| normalize_workspace_resource_policy(Some(policy)))
            .transpose()?
            .unwrap_or_else(|| current.resource_policy.clone()),
        target_display,
        slots,
        created_at: current.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    workspaces[index] = workspace.clone();
    Ok(workspace)
}

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

pub fn reconcile_workspace_displays(
    workspaces: &mut [StateLaunchWorkspaceRecord],
    displays: &[WorkspaceDisplayInfoRecord],
) -> CoreResult<()> {
    for display in displays {
        validate_workspace_target_display(workspace_display_target(display))?;
    }
    let now = chrono::Utc::now().to_rfc3339();
    for workspace in workspaces {
        let Some(target) = &workspace.target_display else {
            continue;
        };
        let resolved = if let Some(fingerprint) = &target.fingerprint {
            let matches = displays
                .iter()
                .filter(|display| display_matches_fingerprint(display, fingerprint))
                .collect::<Vec<_>>();
            (matches.len() == 1).then_some(matches[0])
        } else {
            displays.iter().find(|display| display.id == target.id)
        };
        let Some(resolved) = resolved else { continue };
        if target.id != resolved.id || target.fingerprint.is_none() {
            workspace.target_display = Some(workspace_display_target(resolved));
            workspace.updated_at = now.clone();
        }
    }
    Ok(())
}

fn workspace_display_target(
    display: &WorkspaceDisplayInfoRecord,
) -> StateWorkspaceDisplayTargetRecord {
    StateWorkspaceDisplayTargetRecord {
        id: display.id,
        fingerprint: Some(crate::model::StateWorkspaceDisplayFingerprintRecord {
            label: display.label.clone(),
            bounds: display.bounds.clone(),
            resolution: display.resolution.clone(),
            scale_factor: display.scale_factor,
            is_primary: display.is_primary,
            is_internal: display.is_internal,
        }),
    }
}

fn display_matches_fingerprint(
    display: &WorkspaceDisplayInfoRecord,
    fingerprint: &crate::model::StateWorkspaceDisplayFingerprintRecord,
) -> bool {
    display.label == fingerprint.label
        && display.bounds.x == fingerprint.bounds.x
        && display.bounds.y == fingerprint.bounds.y
        && display.bounds.width == fingerprint.bounds.width
        && display.bounds.height == fingerprint.bounds.height
        && display.resolution.width == fingerprint.resolution.width
        && display.resolution.height == fingerprint.resolution.height
        && display.scale_factor == fingerprint.scale_factor
        && display.is_primary == fingerprint.is_primary
        && display.is_internal == fingerprint.is_internal
}

pub fn create_macro(
    macros: &mut Vec<StateMacroRecord>,
    input: MacroCreateInputRecord,
) -> CoreResult<StateMacroRecord> {
    let now = chrono::Utc::now().to_rfc3339();
    let macro_record = StateMacroRecord {
        id: Uuid::new_v4().to_string(),
        enabled: input.enabled.unwrap_or(true),
        activation_mode: Some(normalize_macro_activation_mode(
            input.activation_mode.as_deref(),
        )?),
        name: normalize_name(&input.name, "MACRO_NAME_REQUIRED", "MACRO_NAME_TOO_LONG")?,
        role_ids: normalize_macro_role_ids(input.role_ids)?,
        trigger: input.trigger.map(normalize_macro_trigger).transpose()?,
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
        trigger: if input.set_trigger {
            input.trigger.map(normalize_macro_trigger).transpose()?
        } else {
            current.trigger.clone()
        },
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
        let before = macro_record.role_ids.len();
        macro_record.role_ids.retain(|id| id != role_id);
        if macro_record.role_ids.len() != before {
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

fn default_workspace_zoom_percent(template: &str) -> f64 {
    match template {
        "eight_grid" => 75.0,
        "nine_grid"
        | "six_grid"
        | "main_center_side_stacks"
        | "three_top_two_bottom"
        | "two_top_three_bottom" => 80.0,
        "three_columns" | "quad" | "four_columns" => 90.0,
        _ => 100.0,
    }
}

fn normalize_workspace_launch_mode(value: Option<&str>) -> CoreResult<String> {
    let value = value.unwrap_or("inherit");
    if matches!(value, "inherit" | "auto" | "embedded" | "external") {
        Ok(value.to_owned())
    } else {
        Err(domain(
            "WORKSPACE_BROWSER_LAUNCH_MODE_INVALID",
            "Launch workspace browser mode is invalid.",
        ))
    }
}

fn normalize_workspace_zoom_mode(value: Option<&str>) -> CoreResult<String> {
    let value = value.unwrap_or("adaptive");
    if matches!(value, "adaptive" | "fixed") {
        Ok(value.to_owned())
    } else {
        Err(domain(
            "WORKSPACE_BROWSER_ZOOM_INVALID",
            "Launch workspace browser zoom is invalid.",
        ))
    }
}

fn normalize_workspace_zoom_percent(value: Option<f64>, fallback: f64) -> CoreResult<f64> {
    let value = value.unwrap_or(fallback);
    if [
        25.0, 33.0, 50.0, 67.0, 75.0, 80.0, 90.0, 100.0, 110.0, 125.0,
    ]
    .contains(&value)
    {
        Ok(value)
    } else {
        Err(domain(
            "WORKSPACE_BROWSER_ZOOM_INVALID",
            "Launch workspace browser zoom is invalid.",
        ))
    }
}

fn normalize_workspace_resource_policy(
    policy: Option<StateWorkspaceResourcePolicyRecord>,
) -> CoreResult<StateWorkspaceResourcePolicyRecord> {
    let mode = policy.map_or_else(|| "adaptive".to_owned(), |policy| policy.mode);
    match mode.as_str() {
        "unrestricted" => Ok(StateWorkspaceResourcePolicyRecord { mode }),
        "adaptive" | "primary_priority" => Ok(StateWorkspaceResourcePolicyRecord {
            mode: "adaptive".to_owned(),
        }),
        _ => Err(domain(
            "WORKSPACE_RESOURCE_POLICY_INVALID",
            "Launch workspace resource policy is invalid.",
        )),
    }
}

fn validate_workspace_target_display(
    mut target: StateWorkspaceDisplayTargetRecord,
) -> CoreResult<StateWorkspaceDisplayTargetRecord> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if target.id == -1 || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&target.id) {
        return Err(workspace_target_display_error());
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
            return Err(workspace_target_display_error());
        }
    }
    Ok(target)
}

fn workspace_target_display_error() -> CoreError {
    domain(
        "WORKSPACE_TARGET_DISPLAY_INVALID",
        "Launch workspace target display is invalid.",
    )
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
    if value.is_finite() && value.fract() == 0.0 && (50.0..=300.0).contains(&value) {
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
            label,
        } => {
            let code = normalize_macro_code(&code, "Macro key step is invalid.")?;
            let modifiers = normalize_macro_modifiers(modifiers, &code)?;
            let action = action.unwrap_or_else(|| "tap".to_owned());
            if !matches!(action.as_str(), "tap" | "hold_until_stop") {
                return Err(domain(
                    "MACRO_KEY_ACTION_INVALID",
                    "Macro key action is invalid.",
                ));
            }
            Ok(MacroStepDefinition::Key {
                id: normalize_id(id, ids),
                code,
                modifiers: (!modifiers.is_empty()).then_some(modifiers),
                action: Some(action),
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
            Some(item.id.as_str()) != current_id
                && item.trigger.as_ref().is_some_and(|other| {
                    serde_json::to_value(other).ok() == serde_json::to_value(trigger).ok()
                })
                && (item.role_ids.is_empty()
                    || candidate.role_ids.is_empty()
                    || item
                        .role_ids
                        .iter()
                        .any(|id| candidate.role_ids.contains(id)))
        })
    {
        return Err(domain(
            "MACRO_TRIGGER_CONFLICT",
            "Macro shortcut conflicts with another macro assigned to the same role.",
        ));
    }
    Ok(())
}

fn is_reserved_macro_trigger(trigger: &MacroTrigger) -> bool {
    let overlay =
        trigger.code == "KeyM" && trigger.ctrl && trigger.shift && !trigger.alt && !trigger.meta;
    let tab_switch = trigger.code == "Tab" && trigger.ctrl && !trigger.alt && !trigger.meta;
    let primary_only = !trigger.alt && trigger.ctrl != trigger.meta;
    let zoom = primary_only
        && (matches!(trigger.code.as_str(), "Equal" | "Plus" | "NumpadAdd")
            || (!trigger.shift
                && matches!(
                    trigger.code.as_str(),
                    "Minus" | "NumpadSubtract" | "Digit0" | "Numpad0"
                )));
    overlay || tab_switch || zoom
}

fn validate_macro_records_graph(macros: &[StateMacroRecord]) -> CoreResult<()> {
    let values = macros
        .iter()
        .map(|item| {
            serde_json::to_value(item).map_err(|error| CoreError::Internal(error.to_string()))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    crate::macro_graph::validate_macro_graph(&values)
}

fn macro_referrer_names(
    macros: &[StateMacroRecord],
    id: &str,
    excluded: &HashSet<String>,
) -> Vec<String> {
    macros.iter().filter(|item| !excluded.contains(&item.id) && item.steps.iter().any(|step| matches!(step, MacroStepDefinition::Macro { macro_id, .. } if macro_id == id))).map(|item| item.name.clone()).collect()
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn normalize_name(
    value: &str,
    required_code: &'static str,
    long_code: &'static str,
) -> CoreResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(domain(required_code, "Name is required."));
    }
    if value.chars().count() > 80 {
        return Err(domain(long_code, "Name must be 80 characters or fewer."));
    }
    Ok(value.to_owned())
}

fn normalize_http_url(value: &str, code: &'static str) -> CoreResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2_048 {
        return Err(domain(code, "URL must use HTTP or HTTPS."));
    }
    let url = Url::parse(value).map_err(|_| domain(code, "URL must use HTTP or HTTPS."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(domain(code, "URL must use HTTP or HTTPS."));
    }
    Ok(url.to_string())
}

fn normalize_image(
    value: Option<String>,
    max_len: usize,
    code: &'static str,
) -> CoreResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_len
        || !value.starts_with("data:image/")
        || !value.contains(";base64,")
        || base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            value.split_once(',').map_or("", |(_, body)| body),
        )
        .is_err()
    {
        return Err(domain(code, "Image must be a valid supported data URL."));
    }
    Ok(Some(value.to_owned()))
}

fn normalize_color(value: Option<String>) -> CoreResult<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return Err(domain(
            "ROLE_COVER_COLOR_INVALID",
            "Role cover dominant color must be a valid hex color.",
        ));
    }
    Ok(Some(value.to_ascii_uppercase()))
}

fn normalize_game_launch_mode(value: Option<&str>) -> CoreResult<String> {
    let value = value.unwrap_or("inherit");
    if !matches!(value, "inherit" | "auto" | "embedded" | "external") {
        return Err(domain(
            "GAME_LAUNCH_MODE_INVALID",
            "Game browser launch mode is invalid.",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_game_id(value: &str) -> CoreResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 120 {
        return Err(domain("ROLE_GAME_INVALID", "Role game is invalid."));
    }
    Ok(value.to_owned())
}

fn ensure_unique_game_name(
    games: &[StateGameRecord],
    name: &str,
    current_id: Option<&str>,
) -> CoreResult<()> {
    if games
        .iter()
        .any(|game| Some(game.id.as_str()) != current_id && game.name.eq_ignore_ascii_case(name))
    {
        return Err(domain(
            "GAME_NAME_DUPLICATE",
            "A game with this name already exists.",
        ));
    }
    Ok(())
}

fn ensure_unique_role_name(
    roles: &[StateRoleRecord],
    game_id: &str,
    name: &str,
    current_id: Option<&str>,
) -> CoreResult<()> {
    if roles.iter().any(|role| {
        Some(role.id.as_str()) != current_id
            && role.game_id == game_id
            && role.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(domain(
            "ROLE_NAME_DUPLICATE",
            "A role with this name already exists.",
        ));
    }
    Ok(())
}

fn ensure_game_exists(games: &[StateGameRecord], game_id: &str) -> CoreResult<()> {
    if games.iter().any(|game| game.id == game_id) {
        Ok(())
    } else {
        Err(domain("ROLE_GAME_INVALID", "Role game is invalid."))
    }
}

fn builtin_definition(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match id {
        "builtin-flyff-universe" => Some(("flyff-universe", "Flyff Universe", DEFAULT_LAUNCH_URL)),
        "builtin-feifei-infinite-universe" => Some((
            "feifei-infinite-universe",
            "飞飞：无限宇宙",
            "https://ffcli.ruiwoo.cn",
        )),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameRecord {
    id: String,
    source: String,
    name: String,
    default_launch_url: String,
    browser_launch_mode: String,
    created_at: String,
    updated_at: String,
}

pub fn validate_game_browser_settings(settings: &GameBrowserSettingsRecord) -> CoreResult<()> {
    one_of(
        &settings.fonts.mode,
        &["default", "custom"],
        "browser font mode",
    )?;
    if settings.fonts.families.iter().any(|(key, value)| {
        !matches!(
            key.as_str(),
            "standard" | "serif" | "sansserif" | "fixed" | "math"
        ) || value.trim().is_empty()
            || value.len() > 120
    }) {
        return Err(CoreError::InvalidInput(
            "browser font families are invalid".to_owned(),
        ));
    }
    one_of(
        &settings.graphics.backend.macos,
        &["automatic", "metal"],
        "macOS browser graphics backend",
    )?;
    one_of(
        &settings.graphics.backend.windows,
        &["automatic", "d3d11", "d3d11on12", "vulkan"],
        "Windows browser graphics backend",
    )?;
    if !settings.graphics.frame_rate_limit_enabled && settings.graphics.vsync_enabled {
        return Err(CoreError::InvalidInput(
            "browser VSync requires the frame-rate limiter".to_owned(),
        ));
    }
    one_of(
        &settings.launch_mode,
        &["auto", "embedded", "external"],
        "browser launch mode",
    )?;
    one_of(
        &settings.macro_badge_position.horizontal_align,
        &["left", "center", "right"],
        "macro badge alignment",
    )?;
    if settings.macro_badge_position.horizontal_margin_px > 128
        || !settings
            .macro_badge_position
            .horizontal_margin_px
            .is_multiple_of(8)
        || settings.macro_badge_position.top_px > 320
        || !settings.macro_badge_position.top_px.is_multiple_of(8)
    {
        return Err(CoreError::InvalidInput(
            "macro badge position is invalid".to_owned(),
        ));
    }
    one_of(
        &settings.network.cdn_compatibility.mode,
        &["off", "auto", "on"],
        "CDN compatibility mode",
    )?;
    one_of(
        &settings.network.proxy.mode,
        &["system", "custom"],
        "browser proxy mode",
    )?;
    if settings.network.proxy.mode == "custom" {
        let proxy = Url::parse(&settings.network.proxy.server)
            .map_err(|_| CoreError::InvalidInput("browser proxy is invalid".to_owned()))?;
        if !matches!(proxy.scheme(), "http" | "https" | "socks4" | "socks5")
            || proxy.host_str().is_none()
        {
            return Err(CoreError::InvalidInput(
                "browser proxy is invalid".to_owned(),
            ));
        }
    }
    one_of(
        &settings.workspace.background,
        &["material", "black"],
        "workspace background",
    )?;
    if !matches!(settings.workspace.gap, 1 | 2 | 4 | 6 | 8 | 12 | 16) {
        return Err(CoreError::InvalidInput(
            "workspace gap is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn normalize_game_browser_settings(
    mut settings: GameBrowserSettingsRecord,
) -> GameBrowserSettingsRecord {
    if !matches!(settings.fonts.mode.as_str(), "default" | "custom") {
        settings.fonts.mode = "default".to_owned();
    }
    settings.fonts.families.retain(|key, value| {
        if !matches!(
            key.as_str(),
            "standard" | "serif" | "sansserif" | "fixed" | "math"
        ) {
            return false;
        }
        let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty()
            || normalized.len() > 120
            || normalized.chars().any(char::is_control)
        {
            return false;
        }
        *value = normalized;
        true
    });
    if settings.fonts.mode == "default" {
        settings.fonts.families.clear();
    }
    if !matches!(
        settings.graphics.backend.macos.as_str(),
        "automatic" | "metal"
    ) {
        settings.graphics.backend.macos = "automatic".to_owned();
    }
    if !matches!(
        settings.graphics.backend.windows.as_str(),
        "automatic" | "d3d11" | "d3d11on12" | "vulkan"
    ) {
        settings.graphics.backend.windows = "automatic".to_owned();
    }
    if !settings.graphics.frame_rate_limit_enabled {
        settings.graphics.vsync_enabled = false;
    }
    if !matches!(
        settings.launch_mode.as_str(),
        "auto" | "embedded" | "external"
    ) {
        settings.launch_mode = "auto".to_owned();
    }
    if !matches!(
        settings.macro_badge_position.horizontal_align.as_str(),
        "left" | "center" | "right"
    ) {
        settings.macro_badge_position.horizontal_align = "center".to_owned();
    }
    if settings.macro_badge_position.horizontal_margin_px > 128
        || !settings
            .macro_badge_position
            .horizontal_margin_px
            .is_multiple_of(8)
    {
        settings.macro_badge_position.horizontal_margin_px = 8;
    }
    if settings.macro_badge_position.top_px > 320
        || !settings.macro_badge_position.top_px.is_multiple_of(8)
    {
        settings.macro_badge_position.top_px = 128;
    }
    if !matches!(
        settings.network.cdn_compatibility.mode.as_str(),
        "off" | "auto" | "on"
    ) {
        settings.network.cdn_compatibility.mode = "auto".to_owned();
    }
    settings.network.proxy.server = settings.network.proxy.server.trim().to_owned();
    let normalized_proxy = (settings.network.proxy.mode == "custom")
        .then(|| Url::parse(&settings.network.proxy.server).ok())
        .flatten()
        .filter(|url| {
            matches!(url.scheme(), "http" | "https" | "socks4" | "socks5")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && (url.path().is_empty() || url.path() == "/")
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .map(|url| {
            let mut value = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
            if let Some(port) = url.port() {
                value.push_str(&format!(":{port}"));
            }
            value
        });
    if let Some(server) = normalized_proxy {
        settings.network.proxy.mode = "custom".to_owned();
        settings.network.proxy.server = server;
    } else {
        settings.network.proxy.mode = "system".to_owned();
        settings.network.proxy.server.clear();
    }
    if !matches!(settings.workspace.background.as_str(), "material" | "black") {
        settings.workspace.background = "material".to_owned();
    }
    if !matches!(settings.workspace.gap, 1 | 2 | 4 | 6 | 8 | 12 | 16) {
        settings.workspace.gap = 4;
    }
    settings
}

pub fn normalize_macro_settings(mut settings: MacroSettingsRecord) -> MacroSettingsRecord {
    if settings.startup_delay_ms > 10_000 {
        settings.startup_delay_ms = 100;
    }
    if !(20..=1_000).contains(&settings.key_hold_ms) {
        settings.key_hold_ms = 30;
    }
    if !(10..=1_000).contains(&settings.post_input_delay_ms) {
        settings.post_input_delay_ms = 30;
    }
    if settings.default_loop_delay_ms > 86_400_000 {
        settings.default_loop_delay_ms = 1_000;
    }
    settings
}

pub fn validate_macro_settings(settings: &MacroSettingsRecord) -> CoreResult<()> {
    if settings.startup_delay_ms > 10_000
        || !(20..=1_000).contains(&settings.key_hold_ms)
        || !(10..=1_000).contains(&settings.post_input_delay_ms)
        || settings.default_loop_delay_ms > 86_400_000
    {
        return Err(CoreError::InvalidInput(
            "macro settings are invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn validate_legal_acceptance(acceptance: &LegalAcceptanceRecord) -> CoreResult<()> {
    if acceptance.schema_version != 1
        || chrono::DateTime::parse_from_rfc3339(&acceptance.accepted_at).is_err()
        || [
            &acceptance.accepted_fair_use_version,
            &acceptance.accepted_terms_version,
            &acceptance.acknowledged_privacy_version,
        ]
        .into_iter()
        .any(|value| value.trim().is_empty())
    {
        return Err(CoreError::InvalidInput(
            "legal acceptance is invalid".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleRecord {
    id: String,
    game_id: String,
    name: String,
    launch_url: String,
    notes: String,
    #[serde(default)]
    browser_session_source: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    id: String,
    name: String,
    template: String,
    browser_launch_mode: String,
    browser_zoom_mode: String,
    browser_zoom_percent: f64,
    resource_policy: ResourcePolicy,
    slots: Vec<WorkspaceSlot>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ResourcePolicy {
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSlot {
    id: String,
    #[serde(default)]
    role_id: Option<String>,
    rect: NormalizedRect,
}

#[derive(Debug, Deserialize)]
struct NormalizedRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacroRecord {
    id: String,
    #[serde(rename = "enabled")]
    _enabled: bool,
    #[serde(default)]
    activation_mode: Option<String>,
    name: String,
    role_ids: Vec<String>,
    repeat: ValidatedMacroRepeat,
    steps: Vec<MacroStep>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ValidatedMacroRepeat {
    Once,
    Loop {
        #[serde(rename = "intervalMs")]
        interval_ms: u32,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MacroStep {
    Key {
        id: String,
        code: String,
        #[serde(default)]
        action: Option<String>,
    },
    Click {
        id: String,
        #[serde(default)]
        unit: Option<String>,
        #[serde(rename = "xPercent")]
        #[serde(default)]
        x_percent: Option<f64>,
        #[serde(rename = "yPercent")]
        #[serde(default)]
        y_percent: Option<f64>,
        #[serde(rename = "xPx")]
        #[serde(default)]
        x_px: Option<f64>,
        #[serde(rename = "yPx")]
        #[serde(default)]
        y_px: Option<f64>,
    },
    Delay {
        id: String,
        ms: u32,
    },
    Macro {
        id: String,
        #[serde(rename = "macroId")]
        macro_id: String,
        #[serde(rename = "callMode")]
        #[serde(default)]
        call_mode: Option<String>,
    },
}

pub fn validate_collection_record(collection: StateCollection, value: &Value) -> CoreResult<()> {
    match collection {
        StateCollection::Games => validate_game(decode(value, "game")?),
        StateCollection::Roles => validate_role(decode(value, "role")?),
        StateCollection::LaunchWorkspaces => validate_workspace(decode(value, "workspace")?),
        StateCollection::Macros => validate_macro(decode(value, "macro")?),
        StateCollection::CompatibilityReports => {
            validate_compatibility_report(decode(value, "compatibility report")?)
        }
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: &Value, label: &str) -> CoreResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|error| CoreError::InvalidInput(format!("invalid {label}: {error}")))
}

fn validate_game(game: GameRecord) -> CoreResult<()> {
    non_empty(&game.id, "game id")?;
    non_empty(&game.name, "game name")?;
    one_of(&game.source, &["builtin", "custom"], "game source")?;
    one_of(
        &game.browser_launch_mode,
        &["inherit", "auto", "embedded", "external"],
        "game browser launch mode",
    )?;
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
    if let Some(source) = role.browser_session_source {
        one_of(
            &source,
            &["embedded", "chrome-profile"],
            "role browser session source",
        )?;
    }
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
    one_of(
        &workspace.browser_launch_mode,
        &["inherit", "auto", "embedded", "external"],
        "workspace browser launch mode",
    )?;
    one_of(
        &workspace.browser_zoom_mode,
        &["adaptive", "fixed"],
        "workspace browser zoom mode",
    )?;
    if !(25.0..=125.0).contains(&workspace.browser_zoom_percent) {
        return Err(CoreError::InvalidInput(
            "workspace browser zoom is out of range".to_owned(),
        ));
    }
    one_of(
        &workspace.resource_policy.mode,
        &["unrestricted", "adaptive"],
        "workspace resource mode",
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
            MacroStep::Key { code, action, .. } => {
                non_empty(&code, "macro key code")?;
                if let Some(action) = action {
                    one_of(&action, &["tap", "hold_until_stop"], "macro key action")?;
                }
            }
            MacroStep::Click {
                unit,
                x_percent,
                y_percent,
                x_px,
                y_px,
                ..
            } => {
                let uses_pixels = unit.as_deref() == Some("px");
                let coordinates = if uses_pixels {
                    [x_px, y_px]
                } else {
                    [x_percent, y_percent]
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

fn validate_compatibility_report(report: StateCompatibilityReportRecord) -> CoreResult<()> {
    non_empty(&report.game_id, "compatibility report gameId")?;
    if let Some(checked_at) = report.checked_at {
        timestamp(&checked_at, "compatibility report checkedAt")?;
    }
    if let Some(load) = report.load {
        one_of(
            &load.state,
            &["available", "failed", "cancelled"],
            "compatibility load state",
        )?;
        if let Some(origin) = load.final_origin {
            http_url(&origin, "compatibility final origin")?;
        }
    }
    if let Some(graphics) = report.graphics {
        for (label, availability) in [
            ("WebGL", graphics.webgl),
            ("WebGL2", graphics.webgl2),
            ("WebGPU", graphics.webgpu),
        ] {
            one_of(
                &availability,
                &["available", "unavailable", "unknown"],
                label,
            )?;
        }
    }
    if let Some(chrome) = report.system_chrome {
        one_of(
            &chrome.state,
            &["available", "unavailable"],
            "system Chrome state",
        )?;
    }
    if let Some(recommendation) = report.recommendation {
        if let Some(mode) = recommendation.mode {
            one_of(
                &mode,
                &["auto", "embedded", "external"],
                "compatibility recommendation mode",
            )?;
        }
        one_of(
            &recommendation.reason,
            &[
                "embedded_available",
                "external_recommended",
                "chrome_required",
                "graphics_unavailable",
            ],
            "compatibility recommendation reason",
        )?;
    }
    for (label, value) in [
        (
            "lastEmbeddedSuccessAt",
            report.observations.last_embedded_success_at,
        ),
        (
            "lastExternalSuccessAt",
            report.observations.last_external_success_at,
        ),
        ("lastFallbackAt", report.observations.last_fallback_at),
        (
            "lastLaunchFailureAt",
            report.observations.last_launch_failure_at,
        ),
    ] {
        if let Some(value) = value {
            timestamp(&value, label)?;
        }
    }
    Ok(())
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

fn timestamp(value: &str, label: &str) -> CoreResult<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| CoreError::InvalidInput(format!("{label} is invalid")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn validates_typed_domain_records() {
        let game = json!({
            "id":"g1","source":"custom","name":"Game",
            "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
        });
        validate_collection_record(StateCollection::Games, &game).unwrap();
        let mut invalid = game;
        invalid["defaultLaunchUrl"] = json!("file:///tmp/game");
        assert!(validate_collection_record(StateCollection::Games, &invalid).is_err());
    }

    #[test]
    fn normalizes_browser_and_macro_settings_before_persistence() {
        let settings = serde_json::from_value(json!({
            "fonts":{"mode":"custom","families":{"fixed":"  Courier   New  ","bad":"Ignored"}},
            "graphics":{"mode":"high_performance"},
            "launchMode":"external",
            "macroBadgePosition":{"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280},
            "network":{"cdnCompatibility":{"mode":"on"},"proxy":{"mode":"custom","server":" socks5://127.0.0.1:7890/ "}},
            "workspace":{"background":"black","gap":12}
        })).unwrap();
        let settings = normalize_game_browser_settings(settings);
        assert_eq!(settings.fonts.families["fixed"], "Courier New");
        assert!(!settings.fonts.families.contains_key("bad"));
        assert_eq!(settings.network.proxy.server, "socks5://127.0.0.1:7890");
        assert!(settings.graphics.prefer_high_performance_gpu);
        assert!(settings.graphics.gpu_blocklist_enabled);
        assert!(!settings.graphics.unsafe_web_gpu_enabled);
        validate_game_browser_settings(&settings).unwrap();

        let mut invalid_graphics = settings.clone();
        invalid_graphics.graphics.backend.windows = "unsupported".to_owned();
        invalid_graphics.graphics.frame_rate_limit_enabled = false;
        invalid_graphics.graphics.vsync_enabled = true;
        let invalid_graphics = normalize_game_browser_settings(invalid_graphics);
        assert_eq!(invalid_graphics.graphics.backend.windows, "automatic");
        assert!(!invalid_graphics.graphics.vsync_enabled);
        validate_game_browser_settings(&invalid_graphics).unwrap();

        let mut invalid_proxy = settings.clone();
        invalid_proxy.network.proxy.mode = "custom".to_owned();
        invalid_proxy.network.proxy.server = "ftp://127.0.0.1:7890".to_owned();
        let invalid_proxy = normalize_game_browser_settings(invalid_proxy);
        assert_eq!(invalid_proxy.network.proxy.mode, "system");
        assert!(invalid_proxy.network.proxy.server.is_empty());

        let macros = normalize_macro_settings(MacroSettingsRecord {
            startup_delay_ms: 10_001,
            key_hold_ms: 0,
            post_input_delay_ms: 0,
            default_loop_delay_ms: 86_400_001,
        });
        assert_eq!(macros.startup_delay_ms, 100);
        assert_eq!(macros.key_hold_ms, 30);
        assert_eq!(macros.post_input_delay_ms, 30);
        assert_eq!(macros.default_loop_delay_ms, 1_000);
    }

    #[test]
    fn property_generated_game_names_are_trimmed_and_bounded() {
        let mut seed = 0x5eed_u64;
        for length in 1..=160 {
            let generated = (0..length)
                .map(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    char::from(b'a' + ((seed >> 32) % 26) as u8)
                })
                .collect::<String>();
            let input = GameCreateInputRecord {
                name: format!("  {generated}  "),
                default_launch_url: "https://example.test/play".to_owned(),
                icon_image_data_url: None,
                cover_image_data_url: None,
                browser_launch_mode: None,
            };
            let mut games = Vec::new();
            let result = create_game(&mut games, input);
            if length <= 80 {
                let game = result.unwrap();
                assert_eq!(game.name, generated);
                assert_eq!(games.len(), 1);
            } else {
                assert!(result.is_err());
                assert!(games.is_empty());
            }
        }
    }
}
