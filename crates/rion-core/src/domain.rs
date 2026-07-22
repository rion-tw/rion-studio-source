use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::{
    error::{CoreError, CoreResult},
    model::StateCollection,
    model::{
        GameBrowserSettingsRecord, LegalAcceptanceRecord, MacroSettingsRecord,
        StateCompatibilityReportRecord,
    },
};

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
        &settings.graphics.mode,
        &["automatic", "high_performance", "experimental"],
        "browser graphics mode",
    )?;
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
    repeat: MacroRepeat,
    steps: Vec<MacroStep>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MacroRepeat {
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
    if let MacroRepeat::Loop { interval_ms } = macro_record.repeat
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
}
