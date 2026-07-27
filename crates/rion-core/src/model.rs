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

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum EmbeddedBrowserEngine {
    #[default]
    System,
}

impl<'de> Deserialize<'de> for EmbeddedBrowserEngine {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "system" | "electron" => Ok(Self::System),
            value => Err(serde::de::Error::custom(format!(
                "unsupported browser engine: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserEngineOverride {
    #[default]
    Inherit,
    System,
}

impl<'de> Deserialize<'de> for BrowserEngineOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "inherit" => Ok(Self::Inherit),
            "system" | "electron" => Ok(Self::System),
            value => Err(serde::de::Error::custom(format!(
                "unsupported browser engine override: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ResolvedBrowserEngine {
    Webview2,
    Wkwebview,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum BrowserHostKind {
    SystemNative,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum EngineCapabilityStatus {
    Supported,
    Degraded,
    Unsupported,
    Disabled,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum SystemWebViewIssueReason {
    WebkitSpiUnavailable,
    MacroInputUnavailable,
    CachedCompatibilityFailure,
    RuntimeCreationFailed,
    RuntimeCrashed,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EngineCapabilitySnapshotRecord {
    pub navigation: EngineCapabilityStatus,
    pub persistent_session: EngineCapabilityStatus,
    pub trusted_input: EngineCapabilityStatus,
    pub background_input: EngineCapabilityStatus,
    pub frame_evaluation: EngineCapabilityStatus,
    pub popup: EngineCapabilityStatus,
    pub audio_mute: EngineCapabilityStatus,
    pub custom_fonts: EngineCapabilityStatus,
    pub graphics_tuning: EngineCapabilityStatus,
    pub downloads: EngineCapabilityStatus,
    pub file_upload: EngineCapabilityStatus,
    pub permissions: EngineCapabilityStatus,
    pub dialogs: EngineCapabilityStatus,
    pub certificate_handling: EngineCapabilityStatus,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserEngineResolutionRecord {
    pub preferred_engine: EmbeddedBrowserEngine,
    pub resolved_engine: ResolvedBrowserEngine,
    pub host_kind: BrowserHostKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue_reason: Option<SystemWebViewIssueReason>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EngineCompatibilityCacheKeyRecord {
    pub app_version: String,
    pub adapter_version: String,
    pub platform: String,
    pub os_build: String,
    pub webview_version: String,
    pub engine: ResolvedBrowserEngine,
    pub game_id: String,
    pub game_updated_at: String,
    pub settings_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct EngineCompatibilityCacheRecord {
    pub key: EngineCompatibilityCacheKeyRecord,
    pub compatible: bool,
    pub capability_snapshot: EngineCapabilitySnapshotRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issue_reason: Option<SystemWebViewIssueReason>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemWebViewProbeRecord {
    pub platform: String,
    pub engine: ResolvedBrowserEngine,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_version: Option<String>,
    pub public_api_available: bool,
    pub macro_input_available: bool,
    pub audio_mute_available: bool,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct SystemWebViewRuntimeRegistrationRecord {
    pub platform: String,
    pub engine: ResolvedBrowserEngine,
    pub adapter_version: String,
    pub available: bool,
    pub capability_snapshot: EngineCapabilitySnapshotRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_reason: Option<SystemWebViewIssueReason>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct WorkspaceEnginePreferenceRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preferred_engine: Option<EmbeddedBrowserEngine>,
    pub requires_override: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct LegacySessionRestoreRecord {
    pub role_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_fingerprint: Option<String>,
    pub cookie_count: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileEntryRecord {
    pub id: String,
    pub directory_name: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub existing_role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub existing_role_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportPreviewRecord {
    pub import_id: String,
    pub source_label: String,
    pub source_in_use: bool,
    pub profiles: Vec<ChromeProfileEntryRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromeProfileImportResolutionRecord {
    Create {
        profile_id: String,
    },
    Copy {
        profile_id: String,
    },
    Replace {
        profile_id: String,
        target_role_id: String,
    },
}

impl ChromeProfileImportResolutionRecord {
    pub fn profile_id(&self) -> &str {
        match self {
            Self::Create { profile_id }
            | Self::Copy { profile_id }
            | Self::Replace { profile_id, .. } => profile_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookieRecord {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStorageEntryRecord {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTransferPayloadRecord {
    pub cookies: Vec<SessionCookieRecord>,
    pub local_storage: Vec<LocalStorageEntryRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportItemResultRecord {
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role_id: Option<String>,
    pub role_name: String,
    pub status: String,
    pub cookie_count: u32,
    pub local_storage_count: u32,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportResultRecord {
    pub import_id: String,
    pub items: Vec<ChromeProfileImportItemResultRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromeProfileImportProgressRecord {
    pub import_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_id: Option<String>,
    pub phase: String,
    pub completed: u32,
    pub total: u32,
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
        versions: RuntimeVersionRecord,
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
        versions: RuntimeVersionRecord,
    },
    CompatibilityRun {
        #[ts(rename = "gameId")]
        game_id: String,
        versions: RuntimeVersionRecord,
    },
    GameBrowserSettingsGet,
    GameBrowserSettingsReplace {
        settings: GameBrowserSettingsRecord,
    },
    EngineCompatibilityCacheGet {
        key: EngineCompatibilityCacheKeyRecord,
    },
    EngineCompatibilityCachePut {
        record: EngineCompatibilityCacheRecord,
    },
    EngineCompatibilityCacheDeleteGame {
        #[ts(rename = "gameId")]
        game_id: String,
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
        versions: RuntimeVersionRecord,
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
        snapshot: ApplicationDiagnosticsSnapshotRecord,
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
                | Self::CompatibilityRun { .. }
                | Self::GraphicsDiagnosticsAssemble { .. }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
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
    #[serde(default)]
    pub browser_engine_pin: Option<EmbeddedBrowserEngine>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
    #[ts(type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: String,
    #[ts(type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: f64,
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

/// Renderer-facing game creation contract. The similarly named `*InputRecord`
/// types below are private command payloads and may contain presence flags used
/// to preserve `undefined` versus `null` across the typed desktop bridge.
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
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
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
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
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
    pub system_browser_data_dir: String,
    pub webview2_user_data_dir: String,
    pub webkit_data_store_key: String,
    pub webkit_data_store_identifier: String,
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
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: Option<f64>,
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
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: Option<f64>,
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
    pub browser_engine: Option<BrowserEngineOverride>,
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
    pub browser_engine: Option<BrowserEngineOverride>,
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
    pub browser_engine: Option<BrowserEngineOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
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
    pub browser_engine: Option<BrowserEngineOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_zoom_percent: Option<f64>,
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
pub struct BulkDeleteSkippedItemRecord {
    pub id: String,
    #[ts(type = "\"protected\" | \"in_use\" | \"not_found\" | \"busy\" | \"failed\"")]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub related_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BulkDeleteResultRecord {
    pub deleted_ids: Vec<String>,
    pub skipped: Vec<BulkDeleteSkippedItemRecord>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
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
    #[ts(optional)]
    pub browser_engine_pin: Option<EmbeddedBrowserEngine>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_engine: Option<BrowserEngineOverride>,
    #[ts(type = "\"adaptive\" | \"fixed\"")]
    pub browser_zoom_mode: String,
    #[ts(type = "25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125")]
    pub browser_zoom_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_display: Option<StateWorkspaceDisplayTargetRecord>,
    pub slots: Vec<StateWorkspaceSlotRecord>,
    pub created_at: String,
    pub updated_at: String,
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
pub struct StateCompatibilityRecommendationRecord {
    #[ts(type = "\"system_webview_available\" | \"load_failed\" | \"graphics_unavailable\"")]
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
pub struct RuntimeVersionRecord {
    pub engine: ResolvedBrowserEngine,
    pub engine_version: String,
    pub shell: String,
    pub shell_version: String,
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
pub struct GraphicsDiagnosticsRecord {
    pub applied_settings: BrowserGraphicsSettingsRecord,
    pub applied_switches: Vec<String>,
    pub collected_at: String,
    pub embedded: StateWebGraphicsRecord,
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
    pub versions: RuntimeVersionRecord,
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
    CompatibilityStatuses {
        statuses: Vec<CompatibilityRunStatusRecord>,
    },
    ChromeProfileImportProgress {
        progress: ChromeProfileImportProgressRecord,
    },
    LegacySessionsRestored {
        records: Vec<LegacySessionRestoreRecord>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub browser_engine: Option<EmbeddedBrowserEngine>,
    pub macro_badge_position: MacroBadgePositionRecord,
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
    pub windows_eco_qos_enabled: bool,
}

impl BrowserGraphicsSettingsRecord {
    pub fn recommended_default() -> Self {
        Self {
            backend: BrowserGraphicsBackendSettingsRecord::default(),
            driver_bug_workarounds_enabled: true,
            force_gpu_rasterization: false,
            frame_rate_limit_enabled: true,
            gpu_blocklist_enabled: true,
            prefer_high_performance_gpu: true,
            unsafe_web_gpu_enabled: false,
            vsync_enabled: true,
            windows_eco_qos_enabled: true,
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
            windows_eco_qos_enabled: true,
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
            windows_eco_qos_enabled: Option<bool>,
        }

        let input = Input::deserialize(deserializer)?;
        let has_new_fields = input.backend.is_some()
            || input.driver_bug_workarounds_enabled.is_some()
            || input.force_gpu_rasterization.is_some()
            || input.frame_rate_limit_enabled.is_some()
            || input.gpu_blocklist_enabled.is_some()
            || input.prefer_high_performance_gpu.is_some()
            || input.unsafe_web_gpu_enabled.is_some()
            || input.vsync_enabled.is_some()
            || input.windows_eco_qos_enabled.is_some();
        let mut settings = if has_new_fields {
            Self::recommended_default()
        } else if let Some(mode) = input.mode.as_deref() {
            Self::from_legacy_mode(mode)
        } else {
            Self::recommended_default()
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
        if let Some(value) = input.windows_eco_qos_enabled {
            settings.windows_eco_qos_enabled = value;
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
    #[serde(default = "default_true")]
    pub restore_game_windows_on_startup: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreTabRecord {
    #[ts(type = "\"role\" | \"workspace\"")]
    pub tab_type: String,
    pub source_id: String,
    pub name: String,
    pub role_ids: Vec<String>,
    pub hidden: bool,
    pub audio_muted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreWindowRecord {
    pub id: String,
    pub target_display: StateWorkspaceDisplayTargetRecord,
    pub was_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_source_id: Option<String>,
    pub tabs: Vec<RuntimeRestoreTabRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct RuntimeRestoreSessionRecord {
    pub schema_version: u8,
    pub updated_at: String,
    pub clean_exit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_focused_window_id: Option<String>,
    pub windows: Vec<RuntimeRestoreWindowRecord>,
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
    pub entry_count: u64,
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
pub struct ApplicationDiagnosticsSnapshotRecord {
    pub application_name: String,
    pub application_version: String,
    pub packaged: bool,
    pub engine: ResolvedBrowserEngine,
    pub engine_version: String,
    pub shell: String,
    pub shell_version: String,
    pub locale: String,
    pub system_version: String,
    pub displays: Vec<DiagnosticDisplayRecord>,
    pub gpu_feature_status_raw_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gpu_info_raw_json: Option<String>,
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
    WorkspaceLaunch,
    MainEventLoopDelay,
    RendererRaf,
    Cdp,
    CoreEventBatch,
    BrowserResult,
    ProcessLaunch,
    ScheduledWait,
    LayoutPass,
    RuntimePublish,
    MenuRefresh,
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
pub struct PerformanceTelemetryRecord {
    #[ts(type = "number")]
    pub browser_result_count: u64,
    pub cdp: CountedLatencySummaryRecord,
    #[ts(type = "number")]
    pub core_event_batch_count: u64,
    pub ipc_command: LatencySummaryRecord,
    #[ts(type = "number")]
    pub layout_pass_count: u64,
    pub macro_schedule_to_dispatch: LatencySummaryRecord,
    pub main_event_loop_delay: LatencySummaryRecord,
    #[ts(type = "number")]
    pub menu_refresh_count: u64,
    pub core_effects: CoreEffectMetricsRecord,
    #[ts(type = "number")]
    pub process_launch_count: u64,
    pub renderer_raf: LatencySummaryRecord,
    #[ts(type = "number")]
    pub scheduled_wait_count: u64,
    pub started_at: String,
    pub tab_activation: LatencySummaryRecord,
    #[ts(type = "number")]
    pub runtime_publish_count: u64,
    pub workspace_launch: LatencySummaryRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct BrowserActionRequest {
    pub request_id: String,
    pub role_id: String,
    #[ts(type = "\"macro\"")]
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
    LegacySessionRestore {
        transaction_id: String,
        role_id: String,
        launch_url: String,
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
    #[ts(type = "number")]
    pub display_id: i64,
    pub work_area: StatePixelBoundsRecord,
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
    pub preferred_engine: Option<EmbeddedBrowserEngine>,
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
    pub preferred_engine: Option<EmbeddedBrowserEngine>,
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

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlayStartSummaryRecord {
    pub skipped_count: u32,
    pub started_count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct MacroOverlayViewModelRecord {
    #[serde(default)]
    pub detached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"en\" | \"zh-TW\" | \"zh-CN\" | \"ja\"")]
    pub language: Option<String>,
    pub macro_badge_position: MacroBadgePositionRecord,
    pub macros: Vec<MacroDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_summary: Option<MacroOverlayStartSummaryRecord>,
    pub statuses: Vec<MacroRunStatus>,
}

#[cfg(test)]
mod command_tests {
    use serde_json::json;

    use super::{CoreCommand, CoreEvent, StateCollection};

    #[test]
    fn enum_fields_use_the_generated_camel_case_contract() {
        let command = serde_json::from_value::<CoreCommand>(json!({
            "type": "macroStop",
            "macroId": "macro-1"
        }))
        .unwrap();
        assert!(matches!(command, CoreCommand::MacroStop { macro_id } if macro_id == "macro-1"));

        let event = serde_json::to_value(CoreEvent::OverlayChanged {
            role_ids: vec!["role-1".to_owned()],
        })
        .unwrap();
        assert_eq!(event["roleIds"], json!(["role-1"]));
        assert!(event.get("role_ids").is_none());

        let state_changed = serde_json::to_value(CoreEvent::StateChanged {
            revision: 4,
            changed_collections: vec![StateCollection::Roles, StateCollection::LaunchWorkspaces],
        })
        .unwrap();
        assert_eq!(
            state_changed["changedCollections"],
            json!(["roles", "launchWorkspaces"])
        );
    }
}
