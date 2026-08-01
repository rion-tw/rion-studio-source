use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::StateCollection,
    model::{
        BrowserFontSettingsRecord, BrowserPerformanceSettingsRecord, DisplayTargetRecord,
        GameBrowserSettingsRecord, GameCreateInputRecord, GameUpdateInputRecord,
        GameWindowCreateInputRecord, GameWindowPlacementRecord, GameWindowSaveRuntimeInputRecord,
        GameWindowUpdateInputRecord, LegalAcceptanceRecord, MacroBadgePositionRecord,
        MacroCreateInputRecord, MacroRepeat, MacroSettingsRecord, MacroStepDefinition,
        MacroStepInputRecord, MacroTrigger, MacroUpdateInputRecord, RoleCreateInputRecord,
        RoleGameAssignmentRecord, RoleUpdateInputRecord, RuntimeRestoreSessionRecord,
        RuntimeRestoreTabRecord, RuntimeRestoreWindowRecord, RuntimeWindowPreferencesRecord,
        StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord, StateMacroRecord,
        StateNormalizedRectRecord, StateRoleRecord, StateWorkspaceSlotRecord,
        WorkspaceAppearanceSettingsRecord, WorkspaceCreateInputRecord, WorkspaceSlotInputRecord,
        WorkspaceUpdateInputRecord,
    },
};

const DEFAULT_LAUNCH_URL: &str = "https://universe.flyff.com/play";
const MAX_IMAGE_DATA_URL_LENGTH: usize = 2_000_128;
const MAX_ROLE_COVER_DATA_URL_LENGTH: usize = 1_500_000;
const MAX_LOCAL_STORAGE_SYNC_KEYS: usize = 32;
const MAX_LOCAL_STORAGE_SYNC_KEY_BYTES: usize = 256;
const FLYFF_LOCAL_STORAGE_SYNC_KEY: &str = "game_client_settings";
const FLYFF_LOCAL_STORAGE_SESSION_KEY: &str = "game_client_sessions";
pub const FLYFF_LOCAL_STORAGE_SYNC_SELECTORS: [&str; 8] = [
    "game_client_settings.audio",
    "game_client_settings.gameplay",
    "game_client_settings.graphics",
    "game_client_settings.ui",
    "game_client_settings.video",
    "game_client_settings.layout.windows",
    "game_client_settings.layout.hotbars",
    "game_client_settings.input.bindings",
];

pub fn default_game_browser_settings() -> GameBrowserSettingsRecord {
    GameBrowserSettingsRecord {
        fonts: default_browser_font_settings(),
        macro_badge_position: MacroBadgePositionRecord {
            horizontal_align: "center".to_owned(),
            horizontal_margin_px: 8,
            top_px: 128,
        },
        performance: BrowserPerformanceSettingsRecord::default(),
        workspace: WorkspaceAppearanceSettingsRecord {
            background: "material".to_owned(),
            gap: 4,
        },
    }
}

fn default_browser_font_settings() -> BrowserFontSettingsRecord {
    BrowserFontSettingsRecord {
        mode: "custom".to_owned(),
        font_smoothing_enabled: true,
        preset_id: Some("system-default".to_owned()),
        cjk_variant: "auto".to_owned(),
        slots: HashMap::from([
            (
                "cjk".to_owned(),
                crate::model::BrowserFontSelectionRecord::System {
                    family: "system-ui".to_owned(),
                },
            ),
            (
                "latin".to_owned(),
                crate::model::BrowserFontSelectionRecord::System {
                    family: "system-ui".to_owned(),
                },
            ),
            (
                "numeric".to_owned(),
                crate::model::BrowserFontSelectionRecord::System {
                    family: "system-ui".to_owned(),
                },
            ),
            (
                "monospace".to_owned(),
                crate::model::BrowserFontSelectionRecord::System {
                    family: "ui-monospace".to_owned(),
                },
            ),
            (
                "math".to_owned(),
                crate::model::BrowserFontSelectionRecord::System {
                    family: "math".to_owned(),
                },
            ),
        ]),
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
        let mut source_keys = HashSet::new();
        let mut claimed_role_ids = HashSet::new();
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
                .any(|tab| tab.source_id == active && !tab.hidden)
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
        local_storage_sync_keys: normalize_game_local_storage_sync_keys(
            None,
            input.local_storage_sync_keys,
        )?,
        local_storage_sync_selectors: normalize_local_storage_sync_selectors(
            None,
            input.local_storage_sync_selectors,
        )?,
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
        local_storage_sync_keys: input
            .local_storage_sync_keys
            .map(|values| {
                normalize_game_local_storage_sync_keys(current.builtin_key.as_deref(), values)
            })
            .transpose()?
            .unwrap_or_else(|| current.local_storage_sync_keys.clone()),
        local_storage_sync_selectors: input
            .local_storage_sync_selectors
            .map(|values| {
                normalize_local_storage_sync_selectors(current.builtin_key.as_deref(), values)
            })
            .transpose()?
            .unwrap_or_else(|| current.local_storage_sync_selectors.clone()),
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
    let definition = builtin_definition(id)
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
        builtin_key: Some(definition.key.to_owned()),
        name: definition.name.to_owned(),
        icon_image_data_url: None,
        cover_image_data_url: None,
        default_launch_url: definition.default_launch_url.to_owned(),
        local_storage_sync_keys: definition
            .local_storage_sync_keys
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        local_storage_sync_selectors: definition
            .local_storage_sync_selectors
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
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
    let default_launch_url = &games
        .iter()
        .find(|game| game.id == game_id)
        .expect("role game existence was validated")
        .default_launch_url;
    let launch_url = normalize_http_url(
        input.launch_url.as_deref().unwrap_or(default_launch_url),
        "ROLE_LAUNCH_URL_INVALID",
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let role = StateRoleRecord {
        id: Uuid::new_v4().to_string(),
        game_id,
        name,
        launch_url,
        notes: input.notes.unwrap_or_default().trim().to_owned(),
        cover_image_dominant_color: if cover.is_some() {
            normalize_color(input.cover_image_dominant_color)?
        } else {
            None
        },
        cover_image_data_url: cover,
        local_storage_source_role_id: normalize_local_storage_source_role_id(
            input.local_storage_source_role_id,
        )?,
        created_at: now.clone(),
        updated_at: now,
    };
    if role.notes.len() > 20_000 {
        return Err(domain("ROLE_NOTES_TOO_LONG", "Role notes are too long."));
    }
    if role.local_storage_source_role_id.is_some()
        && games
            .iter()
            .find(|game| game.id == role.game_id)
            .is_none_or(|game| {
                game.local_storage_sync_keys.is_empty()
                    && game.local_storage_sync_selectors.is_empty()
            })
    {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_KEYS_REQUIRED",
            "The game has no managed localStorage keys.",
        ));
    }
    validate_role_local_storage_binding(&role, roles)?;
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
        local_storage_source_role_id: if input.set_local_storage_source_role_id {
            normalize_local_storage_source_role_id(input.local_storage_source_role_id)?
        } else {
            current.local_storage_source_role_id.clone()
        },
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..current
    };
    if roles
        .iter()
        .any(|candidate| candidate.local_storage_source_role_id.as_deref() == Some(id))
        && (role.game_id != roles[index].game_id
            || launch_origin(&role.launch_url)? != launch_origin(&roles[index].launch_url)?)
    {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_IN_USE",
            "Unbind dependent roles before changing this source role's game or launch origin.",
        ));
    }
    if role.local_storage_source_role_id != roles[index].local_storage_source_role_id
        && role.local_storage_source_role_id.is_some()
        && games
            .iter()
            .find(|game| game.id == role.game_id)
            .is_none_or(|game| {
                game.local_storage_sync_keys.is_empty()
                    && game.local_storage_sync_selectors.is_empty()
            })
    {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_KEYS_REQUIRED",
            "The game has no managed localStorage keys.",
        ));
    }
    validate_role_local_storage_binding(&role, roles)?;
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
        slots,
        created_at: current.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    workspaces[index] = workspace.clone();
    Ok(workspace)
}
