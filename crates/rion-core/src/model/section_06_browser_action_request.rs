#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub role_id: String,
    #[ts(type = "\"macro\"")]
    pub origin: String,
    #[ts(type = "number")]
    pub input_epoch: u64,
    #[ts(type = "\"normal\" | \"cleanup\"")]
    pub intent: String,
    #[ts(type = "number")]
    pub scheduled_at_ms: u64,
    #[ts(type = "number")]
    pub deadline_ms: u64,
    pub action: BrowserAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInputEpochRecord {
    pub role_id: String,
    #[ts(type = "number")]
    pub input_epoch: u64,
    pub current: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedKeyEffectRecord {
    #[ts(type = "\"rawKeyDown\" | \"keyUp\"")]
    pub phase: String,
    pub code: String,
    pub active_codes_before: Vec<String>,
    pub active_codes: Vec<String>,
    pub auto_repeat: bool,
    pub suppress_shortcut: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedKeyTransitionRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub transition_id: Option<String>,
    pub effects: Vec<EmbeddedKeyEffectRecord>,
    pub has_held_keys: bool,
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
        #[ts(type = "\"tap\" | \"hold\" | \"release\"")]
        phase: String,
        key: String,
        code: Option<String>,
        #[ts(type = "Array<\"primary\" | \"ctrl\" | \"alt\" | \"shift\" | \"meta\">")]
        modifiers: Vec<String>,
        #[serde(rename = "ownerId")]
        #[ts(rename = "ownerId")]
        owner_id: String,
        #[serde(default, rename = "suppressOverlayShortcut")]
        #[ts(rename = "suppressOverlayShortcut")]
        suppress_overlay_shortcut: bool,
    },
    Click {
        #[ts(
            type = "\"top-left\" | \"top-center\" | \"top-right\" | \"center-left\" | \"center\" | \"center-right\" | \"bottom-left\" | \"bottom-center\" | \"bottom-right\" | null"
        )]
        anchor: Option<String>,
        #[ts(type = "\"percent\" | \"px\"")]
        unit: String,
        x: f64,
        y: f64,
        #[ts(type = "\"left\" | \"middle\" | \"right\"")]
        button: String,
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreEffectTargetKind {
    App,
    WebContents,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectTarget {
    pub kind: CoreEffectTargetKind,
    pub handle_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreEffectAction {
    RoleBrowserDataClearSession {
        role_id: String,
        webview2_user_data_dir: String,
        webkit_data_store_identifier: String,
    },
    ChromeProfileImportSnapshot {
        transaction_id: String,
        role_id: String,
        launch_url: String,
        webview2_user_data_dir: String,
        webkit_data_store_identifier: String,
        replace_existing: bool,
    },
    ChromeProfileImportApply {
        transaction_id: String,
        role_id: String,
        launch_url: String,
        webview2_user_data_dir: String,
        webkit_data_store_identifier: String,
        replace_existing: bool,
    },
    ChromeProfileImportVerify {
        role_id: String,
        verification_url: String,
        authenticated_path: String,
        login_path: String,
        webview2_user_data_dir: String,
        webkit_data_store_identifier: String,
    },
    ChromeProfileImportRollback {
        transaction_id: String,
        role_id: String,
        launch_url: String,
        webview2_user_data_dir: String,
        webkit_data_store_identifier: String,
    },
    ChromeProfileImportCommit {
        transaction_id: String,
    },
    EmbeddedCreateTab {
        tab: Box<EmbeddedTabEffectRecord>,
    },
    EmbeddedConfigureRoleSessions {
        role_ids: Vec<String>,
    },
    EmbeddedLoadRoles {
        roles: Vec<EmbeddedRoleLoadEffectRecord>,
    },
    EmbeddedInstallOverlays {
        role_ids: Vec<String>,
    },
    EmbeddedFocusRole {
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zoom_factor: Option<f64>,
    },
    EmbeddedDestroyRole {
        role_id: String,
    },
    EmbeddedDestroyTab {
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attempt_generation: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_active_tab_id: Option<String>,
    },
    EmbeddedApplyRuntime {
        snapshot: BrowserRuntimeSnapshot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target: Option<EmbeddedLaunchTargetRecord>,
        #[serde(default)]
        #[ts(rename = "revealWindowIds")]
        reveal_window_ids: Vec<String>,
        #[serde(default)]
        #[ts(rename = "focusWindowIds")]
        focus_window_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "focusTabId")]
        focus_tab_id: Option<String>,
    },
    OverlayOpenMacroPage {
        role_id: String,
    },
    OverlayCopyCoordinate {
        coordinate: MacroCoordinateRecord,
    },
    BrowserAction {
        request: Box<BrowserActionRequest>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectRequest {
    pub effect_id: String,
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_operation_id: Option<String>,
    pub target: CoreEffectTarget,
    #[ts(type = "number")]
    pub deadline_ms: u64,
    pub action: CoreEffectAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectResult {
    pub effect_id: String,
    pub operation_id: String,
    pub ok: bool,
    pub value_json: Option<String>,
    pub error: Option<crate::error::CoreErrorPayload>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectDispatchReport {
    pub accepted: Vec<String>,
    pub duplicate: Vec<String>,
    pub late: Vec<String>,
    pub unknown: Vec<String>,
    pub operation_mismatch: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectMetricsRecord {
    pub pending_effect_count: u32,
    pub peak_pending_effect_count: u32,
    pub active_operation_count: u32,
    pub pending_effect_capacity: u32,
    pub operation_capacity: u32,
    #[ts(type = "number")]
    pub emitted_effect_count: u64,
    #[ts(type = "number")]
    pub acknowledged_effect_count: u64,
    pub effect_ack_latency: LatencySummaryRecord,
    #[ts(type = "number")]
    pub launch_operation_count: u64,
    #[ts(type = "number")]
    pub launch_effect_count: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct OperationCancelResultRecord {
    pub cancelled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedLaunchTargetRecord {
    pub window_id: String,
    #[ts(type = "number")]
    pub display_id: i64,
    pub scale_factor: f64,
    pub work_area: StatePixelBoundsRecord,
    pub bounds: StatePixelBoundsRecord,
    #[ts(type = "\"normal\" | \"maximized\" | \"fullscreen\"")]
    pub presentation: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleViewEffectRecord {
    pub role: StateRoleRecord,
    pub resolved_engine: ResolvedBrowserEngine,
    pub rect: StateNormalizedRectRecord,
    pub zoom_factor: f64,
    #[ts(type = "\"adaptive\" | \"fixed\"")]
    pub zoom_mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleLoadEffectRecord {
    pub role_id: String,
    pub resolved_engine: ResolvedBrowserEngine,
    pub url: String,
    pub zoom_factor: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedTabEffectRecord {
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attempt_generation: Option<String>,
    pub source_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_template: Option<String>,
    pub workspace_appearance: WorkspaceAppearanceSettingsRecord,
    pub target: EmbeddedLaunchTargetRecord,
    pub roles: Vec<EmbeddedRoleViewEffectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedLaunchResultRecord {
    pub role_id: String,
    #[ts(type = "\"running\"")]
    pub state: String,
    pub launched_at: String,
    #[ts(type = "\"embedded\"")]
    pub runtime_mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRoleStatusRecord {
    pub role_id: String,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notice: Option<String>,
    #[ts(type = "\"embedded\"")]
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"ready\" | \"unavailable\"")]
    pub automation_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"ready\" | \"unavailable\"")]
    pub overlay_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"healthy\" | \"unresponsive\"")]
    pub page_health: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolved_engine: Option<ResolvedBrowserEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_kind: Option<BrowserHostKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue_reason: Option<SystemWebViewIssueReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capability_snapshot: Option<EngineCapabilitySnapshotRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserWorkspaceStatusRecord {
    pub workspace_id: String,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolved_engine: Option<ResolvedBrowserEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_kind: Option<BrowserHostKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue_reason: Option<SystemWebViewIssueReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capability_snapshot: Option<EngineCapabilitySnapshotRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroDefinition {
    pub id: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default)]
    pub shortcut_source_scope: MacroShortcutSourceScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroShortcutSourceScope {
    #[default]
    AllExecutionRoles,
    SelectedRoles {
        #[serde(rename = "roleIds")]
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(
            optional,
            type = "Array<\"primary\" | \"ctrl\" | \"alt\" | \"shift\" | \"meta\">"
        )]
        modifiers: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "\"tap\" | \"hold_until_stop\"")]
        action: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
    Click {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(
            optional,
            type = "\"top-left\" | \"top-center\" | \"top-right\" | \"center-left\" | \"center\" | \"center-right\" | \"bottom-left\" | \"bottom-center\" | \"bottom-right\""
        )]
        anchor: Option<String>,
        #[serde(flatten)]
        #[ts(flatten)]
        position: MacroClickDefinition,
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
        #[ts(optional, type = "\"wait\" | \"trigger\"")]
        call_mode: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroClickDefinition {
    Percent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "\"percent\"")]
        unit: Option<String>,
        #[serde(rename = "xPercent")]
        #[ts(rename = "xPercent")]
        x_percent: f64,
        #[serde(rename = "yPercent")]
        #[ts(rename = "yPercent")]
        y_percent: f64,
    },
    Pixels {
        #[ts(type = "\"px\"")]
        unit: String,
        #[serde(rename = "xPx")]
        #[ts(rename = "xPx")]
        x_px: f64,
        #[serde(rename = "yPx")]
        #[ts(rename = "yPx")]
        y_px: f64,
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
    pub source_role_id: Option<String>,
    pub active_role_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInvocationRequest {
    pub macro_id: String,
    pub source_role_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroPressInvocationRequest {
    pub macro_id: String,
    pub source_role_id: String,
    pub press_id: String,
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
    pub source_role_id: String,
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroOverlayRequestRecord {
    Activate,
    GameInputContext {
        active: bool,
    },
    List,
    Open,
    CopyCoordinate {
        #[serde(flatten)]
        coordinate: MacroCoordinateRecord,
    },
    Start {
        #[ts(rename = "macroId")]
        macro_id: String,
    },
    Toggle {
        #[ts(rename = "macroId")]
        macro_id: String,
    },
    Stop {
        #[ts(rename = "macroId")]
        macro_id: String,
    },
    Press {
        #[ts(rename = "macroId")]
        macro_id: String,
        #[ts(rename = "pressId")]
        press_id: String,
    },
    Release {
        #[ts(rename = "macroId")]
        macro_id: String,
        #[ts(rename = "pressId")]
        press_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(
            optional,
            rename = "releaseMode",
            type = "\"complete_first_iteration\" | \"immediate\""
        )]
        release_mode: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroCoordinateRecord {
    pub x_percent: f64,
    pub x_px: u32,
    pub viewport_height_px: u32,
    pub viewport_width_px: u32,
    pub y_percent: f64,
    pub y_px: u32,
}
