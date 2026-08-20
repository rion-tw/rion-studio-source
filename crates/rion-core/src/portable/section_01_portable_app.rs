use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{Map, Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    domain::{
        is_reserved_macro_trigger, macro_shortcut_source_role_ids,
        normalize_game_browser_settings, normalize_macro_settings, validate_game_browser_settings,
        validate_macro_settings,
    },
    error::{CoreError, CoreResult},
    layout::normalize_rect_edges,
    macro_graph::validate_macro_graph,
    model::{
        CoreStateSnapshotRecord, GameBrowserSettingsRecord, GameWindowTabRecord, LayoutRect,
        MacroSettingsRecord, MacroShortcutSourceScope, MacroStepDefinition, MacroTrigger,
        PortableDataRecord,
        PortableDataSelectionRecord, PortableExportResultRecord, PortableGameRecord,
        PortableGameWindowRecord, PortableImportOperationsRecord, PortableImportPreviewRecord,
        PortableImportResultRecord, PortableImportWarningRecord, PortableLaunchWorkspaceRecord,
        PortableMacroConflictCandidateRecord, PortableMacroConflictRecord,
        PortableMacroConflictResolutionRecord, PortableMacroRecord, PortablePreferencesRecord,
        PortableRoleRecord, StateCollection, StateGameRecord, StateGameWindowRecord,
        StateLaunchWorkspaceRecord, StateMacroRecord, StateNormalizedRectRecord, StateRoleRecord,
        StateWorkspaceSlotRecord,
    },
};

const PORTABLE_APP: &str = "Rion Studio";
pub const PORTABLE_SCHEMA_VERSION: u64 = 18;
const MAX_SLOTS: usize = 9;
const MAX_STEPS: usize = 100;
const MAX_PENDING_IMPORTS: usize = 8;
const PENDING_IMPORT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PORTABLE_BYTES: u64 = 128 * 1024 * 1024;

struct BuiltinGame {
    id: &'static str,
    key: &'static str,
    name: &'static str,
    launch_url: &'static str,
}

const BUILTIN_GAMES: &[BuiltinGame] = &[
    BuiltinGame {
        id: "builtin-flyff-universe",
        key: "flyff-universe",
        name: "Flyff Universe",
        launch_url: "https://universe.flyff.com/play",
    },
    BuiltinGame {
        id: "builtin-feifei-infinite-universe",
        key: "feifei-infinite-universe",
        name: "飞飞：无限宇宙",
        launch_url: "https://ffcli.ruiwoo.cn",
    },
];

#[cfg(test)]
pub fn normalize(raw: &str) -> CoreResult<Value> {
    if raw.len() as u64 > MAX_PORTABLE_BYTES {
        return Err(invalid("portable data is too large"));
    }
    let source: Value = serde_json::from_str(raw)
        .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
    normalize_value(source)
}

fn normalize_value(source: Value) -> CoreResult<Value> {
    let object = source
        .as_object()
        .ok_or_else(|| invalid("portable data must be an object"))?;
    if object.get("app").and_then(Value::as_str) != Some(PORTABLE_APP) {
        return Err(invalid("portable app metadata is invalid"));
    }
    let schema = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            CoreError::UnsupportedDataVersion(format!(
                "portable schema must be exactly {PORTABLE_SCHEMA_VERSION}"
            ))
        })?;
    if !(11..=PORTABLE_SCHEMA_VERSION).contains(&schema) {
        return Err(CoreError::UnsupportedDataVersion(format!(
            "portable schema {schema} is unsupported; expected 11 through {PORTABLE_SCHEMA_VERSION}"
        )));
    }
    let mut roles = normalize_array(object, "roles", normalize_role)?;
    let input_games = object
        .get("games")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("portable games must be an array"))?
        .iter()
        .map(|value| normalize_game(value, schema))
        .collect::<CoreResult<Vec<_>>>()?;
    let workspaces = normalize_workspaces(object)?;
    let (games, recovered_roles) = recover_games(input_games, roles)?;
    roles = recovered_roles;
    let macros = normalize_macros(object, true, schema)?;
    let game_windows = normalize_array(object, "gameWindows", normalize_game_window)?;
    ensure_unique_ids(&games, "id", "game")?;
    ensure_unique_ids(&roles, "id", "role")?;
    ensure_unique_ids(&workspaces, "id", "workspace")?;
    ensure_unique_ids(&game_windows, "id", "game window")?;
    ensure_unique_ids(&macros, "id", "macro")?;
    validate_macro_graph(&macros).map_err(|_| portable_macro_dependency_invalid())?;
    let mut output = Map::new();
    output.insert("app".to_owned(), json!(PORTABLE_APP));
    output.insert("schemaVersion".to_owned(), json!(PORTABLE_SCHEMA_VERSION));
    output.insert(
        "exportedAt".to_owned(),
        json!(
            object
                .get("exportedAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    );
    output.insert(
        "appVersion".to_owned(),
        json!(
            object
                .get("appVersion")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    );
    output.insert("games".to_owned(), Value::Array(games));
    output.insert("roles".to_owned(), Value::Array(roles));
    output.insert("launchWorkspaces".to_owned(), Value::Array(workspaces));
    output.insert("gameWindows".to_owned(), Value::Array(game_windows));
    output.insert("macros".to_owned(), Value::Array(macros));
    if let Some(preferences) = normalize_preferences(object.get("preferences"))? {
        output.insert("preferences".to_owned(), preferences);
    }
    Ok(Value::Object(output))
}

fn normalize_array(
    object: &Map<String, Value>,
    key: &str,
    normalize: fn(&Value) -> CoreResult<Value>,
) -> CoreResult<Vec<Value>> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("portable {key} must be an array")))?
        .iter()
        .map(normalize)
        .collect()
}

fn normalize_game(value: &Value, _portable_schema: u64) -> CoreResult<Value> {
    let source = object(value, "game")?;
    let id = required_string(source, "id", "game")?;
    let kind = required_string(source, "source", "game")?;
    if !matches!(kind.as_str(), "builtin" | "custom") {
        return Err(invalid("portable game source is invalid"));
    }
    let builtin_key = optional_string(source.get("builtinKey"));
    if kind == "builtin"
        && builtin_key
            .as_deref()
            .is_none_or(|key| !BUILTIN_GAMES.iter().any(|game| game.key == key))
    {
        return Err(invalid("portable built-in game is invalid"));
    }
    let mut game = Map::new();
    game.insert("id".to_owned(), json!(id));
    game.insert("source".to_owned(), json!(kind));
    if let Some(key) = &builtin_key {
        game.insert("builtinKey".to_owned(), json!(key));
    }
    game.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "game")?),
    );
    copy_optional_image(source, &mut game, "iconImageDataUrl")?;
    copy_optional_image(source, &mut game, "coverImageDataUrl")?;
    game.insert(
        "defaultLaunchUrl".to_owned(),
        json!(normalize_url(required_string(
            source,
            "defaultLaunchUrl",
            "game",
        )?)?),
    );
    if source.get("inferred").and_then(Value::as_bool) == Some(true) {
        game.insert("inferred".to_owned(), Value::Bool(true));
    }
    Ok(Value::Object(game))
}

fn normalize_role(value: &Value) -> CoreResult<Value> {
    let source = object(value, "role")?;
    let mut role = Map::new();
    role.insert(
        "id".to_owned(),
        json!(required_string(source, "id", "role")?),
    );
    if let Some(game_id) = optional_string(source.get("gameId")) {
        role.insert("gameId".to_owned(), json!(game_id));
    }
    role.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "role")?),
    );
    role.insert(
        "launchUrl".to_owned(),
        json!(normalize_url(required_string(
            source,
            "launchUrl",
            "role",
        )?)?),
    );
    role.insert(
        "notes".to_owned(),
        json!(
            source
                .get("notes")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
        ),
    );
    copy_optional_image(source, &mut role, "coverImageDataUrl")?;
    if let Some(color) = optional_string(source.get("coverImageDominantColor")) {
        role.insert("coverImageDominantColor".to_owned(), json!(color));
    }
    Ok(Value::Object(role))
}

fn normalize_game_window(value: &Value) -> CoreResult<Value> {
    let mut window = serde_json::from_value::<PortableGameWindowRecord>(value.clone())
        .map_err(|error| invalid(format!("portable game window is invalid: {error}")))?;
    window.id = window.id.trim().to_owned();
    window.name = window.name.trim().to_owned();
    if window.id.is_empty() || window.id.len() > 128 {
        return Err(invalid("portable game window id is invalid"));
    }
    if window.name.is_empty() || window.name.chars().count() > 80 {
        return Err(invalid("portable game window name is invalid"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    crate::domain::validate_game_window_collection(&[StateGameWindowRecord {
        id: window.id.clone(),
        name: window.name.clone(),
        target_display: window.target_display.clone(),
        placement: window.placement.clone(),
        tabs: window.tabs.clone(),
        active_tab_id: window.active_tab_id.clone(),
        created_at: now.clone(),
        updated_at: now,
    }])?;
    serde_json::to_value(window)
        .map_err(|error| invalid(format!("portable game window is invalid: {error}")))
}

fn recover_games(mut games: Vec<Value>, roles: Vec<Value>) -> CoreResult<(Vec<Value>, Vec<Value>)> {
    let mut game_ids = games
        .iter()
        .filter_map(|game| game.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<HashSet<_>>();
    let mut game_by_url = games
        .iter()
        .filter_map(|game| {
            Some((
                game.get("defaultLaunchUrl")?.as_str()?.to_owned(),
                game.get("id")?.as_str()?.to_owned(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut used_names = games
        .iter()
        .filter_map(|game| game.get("name")?.as_str().map(normalize_name_key))
        .collect::<HashSet<_>>();
    let mut recovered_roles = Vec::with_capacity(roles.len());
    for mut role in roles {
        let object = role
            .as_object_mut()
            .ok_or_else(|| invalid("portable role must be an object"))?;
        let current = object.get("gameId").and_then(Value::as_str);
        if current.is_some_and(|id| game_ids.contains(id)) {
            recovered_roles.push(role);
            continue;
        }
        let launch_url = object
            .get("launchUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let game_id = if let Some(id) = game_by_url.get(&launch_url) {
            id.clone()
        } else if let Some(builtin) = BUILTIN_GAMES
            .iter()
            .find(|game| game.launch_url == launch_url)
        {
            if !game_ids.contains(builtin.id) {
                games.push(json!({
                    "id": builtin.id,
                    "inferred": true,
                    "source": "builtin",
                    "builtinKey": builtin.key,
                    "name": builtin.name,
                    "defaultLaunchUrl": builtin.launch_url
                }));
                game_ids.insert(builtin.id.to_owned());
                game_by_url.insert(launch_url.clone(), builtin.id.to_owned());
            }
            builtin.id.to_owned()
        } else {
            let id = format!("recovered-game-{}", Uuid::new_v4());
            let host = Url::parse(&launch_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| "Imported Game".to_owned());
            let name = unique_name(&host, &mut used_names);
            games.push(json!({
                "id": id,
                "inferred": true,
                "source": "custom",
                "name": name,
                "defaultLaunchUrl": launch_url
            }));
            game_ids.insert(id.clone());
            game_by_url.insert(launch_url.clone(), id.clone());
            id
        };
        object.insert("gameId".to_owned(), json!(game_id));
        object.insert("gameRecovered".to_owned(), Value::Bool(true));
        recovered_roles.push(role);
    }
    Ok((games, recovered_roles))
}

fn normalize_workspaces(object: &Map<String, Value>) -> CoreResult<Vec<Value>> {
    let values = object
        .get("launchWorkspaces")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("portable launchWorkspaces must be an array"))?;
    values.iter().map(normalize_workspace).collect()
}

fn normalize_workspace(value: &Value) -> CoreResult<Value> {
    let source = object(value, "workspace")?;
    let template = required_string(source, "template", "workspace")?;
    if !matches!(
        template.as_str(),
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
        return Err(invalid("portable workspace template is invalid"));
    }
    let slots = source
        .get("slots")
        .and_then(Value::as_array)
        .filter(|slots| slots.len() <= MAX_SLOTS)
        .ok_or_else(|| invalid("portable workspace slots are invalid"))?;
    let mut role_ids = HashSet::new();
    let slots = slots
        .iter()
        .enumerate()
        .map(|(index, slot)| normalize_slot(slot, index, &mut role_ids))
        .collect::<CoreResult<Vec<_>>>()?;
    Ok(json!({
        "id": required_string(source, "id", "workspace")?,
        "name": required_string(source, "name", "workspace")?,
        "template": template,
        "slots": slots
    }))
}

fn normalize_slot(
    value: &Value,
    index: usize,
    role_ids: &mut HashSet<String>,
) -> CoreResult<Value> {
    let source = object(value, "workspace slot")?;
    let role_id = optional_string(source.get("roleId"));
    let web = source.get("web").map(|value| {
        let web = object(value, "workspace web slot")?;
        let name = required_string(web, "name", "workspace web slot")?;
        if name.chars().count() > 80 {
            return Err(invalid("portable workspace web slot name is too long"));
        }
        let start_url = required_string(web, "startUrl", "workspace web slot")?;
        let parsed = Url::parse(&start_url)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
            .ok_or_else(|| invalid("portable workspace web slot URL is invalid"))?;
        Ok(json!({ "name": name, "startUrl": parsed.to_string() }))
    }).transpose()?;
    if role_id.is_some() && web.is_some() {
        return Err(invalid(
            "portable workspace slot cannot contain both a role and a web app",
        ));
    }
    if let Some(role_id) = &role_id
        && !role_ids.insert(role_id.clone())
    {
        return Err(invalid(
            "portable workspace role assignments are duplicated",
        ));
    }
    let rect = source
        .get("rect")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("portable workspace slot rectangle is invalid"))?;
    let number = |key: &str| {
        rect.get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(|| invalid("portable workspace slot rectangle is invalid"))
    };
    let (x, y, width, height) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    if x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
        || x + width > 1.000_001
        || y + height > 1.000_001
    {
        return Err(invalid("portable workspace slot rectangle is out of range"));
    }
    let mut slot = Map::new();
    slot.insert(
        "id".to_owned(),
        json!(optional_string(source.get("id")).unwrap_or_else(|| format!("slot-{}", index + 1))),
    );
    if let Some(role_id) = role_id {
        slot.insert("roleId".to_owned(), json!(role_id));
    } else if let Some(web) = web {
        slot.insert("web".to_owned(), web);
    }
    if (slot.contains_key("roleId") || slot.contains_key("web"))
        && let Some(zoom) = source.get("browserZoomPercent").and_then(Value::as_f64)
    {
        if !(25.0..=500.0).contains(&zoom) {
            return Err(invalid("portable slot zoom is invalid"));
        }
        slot.insert("browserZoomPercent".to_owned(), json!(zoom));
    }
    slot.insert(
        "rect".to_owned(),
        json!({ "x": x, "y": y, "width": width, "height": height }),
    );
    Ok(Value::Object(slot))
}

fn normalize_macros(
    object: &Map<String, Value>,
    supports_modifiers: bool,
    schema: u64,
) -> CoreResult<Vec<Value>> {
    let values = object
        .get("macros")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("portable macros must be an array"))?;
    values
        .iter()
        .map(|value| normalize_macro(value, supports_modifiers, schema))
        .collect()
}

fn normalize_macro(value: &Value, supports_modifiers: bool, schema: u64) -> CoreResult<Value> {
    let source = object(value, "macro")?;
    let role_ids = source
        .get("roleIds")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("portable macro roleIds are invalid"))?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid("portable macro roleId is invalid"))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    if role_ids.iter().collect::<HashSet<_>>().len() != role_ids.len() {
        return Err(invalid("portable macro roleIds are duplicated"));
    }
    let steps = source
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty() && steps.len() <= MAX_STEPS)
        .ok_or_else(|| invalid("portable macro steps are invalid"))?;
    let mut step_ids = HashSet::new();
    let steps = steps
        .iter()
        .map(|step| normalize_step(step, supports_modifiers, schema, &mut step_ids))
        .collect::<CoreResult<Vec<_>>>()?;
    let repeat = source
        .get("repeat")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("portable macro repeat is invalid"))?;
    let repeat = match repeat.get("type").and_then(Value::as_str) {
        Some("once") => json!({ "type": "once" }),
        Some("loop") => json!({
            "type": "loop",
            "intervalMs": repeat.get("intervalMs").and_then(Value::as_u64).filter(|value| *value <= 86_400_000).ok_or_else(|| invalid("portable macro loop interval is invalid"))?
        }),
        _ => return Err(invalid("portable macro repeat is invalid")),
    };
    let activation_mode = source
        .get("activationMode")
        .and_then(Value::as_str)
        .unwrap_or("toggle");
    if !matches!(activation_mode, "toggle" | "while_held") {
        return Err(invalid("portable macro activation mode is invalid"));
    }
    let trigger = source.get("trigger").map(normalize_trigger).transpose()?;
    if activation_mode == "while_held" && trigger.is_none() {
        return Err(invalid("while-held portable macro requires a trigger"));
    }
    let mut macro_value = Map::new();
    macro_value.insert(
        "id".to_owned(),
        json!(required_string(source, "id", "macro")?),
    );
    macro_value.insert(
        "enabled".to_owned(),
        json!(
            source
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    macro_value.insert("activationMode".to_owned(), json!(activation_mode));
    macro_value.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "macro")?),
    );
    macro_value.insert("roleIds".to_owned(), json!(role_ids));
    let shortcut_source_scope = normalize_portable_macro_shortcut_source_scope(
        source,
        schema,
        trigger.is_some(),
    )?;
    macro_value.insert(
        "shortcutSourceScope".to_owned(),
        shortcut_source_scope,
    );
    if let Some(trigger) = trigger {
        macro_value.insert("trigger".to_owned(), trigger);
    }
    macro_value.insert("repeat".to_owned(), repeat);
    macro_value.insert("steps".to_owned(), Value::Array(steps));
    Ok(Value::Object(macro_value))
}

fn normalize_portable_macro_shortcut_source_scope(
    source: &Map<String, Value>,
    schema: u64,
    has_trigger: bool,
) -> CoreResult<Value> {
    if !has_trigger || schema < 15 {
        return Ok(json!({ "type": "all_execution_roles" }));
    }
    let scope = source
        .get("shortcutSourceScope")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("portable macro shortcutSourceScope is invalid"))?;
    match scope.get("type").and_then(Value::as_str) {
        Some("all_execution_roles") => Ok(json!({ "type": "all_execution_roles" })),
        Some("selected_roles") => {
            let role_ids = scope
                .get("roleIds")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("portable macro shortcut source roleIds are invalid"))?
                .iter()
                .map(|id| {
                    id.as_str()
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro shortcut source roleId is invalid"))
                })
                .collect::<CoreResult<Vec<_>>>()?;
            if role_ids.is_empty()
                || role_ids.iter().collect::<HashSet<_>>().len() != role_ids.len()
            {
                return Err(invalid(
                    "portable macro shortcut source roleIds are invalid",
                ));
            }
            Ok(json!({ "type": "selected_roles", "roleIds": role_ids }))
        }
        _ => Err(invalid("portable macro shortcutSourceScope is invalid")),
    }
}
