use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCoreOptions {
    pub user_data_dir: String,
    pub platform: String,
    pub app_version: String,
    #[serde(default)]
    pub performance_telemetry_path: Option<String>,
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
    RoleSetBrowserSessionSource {
        id: String,
        #[ts(type = "\"embedded\" | \"chrome-profile\"")]
        source: String,
    },
    RoleAssignGameIds {
        assignments: Vec<RoleGameAssignmentRecord>,
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
    WorkspaceReconcileDisplays {
        displays: Vec<WorkspaceDisplayInfoRecord>,
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
    CompatibilityReportRecordObservation {
        #[ts(rename = "gameId")]
        game_id: String,
        observation: StateCompatibilityObservationsRecord,
    },
    CompatibilityReportDelete {
        #[ts(rename = "gameId")]
        game_id: String,
    },
    CompatibilityStatuses,
    CompatibilityPrepare {
        #[ts(rename = "gameId")]
        game_id: String,
        #[ts(rename = "systemChromeAvailable")]
        system_chrome_available: bool,
        versions: CompatibilityVersionRecord,
    },
    CompatibilityTransition {
        #[ts(rename = "gameId")]
        game_id: String,
        phase: CompatibilityRunPhase,
    },
    CompatibilityComplete {
        #[ts(rename = "gameId")]
        game_id: String,
        outcome: CompatibilityCheckOutcome,
    },
    CompatibilityCancel {
        #[ts(rename = "gameId")]
        game_id: String,
    },
    CompatibilityReportsCurrent {
        versions: CompatibilityVersionRecord,
    },
    CompatibilityRun {
        #[ts(rename = "gameId")]
        game_id: String,
        versions: CompatibilityVersionRecord,
    },
    GameBrowserSettingsGet,
    GameBrowserSettingsReplace {
        settings: GameBrowserSettingsRecord,
    },
    MacroSettingsGet,
    MacroSettingsReplace {
        settings: MacroSettingsRecord,
    },
    RuntimeWindowPreferencesGet,
    RuntimeWindowPreferencesReplace {
        preferences: RuntimeWindowPreferencesRecord,
    },
    LegalAcceptanceStatus {
        versions: LegalDocumentVersionsRecord,
    },
    LegalAcceptanceAccept {
        versions: LegalDocumentVersionsRecord,
        input: LegalAcceptDocumentsInputRecord,
    },
    BrowserPreferencesApply {
        #[ts(rename = "browserUserDataDir")]
        browser_user_data_dir: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "roleSessionPartition")]
        role_session_partition: Option<String>,
        fonts: BrowserFontSettingsRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "zoomFactor")]
        zoom_factor: Option<f64>,
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
    CdnResolveSession {
        #[ts(rename = "sessionHandleId")]
        session_handle_id: String,
    },
    GraphicsDiagnosticsAssemble {
        #[ts(rename = "appliedSettings")]
        applied_settings: BrowserGraphicsSettingsRecord,
        #[ts(rename = "embeddedRawJson")]
        embedded_raw_json: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "embeddedError")]
        embedded_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "gpuInfoRawJson")]
        gpu_info_raw_json: Option<String>,
        #[ts(rename = "featureStatusRawJson")]
        feature_status_raw_json: String,
        #[ts(rename = "gpuInfoReady")]
        gpu_info_ready: bool,
        #[serde(default)]
        #[ts(type = "boolean | null", rename = "hardwareAccelerationEnabled")]
        hardware_acceleration_enabled: Option<bool>,
        platform: String,
        versions: GraphicsVersionRecord,
    },
    ResourceResolve {
        input: ResourcePolicyInput,
    },
    LayoutResolve {
        input: WorkspaceLayoutInput,
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
        snapshot: ElectronDiagnosticsSnapshotRecord,
    },
    TelemetryRecord {
        sample: TelemetrySampleRecord,
    },
    TelemetrySnapshot,
    SystemChromeClose,
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
        #[ts(rename = "roleId")]
        role_id: String,
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
    ResourceActivateWorkspace {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        #[ts(rename = "policyMode", type = "\"unrestricted\" | \"adaptive\"")]
        policy_mode: String,
        targets: Vec<ResourceRuntimeTargetRecord>,
    },
    ResourceDeactivateWorkspace {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
    },
    ResourceRefreshTarget {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "processId")]
        process_id: Option<u32>,
    },
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
    ExternalProcessLaunch {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "executablePath")]
        executable_path: String,
        arguments: Vec<String>,
    },
    ExternalProcessTerminate {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    ChromeProfileDefaultPath,
    ChromeProfilePreview {
        #[ts(rename = "sourceUserDataDir")]
        source_user_data_dir: String,
    },
    ChromeProfilePrepare {
        #[ts(rename = "importId")]
        import_id: String,
        #[ts(rename = "profileIds")]
        profile_ids: Vec<String>,
        #[ts(rename = "gameId")]
        game_id: String,
        #[ts(rename = "consentAccepted")]
        consent_accepted: bool,
    },
    ChromeProfileApply {
        #[ts(rename = "importId")]
        import_id: String,
        #[ts(rename = "profileIds")]
        profile_ids: Vec<String>,
        #[ts(rename = "gameId")]
        game_id: String,
        #[ts(rename = "consentAccepted")]
        consent_accepted: bool,
    },
    ChromeProfileCommit {
        #[ts(rename = "importId")]
        import_id: String,
    },
    ChromeProfileFinalize {
        #[ts(rename = "importId")]
        import_id: String,
    },
    ChromeProfileRollback {
        #[ts(rename = "importId")]
        import_id: String,
    },
    ChromeProfileDiscard {
        #[ts(rename = "importId")]
        import_id: String,
    },
    ChromeProfileReadCookies {
        #[ts(rename = "browserUserDataDir")]
        browser_user_data_dir: String,
    },
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
    EmbeddedWindowsShow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "displayId", type = "number")]
        display_id: Option<i64>,
    },
    EmbeddedTabActivate {
        #[ts(rename = "tabId")]
        tab_id: String,
    },
    EmbeddedTabActivateAdjacent {
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
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
    EmbeddedDisplayRemove {
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
        fallback: EmbeddedLaunchTargetRecord,
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
    BrowserExternalRecover {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    BrowserStatuses,
    BrowserWorkspaceStatuses,
    BrowserRuntimeSuspend {
        suspended: bool,
    },
    ExternalDiagnosticsCapture {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    ExternalDiagnosticsList,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableDataSelectionRecord {
    pub games: bool,
    pub roles: bool,
    pub launch_workspaces: bool,
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
    #[ts(type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\"")]
    pub browser_launch_mode: String,
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
    #[ts(type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\"")]
    pub browser_launch_mode: String,
    #[ts(type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: String,
    #[ts(type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: f64,
    pub resource_policy: StateWorkspaceResourcePolicyRecord,
    pub slots: Vec<StateWorkspaceSlotRecord>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableDataRecord {
    #[ts(type = "\"Rion Studio\"")]
    pub app: String,
    #[ts(type = "6")]
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub games: Vec<PortableGameRecord>,
    pub roles: Vec<PortableRoleRecord>,
    pub launch_workspaces: Vec<PortableLaunchWorkspaceRecord>,
    pub macros: Vec<PortableMacroRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportOperationSummaryRecord {
    pub create: u32,
    pub update: u32,
    pub unchanged: u32,
    pub skip: u32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportOperationsRecord {
    pub games: PortableImportOperationSummaryRecord,
    pub roles: PortableImportOperationSummaryRecord,
    pub launch_workspaces: PortableImportOperationSummaryRecord,
    pub macros: PortableImportOperationSummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportWarningRecord {
    #[ts(
        type = "\"GAME_NAME_RENAMED\" | \"BUILTIN_GAME_DEFAULTS_REPLACED\" | \"ROLE_GAME_RECOVERED\" | \"ROLE_NAME_RENAMED\" | \"WORKSPACE_NAME_RENAMED\" | \"WORKSPACE_ROLE_MISSING\" | \"MACRO_NAME_RENAMED\" | \"MACRO_ROLE_MISSING\" | \"MACRO_SHORTCUT_CLEARED_CONFLICT\" | \"MACRO_SHORTCUT_CLEARED_RESERVED\" | \"MACRO_SKIPPED_NO_ROLES\" | \"MACRO_SKIPPED_MISSING_DEPENDENCY\""
    )]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replacement_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableMacroConflictCandidateRecord {
    pub id: String,
    pub name: String,
    pub role_names: Vec<String>,
    pub step_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableMacroConflictRecord {
    pub id: String,
    pub macro_id: String,
    pub name: String,
    pub role_names: Vec<String>,
    pub candidates: Vec<PortableMacroConflictCandidateRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportPreviewRecord {
    pub import_id: String,
    pub file_path: String,
    pub exported_at: String,
    pub app_version: String,
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub macro_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
    pub operations: PortableImportOperationsRecord,
    pub conflicts: Vec<PortableMacroConflictRecord>,
    pub warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableImportResultRecord {
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub macro_count: u32,
    pub preferences_included: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferences: Option<PortablePreferencesRecord>,
    pub selection: PortableDataSelectionRecord,
    pub operations: PortableImportOperationsRecord,
    pub warnings: Vec<PortableImportWarningRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PortableExportResultRecord {
    pub file_path: String,
    pub game_count: u32,
    pub role_count: u32,
    pub workspace_count: u32,
    pub macro_count: u32,
    pub preferences_included: bool,
    pub selection: PortableDataSelectionRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileEntryRecord {
    pub id: String,
    pub directory_name: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportWarningRecord {
    #[ts(
        type = "\"unsupported_platform\" | \"source_invalid\" | \"chrome_running\" | \"profile_invalid\" | \"profile_selection_empty\" | \"passwords_excluded\" | \"name_renamed\""
    )]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replacement_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportPreviewRecord {
    pub import_id: String,
    pub source_label: String,
    pub profiles: Vec<ChromeProfileEntryRecord>,
    pub warnings: Vec<ChromeProfileImportWarningRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportRequest {
    pub import_id: String,
    pub profile_ids: Vec<String>,
    pub game_id: String,
    pub consent_accepted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportResultRecord {
    pub roles: Vec<StateRoleRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportProgressRecord {
    pub completed_profile_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_profile_name: Option<String>,
    pub import_id: String,
    #[ts(type = "\"preparing\" | \"importing\" | \"completed\"")]
    pub phase: String,
    pub total_profile_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportPrepareRecord {
    pub overwritten_role_ids: Vec<String>,
    pub profiles: Vec<ChromeProfileEntryRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportedSessionRecord {
    pub profile_id: String,
    pub profile_name: String,
    pub browser_user_data_dir: String,
    pub role: StateRoleRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportCommitRecord {
    pub roles: Vec<StateRoleRecord>,
    pub sessions: Vec<ChromeProfileImportedSessionRecord>,
}

/// Renderer-facing game creation contract. The similarly named `*InputRecord`
/// types below are private command payloads and may contain presence flags used
/// to preserve `undefined` versus `null` across Node-API.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameCreateRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    pub default_launch_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\""
    )]
    pub browser_launch_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\""
    )]
    pub browser_launch_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleCreateRequest {
    pub game_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_dominant_color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub cover_image_dominant_color: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RolePathsRecord {
    pub browser_user_data_dir: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceSlotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rect: Option<StateNormalizedRectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceCreateRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\""
    )]
    pub browser_launch_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_policy: Option<StateWorkspaceResourcePolicyRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotRequest>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"single\" | \"two_columns\" | \"three_columns\" | \"main_left_stack_right\" | \"main_right_stack_left\" | \"main_center_side_stacks\" | \"three_top_two_bottom\" | \"two_top_three_bottom\" | \"quad\" | \"four_columns\" | \"six_grid\" | \"eight_grid\" | \"nine_grid\""
    )]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\""
    )]
    pub browser_launch_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_policy: Option<StateWorkspaceResourcePolicyRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotRequest>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroCreateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    pub steps: Vec<MacroStepDefinition>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroUpdateRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"toggle\" | \"while_held\"")]
    pub activation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steps: Option<Vec<MacroStepDefinition>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameCreateInputRecord {
    pub name: String,
    pub default_launch_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_launch_mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default_launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_image_data_url: Option<String>,
    #[serde(default)]
    pub set_icon_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub set_cover_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_launch_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleCreateInputRecord {
    pub game_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_dominant_color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub game_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launch_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_data_url: Option<String>,
    #[serde(default)]
    pub set_cover_image_data_url: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cover_image_dominant_color: Option<String>,
    #[serde(default)]
    pub set_cover_image_dominant_color: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RoleGameAssignmentRecord {
    pub role_id: String,
    pub game_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceSlotInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rect: Option<StateNormalizedRectRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceCreateInputRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_launch_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_policy: Option<StateWorkspaceResourcePolicyRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotInputRecord>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_launch_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource_policy: Option<StateWorkspaceResourcePolicyRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    #[serde(default)]
    pub set_target_display: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slots: Option<Vec<WorkspaceSlotInputRecord>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceDisplayInfoRecord {
    #[ts(type = "number")]
    pub id: i64,
    pub label: String,
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
    pub is_primary: bool,
    pub is_internal: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum MacroStepInputRecord {
    Key {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        code: String,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        action: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
    Click {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        ms: u32,
    },
    Macro {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
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
pub struct MacroCreateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_mode: Option<String>,
    pub name: String,
    pub role_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    pub steps: Vec<MacroStepInputRecord>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroUpdateInputRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activation_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    #[serde(default)]
    pub set_trigger: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub repeat: Option<MacroRepeat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steps: Option<Vec<MacroStepInputRecord>>,
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
    #[ts(type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\"")]
    pub browser_launch_mode: String,
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
    #[ts(optional, type = "\"embedded\" | \"chrome-profile\"")]
    pub browser_session_source: Option<String>,
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
    #[ts(type = "\"auto\" | \"embedded\" | \"external\" | \"inherit\"")]
    pub browser_launch_mode: String,
    #[ts(type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: String,
    #[ts(type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: f64,
    pub resource_policy: StateWorkspaceResourcePolicyRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    pub slots: Vec<StateWorkspaceSlotRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWorkspaceResourcePolicyRecord {
    #[ts(type = "\"unrestricted\" | \"adaptive\"")]
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWorkspaceDisplayTargetRecord {
    #[ts(type = "number")]
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fingerprint: Option<StateWorkspaceDisplayFingerprintRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateWorkspaceDisplayFingerprintRecord {
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trigger: Option<MacroTrigger>,
    pub repeat: MacroRepeat,
    pub steps: Vec<MacroStepDefinition>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateCompatibilityReportRecord {
    pub game_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub configuration_fingerprint: Option<String>,
    pub is_stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub load: Option<StateCompatibilityLoadRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub graphics: Option<StateWebGraphicsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub system_chrome: Option<StateCompatibilityChromeRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recommendation: Option<StateCompatibilityRecommendationRecord>,
    pub observations: StateCompatibilityObservationsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateCompatibilityLoadRecord {
    #[ts(type = "\"available\" | \"failed\" | \"cancelled\"")]
    pub state: String,
    #[ts(type = "number")]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub final_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub error_code: Option<String>,
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateCompatibilityChromeRecord {
    #[ts(type = "\"available\" | \"unavailable\"")]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateCompatibilityRecommendationRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"auto\" | \"embedded\" | \"external\"")]
    pub mode: Option<String>,
    #[ts(
        type = "\"embedded_available\" | \"external_recommended\" | \"chrome_required\" | \"graphics_unavailable\""
    )]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct StateCompatibilityObservationsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub last_embedded_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub last_external_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub last_fallback_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub last_launch_failure_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub last_launch_failure_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CompatibilityRunPhase {
    Preparing,
    Loading,
    Probing,
    CleaningUp,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibilityRunStatusRecord {
    pub game_id: String,
    pub phase: CompatibilityRunPhase,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibilityVersionRecord {
    pub chrome: String,
    pub electron: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CompatibilityCheckPlanRecord {
    pub game_id: String,
    pub game_name: String,
    pub launch_url: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumSwitchRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BootstrapPlanRecord {
    pub applied_graphics_settings: BrowserGraphicsSettingsRecord,
    pub switches: Vec<ChromiumSwitchRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CdnResolutionRecord {
    pub enabled: bool,
    pub request_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsVersionRecord {
    pub chromium: String,
    pub electron: String,
    pub node: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsDeviceDiagnosticsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_id: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub device_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub driver_vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub driver_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vendor_id: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vendor_string: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalGraphicsDiagnosticsRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub probe: Option<StateWebGraphicsRecord>,
    pub role_id: String,
    pub role_name: String,
    #[ts(type = "\"ready\" | \"unavailable\"")]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsDiagnosticsRecord {
    pub applied_settings: BrowserGraphicsSettingsRecord,
    pub applied_switches: Vec<String>,
    pub collected_at: String,
    pub embedded: StateWebGraphicsRecord,
    pub external_roles: Vec<ExternalGraphicsDiagnosticsRecord>,
    pub feature_status: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gpu_device: Option<GraphicsDeviceDiagnosticsRecord>,
    pub gpu_info_ready: bool,
    #[ts(type = "boolean | null")]
    pub hardware_acceleration_enabled: Option<bool>,
    pub platform: String,
    pub restart_required: bool,
    pub saved_settings: BrowserGraphicsSettingsRecord,
    pub versions: GraphicsVersionRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum CompatibilityCheckOutcome {
    Loaded {
        #[ts(type = "number")]
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        final_origin: Option<String>,
        graphics: StateWebGraphicsRecord,
    },
    Failed {
        #[ts(type = "number")]
        duration_ms: u64,
        error_code: String,
    },
    Cancelled {
        #[ts(type = "number")]
        duration_ms: u64,
    },
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
    pub macros: Vec<StateMacroRecord>,
    #[serde(default)]
    pub compatibility_reports: Vec<StateCompatibilityReportRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub legal_acceptance: Option<LegalAcceptanceRecord>,
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
    LogEntriesCaptured {
        entries: Vec<LogEntry>,
    },
    PressureChanged {
        snapshot: SystemPressureSnapshot,
    },
    BrowserActions {
        actions: Vec<BrowserActionRequest>,
    },
    CoreEffects {
        effects: Vec<CoreEffectRequest>,
    },
    ChromeProfileImportProgress {
        progress: ChromeProfileImportProgressRecord,
    },
    BrowserStatuses {
        statuses: Vec<BrowserRoleStatusRecord>,
    },
    MacroStatuses {
        statuses: Vec<MacroRunStatus>,
    },
    ResourceStatuses {
        statuses: Vec<ResourceRuntimeStatusRecord>,
    },
    CompatibilityStatuses {
        statuses: Vec<CompatibilityRunStatusRecord>,
    },
    ExternalProcessExited {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "exitCode")]
        exit_code: Option<i32>,
        terminated: bool,
    },
    ExternalHealthChanged {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "\"healthy\" | \"unresponsive\"")]
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
        #[ts(optional, rename = "displayId", type = "number")]
        display_id: Option<i64>,
        #[serde(rename = "roleIds")]
        #[ts(rename = "roleIds")]
        role_ids: Vec<String>,
    },
    RegisterDisplay {
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
    },
    CreateTab {
        #[ts(rename = "sourceId")]
        source_id: String,
        name: String,
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
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
    CreateExternalWorkspace {
        #[ts(rename = "workspaceId")]
        workspace_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "displayId", type = "number")]
        display_id: Option<i64>,
        #[serde(default)]
        #[ts(rename = "exclusiveDisplay")]
        exclusive_display: bool,
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
    ShowDisplay {
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
    },
    ActivateAdjacentTab {
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
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
    MoveTab {
        #[ts(rename = "tabId")]
        tab_id: String,
        #[ts(rename = "displayId")]
        #[ts(type = "number")]
        display_id: i64,
    },
    MoveDisplayTabs {
        #[ts(rename = "sourceDisplayId")]
        #[ts(type = "number")]
        source_display_id: i64,
        #[ts(rename = "targetDisplayId")]
        #[ts(type = "number")]
        target_display_id: i64,
    },
    RoleTransition {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(type = "\"embedded\" | \"external\"")]
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
pub struct BrowserRuntimeDisplayRecord {
    #[ts(type = "number")]
    pub display_id: i64,
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
    #[ts(type = "number")]
    pub display_id: i64,
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
    #[ts(type = "\"embedded\" | \"external\"")]
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
    #[ts(type = "\"pending\" | \"embedded\" | \"external\"")]
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub display_id: Option<i64>,
    pub exclusive_display: bool,
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
    pub displays: Vec<BrowserRuntimeDisplayRecord>,
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
    #[ts(type = "\"baseline\" | \"cpu\" | \"memory\" | \"thermal\"")]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourcePolicyInput {
    #[ts(type = "\"unrestricted\" | \"adaptive\"")]
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
    #[ts(type = "1 | 2 | 4")]
    pub cpu_throttle_rate: u8,
    #[ts(type = "\"full_speed\" | \"throttled\" | \"macro_override\" | \"shared_process\"")]
    pub resource_state: String,
    #[ts(
        type = "\"macro\" | \"shared_process\" | \"system_pressure\" | \"runtime_tab_background\" | null"
    )]
    pub resource_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ResourceRuntimeCommand {
    Snapshot,
    ActivateWorkspace {
        workspace_id: String,
        #[ts(type = "\"unrestricted\" | \"adaptive\"")]
        policy_mode: String,
        targets: Vec<ResourceRuntimeTargetRecord>,
    },
    DeactivateWorkspace {
        workspace_id: String,
    },
    SetMacroRoleIds {
        role_ids: Vec<String>,
    },
    SetHiddenWorkspaceIds {
        workspace_ids: Vec<String>,
    },
    PrepareWorkspaceForeground {
        workspace_id: String,
    },
    ReconcileRuntimeRoleIds {
        #[ts(type = "\"embedded\" | \"external\"")]
        runtime_mode: String,
        active_role_ids: Vec<String>,
    },
    RefreshTarget {
        workspace_id: String,
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        process_id: Option<u32>,
    },
    SetPressure {
        level: PressureLevel,
        reason: String,
    },
    SetUnavailableRoleIds {
        role_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourceRuntimeTargetRecord {
    pub role_id: String,
    #[ts(type = "\"embedded\" | \"external\"")]
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourceRuntimeEffectRecord {
    pub role_ids: Vec<String>,
    #[ts(type = "1 | 2 | 4")]
    pub cpu_throttle_rate: u8,
    pub release: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourceRuntimeStatusRecord {
    pub role_id: String,
    #[ts(type = "\"throttled\" | \"macro_override\" | \"shared_process\" | \"unavailable\"")]
    pub resource_state: String,
    #[ts(type = "1 | 2 | 4")]
    pub cpu_throttle_rate: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"normal\" | \"constrained\"")]
    pub resource_pressure_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"baseline\" | \"cpu\" | \"memory\" | \"thermal\" | \"macro\" | \"shared_process\" | \"runtime_tab_background\" | \"unavailable\""
    )]
    pub resource_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ResourceRuntimeResult {
    pub effects: Vec<ResourceRuntimeEffectRecord>,
    pub statuses: Vec<ResourceRuntimeStatusRecord>,
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GameBrowserSettingsRecord {
    pub fonts: BrowserFontSettingsRecord,
    pub graphics: BrowserGraphicsSettingsRecord,
    #[ts(type = "\"auto\" | \"embedded\" | \"external\"")]
    pub launch_mode: String,
    pub macro_badge_position: MacroBadgePositionRecord,
    pub network: BrowserNetworkSettingsRecord,
    pub workspace: WorkspaceAppearanceSettingsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserFontSettingsRecord {
    #[ts(type = "\"default\" | \"custom\"")]
    pub mode: String,
    #[ts(
        type = "Partial<Record<\"standard\" | \"serif\" | \"sansserif\" | \"fixed\" | \"math\", string>>"
    )]
    pub families: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserGraphicsBackendSettingsRecord {
    #[ts(type = "\"automatic\" | \"metal\"")]
    pub macos: String,
    #[ts(type = "\"automatic\" | \"d3d11\" | \"d3d11on12\" | \"vulkan\"")]
    pub windows: String,
}

impl Default for BrowserGraphicsBackendSettingsRecord {
    fn default() -> Self {
        Self {
            macos: "automatic".to_owned(),
            windows: "automatic".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserGraphicsSettingsRecord {
    pub backend: BrowserGraphicsBackendSettingsRecord,
    pub driver_bug_workarounds_enabled: bool,
    pub force_gpu_rasterization: bool,
    pub frame_rate_limit_enabled: bool,
    pub gpu_blocklist_enabled: bool,
    pub prefer_high_performance_gpu: bool,
    pub unsafe_web_gpu_enabled: bool,
    pub vsync_enabled: bool,
}

impl BrowserGraphicsSettingsRecord {
    pub fn aggressive_default() -> Self {
        Self {
            backend: BrowserGraphicsBackendSettingsRecord::default(),
            driver_bug_workarounds_enabled: true,
            force_gpu_rasterization: true,
            frame_rate_limit_enabled: false,
            gpu_blocklist_enabled: false,
            prefer_high_performance_gpu: true,
            unsafe_web_gpu_enabled: true,
            vsync_enabled: false,
        }
    }

    pub fn from_legacy_mode(mode: &str) -> Self {
        let mut settings = Self {
            backend: BrowserGraphicsBackendSettingsRecord::default(),
            driver_bug_workarounds_enabled: true,
            force_gpu_rasterization: false,
            frame_rate_limit_enabled: true,
            gpu_blocklist_enabled: true,
            prefer_high_performance_gpu: false,
            unsafe_web_gpu_enabled: false,
            vsync_enabled: true,
        };
        if matches!(mode, "high_performance" | "experimental") {
            settings.prefer_high_performance_gpu = true;
        }
        if mode == "experimental" {
            settings.gpu_blocklist_enabled = false;
            settings.unsafe_web_gpu_enabled = true;
        }
        settings
    }
}

impl<'de> Deserialize<'de> for BrowserGraphicsSettingsRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            backend: Option<BrowserGraphicsBackendSettingsRecord>,
            driver_bug_workarounds_enabled: Option<bool>,
            force_gpu_rasterization: Option<bool>,
            frame_rate_limit_enabled: Option<bool>,
            gpu_blocklist_enabled: Option<bool>,
            mode: Option<String>,
            prefer_high_performance_gpu: Option<bool>,
            unsafe_web_gpu_enabled: Option<bool>,
            vsync_enabled: Option<bool>,
        }

        let input = Input::deserialize(deserializer)?;
        let has_new_fields = input.backend.is_some()
            || input.driver_bug_workarounds_enabled.is_some()
            || input.force_gpu_rasterization.is_some()
            || input.frame_rate_limit_enabled.is_some()
            || input.gpu_blocklist_enabled.is_some()
            || input.prefer_high_performance_gpu.is_some()
            || input.unsafe_web_gpu_enabled.is_some()
            || input.vsync_enabled.is_some();
        let mut settings = if has_new_fields {
            Self::aggressive_default()
        } else if let Some(mode) = input.mode.as_deref() {
            Self::from_legacy_mode(mode)
        } else {
            Self::aggressive_default()
        };

        if let Some(value) = input.backend {
            settings.backend = value;
        }
        if let Some(value) = input.driver_bug_workarounds_enabled {
            settings.driver_bug_workarounds_enabled = value;
        }
        if let Some(value) = input.force_gpu_rasterization {
            settings.force_gpu_rasterization = value;
        }
        if let Some(value) = input.frame_rate_limit_enabled {
            settings.frame_rate_limit_enabled = value;
        }
        if let Some(value) = input.gpu_blocklist_enabled {
            settings.gpu_blocklist_enabled = value;
        }
        if let Some(value) = input.prefer_high_performance_gpu {
            settings.prefer_high_performance_gpu = value;
        }
        if let Some(value) = input.unsafe_web_gpu_enabled {
            settings.unsafe_web_gpu_enabled = value;
        }
        if let Some(value) = input.vsync_enabled {
            settings.vsync_enabled = value;
        }
        if !settings.frame_rate_limit_enabled {
            settings.vsync_enabled = false;
        }
        Ok(settings)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroBadgePositionRecord {
    #[ts(type = "\"left\" | \"center\" | \"right\"")]
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
    #[ts(type = "\"off\" | \"auto\" | \"on\"")]
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserProxySettingsRecord {
    #[ts(type = "\"system\" | \"custom\"")]
    pub mode: String,
    pub server: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceAppearanceSettingsRecord {
    #[ts(type = "\"material\" | \"black\"")]
    pub background: String,
    #[ts(type = "1 | 2 | 4 | 6 | 8 | 12 | 16")]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalDocumentVersionsRecord {
    pub fair_use: String,
    pub privacy: String,
    pub terms: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptDocumentsInputRecord {
    pub fair_use_version: String,
    pub privacy_version: String,
    pub terms_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegalAcceptanceStatusRecord {
    pub current_versions: LegalDocumentVersionsRecord,
    pub is_accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_fair_use_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub accepted_terms_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub acknowledged_privacy_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemFontFamilyRecord {
    pub family: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsGraphicsEventRecord {
    pub event_id: u32,
    pub provider: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WindowsGraphicsEventCollectionRecord {
    pub available: bool,
    pub events: Vec<WindowsGraphicsEventRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum LogSource {
    Main,
    Preload,
    Renderer,
    Ipc,
    Browser,
    Macro,
    Persistence,
    Update,
}

impl LogSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Preload => "preload",
            Self::Renderer => "renderer",
            Self::Ipc => "ipc",
            Self::Browser => "browser",
            Self::Macro => "macro",
            Self::Persistence => "persistence",
            Self::Update => "update",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogErrorDetails {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cause: Option<Box<LogErrorDetails>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogCaptureRecord {
    pub level: LogLevel,
    pub source: LogSource,
    pub event: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, rename = "contextRawJson")]
    pub context_raw_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<LogErrorDetails>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub source: LogSource,
    pub event: String,
    pub message: String,
    pub session_id: String,
    #[serde(default)]
    #[ts(optional)]
    #[ts(type = "Record<string, unknown>")]
    pub context: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    #[ts(optional)]
    pub error: Option<LogErrorDetails>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogQuery {
    #[serde(default)]
    #[ts(optional)]
    pub levels: Option<Vec<LogLevel>>,
    #[serde(default)]
    #[ts(optional)]
    pub sources: Option<Vec<LogSource>>,
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
pub struct LogPageRecord {
    pub entries: Vec<LogEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LogStorageStatusRecord {
    pub current_level: LogLevel,
    #[ts(type = "number")]
    pub file_count: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub oldest_timestamp: Option<String>,
    pub newest_timestamp: Option<String>,
    pub retention_days: u32,
    #[ts(type = "number")]
    pub max_bytes: u64,
    pub directory: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DiagnosticDisplayRecord {
    pub bounds: StatePixelBoundsRecord,
    pub resolution: StateResolutionRecord,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ElectronDiagnosticsSnapshotRecord {
    pub application_name: String,
    pub application_version: String,
    pub packaged: bool,
    pub electron_version: String,
    pub chromium_version: String,
    pub node_version: String,
    pub locale: String,
    pub system_version: String,
    pub displays: Vec<DiagnosticDisplayRecord>,
    pub gpu_feature_status_raw_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gpu_info_raw_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub external_freeze_reported_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct DiagnosticExportResultRecord {
    pub file_path: String,
    pub log_file_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum TelemetryMetric {
    IpcCommand,
    MacroScheduleToDispatch,
    TabActivation,
    Cdp,
    CoreEventBatch,
    BrowserResult,
    ProcessLaunch,
    ScheduledWait,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct TelemetrySampleRecord {
    pub metric: TelemetryMetric,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<f64>,
    #[serde(default = "default_telemetry_count")]
    pub count: u32,
}

fn default_telemetry_count() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LatencySummaryRecord {
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub sample_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CountedLatencySummaryRecord {
    #[ts(type = "number")]
    pub message_count: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub latency: LatencySummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct NapiLatencySummaryRecord {
    #[ts(type = "number")]
    pub call_count: u64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub latency: LatencySummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct PerformanceTelemetryRecord {
    #[ts(type = "number")]
    pub browser_result_count: u64,
    pub cdp: CountedLatencySummaryRecord,
    #[ts(type = "number")]
    pub core_event_batch_count: u64,
    pub ipc_command: LatencySummaryRecord,
    pub macro_schedule_to_dispatch: LatencySummaryRecord,
    pub napi: NapiLatencySummaryRecord,
    #[ts(type = "number")]
    pub process_launch_count: u64,
    #[ts(type = "number")]
    pub scheduled_wait_count: u64,
    pub started_at: String,
    pub tab_activation: LatencySummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub role_id: String,
    #[ts(type = "\"macro\" | \"external_health\"")]
    pub origin: String,
    #[ts(type = "number")]
    pub scheduled_at_ms: u64,
    #[ts(type = "number")]
    pub deadline_ms: u64,
    pub action: BrowserAction,
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
pub struct CoreEffectTarget {
    #[ts(type = "\"app\" | \"window\" | \"view\" | \"webContents\" | \"session\"")]
    pub kind: String,
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
    CreateWindow {
        options_json: String,
    },
    CreateView {
        options_json: String,
    },
    AttachView {
        child_handle_id: String,
    },
    DetachView {
        child_handle_id: String,
    },
    Destroy,
    LoadUrl {
        url: String,
    },
    SetBounds {
        bounds: StatePixelBoundsRecord,
    },
    SetVisible {
        visible: bool,
    },
    Focus,
    Evaluate {
        source: String,
    },
    DebuggerCommand {
        method: String,
        params_json: String,
    },
    SessionClearStorage {
        storages: Vec<String>,
    },
    CookieSet {
        cookie_json: String,
    },
    ChromeProfileApplySession {
        role_id: String,
        browser_user_data_dir: String,
        cookies_json: String,
    },
    ChromeProfileClearSession {
        role_id: String,
        browser_user_data_dir: String,
    },
    RoleBrowserDataClearSession {
        role_id: String,
        browser_user_data_dir: String,
        #[ts(type = "\"embedded\" | \"chrome-profile\"")]
        session_source: String,
    },
    CompatibilityCreateWindow {
        plan: CompatibilityCheckPlanRecord,
    },
    CompatibilityConfigureSession {
        game_id: String,
    },
    CompatibilityLoadUrl {
        game_id: String,
        url: String,
    },
    CompatibilityProbeGraphics {
        game_id: String,
        source: String,
    },
    CompatibilityCleanupWindow {
        game_id: String,
    },
    CdnProbeGoogle {
        url: String,
    },
    SetAudioMuted {
        muted: bool,
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
    EmbeddedActivateResources {
        tab_id: String,
        policy: StateWorkspaceResourcePolicyRecord,
        role_ids: Vec<String>,
    },
    EmbeddedApplyResourceEffects {
        effects: Vec<ResourceRuntimeEffectRecord>,
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
        next_active_tab_id: Option<String>,
    },
    EmbeddedApplyRuntime {
        snapshot: BrowserRuntimeSnapshot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target: Option<EmbeddedLaunchTargetRecord>,
        #[serde(default)]
        #[ts(rename = "revealDisplayIds", type = "Array<number>")]
        reveal_display_ids: Vec<i64>,
        #[serde(default)]
        #[ts(rename = "focusWindowDisplayIds", type = "Array<number>")]
        focus_window_display_ids: Vec<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "focusTabId")]
        focus_tab_id: Option<String>,
    },
    ExternalPrepareSession {
        role_id: String,
        #[ts(type = "\"auto\" | \"off\" | \"on\"")]
        cdn_mode: String,
    },
    ExternalResolvePhysicalBounds {
        bounds: StatePixelBoundsRecord,
    },
    ExternalOverlaySource {
        role_id: String,
    },
    ExternalOverlayRequest {
        role_id: String,
        request_json: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectRequest {
    pub effect_id: String,
    pub operation_id: String,
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreEffectMetricsRecord {
    pub pending_effect_count: u32,
    pub active_operation_count: u32,
    pub pending_effect_capacity: u32,
    pub operation_capacity: u32,
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
    #[ts(type = "number")]
    pub display_id: i64,
    pub work_area: StatePixelBoundsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedRoleViewEffectRecord {
    pub role: StateRoleRecord,
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
    pub url: String,
    pub zoom_factor: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EmbeddedTabEffectRecord {
    pub tab_id: String,
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
    #[ts(type = "\"embedded\" | \"external\"")]
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"ready\" | \"unavailable\"")]
    pub automation_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"healthy\" | \"unresponsive\"")]
    pub page_health: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"throttled\" | \"macro_override\" | \"shared_process\" | \"unavailable\""
    )]
    pub resource_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "1 | 2 | 4")]
    pub cpu_throttle_rate: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"normal\" | \"constrained\"")]
    pub resource_pressure_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(
        optional,
        type = "\"runtime_tab_background\" | \"cpu\" | \"memory\" | \"thermal\" | \"macro\" | \"shared_process\" | \"unavailable\""
    )]
    pub resource_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserWorkspaceStatusRecord {
    pub workspace_id: String,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalPrepareSessionResultRecord {
    pub cdn_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proxy_server: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalChromeDiagnosticsRecord {
    pub automation_state: String,
    pub bounds: StatePixelBoundsRecord,
    pub captured_at: String,
    pub external_role_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"healthy\" | \"unresponsive\"")]
    pub page_health: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub physical_bounds: Option<StatePixelBoundsRecord>,
    pub role_id: String,
    #[ts(type = "\"external\"")]
    pub runtime_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    pub zoom_factor: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chrome_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalBrowserActionDispatch {
    pub results: Vec<BrowserActionResult>,
    pub unhandled: Vec<BrowserActionRequest>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ExternalSessionCommand {
    Snapshot,
    Begin {
        role: StateRoleRecord,
        bounds: StatePixelBoundsRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "physicalBounds")]
        physical_bounds: Option<StatePixelBoundsRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "workspaceId")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        notice: Option<String>,
        #[ts(rename = "zoomFactor")]
        zoom_factor: f64,
    },
    UpdateRole {
        role: StateRoleRecord,
    },
    SetNotice {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        notice: Option<String>,
    },
    SetAutomation {
        #[ts(rename = "roleId")]
        role_id: String,
        available: bool,
        #[ts(rename = "cdnActive")]
        cdn_active: bool,
    },
    SetRunning {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "launchedAt")]
        launched_at: String,
    },
    SetStopping {
        #[ts(rename = "roleId")]
        role_id: String,
    },
    SetHealth {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "\"healthy\" | \"unresponsive\"")]
        health: Option<String>,
        #[ts(rename = "pageHidden")]
        page_hidden: bool,
    },
    RecordCdpTimeout {
        #[ts(rename = "roleId")]
        role_id: String,
        #[ts(rename = "atMs", type = "number")]
        at_ms: u64,
    },
    Remove {
        #[ts(rename = "roleId")]
        role_id: String,
        #[serde(default)]
        #[ts(rename = "preserveWorkspace")]
        preserve_workspace: bool,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalSessionRecord {
    pub role: StateRoleRecord,
    pub bounds: StatePixelBoundsRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub physical_bounds: Option<StatePixelBoundsRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notice: Option<String>,
    pub zoom_factor: f64,
    #[ts(type = "\"launching\" | \"running\" | \"stopping\"")]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub launched_at: Option<String>,
    pub automation_available: bool,
    pub cdn_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"healthy\" | \"unresponsive\"")]
    pub page_health: Option<String>,
    pub page_hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub last_cdp_timeout_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ExternalSessionResult {
    pub sessions: Vec<ExternalSessionRecord>,
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
    pub role_id: Option<String>,
    pub active_role_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroInvocationRequest {
    pub macro_id: String,
    pub role_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroPressInvocationRequest {
    pub macro_id: String,
    pub role_id: String,
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
