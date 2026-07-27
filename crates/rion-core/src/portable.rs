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
        normalize_game_browser_settings, normalize_macro_settings, validate_game_browser_settings,
        validate_macro_settings,
    },
    error::{CoreError, CoreResult},
    layout::normalize_rect_edges,
    macro_graph::validate_macro_graph,
    model::{
        CoreStateSnapshotRecord, GameBrowserSettingsRecord, GameWindowTabRecord, LayoutRect,
        MacroSettingsRecord, MacroStepDefinition, MacroTrigger, PortableDataRecord,
        PortableDataSelectionRecord, PortableExportResultRecord, PortableGameRecord,
        PortableGameWindowRecord, PortableImportOperationsRecord, PortableImportPreviewRecord,
        PortableImportResultRecord, PortableImportWarningRecord, PortableLaunchWorkspaceRecord,
        PortableMacroConflictCandidateRecord, PortableMacroConflictRecord,
        PortableMacroConflictResolutionRecord, PortableMacroRecord, PortablePreferencesRecord,
        PortableRoleRecord, StateGameRecord, StateGameWindowRecord, StateLaunchWorkspaceRecord,
        StateMacroRecord, StateNormalizedRectRecord, StateRoleRecord, StateWorkspaceSlotRecord,
    },
};

const PORTABLE_APP: &str = "Rion Studio";
const CURRENT_SCHEMA: u64 = 10;
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
    local_storage_sync_keys: &'static [&'static str],
}

const BUILTIN_GAMES: &[BuiltinGame] = &[
    BuiltinGame {
        id: "builtin-flyff-universe",
        key: "flyff-universe",
        name: "Flyff Universe",
        launch_url: "https://universe.flyff.com/play",
        local_storage_sync_keys: &["game_client_settings"],
    },
    BuiltinGame {
        id: "builtin-feifei-infinite-universe",
        key: "feifei-infinite-universe",
        name: "飞飞：无限宇宙",
        launch_url: "https://ffcli.ruiwoo.cn",
        local_storage_sync_keys: &[],
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
        .filter(|schema| (1..=CURRENT_SCHEMA).contains(schema))
        .ok_or_else(|| invalid("portable schema version is unsupported"))?;
    let mut roles = normalize_array(object, "roles", normalize_role)?;
    let input_games = if schema >= 2 {
        normalize_array(object, "games", normalize_game)?
    } else {
        Vec::new()
    };
    let workspaces = normalize_workspaces(object)?;
    let (games, recovered_roles) = recover_games(input_games, roles)?;
    roles = recovered_roles;
    let macros = normalize_macros(object, schema >= 5)?;
    let game_windows = if schema >= 8 {
        normalize_array(object, "gameWindows", normalize_game_window)?
    } else {
        Vec::new()
    };
    ensure_unique_ids(&games, "id", "game")?;
    ensure_unique_ids(&roles, "id", "role")?;
    ensure_unique_ids(&workspaces, "id", "workspace")?;
    ensure_unique_ids(&game_windows, "id", "game window")?;
    ensure_unique_ids(&macros, "id", "macro")?;
    validate_macro_graph(&macros).map_err(|_| portable_macro_dependency_invalid())?;
    let mut output = Map::new();
    output.insert("app".to_owned(), json!(PORTABLE_APP));
    output.insert("schemaVersion".to_owned(), json!(CURRENT_SCHEMA));
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

fn normalize_game(value: &Value) -> CoreResult<Value> {
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
    let local_storage_sync_keys = source
        .get("localStorageSyncKeys")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable localStorage sync key is invalid"))
                })
                .collect::<CoreResult<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_else(|| {
            builtin_key
                .as_deref()
                .and_then(builtin_by_key)
                .map(|game| {
                    game.local_storage_sync_keys
                        .iter()
                        .map(|value| (*value).to_owned())
                        .collect()
                })
                .unwrap_or_default()
        });
    game.insert(
        "localStorageSyncKeys".to_owned(),
        json!(crate::domain::normalize_local_storage_sync_keys(
            local_storage_sync_keys
        )?),
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
    if let Some(source_role_id) = optional_string(source.get("localStorageSourceRoleId")) {
        role.insert("localStorageSourceRoleId".to_owned(), json!(source_role_id));
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
                    "defaultLaunchUrl": builtin.launch_url,
                    "localStorageSyncKeys": builtin.local_storage_sync_keys
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
                "defaultLaunchUrl": launch_url,
                "localStorageSyncKeys": []
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
    let zoom = source
        .get("browserZoomPercent")
        .and_then(Value::as_f64)
        .filter(|zoom| (25.0..=125.0).contains(zoom))
        .ok_or_else(|| invalid("portable workspace zoom is invalid"))?;
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
        "browserZoomMode": match source.get("browserZoomMode").and_then(Value::as_str) {
            Some("fixed") => "fixed",
            Some("adaptive") | None => "adaptive",
            _ => return Err(invalid("portable workspace zoom mode is invalid")),
        },
        "browserZoomPercent": zoom,
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
        if let Some(zoom) = source.get("browserZoomPercent").and_then(Value::as_f64) {
            if !(10.0..=300.0).contains(&zoom) {
                return Err(invalid("portable slot zoom is invalid"));
            }
            slot.insert("browserZoomPercent".to_owned(), json!(zoom));
        }
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
) -> CoreResult<Vec<Value>> {
    let values = object
        .get("macros")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("portable macros must be an array"))?;
    values
        .iter()
        .map(|value| normalize_macro(value, supports_modifiers))
        .collect()
}

fn normalize_macro(value: &Value, supports_modifiers: bool) -> CoreResult<Value> {
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
        .map(|step| normalize_step(step, supports_modifiers, &mut step_ids))
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
    if let Some(trigger) = trigger {
        macro_value.insert("trigger".to_owned(), trigger);
    }
    macro_value.insert("repeat".to_owned(), repeat);
    macro_value.insert("steps".to_owned(), Value::Array(steps));
    Ok(Value::Object(macro_value))
}

fn normalize_step(
    value: &Value,
    supports_modifiers: bool,
    ids: &mut HashSet<String>,
) -> CoreResult<Value> {
    let source = object(value, "macro step")?;
    let id = optional_string(source.get("id"))
        .filter(|id| ids.insert(id.clone()))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    ids.insert(id.clone());
    match source.get("type").and_then(Value::as_str) {
        Some("key") => {
            let code = required_string(source, "code", "macro key step")?;
            let action = source
                .get("action")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|action| matches!(*action, "tap" | "hold_until_stop"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro key action is invalid"))
                })
                .transpose()?;
            let modifiers = if supports_modifiers {
                source
                    .get("modifiers")
                    .map(|value| {
                        value
                            .as_array()
                            .ok_or_else(|| invalid("portable macro key modifiers are invalid"))
                            .and_then(|values| {
                                values
                                    .iter()
                                    .map(|value| {
                                        value
                                            .as_str()
                                            .filter(|value| {
                                                matches!(
                                                    *value,
                                                    "primary" | "ctrl" | "alt" | "shift" | "meta"
                                                )
                                            })
                                            .map(str::to_owned)
                                            .ok_or_else(|| {
                                                invalid("portable macro key modifier is invalid")
                                            })
                                    })
                                    .collect::<CoreResult<Vec<_>>>()
                            })
                    })
                    .transpose()?
            } else {
                None
            };
            let label = source
                .get("label")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|label| !label.trim().is_empty() && label.chars().count() <= 48)
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro key label is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("key")),
                ("code".to_owned(), json!(code)),
            ]);
            if let Some(modifiers) = modifiers {
                step.insert("modifiers".to_owned(), json!(modifiers));
            }
            if let Some(action) = action {
                step.insert("action".to_owned(), json!(action));
            }
            if let Some(label) = label {
                step.insert("label".to_owned(), json!(label));
            }
            Ok(Value::Object(step))
        }
        Some("click") => {
            let explicit_unit = source
                .get("unit")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|unit| matches!(*unit, "percent" | "px"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro click unit is invalid"))
                })
                .transpose()?;
            let unit = explicit_unit.as_deref().unwrap_or("percent");
            let anchor = source
                .get("anchor")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|anchor| {
                            matches!(
                                *anchor,
                                "top-left"
                                    | "top-center"
                                    | "top-right"
                                    | "center-left"
                                    | "center"
                                    | "center-right"
                                    | "bottom-left"
                                    | "bottom-center"
                                    | "bottom-right"
                            )
                        })
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro click anchor is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("click")),
            ]);
            if let Some(unit) = explicit_unit.as_ref() {
                step.insert("unit".to_owned(), json!(unit));
            }
            if let Some(anchor) = anchor {
                step.insert("anchor".to_owned(), json!(anchor));
            }
            if unit == "px" {
                step.insert("xPx".to_owned(), json!(finite_number(source, "xPx")?));
                step.insert("yPx".to_owned(), json!(finite_number(source, "yPx")?));
                Ok(Value::Object(step))
            } else if unit == "percent" {
                step.insert(
                    "xPercent".to_owned(),
                    json!(finite_number(source, "xPercent")?),
                );
                step.insert(
                    "yPercent".to_owned(),
                    json!(finite_number(source, "yPercent")?),
                );
                Ok(Value::Object(step))
            } else {
                Err(invalid("portable macro click unit is invalid"))
            }
        }
        Some("delay") => Ok(json!({
            "id": id, "type": "delay",
            "ms": source.get("ms").and_then(Value::as_u64).filter(|value| *value <= 86_400_000).ok_or_else(|| invalid("portable macro delay is invalid"))?
        })),
        Some("macro") => {
            let mode = source
                .get("callMode")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|mode| matches!(*mode, "wait" | "trigger"))
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("portable macro call mode is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("macro")),
                (
                    "macroId".to_owned(),
                    json!(required_string(source, "macroId", "macro call step")?),
                ),
            ]);
            if let Some(mode) = mode {
                step.insert("callMode".to_owned(), json!(mode));
            }
            Ok(Value::Object(step))
        }
        _ => Err(invalid("portable macro step type is invalid")),
    }
}

fn normalize_trigger(value: &Value) -> CoreResult<Value> {
    let trigger = object(value, "macro trigger")?;
    Ok(json!({
        "code": required_string(trigger, "code", "macro trigger")?,
        "ctrl": trigger.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
        "alt": trigger.get("alt").and_then(Value::as_bool).unwrap_or(false),
        "shift": trigger.get("shift").and_then(Value::as_bool).unwrap_or(false),
        "meta": trigger.get("meta").and_then(Value::as_bool).unwrap_or(false)
    }))
}

fn normalize_preferences(value: Option<&Value>) -> CoreResult<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    let source = object(value, "preferences")?;
    let mut output = Map::new();
    if let Some(language) = source.get("language").and_then(Value::as_str)
        && matches!(language, "en" | "zh-TW" | "zh-CN" | "ja")
    {
        output.insert("language".to_owned(), json!(language));
    }
    if let Some(theme) = source.get("themeMode").and_then(Value::as_str)
        && matches!(theme, "system" | "light" | "dark")
    {
        output.insert("themeMode".to_owned(), json!(theme));
    }
    if let Some(value) = source.get("gameBrowserSettings")
        && value.is_object()
    {
        let settings = serde_json::from_value::<GameBrowserSettingsRecord>(value.clone())
            .map_err(|_| invalid("portable browser settings are invalid"))?;
        output.insert(
            "gameBrowserSettings".to_owned(),
            serde_json::to_value(normalize_game_browser_settings(settings))
                .map_err(|error| CoreError::Internal(error.to_string()))?,
        );
    }
    if let Some(value) = source.get("macroSettings")
        && value.is_object()
    {
        let settings = serde_json::from_value::<MacroSettingsRecord>(value.clone())
            .map_err(|_| invalid("portable macro settings are invalid"))?;
        output.insert(
            "macroSettings".to_owned(),
            serde_json::to_value(normalize_macro_settings(settings))
                .map_err(|error| CoreError::Internal(error.to_string()))?,
        );
    }
    Ok((!output.is_empty()).then_some(Value::Object(output)))
}

fn object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("portable {label} must be an object")))
}

fn required_string(object: &Map<String, Value>, key: &str, label: &str) -> CoreResult<String> {
    optional_string(object.get(key))
        .ok_or_else(|| invalid(format!("portable {label} requires {key}")))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalize_url(value: String) -> CoreResult<String> {
    let url = Url::parse(&value).map_err(|_| invalid("portable URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("portable URL is invalid"));
    }
    Ok(url.to_string())
}

fn copy_optional_image(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) -> CoreResult<()> {
    let Some(value) = source.get(key) else {
        return Ok(());
    };
    let image = value
        .as_str()
        .ok_or_else(|| invalid("portable image is invalid"))?;
    if image.len() > 2_000_128 || !image.starts_with("data:image/") || !image.contains(";base64,") {
        return Err(invalid("portable image is invalid"));
    }
    target.insert(key.to_owned(), json!(image));
    Ok(())
}

fn finite_number(object: &Map<String, Value>, key: &str) -> CoreResult<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("portable {key} is invalid")))
}

fn ensure_unique_ids(values: &[Value], key: &str, label: &str) -> CoreResult<()> {
    let mut ids = HashSet::new();
    for value in values {
        let id = value
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("portable {label} id is invalid")))?;
        if !ids.insert(id) {
            return Err(invalid(format!("portable {label} ids are duplicated")));
        }
    }
    Ok(())
}

fn normalize_name_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn unique_name(base: &str, used: &mut HashSet<String>) -> String {
    let base = if base.trim().is_empty() {
        "Imported Game"
    } else {
        base.trim()
    };
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            base.to_owned()
        } else {
            format!("{base} ({index})")
        };
        if used.insert(normalize_name_key(&candidate)) {
            return candidate;
        }
    }
    format!("Imported Game {}", Uuid::new_v4())
}

#[derive(Debug, Clone)]
struct PendingImport {
    created_at: Instant,
    data: PortableDataRecord,
    import_id: String,
}

#[derive(Debug, Default)]
pub(crate) struct PortableRuntime {
    pending: VecDeque<PendingImport>,
}

#[derive(Debug)]
pub(crate) struct PreparedPortableApply {
    pub affected_macro_ids: Vec<String>,
    pub result: PortableImportResultRecord,
    pub snapshot: CoreStateSnapshotRecord,
}

#[derive(Debug)]
struct ImportPlan {
    affected_macro_ids: Vec<String>,
    conflicts: Vec<PortableMacroConflictRecord>,
    operations: PortableImportOperationsRecord,
    snapshot: CoreStateSnapshotRecord,
    warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug)]
struct PlannedMacro {
    destination_id: String,
    existing: Option<StateMacroRecord>,
    macro_record: PortableMacroRecord,
    name: String,
    role_ids: Vec<String>,
}

impl PortableRuntime {
    pub fn preview(
        &mut self,
        raw_json: &str,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        if raw_json.len() as u64 > MAX_PORTABLE_BYTES {
            return Err(invalid("portable data is too large"));
        }
        let source = serde_json::from_str(raw_json)
            .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
        self.preview_normalized(source, file_path, snapshot)
    }

    pub fn preview_file(
        &mut self,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        let path = absolute_portable_path(&file_path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| portable_io(&path, error))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(invalid("portable import path must be a regular file"));
        }
        if metadata.len() > MAX_PORTABLE_BYTES {
            return Err(invalid("portable data is too large"));
        }
        let file = fs::File::open(&path).map_err(|error| portable_io(&path, error))?;
        let source = serde_json::from_reader(BufReader::new(file))
            .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
        self.preview_normalized(source, file_path, snapshot)
    }

    fn preview_normalized(
        &mut self,
        source: Value,
        file_path: String,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PortableImportPreviewRecord> {
        self.prune_expired();
        let normalized = normalize_value(source)?;
        let data = serde_json::from_value::<PortableDataRecord>(normalized)
            .map_err(|error| invalid(format!("portable data model is invalid: {error}")))?;
        validate_preferences(data.preferences.as_ref())?;
        let plan = build_import_plan(&data, &all_selection(), &[], snapshot)?;
        let import_id = Uuid::new_v4().to_string();
        while self.pending.len() >= MAX_PENDING_IMPORTS {
            self.pending.pop_front();
        }
        self.pending.push_back(PendingImport {
            created_at: Instant::now(),
            data: data.clone(),
            import_id: import_id.clone(),
        });
        Ok(PortableImportPreviewRecord {
            import_id,
            file_path,
            exported_at: data.exported_at,
            app_version: data.app_version,
            game_count: processed_count(&plan.operations.games),
            role_count: processed_count(&plan.operations.roles),
            workspace_count: processed_count(&plan.operations.launch_workspaces),
            game_window_count: processed_count(&plan.operations.game_windows),
            macro_count: processed_count(&plan.operations.macros),
            preferences: data.preferences,
            operations: plan.operations,
            conflicts: plan.conflicts,
            warnings: plan.warnings,
        })
    }

    pub fn prepare_apply(
        &mut self,
        import_id: &str,
        selection: PortableDataSelectionRecord,
        resolutions: Vec<PortableMacroConflictResolutionRecord>,
        snapshot: CoreStateSnapshotRecord,
    ) -> CoreResult<PreparedPortableApply> {
        self.prune_expired();
        let pending = self
            .pending
            .iter()
            .find(|pending| pending.import_id == import_id)
            .ok_or_else(import_expired)?;
        let selection = normalize_selection(selection);
        ensure_selected_content(&pending.data, &selection)?;
        let plan = build_import_plan(&pending.data, &selection, &resolutions, snapshot)?;
        if !plan.conflicts.is_empty() {
            return Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_CONFLICT_UNRESOLVED",
                message: "Resolve every ambiguous macro before importing.".to_owned(),
            });
        }
        let preferences = selection
            .preferences
            .then(|| pending.data.preferences.clone())
            .flatten();
        Ok(PreparedPortableApply {
            affected_macro_ids: plan.affected_macro_ids,
            result: PortableImportResultRecord {
                game_count: processed_count(&plan.operations.games),
                role_count: processed_count(&plan.operations.roles),
                workspace_count: processed_count(&plan.operations.launch_workspaces),
                game_window_count: processed_count(&plan.operations.game_windows),
                macro_count: processed_count(&plan.operations.macros),
                preferences_included: preferences.is_some(),
                preferences,
                selection: effective_selection(&pending.data, &selection),
                operations: plan.operations,
                warnings: plan.warnings,
            },
            snapshot: plan.snapshot,
        })
    }

    pub fn discard(&mut self, import_id: &str) -> bool {
        self.prune_expired();
        let original_len = self.pending.len();
        self.pending
            .retain(|pending| pending.import_id != import_id);
        original_len != self.pending.len()
    }

    fn prune_expired(&mut self) {
        let now = Instant::now();
        self.pending.retain(|pending| {
            now.saturating_duration_since(pending.created_at) <= PENDING_IMPORT_TTL
        });
    }
}

pub(crate) fn export(
    snapshot: CoreStateSnapshotRecord,
    preferences: Option<PortablePreferencesRecord>,
    selection: PortableDataSelectionRecord,
    app_version: &str,
) -> CoreResult<PortableDataRecord> {
    let selection = normalize_selection(selection);
    let preferences = selection.preferences.then_some(preferences).flatten();
    validate_preferences(preferences.as_ref())?;
    let data = PortableDataRecord {
        app: PORTABLE_APP.to_owned(),
        schema_version: CURRENT_SCHEMA as u32,
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: app_version.to_owned(),
        games: if selection.games {
            snapshot.games.iter().map(portable_game).collect()
        } else {
            Vec::new()
        },
        roles: if selection.roles {
            snapshot.roles.iter().map(portable_role).collect()
        } else {
            Vec::new()
        },
        launch_workspaces: if selection.launch_workspaces {
            snapshot
                .launch_workspaces
                .iter()
                .map(portable_workspace)
                .collect()
        } else {
            Vec::new()
        },
        game_windows: if selection.game_windows {
            snapshot
                .game_windows
                .iter()
                .map(portable_game_window)
                .collect()
        } else {
            Vec::new()
        },
        macros: if selection.macros {
            snapshot.macros.iter().map(portable_macro).collect()
        } else {
            Vec::new()
        },
        preferences,
    };
    ensure_selected_content(&data, &selection)?;
    Ok(data)
}

pub(crate) fn write_export(
    path: &str,
    data: &PortableDataRecord,
    requested_selection: &PortableDataSelectionRecord,
) -> CoreResult<PortableExportResultRecord> {
    let path = absolute_portable_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("portable export path has no parent directory"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("portable export path is invalid"))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| portable_io(&temporary, error))?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, data)
            .map_err(|error| invalid(format!("portable export serialization failed: {error}")))?;
        writer
            .write_all(b"\n")
            .and_then(|()| writer.flush())
            .map_err(|error| portable_io(&temporary, error))?;
        writer
            .into_inner()
            .map_err(|error| portable_io(&temporary, error.into_error()))?
            .sync_all()
            .map_err(|error| portable_io(&temporary, error))?;
        rion_platform::atomic_replace_file(&temporary, &path)
            .map_err(|error| CoreError::Platform(error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    let selection = effective_selection(data, &normalize_selection(requested_selection.clone()));
    Ok(PortableExportResultRecord {
        file_path: path.to_string_lossy().into_owned(),
        game_count: data.games.len() as u32,
        role_count: data.roles.len() as u32,
        workspace_count: data.launch_workspaces.len() as u32,
        game_window_count: data.game_windows.len() as u32,
        macro_count: data.macros.len() as u32,
        preferences_included: data.preferences.is_some(),
        selection,
    })
}

fn absolute_portable_path(value: &str) -> CoreResult<PathBuf> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() || !path.is_absolute() {
        return Err(invalid("portable path must be absolute"));
    }
    Ok(path)
}

fn portable_io(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!(
        "portable file operation failed for {}: {error}",
        path.display()
    ))
}

fn build_import_plan(
    data: &PortableDataRecord,
    selection: &PortableDataSelectionRecord,
    resolutions: &[PortableMacroConflictResolutionRecord],
    mut snapshot: CoreStateSnapshotRecord,
) -> CoreResult<ImportPlan> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut warnings = Vec::new();
    let mut operations = PortableImportOperationsRecord::default();
    let mut game_id_map = HashMap::new();
    let mut role_id_map = HashMap::new();
    let mut workspace_id_map = HashMap::new();

    if selection.games {
        let mut used_names = snapshot
            .games
            .iter()
            .map(|game| normalize_name_key(&game.name))
            .collect::<HashSet<_>>();
        let mut seen_keys = HashSet::new();
        for game in &data.games {
            let identity_key = if game.source == "builtin" {
                game.builtin_key
                    .as_ref()
                    .map(|key| format!("builtin:{key}"))
                    .unwrap_or_else(|| format!("custom:{}", normalize_name_key(&game.name)))
            } else {
                format!("custom:{}", normalize_name_key(&game.name))
            };
            let duplicate = !seen_keys.insert(identity_key);
            let existing_index = if duplicate {
                None
            } else if game.source == "builtin" {
                game.builtin_key.as_ref().and_then(|key| {
                    snapshot
                        .games
                        .iter()
                        .position(|candidate| candidate.builtin_key.as_ref() == Some(key))
                })
            } else if game.inferred == Some(true) {
                snapshot.games.iter().position(|candidate| {
                    candidate.source == "custom"
                        && candidate.default_launch_url == game.default_launch_url
                })
            } else {
                snapshot.games.iter().position(|candidate| {
                    candidate.source == "custom"
                        && normalize_name_key(&candidate.name) == normalize_name_key(&game.name)
                })
            };
            if let Some(index) = existing_index {
                let existing = snapshot.games[index].clone();
                game_id_map.insert(game.id.clone(), existing.id.clone());
                if game.inferred == Some(true) {
                    operations.games.unchanged += 1;
                    continue;
                }
                let mut updated = existing.clone();
                if existing.source != "builtin" {
                    updated.name = game.name.clone();
                    updated.icon_image_data_url = game.icon_image_data_url.clone();
                    updated.cover_image_data_url = game.cover_image_data_url.clone();
                }
                updated.default_launch_url = game.default_launch_url.clone();
                updated.local_storage_sync_keys = game.local_storage_sync_keys.clone();
                updated.updated_at = timestamp.clone();
                if game_equivalent(&existing, &updated)? {
                    operations.games.unchanged += 1;
                } else {
                    if existing.source == "builtin" {
                        warnings.push(warning(
                            "BUILTIN_GAME_DEFAULTS_REPLACED",
                            Some(existing.name.clone()),
                            None,
                            None,
                        ));
                    }
                    snapshot.games[index] = updated;
                    operations.games.update += 1;
                }
                continue;
            }

            let mut source = game.clone();
            if duplicate && source.source == "builtin" {
                source.source = "custom".to_owned();
                source.builtin_key = None;
            }
            let name = reserve_import_name(&source.name, &mut used_names)?;
            if name != game.name {
                warnings.push(warning(
                    "GAME_NAME_RENAMED",
                    Some(game.name.clone()),
                    Some(name.clone()),
                    None,
                ));
            }
            let builtin = source.builtin_key.as_deref().and_then(builtin_by_key);
            let created = StateGameRecord {
                id: builtin
                    .map(|definition| definition.id.to_owned())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                source: if builtin.is_some() {
                    "builtin"
                } else {
                    "custom"
                }
                .to_owned(),
                builtin_key: builtin.map(|definition| definition.key.to_owned()),
                name: builtin
                    .map(|definition| definition.name.to_owned())
                    .unwrap_or(name),
                icon_image_data_url: builtin
                    .is_none()
                    .then_some(source.icon_image_data_url)
                    .flatten(),
                cover_image_data_url: builtin
                    .is_none()
                    .then_some(source.cover_image_data_url)
                    .flatten(),
                default_launch_url: source.default_launch_url,
                local_storage_sync_keys: source.local_storage_sync_keys,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            };
            game_id_map.insert(game.id.clone(), created.id.clone());
            snapshot.games.push(created);
            operations.games.create += 1;
        }
    }

    if selection.roles {
        assert_unique_role_names(&snapshot.roles)?;
        let mut seen_keys = HashSet::new();
        for role in &data.roles {
            let source_game_id = role.game_id.as_deref().ok_or_else(role_game_missing)?;
            let game_id = game_id_map
                .get(source_game_id)
                .cloned()
                .ok_or_else(role_game_missing)?;
            if role.game_recovered == Some(true) {
                warnings.push(warning(
                    "ROLE_GAME_RECOVERED",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
            }
            let identity = role_identity(&game_id, &role.name);
            if !seen_keys.insert(identity.clone()) {
                return Err(role_name_conflict());
            }
            if let Some(index) = snapshot.roles.iter().position(|candidate| {
                role_identity(&candidate.game_id, &candidate.name) == identity
            }) {
                let existing = snapshot.roles[index].clone();
                role_id_map.insert(role.id.clone(), existing.id.clone());
                let mut updated = existing.clone();
                updated.game_id = game_id;
                updated.name = role.name.clone();
                updated.launch_url = role.launch_url.clone();
                updated.notes = role.notes.clone();
                updated.cover_image_data_url = role.cover_image_data_url.clone();
                updated.cover_image_dominant_color = role
                    .cover_image_data_url
                    .as_ref()
                    .and(role.cover_image_dominant_color.clone());
                updated.local_storage_source_role_id = None;
                updated.updated_at = timestamp.clone();
                if role_equivalent(&existing, &updated)? {
                    operations.roles.unchanged += 1;
                } else {
                    snapshot.roles[index] = updated;
                    operations.roles.update += 1;
                }
            } else {
                let created = StateRoleRecord {
                    id: Uuid::new_v4().to_string(),
                    game_id,
                    name: role.name.clone(),
                    launch_url: role.launch_url.clone(),
                    notes: role.notes.clone(),
                    cover_image_data_url: role.cover_image_data_url.clone(),
                    cover_image_dominant_color: role
                        .cover_image_data_url
                        .as_ref()
                        .and(role.cover_image_dominant_color.clone()),
                    local_storage_source_role_id: None,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                };
                role_id_map.insert(role.id.clone(), created.id.clone());
                snapshot.roles.push(created);
                operations.roles.create += 1;
            }
        }

        for role in &data.roles {
            let Some(imported_source_id) = role.local_storage_source_role_id.as_deref() else {
                continue;
            };
            let Some(target_id) = role_id_map.get(&role.id).cloned() else {
                continue;
            };
            let Some(source_id) = role_id_map.get(imported_source_id).cloned() else {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_SOURCE_MISSING",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            };
            let portable_source_is_root = data
                .roles
                .iter()
                .find(|candidate| candidate.id == imported_source_id)
                .is_some_and(|candidate| candidate.local_storage_source_role_id.is_none());
            let portable_target_has_dependents = data.roles.iter().any(|candidate| {
                candidate.local_storage_source_role_id.as_deref() == Some(role.id.as_str())
            });
            if !portable_source_is_root || portable_target_has_dependents {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_BINDING_INVALID",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            }
            let Some(target_index) = snapshot
                .roles
                .iter()
                .position(|candidate| candidate.id == target_id)
            else {
                continue;
            };
            let mut candidate = snapshot.roles[target_index].clone();
            candidate.local_storage_source_role_id = Some(source_id);
            let has_managed_keys = snapshot
                .games
                .iter()
                .find(|game| game.id == candidate.game_id)
                .is_some_and(|game| !game.local_storage_sync_keys.is_empty());
            if !has_managed_keys
                || crate::domain::validate_role_local_storage_binding(&candidate, &snapshot.roles)
                    .is_err()
            {
                warnings.push(warning(
                    "ROLE_LOCAL_STORAGE_BINDING_INVALID",
                    Some(role.name.clone()),
                    None,
                    None,
                ));
                continue;
            }
            snapshot.roles[target_index] = candidate;
        }
    }

    if selection.launch_workspaces {
        let mut used_names = snapshot
            .launch_workspaces
            .iter()
            .map(|workspace| normalize_name_key(&workspace.name))
            .collect::<HashSet<_>>();
        let mut seen_keys = HashSet::new();
        for workspace in &data.launch_workspaces {
            let missing = workspace
                .slots
                .iter()
                .filter_map(|slot| slot.role_id.as_ref())
                .filter(|role_id| !role_id_map.contains_key(*role_id))
                .count() as u32;
            if missing > 0 {
                warnings.push(warning(
                    "WORKSPACE_ROLE_MISSING",
                    Some(workspace.name.clone()),
                    None,
                    Some(missing),
                ));
            }
            let slot_count = template_slot_count(&workspace.template)?;
            if workspace
                .slots
                .iter()
                .skip(slot_count)
                .any(|slot| slot.role_id.is_some())
            {
                return Err(invalid(
                    "portable workspace assigns a role outside its template",
                ));
            }
            let identity = normalize_name_key(&workspace.name);
            let duplicate = !seen_keys.insert(identity.clone());
            let existing_index = (!duplicate)
                .then(|| {
                    snapshot
                        .launch_workspaces
                        .iter()
                        .position(|candidate| normalize_name_key(&candidate.name) == identity)
                })
                .flatten();
            let name = if existing_index.is_some() {
                workspace.name.clone()
            } else {
                reserve_import_name(&workspace.name, &mut used_names)?
            };
            if name != workspace.name {
                warnings.push(warning(
                    "WORKSPACE_NAME_RENAMED",
                    Some(workspace.name.clone()),
                    Some(name.clone()),
                    None,
                ));
            }
            let existing = existing_index.map(|index| snapshot.launch_workspaces[index].clone());
            let defaults = default_rects(&workspace.template)?;
            let source_rects = workspace
                .slots
                .iter()
                .take(slot_count)
                .map(|slot| LayoutRect {
                    x: slot.rect.x,
                    y: slot.rect.y,
                    width: slot.rect.width,
                    height: slot.rect.height,
                })
                .collect::<Vec<_>>();
            let repaired_rects = normalize_rect_edges(&source_rects);
            let slots = defaults
                .into_iter()
                .enumerate()
                .map(|(index, default_rect)| {
                    let source = workspace.slots.get(index);
                    let role_id = source
                        .and_then(|slot| slot.role_id.as_ref())
                        .and_then(|role_id| role_id_map.get(role_id))
                        .cloned();
                    StateWorkspaceSlotRecord {
                        id: source
                            .map(|slot| slot.id.clone())
                            .filter(|id| !id.is_empty())
                            .unwrap_or_else(|| format!("slot-{}", index + 1)),
                        browser_zoom_percent: role_id
                            .as_ref()
                            .and_then(|_| source.and_then(|slot| slot.browser_zoom_percent)),
                        role_id,
                        rect: repaired_rects
                            .get(index)
                            .map(|rect| StateNormalizedRectRecord {
                                x: rect.x,
                                y: rect.y,
                                width: rect.width,
                                height: rect.height,
                            })
                            .or_else(|| source.map(|slot| slot.rect.clone()))
                            .unwrap_or(default_rect),
                    }
                })
                .collect();
            let merged = StateLaunchWorkspaceRecord {
                id: existing
                    .as_ref()
                    .map(|workspace| workspace.id.clone())
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                name,
                template: workspace.template.clone(),
                browser_zoom_mode: workspace.browser_zoom_mode.clone(),
                browser_zoom_percent: workspace.browser_zoom_percent,
                slots,
                created_at: existing
                    .as_ref()
                    .map(|workspace| workspace.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            let merged_id = merged.id.clone();
            if let Some(index) = existing_index {
                if workspace_equivalent(&snapshot.launch_workspaces[index], &merged)? {
                    operations.launch_workspaces.unchanged += 1;
                } else {
                    snapshot.launch_workspaces[index] = merged;
                    operations.launch_workspaces.update += 1;
                }
            } else {
                snapshot.launch_workspaces.push(merged);
                operations.launch_workspaces.create += 1;
            }
            workspace_id_map.insert(workspace.id.clone(), merged_id);
        }
    }

    if selection.game_windows {
        let incoming_ids = data
            .game_windows
            .iter()
            .map(|window| window.id.as_str())
            .collect::<HashSet<_>>();
        let mut used_names = snapshot
            .game_windows
            .iter()
            .filter(|window| !incoming_ids.contains(window.id.as_str()))
            .map(|window| normalize_name_key(&window.name))
            .collect::<HashSet<_>>();
        let mut claimed_sources = HashSet::new();
        let mut claimed_roles = HashSet::new();
        let mut used_tab_ids = HashSet::new();
        for window in snapshot
            .game_windows
            .iter()
            .filter(|window| !incoming_ids.contains(window.id.as_str()))
        {
            for tab in &window.tabs {
                claimed_sources.insert(format!("{}:{}", tab.tab_type, tab.source_id));
                claimed_roles.extend(tab.role_ids.iter().cloned());
                used_tab_ids.insert(tab.id.clone());
            }
        }

        for portable in &data.game_windows {
            let existing_index = snapshot
                .game_windows
                .iter()
                .position(|window| window.id == portable.id);
            let name = reserve_import_name(&portable.name, &mut used_names)?;
            if name != portable.name {
                warnings.push(warning(
                    "GAME_WINDOW_NAME_RENAMED",
                    Some(portable.name.clone()),
                    Some(name.clone()),
                    None,
                ));
            }
            let mut tabs = Vec::new();
            let mut imported_tab_ids = HashMap::new();
            for tab in &portable.tabs {
                let source_id = if tab.tab_type == "role" {
                    role_id_map.get(&tab.source_id)
                } else {
                    workspace_id_map.get(&tab.source_id)
                };
                let Some(source_id) = source_id.cloned() else {
                    warnings.push(warning(
                        "GAME_WINDOW_TAB_DEPENDENCY_MISSING",
                        Some(tab.name.clone()),
                        None,
                        None,
                    ));
                    continue;
                };
                let role_ids = if tab.tab_type == "role" {
                    vec![source_id.clone()]
                } else {
                    tab.role_ids
                        .iter()
                        .filter_map(|role_id| role_id_map.get(role_id).cloned())
                        .collect::<Vec<_>>()
                };
                let source_key = format!("{}:{source_id}", tab.tab_type);
                if role_ids.is_empty()
                    || claimed_sources.contains(&source_key)
                    || role_ids
                        .iter()
                        .any(|role_id| claimed_roles.contains(role_id))
                {
                    warnings.push(warning(
                        "GAME_WINDOW_TAB_ROLE_CONFLICT",
                        Some(tab.name.clone()),
                        None,
                        None,
                    ));
                    continue;
                }
                let tab_id = if !tab.id.trim().is_empty() && used_tab_ids.insert(tab.id.clone()) {
                    tab.id.clone()
                } else {
                    let id = Uuid::new_v4().to_string();
                    used_tab_ids.insert(id.clone());
                    id
                };
                let role_views = tab
                    .role_views
                    .iter()
                    .filter_map(|view| {
                        let role_id = role_id_map.get(&view.role_id)?.clone();
                        role_ids.contains(&role_id).then(|| {
                            crate::model::GameWindowRoleViewRecord {
                                role_id,
                                rect: view.rect.clone(),
                                browser_zoom_percent: view.browser_zoom_percent,
                            }
                        })
                    })
                    .collect();
                claimed_sources.insert(source_key);
                claimed_roles.extend(role_ids.iter().cloned());
                imported_tab_ids.insert(tab.id.clone(), tab_id.clone());
                tabs.push(GameWindowTabRecord {
                    id: tab_id,
                    tab_type: tab.tab_type.clone(),
                    source_id,
                    name: tab.name.clone(),
                    role_ids,
                    hidden: tab.hidden,
                    audio_muted: tab.audio_muted,
                    role_views,
                });
            }
            let existing = existing_index.map(|index| snapshot.game_windows[index].clone());
            let merged = StateGameWindowRecord {
                id: portable.id.clone(),
                name,
                target_display: portable.target_display.clone(),
                placement: portable.placement.clone(),
                active_tab_id: portable
                    .active_tab_id
                    .as_ref()
                    .and_then(|id| imported_tab_ids.get(id).cloned())
                    .or_else(|| tabs.first().map(|tab| tab.id.clone())),
                tabs,
                created_at: existing
                    .as_ref()
                    .map(|window| window.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            if let Some(index) = existing_index {
                if game_window_equivalent(&snapshot.game_windows[index], &merged)? {
                    operations.game_windows.unchanged += 1;
                } else {
                    snapshot.game_windows[index] = merged;
                    operations.game_windows.update += 1;
                }
            } else {
                snapshot.game_windows.push(merged);
                operations.game_windows.create += 1;
            }
        }
        crate::domain::validate_game_window_collection(&snapshot.game_windows)?;
    }

    let mut conflicts = Vec::new();
    let mut affected_macro_ids = Vec::new();
    if selection.macros {
        let resolution_by_id = resolutions
            .iter()
            .map(|resolution| (resolution_conflict_id(resolution), resolution))
            .collect::<HashMap<_, _>>();
        if resolution_by_id.len() != resolutions.len() {
            return Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_RESOLUTION_INVALID",
                message: "Portable import conflict resolution is invalid.".to_owned(),
            });
        }
        let existing_macros = snapshot.macros.clone();
        let mut seen_keys = HashSet::new();
        let mut used_copy_names = existing_macros
            .iter()
            .map(|macro_record| normalize_name_key(&macro_record.name))
            .collect::<HashSet<_>>();
        let mut planned = Vec::new();
        for macro_record in &data.macros {
            let mut seen_role_ids = HashSet::new();
            let role_ids = macro_record
                .role_ids
                .iter()
                .filter_map(|role_id| role_id_map.get(role_id).cloned())
                .filter(|role_id| seen_role_ids.insert(role_id.clone()))
                .collect::<Vec<_>>();
            let missing = macro_record
                .role_ids
                .iter()
                .collect::<HashSet<_>>()
                .into_iter()
                .filter(|role_id| !role_id_map.contains_key(*role_id))
                .count() as u32;
            if missing > 0 {
                warnings.push(warning(
                    "MACRO_ROLE_MISSING",
                    Some(macro_record.name.clone()),
                    None,
                    Some(missing),
                ));
            }
            if !macro_record.role_ids.is_empty() && role_ids.is_empty() {
                warnings.push(warning(
                    "MACRO_SKIPPED_NO_ROLES",
                    Some(macro_record.name.clone()),
                    None,
                    None,
                ));
                operations.macros.skip += 1;
                continue;
            }
            let identity = macro_identity(&macro_record.name, &role_ids);
            if !seen_keys.insert(identity.clone()) {
                let name = reserve_import_name(&macro_record.name, &mut used_copy_names)?;
                warnings.push(warning(
                    "MACRO_NAME_RENAMED",
                    Some(macro_record.name.clone()),
                    Some(name.clone()),
                    None,
                ));
                planned.push(PlannedMacro {
                    destination_id: Uuid::new_v4().to_string(),
                    existing: None,
                    macro_record: macro_record.clone(),
                    name,
                    role_ids,
                });
                continue;
            }
            let candidates = existing_macros
                .iter()
                .filter(|candidate| {
                    macro_identity(&candidate.name, &candidate.role_ids) == identity
                })
                .cloned()
                .collect::<Vec<_>>();
            if candidates.len() <= 1 {
                planned.push(PlannedMacro {
                    destination_id: candidates
                        .first()
                        .map(|candidate| candidate.id.clone())
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    existing: candidates.first().cloned(),
                    macro_record: macro_record.clone(),
                    name: macro_record.name.clone(),
                    role_ids,
                });
                continue;
            }
            let conflict_id = format!("macro:{}", macro_record.id);
            match resolution_by_id.get(conflict_id.as_str()).copied() {
                Some(PortableMacroConflictResolutionRecord::Skip { .. }) => {
                    operations.macros.skip += 1;
                }
                Some(PortableMacroConflictResolutionRecord::Copy { .. }) => {
                    let name = reserve_import_name(&macro_record.name, &mut used_copy_names)?;
                    warnings.push(warning(
                        "MACRO_NAME_RENAMED",
                        Some(macro_record.name.clone()),
                        Some(name.clone()),
                        None,
                    ));
                    planned.push(PlannedMacro {
                        destination_id: Uuid::new_v4().to_string(),
                        existing: None,
                        macro_record: macro_record.clone(),
                        name,
                        role_ids,
                    });
                }
                Some(PortableMacroConflictResolutionRecord::Update {
                    target_macro_id, ..
                }) => {
                    let selected = candidates
                        .iter()
                        .find(|candidate| &candidate.id == target_macro_id)
                        .cloned()
                        .ok_or_else(|| CoreError::Domain {
                            code: "PORTABLE_IMPORT_RESOLUTION_INVALID",
                            message: "Portable import conflict resolution is invalid.".to_owned(),
                        })?;
                    planned.push(PlannedMacro {
                        destination_id: selected.id.clone(),
                        existing: Some(selected),
                        macro_record: macro_record.clone(),
                        name: macro_record.name.clone(),
                        role_ids,
                    });
                }
                None => conflicts.push(portable_conflict(
                    &conflict_id,
                    macro_record,
                    &role_ids,
                    &candidates,
                    &snapshot.roles,
                )),
            }
        }

        let mut macro_id_map = planned
            .iter()
            .map(|item| (item.macro_record.id.clone(), item.destination_id.clone()))
            .collect::<HashMap<_, _>>();
        loop {
            let missing_index = planned.iter().position(|item| {
                item.macro_record.steps.iter().any(|step| match step {
                    MacroStepDefinition::Macro { macro_id, .. } => {
                        !macro_id_map.contains_key(macro_id)
                    }
                    _ => false,
                })
            });
            let Some(index) = missing_index else { break };
            let removed = planned.remove(index);
            macro_id_map.remove(&removed.macro_record.id);
            warnings.push(warning(
                "MACRO_SKIPPED_MISSING_DEPENDENCY",
                Some(removed.name),
                None,
                None,
            ));
            operations.macros.skip += 1;
        }

        let replaced_ids = planned
            .iter()
            .filter_map(|item| item.existing.as_ref().map(|existing| existing.id.clone()))
            .collect::<HashSet<_>>();
        let mut accepted = existing_macros
            .iter()
            .filter(|macro_record| !replaced_ids.contains(&macro_record.id))
            .cloned()
            .collect::<Vec<_>>();
        let mut replacements = HashMap::new();
        let mut created = Vec::new();
        let mut directly_affected = Vec::new();
        for item in planned {
            let mut trigger = item.macro_record.trigger.clone();
            if trigger.as_ref().is_some_and(is_overlay_trigger) {
                warnings.push(warning(
                    "MACRO_SHORTCUT_CLEARED_RESERVED",
                    Some(item.name.clone()),
                    None,
                    None,
                ));
                trigger = None;
            } else if trigger.as_ref().is_some_and(|trigger| {
                accepted.iter().any(|candidate| {
                    candidate
                        .trigger
                        .as_ref()
                        .is_some_and(|candidate_trigger| triggers_equal(candidate_trigger, trigger))
                        && roles_overlap(&candidate.role_ids, &item.role_ids)
                })
            }) {
                warnings.push(warning(
                    "MACRO_SHORTCUT_CLEARED_CONFLICT",
                    Some(item.name.clone()),
                    None,
                    None,
                ));
                trigger = None;
            }
            let steps = item
                .macro_record
                .steps
                .iter()
                .cloned()
                .map(|step| remap_macro_step(step, &macro_id_map))
                .collect::<CoreResult<Vec<_>>>()?;
            let merged = StateMacroRecord {
                id: item.destination_id,
                enabled: item.macro_record.enabled,
                activation_mode: Some(if trigger.is_some() {
                    item.macro_record.activation_mode.clone()
                } else {
                    "toggle".to_owned()
                }),
                name: item.name,
                role_ids: item.role_ids,
                trigger,
                repeat: item.macro_record.repeat,
                steps,
                created_at: item
                    .existing
                    .as_ref()
                    .map(|existing| existing.created_at.clone())
                    .unwrap_or_else(|| timestamp.clone()),
                updated_at: timestamp.clone(),
            };
            if let Some(existing) = item.existing {
                if macro_equivalent(&existing, &merged)? {
                    replacements.insert(existing.id.clone(), existing.clone());
                    accepted.push(existing);
                    operations.macros.unchanged += 1;
                } else {
                    directly_affected.push(existing.id.clone());
                    replacements.insert(existing.id, merged.clone());
                    accepted.push(merged);
                    operations.macros.update += 1;
                }
            } else {
                accepted.push(merged.clone());
                created.push(merged);
                operations.macros.create += 1;
            }
        }
        snapshot.macros = existing_macros
            .iter()
            .map(|macro_record| {
                replacements
                    .get(&macro_record.id)
                    .cloned()
                    .unwrap_or_else(|| macro_record.clone())
            })
            .chain(created)
            .collect();
        validate_macro_records(&snapshot.macros)?;
        affected_macro_ids = existing_macros
            .iter()
            .filter(|macro_record| {
                directly_affected.contains(&macro_record.id)
                    || directly_affected
                        .iter()
                        .any(|target| macro_depends_on(&existing_macros, &macro_record.id, target))
            })
            .map(|macro_record| macro_record.id.clone())
            .collect();
    }

    if selection.preferences
        && let Some(preferences) = &data.preferences
    {
        if let Some(settings) = &preferences.game_browser_settings {
            validate_game_browser_settings(settings)?;
            snapshot.game_browser_settings = Some(settings.clone());
        }
        if let Some(settings) = &preferences.macro_settings {
            validate_macro_settings(settings)?;
            snapshot.macro_settings = Some(settings.clone());
        }
    }

    Ok(ImportPlan {
        affected_macro_ids,
        conflicts,
        operations,
        snapshot,
        warnings,
    })
}

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
        local_storage_sync_keys: game.local_storage_sync_keys.clone(),
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
        local_storage_source_role_id: role.local_storage_source_role_id.clone(),
    }
}

fn portable_workspace(workspace: &StateLaunchWorkspaceRecord) -> PortableLaunchWorkspaceRecord {
    PortableLaunchWorkspaceRecord {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        template: workspace.template.clone(),
        browser_zoom_mode: workspace.browser_zoom_mode.clone(),
        browser_zoom_percent: workspace.browser_zoom_percent,
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
    PortableMacroRecord {
        id: macro_record.id.clone(),
        enabled: macro_record.enabled,
        activation_mode: macro_record
            .activation_mode
            .clone()
            .unwrap_or_else(|| "toggle".to_owned()),
        name: macro_record.name.clone(),
        role_ids,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture(schema: u64) -> String {
        json!({
            "app":"Rion Studio","schemaVersion":schema,"exportedAt":"2026-01-01T00:00:00Z","appVersion":"1.37.0",
            "games": if schema >= 2 { json!([{"id":"g1","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit"}]) } else { json!([]) },
            "roles":[{"id":"r1","gameId": if schema >= 2 { "g1" } else { "" },"name":"Role","launchUrl":"https://example.test/play","notes":""}],
            "launchWorkspaces":[{"id":"w1","name":"Workspace","template":"single","browserZoomPercent":100,"slots":[{"id":"s1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}]}],
            "gameWindows":[],
            "macros":[{"id":"m1","name":"Macro","roleIds":["r1"],"repeat":{"type":"once"},"steps":[{"id":"step","type":"delay","ms":1}]}]
        }).to_string()
    }

    fn fixture_value(schema: u64) -> Value {
        serde_json::from_str(&fixture(schema)).unwrap()
    }

    fn state_fixture() -> CoreStateSnapshotRecord {
        serde_json::from_value(json!({
            "games": [{
                "id":"g","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles": [{
                "id":"r","gameId":"g","name":"Role","launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "launchWorkspaces": [],
            "macros": [{
                "id":"m","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["r"],
                "repeat":{"type":"once"},"steps":[{"id":"delay","type":"delay","ms":1}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "compatibilityReports": []
        }))
        .unwrap()
    }

    #[test]
    fn normalizes_every_supported_portable_schema_to_v10() {
        for schema in 1..=10 {
            let value = normalize(&fixture(schema)).unwrap();
            assert_eq!(value["schemaVersion"], 10);
            assert!(!value["roles"][0]["gameId"].as_str().unwrap().is_empty());
            assert_eq!(value["macros"][0]["enabled"], true);
            assert!(value["launchWorkspaces"][0].get("resourcePolicy").is_none());
        }
    }

    // Historical parity evidence retained after the portable schema advanced to v10.
    #[test]
    fn normalizes_every_supported_portable_schema_to_v7() {
        normalizes_every_supported_portable_schema_to_v10();
    }

    #[test]
    fn removes_legacy_browser_engine_fields_before_import() {
        let mut source = fixture_value(7);
        source["games"][0]["browserEngine"] = json!("electron");
        source["roles"][0]["browserEnginePin"] = json!("electron");
        source["launchWorkspaces"][0]["browserEngine"] = json!("electron");

        let normalized = normalize(&source.to_string()).unwrap();

        assert!(normalized["games"][0].get("browserEngine").is_none());
        assert!(normalized["roles"][0].get("browserEnginePin").is_none());
        assert!(
            normalized["launchWorkspaces"][0]
                .get("browserEngine")
                .is_none()
        );
    }

    #[test]
    fn portable_game_windows_remap_dependencies_and_keep_first_role_claim() {
        let mut source = fixture_value(8);
        let first_window_id = uuid::Uuid::new_v4().to_string();
        let second_window_id = uuid::Uuid::new_v4().to_string();
        source["gameWindows"] = json!([
            {
                "id": first_window_id,
                "name": "Imported Window",
                "targetDisplay": { "id": 7 },
                "placement": {
                    "normalBounds": { "x": 20, "y": 20, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "maximized"
                },
                "tabs": [{
                    "id": uuid::Uuid::new_v4().to_string(),
                    "tabType": "workspace",
                    "sourceId": "w1",
                    "name": "Workspace",
                    "roleIds": ["r1"],
                    "hidden": true,
                    "audioMuted": true,
                    "roleViews": [{
                        "roleId": "r1",
                        "rect": { "x": 0, "y": 0, "width": 1, "height": 1 },
                        "browserZoomPercent": 90
                    }]
                }],
                "activeTabId": null
            },
            {
                "id": second_window_id,
                "name": "Second Window",
                "targetDisplay": { "id": 7 },
                "placement": {
                    "normalBounds": { "x": 40, "y": 40, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                },
                "tabs": [{
                    "id": uuid::Uuid::new_v4().to_string(),
                    "tabType": "role",
                    "sourceId": "r1",
                    "name": "Duplicate role",
                    "roleIds": ["r1"],
                    "hidden": false,
                    "audioMuted": false,
                    "roleViews": []
                }],
                "activeTabId": null
            }
        ]);
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &source.to_string(),
                "/tmp/game-windows.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();

        assert_eq!(prepared.snapshot.game_windows.len(), 2);
        assert_eq!(prepared.snapshot.game_windows[0].tabs.len(), 1);
        assert!(prepared.snapshot.game_windows[0].tabs[0].hidden);
        assert!(prepared.snapshot.game_windows[0].tabs[0].audio_muted);
        assert_eq!(
            prepared.snapshot.game_windows[0].placement.presentation,
            "maximized"
        );
        assert!(prepared.snapshot.game_windows[1].tabs.is_empty());
        assert!(
            prepared
                .result
                .warnings
                .iter()
                .any(|warning| { warning.code == "GAME_WINDOW_TAB_ROLE_CONFLICT" })
        );
    }

    #[test]
    fn ignores_legacy_workspace_resource_policies_in_every_supported_schema() {
        for schema in 1..=7 {
            for mode in ["adaptive", "unrestricted"] {
                let mut source = fixture_value(schema);
                source["launchWorkspaces"][0]["resourcePolicy"] = json!({ "mode": mode });
                let normalized = normalize(&source.to_string()).unwrap();
                assert!(
                    normalized["launchWorkspaces"][0]
                        .get("resourcePolicy")
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn rejects_cycles_and_unsupported_versions() {
        let mut cycle: Value = serde_json::from_str(&fixture(6)).unwrap();
        cycle["macros"] = json!([
            {
                "id":"a","name":"A","roleIds":["r1"],"repeat":{"type":"once"},
                "steps":[{"id":"call-b","type":"macro","macroId":"b"}]
            },
            {
                "id":"b","name":"B","roleIds":["r1"],"repeat":{"type":"once"},
                "steps":[{"id":"call-a","type":"macro","macroId":"a"}]
            }
        ]);
        crate::v1_case!("portable-profile-8808c827c529", {
            let error = normalize(&cycle.to_string()).unwrap_err();
            assert_eq!(error.code(), "PORTABLE_MACRO_DEPENDENCY_INVALID");
        });
        let future = fixture(10).replace("\"schemaVersion\":10", "\"schemaVersion\":11");
        assert!(normalize(&future).is_err());
    }

    fn empty_snapshot() -> CoreStateSnapshotRecord {
        CoreStateSnapshotRecord::default()
    }

    #[test]
    fn rust_runtime_owns_preview_selection_and_single_apply_snapshot() {
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(&fixture(6), "/tmp/import.json".to_owned(), empty_snapshot())
            .unwrap();
        assert_eq!(preview.operations.games.create, 1);
        assert_eq!(preview.operations.roles.create, 1);
        assert_eq!(preview.operations.launch_workspaces.create, 1);
        assert_eq!(preview.operations.macros.create, 1);

        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: true,
                    preferences: false,
                },
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();
        assert_eq!(prepared.snapshot.games.len(), 1);
        assert_eq!(prepared.snapshot.roles.len(), 1);
        assert_eq!(prepared.snapshot.macros.len(), 1);
        assert!(prepared.snapshot.launch_workspaces.is_empty());
        assert!(prepared.result.selection.games);
        assert!(prepared.result.selection.roles);
        assert!(prepared.result.selection.macros);
        assert!(!prepared.result.selection.launch_workspaces);
    }

    #[test]
    fn portable_v10_remaps_role_local_storage_bindings_and_warns_when_missing() {
        let mut source = fixture_value(10);
        source["games"][0]["localStorageSyncKeys"] = json!(["game_client_settings"]);
        source["roles"] = json!([
            {"id":"master","gameId":"g1","name":"Master","launchUrl":"https://example.test/play","notes":""},
            {"id":"follower","gameId":"g1","name":"Follower","launchUrl":"https://example.test/play","notes":"","localStorageSourceRoleId":"master"}
        ]);
        source["launchWorkspaces"] = json!([]);
        source["macros"] = json!([]);

        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &source.to_string(),
                "/tmp/binding.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();
        let master = prepared
            .snapshot
            .roles
            .iter()
            .find(|role| role.name == "Master")
            .unwrap();
        let follower = prepared
            .snapshot
            .roles
            .iter()
            .find(|role| role.name == "Follower")
            .unwrap();
        assert_eq!(
            follower.local_storage_source_role_id.as_deref(),
            Some(master.id.as_str())
        );

        source["roles"][1]["localStorageSourceRoleId"] = json!("missing");
        let preview = runtime
            .preview(
                &source.to_string(),
                "/tmp/missing.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                empty_snapshot(),
            )
            .unwrap();
        assert!(
            prepared
                .snapshot
                .roles
                .iter()
                .all(|role| role.local_storage_source_role_id.is_none())
        );
        assert!(
            prepared
                .result
                .warnings
                .iter()
                .any(|warning| warning.code == "ROLE_LOCAL_STORAGE_SOURCE_MISSING")
        );
    }

    #[test]
    fn portable_macro_schema_and_dependency_contracts_match_v1() {
        crate::v1_case!("portable-profile-8e28536dd709", {
            let mut source = fixture_value(6);
            source["roles"] = json!([]);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([
                {
                    "id":"child","name":"Child","roleIds":[],"repeat":{"type":"once"},
                    "steps":[{"id":"child-delay","type":"delay","ms":1}]
                },
                {
                    "id":"parent","name":"Parent","roleIds":[],"repeat":{"type":"once"},
                    "steps":[{"id":"call-child","type":"macro","macroId":"child"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/unassigned.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(prepared.snapshot.macros.len(), 2);
            let child_id = &prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Child")
                .unwrap()
                .id;
            let parent = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Parent")
                .unwrap();
            assert!(parent.role_ids.is_empty());
            assert!(parent.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == child_id
            )));
        });

        crate::v1_case!("portable-profile-e6af9396e983", {
            let mut current = fixture_value(5);
            current["macros"][0]["steps"] = json!([{
                "id":"key","type":"key","code":"KeyK","modifiers":["primary","shift"]
            }]);
            let normalized = normalize(&current.to_string()).unwrap();
            assert_eq!(
                normalized["macros"][0]["steps"][0]["modifiers"],
                json!(["primary", "shift"])
            );
            current["schemaVersion"] = json!(4);
            let legacy = normalize(&current.to_string()).unwrap();
            assert!(legacy["macros"][0]["steps"][0].get("modifiers").is_none());
        });

        crate::v1_case!("portable-profile-ad31d6182c00", {
            let mut source = fixture_value(4);
            source["macros"][0]["activationMode"] = json!("while_held");
            source["macros"][0]["trigger"] =
                json!({"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false});
            source["macros"][0]["steps"] = json!([{
                "id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"
            }]);
            let normalized = normalize(&source.to_string()).unwrap();
            assert_eq!(normalized["macros"][0]["activationMode"], "while_held");
            assert_eq!(
                normalized["macros"][0]["steps"][0]["action"],
                "hold_until_stop"
            );
        });

        crate::v1_case!("portable-profile-1e98f72121bd", {
            let mut source = fixture_value(3);
            source["macros"] = json!([
                {
                    "id":"parent","name":"Parent","roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"call","type":"macro","macroId":"child"}]
                },
                {
                    "id":"child","name":"Child","roleIds":["r1"],
                    "activationMode":"while_held",
                    "trigger":{"code":"F7","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/two-pass.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            let child = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Child")
                .unwrap();
            let parent = prepared
                .snapshot
                .macros
                .iter()
                .find(|item| item.name == "Parent")
                .unwrap();
            assert_ne!(child.id, "child");
            assert!(parent.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == &child.id
            )));
            assert_eq!(child.activation_mode.as_deref(), Some("while_held"));
        });

        crate::v1_case!("portable-profile-80399681ac04", {
            let mut source = fixture_value(6);
            source["macros"] = json!([
                {
                    "id":"target","name":"Unavailable target","roleIds":["missing"],
                    "repeat":{"type":"once"},"steps":[{"id":"delay","type":"delay","ms":1}]
                },
                {
                    "id":"parent","name":"Dependent parent","roleIds":["r1"],
                    "repeat":{"type":"once"},
                    "steps":[{"id":"call","type":"macro","macroId":"target"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/missing-dependency.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(preview.operations.macros.skip, 2);
            assert_eq!(
                preview
                    .warnings
                    .iter()
                    .filter(|warning| {
                        matches!(
                            warning.code.as_str(),
                            "MACRO_SKIPPED_NO_ROLES" | "MACRO_SKIPPED_MISSING_DEPENDENCY"
                        )
                    })
                    .count(),
                2
            );
        });
    }

    #[test]
    fn portable_export_selection_and_preferences_match_v1() {
        crate::v1_case!("portable-profile-f1fe3b381736", {
            let exported = export(
                state_fixture(),
                None,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: true,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.games.len(), 1);
            assert_eq!(exported.roles.len(), 1);
            assert_eq!(exported.macros.len(), 1);
            assert!(exported.launch_workspaces.is_empty());
            assert!(exported.preferences.is_none());
        });

        crate::v1_case!("portable-profile-5304f75afec4", {
            let mut snapshot = state_fixture();
            snapshot.roles.clear();
            snapshot.macros.clear();
            let exported = export(
                snapshot,
                None,
                PortableDataSelectionRecord {
                    games: true,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.games.len(), 1);
            assert!(exported.roles.is_empty());
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &serde_json::to_string(&exported).unwrap(),
                    "/tmp/games-only.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(preview.game_count, 1);
            assert_eq!(preview.role_count, 0);
        });

        crate::v1_case!("portable-profile-9ff67670a6e1", {
            let error = export(
                empty_snapshot(),
                None,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                "2.0.0",
            )
            .unwrap_err();
            assert_eq!(error.code(), "PORTABLE_SELECTION_EMPTY");
        });

        crate::v1_case!("portable-profile-34a45c05788e", {
            let preferences = PortablePreferencesRecord {
                game_browser_settings: None,
                language: None,
                macro_settings: Some(crate::domain::default_macro_settings()),
                theme_mode: None,
            };
            let exported = export(
                state_fixture(),
                Some(preferences),
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: true,
                },
                "2.0.0",
            )
            .unwrap();
            assert_eq!(exported.schema_version, 10);
            let settings = exported.preferences.unwrap().macro_settings.unwrap();
            assert_eq!(settings.startup_delay_ms, 100);
            assert_eq!(settings.default_loop_delay_ms, 1_000);
        });

        crate::v1_case!("portable-profile-aeb1cbd39bbb", {
            let mut source = fixture_value(6);
            source["preferences"] = json!({"language":"ja","themeMode":"light"});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/preferences-only.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    PortableDataSelectionRecord {
                        games: false,
                        roles: false,
                        launch_workspaces: false,
                        game_windows: false,
                        macros: false,
                        preferences: true,
                    },
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(prepared.result.game_count, 0);
            assert_eq!(prepared.result.role_count, 0);
            assert_eq!(prepared.result.macro_count, 0);
            assert!(prepared.result.preferences_included);
            assert_eq!(
                prepared
                    .result
                    .preferences
                    .as_ref()
                    .and_then(|preferences| preferences.language.as_deref()),
                Some("ja")
            );
        });

        crate::v1_case!("portable-profile-3f9907060aae", {
            let mut source = fixture_value(6);
            source["preferences"] = json!({"language":"en"});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/retry-selection.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let empty = runtime.prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: false,
                },
                Vec::new(),
                empty_snapshot(),
            );
            assert!(matches!(
                empty,
                Err(CoreError::Domain {
                    code: "PORTABLE_SELECTION_EMPTY",
                    ..
                })
            ));
            let retry = runtime
                .prepare_apply(
                    &preview.import_id,
                    PortableDataSelectionRecord {
                        games: false,
                        roles: false,
                        launch_workspaces: false,
                        game_windows: false,
                        macros: false,
                        preferences: true,
                    },
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(retry.result.preferences_included);
        });
    }

    #[test]
    fn portable_export_never_contains_device_local_runtime_restore_state() {
        let mut snapshot = state_fixture();
        snapshot.runtime_restore_session = Some(
            serde_json::from_value(json!({
                "schemaVersion": 1,
                "updatedAt": "2026-07-25T00:00:00Z",
                "cleanExit": true,
                "windows": [{
                    "id": "window-1",
                    "targetDisplay": {"id": 7},
                    "wasVisible": true,
                    "tabs": [{
                        "tabType": "role",
                        "sourceId": "r",
                        "name": "Role",
                        "roleIds": ["r"],
                        "hidden": false,
                        "audioMuted": false
                    }]
                }]
            }))
            .unwrap(),
        );

        let exported = export(
            snapshot,
            None,
            PortableDataSelectionRecord {
                games: true,
                roles: true,
                launch_workspaces: false,
                game_windows: false,
                macros: true,
                preferences: false,
            },
            "2.0.0",
        )
        .unwrap();
        let exported = serde_json::to_value(exported).unwrap();

        assert!(exported.get("runtimeRestoreSession").is_none());
        assert!(exported.get("runtimeWindowPreferences").is_none());
    }

    #[test]
    fn portable_preferences_do_not_export_or_overwrite_device_log_level() {
        let mut snapshot = state_fixture();
        snapshot.log_level = Some(crate::model::LogLevel::Debug);
        let preferences = PortablePreferencesRecord {
            game_browser_settings: None,
            language: Some("en".to_owned()),
            macro_settings: None,
            theme_mode: None,
        };
        let exported = export(
            snapshot.clone(),
            Some(preferences),
            PortableDataSelectionRecord {
                games: false,
                roles: false,
                launch_workspaces: false,
                game_windows: false,
                macros: false,
                preferences: true,
            },
            "2.0.0",
        )
        .unwrap();
        assert!(
            serde_json::to_value(&exported)
                .unwrap()
                .get("logLevel")
                .is_none()
        );

        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &serde_json::to_string(&exported).unwrap(),
                "/tmp/preferences-with-local-log-level.json".to_owned(),
                snapshot.clone(),
            )
            .unwrap();
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                PortableDataSelectionRecord {
                    games: false,
                    roles: false,
                    launch_workspaces: false,
                    game_windows: false,
                    macros: false,
                    preferences: true,
                },
                Vec::new(),
                snapshot,
            )
            .unwrap();
        assert_eq!(
            prepared.snapshot.log_level,
            Some(crate::model::LogLevel::Debug)
        );
    }

    #[test]
    fn portable_validation_boundaries_match_v1() {
        crate::v1_case!("portable-profile-2d3cefe26629", {
            let mut source = fixture_value(2);
            source["games"][0]["coverImageDataUrl"] = json!("https://example.test/cover.png");
            assert_eq!(
                normalize(&source.to_string()).unwrap_err().code(),
                "CORE_INPUT_INVALID"
            );
        });

        crate::v1_case!("portable-profile-9a858942068b", {
            assert_eq!(
                normalize(r#"{"app":"Rion Studio","schemaVersion":999}"#)
                    .unwrap_err()
                    .code(),
                "CORE_INPUT_INVALID"
            );
            assert_eq!(normalize("{").unwrap_err().code(), "CORE_INPUT_INVALID");
        });

        crate::v1_case!("portable-profile-920e788a3d07", {
            let mut source = fixture_value(4);
            for macro_value in [
                json!({
                    "id":"bad","enabled":true,"activationMode":"invalid","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }),
                json!({
                    "id":"bad","enabled":true,"activationMode":"toggle","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"key_down"}]
                }),
                json!({
                    "id":"bad","enabled":true,"activationMode":"while_held","name":"Bad",
                    "roleIds":["r1"],"repeat":{"type":"once"},
                    "steps":[{"id":"hold","type":"key","code":"KeyW","action":"hold_until_stop"}]
                }),
            ] {
                source["macros"] = json!([macro_value]);
                assert_eq!(
                    normalize(&source.to_string()).unwrap_err().code(),
                    "CORE_INPUT_INVALID"
                );
            }
            source["schemaVersion"] = json!("4");
            assert_eq!(
                normalize(&source.to_string()).unwrap_err().code(),
                "CORE_INPUT_INVALID"
            );
        });

        crate::v1_case!("portable-profile-4a3164c3671d", {
            let mut source = fixture_value(6);
            source["macros"][0]["repeat"] = json!({"type":"loop","intervalMs":86_400_000_u64});
            source["macros"][0]["steps"] =
                json!([{"id":"delay","type":"delay","ms":86_400_000_u64}]);
            assert!(normalize(&source.to_string()).is_ok());
            source["macros"][0]["steps"][0]["ms"] = json!(86_400_001_u64);
            assert!(normalize(&source.to_string()).is_err());
            source["macros"][0]["steps"][0]["ms"] = json!(86_400_000_u64);
            source["macros"][0]["repeat"]["intervalMs"] = json!(86_400_001_u64);
            assert!(normalize(&source.to_string()).is_err());
        });
    }

    #[test]
    fn portable_workspace_and_legacy_field_migrations_match_v1() {
        crate::v1_case!("portable-profile-f6192f7c5af5", {
            let mut source = fixture_value(6);
            source["preferences"] = json!({"language":"ja"});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/workspace-only.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    PortableDataSelectionRecord {
                        games: false,
                        roles: false,
                        launch_workspaces: true,
                        game_windows: false,
                        macros: false,
                        preferences: false,
                    },
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert_eq!(prepared.result.game_count, 1);
            assert_eq!(prepared.result.role_count, 1);
            assert_eq!(prepared.result.workspace_count, 1);
            assert_eq!(prepared.result.macro_count, 0);
            assert!(!prepared.result.preferences_included);
            assert!(prepared.result.selection.games);
            assert!(prepared.result.selection.roles);
            assert!(prepared.result.selection.launch_workspaces);
            assert!(!prepared.result.selection.macros);
        });

        crate::v1_case!("portable-profile-8d9b6b46ac4a", {
            let mut source = fixture_value(6);
            source["launchWorkspaces"][0]["template"] = json!("nine_grid");
            source["launchWorkspaces"][0]["browserZoomPercent"] = json!(80);
            source["launchWorkspaces"][0]["slots"] = Value::Array(
                default_rects("nine_grid")
                    .unwrap()
                    .into_iter()
                    .enumerate()
                    .map(|(index, rect)| {
                        json!({
                            "id":format!("slot-{}", index + 1),
                            "roleId": (index == 0).then_some("r1"),
                            "rect":rect
                        })
                    })
                    .collect(),
            );
            assert!(normalize(&source.to_string()).is_ok());
            source["launchWorkspaces"][0]["slots"]
                .as_array_mut()
                .unwrap()
                .push(json!({
                    "id":"slot-10",
                    "rect":{"x":0,"y":0,"width":0.3333,"height":0.3333}
                }));
            assert!(normalize(&source.to_string()).is_err());
        });

        crate::v1_case!("portable-profile-d77ce362da9b", {
            let mut source = fixture_value(6);
            source["launchWorkspaces"][0] = json!({
                "id":"w1","name":"Workspace","template":"three_columns",
                "browserZoomMode":"fixed","browserZoomPercent":90,
                "resourcePolicy":{"mode":"unrestricted"},
                "slots":[
                    {
                        "id":"slot-1","roleId":"r1","browserZoomPercent":120,
                        "rect":{"x":0,"y":0,"width":0.3333,"height":1}
                    },
                    {"id":"slot-2","rect":{"x":0.3333,"y":0,"width":0.3333,"height":1}},
                    {"id":"slot-3","rect":{"x":0.6667,"y":0,"width":0.3333,"height":1}}
                ]
            });
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/legacy-thirds.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            let workspace = &prepared.snapshot.launch_workspaces[0];
            assert_eq!(
                workspace
                    .slots
                    .iter()
                    .map(|slot| [slot.rect.x, slot.rect.y, slot.rect.width, slot.rect.height])
                    .collect::<Vec<_>>(),
                vec![
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0]
                ]
            );
            assert!(
                serde_json::to_value(workspace)
                    .unwrap()
                    .get("resourcePolicy")
                    .is_none()
            );
            assert_eq!(workspace.browser_zoom_mode, "fixed");
            assert_eq!(workspace.slots[0].browser_zoom_percent, Some(120.0));
            source["launchWorkspaces"][0]["slots"][0]["browserZoomPercent"] = json!(301);
            assert!(normalize(&source.to_string()).is_err());
        });

        crate::v1_case!("portable-profile-010d0aa468df", {
            let mut source = fixture_value(6);
            source["launchWorkspaces"][0]["resourcePolicy"] =
                json!({"mode":"primary_priority","backgroundCpuThrottleRate":2});
            for slot in source["launchWorkspaces"][0]["slots"]
                .as_array_mut()
                .unwrap()
            {
                slot.as_object_mut().unwrap().remove("roleId");
            }
            source["macros"] = json!([]);
            let normalized = normalize(&source.to_string()).unwrap();
            assert!(
                normalized["launchWorkspaces"][0]
                    .get("resourcePolicy")
                    .is_none()
            );
        });

        crate::v1_case!("portable-profile-84356a8bf16d", {
            let mut source = fixture_value(6);
            source["launchWorkspaces"][0]["template"] = json!("single");
            source["launchWorkspaces"][0]["slots"] = json!([
                {"id":"slot-1","rect":{"x":0,"y":0,"width":1,"height":1}},
                {
                    "id":"slot-2","roleId":"r1",
                    "rect":{"x":0.5,"y":0,"width":0.5,"height":1}
                }
            ]);
            let mut runtime = PortableRuntime::default();
            assert_eq!(
                runtime
                    .preview(
                        &source.to_string(),
                        "/tmp/outside-layout.json".to_owned(),
                        empty_snapshot()
                    )
                    .unwrap_err()
                    .code(),
                "CORE_INPUT_INVALID"
            );
        });

        crate::v1_case!("portable-profile-107e66b960d2", {
            let mut source = fixture_value(6);
            source["preferences"] = json!({
                "language":"zh-TW",
                "roleDefaults":{"windowWidth":100,"windowHeight":1080}
            });
            let normalized = normalize(&source.to_string()).unwrap();
            assert_eq!(normalized["preferences"]["language"], "zh-TW");
            assert!(normalized["preferences"].get("roleDefaults").is_none());
        });

        for (case_id, schema, role_patch, preference_patch) in [
            (
                "portable-profile-56bd19ed6e5a",
                6,
                json!({"launchPreset":"turbo"}),
                json!({"roleDefaults":{"launchPreset":"turbo"}}),
            ),
            (
                "portable-profile-f87b1dc6ef63",
                5,
                json!({"windowWidth":1280,"windowHeight":720}),
                json!({}),
            ),
            (
                "portable-profile-69f001ded109",
                6,
                json!({"launchPreset":"performance"}),
                json!({"roleDefaults":{"launchPreset":"performance"}}),
            ),
        ] {
            crate::v1_case!(case_id, {
                let mut source = fixture_value(schema);
                for (key, value) in role_patch.as_object().unwrap() {
                    source["roles"][0][key] = value.clone();
                }
                source["preferences"] = preference_patch;
                let normalized = normalize(&source.to_string()).unwrap();
                assert!(normalized["roles"][0].get("launchPreset").is_none());
                assert!(normalized["roles"][0].get("windowWidth").is_none());
                assert!(normalized["roles"][0].get("windowHeight").is_none());
                assert!(
                    normalized
                        .get("preferences")
                        .is_none_or(|preferences| preferences.get("roleDefaults").is_none())
                );
            });
        }
    }

    #[test]
    fn portable_browser_preferences_are_normalized_before_preview() {
        crate::v1_case!("portable-profile-fa211529b3fe", {
            let mut source = fixture_value(6);
            let mut settings =
                serde_json::to_value(crate::domain::default_game_browser_settings()).unwrap();
            settings["graphics"]
                .as_object_mut()
                .unwrap()
                .remove("windowsEcoQosEnabled");
            settings["fonts"]["mode"] = json!("custom");
            settings["fonts"]["families"] = json!({
                "fixed":"Bad\u{0000}Font",
                "math":"Noto Sans Math",
                "standard":"  Missing   But   Valid  Font  "
            });
            source["preferences"] = json!({"gameBrowserSettings":settings});
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/font-normalization.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            let browser_settings = preview.preferences.unwrap().game_browser_settings.unwrap();
            assert!(browser_settings.graphics.windows_eco_qos_enabled);
            let fonts = &browser_settings.fonts;
            assert_eq!(
                fonts.families.get("standard").map(String::as_str),
                Some("Missing But Valid Font")
            );
            assert_eq!(
                fonts.families.get("math").map(String::as_str),
                Some("Noto Sans Math")
            );
            assert!(!fonts.families.contains_key("fixed"));
        });
    }

    #[test]
    fn portable_browser_preferences_preserve_explicit_eco_qos_opt_out() {
        let mut browser_settings = crate::domain::default_game_browser_settings();
        browser_settings.graphics.windows_eco_qos_enabled = false;
        let exported = export(
            state_fixture(),
            Some(PortablePreferencesRecord {
                game_browser_settings: Some(browser_settings),
                language: None,
                macro_settings: None,
                theme_mode: None,
            }),
            PortableDataSelectionRecord {
                games: false,
                roles: false,
                launch_workspaces: false,
                game_windows: false,
                macros: false,
                preferences: true,
            },
            "2.0.0",
        )
        .unwrap();
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(
                &serde_json::to_string(&exported).unwrap(),
                "/tmp/eco-qos-opt-out.json".to_owned(),
                empty_snapshot(),
            )
            .unwrap();

        assert!(
            !preview
                .preferences
                .unwrap()
                .game_browser_settings
                .unwrap()
                .graphics
                .windows_eco_qos_enabled
        );
    }

    #[test]
    fn portable_role_mapping_and_shortcut_resolution_match_v1() {
        crate::v1_case!("portable-profile-33fe29268d6f", {
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &fixture(6),
                    "/tmp/remapped-role.json".to_owned(),
                    state_fixture(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    state_fixture(),
                )
                .unwrap();
            assert_eq!(prepared.snapshot.roles.len(), 1);
            assert_eq!(prepared.snapshot.roles[0].id, "r");
            assert_eq!(
                prepared.snapshot.launch_workspaces[0].slots[0]
                    .role_id
                    .as_deref(),
                Some("r")
            );
            assert_eq!(prepared.snapshot.macros.len(), 1);
            assert_eq!(prepared.snapshot.macros[0].role_ids, vec!["r"]);
        });

        crate::v1_case!("portable-profile-18b7bc217566", {
            let mut source = fixture_value(6);
            let duplicate = json!({
                "id":"r2","gameId":"g1","name":"Role",
                "launchUrl":"https://example.test/play","notes":""
            });
            source["roles"].as_array_mut().unwrap().push(duplicate);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([]);
            let mut runtime = PortableRuntime::default();
            assert_eq!(
                runtime
                    .preview(
                        &source.to_string(),
                        "/tmp/duplicate-source-role.json".to_owned(),
                        empty_snapshot(),
                    )
                    .unwrap_err()
                    .code(),
                "PORTABLE_ROLE_NAME_CONFLICT"
            );
        });

        crate::v1_case!("portable-profile-b1d7a007f597", {
            let mut snapshot = state_fixture();
            let mut duplicate = snapshot.roles[0].clone();
            duplicate.id = "r-duplicate".to_owned();
            snapshot.roles.push(duplicate);
            let before = snapshot.clone();
            let mut runtime = PortableRuntime::default();
            assert_eq!(
                runtime
                    .preview(
                        &fixture(6),
                        "/tmp/duplicate-existing-role.json".to_owned(),
                        snapshot,
                    )
                    .unwrap_err()
                    .code(),
                "PORTABLE_ROLE_NAME_CONFLICT"
            );
            assert_eq!(
                serde_json::to_value(before.clone()).unwrap(),
                serde_json::to_value(before).unwrap()
            );
        });

        crate::v1_case!("portable-profile-8e828c607960", {
            let mut source = fixture_value(6);
            source["macros"] = json!([
                {
                    "id":"first","name":"First","roleIds":["r1"],
                    "trigger":{"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"one","type":"key","code":"F1"}]
                },
                {
                    "id":"conflict","name":"Conflict","roleIds":["r1"],
                    "trigger":{"code":"F2","ctrl":false,"alt":false,"shift":false,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"two","type":"key","code":"F2"}]
                },
                {
                    "id":"reserved","name":"Reserved","roleIds":["r1"],
                    "trigger":{"code":"KeyM","ctrl":true,"alt":false,"shift":true,"meta":false},
                    "repeat":{"type":"once"},"steps":[{"id":"three","type":"key","code":"F3"}]
                }
            ]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/shortcut-conflicts.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "MACRO_SHORTCUT_CLEARED_CONFLICT"
                    && warning.item_name.as_deref() == Some("Conflict")
            }));
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "MACRO_SHORTCUT_CLEARED_RESERVED"
                    && warning.item_name.as_deref() == Some("Reserved")
            }));
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(
                prepared
                    .snapshot
                    .macros
                    .iter()
                    .find(|item| item.name == "First")
                    .unwrap()
                    .trigger
                    .is_some()
            );
            assert!(
                prepared
                    .snapshot
                    .macros
                    .iter()
                    .filter(|item| matches!(item.name.as_str(), "Conflict" | "Reserved"))
                    .all(|item| item.trigger.is_none())
            );
        });
    }

    #[test]
    fn portable_game_identity_and_recovery_match_v1() {
        crate::v1_case!("portable-profile-c5a398f580e3", {
            let mut snapshot = state_fixture();
            snapshot.games = serde_json::from_value(json!([
                {
                    "id":"builtin-flyff-universe","source":"builtin",
                    "builtinKey":"flyff-universe","name":"Flyff Universe",
                    "defaultLaunchUrl":"https://local.test/play","browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                },
                {
                    "id":"local-shared","source":"custom","name":"Shared",
                    "defaultLaunchUrl":"https://local-shared.test/play",
                    "browserLaunchMode":"inherit",
                    "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
                }
            ]))
            .unwrap();
            snapshot.roles.clear();
            snapshot.macros.clear();
            let mut source = fixture_value(2);
            source["games"] = json!([
                {
                    "id":"remote-builtin","source":"builtin","builtinKey":"flyff-universe",
                    "name":"Ignored imported name",
                    "defaultLaunchUrl":"https://override.test/play","browserLaunchMode":"external"
                },
                {
                    "id":"remote-custom","source":"custom","name":"Shared",
                    "defaultLaunchUrl":"https://remote-shared.test/play","browserLaunchMode":"inherit"
                }
            ]);
            source["roles"] = json!([
                {
                    "id":"remote-role","gameId":"remote-custom","name":"Remote",
                    "launchUrl":"https://remote-shared.test/play","notes":""
                },
                {
                    "id":"recovered-role","gameId":"missing-game","name":"Recovered",
                    "launchUrl":"https://recovery.test/custom/path","notes":""
                }
            ]);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/v2-games.json".to_owned(),
                    snapshot.clone(),
                )
                .unwrap();
            assert!(
                preview
                    .warnings
                    .iter()
                    .any(|warning| { warning.code == "BUILTIN_GAME_DEFAULTS_REPLACED" })
            );
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "ROLE_GAME_RECOVERED"
                    && warning.item_name.as_deref() == Some("Recovered")
            }));
            let prepared = runtime
                .prepare_apply(&preview.import_id, all_selection(), Vec::new(), snapshot)
                .unwrap();
            let builtin = prepared
                .snapshot
                .games
                .iter()
                .find(|game| game.builtin_key.as_deref() == Some("flyff-universe"))
                .unwrap();
            assert_eq!(builtin.default_launch_url, "https://override.test/play");
            assert!(prepared.snapshot.roles.iter().all(|role| {
                prepared
                    .snapshot
                    .games
                    .iter()
                    .any(|game| game.id == role.game_id)
            }));
        });

        crate::v1_case!("portable-profile-945173b78a01", {
            let mut source = fixture_value(2);
            source["games"] = json!([
                {
                    "id":"builtin-one","source":"builtin","builtinKey":"flyff-universe",
                    "name":"Flyff Universe","defaultLaunchUrl":"https://universe.flyff.com/play",
                    "browserLaunchMode":"inherit"
                },
                {
                    "id":"builtin-two","source":"builtin","builtinKey":"flyff-universe",
                    "name":"Flyff Universe","defaultLaunchUrl":"https://duplicate.example/play",
                    "browserLaunchMode":"inherit"
                }
            ]);
            source["roles"] = json!([{
                "id":"duplicate-role","gameId":"builtin-two","name":"Duplicate role",
                "launchUrl":"https://duplicate.example/play","notes":""
            }]);
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/duplicate-builtin.json".to_owned(),
                    empty_snapshot(),
                )
                .unwrap();
            assert!(preview.warnings.iter().any(|warning| {
                warning.code == "GAME_NAME_RENAMED"
                    && warning.replacement_name.as_deref() == Some("Flyff Universe (Imported)")
            }));
            let prepared = runtime
                .prepare_apply(
                    &preview.import_id,
                    all_selection(),
                    Vec::new(),
                    empty_snapshot(),
                )
                .unwrap();
            let imported = prepared
                .snapshot
                .games
                .iter()
                .find(|game| game.name == "Flyff Universe (Imported)")
                .unwrap();
            assert_eq!(imported.source, "custom");
            assert_eq!(
                imported.default_launch_url,
                "https://duplicate.example/play"
            );
            assert!(
                prepared
                    .snapshot
                    .roles
                    .iter()
                    .any(|role| { role.name == "Duplicate role" && role.game_id == imported.id })
            );
        });

        crate::v1_case!("portable-profile-5a22ac74c78d", {
            let mut snapshot = empty_snapshot();
            snapshot.games = serde_json::from_value(json!([{
                "id":"builtin-flyff-universe","source":"builtin",
                "builtinKey":"flyff-universe","name":"Flyff Universe",
                "defaultLaunchUrl":"https://local-override.test/play",
                "browserLaunchMode":"external",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }]))
            .unwrap();
            let mut source = fixture_value(1);
            source["roles"][0]["launchUrl"] = json!("https://universe.flyff.com/play");
            source["launchWorkspaces"] = json!([]);
            source["macros"] = json!([]);
            let mut runtime = PortableRuntime::default();
            let preview = runtime
                .preview(
                    &source.to_string(),
                    "/tmp/legacy-builtin.json".to_owned(),
                    snapshot.clone(),
                )
                .unwrap();
            let prepared = runtime
                .prepare_apply(&preview.import_id, all_selection(), Vec::new(), snapshot)
                .unwrap();
            let builtin = &prepared.snapshot.games[0];
            assert_eq!(
                builtin.default_launch_url,
                "https://local-override.test/play"
            );
        });
    }

    #[test]
    fn pending_imports_are_bounded_and_discarded_by_id() {
        let mut runtime = PortableRuntime::default();
        let mut ids = Vec::new();
        for index in 0..=MAX_PENDING_IMPORTS {
            let preview = runtime
                .preview(
                    &fixture(6),
                    format!("/tmp/import-{index}.json"),
                    empty_snapshot(),
                )
                .unwrap();
            ids.push(preview.import_id);
        }
        let first = runtime.prepare_apply(&ids[0], all_selection(), Vec::new(), empty_snapshot());
        assert!(matches!(
            first,
            Err(CoreError::Domain {
                code: "PORTABLE_IMPORT_EXPIRED",
                ..
            })
        ));
        assert!(runtime.discard(ids.last().unwrap()));
        assert!(!runtime.discard(ids.last().unwrap()));
    }

    #[test]
    fn unresolved_macro_ambiguity_requires_a_typed_resolution() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
            "games": [{
                "id":"existing-game","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles": [{
                "id":"existing-role","gameId":"existing-game","name":"Role",
                "launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "launchWorkspaces": [],
            "macros": [
                {"id":"existing-1","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["existing-role"],"repeat":{"type":"once"},"steps":[{"id":"a","type":"delay","ms":1}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
                {"id":"existing-2","enabled":true,"activationMode":"toggle","name":"Macro","roleIds":["existing-role"],"repeat":{"type":"once"},"steps":[{"id":"b","type":"delay","ms":2}],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
            ],
            "compatibilityReports": []
        }))
        .unwrap();
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(&fixture(6), "/tmp/import.json".to_owned(), snapshot.clone())
            .unwrap();
        assert_eq!(preview.conflicts.len(), 1);
        let unresolved = runtime.prepare_apply(
            &preview.import_id,
            all_selection(),
            Vec::new(),
            snapshot.clone(),
        );
        crate::v1_case!("portable-profile-f49ebbf4835b", {
            assert!(matches!(
                unresolved,
                Err(CoreError::Domain {
                    code: "PORTABLE_IMPORT_CONFLICT_UNRESOLVED",
                    ..
                })
            ));
            assert_eq!(preview.conflicts.len(), 1);
            assert_eq!(preview.conflicts[0].candidates.len(), 2);
        });

        let resolved = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                vec![PortableMacroConflictResolutionRecord::Update {
                    conflict_id: "macro:m1".to_owned(),
                    target_macro_id: "existing-2".to_owned(),
                }],
                snapshot,
            )
            .unwrap();
        assert_eq!(resolved.snapshot.macros.len(), 2);
        assert!(
            resolved
                .affected_macro_ids
                .contains(&"existing-2".to_owned())
        );
    }

    #[test]
    fn exported_macro_round_trip_is_semantically_idempotent() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
            "games": [{
                "id":"g","source":"custom","name":"Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "roles": [{
                "id":"r","gameId":"g","name":"Role","launchUrl":"https://example.test/play","notes":"",
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "launchWorkspaces": [],
            "macros": [{
                "id":"target","enabled":true,"activationMode":"toggle","name":"Target","roleIds":["r"],
                "repeat":{"type":"once"},
                "steps":[{"id":"target-delay","type":"delay","ms":1}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }, {
                "id":"source","enabled":true,"activationMode":"toggle","name":"Source","roleIds":["r"],
                "repeat":{"type":"once"},
                "steps":[
                    {"id":"key-label","type":"key","code":"Digit1","action":"tap","label":"1"},
                    {"id":"key-empty","type":"key","code":"Digit2","modifiers":[]},
                    {"id":"percent-default","type":"click","xPercent":12.5,"yPercent":-4.0},
                    {"id":"percent-explicit","type":"click","unit":"percent","anchor":"top-left","xPercent":1.0,"yPercent":2.0},
                    {"id":"pixels","type":"click","unit":"px","anchor":"center","xPx":3.0,"yPx":4.0},
                    {"id":"call-default","type":"macro","macroId":"target"},
                    {"id":"call-explicit","type":"macro","macroId":"target","callMode":"wait"}
                ],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "compatibilityReports": []
        }))
        .unwrap();
        let exported = export(snapshot.clone(), None, all_selection(), "2.0.0").unwrap();
        let raw = serde_json::to_string(&exported).unwrap();
        let mut runtime = PortableRuntime::default();
        let preview = runtime
            .preview(&raw, "/tmp/round-trip.json".to_owned(), snapshot.clone())
            .unwrap();

        assert_eq!(preview.operations.macros.unchanged, 2);
        assert_eq!(preview.operations.macros.update, 0);
        let prepared = runtime
            .prepare_apply(
                &preview.import_id,
                all_selection(),
                Vec::new(),
                snapshot.clone(),
            )
            .unwrap();
        assert!(prepared.affected_macro_ids.is_empty());
        assert_eq!(prepared.result.operations.macros.unchanged, 2);
        assert_eq!(
            serde_json::to_value(prepared.snapshot.clone()).unwrap(),
            serde_json::to_value(snapshot).unwrap()
        );
        crate::v1_case!("portable-profile-277d992999d1", {
            let source = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "source")
                .unwrap();
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Macro { macro_id, .. } if macro_id == "target"
            )));
            let target = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "target")
                .unwrap();
            assert!(matches!(target.repeat, crate::model::MacroRepeat::Once));
        });
        crate::v1_case!("portable-profile-a4e93b0bc110", {
            let source = prepared
                .snapshot
                .macros
                .iter()
                .find(|macro_record| macro_record.id == "source")
                .unwrap();
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Percent {
                        unit: Some(unit),
                        x_percent: x,
                        y_percent: y,
                    },
                    ..
                } if unit == "percent" && anchor == "top-left" && *x == 1.0 && *y == 2.0
            )));
            assert!(source.steps.iter().any(|step| matches!(
                step,
                MacroStepDefinition::Click {
                    anchor: Some(anchor),
                    position: crate::model::MacroClickDefinition::Pixels {
                        unit,
                        x_px: x,
                        y_px: y,
                    },
                    ..
                } if unit == "px" && anchor == "center" && *x == 3.0 && *y == 4.0
            )));
        });
    }

    #[test]
    fn export_is_v10_and_never_emits_internal_timestamps_or_browser_session_source() {
        let snapshot = serde_json::from_value::<CoreStateSnapshotRecord>(json!({
            "games": [{"id":"g","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}],
            "roles": [{"id":"r","gameId":"g","name":"Role","launchUrl":"https://example.test/play","notes":"","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}],
            "launchWorkspaces": [{
                "id":"w","name":"Workspace","template":"single","browserLaunchMode":"inherit",
                "browserZoomMode":"adaptive","browserZoomPercent":100,
                "slots":[{"id":"s","roleId":"r","rect":{"x":0,"y":0,"width":1,"height":1}}],
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
            }],
            "macros": [], "compatibilityReports": []
        }))
        .unwrap();
        let exported = export(snapshot, None, all_selection(), "2.0.0").unwrap();
        let value = serde_json::to_value(exported).unwrap();
        crate::v1_case!("portable-profile-3dc36f8d51a0", {
            assert_eq!(value["schemaVersion"], 10);
            assert_eq!(value["appVersion"], "2.0.0");
            for field in [
                "authState",
                "browserSessionSource",
                "browserUserDataDir",
                "createdAt",
                "lastAuthCheckAt",
                "lastSuccessfulLoginAt",
                "launchPreset",
                "updatedAt",
                "windowHeight",
                "windowWidth",
            ] {
                assert!(value["roles"][0].get(field).is_none());
            }
            assert!(value.get("gameCompatibilityReports").is_none());
        });
        assert!(value["launchWorkspaces"][0].get("resourcePolicy").is_none());
    }

    #[test]
    fn portable_files_are_atomically_replaced_and_streamed_back_into_preview() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("rion.json");
        fs::write(&path, b"old").unwrap();
        let data =
            serde_json::from_value::<PortableDataRecord>(normalize(&fixture(6)).unwrap()).unwrap();
        let selection = all_selection();

        let result = write_export(path.to_str().unwrap(), &data, &selection).unwrap();
        assert_eq!(result.file_path, path.to_string_lossy());
        assert!(!fs::read(&path).unwrap().starts_with(b"old"));
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));

        let preview = PortableRuntime::default()
            .preview_file(
                path.to_string_lossy().into_owned(),
                CoreStateSnapshotRecord::default(),
            )
            .unwrap();
        assert_eq!(preview.game_count, 1);
        assert_eq!(preview.role_count, 1);
    }

    #[test]
    fn portable_file_preview_rejects_oversized_inputs_before_reading() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("oversized.json");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_PORTABLE_BYTES + 1).unwrap();

        let error = PortableRuntime::default()
            .preview_file(
                path.to_string_lossy().into_owned(),
                CoreStateSnapshotRecord::default(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "CORE_INPUT_INVALID");
    }
}
