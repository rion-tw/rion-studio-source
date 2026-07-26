use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Map, Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    macro_graph::validate_macro_graph,
    model::BrowserGraphicsSettingsRecord,
};

const DEFAULT_LAUNCH_URL: &str = "https://universe.flyff.com/play";
const WORKSPACE_SCHEMA_VERSION: u64 = 7;

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
        launch_url: DEFAULT_LAUNCH_URL,
    },
    BuiltinGame {
        id: "builtin-feifei-infinite-universe",
        key: "feifei-infinite-universe",
        name: "飞飞：无限宇宙",
        launch_url: "https://ffcli.ruiwoo.cn",
    },
];

pub(super) fn build_snapshot(user_data_dir: &Path) -> CoreResult<Value> {
    let now = Utc::now().to_rfc3339();
    let mut games = normalize_games(read_array(user_data_dir.join("games.json"), "games")?, &now)?;
    let raw_roles = if user_data_dir.join("roles.json").is_file() {
        read_array(user_data_dir.join("roles.json"), "roles")?
    } else {
        read_array(user_data_dir.join("profiles.json"), "profiles")?
    };
    let roles = normalize_roles(raw_roles, &mut games, &now)?;
    let workspaces = normalize_workspaces(
        read_optional_object(user_data_dir.join("launch-workspaces.json"), false)?.as_ref(),
        &now,
    )?;
    let macros = normalize_macros(
        read_array(user_data_dir.join("macros.json"), "macros")?,
        &now,
    )?;
    validate_macro_graph(&macros)?;

    let game_ids = games
        .iter()
        .filter_map(|game| game.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let compatibility =
        read_lenient_array(user_data_dir.join("game-compatibility.json"), "reports")
            .into_iter()
            .filter_map(normalize_compatibility_report)
            .filter(|report| {
                report
                    .get("gameId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| game_ids.contains(id))
            })
            .collect::<Vec<_>>();

    let mut snapshot = Map::new();
    snapshot.insert("games".to_owned(), Value::Array(games));
    snapshot.insert("roles".to_owned(), Value::Array(roles));
    snapshot.insert("launchWorkspaces".to_owned(), Value::Array(workspaces));
    snapshot.insert("macros".to_owned(), Value::Array(macros));
    snapshot.insert(
        "compatibilityReports".to_owned(),
        Value::Array(compatibility),
    );
    snapshot.insert(
        "gameBrowserSettings".to_owned(),
        normalize_browser_settings(read_optional_object(
            user_data_dir.join("game-browser-settings.json"),
            true,
        )?),
    );
    snapshot.insert(
        "macroSettings".to_owned(),
        normalize_macro_settings(read_optional_object(
            user_data_dir.join("macro-settings.json"),
            true,
        )?),
    );
    snapshot.insert(
        "runtimeWindowPreferences".to_owned(),
        normalize_runtime_preferences(read_optional_object(
            user_data_dir.join("runtime-window-preferences.json"),
            true,
        )?),
    );
    if let Some(value) = normalize_legal_acceptance(read_optional_object(
        user_data_dir.join("legal-acceptance.json"),
        true,
    )?) {
        snapshot.insert("legalAcceptance".to_owned(), value);
    }
    Ok(Value::Object(snapshot))
}

pub(super) fn migrate_role_directories(user_data_dir: &Path, roles: &[Value]) -> CoreResult<()> {
    let legacy_root = user_data_dir.join("profiles");
    if !legacy_root.is_dir() {
        return Ok(());
    }
    let roles_root = user_data_dir.join("roles");
    if !roles_root.exists() {
        fs::rename(&legacy_root, &roles_root).map_err(|error| migration_io(&legacy_root, error))?;
        return Ok(());
    }
    for role in roles {
        let Some(id) = role.get("id").and_then(Value::as_str) else {
            continue;
        };
        ensure_safe_component(id)?;
        let source = legacy_root.join(id);
        let target = roles_root.join(id);
        if source.exists() && !target.exists() {
            fs::rename(&source, &target).map_err(|error| migration_io(&source, error))?;
        }
    }
    Ok(())
}

fn normalize_games(values: Vec<Value>, now: &str) -> CoreResult<Vec<Value>> {
    let mut games = values
        .iter()
        .map(|value| normalize_game(value, now))
        .collect::<CoreResult<Vec<_>>>()?;
    for builtin in BUILTIN_GAMES {
        if let Some(index) = games.iter().position(|game| {
            game.get("id").and_then(Value::as_str) == Some(builtin.id)
                || game.get("builtinKey").and_then(Value::as_str) == Some(builtin.key)
        }) {
            let object = games[index].as_object_mut().expect("normalized game");
            object.insert("id".to_owned(), json!(builtin.id));
            object.insert("source".to_owned(), json!("builtin"));
            object.insert("builtinKey".to_owned(), json!(builtin.key));
            object.insert("name".to_owned(), json!(builtin.name));
            object.remove("iconImageDataUrl");
            object.remove("coverImageDataUrl");
        } else {
            games.push(json!({
                "id": builtin.id, "source": "builtin", "builtinKey": builtin.key,
                "name": builtin.name, "defaultLaunchUrl": normalize_url(builtin.launch_url.to_owned())?,
                "browserEngine": "inherit",
                "createdAt": now, "updatedAt": now
            }));
        }
    }
    ensure_unique_ids(&games, "id", "game")?;
    let builtin_names = games
        .iter()
        .filter(|game| game.get("source").and_then(Value::as_str) == Some("builtin"))
        .filter_map(|game| game.get("name").and_then(Value::as_str))
        .map(str::to_lowercase)
        .collect::<HashSet<_>>();
    let mut used_names = HashSet::new();
    for game in &mut games {
        let object = game.as_object_mut().expect("normalized game");
        let mut name = object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if object.get("source").and_then(Value::as_str) == Some("custom")
            && builtin_names.contains(&name.to_lowercase())
        {
            name = format!("{name} (Custom)");
            object.insert("updatedAt".to_owned(), json!(now));
        }
        object.insert(
            "name".to_owned(),
            json!(unique_name(&name, &mut used_names)),
        );
    }
    Ok(games)
}

fn normalize_game(value: &Value, now: &str) -> CoreResult<Value> {
    let source = object(value, "game")?;
    let id = required_string(source, "id", "game")?;
    let builtin = BUILTIN_GAMES.iter().find(|game| {
        game.id == id || source.get("builtinKey").and_then(Value::as_str) == Some(game.key)
    });
    if builtin.is_none()
        && !matches!(
            source.get("source").and_then(Value::as_str),
            None | Some("custom")
        )
    {
        return Err(invalid("legacy game source is invalid"));
    }
    let mut output = Map::new();
    output.insert(
        "id".to_owned(),
        json!(builtin.map_or(id.as_str(), |game| game.id)),
    );
    output.insert(
        "source".to_owned(),
        json!(if builtin.is_some() {
            "builtin"
        } else {
            "custom"
        }),
    );
    output.insert(
        "name".to_owned(),
        json!(
            builtin.map_or(required_string(source, "name", "game")?, |game| game
                .name
                .to_owned())
        ),
    );
    if let Some(builtin) = builtin {
        output.insert("builtinKey".to_owned(), json!(builtin.key));
    } else {
        copy_optional_string(source, &mut output, "iconImageDataUrl");
        copy_optional_string(source, &mut output, "coverImageDataUrl");
    }
    output.insert(
        "defaultLaunchUrl".to_owned(),
        json!(normalize_url(
            optional_string(source.get("defaultLaunchUrl"))
                .unwrap_or_else(|| DEFAULT_LAUNCH_URL.to_owned())
        )?),
    );
    output.insert("browserEngine".to_owned(), json!("inherit"));
    output.insert(
        "createdAt".to_owned(),
        json!(timestamp(source.get("createdAt"), now)),
    );
    output.insert(
        "updatedAt".to_owned(),
        json!(timestamp(source.get("updatedAt"), now)),
    );
    Ok(Value::Object(output))
}

fn normalize_roles(
    values: Vec<Value>,
    games: &mut Vec<Value>,
    now: &str,
) -> CoreResult<Vec<Value>> {
    let mut roles = values
        .iter()
        .map(|value| normalize_role(value, now))
        .collect::<CoreResult<Vec<_>>>()?;
    ensure_unique_ids(&roles, "id", "role")?;
    let mut game_by_url = games
        .iter()
        .filter_map(|game| {
            Some((
                normalize_url(game.get("defaultLaunchUrl")?.as_str()?.to_owned()).ok()?,
                game.get("id")?.as_str()?.to_owned(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let mut game_ids = games
        .iter()
        .filter_map(|game| game.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<HashSet<_>>();
    let mut game_names = games
        .iter()
        .filter_map(|game| game.get("name").and_then(Value::as_str))
        .map(str::to_lowercase)
        .collect::<HashSet<_>>();
    let mut role_names = HashSet::new();
    for role in &mut roles {
        let object = role.as_object_mut().expect("normalized role");
        let launch_url = object["launchUrl"]
            .as_str()
            .unwrap_or(DEFAULT_LAUNCH_URL)
            .to_owned();
        let current = object.get("gameId").and_then(Value::as_str);
        let game_id = if current.is_some_and(|id| game_ids.contains(id)) {
            current.unwrap().to_owned()
        } else if let Some(id) = game_by_url.get(&launch_url) {
            id.clone()
        } else {
            let id = Uuid::new_v4().to_string();
            let host = Url::parse(&launch_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| "Imported Game".to_owned());
            let name = unique_name(&host, &mut game_names);
            games.push(json!({ "id": id, "source": "custom", "name": name, "defaultLaunchUrl": launch_url, "browserEngine": "inherit", "createdAt": now, "updatedAt": now }));
            game_ids.insert(id.clone());
            game_by_url.insert(launch_url.clone(), id.clone());
            id
        };
        object.insert("gameId".to_owned(), json!(game_id));
        let key = format!(
            "{}:{}",
            object["gameId"].as_str().unwrap_or_default(),
            object["name"].as_str().unwrap_or_default().to_lowercase()
        );
        if !role_names.insert(key) {
            return Err(invalid("legacy role names must be unique per game"));
        }
    }
    Ok(roles)
}

fn normalize_role(value: &Value, now: &str) -> CoreResult<Value> {
    let source = object(value, "role")?;
    let launch_url = source
        .get("launchUrl")
        .or_else(|| source.get("gameUrl"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_LAUNCH_URL)
        .trim()
        .to_owned();
    let mut output = Map::new();
    output.insert(
        "id".to_owned(),
        json!(required_string(source, "id", "role")?),
    );
    if let Some(game_id) = optional_string(source.get("gameId")) {
        output.insert("gameId".to_owned(), json!(game_id));
    }
    output.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "role")?),
    );
    output.insert("launchUrl".to_owned(), json!(normalize_url(launch_url)?));
    output.insert(
        "notes".to_owned(),
        json!(
            source
                .get("notes")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
        ),
    );
    copy_optional_string(source, &mut output, "coverImageDataUrl");
    if output.contains_key("coverImageDataUrl")
        && let Some(color) = optional_string(source.get("coverImageDominantColor"))
    {
        output.insert(
            "coverImageDominantColor".to_owned(),
            json!(color.to_uppercase()),
        );
    }
    output.insert(
        "createdAt".to_owned(),
        json!(timestamp(source.get("createdAt"), now)),
    );
    output.insert(
        "updatedAt".to_owned(),
        json!(timestamp(source.get("updatedAt"), now)),
    );
    Ok(Value::Object(output))
}

fn normalize_workspaces(file: Option<&Map<String, Value>>, now: &str) -> CoreResult<Vec<Value>> {
    let Some(file) = file else {
        return Ok(Vec::new());
    };
    let schema = file
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if schema > WORKSPACE_SCHEMA_VERSION {
        return Err(invalid(
            "legacy workspace schema is newer than supported schema 7",
        ));
    }
    let values = file
        .get("workspaces")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("legacy workspaces must be an array"))?;
    let workspaces = values
        .iter()
        .map(|value| normalize_workspace(value, now))
        .collect::<CoreResult<Vec<_>>>()?;
    ensure_unique_ids(&workspaces, "id", "workspace")?;
    ensure_unique_names(&workspaces, "workspace")?;
    Ok(workspaces)
}

fn normalize_workspace(value: &Value, now: &str) -> CoreResult<Value> {
    let source = object(value, "workspace")?;
    let template = source
        .get("template")
        .and_then(Value::as_str)
        .unwrap_or("two_columns");
    let defaults =
        default_rects(template).ok_or_else(|| invalid("legacy workspace template is invalid"))?;
    let source_slots = source
        .get("slots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if source_slots.len() > 9 {
        return Err(invalid("legacy workspace has too many slots"));
    }
    if source_slots.len() > defaults.len()
        && source_slots[defaults.len()..].iter().any(|slot| {
            slot.get("roleId")
                .or_else(|| slot.get("profileId"))
                .and_then(Value::as_str)
                .is_some_and(|id| !id.trim().is_empty())
        })
    {
        return Err(invalid("legacy workspace role is outside its layout"));
    }
    let legacy_center = template == "main_center_side_stacks"
        && source_slots.len() == 5
        && source_slots
            .iter()
            .zip(legacy_center_rects())
            .all(|(slot, expected)| {
                slot.get("rect")
                    .is_some_and(|rect| rect_matches(rect, &expected))
            });
    let mut seen_roles = HashSet::new();
    let slots = defaults
        .iter()
        .enumerate()
        .map(|(index, fallback)| {
            normalize_workspace_slot(
                source_slots.get(index),
                index,
                fallback,
                legacy_center,
                &mut seen_roles,
            )
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let zoom = source
        .get("browserZoomPercent")
        .and_then(Value::as_u64)
        .unwrap_or(100);
    if !matches!(zoom, 25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125) {
        return Err(invalid("legacy workspace browser zoom is invalid"));
    }
    let mut output = Map::new();
    output.insert(
        "id".to_owned(),
        json!(optional_string(source.get("id")).unwrap_or_else(|| Uuid::new_v4().to_string())),
    );
    output.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "workspace")?),
    );
    output.insert("template".to_owned(), json!(template));
    output.insert("browserEngine".to_owned(), json!("system"));
    output.insert(
        "browserZoomMode".to_owned(),
        json!(
            match source.get("browserZoomMode").and_then(Value::as_str) {
                None | Some("adaptive") => "adaptive",
                Some("fixed") => "fixed",
                _ => return Err(invalid("legacy workspace browser zoom mode is invalid")),
            }
        ),
    );
    output.insert("browserZoomPercent".to_owned(), json!(zoom));
    if let Some(target) = normalize_target_display(source)? {
        output.insert("targetDisplay".to_owned(), target);
    }
    output.insert("slots".to_owned(), Value::Array(slots));
    output.insert(
        "createdAt".to_owned(),
        json!(timestamp(source.get("createdAt"), now)),
    );
    output.insert(
        "updatedAt".to_owned(),
        json!(timestamp(source.get("updatedAt"), now)),
    );
    Ok(Value::Object(output))
}

fn normalize_workspace_slot(
    value: Option<&Value>,
    index: usize,
    fallback: &Value,
    force_default: bool,
    seen_roles: &mut HashSet<String>,
) -> CoreResult<Value> {
    let source = value.and_then(Value::as_object);
    let role_id = source
        .and_then(|source| source.get("roleId").or_else(|| source.get("profileId")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if role_id
        .as_ref()
        .is_some_and(|id| !seen_roles.insert(id.clone()))
    {
        return Err(invalid("legacy workspace role assignments are duplicated"));
    }
    let rect = if force_default {
        fallback.clone()
    } else if let Some(rect) = source.and_then(|source| source.get("rect")) {
        normalize_rect(rect)?
    } else {
        fallback.clone()
    };
    let mut output = Map::new();
    output.insert(
        "id".to_owned(),
        json!(
            source
                .and_then(|source| optional_string(source.get("id")))
                .unwrap_or_else(|| format!("slot-{}", index + 1))
        ),
    );
    if let Some(role_id) = role_id {
        output.insert("roleId".to_owned(), json!(role_id));
        if let Some(zoom) = source
            .and_then(|source| source.get("browserZoomPercent"))
            .and_then(Value::as_u64)
        {
            if !(50..=300).contains(&zoom) {
                return Err(invalid("legacy workspace slot zoom is invalid"));
            }
            output.insert("browserZoomPercent".to_owned(), json!(zoom));
        }
    }
    output.insert("rect".to_owned(), rect);
    Ok(Value::Object(output))
}

fn normalize_macros(values: Vec<Value>, now: &str) -> CoreResult<Vec<Value>> {
    let macros = values
        .iter()
        .map(|value| normalize_macro(value, now))
        .collect::<CoreResult<Vec<_>>>()?;
    ensure_unique_ids(&macros, "id", "macro")?;
    Ok(macros)
}

fn normalize_macro(value: &Value, now: &str) -> CoreResult<Value> {
    let source = object(value, "macro")?;
    let role_ids_value = source
        .get("roleIds")
        .cloned()
        .or_else(|| source.get("roleId").cloned().map(|id| json!([id])))
        .or_else(|| source.get("profileId").cloned().map(|id| json!([id])))
        .ok_or_else(|| invalid("legacy macro role assignment is invalid"))?;
    let mut role_ids = role_ids_value
        .as_array()
        .ok_or_else(|| invalid("legacy macro role assignment is invalid"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid("legacy macro role assignment is invalid"))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    let mut unique_roles = HashSet::new();
    role_ids.retain(|id| unique_roles.insert(id.clone()));
    let mut activation_mode = source
        .get("activationMode")
        .and_then(Value::as_str)
        .unwrap_or("toggle");
    if !matches!(activation_mode, "toggle" | "while_held") {
        return Err(invalid("legacy macro activation mode is invalid"));
    }
    let mut trigger = source
        .get("trigger")
        .filter(|value| !value.is_null())
        .map(normalize_trigger)
        .transpose()?;
    if trigger.as_ref().is_some_and(is_reserved_macro_trigger) {
        trigger = None;
        if activation_mode == "while_held" {
            activation_mode = "toggle";
        }
    }
    if activation_mode == "while_held" && trigger.is_none() {
        return Err(invalid("legacy while-held macro requires a trigger"));
    }
    let source_steps = source
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty() && steps.len() <= 100)
        .ok_or_else(|| invalid("legacy macro steps are invalid"))?;
    let mut step_ids = HashSet::new();
    let steps = source_steps
        .iter()
        .map(|step| normalize_macro_step(step, &mut step_ids))
        .collect::<CoreResult<Vec<_>>>()?;
    let repeat = match source.get("repeat").and_then(Value::as_object) {
        None => json!({ "type": "once" }),
        Some(repeat) if repeat.get("type").and_then(Value::as_str) == Some("once") => {
            json!({ "type": "once" })
        }
        Some(repeat) if repeat.get("type").and_then(Value::as_str) == Some("loop") => {
            let interval = repeat
                .get("intervalMs")
                .and_then(Value::as_u64)
                .filter(|value| *value <= 86_400_000)
                .ok_or_else(|| invalid("legacy macro repeat interval is invalid"))?;
            json!({ "type": "loop", "intervalMs": interval })
        }
        _ => return Err(invalid("legacy macro repeat is invalid")),
    };
    let mut output = Map::new();
    output.insert(
        "id".to_owned(),
        json!(optional_string(source.get("id")).unwrap_or_else(|| Uuid::new_v4().to_string())),
    );
    output.insert(
        "enabled".to_owned(),
        json!(
            source
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    output.insert("activationMode".to_owned(), json!(activation_mode));
    output.insert(
        "name".to_owned(),
        json!(required_string(source, "name", "macro")?),
    );
    output.insert("roleIds".to_owned(), json!(role_ids));
    if let Some(trigger) = trigger {
        output.insert("trigger".to_owned(), trigger);
    }
    output.insert("repeat".to_owned(), repeat);
    output.insert("steps".to_owned(), Value::Array(steps));
    output.insert(
        "createdAt".to_owned(),
        json!(timestamp(source.get("createdAt"), now)),
    );
    output.insert(
        "updatedAt".to_owned(),
        json!(timestamp(source.get("updatedAt"), now)),
    );
    Ok(Value::Object(output))
}

fn normalize_macro_step(value: &Value, ids: &mut HashSet<String>) -> CoreResult<Value> {
    let source = object(value, "macro step")?;
    let mut id = optional_string(source.get("id")).unwrap_or_else(|| Uuid::new_v4().to_string());
    if !ids.insert(id.clone()) {
        id = Uuid::new_v4().to_string();
        ids.insert(id.clone());
    }
    match source.get("type").and_then(Value::as_str) {
        Some("key") => {
            let action = source
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("tap");
            if !matches!(action, "tap" | "hold_until_stop") {
                return Err(invalid("legacy macro key action is invalid"));
            }
            let modifiers = source
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .filter(|modifier| {
                                    matches!(
                                        *modifier,
                                        "primary" | "ctrl" | "alt" | "shift" | "meta"
                                    )
                                })
                                .map(str::to_owned)
                                .ok_or_else(|| invalid("legacy macro key modifier is invalid"))
                        })
                        .collect::<CoreResult<Vec<_>>>()
                })
                .transpose()?
                .unwrap_or_default();
            let label = source
                .get("label")
                .map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|label| !label.is_empty())
                        .map(|label| label.chars().take(48).collect::<String>())
                        .ok_or_else(|| invalid("legacy macro key label is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("key")),
                (
                    "code".to_owned(),
                    json!(required_string(source, "code", "macro key step")?),
                ),
                ("action".to_owned(), json!(action)),
            ]);
            if !modifiers.is_empty() {
                step.insert("modifiers".to_owned(), json!(modifiers));
            }
            if let Some(label) = label {
                step.insert("label".to_owned(), json!(label));
            }
            Ok(Value::Object(step))
        }
        Some("click") => {
            let unit = source
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("percent");
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
                        .ok_or_else(|| invalid("legacy macro click anchor is invalid"))
                })
                .transpose()?;
            let mut step = Map::from_iter([
                ("id".to_owned(), json!(id)),
                ("type".to_owned(), json!("click")),
            ]);
            if let Some(anchor) = anchor.filter(|anchor| anchor != "top-left") {
                step.insert("anchor".to_owned(), json!(anchor));
            }
            if unit == "px" {
                step.insert("unit".to_owned(), json!("px"));
                step.insert(
                    "xPx".to_owned(),
                    json!(finite_number(source, "xPx")?.round()),
                );
                step.insert(
                    "yPx".to_owned(),
                    json!(finite_number(source, "yPx")?.round()),
                );
                Ok(Value::Object(step))
            } else if unit == "percent" {
                step.insert(
                    "xPercent".to_owned(),
                    json!(normalize_macro_percent(source, "xPercent")?),
                );
                step.insert(
                    "yPercent".to_owned(),
                    json!(normalize_macro_percent(source, "yPercent")?),
                );
                Ok(Value::Object(step))
            } else {
                Err(invalid("legacy macro click unit is invalid"))
            }
        }
        Some("delay") => Ok(json!({
            "id": id, "type": "delay",
            "ms": source.get("ms").and_then(Value::as_u64).filter(|value| *value <= 86_400_000).ok_or_else(|| invalid("legacy macro delay is invalid"))?
        })),
        Some("macro") => {
            let call_mode = source
                .get("callMode")
                .and_then(Value::as_str)
                .unwrap_or("wait");
            if !matches!(call_mode, "wait" | "trigger") {
                return Err(invalid("legacy macro call mode is invalid"));
            }
            Ok(json!({
                "id": id, "type": "macro",
                "macroId": required_string(source, "macroId", "macro call step")?,
                "callMode": call_mode
            }))
        }
        _ => Err(invalid("legacy macro step type is invalid")),
    }
}

fn normalize_trigger(value: &Value) -> CoreResult<Value> {
    let source = object(value, "macro trigger")?;
    Ok(json!({
        "code": required_string(source, "code", "macro trigger")?,
        "ctrl": source.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
        "alt": source.get("alt").and_then(Value::as_bool).unwrap_or(false),
        "shift": source.get("shift").and_then(Value::as_bool).unwrap_or(false),
        "meta": source.get("meta").and_then(Value::as_bool).unwrap_or(false)
    }))
}

fn is_reserved_macro_trigger(value: &Value) -> bool {
    let Some(trigger) = value.as_object() else {
        return false;
    };
    let code = trigger.get("code").and_then(Value::as_str).unwrap_or("");
    let ctrl = trigger
        .get("ctrl")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alt = trigger.get("alt").and_then(Value::as_bool).unwrap_or(false);
    let shift = trigger
        .get("shift")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let meta = trigger
        .get("meta")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let overlay = code == "KeyM" && ctrl && shift && !alt && !meta;
    let tab_switch = code == "Tab" && ctrl && !alt && !meta;
    let primary_only = !alt && ctrl != meta;
    let zoom = primary_only
        && (matches!(code, "Equal" | "Plus" | "NumpadAdd")
            || (!shift && matches!(code, "Minus" | "NumpadSubtract" | "Digit0" | "Numpad0")));
    overlay || tab_switch || zoom
}

fn normalize_browser_settings(value: Option<Map<String, Value>>) -> Value {
    let source = value.unwrap_or_default();
    let fonts = source.get("fonts").and_then(Value::as_object);
    let font_mode = fonts
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "default" | "custom"))
        .unwrap_or("default");
    let mut families = Map::new();
    if font_mode == "custom"
        && let Some(input) = fonts
            .and_then(|value| value.get("families"))
            .and_then(Value::as_object)
    {
        for key in ["standard", "serif", "sansserif", "fixed", "math"] {
            if let Some(value) = input
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 120)
            {
                families.insert(key.to_owned(), json!(value));
            }
        }
    }
    let graphics_mode = source
        .get("graphics")
        .and_then(Value::as_object)
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "automatic" | "high_performance" | "experimental"))
        .unwrap_or("automatic");
    let graphics = BrowserGraphicsSettingsRecord::from_legacy_mode(graphics_mode);
    let network = source.get("network").and_then(Value::as_object);
    let proxy_input = network
        .and_then(|value| value.get("proxy"))
        .and_then(Value::as_object);
    let proxy_mode = proxy_input
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str);
    let proxy_server = proxy_input
        .and_then(|value| value.get("server"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| value.len() <= 200)
        .unwrap_or("");
    let proxy = if proxy_mode == Some("custom")
        && Url::parse(proxy_server)
            .ok()
            .is_some_and(|url| matches!(url.scheme(), "http" | "https" | "socks4" | "socks5"))
    {
        json!({ "mode": "custom", "server": proxy_server })
    } else {
        json!({ "mode": "system", "server": "" })
    };
    let workspace = source.get("workspace").and_then(Value::as_object);
    let background = workspace
        .and_then(|value| value.get("background"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "material" | "black"))
        .unwrap_or("material");
    let gap = workspace
        .and_then(|value| value.get("gap"))
        .and_then(Value::as_u64)
        .filter(|value| matches!(*value, 1 | 2 | 4 | 6 | 8 | 12 | 16))
        .unwrap_or(4);
    let badge = source.get("macroBadgePosition").and_then(Value::as_object);
    let horizontal_align = badge
        .and_then(|value| value.get("horizontalAlign").or_else(|| value.get("x")))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "left" | "center" | "right"))
        .unwrap_or("center");
    let horizontal_margin_px = badge
        .and_then(|value| value.get("horizontalMarginPx"))
        .and_then(Value::as_u64)
        .filter(|value| *value <= 128 && value.is_multiple_of(8))
        .unwrap_or(8);
    let top_px = badge
        .and_then(|value| value.get("topPx"))
        .and_then(Value::as_u64)
        .filter(|value| *value <= 320 && value.is_multiple_of(8))
        .unwrap_or(128);
    json!({
        "fonts": { "families": families, "mode": font_mode },
        "graphics": graphics,
        "browserEngine": "system",
        "macroBadgePosition": {
            "horizontalAlign": horizontal_align,
            "horizontalMarginPx": horizontal_margin_px,
            "topPx": top_px
        },
        "network": { "proxy": proxy },
        "workspace": { "background": background, "gap": gap }
    })
}

fn normalize_macro_settings(value: Option<Map<String, Value>>) -> Value {
    let source = value.unwrap_or_default();
    let number = |key: &str, default: u64, min: u64, max: u64| {
        source
            .get(key)
            .and_then(Value::as_u64)
            .filter(|value| (*value >= min) && (*value <= max))
            .unwrap_or(default)
    };
    json!({
        "startupDelayMs": number("startupDelayMs", 100, 0, 10_000),
        "keyHoldMs": number("keyHoldMs", 30, 20, 1_000),
        "postInputDelayMs": number("postInputDelayMs", 30, 10, 1_000),
        "defaultLoopDelayMs": number("defaultLoopDelayMs", 1_000, 0, 86_400_000)
    })
}

fn normalize_runtime_preferences(value: Option<Map<String, Value>>) -> Value {
    json!({
        "alwaysShowToolbarInFullScreen": value
            .as_ref()
            .and_then(|source| source.get("alwaysShowToolbarInFullScreen"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

fn normalize_legal_acceptance(value: Option<Map<String, Value>>) -> Option<Value> {
    let source = value?;
    if source.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    for key in [
        "acceptedAt",
        "acceptedFairUseVersion",
        "acceptedTermsVersion",
        "acknowledgedPrivacyVersion",
    ] {
        optional_string(source.get(key))?;
    }
    Some(Value::Object(source))
}

fn normalize_compatibility_report(value: Value) -> Option<Value> {
    let mut source = value.as_object()?.clone();
    optional_string(source.get("gameId"))?;
    let observations = source.get_mut("observations")?.as_object_mut()?;
    observations.remove("lastAuthSuccessAt");
    observations.remove("lastAuthFailureAt");
    source.insert("isStale".to_owned(), Value::Bool(false));
    Some(Value::Object(source))
}

fn normalize_target_display(source: &Map<String, Value>) -> CoreResult<Option<Value>> {
    if let Some(target) = source.get("targetDisplay") {
        if target.is_null() {
            return Ok(None);
        }
        let target = object(target, "workspace target display")?;
        let id = target
            .get("id")
            .and_then(Value::as_i64)
            .filter(|id| *id != -1)
            .ok_or_else(|| invalid("legacy workspace target display is invalid"))?;
        let mut output = Map::new();
        output.insert("id".to_owned(), json!(id));
        if let Some(fingerprint) = target.get("fingerprint").filter(|value| value.is_object()) {
            output.insert("fingerprint".to_owned(), fingerprint.clone());
        }
        return Ok(Some(Value::Object(output)));
    }
    match source.get("targetDisplayId") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let id = value
                .as_i64()
                .filter(|id| *id != -1)
                .ok_or_else(|| invalid("legacy workspace target display is invalid"))?;
            Ok(Some(json!({ "id": id })))
        }
    }
}

fn default_rects(template: &str) -> Option<Vec<Value>> {
    let equal_columns = |count: usize| {
        (0..count)
            .map(|index| {
                json!({ "x": index as f64 / count as f64, "y": 0, "width": 1.0 / count as f64, "height": 1 })
            })
            .collect()
    };
    let grid = |columns: usize, rows: usize| {
        (0..columns * rows)
            .map(|index| {
                json!({ "x": (index % columns) as f64 / columns as f64, "y": (index / columns) as f64 / rows as f64, "width": 1.0 / columns as f64, "height": 1.0 / rows as f64 })
            })
            .collect()
    };
    Some(match template {
        "single" => vec![json!({ "x": 0, "y": 0, "width": 1, "height": 1 })],
        "two_columns" => equal_columns(2),
        "three_columns" => equal_columns(3),
        "main_left_stack_right" => vec![
            json!({"x":0,"y":0,"width":0.5,"height":1}),
            json!({"x":0.5,"y":0,"width":0.5,"height":0.5}),
            json!({"x":0.5,"y":0.5,"width":0.5,"height":0.5}),
        ],
        "main_right_stack_left" => vec![
            json!({"x":0.5,"y":0,"width":0.5,"height":1}),
            json!({"x":0,"y":0,"width":0.5,"height":0.5}),
            json!({"x":0,"y":0.5,"width":0.5,"height":0.5}),
        ],
        "main_center_side_stacks" => vec![
            json!({"x":0.3,"y":0,"width":0.4,"height":1}),
            json!({"x":0,"y":0,"width":0.3,"height":0.5}),
            json!({"x":0,"y":0.5,"width":0.3,"height":0.5}),
            json!({"x":0.7,"y":0,"width":0.3,"height":0.5}),
            json!({"x":0.7,"y":0.5,"width":0.3,"height":0.5}),
        ],
        "three_top_two_bottom" => split_rows(3, 2),
        "two_top_three_bottom" => split_rows(2, 3),
        "quad" => grid(2, 2),
        "four_columns" => equal_columns(4),
        "six_grid" => grid(3, 2),
        "eight_grid" => grid(4, 2),
        "nine_grid" => grid(3, 3),
        _ => return None,
    })
}

fn split_rows(top: usize, bottom: usize) -> Vec<Value> {
    (0..top)
        .map(|index| {
            json!({ "x": index as f64 / top as f64, "y": 0, "width": 1.0 / top as f64, "height": 0.5 })
        })
        .chain((0..bottom).map(|index| {
            json!({ "x": index as f64 / bottom as f64, "y": 0.5, "width": 1.0 / bottom as f64, "height": 0.5 })
        }))
        .collect()
}

fn legacy_center_rects() -> Vec<Value> {
    vec![
        json!({"x":0.25,"y":0,"width":0.5,"height":1}),
        json!({"x":0,"y":0,"width":0.25,"height":0.5}),
        json!({"x":0,"y":0.5,"width":0.25,"height":0.5}),
        json!({"x":0.75,"y":0,"width":0.25,"height":0.5}),
        json!({"x":0.75,"y":0.5,"width":0.25,"height":0.5}),
    ]
}

fn rect_matches(value: &Value, expected: &Value) -> bool {
    ["x", "y", "width", "height"].iter().all(|key| {
        value.get(key).and_then(Value::as_f64) == expected.get(key).and_then(Value::as_f64)
    })
}

fn normalize_rect(value: &Value) -> CoreResult<Value> {
    let source = object(value, "workspace rectangle")?;
    let read = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .ok_or_else(|| invalid("legacy workspace rectangle is invalid"))
    };
    let (x, y, width, height) = (read("x")?, read("y")?, read("width")?, read("height")?);
    if width < 0.12 || height < 0.12 || x + width > 1.0001 || y + height > 1.0001 {
        return Err(invalid("legacy workspace rectangle is invalid"));
    }
    Ok(json!({ "x": x, "y": y, "width": width, "height": height }))
}

fn read_array(path: PathBuf, key: &str) -> CoreResult<Vec<Value>> {
    let Some(object) = read_optional_object(path, false)? else {
        return Ok(Vec::new());
    };
    object
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| invalid(format!("legacy {key} must be an array")))
}

fn read_lenient_array(path: PathBuf, key: &str) -> Vec<Value> {
    read_optional_object(path, true)
        .ok()
        .flatten()
        .and_then(|object| object.get(key).and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn read_optional_object(path: PathBuf, lenient: bool) -> CoreResult<Option<Map<String, Value>>> {
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(migration_io(&path, error)),
    };
    match serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
    {
        Some(value) => Ok(Some(value)),
        None if lenient => Ok(None),
        None => Err(invalid(format!(
            "legacy file is invalid: {}",
            path.display()
        ))),
    }
}

fn object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("legacy {label} must be an object")))
}

fn required_string(object: &Map<String, Value>, key: &str, label: &str) -> CoreResult<String> {
    optional_string(object.get(key))
        .ok_or_else(|| invalid(format!("legacy {label} requires {key}")))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn timestamp(value: Option<&Value>, fallback: &str) -> String {
    optional_string(value).unwrap_or_else(|| fallback.to_owned())
}

fn normalize_url(value: String) -> CoreResult<String> {
    let url = Url::parse(value.trim()).map_err(|_| invalid("legacy URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid("legacy URL is invalid"));
    }
    Ok(url.to_string())
}

fn copy_optional_string(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = optional_string(source.get(key)) {
        target.insert(key.to_owned(), json!(value));
    }
}

fn finite_number(object: &Map<String, Value>, key: &str) -> CoreResult<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("legacy {key} is invalid")))
}

fn normalize_macro_percent(object: &Map<String, Value>, key: &str) -> CoreResult<f64> {
    let value = finite_number(object, key)?;
    if !(-100.0..=100.0).contains(&value) {
        return Err(invalid(format!("legacy {key} is invalid")));
    }
    Ok((value * 100.0).round() / 100.0)
}

fn unique_name(base: &str, used: &mut HashSet<String>) -> String {
    for index in 1..=10_000 {
        let candidate = if index == 1 {
            base.to_owned()
        } else {
            format!("{base} {index}")
        };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    format!("Imported Game {}", Uuid::new_v4())
}

fn ensure_unique_ids(values: &[Value], key: &str, label: &str) -> CoreResult<()> {
    let mut ids = HashSet::new();
    for value in values {
        let id = value
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(format!("legacy {label} id is invalid")))?;
        if !ids.insert(id) {
            return Err(invalid(format!("legacy {label} ids are duplicated")));
        }
    }
    Ok(())
}

fn ensure_unique_names(values: &[Value], label: &str) -> CoreResult<()> {
    let mut names = HashSet::new();
    for value in values {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        if !names.insert(name) {
            return Err(invalid(format!("legacy {label} names are duplicated")));
        }
    }
    Ok(())
}

fn ensure_safe_component(value: &str) -> CoreResult<()> {
    if !is_safe_component(value) {
        return Err(CoreError::Migration(
            "legacy role data contains an unsafe path component".to_owned(),
        ));
    }
    Ok(())
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn migration_io(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Migration(format!("migration failed for {}: {error}", path.display()))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Migration(message.into())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use crate::database::state;

    use super::*;

    #[test]
    fn migrates_workspace_schemas_zero_through_seven_and_old_macro_fields() {
        for schema in 0..=7 {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("profiles.json"),
                r#"{"profiles":[{"id":"r1","name":"Role","gameUrl":"https://example.test/play","launchPreset":"legacy"}]}"#,
            )
            .unwrap();
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({ "schemaVersion": schema, "workspaces": [{ "id": "w1", "name": "Workspace", "slots": [{ "profileId": "r1" }] }] }).to_string(),
            )
            .unwrap();
            fs::write(
                directory.path().join("macros.json"),
                r#"{"macros":[{"id":"m1","name":"Macro","profileId":"r1","steps":[{"type":"key","code":"KeyA","label":"A"},{"type":"click","xPercent":12.5,"yPercent":-4}]}]}"#,
            )
            .unwrap();

            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(snapshot["launchWorkspaces"][0]["template"], "two_columns");
            assert_eq!(snapshot["launchWorkspaces"][0]["slots"][0]["roleId"], "r1");
            assert_eq!(snapshot["macros"][0]["enabled"], true);
            assert_eq!(snapshot["macros"][0]["steps"][0]["action"], "tap");
            assert_eq!(snapshot["macros"][0]["steps"][0]["label"], "A");
            assert!(snapshot["macros"][0]["steps"][0].get("modifiers").is_none());
            assert!(snapshot["macros"][0]["steps"][1].get("unit").is_none());
            assert!(snapshot["macros"][0]["steps"][1].get("anchor").is_none());
            assert!(!snapshot["roles"][0]["gameId"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn corrupt_optional_settings_use_defaults_and_future_workspace_schema_fails() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("game-browser-settings.json"), "{").unwrap();
        fs::write(
            directory.path().join("macro-settings.json"),
            r#"{"keyHoldMs":1}"#,
        )
        .unwrap();
        let snapshot = build_snapshot(directory.path()).unwrap();
        assert_eq!(snapshot["gameBrowserSettings"]["browserEngine"], "system");
        assert!(snapshot["gameBrowserSettings"].get("launchMode").is_none());
        assert_eq!(
            snapshot["gameBrowserSettings"]["macroBadgePosition"],
            json!({
                "horizontalAlign": "center",
                "horizontalMarginPx": 8,
                "topPx": 128
            })
        );
        assert_eq!(snapshot["macroSettings"]["keyHoldMs"], 30);

        fs::write(
            directory.path().join("launch-workspaces.json"),
            r#"{"schemaVersion":8,"workspaces":[]}"#,
        )
        .unwrap();
        assert!(build_snapshot(directory.path()).is_err());
    }

    #[test]
    fn legacy_scalar_and_background_activity_migrations_match_v1() {
        crate::v1_case!("state-migration-4c4b53674424", {
            let settings = normalize_browser_settings(Some(
                json!({
                    "fonts":{"mode":"default","families":{}},
                    "graphics":{"mode":"automatic"},
                    "launchMode":"auto"
                })
                .as_object()
                .unwrap()
                .clone(),
            ));
            assert_eq!(
                settings["workspace"],
                json!({"background":"material","gap":4})
            );
        });

        crate::v1_case!("state-migration-7fbe9235593b", {
            assert_eq!(
                normalize_runtime_preferences(None),
                json!({"alwaysShowToolbarInFullScreen":false})
            );
            assert_eq!(
                normalize_runtime_preferences(Some(
                    json!({"alwaysShowToolbarInFullScreen":"yes"})
                        .as_object()
                        .unwrap()
                        .clone()
                )),
                json!({"alwaysShowToolbarInFullScreen":false})
            );
            assert_eq!(
                normalize_runtime_preferences(Some(
                    json!({"alwaysShowToolbarInFullScreen":true})
                        .as_object()
                        .unwrap()
                        .clone()
                )),
                json!({"alwaysShowToolbarInFullScreen":true})
            );
        });

        crate::v1_case!("state-migration-edf454eef094", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("games.json"),
                r#"{"games":[{"id":"g1","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit","windowWidth":1280,"windowHeight":720,"launchPreset":"legacy","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"#,
            )
            .unwrap();
            fs::write(
                directory.path().join("roles.json"),
                r#"{"roles":[{"id":"r1","gameId":"g1","name":"Role","launchUrl":"https://example.test/play","launchPreset":"legacy","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"#,
            )
            .unwrap();
            let first = build_snapshot(directory.path()).unwrap();
            let second = build_snapshot(directory.path()).unwrap();
            for collection in ["games", "roles"] {
                assert!(
                    first[collection][0].get("launchPreset").is_none(),
                    "{collection} launch preset was not removed"
                );
                assert_eq!(first[collection][0], second[collection][0]);
            }
        });

        crate::v1_case!("state-migration-1600a563ad57", {
            let directory = tempdir().unwrap();
            let invalid = r#"{"games":[{"id":"g1","name":"Invalid URL","defaultLaunchUrl":"not-a-url","launchPreset":"legacy"}]}"#;
            fs::write(directory.path().join("games.json"), invalid).unwrap();
            assert!(build_snapshot(directory.path()).is_err());
            assert_eq!(
                fs::read_to_string(directory.path().join("games.json")).unwrap(),
                invalid
            );
            fs::write(directory.path().join("games.json"), r#"{"games":[]}"#).unwrap();
            let retry = build_snapshot(directory.path()).unwrap();
            assert!(retry["games"].as_array().unwrap().len() >= BUILTIN_GAMES.len());
        });
    }

    #[test]
    fn legacy_game_migrations_match_v1() {
        crate::v1_case!("state-migration-4ade1c3ece0b", {
            let directory = tempdir().unwrap();
            let seeded = build_snapshot(directory.path()).unwrap();
            assert_eq!(
                seeded["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|game| game["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["builtin-flyff-universe", "builtin-feifei-infinite-universe"]
            );
            assert!(
                seeded["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|game| game["source"] == "builtin")
            );

            let flyff = seeded["games"][0].clone();
            fs::write(
                directory.path().join("games.json"),
                json!({
                    "games": [
                        {
                            "id": "tampered",
                            "source": "custom",
                            "builtinKey": flyff["builtinKey"],
                            "name": "Tampered",
                            "defaultLaunchUrl": flyff["defaultLaunchUrl"],
                            "browserLaunchMode": flyff["browserLaunchMode"],
                            "iconImageDataUrl": "data:image/png;base64,QQ==",
                            "coverImageDataUrl": "data:image/webp;base64,QQ==",
                            "createdAt": flyff["createdAt"],
                            "updatedAt": flyff["updatedAt"]
                        },
                        seeded["games"][1].clone()
                    ]
                })
                .to_string(),
            )
            .unwrap();
            let repaired = build_snapshot(directory.path()).unwrap();
            assert_eq!(repaired["games"][0]["id"], json!("builtin-flyff-universe"));
            assert_eq!(repaired["games"][0]["name"], json!("Flyff Universe"));
            assert_eq!(repaired["games"][0]["source"], json!("builtin"));
            assert!(repaired["games"][0].get("iconImageDataUrl").is_none());
            assert!(repaired["games"][0].get("coverImageDataUrl").is_none());
        });

        crate::v1_case!("state-migration-80142638feba", {
            let directory = tempdir().unwrap();
            let timestamp = "2026-07-10T00:00:00.000Z";
            fs::write(
                directory.path().join("games.json"),
                json!({
                    "games": [{
                        "id": "game-1",
                        "source": "custom",
                        "name": "Performance defaults",
                        "defaultLaunchUrl": "https://example.test/performance",
                        "browserLaunchMode": "inherit",
                        "roleDefaults": {
                            "windowWidth": 1280,
                            "windowHeight": 720,
                            "launchPreset": "performance"
                        },
                        "createdAt": timestamp,
                        "updatedAt": timestamp
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let game = build_snapshot(directory.path()).unwrap()["games"][0].clone();
            assert_eq!(game["createdAt"], timestamp);
            assert_eq!(game["updatedAt"], timestamp);
            assert!(game.get("roleDefaults").is_none());
            assert!(!game.to_string().contains("launchPreset"));
        });

        crate::v1_case!("state-migration-e921eee58933", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("games.json"),
                json!({
                    "games": [{
                        "id": "game-1",
                        "source": "custom",
                        "name": "Legacy login URL",
                        "defaultLaunchUrl": "https://example.test/game",
                        "loginUrl": "https://example.test/login",
                        "createdAt": "2026-07-10T00:00:00.000Z",
                        "updatedAt": "2026-07-10T00:00:00.000Z"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(
                snapshot["games"][0]["defaultLaunchUrl"],
                "https://example.test/game"
            );
            assert!(snapshot["games"][0].get("loginUrl").is_none());
            assert!(!snapshot.to_string().contains("loginUrl"));
        });

        crate::v1_case!("state-migration-37540089443b", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("games.json"),
                json!({
                    "games": [{
                        "id": "game-1",
                        "source": "custom",
                        "name": "Invalid stored defaults",
                        "defaultLaunchUrl": "https://example.test/invalid",
                        "roleDefaults": {
                            "windowWidth": 100,
                            "windowHeight": 900,
                            "launchPreset": "turbo"
                        },
                        "createdAt": "2026-07-10T00:00:00.000Z",
                        "updatedAt": "2026-07-10T00:00:00.000Z"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(snapshot["games"][0]["name"], "Invalid stored defaults");
            assert!(snapshot["games"][0].get("roleDefaults").is_none());
            assert!(!snapshot.to_string().contains("launchPreset"));
        });

        crate::v1_case!("state-migration-d5f293f55a7f", {
            let directory = tempdir().unwrap();
            let timestamp = "2026-07-10T00:00:00.000Z";
            fs::write(
                directory.path().join("roles.json"),
                json!({
                    "roles": [
                        {
                            "id": "known",
                            "gameId": "legacy-missing",
                            "name": "Known",
                            "launchUrl": "https://universe.flyff.com/play",
                            "createdAt": timestamp,
                            "updatedAt": timestamp
                        },
                        {
                            "id": "unknown",
                            "gameId": "legacy-missing",
                            "name": "Unknown",
                            "launchUrl": "https://example.test/game",
                            "createdAt": timestamp,
                            "updatedAt": timestamp
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
            let first = build_snapshot(directory.path()).unwrap();
            let known = first["roles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|role| role["id"] == "known")
                .unwrap();
            let unknown = first["roles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|role| role["id"] == "unknown")
                .unwrap();
            assert_eq!(known["gameId"], "builtin-flyff-universe");
            assert!(known.get("browserSessionSource").is_none());
            assert!(known.get("browserEnginePin").is_none());
            assert_eq!(known["createdAt"], timestamp);
            assert_eq!(known["updatedAt"], timestamp);
            let unknown_game_id = unknown["gameId"].as_str().unwrap();
            assert!(first["games"].as_array().unwrap().iter().any(|game| {
                game["id"] == unknown_game_id
                    && game["defaultLaunchUrl"] == "https://example.test/game"
            }));

            let mut connection = Connection::open_in_memory().unwrap();
            state::create_schema(&connection, false).unwrap();
            state::import_legacy_files(&mut connection, directory.path()).unwrap();
            let persisted_once = state::read_snapshot(&connection).unwrap();
            let persisted_twice = state::read_snapshot(&connection).unwrap();
            assert_eq!(persisted_once, persisted_twice);
        });

        crate::v1_case!("state-migration-c3c8bb15306d", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("roles.json"),
                json!({
                    "roles": [
                        {
                            "id": "role-1",
                            "gameId": "legacy-missing",
                            "name": "One",
                            "launchUrl": "https://example.test/game"
                        },
                        {
                            "id": "role-2",
                            "gameId": "legacy-missing",
                            "name": "Two",
                            "launchUrl": "https://example.test/game"
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(
                snapshot["roles"][0]["gameId"],
                snapshot["roles"][1]["gameId"]
            );
            assert_eq!(
                snapshot["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|game| game["source"] == "custom")
                    .count(),
                1
            );
        });

        crate::v1_case!("state-migration-ace933e7226a", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("games.json"),
                json!({
                    "games": [{
                        "id": "recovered-game",
                        "source": "custom",
                        "name": "example.test",
                        "defaultLaunchUrl": "https://example.test/game?server=one",
                        "createdAt": "2026-07-10T00:00:00.000Z",
                        "updatedAt": "2026-07-10T00:00:00.000Z"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                directory.path().join("roles.json"),
                json!({
                    "roles": [{
                        "id": "role-1",
                        "gameId": "legacy-missing",
                        "name": "Interrupted",
                        "launchUrl": "https://example.test/game?server=one"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(
                snapshot["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|game| game["source"] == "custom")
                    .count(),
                1
            );
            assert_eq!(snapshot["roles"][0]["gameId"], "recovered-game");
        });

        crate::v1_case!("state-migration-25a2c4d1eb9f", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("roles.json"),
                json!({
                    "roles": [
                        {
                            "id": "role-1",
                            "gameId": "legacy-missing",
                            "name": "One",
                            "launchUrl": "https://same.test/play?server=one"
                        },
                        {
                            "id": "role-2",
                            "gameId": "legacy-missing",
                            "name": "Two",
                            "launchUrl": "https://same.test/play?server=two"
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(
                snapshot["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|game| game["source"] == "custom")
                    .map(|game| game["name"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["same.test", "same.test 2"]
            );
        });
    }

    #[test]
    fn legacy_workspace_migrations_match_v1() {
        crate::v1_case!("state-migration-749347c7f1df", {
            let directory = tempdir().unwrap();
            let timestamp = "2026-07-10T00:00:00.000Z";
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "schemaVersion": 6,
                    "workspaces": [{
                        "id": "workspace-v6",
                        "name": "Version six",
                        "template": "two_columns",
                        "browserLaunchMode": "inherit",
                        "browserZoomMode": "adaptive",
                        "browserZoomPercent": 100,
                        "resourcePolicy": {"mode": "adaptive"},
                        "slots": [
                            {"id": "slot-1", "roleId": "role-1"},
                            {"id": "slot-2"}
                        ],
                        "createdAt": timestamp,
                        "updatedAt": timestamp
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let workspace =
                build_snapshot(directory.path()).unwrap()["launchWorkspaces"][0].clone();
            assert!(workspace["slots"][0].get("browserZoomPercent").is_none());
            assert!(
                workspace["slots"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|slot| slot.get("browserZoomPercent").is_none())
            );
        });

        crate::v1_case!("state-migration-cef697ad01ce", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "workspaces": [{
                        "id": "workspace-1",
                        "name": "Legacy",
                        "template": "quad",
                        "slots": [
                            {"id": "a", "roleId": "role-1"},
                            {"id": "b"},
                            {"id": "c"},
                            {"id": "d"}
                        ],
                        "createdAt": "2026-07-10T00:00:00.000Z",
                        "updatedAt": "2026-07-10T00:00:00.000Z"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let workspace =
                build_snapshot(directory.path()).unwrap()["launchWorkspaces"][0].clone();
            assert_eq!(workspace["browserEngine"], "system");
            assert!(workspace.get("browserLaunchMode").is_none());
            assert_eq!(workspace["browserZoomMode"], "adaptive");
            assert_eq!(workspace["browserZoomPercent"], 100);
            assert!(workspace.get("resourcePolicy").is_none());
            assert_eq!(
                workspace["slots"],
                json!([
                    {"id":"a","roleId":"role-1","rect":{"x":0.0,"y":0.0,"width":0.5,"height":0.5}},
                    {"id":"b","rect":{"x":0.5,"y":0.0,"width":0.5,"height":0.5}},
                    {"id":"c","rect":{"x":0.0,"y":0.5,"width":0.5,"height":0.5}},
                    {"id":"d","rect":{"x":0.5,"y":0.5,"width":0.5,"height":0.5}}
                ])
            );
        });

        crate::v1_case!("state-migration-6ec9344f6e1a", {
            let directory = tempdir().unwrap();
            let timestamp = "2026-07-10T00:00:00.000Z";
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "schemaVersion": 5,
                    "workspaces": [
                        {
                            "id": "workspace-unrestricted",
                            "name": "Legacy unrestricted",
                            "template": "two_columns",
                            "resourcePolicy": {
                                "mode": "unrestricted",
                                "backgroundCpuThrottleRate": 4
                            },
                            "slots": [{"roleId":"role-1"},{"roleId":"role-2"}],
                            "createdAt": timestamp,
                            "updatedAt": timestamp
                        },
                        {
                            "id": "workspace-priority",
                            "name": "Legacy priority",
                            "template": "two_columns",
                            "resourcePolicy": {
                                "mode": "primary_priority",
                                "backgroundCpuThrottleRate": 4,
                                "primaryRoleId": "role-2"
                            },
                            "slots": [{"roleId":"role-1"},{"roleId":"role-2"}],
                            "createdAt": timestamp,
                            "updatedAt": timestamp
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
            let workspaces = build_snapshot(directory.path()).unwrap()["launchWorkspaces"]
                .as_array()
                .unwrap()
                .clone();
            assert!(workspaces[0].get("resourcePolicy").is_none());
            assert_eq!(workspaces[0]["createdAt"], timestamp);
            assert_eq!(workspaces[0]["updatedAt"], timestamp);
            assert!(workspaces[1].get("resourcePolicy").is_none());
            assert!(!workspaces[1].to_string().contains("primaryRoleId"));
        });

        crate::v1_case!("state-migration-4437431055b4", {
            let directory = tempdir().unwrap();
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "workspaces": [{
                        "id": "workspace-1",
                        "name": "Legacy",
                        "template": "two_columns",
                        "slots": [
                            {"id":"left","profileId":" role-1 "},
                            {"id":"right","roleId":"role-2","profileId":"role-old"}
                        ]
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let workspace =
                build_snapshot(directory.path()).unwrap()["launchWorkspaces"][0].clone();
            assert_eq!(workspace["slots"][0]["roleId"], "role-1");
            assert_eq!(workspace["slots"][1]["roleId"], "role-2");
            assert!(!workspace.to_string().contains("profileId"));
        });

        crate::v1_case!("state-migration-ef3f8f924303", {
            let directory = tempdir().unwrap();
            let timestamp_created = "2026-07-10T00:00:00.000Z";
            let timestamp_updated = "2026-07-11T00:00:00.000Z";
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "workspaces": [{
                        "id": "workspace-centered",
                        "name": "Centered main",
                        "template": "main_center_side_stacks",
                        "browserZoomPercent": 80,
                        "targetDisplayId": 22,
                        "slots": [
                            {"id":"main","roleId":"role-1","rect":{"x":0.25,"y":0,"width":0.5,"height":1}},
                            {"id":"left-top","roleId":"role-2","rect":{"x":0,"y":0,"width":0.25,"height":0.5}},
                            {"id":"left-bottom","roleId":"role-3","rect":{"x":0,"y":0.5,"width":0.25,"height":0.5}},
                            {"id":"right-top","roleId":"role-4","rect":{"x":0.75,"y":0,"width":0.25,"height":0.5}},
                            {"id":"right-bottom","roleId":"role-5","rect":{"x":0.75,"y":0.5,"width":0.25,"height":0.5}}
                        ],
                        "createdAt": timestamp_created,
                        "updatedAt": timestamp_updated
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let workspace =
                build_snapshot(directory.path()).unwrap()["launchWorkspaces"][0].clone();
            assert_eq!(workspace["id"], "workspace-centered");
            assert_eq!(workspace["name"], "Centered main");
            assert_eq!(workspace["browserZoomPercent"], 80);
            assert_eq!(workspace["targetDisplay"], json!({"id":22}));
            assert_eq!(workspace["createdAt"], timestamp_created);
            assert_eq!(workspace["updatedAt"], timestamp_updated);
            assert_eq!(
                workspace["slots"],
                json!([
                    {"id":"main","roleId":"role-1","rect":{"x":0.3,"y":0,"width":0.4,"height":1}},
                    {"id":"left-top","roleId":"role-2","rect":{"x":0,"y":0,"width":0.3,"height":0.5}},
                    {"id":"left-bottom","roleId":"role-3","rect":{"x":0,"y":0.5,"width":0.3,"height":0.5}},
                    {"id":"right-top","roleId":"role-4","rect":{"x":0.7,"y":0,"width":0.3,"height":0.5}},
                    {"id":"right-bottom","roleId":"role-5","rect":{"x":0.7,"y":0.5,"width":0.3,"height":0.5}}
                ])
            );
        });

        crate::v1_case!("state-migration-ad27c5f187be", {
            let directory = tempdir().unwrap();
            let custom_rects = json!([
                {"x":0.2,"y":0,"width":0.5,"height":1},
                {"x":0,"y":0,"width":0.2,"height":0.6},
                {"x":0,"y":0.6,"width":0.2,"height":0.4},
                {"x":0.7,"y":0,"width":0.3,"height":0.6},
                {"x":0.7,"y":0.6,"width":0.3,"height":0.4}
            ]);
            fs::write(
                directory.path().join("launch-workspaces.json"),
                json!({
                    "workspaces": [{
                        "id": "workspace-custom-centered",
                        "name": "Custom centered main",
                        "template": "main_center_side_stacks",
                        "browserZoomPercent": 80,
                        "slots": custom_rects
                            .as_array()
                            .unwrap()
                            .iter()
                            .enumerate()
                            .map(|(index, rect)| json!({"id":format!("slot-{index}"),"rect":rect}))
                            .collect::<Vec<_>>()
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let workspace =
                build_snapshot(directory.path()).unwrap()["launchWorkspaces"][0].clone();
            assert_eq!(
                workspace["slots"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|slot| {
                        ["x", "y", "width", "height"].map(|key| slot["rect"][key].as_f64().unwrap())
                    })
                    .collect::<Vec<_>>(),
                custom_rects
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|rect| {
                        ["x", "y", "width", "height"].map(|key| rect[key].as_f64().unwrap())
                    })
                    .collect::<Vec<_>>()
            );
            assert_eq!(workspace["browserEngine"], "system");
            assert!(workspace.get("browserLaunchMode").is_none());
        });
    }

    #[test]
    fn legacy_macro_migrations_match_v1() {
        crate::v1_case!("state-migration-330d634635d8", {
            let macro_record = normalize_macro(
                &json!({
                    "id": "macro-1",
                    "name": "Legacy",
                    "roleIds": [" role-1 ", "role-2"],
                    "repeat": {"type":"once"},
                    "steps": [
                        {"id":"","type":"key","code":"Tab","label":" Tab "},
                        {"id":"","type":"click","xPercent":50.123,"yPercent":49.987}
                    ],
                    "createdAt": "2026-07-10T00:00:00.000Z",
                    "updatedAt": "2026-07-10T00:00:00.000Z"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(macro_record["roleIds"], json!(["role-1", "role-2"]));
            assert_eq!(macro_record["steps"][0]["code"], "Tab");
            assert_eq!(macro_record["steps"][0]["label"], "Tab");
            assert_eq!(macro_record["steps"][1]["xPercent"], 50.12);
            assert_eq!(macro_record["steps"][1]["yPercent"], 49.99);
            assert!(!macro_record["steps"][0]["id"].as_str().unwrap().is_empty());
            assert!(!macro_record["steps"][1]["id"].as_str().unwrap().is_empty());
            assert_ne!(
                macro_record["steps"][0]["id"],
                macro_record["steps"][1]["id"]
            );
        });

        crate::v1_case!("state-migration-9aa9fd4d4c0a", {
            let first = normalize_macro(
                &json!({
                    "id":"macro-1","name":"Legacy","profileId":" role-1 ",
                    "steps":[{"id":"step-1","type":"key","code":"F1"}]
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            let second = normalize_macro(
                &json!({
                    "id":"macro-2","name":"Modern wins","roleId":"role-2",
                    "profileId":"role-old",
                    "steps":[{"id":"step-2","type":"key","code":"F2"}]
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(first["roleIds"], json!(["role-1"]));
            assert_eq!(second["roleIds"], json!(["role-2"]));
            assert!(!first.to_string().contains("profileId"));
            assert!(!second.to_string().contains("roleId\":"));
        });

        crate::v1_case!("state-migration-fca48eef5ec1", {
            let macro_record = normalize_macro(
                &json!({
                    "id":"macro-1","name":"Modern","roleIds":["role-1"],
                    "steps":[{"id":"step-1","type":"key","code":"F1"}]
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(macro_record["id"], "macro-1");
            assert_eq!(macro_record["roleIds"], json!(["role-1"]));
        });

        for (case_id, trigger) in [
            (
                "state-migration-f289d74f5ef5",
                json!({"code":"Equal","ctrl":true,"alt":false,"shift":true,"meta":false}),
            ),
            (
                "state-migration-bd9960594932",
                json!({"code":"Tab","ctrl":true,"alt":false,"shift":true,"meta":false}),
            ),
        ] {
            let macro_record = normalize_macro(
                &json!({
                    "id":"legacy-reserved-trigger",
                    "enabled":true,
                    "activationMode":"while_held",
                    "name":"Legacy reserved trigger",
                    "roleIds":["role-1"],
                    "trigger":trigger,
                    "repeat":{"type":"loop","intervalMs":100},
                    "steps":[{"id":"step-1","type":"key","code":"F2","action":"hold_until_stop"}],
                    "createdAt":"2026-07-10T00:00:00.000Z",
                    "updatedAt":"2026-07-10T00:00:00.000Z"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            match case_id {
                "state-migration-f289d74f5ef5" => {
                    crate::v1_case!("state-migration-f289d74f5ef5", {
                        assert_eq!(macro_record["activationMode"], "toggle");
                        assert!(macro_record.get("trigger").is_none());
                        assert_eq!(macro_record["name"], "Legacy reserved trigger");
                        assert_eq!(
                            macro_record["steps"][0],
                            json!({
                                "id":"step-1",
                                "type":"key",
                                "code":"F2",
                                "action":"hold_until_stop"
                            })
                        );
                    });
                }
                _ => {
                    crate::v1_case!("state-migration-bd9960594932", {
                        assert_eq!(macro_record["activationMode"], "toggle");
                        assert!(macro_record.get("trigger").is_none());
                        assert_eq!(macro_record["name"], "Legacy reserved trigger");
                        assert_eq!(
                            macro_record["steps"][0],
                            json!({
                                "id":"step-1",
                                "type":"key",
                                "code":"F2",
                                "action":"hold_until_stop"
                            })
                        );
                    });
                }
            }
        }
    }

    #[test]
    fn legacy_role_migrations_match_v1() {
        crate::v1_case!("state-migration-0bfa8ffd1f93", {
            let timestamp = "2026-07-10T00:00:00.000Z";
            let role = normalize_role(
                &json!({
                    "id":"role-1","gameId":"game-1","name":"Legacy",
                    "launchUrl":"https://example.test/play",
                    "launchPreset":"performance",
                    "createdAt":timestamp,"updatedAt":timestamp
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(role["createdAt"], timestamp);
            assert_eq!(role["updatedAt"], timestamp);
            assert!(role.get("launchPreset").is_none());
        });

        crate::v1_case!("state-migration-a1863c15e3cc", {
            let role = normalize_role(
                &json!({
                    "id":"role-1","gameId":"game-1","name":"Invalid stored preset",
                    "launchUrl":"https://example.test/play","launchPreset":"turbo"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(role["name"], "Invalid stored preset");
            assert!(role.get("launchPreset").is_none());
        });

        crate::v1_case!("state-migration-cc8cc31f4273", {
            let role = normalize_role(
                &json!({
                    "id":"role-1","gameId":"game-1","name":"Imported",
                    "launchUrl":"https://example.test/play",
                    "preferredBrowserLaunchMode":"external"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert!(role.get("browserSessionSource").is_none());
            assert!(role.get("browserEnginePin").is_none());
            assert!(role.get("preferredBrowserLaunchMode").is_none());
        });

        crate::v1_case!("state-migration-55b9548e1a9d", {
            let role = normalize_role(
                &json!({
                    "id":"role-1","name":"Legacy",
                    "launchUrl":"https://example.com/play",
                    "windowWidth":1280,"windowHeight":720,
                    "notes":"","launchPreset":"performance",
                    "authState":"authenticated","loginProvider":"google",
                    "lastAuthCheckAt":"2026-07-10T00:00:00.000Z",
                    "lastSuccessfulLoginAt":"2026-07-10T00:00:00.000Z"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(role["id"], "role-1");
            assert_eq!(role["launchUrl"], "https://example.com/play");
            for field in [
                "loginProvider",
                "windowWidth",
                "windowHeight",
                "authState",
                "lastAuthCheckAt",
                "lastSuccessfulLoginAt",
            ] {
                assert!(role.get(field).is_none(), "{field} was not removed");
            }
        });

        crate::v1_case!("state-migration-76598d90b2ca", {
            let role = normalize_role(
                &json!({
                    "id":"role-1","name":"Legacy",
                    "gameUrl":"https://legacy.example/play",
                    "windowWidth":1280,"windowHeight":720,
                    "notes":"","launchPreset":"performance",
                    "authState":"authenticated"
                }),
                "2026-07-24T00:00:00.000Z",
            )
            .unwrap();
            assert_eq!(role["launchUrl"], "https://legacy.example/play");
            assert!(role.get("gameUrl").is_none());
        });

        crate::v1_case!("state-migration-72abd0443a48", {
            let directory = tempdir().unwrap();
            fs::create_dir_all(directory.path().join("profiles/role-1/browser")).unwrap();
            fs::write(
                directory.path().join("profiles/role-1/browser/session.txt"),
                "ok",
            )
            .unwrap();
            fs::write(
                directory.path().join("profiles.json"),
                json!({
                    "profiles": [{
                        "id":"role-1","name":"Legacy",
                        "launchUrl":"https://example.com/play",
                        "windowWidth":1280,"windowHeight":720,
                        "notes":"","launchPreset":"performance",
                        "authState":"authenticated",
                        "createdAt":"2026-07-10T00:00:00.000Z",
                        "updatedAt":"2026-07-10T00:00:00.000Z"
                    }]
                })
                .to_string(),
            )
            .unwrap();
            let snapshot = build_snapshot(directory.path()).unwrap();
            assert_eq!(snapshot["roles"][0]["id"], "role-1");
            assert_eq!(snapshot["roles"][0]["name"], "Legacy");
            migrate_role_directories(directory.path(), snapshot["roles"].as_array().unwrap())
                .unwrap();
            assert!(
                directory
                    .path()
                    .join("roles/role-1/browser/session.txt")
                    .is_file()
            );
            assert!(
                !directory
                    .path()
                    .join("profiles/role-1/browser/session.txt")
                    .exists()
            );
        });

        crate::v1_case!("state-migration-7e292a80d980", {
            let directory = tempdir().unwrap();
            fs::create_dir_all(directory.path().join("roles/role-1/browser")).unwrap();
            fs::write(
                directory.path().join("roles/role-1/browser/current.txt"),
                "current",
            )
            .unwrap();
            for role_id in ["role-1", "role-2"] {
                fs::create_dir_all(
                    directory
                        .path()
                        .join("profiles")
                        .join(role_id)
                        .join("browser"),
                )
                .unwrap();
                fs::write(
                    directory
                        .path()
                        .join("profiles")
                        .join(role_id)
                        .join("browser/legacy.txt"),
                    "legacy",
                )
                .unwrap();
            }
            let roles = vec![
                json!({"id":"role-1","name":"Current"}),
                json!({"id":"role-2","name":"Legacy"}),
            ];
            migrate_role_directories(directory.path(), &roles).unwrap();
            assert!(
                directory
                    .path()
                    .join("roles/role-1/browser/current.txt")
                    .is_file()
            );
            assert!(
                !directory
                    .path()
                    .join("roles/role-1/browser/legacy.txt")
                    .exists()
            );
            assert!(
                directory
                    .path()
                    .join("profiles/role-1/browser/legacy.txt")
                    .is_file()
            );
            assert!(
                directory
                    .path()
                    .join("roles/role-2/browser/legacy.txt")
                    .is_file()
            );
        });
    }

    #[test]
    fn removes_legacy_login_observations_from_compatibility_reports() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-compatibility.json"),
            json!({
                "reports": [{
                    "gameId": "builtin-flyff-universe",
                    "observations": {
                        "lastAuthFailureAt": "2026-07-15T00:00:00.000Z",
                        "lastAuthSuccessAt": "2026-07-15T00:01:00.000Z",
                        "lastEmbeddedLaunchAt": "2026-07-15T00:02:00.000Z"
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();

        let snapshot = build_snapshot(directory.path()).unwrap();
        let observations = &snapshot["compatibilityReports"][0]["observations"];
        crate::v1_case!("browser-workspace-df5ebcde1ab5", {
            assert_eq!(
                observations["lastEmbeddedLaunchAt"],
                "2026-07-15T00:02:00.000Z"
            );
            assert!(observations.get("lastAuthSuccessAt").is_none());
            assert!(observations.get("lastAuthFailureAt").is_none());
        });
    }
}
