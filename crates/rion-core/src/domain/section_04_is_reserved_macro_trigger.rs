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

struct BuiltinGameDefinition {
    key: &'static str,
    name: &'static str,
    default_launch_url: &'static str,
    local_storage_sync_keys: &'static [&'static str],
    local_storage_sync_selectors: &'static [&'static str],
}

fn builtin_definition(id: &str) -> Option<BuiltinGameDefinition> {
    match id {
        "builtin-flyff-universe" => Some(BuiltinGameDefinition {
            key: "flyff-universe",
            name: "Flyff Universe",
            default_launch_url: DEFAULT_LAUNCH_URL,
            local_storage_sync_keys: &[],
            local_storage_sync_selectors: &FLYFF_LOCAL_STORAGE_SYNC_SELECTORS,
        }),
        "builtin-feifei-infinite-universe" => Some(BuiltinGameDefinition {
            key: "feifei-infinite-universe",
            name: "飞飞：无限宇宙",
            default_launch_url: "https://ffcli.ruiwoo.cn",
            local_storage_sync_keys: &[],
            local_storage_sync_selectors: &FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS,
        }),
        _ => None,
    }
}

pub fn normalize_local_storage_sync_keys(values: Vec<String>) -> CoreResult<Vec<String>> {
    if values.len() > MAX_LOCAL_STORAGE_SYNC_KEYS {
        return Err(domain(
            "GAME_LOCAL_STORAGE_SYNC_KEYS_TOO_MANY",
            "A game can synchronize at most 32 localStorage keys.",
        ));
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let value = value.trim().to_owned();
        if value.is_empty() || value.len() > MAX_LOCAL_STORAGE_SYNC_KEY_BYTES {
            return Err(domain(
                "GAME_LOCAL_STORAGE_SYNC_KEY_INVALID",
                "localStorage sync keys must be between 1 and 256 UTF-8 bytes.",
            ));
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

pub fn normalize_game_local_storage_sync_keys(
    builtin_key: Option<&str>,
    values: Vec<String>,
) -> CoreResult<Vec<String>> {
    let values = normalize_local_storage_sync_keys(values)?;
    if matches!(
        builtin_key,
        Some("flyff-universe" | "feifei-infinite-universe")
    )
        && values.iter().any(|value| {
            matches!(
                value.as_str(),
                FLYFF_LOCAL_STORAGE_SYNC_KEY | FLYFF_LOCAL_STORAGE_SESSION_KEY
            )
        })
    {
        return Err(domain(
            "GAME_LOCAL_STORAGE_SYNC_KEY_UNSAFE",
            "Flyff settings and session identity cannot be synchronized as whole values.",
        ));
    }
    Ok(values)
}

pub fn normalize_local_storage_sync_selectors(
    builtin_key: Option<&str>,
    values: Vec<String>,
) -> CoreResult<Vec<String>> {
    let allowed = match builtin_key {
        Some("flyff-universe") => FLYFF_LOCAL_STORAGE_SYNC_SELECTORS.as_slice(),
        Some("feifei-infinite-universe") => {
            FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS.as_slice()
        }
        _ => &[],
    };
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let value = value.trim().to_owned();
        if !allowed.contains(&value.as_str()) {
            return Err(domain(
                "GAME_LOCAL_STORAGE_SYNC_SELECTOR_INVALID",
                "The localStorage synchronization field is not available for this game.",
            ));
        }
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

fn normalize_local_storage_source_role_id(value: Option<String>) -> CoreResult<Option<String>> {
    value
        .map(|value| {
            let value = value.trim().to_owned();
            if value.is_empty() || value.len() > 128 {
                Err(domain(
                    "ROLE_LOCAL_STORAGE_SOURCE_INVALID",
                    "The localStorage source role is invalid.",
                ))
            } else {
                Ok(value)
            }
        })
        .transpose()
}

pub fn validate_role_local_storage_binding(
    role: &StateRoleRecord,
    roles: &[StateRoleRecord],
) -> CoreResult<()> {
    let Some(source_id) = role.local_storage_source_role_id.as_deref() else {
        return Ok(());
    };
    if source_id == role.id {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_SELF",
            "A role cannot synchronize localStorage from itself.",
        ));
    }
    if roles.iter().any(|candidate| {
        candidate.local_storage_source_role_id.as_deref() == Some(role.id.as_str())
    }) {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_HAS_DEPENDENTS",
            "A source role with dependents cannot depend on another role.",
        ));
    }
    let source = roles
        .iter()
        .find(|candidate| candidate.id == source_id)
        .ok_or_else(|| {
            domain(
                "ROLE_LOCAL_STORAGE_SOURCE_NOT_FOUND",
                "The localStorage source role was not found.",
            )
        })?;
    if source.local_storage_source_role_id.is_some() {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_CHAIN",
            "A dependent role cannot be used as a localStorage source.",
        ));
    }
    if source.game_id != role.game_id {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_GAME_MISMATCH",
            "The localStorage source role must belong to the same game.",
        ));
    }
    if launch_origin(&source.launch_url)? != launch_origin(&role.launch_url)? {
        return Err(domain(
            "ROLE_LOCAL_STORAGE_SOURCE_ORIGIN_MISMATCH",
            "The localStorage source role must use the same launch origin.",
        ));
    }
    Ok(())
}

pub fn launch_origin(value: &str) -> CoreResult<String> {
    let url = Url::parse(value).map_err(|_| {
        domain(
            "ROLE_LAUNCH_URL_INVALID",
            "Role launch URL must be a valid HTTP or HTTPS URL.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(domain(
            "ROLE_LAUNCH_URL_INVALID",
            "Role launch URL must be a valid HTTP or HTTPS URL.",
        ));
    }
    Ok(url.origin().ascii_serialization())
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
    one_of(
        &settings.fonts.cjk_variant,
        &["auto", "tc", "sc", "jp"],
        "browser font CJK variant",
    )?;
    if settings.fonts.preset_id.as_ref().is_some_and(|value| {
        value.is_empty()
            || value.len() > 64
            || !value.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
    }) {
        return Err(CoreError::InvalidInput(
            "browser font preset is invalid".to_owned(),
        ));
    }
    for (slot, selection) in &settings.fonts.slots {
        if !matches!(
            slot.as_str(),
            "cjk" | "latin" | "numeric" | "monospace" | "math"
        ) {
            return Err(CoreError::InvalidInput(
                "browser font slot is invalid".to_owned(),
            ));
        }
        match selection {
            crate::model::BrowserFontSelectionRecord::System { family } => {
                if normalize_font_family(family).as_deref() != Some(family.as_str()) {
                    return Err(CoreError::InvalidInput(
                        "browser system font family is invalid".to_owned(),
                    ));
                }
            }
            crate::model::BrowserFontSelectionRecord::Google { catalog_id, family } => {
                if catalog_id.is_empty()
                    || catalog_id.len() > 64
                    || !crate::font_catalog::contains(catalog_id)
                    || !catalog_id.chars().all(|character| {
                        character.is_ascii_lowercase()
                            || character.is_ascii_digit()
                            || character == '-'
                    })
                {
                    return Err(CoreError::InvalidInput(
                        "browser Google font catalog id is invalid".to_owned(),
                    ));
                }
                if crate::font_catalog::is_custom_catalog_id(catalog_id) {
                    let valid_family = family.as_deref().is_some_and(|family| {
                        normalize_font_family(family).as_deref() == Some(family)
                            && crate::font_catalog::custom_catalog_id(family).as_deref()
                                == Some(catalog_id.as_str())
                    });
                    if !valid_family {
                        return Err(CoreError::InvalidInput(
                            "browser custom Google font family is invalid".to_owned(),
                        ));
                    }
                } else if family.is_some() {
                    return Err(CoreError::InvalidInput(
                        "browser curated Google font family is invalid".to_owned(),
                    ));
                }
            }
        }
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
    let font_smoothing_enabled = settings.fonts.font_smoothing_enabled;
    if !matches!(settings.fonts.mode.as_str(), "default" | "custom") {
        settings.fonts.mode = "default".to_owned();
    }
    if !matches!(
        settings.fonts.cjk_variant.as_str(),
        "auto" | "tc" | "sc" | "jp"
    ) {
        settings.fonts.cjk_variant = "auto".to_owned();
    }
    settings.fonts.preset_id = settings.fonts.preset_id.and_then(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        (!normalized.is_empty()
            && normalized.len() <= 64
            && normalized.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            }))
        .then_some(normalized)
    });
    settings.fonts.slots.retain(|slot, selection| {
        if !matches!(
            slot.as_str(),
            "cjk" | "latin" | "numeric" | "monospace" | "math"
        ) {
            return false;
        }
        match selection {
            crate::model::BrowserFontSelectionRecord::System { family } => {
                let Some(normalized) = normalize_font_family(family) else {
                    return false;
                };
                *family = normalized;
                true
            }
            crate::model::BrowserFontSelectionRecord::Google { catalog_id, family } => {
                let normalized = catalog_id.trim().to_ascii_lowercase();
                if normalized.is_empty()
                    || normalized.len() > 64
                    || !crate::font_catalog::contains(&normalized)
                    || !normalized.chars().all(|character| {
                        character.is_ascii_lowercase()
                            || character.is_ascii_digit()
                            || character == '-'
                    })
                {
                    return false;
                }
                if crate::font_catalog::is_custom_catalog_id(&normalized) {
                    let Some(normalized_family) = family.as_deref().and_then(normalize_font_family)
                    else {
                        return false;
                    };
                    if crate::font_catalog::custom_catalog_id(&normalized_family).as_deref()
                        != Some(normalized.as_str())
                    {
                        return false;
                    }
                    *family = Some(normalized_family);
                } else {
                    *family = None;
                }
                *catalog_id = normalized;
                true
            }
        }
    });
    if settings.fonts.mode == "default" {
        settings.fonts = default_browser_font_settings();
        settings.fonts.font_smoothing_enabled = font_smoothing_enabled;
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

fn normalize_font_family(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty() && normalized.len() <= 120 && !normalized.chars().any(char::is_control))
        .then_some(normalized)
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
    }
}
