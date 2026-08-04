#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateGameRecord {
    pub id: String,
    #[ts(type = "\"builtin\" | \"custom\"")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"flyff-universe\" | \"feifei-infinite-universe\"")]
    pub builtin_key: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateRoleRecord {
    pub id: String,
    pub game_id: String,
    pub name: String,
    pub launch_url: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub cover_image_dominant_color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateLaunchWorkspaceRecord {
    pub id: String,
    pub name: String,
    #[ts(
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: String,
    pub slots: Vec<StateWorkspaceSlotRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayTargetRecord {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fingerprint: Option<DisplayFingerprintRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DisplayFingerprintRecord {
    pub label: String,
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub is_internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StatePixelBoundsRecord {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateResolutionRecord {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowPlacementRecord {
    pub normal_bounds: StatePixelBoundsRecord,
    pub saved_work_area: StatePixelBoundsRecord,
    #[ts(type = "\"normal\" | \"maximized\" | \"fullscreen\"")]
    pub presentation: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowRoleViewRecord {
    pub role_id: String,
    pub rect: StateNormalizedRectRecord,
    pub browser_zoom_percent: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowTabRecord {
    pub id: String,
    #[ts(type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    pub source_id: String,
    pub name: String,
    pub role_ids: Vec<String>,
    pub hidden: bool,
    pub audio_muted: bool,
    #[serde(default)]
    pub role_views: Vec<GameWindowRoleViewRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateGameWindowRecord {
    pub id: String,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
    #[serde(default)]
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowCreateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowSaveRuntimeInputRecord {
    pub window_id: String,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<DisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub placement: Option<GameWindowPlacementRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tabs: Option<Vec<GameWindowTabRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub active_tab_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameWindowDisplayRemapRecord {
    pub window_id: String,
    pub input: GameWindowUpdateInputRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWorkspaceSlotRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub browser_zoom_percent: Option<f64>,
    pub rect: StateNormalizedRectRecord,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateNormalizedRectRecord {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateMacroRecord {
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
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWebGraphicsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub renderer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub vendor: Option<String>,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgl: String,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgl2: String,
    #[ts(type = "\"available\" | \"unavailable\" | \"unknown\"")]
    pub webgpu: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreStateSnapshotRecord {
    #[serde(default)]
    pub games: Vec<StateGameRecord>,
    #[serde(default)]
    pub roles: Vec<StateRoleRecord>,
    #[serde(default)]
    pub launch_workspaces: Vec<StateLaunchWorkspaceRecord>,
    #[serde(default)]
    pub game_windows: Vec<StateGameWindowRecord>,
    #[serde(default)]
    pub macros: Vec<StateMacroRecord>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_browser_settings: Option<GameBrowserSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub macro_settings: Option<MacroSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_window_preferences: Option<RuntimeWindowPreferencesRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_restore_session: Option<RuntimeRestoreSessionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legal_acceptance: Option<LegalAcceptanceRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub log_level: Option<LogLevel>,
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
        changed_collections: Vec<StateCollection>,
    },
    LogsChanged,
    LogEntriesCaptured {
        entries: Vec<LogEntry>,
    },
    BrowserActions {
        actions: Vec<BrowserActionRequest>,
    },
    CoreEffects {
        effects: Vec<CoreEffectRequest>,
    },
    BrowserStatuses {
        statuses: Vec<BrowserRoleStatusRecord>,
    },
    MacroStatuses {
        reliable: bool,
        statuses: Vec<MacroRunStatus>,
    },
    OverlayChanged {
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
    ChromeProfileImportProgress {
        progress: ChromeProfileImportProgressRecord,
    },
    Shutdown,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserRuntimeCommand {
    Snapshot,
    BeginWorkspace {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "windowId")]
        window_id: Option<String>,
        #[serde(rename = "roleIds")]
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
    RegisterWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    RemoveWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    CreateTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "tabId")]
        tab_id: Option<String>,
        #[ts(rename = "sourceId")]
        source_id: String,
        name: String,
        #[ts(rename = "windowId")]
        window_id: String,
        #[serde(rename = "tabType")]
        #[ts(rename = "tabType", type = "\"role\" | \"workspace\"")]
        tab_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "workspaceId")]
        workspace_id: Option<String>,
        #[serde(rename = "roleIds")]
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
    RemoveTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ActivateTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ShowWindow {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    ActivateAdjacentTab {
        #[ts(rename = "windowId")]
        window_id: String,
        #[ts(type = "\"next\" | \"previous\"")]
        direction: String,
    },
    HideTab {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    ReorderTab {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "beforeTabId")]
        before_tab_id: Option<String>,
    },
    CommitTabDragTopology {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "sourceWindowId")]
        source_window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "targetWindowId")]
        target_window_id: Option<String>,
        #[ts(rename = "sourceBeforeTabIds")]
        source_before_tab_ids: Vec<String>,
        #[ts(rename = "sourceAfterTabIds")]
        source_after_tab_ids: Vec<String>,
        #[ts(rename = "targetBeforeTabIds")]
        target_before_tab_ids: Vec<String>,
        #[ts(rename = "targetAfterTabIds")]
        target_after_tab_ids: Vec<String>,
    },
    MoveTab {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "windowId")]
        window_id: String,
    },
    MoveWindowTabs {
        #[ts(rename = "sourceWindowId")]
        source_window_id: String,
        #[ts(rename = "targetWindowId")]
        target_window_id: String,
    },
    RoleTransition {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "\"embedded\"")]
        runtime: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "workspaceId")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "tabId")]
        tab_id: Option<String>,
        #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "launchedAt")]
        launched_at: Option<String>,
    },
    RemoveRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    SetWorkspaceState {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
        state: String,
    },
    RemoveWorkspace {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeWindowRecord {
    pub window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
    pub tab_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeTabRecord {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub window_id: String,
    #[serde(rename = "tabType")]
    #[ts(rename = "tabType", type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    pub role_ids: Vec<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeRoleRecord {
    pub role_id: String,
    #[ts(type = "\"embedded\"")]
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab_id: Option<String>,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launched_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeWorkspaceRecord {
    pub workspace_id: String,
    pub name: String,
    #[ts(type = "\"pending\" | \"embedded\"")]
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub window_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tab_id: Option<String>,
    pub role_ids: Vec<String>,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeSnapshot {
    pub windows: Vec<BrowserRuntimeWindowRecord>,
    pub roles: Vec<BrowserRuntimeRoleRecord>,
    pub tabs: Vec<BrowserRuntimeTabRecord>,
    pub workspaces: Vec<BrowserRuntimeWorkspaceRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserRuntimeResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_tab_id: Option<String>,
    pub snapshot: BrowserRuntimeSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserOperationRequest {
    pub role_ids: Vec<String>,
    #[ts(type = "\"normal\" | \"recoverableMutation\" | \"destructiveMutation\"")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserOperationLease {
    pub id: String,
    pub role_ids: Vec<String>,
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
pub struct WorkspaceDividerDescriptor {
    #[ts(type = "\"horizontal\" | \"vertical\"")]
    pub axis: String,
    pub before_role_ids: Vec<String>,
    pub after_role_ids: Vec<String>,
    pub default_position: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDividerResizeInput {
    pub roles: Vec<LayoutRoleInput>,
    pub dividers: Vec<WorkspaceDividerDescriptor>,
    pub divider_index: u32,
    pub requested_position: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_position: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDividerResizeOutput {
    pub changed: bool,
    pub position: f64,
    pub role_ids: Vec<String>,
    pub roles: Vec<LayoutRoleInput>,
}
