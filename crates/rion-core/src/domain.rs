use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::StateCollection,
    model::{
        BrowserFontSettingsRecord, BrowserGraphicsSettingsRecord, DisplayTargetRecord,
        GameBrowserSettingsRecord, GameCreateInputRecord, GameUpdateInputRecord,
        GameWindowCreateInputRecord, GameWindowPlacementRecord, GameWindowUpdateInputRecord,
        LegalAcceptanceRecord, MacroBadgePositionRecord, MacroCreateInputRecord, MacroRepeat,
        MacroSettingsRecord, MacroStepDefinition, MacroStepInputRecord, MacroTrigger,
        MacroUpdateInputRecord, RoleCreateInputRecord, RoleGameAssignmentRecord,
        RoleUpdateInputRecord, RuntimeRestoreSessionRecord, RuntimeRestoreTabRecord,
        RuntimeRestoreWindowRecord, RuntimeWindowPreferencesRecord, StateCompatibilityReportRecord,
        StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord, StateMacroRecord,
        StateNormalizedRectRecord, StateRoleRecord, StateWorkspaceSlotRecord,
        WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord, WorkspaceSlotInputRecord,
        WorkspaceUpdateInputRecord,
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
        graphics: BrowserGraphicsSettingsRecord::recommended_default(),
        macro_badge_position: MacroBadgePositionRecord {
            horizontal_align: "center".to_owned(),
            horizontal_margin_px: 8,
            top_px: 128,
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
        always_hide_tab_close_button: false,
        always_show_toolbar_in_full_screen: false,
        restore_game_windows_on_startup: true,
    }
}

pub fn default_runtime_restore_session() -> RuntimeRestoreSessionRecord {
    RuntimeRestoreSessionRecord {
        schema_version: 2,
        session_generation: 0,
        updated_at: chrono::Utc::now().to_rfc3339(),
        clean_exit: true,
        last_focused_window_id: None,
        restore_in_progress_window_ids: Vec::new(),
        windows: Vec::new(),
    }
}

pub fn normalize_runtime_restore_session(
    session: RuntimeRestoreSessionRecord,
) -> CoreResult<RuntimeRestoreSessionRecord> {
    const MAX_WINDOWS: usize = 32;
    const MAX_TABS: usize = 256;
    const MAX_LABEL_LENGTH: usize = 256;

    let mut window_ids = HashSet::new();
    let mut source_keys = HashSet::new();
    let mut claimed_role_ids = HashSet::new();
    let mut tab_count = 0usize;
    let mut windows = Vec::new();

    for window in session.windows.into_iter().take(MAX_WINDOWS) {
        let window_id = window.id.trim();
        if window_id.is_empty() || window_id.len() > 128 || !window_ids.insert(window_id.to_owned())
        {
            continue;
        }
        let target_display = validate_display_target(window.target_display)?;

        let mut tabs = Vec::new();
        for tab in window.tabs {
            if tab_count >= MAX_TABS {
                break;
            }
            let source_id = tab.source_id.trim();
            if source_id.is_empty() || source_id.len() > 128 {
                continue;
            }
            if !matches!(tab.tab_type.as_str(), "role" | "workspace") {
                continue;
            }
            let source_key = format!("{}:{source_id}", tab.tab_type);
            if source_keys.contains(&source_key) {
                continue;
            }
            let mut role_ids = Vec::new();
            let mut seen_role_ids = HashSet::new();
            let input_role_ids = if tab.tab_type == "role" {
                vec![source_id.to_owned()]
            } else {
                tab.role_ids
            };
            for role_id in input_role_ids {
                let role_id = role_id.trim();
                if !role_id.is_empty()
                    && role_id.len() <= 128
                    && seen_role_ids.insert(role_id.to_owned())
                {
                    role_ids.push(role_id.to_owned());
                }
            }
            if role_ids
                .iter()
                .any(|role_id| claimed_role_ids.contains(role_id))
            {
                continue;
            }
            source_keys.insert(source_key);
            claimed_role_ids.extend(role_ids.iter().cloned());
            let name = tab.name.trim();
            tabs.push(RuntimeRestoreTabRecord {
                tab_type: tab.tab_type,
                source_id: source_id.to_owned(),
                name: if name.is_empty() {
                    source_id.to_owned()
                } else {
                    name.chars().take(MAX_LABEL_LENGTH).collect()
                },
                role_ids,
                hidden: tab.hidden,
                audio_muted: tab.audio_muted,
            });
            tab_count += 1;
        }
        if tabs.is_empty() {
            continue;
        }
        let active_source_id = window.active_source_id.and_then(|active| {
            let active = active.trim().to_owned();
            tabs.iter()
                .any(|tab| tab.source_id == active)
                .then_some(active)
        });
        windows.push(RuntimeRestoreWindowRecord {
            id: window_id.to_owned(),
            target_display,
            was_visible: window.was_visible,
            active_source_id,
            tabs,
        });
    }

    let last_focused_window_id = session.last_focused_window_id.and_then(|window_id| {
        let window_id = window_id.trim().to_owned();
        (!window_id.is_empty() && window_id.len() <= 128).then_some(window_id)
    });
    let mut restore_in_progress_window_ids = session
        .restore_in_progress_window_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .collect::<Vec<_>>();
    restore_in_progress_window_ids.sort();
    restore_in_progress_window_ids.dedup();
    restore_in_progress_window_ids.truncate(MAX_WINDOWS);
    Ok(RuntimeRestoreSessionRecord {
        schema_version: 2,
        session_generation: session.session_generation,
        updated_at: chrono::Utc::now().to_rfc3339(),
        clean_exit: session.clean_exit,
        last_focused_window_id,
        restore_in_progress_window_ids,
        windows,
    })
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
    let now = chrono::Utc::now().to_rfc3339();
    let workspace = StateLaunchWorkspaceRecord {
        id: Uuid::new_v4().to_string(),
        name,
        template: template.clone(),
        browser_zoom_mode: normalize_workspace_zoom_mode(input.browser_zoom_mode.as_deref())?,
        browser_zoom_percent: normalize_workspace_zoom_percent(
            input.browser_zoom_percent,
            default_workspace_zoom_percent(&template),
        )?,
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
    let workspace = StateLaunchWorkspaceRecord {
        id: current.id.clone(),
        name,
        template,
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

pub fn validate_game_window_collection(game_windows: &[StateGameWindowRecord]) -> CoreResult<()> {
    if game_windows.len() > 32 {
        return Err(domain(
            "GAME_WINDOW_LIMIT_REACHED",
            "No more than 32 game windows can be saved.",
        ));
    }
    let mut names = HashSet::new();
    let mut window_ids = HashSet::new();
    let mut source_keys = HashSet::new();
    let mut claimed_role_ids = HashSet::new();
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
        for tab in &window.tabs {
            tab_count += 1;
            let source_key = format!("{}:{}", tab.tab_type, tab.source_id);
            if !source_keys.insert(source_key)
                || tab
                    .role_ids
                    .iter()
                    .any(|role_id| !claimed_role_ids.insert(role_id.clone()))
            {
                return Err(domain(
                    "GAME_WINDOW_TAB_CONFLICT",
                    "A role or source can belong to only one saved game-window tab.",
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
        tab.role_ids = tab
            .role_ids
            .drain(..)
            .map(|role_id| role_id.trim().to_owned())
            .filter(|role_id| !role_id.is_empty() && role_id.len() <= 128)
            .filter(|role_id| role_ids.insert(role_id.clone()))
            .collect();
        if tab.tab_type == "role" && tab.role_ids != [tab.source_id.clone()] {
            return Err(domain(
                "GAME_WINDOW_TAB_INVALID",
                "A role tab must contain exactly its source role.",
            ));
        }
        for view in &tab.role_views {
            let rect = &view.rect;
            if view.role_id.trim().is_empty()
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
                || !view.browser_zoom_percent.is_finite()
                || !(25.0..=500.0).contains(&view.browser_zoom_percent)
            {
                return Err(domain(
                    "GAME_WINDOW_TAB_LAYOUT_INVALID",
                    "Game window tab layout is invalid.",
                ));
            }
        }
    }
    window.active_tab_id = if window.tabs.is_empty() {
        None
    } else {
        window
            .active_tab_id
            .filter(|active| window.tabs.iter().any(|tab| &tab.id == active))
            .or_else(|| window.tabs.first().map(|tab| tab.id.clone()))
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
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    id: String,
    name: String,
    template: String,
    browser_zoom_mode: String,
    browser_zoom_percent: f64,
    slots: Vec<WorkspaceSlot>,
    created_at: String,
    updated_at: String,
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
        StateCollection::GameWindows => {
            normalize_game_window(decode(value, "game window")?).map(|_| ())
        }
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
    if let Some(recommendation) = report.recommendation {
        one_of(
            &recommendation.reason,
            &[
                "system_webview_available",
                "load_failed",
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

    fn macro_input(value: Value) -> MacroCreateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn macro_update(value: Value) -> MacroUpdateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn workspace_input(value: Value) -> WorkspaceCreateInputRecord {
        serde_json::from_value(value).unwrap()
    }

    fn game_window_input(name: &str) -> GameWindowCreateInputRecord {
        serde_json::from_value(json!({
            "name": name,
            "targetDisplay": { "id": 7 },
            "placement": {
                "normalBounds": { "x": 900, "y": 600, "width": 100, "height": 100 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1000, "height": 700 },
                "presentation": "normal"
            }
        }))
        .unwrap()
    }

    fn game_record(value: Value) -> StateGameRecord {
        serde_json::from_value(value).unwrap()
    }

    fn role_record(value: Value) -> StateRoleRecord {
        serde_json::from_value(value).unwrap()
    }

    fn assert_workspace_template(template: &str, expected_zoom: f64, expected_rects: &[[f64; 4]]) {
        let mut workspaces = Vec::new();
        let workspace = create_workspace(
            &mut workspaces,
            workspace_input(json!({"name":"Layout","template":template})),
        )
        .unwrap();
        assert_eq!(workspace.browser_zoom_percent, expected_zoom);
        assert_eq!(workspace.slots.len(), expected_rects.len());
        for (slot, expected) in workspace.slots.iter().zip(expected_rects) {
            assert_eq!(
                [slot.rect.x, slot.rect.y, slot.rect.width, slot.rect.height],
                *expected
            );
        }
    }

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
    fn game_windows_normalize_geometry_enforce_limits_and_reject_role_conflicts() {
        let mut windows = Vec::new();
        let first = create_game_window(&mut windows, game_window_input("  Main  ")).unwrap();
        assert_eq!(first.name, "Main");
        assert_eq!(first.placement.normal_bounds.width, 640);
        assert_eq!(first.placement.normal_bounds.height, 480);
        assert_eq!(first.placement.normal_bounds.x, 360);
        assert_eq!(first.placement.normal_bounds.y, 220);
        assert_eq!(
            create_game_window(&mut windows, game_window_input("main"))
                .unwrap_err()
                .code(),
            "GAME_WINDOW_NAME_DUPLICATE"
        );

        let second = create_game_window(&mut windows, game_window_input("Second")).unwrap();
        let role_tab = |id: String| {
            serde_json::from_value(json!({
                "id": id,
                "tabType": "role",
                "sourceId": "role-1",
                "name": "Role 1",
                "roleIds": ["role-1"],
                "hidden": false,
                "audioMuted": false,
                "roleViews": []
            }))
            .unwrap()
        };
        update_game_window(
            &mut windows,
            &first.id,
            GameWindowUpdateInputRecord {
                tabs: Some(vec![role_tab(Uuid::new_v4().to_string())]),
                ..GameWindowUpdateInputRecord::default()
            },
        )
        .unwrap();
        assert_eq!(
            update_game_window(
                &mut windows,
                &second.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(vec![role_tab(Uuid::new_v4().to_string())]),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap_err()
            .code(),
            "GAME_WINDOW_TAB_CONFLICT"
        );

        for number in 3..=32 {
            create_game_window(&mut windows, game_window_input(&format!("Window {number}")))
                .unwrap();
        }
        assert_eq!(
            create_game_window(&mut windows, game_window_input("Window 33"))
                .unwrap_err()
                .code(),
            "GAME_WINDOW_LIMIT_REACHED"
        );

        let mut tab_windows = Vec::new();
        let tab_window =
            create_game_window(&mut tab_windows, game_window_input("Tab limit")).unwrap();
        let tabs = (0..257)
            .map(|index| {
                let role_id = format!("role-{index}");
                serde_json::from_value(json!({
                    "id": Uuid::new_v4().to_string(),
                    "tabType": "role",
                    "sourceId": role_id,
                    "name": format!("Role {index}"),
                    "roleIds": [role_id],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
                }))
                .unwrap()
            })
            .collect();
        assert_eq!(
            update_game_window(
                &mut tab_windows,
                &tab_window.id,
                GameWindowUpdateInputRecord {
                    tabs: Some(tabs),
                    ..GameWindowUpdateInputRecord::default()
                },
            )
            .unwrap_err()
            .code(),
            "GAME_WINDOW_TAB_LIMIT_REACHED"
        );
    }

    #[test]
    fn normalizes_browser_and_macro_settings_before_persistence() {
        let settings = serde_json::from_value(json!({
            "fonts":{"mode":"custom","families":{"fixed":"  Courier   New  ","bad":"Ignored"}},
            "graphics":{"mode":"high_performance"},
            "launchMode":"external",
            "macroBadgePosition":{"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280},
            "workspace":{"background":"black","gap":12}
        }))
        .unwrap();
        let settings = normalize_game_browser_settings(settings);
        assert_eq!(settings.fonts.families["fixed"], "Courier New");
        assert!(!settings.fonts.families.contains_key("bad"));
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

        crate::v1_case!("state-migration-40f54d27f418", {
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
        });

        crate::v1_case!("state-migration-16455f5cd61d", {
            let defaults = default_game_browser_settings();
            validate_game_browser_settings(&defaults).unwrap();
            assert_eq!(defaults.workspace.background, "material");
            assert_eq!(defaults.workspace.gap, 4);
        });
        crate::v1_case!("state-migration-53ba1094014a", {
            let defaults = default_macro_settings();
            validate_macro_settings(&defaults).unwrap();
            assert_eq!(defaults.startup_delay_ms, 100);
            assert_eq!(defaults.key_hold_ms, 30);
            assert_eq!(defaults.post_input_delay_ms, 30);
            assert_eq!(defaults.default_loop_delay_ms, 1_000);
        });
    }

    #[test]
    fn normalizes_runtime_restore_sessions_and_keeps_first_conflicting_source() {
        let session: RuntimeRestoreSessionRecord = serde_json::from_value(json!({
            "schemaVersion": 9,
            "updatedAt": "stale",
            "cleanExit": false,
            "lastFocusedWindowId": "window-2",
            "windows": [
                {
                    "id": " window-1 ",
                    "targetDisplay": { "id": 7 },
                    "wasVisible": true,
                    "activeSourceId": "missing",
                    "tabs": [
                        {
                            "tabType": "role",
                            "sourceId": " role-1 ",
                            "name": " Main ",
                            "roleIds": ["role-1", "role-1", ""],
                            "hidden": false,
                            "audioMuted": true
                        },
                        {
                            "tabType": "invalid",
                            "sourceId": "ignored",
                            "name": "Ignored",
                            "roleIds": [],
                            "hidden": false,
                            "audioMuted": false
                        }
                    ]
                },
                {
                    "id": "window-2",
                    "targetDisplay": { "id": 8 },
                    "wasVisible": false,
                    "activeSourceId": "role-2",
                    "tabs": [
                        {
                            "tabType": "role",
                            "sourceId": "role-1",
                            "name": "Duplicate",
                            "roleIds": ["role-1"],
                            "hidden": false,
                            "audioMuted": false
                        },
                        {
                            "tabType": "workspace",
                            "sourceId": "workspace-conflict",
                            "name": "Conflicting Workspace",
                            "roleIds": ["role-1"],
                            "hidden": false,
                            "audioMuted": false
                        },
                        {
                            "tabType": "role",
                            "sourceId": "role-2",
                            "name": "",
                            "roleIds": ["role-2"],
                            "hidden": true,
                            "audioMuted": false
                        }
                    ]
                }
            ]
        }))
        .unwrap();

        let normalized = normalize_runtime_restore_session(session).unwrap();

        assert_eq!(normalized.schema_version, 2);
        assert!(!normalized.clean_exit);
        assert_eq!(
            normalized.last_focused_window_id.as_deref(),
            Some("window-2")
        );
        assert_eq!(normalized.windows.len(), 2);
        assert_eq!(normalized.windows[0].id, "window-1");
        assert_eq!(normalized.windows[0].active_source_id, None);
        assert_eq!(normalized.windows[0].tabs[0].name, "Main");
        assert_eq!(normalized.windows[0].tabs[0].role_ids, ["role-1"]);
        assert_eq!(normalized.windows[1].tabs.len(), 1);
        assert_eq!(normalized.windows[1].tabs[0].source_id, "role-2");
        assert_eq!(normalized.windows[1].tabs[0].name, "role-2");
    }

    #[test]
    fn runtime_window_preferences_default_to_startup_restore() {
        let preferences = default_runtime_window_preferences();
        assert!(!preferences.always_hide_tab_close_button);
        assert!(!preferences.always_show_toolbar_in_full_screen);
        assert!(preferences.restore_game_windows_on_startup);
        let legacy: RuntimeWindowPreferencesRecord = serde_json::from_value(json!({
            "alwaysShowToolbarInFullScreen": true
        }))
        .unwrap();
        assert!(!legacy.always_hide_tab_close_button);
        assert!(legacy.restore_game_windows_on_startup);
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

    #[test]
    fn macro_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-24fee99df77d", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Copy","roleIds":["r1"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let mut isolated = macros.clone();
            isolated[0].name = "Changed".to_owned();
            assert_eq!(macros[0].name, "Copy");
            assert_eq!(created.name, "Copy");
        });

        crate::v1_case!("state-migration-a59f6e22aea7", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Party","roleIds":["r1","r2"],
                    "steps":[{"type":"key","code":"F1"}]
                })),
            )
            .unwrap();
            assert_eq!(created.role_ids, vec!["r1", "r2"]);
            let updated = update_macro(
                &mut macros,
                &created.id,
                macro_update(json!({"name":"Party updated"})),
            )
            .unwrap();
            assert_eq!(updated.name, "Party updated");
            delete_macro(&mut macros, &created.id).unwrap();
            assert!(macros.is_empty());
        });

        crate::v1_case!("state-migration-7dd0a543761c", {
            let mut macros = Vec::new();
            let disabled = create_macro(
                &mut macros,
                macro_input(json!({
                    "enabled":false,"name":"Disabled","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let enabled = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Legacy default","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(!disabled.enabled);
            assert!(enabled.enabled);
        });

        crate::v1_case!("state-migration-18973c29ec15", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[
                        {"type":"macro","macroId":target.id},
                        {"type":"macro","macroId":target.id,"callMode":"trigger"}
                    ]
                })),
            )
            .unwrap();
            assert!(matches!(
                &parent.steps[0],
                MacroStepDefinition::Macro { call_mode: Some(mode), .. } if mode == "wait"
            ));
            assert!(matches!(
                &parent.steps[1],
                MacroStepDefinition::Macro { call_mode: Some(mode), .. } if mode == "trigger"
            ));
        });

        crate::v1_case!("state-migration-f5d8acae045e", {
            let mut macros = Vec::new();
            let held = create_macro(
                &mut macros,
                macro_input(json!({
                    "activationMode":"while_held",
                    "name":"Held","roleIds":["r1"],
                    "trigger":{"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            assert_eq!(held.activation_mode.as_deref(), Some("while_held"));
            assert!(matches!(
                &held.steps[0],
                MacroStepDefinition::Key { action: Some(action), .. } if action == "hold_until_stop"
            ));
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "activationMode":"while_held","name":"Invalid","roleIds":["r2"],
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-25770bd4824c", {
            let mut macros = Vec::new();
            let normalized = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Modifiers","roleIds":[],
                    "steps":[{
                        "type":"key","code":"KeyK",
                        "modifiers":["shift","primary","shift","alt"]
                    }]
                })),
            )
            .unwrap();
            assert!(matches!(
                &normalized.steps[0],
                MacroStepDefinition::Key { modifiers: Some(values), .. }
                    if values == &vec!["primary".to_owned(), "alt".to_owned(), "shift".to_owned()]
            ));
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Ambiguous","roleIds":[],
                        "steps":[{"type":"key","code":"KeyK","modifiers":["primary","ctrl"]}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-44163e85a900", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Held target","roleIds":[],
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Nested","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            assert!(matches!(
                &target.steps[0],
                MacroStepDefinition::Key { action: Some(action), .. }
                    if action == "hold_until_stop"
            ));
            assert!(matches!(
                &parent.steps[0],
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-905d5e9f3e52", {
            let mut macros = Vec::new();
            for name in ["Duplicate", "Duplicate"] {
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":name,"roleIds":[],
                        "repeat":{"type":"loop","intervalMs":86_400_000_u64},
                        "steps":[{"type":"delay","ms":86_400_000_u64}]
                    })),
                )
                .unwrap();
            }
            assert_eq!(macros.len(), 2);
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Too long","roleIds":[],
                        "repeat":{"type":"loop","intervalMs":86_400_001_u64},
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-4c9648c9e15d", {
            let invalid = serde_json::from_value::<MacroCreateInputRecord>(json!({
                "name":"Missing roles","steps":[{"type":"delay","ms":1}]
            }));
            assert!(invalid.is_err());
            let mut macros = Vec::new();
            let unassigned = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Unassigned","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(unassigned.role_ids.is_empty());
        });

        crate::v1_case!("state-migration-f03e9cfce6a3", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Roles","roleIds":[" r1 ","r1"," r2 "],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert_eq!(created.role_ids, vec!["r1", "r2"]);
        });

        crate::v1_case!("state-migration-a4407a2e1282", {
            let mut macros = Vec::new();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Empty","roleIds":[],"steps":[]
                    }))
                )
                .is_err()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Click","roleIds":[],
                        "steps":[{"type":"click","xPercent":101,"yPercent":0}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-238ae0807744", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Pixels","roleIds":[],
                    "steps":[{"type":"click","unit":"px","xPx":12.4,"yPx":34.6}]
                })),
            )
            .unwrap();
            assert!(matches!(
                &created.steps[0],
                MacroStepDefinition::Click {
                    position: crate::model::MacroClickDefinition::Pixels {
                        x_px, y_px, ..
                    },
                    ..
                } if *x_px == 12.0 && *y_px == 35.0
            ));
        });

        crate::v1_case!("state-migration-e8dafd40d2f5", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Anchored","roleIds":[],
                    "steps":[{
                        "type":"click","unit":"px","anchor":"bottom-right",
                        "xPx":-24,"yPx":-32
                    }]
                })),
            )
            .unwrap();
            assert!(matches!(
                &created.steps[0],
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Pixels {
                        x_px, y_px, ..
                    },
                    ..
                } if anchor == "bottom-right" && *x_px == -24.0 && *y_px == -32.0
            ));
        });

        crate::v1_case!("state-migration-f7980c6af8d2", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":["r1","r2"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":["r1"],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            clear_macro_role(&mut macros, "r1");
            assert_eq!(macros.len(), 2);
            assert_eq!(macros[0].role_ids, vec!["r2"]);
            assert!(macros[1].role_ids.is_empty());
            assert!(matches!(
                &macros[1].steps[0],
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-a3755087145d", {
            let mut macros = Vec::new();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Concurrent cleanup","roleIds":["r1","r2","r3"],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            clear_macro_role(&mut macros, "r1");
            clear_macro_role(&mut macros, "r2");
            assert_eq!(macros[0].role_ids, vec!["r3"]);
        });

        crate::v1_case!("state-migration-ee5e6e6e550a", {
            let mut macros = Vec::new();
            let created = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Zero wait","roleIds":[],
                    "repeat":{"type":"loop","intervalMs":0},
                    "steps":[{"type":"delay","ms":0}]
                })),
            )
            .unwrap();
            assert!(matches!(
                created.repeat,
                MacroRepeat::Loop { interval_ms: 0 }
            ));
            assert!(matches!(
                created.steps[0],
                MacroStepDefinition::Delay { ms: 0, .. }
            ));
        });

        crate::v1_case!("state-migration-11854785813c", {
            let trigger = json!({"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false});
            let mut macros = Vec::new();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"First","roleIds":["r1"],"trigger":trigger,
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Overlap","roleIds":["r1"],"trigger":trigger,
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Separate","roleIds":["r2"],"trigger":trigger,
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_ok()
            );
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Reserved","roleIds":["r3"],
                        "trigger":{"code":"KeyM","ctrl":true,"alt":false,"shift":true,"meta":false},
                        "steps":[{"type":"delay","ms":1}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-08dee212a406", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"id":"target-step","type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"id":"call-step","type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({"name":"Renamed target"})),
            )
            .unwrap();
            assert!(matches!(
                &macros.iter().find(|item| item.id == parent.id).unwrap().steps[0],
                MacroStepDefinition::Macro { id, macro_id, .. }
                    if id == "call-step" && macro_id == &target.id
            ));
        });

        crate::v1_case!("state-migration-5ec8118b2de8", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Loop","roleIds":[],
                    "repeat":{"type":"loop","intervalMs":1000},
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Caller","roleIds":[],
                        "steps":[{"type":"macro","macroId":target.id}]
                    }))
                )
                .is_ok()
            );
        });

        crate::v1_case!("state-migration-e1b19c8acafb", {
            let mut macros = Vec::new();
            assert!(
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":"Missing","roleIds":[],
                        "steps":[{"type":"macro","macroId":"missing"}]
                    }))
                )
                .is_err()
            );
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            assert!(
                update_macro(
                    &mut macros,
                    &target.id,
                    macro_update(json!({
                        "steps":[{"type":"macro","macroId":target.id}]
                    }))
                )
                .is_err()
            );
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            assert!(
                update_macro(
                    &mut macros,
                    &target.id,
                    macro_update(json!({
                        "steps":[{"type":"macro","macroId":parent.id}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-eaeea61f42ff", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let updated = update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({"repeat":{"type":"loop","intervalMs":500}})),
            )
            .unwrap();
            assert!(matches!(
                updated.repeat,
                MacroRepeat::Loop { interval_ms: 500 }
            ));
        });

        crate::v1_case!("state-migration-a995f2021932", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let updated = update_macro(
                &mut macros,
                &target.id,
                macro_update(json!({
                    "steps":[{"type":"key","code":"KeyW","action":"hold_until_stop"}]
                })),
            )
            .unwrap();
            assert!(matches!(
                updated.steps[0],
                MacroStepDefinition::Key { action: Some(ref action), .. }
                    if action == "hold_until_stop"
            ));
        });

        crate::v1_case!("state-migration-b436d48eb42a", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            for name in ["First referrer", "Second referrer"] {
                create_macro(
                    &mut macros,
                    macro_input(json!({
                        "name":name,"roleIds":[],
                        "steps":[{"type":"macro","macroId":target.id}]
                    })),
                )
                .unwrap();
            }
            let error = delete_macro(&mut macros, &target.id).unwrap_err();
            assert_eq!(error.code(), "MACRO_IN_USE");
            assert!(error.to_string().contains("First referrer"));
            assert!(error.to_string().contains("Second referrer"));
        });

        crate::v1_case!("state-migration-eb10d0654aa7", {
            let mut macros = Vec::new();
            let target = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Target","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let parent = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Parent","roleIds":[],
                    "steps":[{"type":"macro","macroId":target.id}]
                })),
            )
            .unwrap();
            let unrelated = create_macro(
                &mut macros,
                macro_input(json!({
                    "name":"Unrelated","roleIds":[],
                    "steps":[{"type":"delay","ms":1}]
                })),
            )
            .unwrap();
            let (deleted, skipped) =
                delete_macros(&mut macros, &[target.id.clone(), parent.id.clone()]);
            assert_eq!(deleted.len(), 2);
            assert!(skipped.is_empty());
            let (deleted, skipped) =
                delete_macros(&mut macros, &[unrelated.id.clone(), "missing".to_owned()]);
            assert_eq!(deleted, vec![unrelated.id]);
            assert_eq!(skipped[0].1, "not_found");
            assert!(macros.is_empty());
        });
    }

    #[test]
    fn workspace_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-1d14f6cf4383", {
            let mut workspaces = Vec::new();
            create_workspace(&mut workspaces, workspace_input(json!({"name":"Copy"}))).unwrap();
            let mut copy = workspaces.clone();
            copy[0].slots[0].role_id = Some("changed".to_owned());
            assert!(workspaces[0].slots[0].role_id.is_none());
        });

        crate::v1_case!("state-migration-16b79eaa516a", {
            let mut workspaces = Vec::new();
            let created =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Default"})))
                    .unwrap();
            assert_eq!(created.template, "two_columns");
            assert_eq!(created.browser_zoom_percent, 100.0);
            assert_eq!(created.slots.len(), 2);
            assert_eq!(created.slots[0].id, "slot-1");
            assert_eq!(created.slots[1].id, "slot-2");
        });

        crate::v1_case!("state-migration-75ebe8c3c038", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Zoom","slots":[
                        {"roleId":"r1","browserZoomPercent":125},
                        {"roleId":"r2"}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[0].browser_zoom_percent, Some(125.0));
            assert!(created.slots[1].browser_zoom_percent.is_none());
            assert!(
                create_workspace(
                    &mut workspaces,
                    workspace_input(json!({
                        "name":"Invalid zoom",
                        "slots":[{"roleId":"r3","browserZoomPercent":301}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-40b550e6e02f", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Assigned","slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({
                    "slots":[{"roleId":"r1"},{}]
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(
                set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r2", 125.0)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r1", 125.0)
                    .unwrap()
                    .unwrap()
                    .slots[0]
                    .browser_zoom_percent,
                Some(125.0)
            );
        });

        crate::v1_case!("state-migration-4ac7d2da52d7", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Serialized zoom",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r1", 110.0).unwrap();
            set_workspace_role_browser_zoom(&mut workspaces, &created.id, "r2", 125.0).unwrap();
            assert_eq!(workspaces[0].slots[0].browser_zoom_percent, Some(110.0));
            assert_eq!(workspaces[0].slots[1].browser_zoom_percent, Some(125.0));
        });

        crate::v1_case!("state-migration-b94ebf809cc1", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Adaptive",
                    "resourcePolicy":{"mode":"adaptive"}
                })),
            )
            .unwrap();
            assert!(
                serde_json::to_value(created)
                    .unwrap()
                    .get("resourcePolicy")
                    .is_none()
            );
        });

        crate::v1_case!("state-migration-a26b7bfb3502", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Cleanup",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            clear_workspace_role(&mut workspaces, "r2");
            assert!(
                workspaces[0]
                    .slots
                    .iter()
                    .all(|slot| slot.role_id.is_none())
            );
        });

        crate::v1_case!("state-migration-456c08bd8759", {
            let mut workspaces = Vec::new();
            let first = create_workspace(&mut workspaces, workspace_input(json!({"name":"First"})))
                .unwrap();
            let second =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Second"})))
                    .unwrap();
            let timestamps = [first.updated_at.clone(), second.updated_at.clone()];
            reorder_workspaces(&mut workspaces, &[second.id.clone(), first.id.clone()]).unwrap();
            assert_eq!(
                workspaces
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                vec![second.id.as_str(), first.id.as_str()]
            );
            assert_eq!(workspaces[0].updated_at, timestamps[1]);
            assert_eq!(workspaces[1].updated_at, timestamps[0]);
            let third = create_workspace(&mut workspaces, workspace_input(json!({"name":"Third"})))
                .unwrap();
            assert_eq!(workspaces.last().unwrap().id, third.id);
        });

        crate::v1_case!("state-migration-4b4f49acea6a", {
            let mut workspaces = Vec::new();
            let created =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Layout"})))
                    .unwrap();
            let updated = update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({
                    "template":"three_columns",
                    "slots":[{"roleId":"r1"},{"roleId":"r2"},{}]
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(updated.template, "three_columns");
            assert_eq!(updated.slots.len(), 3);
            assert!(
                update_workspace(
                    &mut workspaces,
                    &created.id,
                    serde_json::from_value(json!({
                        "slots":[{"roleId":"r1"},{"roleId":"r1"},{}]
                    }))
                    .unwrap(),
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-42919f758e6e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable thirds","template":"three_columns",
                    "slots":[
                        {"rect":{"x":0,"y":0,"width":0.25,"height":1}},
                        {"rect":{"x":0.25,"y":0,"width":0.5,"height":1}},
                        {"rect":{"x":0.75,"y":0,"width":0.25,"height":1}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[1].rect.width, 0.5);
        });

        crate::v1_case!("state-migration-b57b56106912", {
            assert_workspace_template(
                "three_columns",
                90.0,
                &[
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0],
                ],
            );
        });

        crate::v1_case!("state-migration-0350a4c0ff11", {
            let rects = normalize_workspace_rect_edges(vec![
                StateNormalizedRectRecord {
                    x: 0.0,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
                StateNormalizedRectRecord {
                    x: 0.3333,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
                StateNormalizedRectRecord {
                    x: 0.6667,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
            ]);
            assert_eq!(rects[1].width, 0.3334);
            assert_eq!(rects[0].width, 0.3333);
            assert_eq!(rects[2].width, 0.3333);
        });

        crate::v1_case!("state-migration-323cefb9afae", {
            assert_workspace_template(
                "main_right_stack_left",
                100.0,
                &[
                    [0.5, 0.0, 0.5, 1.0],
                    [0.0, 0.0, 0.5, 0.5],
                    [0.0, 0.5, 0.5, 0.5],
                ],
            );
        });

        crate::v1_case!("state-migration-1588b59a839e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable right","template":"main_right_stack_left",
                    "slots":[
                        {"rect":{"x":0.6,"y":0,"width":0.4,"height":1}},
                        {"rect":{"x":0,"y":0,"width":0.6,"height":0.4}},
                        {"rect":{"x":0,"y":0.4,"width":0.6,"height":0.6}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[0].rect.x, 0.6);
            assert_eq!(created.slots[2].rect.height, 0.6);
        });

        crate::v1_case!("state-migration-37306492d6a9", {
            assert_workspace_template(
                "main_center_side_stacks",
                80.0,
                &[
                    [0.3, 0.0, 0.4, 1.0],
                    [0.0, 0.0, 0.3, 0.5],
                    [0.0, 0.5, 0.3, 0.5],
                    [0.7, 0.0, 0.3, 0.5],
                    [0.7, 0.5, 0.3, 0.5],
                ],
            );
        });

        crate::v1_case!("state-migration-abb686727e4e", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Resizable four","template":"four_columns",
                    "slots":[
                        {"rect":{"x":0,"y":0,"width":0.2,"height":1}},
                        {"rect":{"x":0.2,"y":0,"width":0.3,"height":1}},
                        {"rect":{"x":0.5,"y":0,"width":0.3,"height":1}},
                        {"rect":{"x":0.8,"y":0,"width":0.2,"height":1}}
                    ]
                })),
            )
            .unwrap();
            assert_eq!(created.slots[1].rect.width, 0.3);
            assert_eq!(created.slots[3].rect.x, 0.8);
        });

        crate::v1_case!("state-migration-8e8c9045207a", {
            assert_workspace_template(
                "three_columns",
                90.0,
                &[
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0],
                ],
            );
        });
        crate::v1_case!("state-migration-7e275803fcea", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Quad","template":"quad"})),
            )
            .unwrap();
            assert_eq!(workspace.browser_zoom_percent, 90.0);
            assert_eq!(workspace.slots.len(), 4);
        });
        crate::v1_case!("state-migration-426c9c61f12c", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Four","template":"four_columns"})),
            )
            .unwrap();
            assert_eq!(workspace.browser_zoom_percent, 90.0);
            assert_eq!(workspace.slots.len(), 4);
        });

        crate::v1_case!("state-migration-781fa7614848", {
            let mut workspaces = Vec::new();
            let created = create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Custom zoom","browserZoomPercent":125
                })),
            )
            .unwrap();
            assert_eq!(created.browser_zoom_percent, 125.0);
            let updated = update_workspace(
                &mut workspaces,
                &created.id,
                serde_json::from_value(json!({"browserZoomPercent":90})).unwrap(),
            )
            .unwrap();
            assert_eq!(updated.browser_zoom_percent, 90.0);
            assert!(
                update_workspace(
                    &mut workspaces,
                    &created.id,
                    serde_json::from_value(json!({"browserZoomPercent":91})).unwrap(),
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-ebaa1c20914a", {
            assert_workspace_template(
                "four_columns",
                90.0,
                &[
                    [0.0, 0.0, 0.25, 1.0],
                    [0.25, 0.0, 0.25, 1.0],
                    [0.5, 0.0, 0.25, 1.0],
                    [0.75, 0.0, 0.25, 1.0],
                ],
            );
        });

        crate::v1_case!("state-migration-764ee3055e09", {
            assert_workspace_template(
                "three_top_two_bottom",
                80.0,
                &[
                    [0.0, 0.0, 0.3333, 0.5],
                    [0.3333, 0.0, 0.3334, 0.5],
                    [0.6667, 0.0, 0.3333, 0.5],
                    [0.0, 0.5, 0.5, 0.5],
                    [0.5, 0.5, 0.5, 0.5],
                ],
            );
        });
        crate::v1_case!("state-migration-fbdf387e5729", {
            assert_workspace_template(
                "two_top_three_bottom",
                80.0,
                &[
                    [0.0, 0.0, 0.5, 0.5],
                    [0.5, 0.0, 0.5, 0.5],
                    [0.0, 0.5, 0.3333, 0.5],
                    [0.3333, 0.5, 0.3334, 0.5],
                    [0.6667, 0.5, 0.3333, 0.5],
                ],
            );
        });
        crate::v1_case!("state-migration-e0ba5057971f", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Six","template":"six_grid"})),
            )
            .unwrap();
            assert_eq!(workspace.browser_zoom_percent, 80.0);
            assert_eq!(workspace.slots.len(), 6);
            assert_eq!(workspace.slots[3].rect.y, 0.5);
        });
        crate::v1_case!("state-migration-12fbf3f5504d", {
            let mut workspaces = Vec::new();
            let workspace = create_workspace(
                &mut workspaces,
                workspace_input(json!({"name":"Eight","template":"eight_grid"})),
            )
            .unwrap();
            assert_eq!(workspace.browser_zoom_percent, 75.0);
            assert_eq!(workspace.slots.len(), 8);
            assert_eq!(workspace.slots[4].rect.y, 0.5);
        });

        crate::v1_case!("state-migration-219a4ed72571", {
            let mut workspaces = Vec::new();
            create_workspace(&mut workspaces, workspace_input(json!({"name":"Party"}))).unwrap();
            assert!(
                create_workspace(&mut workspaces, workspace_input(json!({"name":" party "})))
                    .is_err()
            );
            assert!(
                create_workspace(
                    &mut workspaces,
                    workspace_input(json!({
                        "name":"Outside","template":"single",
                        "slots":[{},{"roleId":"r1"}]
                    }))
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-997864952f1b", {
            let mut workspaces = Vec::new();
            let workspace =
                create_workspace(&mut workspaces, workspace_input(json!({"name":"Order"})))
                    .unwrap();
            for order in [
                vec![],
                vec![workspace.id.clone(), workspace.id.clone()],
                vec!["missing".to_owned()],
            ] {
                let mut attempt = workspaces.clone();
                assert!(reorder_workspaces(&mut attempt, &order).is_err());
                assert_eq!(attempt[0].id, workspace.id);
            }
        });

        crate::v1_case!("state-migration-6bb1641c8896", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Keep","slots":[{"roleId":"r1"},{"roleId":"r2"}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            assert_eq!(workspaces.len(), 1);
            assert!(workspaces[0].slots[0].role_id.is_none());
            assert_eq!(workspaces[0].slots[1].role_id.as_deref(), Some("r2"));
        });

        crate::v1_case!("state-migration-002e4a037a07", {
            let mut workspaces = Vec::new();
            create_workspace(
                &mut workspaces,
                workspace_input(json!({
                    "name":"Adaptive cleanup",
                    "resourcePolicy":{"mode":"adaptive"},
                    "slots":[{"roleId":"r1"},{}]
                })),
            )
            .unwrap();
            clear_workspace_role(&mut workspaces, "r1");
            assert!(workspaces[0].slots[0].role_id.is_none());
            assert!(
                serde_json::to_value(&workspaces[0])
                    .unwrap()
                    .get("resourcePolicy")
                    .is_none()
            );
        });
    }

    #[test]
    fn game_and_role_store_domain_contracts_match_v1() {
        crate::v1_case!("state-migration-ece15253f5ea", {
            let mut games = Vec::new();
            create_game(
                &mut games,
                GameCreateInputRecord {
                    name: "Game".to_owned(),
                    default_launch_url: "https://example.test/play".to_owned(),
                    icon_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                    cover_image_data_url: Some("data:image/png;base64,Ag==".to_owned()),
                },
            )
            .unwrap();
            assert_eq!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: " game ".to_owned(),
                        default_launch_url: "https://other.test/play".to_owned(),
                        icon_image_data_url: None,
                        cover_image_data_url: None,
                    }
                )
                .unwrap_err()
                .code(),
                "GAME_NAME_DUPLICATE"
            );
            assert!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: "Bad URL".to_owned(),
                        default_launch_url: "file:///tmp/game".to_owned(),
                        icon_image_data_url: None,
                        cover_image_data_url: None,
                    }
                )
                .is_err()
            );
            assert!(
                create_game(
                    &mut games,
                    GameCreateInputRecord {
                        name: "Bad image".to_owned(),
                        default_launch_url: "https://image.test/play".to_owned(),
                        icon_image_data_url: Some("https://image.test/icon.png".to_owned()),
                        cover_image_data_url: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-d0148c9da12a", {
            let mut games = vec![game_record(json!({
                "id":"builtin-flyff-universe","source":"builtin",
                "builtinKey":"flyff-universe","name":"Flyff Universe",
                "defaultLaunchUrl":"https://override.test/play",
                "browserLaunchMode":"external",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }))];
            let protected = update_game(
                &mut games,
                "builtin-flyff-universe",
                GameUpdateInputRecord {
                    name: Some("Renamed".to_owned()),
                    ..GameUpdateInputRecord::default()
                },
            )
            .unwrap_err();
            assert_eq!(protected.code(), "GAME_BUILTIN_FIELD_PROTECTED");
            let reset = reset_builtin_game(&mut games, "builtin-flyff-universe").unwrap();
            assert_eq!(reset.name, "Flyff Universe");
            assert_eq!(reset.default_launch_url, "https://universe.flyff.com/play");
            assert!(delete_game(&mut games, &[], "builtin-flyff-universe").is_err());
        });

        crate::v1_case!("state-migration-12eeac5ebdd5", {
            let game = game_record(json!({
                "id":"g1","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            let role = role_record(json!({
                "id":"r1","gameId":"g1","name":"Role",
                "launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            let mut games = vec![game];
            let error = delete_game(&mut games, &[role], "g1").unwrap_err();
            assert_eq!(error.code(), "GAME_IN_USE");
            assert_eq!(games.len(), 1);
        });

        let games = vec![
            game_record(json!({
                "id":"g1","source":"custom","name":"One",
                "defaultLaunchUrl":"https://one.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
            game_record(json!({
                "id":"g2","source":"custom","name":"Two",
                "defaultLaunchUrl":"https://two.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            })),
        ];

        crate::v1_case!("state-migration-a22e317b5201", {
            let mut roles = Vec::new();
            create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Role".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            let mut copy = roles.clone();
            copy[0].name = "Changed".to_owned();
            assert_eq!(roles[0].name, "Role");
        });

        crate::v1_case!("state-migration-dd656a1ce95e", {
            let mut roles = Vec::new();
            let first = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "First".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            let second = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Second".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            reorder_roles(&mut roles, &[second.id.clone(), first.id.clone()]).unwrap();
            assert_eq!(roles[0].id, second.id);
            assert_eq!(roles[1].id, first.id);
            assert_eq!(roles[0].updated_at, second.updated_at);
            let third = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Third".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            assert_eq!(roles.last().unwrap().id, third.id);
        });

        crate::v1_case!("state-migration-ebab678949df", {
            let role = role_record(json!({
                "id":"r1","gameId":"g1","name":"Role",
                "launchUrl":"https://one.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            for order in [
                vec![],
                vec!["r1".to_owned(), "r1".to_owned()],
                vec!["missing".to_owned()],
            ] {
                let mut roles = vec![role.clone()];
                assert!(reorder_roles(&mut roles, &order).is_err());
                assert_eq!(roles[0].id, "r1");
            }
        });

        crate::v1_case!("state-migration-d4a525975422", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "URL".to_owned(),
                    launch_url: Some("https://one.test/custom".to_owned()),
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            assert_eq!(role.launch_url, "https://one.test/custom");
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    launch_url: Some("https://one.test/updated".to_owned()),
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(updated.launch_url, "https://one.test/updated");
        });

        crate::v1_case!("state-migration-8436b92a9a3c", {
            let mut roles = Vec::new();
            create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Main".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: " main ".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-fcc108ce785b", {
            let mut roles = Vec::new();
            for game_id in ["g1", "g2"] {
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: game_id.to_owned(),
                        name: "Main".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                    },
                )
                .unwrap();
            }
            assert_eq!(roles.len(), 2);
        });

        crate::v1_case!("state-migration-b3cbb430c785", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Before".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            let created_at = role.created_at.clone();
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    name: Some("After".to_owned()),
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert_eq!(updated.name, "After");
            assert_eq!(updated.created_at, created_at);
        });

        crate::v1_case!("state-migration-91c76a57ca59", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Covered".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                    cover_image_dominant_color: Some("#123456".to_owned()),
                },
            )
            .unwrap();
            assert_eq!(
                role.cover_image_data_url.as_deref(),
                Some("data:image/png;base64,AQ==")
            );
            assert_eq!(role.cover_image_dominant_color.as_deref(), Some("#123456"));
        });

        crate::v1_case!("state-migration-18c6d70a1950", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "Cover update".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            let updated = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    cover_image_data_url: Some("data:image/png;base64,Ag==".to_owned()),
                    set_cover_image_data_url: true,
                    cover_image_dominant_color: Some("#abcdef".to_owned()),
                    set_cover_image_dominant_color: true,
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert!(updated.cover_image_data_url.is_some());
            let cleared = update_role(
                &games,
                &mut roles,
                &role.id,
                RoleUpdateInputRecord {
                    set_cover_image_data_url: true,
                    set_cover_image_dominant_color: true,
                    ..RoleUpdateInputRecord::default()
                },
            )
            .unwrap();
            assert!(cleared.cover_image_data_url.is_none());
            assert!(cleared.cover_image_dominant_color.is_none());
        });

        crate::v1_case!("state-migration-32f9dd5be142", {
            let mut roles = Vec::new();
            let role = create_role(
                &games,
                &mut roles,
                RoleCreateInputRecord {
                    game_id: "g1".to_owned(),
                    name: "No cover".to_owned(),
                    launch_url: None,
                    notes: None,
                    cover_image_data_url: None,
                    cover_image_dominant_color: None,
                },
            )
            .unwrap();
            assert!(role.cover_image_data_url.is_none());
            assert!(role.cover_image_dominant_color.is_none());
        });

        crate::v1_case!("state-migration-a25bac4e9534", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Invalid cover".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some("https://example.test/cover.png".to_owned()),
                        cover_image_dominant_color: None,
                    }
                )
                .is_err()
            );
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Oversized cover".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some(format!(
                            "data:image/png;base64,{}",
                            "A".repeat(MAX_ROLE_COVER_DATA_URL_LENGTH)
                        )),
                        cover_image_dominant_color: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-bf976dd9efa1", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Bad URL".to_owned(),
                        launch_url: Some("file:///tmp/game".to_owned()),
                        notes: None,
                        cover_image_data_url: None,
                        cover_image_dominant_color: None,
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-6f61d05c2101", {
            let mut roles = Vec::new();
            assert!(
                create_role(
                    &games,
                    &mut roles,
                    RoleCreateInputRecord {
                        game_id: "g1".to_owned(),
                        name: "Bad color".to_owned(),
                        launch_url: None,
                        notes: None,
                        cover_image_data_url: Some("data:image/png;base64,AQ==".to_owned()),
                        cover_image_dominant_color: Some("red".to_owned()),
                    }
                )
                .is_err()
            );
        });

        crate::v1_case!("state-migration-c78fcecd60d3", {
            let legacy = role_record(json!({
                "id":"legacy","gameId":"g1","name":"Legacy",
                "launchUrl":"https://one.test/play","notes":"",
                "coverImageDataUrl":"data:image/png;base64,AQ==",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }));
            assert!(legacy.cover_image_data_url.is_some());
            assert!(legacy.cover_image_dominant_color.is_none());
        });
    }
}
