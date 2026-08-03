#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CoreCommand {
    Health,
    SystemWebViewProbe,
    SystemWebViewRuntimeRegister {
        registration: SystemWebViewRuntimeRegistrationRecord,
    },
    StateSnapshot,
    GamesList,
    GameGet {
        id: String,
    },
    GameCreate {
        input: GameCreateInputRecord,
    },
    GameUpdate {
        id: String,
        input: GameUpdateInputRecord,
    },
    GameResetBuiltin {
        id: String,
    },
    GameDelete {
        id: String,
    },
    GamesDelete {
        ids: Vec<String>,
    },
    RolesList,
    RoleGet {
        id: String,
    },
    RoleCreate {
        input: RoleCreateInputRecord,
    },
    RoleUpdate {
        id: String,
        input: RoleUpdateInputRecord,
    },
    RoleReorder {
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    RoleDelete {
        id: String,
    },
    RolesDelete {
        ids: Vec<String>,
    },
    RoleBrowserDataClear {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    RoleBrowserDirectoryEnsure {
        id: String,
    },
    RoleBrowserDirectoryReset {
        id: String,
    },
    RolePathsResolve {
        id: String,
    },
    RoleAssignGameIds {
        assignments: Vec<RoleGameAssignmentRecord>,
    },
    ChromeProfileDefaultPath,
    ChromeProfilePreview {
        source_user_data_dir: String,
    },
    ChromeProfileRefresh {
        import_id: String,
    },
    ChromeProfileRequestQuit {
        import_id: String,
    },
    ChromeProfileApply {
        import_id: String,
        game_id: String,
        consent_accepted: bool,
        resolutions: Vec<ChromeProfileImportResolutionRecord>,
    },
    ChromeProfileDiscard {
        import_id: String,
    },
    WorkspacesList,
    WorkspaceGet {
        id: String,
    },
    WorkspaceCreate {
        input: WorkspaceCreateInputRecord,
    },
    WorkspaceUpdate {
        id: String,
        input: WorkspaceUpdateInputRecord,
    },
    WorkspaceReorder {
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    WorkspaceDelete {
        id: String,
    },
    WorkspacesDelete {
        ids: Vec<String>,
    },
    WorkspaceClearRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    WorkspaceSetRoleBrowserZoom {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "browserZoomPercent")]
        browser_zoom_percent: f64,
    },
    GameWindowsList,
    GameWindowGet {
        id: String,
    },
    GameWindowCreate {
        input: GameWindowCreateInputRecord,
    },
    GameWindowSaveRuntime {
        input: GameWindowSaveRuntimeInputRecord,
    },
    GameWindowUpdate {
        id: String,
        input: GameWindowUpdateInputRecord,
    },
    GameWindowsDisplayRemap {
        updates: Vec<GameWindowDisplayRemapRecord>,
    },
    GameWindowReorder {
        #[ts(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    GameWindowDelete {
        id: String,
    },
    GameWindowDeleteIfUnchanged {
        id: String,
        #[ts(rename = "updatedAt")]
        updated_at: String,
    },
    MacrosList,
    MacroGet {
        id: String,
    },
    MacroCreate {
        input: MacroCreateInputRecord,
    },
    MacroUpdate {
        id: String,
        input: MacroUpdateInputRecord,
    },
    MacroDelete {
        id: String,
    },
    MacrosDelete {
        ids: Vec<String>,
    },
    MacrosClearRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    GameBrowserSettingsGet,
    GameBrowserSettingsReplace {
        settings: GameBrowserSettingsRecord,
    },
    GameBrowserSettingsPatch {
        patch: GameBrowserSettingsPatchRecord,
    },
    BrowserFontCatalogList,
    BrowserFontPackInstall {
        #[ts(rename = "catalogId")]
        catalog_id: String,
    },
    BrowserFontFamilyInstall {
        family: String,
    },
    BrowserFontPackRemove {
        #[ts(rename = "catalogId")]
        catalog_id: String,
    },
    BrowserFontRuntimePayload {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        settings: Option<BrowserFontSettingsRecord>,
    },
    MacroSettingsGet,
    MacroSettingsReplace {
        settings: MacroSettingsRecord,
    },
    RuntimeWindowPreferencesGet,
    RuntimeWindowPreferencesReplace {
        preferences: RuntimeWindowPreferencesRecord,
    },
    RuntimeRestoreSessionGet,
    RuntimeRestoreSessionReplace {
        session: RuntimeRestoreSessionRecord,
    },
    LegalAcceptanceStatus,
    LegalAcceptanceAccept {
        input: LegalAcceptDocumentsInputRecord,
    },
    SystemFontsList,
    WindowsGraphicsEventsCollect {
        since: String,
    },
    PortableExport {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        preferences: Option<PortablePreferencesRecord>,
        selection: PortableDataSelectionRecord,
    },
    PortableExportTo {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        preferences: Option<PortablePreferencesRecord>,
        selection: PortableDataSelectionRecord,
    },
    PortablePreview {
        #[serde(rename = "rawJson")]
        #[ts(rename = "rawJson")]
        raw_json: String,
        #[serde(rename = "filePath")]
        #[ts(rename = "filePath")]
        file_path: String,
    },
    PortablePreviewFile {
        path: String,
    },
    PortableApply {
        #[serde(rename = "importId")]
        #[ts(rename = "importId")]
        import_id: String,
        selection: PortableDataSelectionRecord,
        #[serde(default)]
        resolutions: Vec<PortableMacroConflictResolutionRecord>,
    },
    PortableDiscard {
        #[serde(rename = "importId")]
        #[ts(rename = "importId")]
        import_id: String,
    },
    LayoutResolve {
        input: WorkspaceLayoutInput,
    },
    LayoutNormalizeRects {
        rects: Vec<LayoutRect>,
    },
    LayoutCreateDividers {
        roles: Vec<LayoutRoleInput>,
    },
    LayoutResizeDivider {
        input: WorkspaceDividerResizeInput,
    },
    LayoutAdaptiveZoom {
        #[ts(rename = "viewportWidth")]
        viewport_width: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "currentPercent")]
        current_percent: Option<u32>,
    },
    EmbeddedKeyPrepare {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "\"hold\" | \"release\" | \"tap\"")]
        phase: String,
        code: String,
        #[ts(rename = "modifierCodes")]
        modifier_codes: Vec<String>,
        #[ts(rename = "ownerId")]
        owner_id: String,
    },
    EmbeddedKeyComplete {
        #[ts(rename = "transitionId")]
        transition_id: String,
        succeeded: bool,
    },
    EmbeddedKeysReassert {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    EmbeddedKeysHeld {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    EmbeddedKeysClear {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    LogsCapture {
        entries: Vec<LogCaptureRecord>,
    },
    LogsSetLevel {
        level: LogLevel,
    },
    LogsQuery {
        query: LogQuery,
    },
    LogsClear,
    LogsStatus,
    LogsExportTo {
        path: String,
    },
    DiagnosticsExport {
        path: String,
        snapshot: Box<ApplicationDiagnosticsSnapshotRecord>,
    },
    TelemetryRecord {
        sample: TelemetrySampleRecord,
    },
    TelemetrySnapshot,
    OverlayRequest {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "requestJson")]
        request_json: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        language: Option<String>,
    },
    OverlayLanguageSet {
        #[ts(type = "\"en\" | \"zh-TW\" | \"zh-CN\" | \"ja\"")]
        language: String,
    },
    RuntimeThemeSet {
        #[ts(type = "\"light\" | \"dark\"")]
        theme: String,
    },
    MacroStart {
        request: MacroInvocationRequest,
    },
    MacroPress {
        request: MacroPressInvocationRequest,
    },
    MacroRelease {
        request: MacroReleaseRequest,
    },
    MacroStop {
        #[ts(rename = "macroId")]
        macro_id: String,
    },
    MacroStopForRole {
        #[ts(rename = "macroId")]
        macro_id: String,
        #[ts(rename = "sourceRoleId")]
        source_role_id: String,
    },
    MacroStopRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    MacroReleaseRole {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    MacroInputFence {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    MacroInputDrain {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "number", rename = "inputEpoch")]
        input_epoch: u64,
    },
    MacroInputResume {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "number", rename = "inputEpoch")]
        input_epoch: u64,
    },
    MacroStatuses,
    OperationCancel {
        #[ts(rename = "operationId")]
        operation_id: String,
    },
    CoreEffectMetrics,
    EmbeddedRoleLaunch {
        #[ts(rename = "roleId")]
        role_id: String,
        target: EmbeddedLaunchTargetRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "zoomFactor")]
        zoom_factor: Option<f64>,
    },
    EmbeddedWorkspaceLaunch {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        target: EmbeddedLaunchTargetRecord,
    },
    EmbeddedRoleStop {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    EmbeddedWorkspaceStop {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
    },
    EmbeddedSystemSurfaceFailed {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    EmbeddedSystemSurfaceRecovered {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    EmbeddedWindowRegister {
        target: EmbeddedLaunchTargetRecord,
    },
    EmbeddedWindowDelete {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    EmbeddedWindowsShow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "windowId")]
        window_id: Option<String>,
    },
    EmbeddedTabActivate {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    EmbeddedTabActivateConditional {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "windowId")]
        window_id: String,
        #[ts(type = "number", rename = "selectionRevision")]
        selection_revision: u64,
    },
    EmbeddedTabActivateAdjacent {
        #[ts(rename = "windowId")]
        window_id: String,
        #[ts(type = "\"next\" | \"previous\"")]
        direction: String,
    },
    EmbeddedTabHide {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    EmbeddedTabReorder {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "beforeTabId")]
        before_tab_id: Option<String>,
    },
    EmbeddedTabMove {
        #[ts(rename = "tabId")]
        tab_id: String,
        target: EmbeddedLaunchTargetRecord,
    },
    EmbeddedTabMoveOrdered {
        #[ts(rename = "tabId")]
        tab_id: String,
        target: EmbeddedLaunchTargetRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "beforeTabId")]
        before_tab_id: Option<String>,
    },
    EmbeddedTabMutation {
        request: RuntimeTabMutationRequestRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target: Option<EmbeddedLaunchTargetRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "beforeTabId")]
        before_tab_id: Option<String>,
    },
    EmbeddedTabStop {
        request: RuntimeTabMutationRequestRecord,
        #[ts(rename = "sourceId")]
        source_id: String,
        #[ts(rename = "tabType", type = "\"role\" | \"workspace\"")]
        tab_type: String,
    },
    BrowserRoleLaunch {
        #[ts(rename = "roleId")]
        role_id: String,
        target: EmbeddedLaunchTargetRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "zoomFactor")]
        zoom_factor: Option<f64>,
    },
    BrowserWorkspaceLaunch {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        target: EmbeddedLaunchTargetRecord,
    },
    BrowserRoleStop {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    BrowserWorkspaceStop {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
    },
    BrowserWindowStop {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    BrowserWindowDelete {
        #[ts(rename = "windowId")]
        window_id: String,
    },
    BrowserStatuses,
    BrowserWorkspaceStatuses,
    BrowserRuntimeSnapshot,
    BrowserRuntimeSuspend {
        suspended: bool,
    },
}

impl CoreCommand {
    pub fn requires_async_dispatch(&self) -> bool {
        matches!(
            self,
            Self::GameDelete { .. }
                | Self::GamesDelete { .. }
                | Self::RoleCreate { .. }
                | Self::RoleUpdate { .. }
                | Self::RoleDelete { .. }
                | Self::RolesDelete { .. }
                | Self::RoleBrowserDataClear { .. }
                | Self::ChromeProfileRequestQuit { .. }
                | Self::ChromeProfileApply { .. }
                | Self::WorkspaceCreate { .. }
                | Self::WorkspaceUpdate { .. }
                | Self::WorkspaceDelete { .. }
                | Self::WorkspacesDelete { .. }
                | Self::MacroCreate { .. }
                | Self::MacroUpdate { .. }
                | Self::MacroDelete { .. }
                | Self::MacrosDelete { .. }
                | Self::DiagnosticsExport { .. }
                | Self::OverlayRequest { .. }
                | Self::BrowserRoleLaunch { .. }
                | Self::BrowserWorkspaceLaunch { .. }
                | Self::BrowserRoleStop { .. }
                | Self::BrowserWorkspaceStop { .. }
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableDataSelectionRecord {
    pub games: bool,
    pub roles: bool,
    pub launch_workspaces: bool,
    #[serde(default)]
    pub game_windows: bool,
    pub macros: bool,
    pub preferences: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum PortableMacroConflictResolutionRecord {
    Update {
        #[serde(rename = "conflictId")]
        #[ts(rename = "conflictId")]
        conflict_id: String,
        #[serde(rename = "targetMacroId")]
        #[ts(rename = "targetMacroId")]
        target_macro_id: String,
    },
    Copy {
        #[serde(rename = "conflictId")]
        #[ts(rename = "conflictId")]
        conflict_id: String,
    },
    Skip {
        #[serde(rename = "conflictId")]
        #[ts(rename = "conflictId")]
        conflict_id: String,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortablePreferencesRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_browser_settings: Option<GameBrowserSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"en\" | \"zh-TW\" | \"zh-CN\" | \"ja\"")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub macro_settings: Option<MacroSettingsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"system\" | \"light\" | \"dark\"")]
    pub theme_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableGameRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inferred: Option<bool>,
    #[ts(type = "\"builtin\" | \"custom\"")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"flyff-universe\" | \"feifei-infinite-universe\"")]
    pub builtin_key: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableRoleRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_recovered: Option<bool>,
    pub name: String,
    pub launch_url: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_dominant_color: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableLaunchWorkspaceRecord {
    pub id: String,
    pub name: String,
    #[ts(
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: String,
    pub slots: Vec<StateWorkspaceSlotRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableGameWindowRecord {
    pub id: String,
    pub name: String,
    pub target_display: DisplayTargetRecord,
    pub placement: GameWindowPlacementRecord,
    #[serde(default)]
    pub tabs: Vec<GameWindowTabRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableMacroRecord {
    pub id: String,
    pub enabled: bool,
    #[ts(type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: String,
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
