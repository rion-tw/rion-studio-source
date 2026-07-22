use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreCommand {
    Health,
    StateSnapshot,
    GameBrowserSettingsReplace {
        settings: GameBrowserSettingsRecord,
    },
    MacroSettingsReplace {
        settings: MacroSettingsRecord,
    },
    RuntimeWindowPreferencesReplace {
        preferences: RuntimeWindowPreferencesRecord,
    },
    LegalAcceptanceReplace {
        acceptance: LegalAcceptanceRecord,
    },
    PortableCommit {
        #[ts(type = "unknown")]
        snapshot: Value,
    },
    GamesApplyDelta {
        #[ts(type = "Array<import(\"../types\").Game>")]
        upserts: Vec<StateGameRecord>,
        #[ts(rename = "deleteIds")]
        delete_ids: Vec<String>,
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    RolesApplyDelta {
        #[ts(type = "Array<import(\"../types\").Role>")]
        upserts: Vec<StateRoleRecord>,
        #[ts(rename = "deleteIds")]
        delete_ids: Vec<String>,
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    LaunchWorkspacesApplyDelta {
        #[ts(type = "Array<import(\"../types\").LaunchWorkspace>")]
        upserts: Vec<StateLaunchWorkspaceRecord>,
        #[ts(rename = "deleteIds")]
        delete_ids: Vec<String>,
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    MacrosApplyDelta {
        #[ts(type = "Array<import(\"../types\").Macro>")]
        upserts: Vec<StateMacroRecord>,
        #[ts(rename = "deleteIds")]
        delete_ids: Vec<String>,
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    CompatibilityReportsApplyDelta {
        #[ts(type = "Array<import(\"../types\").GameCompatibilityReport>")]
        upserts: Vec<StateCompatibilityReportRecord>,
        #[ts(rename = "deleteIds")]
        delete_ids: Vec<String>,
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    CdnReplaceRules {
        rules: Vec<CdnRule>,
    },
    CdnRewriteUrl {
        url: String,
    },
    ResourceResolve {
        input: ResourcePolicyInput,
    },
    LayoutResolve {
        input: WorkspaceLayoutInput,
    },
    LogsAppend {
        entries: Vec<LogEntry>,
    },
    LogsQuery {
        query: LogQuery,
    },
    LogsClear,
    LogsStatus,
    LogsExport,
    LogsExportTo {
        path: String,
    },
    MacroStart {
        request: MacroStartRequest,
    },
    MacroPress {
        request: MacroPressRequest,
    },
    MacroRelease {
        request: MacroReleaseRequest,
    },
    MacroStop {
        #[ts(rename = "macroId")]
        macro_id: String,
    },
    MacroStopRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    MacroReleaseRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    MacroStatuses,
    ExternalHealthRegister {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    ExternalHealthHeartbeat {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "pageHidden")]
        page_hidden: bool,
    },
    ExternalHealthRemove {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    ExternalHealthSuspend {
        suspended: bool,
    },
    ChromeProfileDiscover {
        #[ts(rename = "sourceUserDataDir")]
        source_user_data_dir: String,
    },
    ChromeProfileCopy {
        #[ts(rename = "sourceUserDataDir")]
        source_user_data_dir: String,
        #[ts(rename = "directoryName")]
        directory_name: String,
        destination: String,
    },
    ChromeProfileReadCookies {
        #[ts(rename = "browserUserDataDir")]
        browser_user_data_dir: String,
    },
    PortableNormalize {
        #[serde(rename = "rawJson")]
        #[ts(rename = "rawJson")]
        raw_json: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum StateCollection {
    Games,
    Roles,
    LaunchWorkspaces,
    Macros,
    CompatibilityReports,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateGameRecord {
    pub id: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin_key: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
    pub browser_launch_mode: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRoleRecord {
    pub id: String,
    pub game_id: String,
    pub name: String,
    pub launch_url: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_session_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image_dominant_color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateLaunchWorkspaceRecord {
    pub id: String,
    pub name: String,
    pub template: String,
    pub browser_launch_mode: String,
    pub browser_zoom_mode: String,
    pub browser_zoom_percent: f64,
    pub resource_policy: StateWorkspaceResourcePolicyRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    pub slots: Vec<StateWorkspaceSlotRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateWorkspaceResourcePolicyRecord {
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateWorkspaceDisplayTargetRecord {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<StateWorkspaceDisplayFingerprintRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateWorkspaceDisplayFingerprintRecord {
    pub label: String,
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub is_internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StatePixelBoundsRecord {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateResolutionRecord {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateWorkspaceSlotRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_zoom_percent: Option<f64>,
    pub rect: StateNormalizedRectRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateNormalizedRectRecord {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateMacroRecord {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateCompatibilityReportRecord {
    pub game_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_fingerprint: Option<String>,
    pub is_stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load: Option<StateCompatibilityLoadRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphics: Option<StateWebGraphicsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_chrome: Option<StateCompatibilityChromeRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<StateCompatibilityRecommendationRecord>,
    pub observations: StateCompatibilityObservationsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateCompatibilityLoadRecord {
    pub state: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateWebGraphicsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renderer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    pub webgl: String,
    pub webgl2: String,
    pub webgpu: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateCompatibilityChromeRecord {
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StateCompatibilityRecommendationRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateCompatibilityObservationsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_embedded_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_external_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fallback_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_launch_failure_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_launch_failure_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreEvent {
    Ready {
        #[serde(rename = "schemaVersion")]
        #[ts(rename = "schemaVersion")]
        schema_version: u32,
    },
    StateChanged {
        #[ts(type = "number")]
        revision: u64,
    },
    LogsChanged,
    PressureChanged {
        snapshot: SystemPressureSnapshot,
    },
    BrowserActions {
        actions: Vec<BrowserActionRequest>,
    },
    MacroStatuses {
        statuses: Vec<MacroRunStatus>,
    },
    ExternalHealthChanged {
        #[ts(rename = "roleId")]
        role_id: String,
        health: String,
    },
    ExternalHealthProbeFailed {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "errorCode")]
        error_code: String,
        #[ts(rename = "errorMessage")]
        error_message: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CdnRule {
    pub id: String,
    pub regex_filter: String,
    pub regex_substitution: String,
    pub source_host: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum PressureLevel {
    Normal,
    Constrained,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemPressureSnapshot {
    pub level: PressureLevel,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourcePolicyInput {
    pub policy_mode: String,
    pub workspace_hidden: bool,
    pub macro_active: bool,
    pub shares_process_with_macro: bool,
    pub pressure_level: PressureLevel,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourcePolicyDecision {
    pub cpu_throttle_rate: u8,
    pub resource_state: String,
    pub resource_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRoleInput {
    pub role_id: String,
    pub rect: LayoutRect,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutDividerInput {
    pub axis: String,
    pub before_role_ids: Vec<String>,
    pub after_role_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceLayoutInput {
    pub active: bool,
    pub hidden: bool,
    pub window_visible: bool,
    pub content_bounds: LayoutBounds,
    pub gap: u32,
    pub roles: Vec<LayoutRoleInput>,
    pub dividers: Vec<LayoutDividerInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutRoleBounds {
    pub role_id: String,
    pub bounds: LayoutBounds,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LayoutDividerBounds {
    pub index: u32,
    pub bounds: LayoutBounds,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceLayoutOutput {
    pub visible: bool,
    pub roles: Vec<LayoutRoleBounds>,
    pub dividers: Vec<LayoutDividerBounds>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameBrowserSettingsRecord {
    pub fonts: BrowserFontSettingsRecord,
    pub graphics: BrowserGraphicsSettingsRecord,
    pub launch_mode: String,
    pub macro_badge_position: MacroBadgePositionRecord,
    pub network: BrowserNetworkSettingsRecord,
    pub workspace: WorkspaceAppearanceSettingsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontSettingsRecord {
    pub mode: String,
    pub families: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserGraphicsSettingsRecord {
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroBadgePositionRecord {
    pub horizontal_align: String,
    pub horizontal_margin_px: u32,
    pub top_px: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserNetworkSettingsRecord {
    pub cdn_compatibility: BrowserCdnCompatibilityRecord,
    pub proxy: BrowserProxySettingsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserCdnCompatibilityRecord {
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserProxySettingsRecord {
    pub mode: String,
    pub server: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceAppearanceSettingsRecord {
    pub background: String,
    pub gap: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroSettingsRecord {
    pub startup_delay_ms: u32,
    pub key_hold_ms: u32,
    pub post_input_delay_ms: u32,
    pub default_loop_delay_ms: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeWindowPreferencesRecord {
    pub always_show_toolbar_in_full_screen: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptanceRecord {
    pub accepted_at: String,
    pub accepted_fair_use_version: String,
    pub accepted_terms_version: String,
    pub acknowledged_privacy_version: String,
    pub schema_version: u8,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub event: String,
    pub message: String,
    pub session_id: String,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub context: Option<Value>,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogQuery {
    #[serde(default)]
    #[ts(optional)]
    pub levels: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub sources: Option<Vec<String>>,
    #[ts(optional)]
    pub from: Option<String>,
    #[ts(optional)]
    pub to: Option<String>,
    #[ts(optional)]
    pub search: Option<String>,
    #[ts(optional)]
    pub cursor: Option<String>,
    #[ts(optional)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub role_id: String,
    pub origin: String,
    #[ts(type = "number")]
    pub scheduled_at_ms: u64,
    #[ts(type = "number")]
    pub deadline_ms: u64,
    pub action: BrowserAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserAction {
    Focus,
    Key {
        phase: String,
        key: String,
        code: Option<String>,
        modifiers: Vec<String>,
        #[serde(rename = "ownerId")]
        #[ts(rename = "ownerId")]
        owner_id: String,
    },
    Click {
        anchor: Option<String>,
        unit: String,
        x: f64,
        y: f64,
        button: String,
    },
    Evaluate {
        source: String,
    },
    Cookies {
        operation: String,
        #[serde(rename = "payloadJson")]
        #[ts(rename = "payloadJson")]
        payload_json: String,
    },
    Session {
        operation: String,
        #[serde(rename = "payloadJson")]
        #[ts(rename = "payloadJson")]
        payload_json: String,
    },
    Debugger {
        method: String,
        #[serde(rename = "paramsJson")]
        #[ts(rename = "paramsJson")]
        params_json: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionResult {
    pub request_id: String,
    pub ok: bool,
    pub value_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroDefinition {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroTrigger {
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroRepeat {
    Once,
    Loop {
        #[serde(rename = "intervalMs")]
        #[ts(rename = "intervalMs")]
        interval_ms: u32,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroStepDefinition {
    Key {
        id: String,
        code: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        action: Option<String>,
    },
    Click {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        anchor: Option<String>,
        #[serde(rename = "xPercent")]
        #[ts(rename = "xPercent")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        x_percent: Option<f64>,
        #[serde(rename = "yPercent")]
        #[ts(rename = "yPercent")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        y_percent: Option<f64>,
        #[serde(rename = "xPx")]
        #[ts(rename = "xPx")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        x_px: Option<f64>,
        #[serde(rename = "yPx")]
        #[ts(rename = "yPx")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        y_px: Option<f64>,
    },
    Delay {
        id: String,
        ms: u32,
    },
    Macro {
        id: String,
        #[serde(rename = "macroId")]
        #[ts(rename = "macroId")]
        macro_id: String,
        #[serde(rename = "callMode")]
        #[ts(rename = "callMode")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        call_mode: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroRuntimeSettings {
    pub startup_delay_ms: u32,
    pub key_hold_ms: u32,
    pub post_input_delay_ms: u32,
    pub default_loop_delay_ms: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroStartRequest {
    pub macros: Vec<MacroDefinition>,
    pub settings: MacroRuntimeSettings,
    pub macro_id: String,
    pub role_id: Option<String>,
    pub active_role_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroPressRequest {
    pub start: MacroStartRequest,
    pub press_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroReleaseRequest {
    pub macro_id: String,
    pub role_id: String,
    pub press_id: String,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroRunStatus {
    pub role_id: String,
    pub macro_id: String,
    pub state: String,
    pub iteration: Option<u32>,
    pub last_click: Option<MacroLastClick>,
    pub started_at: String,
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroLastClick {
    pub sequence: u32,
    pub step_id: String,
}

#[cfg(test)]
mod command_tests {
    use serde_json::json;

    use super::{CoreCommand, CoreEvent};

    #[test]
    fn collection_delta_commands_decode_typed_records() {
        let command: CoreCommand = serde_json::from_value(json!({
            "type": "gamesApplyDelta",
            "upserts": [{
                "id": "game-1",
                "source": "custom",
                "name": "Game",
                "defaultLaunchUrl": "https://example.test/play",
                "browserLaunchMode": "inherit",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            }],
            "deleteIds": [],
            "orderedIds": ["game-1"]
        }))
        .unwrap();

        let encoded = serde_json::to_value(command).unwrap();
        assert_eq!(encoded["upserts"][0]["id"], "game-1");
        assert!(encoded["upserts"][0].get("builtinKey").is_none());
    }

    #[test]
    fn collection_delta_commands_reject_untyped_records() {
        let error = serde_json::from_value::<CoreCommand>(json!({
            "type": "gamesApplyDelta",
            "upserts": [{ "id": "game-1" }],
            "deleteIds": [],
            "orderedIds": ["game-1"]
        }))
        .unwrap_err();

        assert!(error.to_string().contains("source"));
    }

    #[test]
    fn enum_fields_use_the_generated_camel_case_contract() {
        let command = serde_json::from_value::<CoreCommand>(json!({
            "type": "macroStop",
            "macroId": "macro-1"
        }))
        .unwrap();
        assert!(matches!(command, CoreCommand::MacroStop { macro_id } if macro_id == "macro-1"));

        let event = serde_json::to_value(CoreEvent::ExternalHealthChanged {
            role_id: "role-1".to_owned(),
            health: "healthy".to_owned(),
        })
        .unwrap();
        assert_eq!(event["roleId"], "role-1");
        assert!(event.get("role_id").is_none());
    }
}
