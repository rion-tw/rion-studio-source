use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    macro_graph::validate_macro_graph,
};

const PORTABLE_APP: &str = "Rion Studio";
const CURRENT_SCHEMA: u64 = 6;
const MAX_SLOTS: usize = 9;
const MAX_STEPS: usize = 100;

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

pub fn normalize(raw: &str) -> CoreResult<Value> {
    if raw.len() > 128 * 1024 * 1024 {
        return Err(invalid("portable data is too large"));
    }
    let source: Value = serde_json::from_str(raw)
        .map_err(|error| invalid(format!("portable JSON is invalid: {error}")))?;
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
    let (games, recovered_roles) = recover_games(input_games, roles)?;
    roles = recovered_roles;
    let workspaces = normalize_workspaces(object)?;
    let macros = normalize_macros(object, schema >= 5)?;
    ensure_unique_ids(&games, "id", "game")?;
    ensure_unique_ids(&roles, "id", "role")?;
    ensure_unique_ids(&workspaces, "id", "workspace")?;
    ensure_unique_ids(&macros, "id", "macro")?;
    validate_macro_graph(&macros)?;
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
    if let Some(key) = builtin_key {
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
    game.insert(
        "browserLaunchMode".to_owned(),
        json!(launch_mode(source.get("browserLaunchMode"))?),
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
                    "browserLaunchMode": "inherit"
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
                "browserLaunchMode": "inherit"
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
    let resource_mode = source
        .get("resourcePolicy")
        .and_then(Value::as_object)
        .and_then(|policy| policy.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("adaptive");
    Ok(json!({
        "id": required_string(source, "id", "workspace")?,
        "name": required_string(source, "name", "workspace")?,
        "template": template,
        "browserLaunchMode": launch_mode(source.get("browserLaunchMode"))?,
        "browserZoomMode": match source.get("browserZoomMode").and_then(Value::as_str) {
            Some("fixed") => "fixed",
            Some("adaptive") | None => "adaptive",
            _ => return Err(invalid("portable workspace zoom mode is invalid")),
        },
        "browserZoomPercent": zoom,
        "resourcePolicy": { "mode": if resource_mode == "unrestricted" { "unrestricted" } else { "adaptive" } },
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
            if !(10.0..=500.0).contains(&zoom) {
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
                .and_then(Value::as_str)
                .unwrap_or("tap");
            if !matches!(action, "tap" | "hold_until_stop") {
                return Err(invalid("portable macro key action is invalid"));
            }
            let modifiers = if supports_modifiers {
                source
                    .get("modifiers")
                    .and_then(Value::as_array)
                    .map(|values| {
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
                    .transpose()?
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            Ok(
                json!({ "id": id, "type": "key", "code": code, "modifiers": modifiers, "action": action }),
            )
        }
        Some("click") => {
            let unit = source
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("percent");
            if unit == "px" {
                Ok(json!({
                    "id": id, "type": "click", "unit": "px",
                    "anchor": source.get("anchor").and_then(Value::as_str).unwrap_or("top-left"),
                    "xPx": finite_number(source, "xPx")?, "yPx": finite_number(source, "yPx")?
                }))
            } else if unit == "percent" {
                Ok(json!({
                    "id": id, "type": "click", "unit": "percent",
                    "anchor": source.get("anchor").and_then(Value::as_str).unwrap_or("top-left"),
                    "xPercent": finite_number(source, "xPercent")?, "yPercent": finite_number(source, "yPercent")?
                }))
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
                .and_then(Value::as_str)
                .unwrap_or("wait");
            if !matches!(mode, "wait" | "trigger") {
                return Err(invalid("portable macro call mode is invalid"));
            }
            Ok(
                json!({ "id": id, "type": "macro", "macroId": required_string(source, "macroId", "macro call step")?, "callMode": mode }),
            )
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
    for key in ["gameBrowserSettings", "macroSettings"] {
        if let Some(value) = source.get(key)
            && value.is_object()
        {
            output.insert(key.to_owned(), value.clone());
        }
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

fn launch_mode(value: Option<&Value>) -> CoreResult<&'static str> {
    match value.and_then(Value::as_str).unwrap_or("inherit") {
        "inherit" => Ok("inherit"),
        "auto" => Ok("auto"),
        "embedded" => Ok("embedded"),
        "external" => Ok("external"),
        _ => Err(invalid("portable browser launch mode is invalid")),
    }
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

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidInput(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(schema: u64) -> String {
        json!({
            "app":"Rion Studio","schemaVersion":schema,"exportedAt":"2026-01-01T00:00:00Z","appVersion":"1.37.0",
            "games": if schema >= 2 { json!([{"id":"g1","source":"custom","name":"Game","defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit"}]) } else { json!([]) },
            "roles":[{"id":"r1","gameId": if schema >= 2 { "g1" } else { "" },"name":"Role","launchUrl":"https://example.test/play","notes":""}],
            "launchWorkspaces":[{"id":"w1","name":"Workspace","template":"single","browserZoomPercent":100,"slots":[{"id":"s1","roleId":"r1","rect":{"x":0,"y":0,"width":1,"height":1}}]}],
            "macros":[{"id":"m1","name":"Macro","roleIds":["r1"],"repeat":{"type":"once"},"steps":[{"id":"step","type":"delay","ms":1}]}]
        }).to_string()
    }

    #[test]
    fn normalizes_every_supported_portable_schema_to_v6() {
        for schema in 1..=6 {
            let value = normalize(&fixture(schema)).unwrap();
            assert_eq!(value["schemaVersion"], 6);
            assert!(!value["roles"][0]["gameId"].as_str().unwrap().is_empty());
            assert_eq!(value["macros"][0]["enabled"], true);
        }
    }

    #[test]
    fn rejects_cycles_and_unsupported_versions() {
        let mut cycle: Value = serde_json::from_str(&fixture(6)).unwrap();
        cycle["macros"][0]["steps"] = json!([{"id":"call","type":"macro","macroId":"m1"}]);
        assert!(normalize(&cycle.to_string()).is_err());
        let future = fixture(6).replace("\"schemaVersion\":6", "\"schemaVersion\":7");
        assert!(normalize(&future).is_err());
    }
}
