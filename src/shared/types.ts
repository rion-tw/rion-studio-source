import type {
  BrowserCdnCompatibilityRecord,
  BrowserFontSettingsRecord,
  BrowserGraphicsSettingsRecord,
  BrowserNetworkSettingsRecord,
  BrowserProxySettingsRecord,
  ChromeProfileEntryRecord,
  ChromeProfileImportPreviewRecord,
  ChromeProfileImportRequest,
  ChromeProfileImportResultRecord,
  ChromeProfileImportWarningRecord,
  CompatibilityRunPhase,
  CompatibilityRunStatusRecord,
  GameCreateRequest,
  GameBrowserSettingsRecord,
  GameUpdateRequest,
  LegalAcceptDocumentsInputRecord,
  LegalAcceptanceStatusRecord,
  LegalDocumentVersionsRecord,
  LogEntry as RustLogEntry,
  LogErrorDetails as RustLogErrorDetails,
  LogLevel as RustLogLevel,
  LogQuery as RustLogQuery,
  LogSource as RustLogSource,
  MacroCreateRequest,
  MacroBadgePositionRecord,
  MacroRepeat as RustMacroRepeat,
  MacroSettingsRecord,
  MacroStepDefinition,
  MacroTrigger as RustMacroTrigger,
  MacroUpdateRequest,
  PortableDataRecord,
  PortableDataSelectionRecord,
  PortableGameRecord,
  PortableImportOperationsRecord,
  PortableImportOperationSummaryRecord,
  PortableImportPreviewRecord,
  PortableImportResultRecord,
  PortableImportWarningRecord,
  PortableLaunchWorkspaceRecord,
  PortableMacroConflictCandidateRecord,
  PortableMacroConflictRecord,
  PortableMacroConflictResolutionRecord,
  PortableMacroRecord,
  PortablePreferencesRecord,
  PortableRoleRecord,
  StateGameRecord,
  StateCompatibilityChromeRecord,
  StateCompatibilityLoadRecord,
  StateCompatibilityObservationsRecord,
  StateCompatibilityRecommendationRecord,
  StateCompatibilityReportRecord,
  StateLaunchWorkspaceRecord,
  StateMacroRecord,
  StateNormalizedRectRecord,
  StatePixelBoundsRecord,
  StateRoleRecord,
  StateWorkspaceDisplayFingerprintRecord,
  StateWorkspaceDisplayTargetRecord,
  StateWorkspaceResourcePolicyRecord,
  StateWorkspaceSlotRecord,
  StateWebGraphicsRecord,
  SystemFontFamilyRecord,
  WorkspaceAppearanceSettingsRecord,
  RoleCreateRequest,
  RolePathsRecord,
  RoleUpdateRequest,
  WorkspaceCreateRequest,
  WorkspaceUpdateRequest
} from "./generated";

export const DEFAULT_LAUNCH_URL = "https://universe.flyff.com/play";
export type WorkspaceLayoutTemplate =
  | "single"
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
  | "nine_grid";
export type WorkspaceBrowserZoomPercent = 25 | 33 | 50 | 67 | 75 | 80 | 90 | 100 | 110 | 125;
export type WorkspaceSlotBrowserZoomPercent = number;
export type WorkspaceBrowserZoomMode = "adaptive" | "fixed";
export type AppLanguage = "en" | "zh-TW" | "zh-CN" | "ja";
export type AppThemeMode = "system" | "light" | "dark";
export type AppRendererReadyState = "failed" | "ready";

export interface AppWindowState {
  fullscreen: boolean;
}

export type GameSource = "builtin" | "custom";
export type BuiltinGameKey = "flyff-universe" | "feifei-infinite-universe";

export type Game = StateGameRecord;

export type CreateGameInput = GameCreateRequest;

export type UpdateGameInput = GameUpdateRequest;

export type Role = StateRoleRecord;

/** Selects the browser storage backend; this is not an authentication state. */
export type RoleBrowserSessionSource = "embedded" | "chrome-profile";

export type CreateRoleInput = RoleCreateRequest;

export type UpdateRoleInput = RoleUpdateRequest;

export interface ReorderItemsInput {
  orderedIds: string[];
}

export interface BulkDeleteInput {
  ids: string[];
}

export type BulkDeleteSkipReason = "protected" | "in_use" | "not_found" | "busy" | "failed";

export interface BulkDeleteSkippedItem {
  id: string;
  reason: BulkDeleteSkipReason;
  relatedNames?: string[];
}

export interface BulkDeleteResult {
  deletedIds: string[];
  skipped: BulkDeleteSkippedItem[];
}

export type RoleRunState = "launching" | "running" | "stopping";

export interface RoleStatus {
  roleId: string;
  state: RoleRunState;
  launchedAt?: string;
  notice?: string;
  runtimeMode?: BrowserRuntimeMode;
  automationState?: "ready" | "unavailable";
  /** Health reported by the external Chrome page diagnostics bridge. */
  pageHealth?: "healthy" | "unresponsive";
  resourceState?: WorkspaceResourceState;
  cpuThrottleRate?: WorkspaceCpuThrottleRate | 1;
  resourcePressureLevel?: WorkspacePressureLevel;
  resourceReason?: WorkspaceResourceReason;
}

export type EmbeddedRuntimeTabType = "role" | "workspace";

export interface EmbeddedRuntimeTabSummary {
  id: string;
  type: EmbeddedRuntimeTabType;
  sourceId: string;
  name: string;
  displayId: number;
  roleIds: string[];
  /** Role names in the same order as roleIds, present for workspace tabs. */
  roleNames?: string[];
  hidden: boolean;
  active: boolean;
  /** True when any role or popup in the tab is currently producing audio. */
  audible: boolean;
  /** True when Rion Studio has explicitly muted the whole runtime tab. */
  audioMuted: boolean;
}

export interface EmbeddedRuntimeWindowSummary {
  displayId: number;
  bounds: PixelBounds;
  visible: boolean;
  activeTabId?: string;
  tabCount: number;
}

export interface EmbeddedRuntimeState {
  windows: EmbeddedRuntimeWindowSummary[];
  tabs: EmbeddedRuntimeTabSummary[];
}

export type MacroTrigger = RustMacroTrigger;

export type MacroActivationMode = "toggle" | "while_held";

export type MacroKeyAction = "tap" | "hold_until_stop";

export type MacroKeyModifier = "primary" | "ctrl" | "alt" | "shift" | "meta";

export type MacroSettings = MacroSettingsRecord;

export type MacroRepeat = RustMacroRepeat;

export type MacroCallMode = "wait" | "trigger";
export type MacroClickUnit = "percent" | "px";
export type MacroClickAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type MacroStep = MacroStepDefinition;

export type Macro = StateMacroRecord;

export type CreateMacroInput = MacroCreateRequest;

export type UpdateMacroInput = MacroUpdateRequest;

export interface MacroPageRequest {
  roleId: string;
}

export type MacroRunState = "running" | "stopping" | "failed" | "cancelled";

export interface MacroRunStatus {
  roleId: string;
  macroId: string;
  state: MacroRunState;
  /** Number of completed iterations for the current runtime invocation. */
  iteration?: number;
  lastClick?: {
    sequence: number;
    stepId: string;
  };
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export type RolePaths = RolePathsRecord;

export type NormalizedRect = StateNormalizedRectRecord;

export type LaunchWorkspaceSlot = StateWorkspaceSlotRecord;

export type WorkspaceResourceMode = "unrestricted" | "adaptive";
export type WorkspaceCpuThrottleRate = 2 | 4;
export type WorkspacePressureLevel = "normal" | "constrained";
export type WorkspaceResourceReason =
  | "baseline"
  | "cpu"
  | "memory"
  | "thermal"
  | "macro"
  | "shared_process"
  | "runtime_tab_background"
  | "unavailable";
export type WorkspaceResourceState =
  | "throttled"
  | "macro_override"
  | "shared_process"
  | "unavailable";

export type WorkspaceResourcePolicy = StateWorkspaceResourcePolicyRecord;

export type PixelBounds = StatePixelBoundsRecord;

export type WorkspaceDisplayFingerprint = StateWorkspaceDisplayFingerprintRecord;

export type WorkspaceDisplayTarget = StateWorkspaceDisplayTargetRecord;

export type LaunchWorkspace = StateLaunchWorkspaceRecord;

export type CreateLaunchWorkspaceInput = WorkspaceCreateRequest;

export type UpdateLaunchWorkspaceInput = WorkspaceUpdateRequest;

export interface WorkspaceDisplayInfo {
  id: number;
  label: string;
  /** Display bounds in device-independent pixels (DIP). */
  bounds: PixelBounds;
  /** Available work area in device-independent pixels (DIP). */
  workArea: PixelBounds;
  /** Backing resolution in physical pixels after applying the display scale factor. */
  resolution: {
    width: number;
    height: number;
  };
  scaleFactor: number;
  isPrimary: boolean;
  isInternal: boolean;
}

export interface AppSnapshot {
  embeddedRuntimeState: EmbeddedRuntimeState;
  games: Game[];
  gameCompatibilityReports: GameCompatibilityReport[];
  gameCompatibilityStatuses: GameCompatibilityRunStatus[];
  roles: Role[];
  roleStatuses: RoleStatus[];
  launchWorkspaces: LaunchWorkspace[];
  workspaceDisplays: WorkspaceDisplayInfo[];
  macros: Macro[];
  macroStatuses: MacroRunStatus[];
}

export interface WorkspaceDisplayLaunchOption extends WorkspaceDisplayInfo {
  occupiedByWorkspace?: {
    id: string;
    name: string;
  };
}

export interface WorkspaceLaunchInput {
  displayId?: number;
}

export type WorkspaceLaunchResult =
  | {
      kind: "launched";
      displayId: number;
      statuses: RoleStatus[];
    }
  | {
      kind: "display_selection_required";
      reason: "target_occupied" | "target_unavailable";
      displays: WorkspaceDisplayLaunchOption[];
    };

export interface PendingWorkspaceLaunchRequest {
  workspaceId: string;
  workspaceName: string;
  result: Extract<WorkspaceLaunchResult, { kind: "display_selection_required" }>;
}

export interface AppErrorPayload {
  code: string;
  message: string;
}

export type BrowserFontFamilyRole = "standard" | "serif" | "sansserif" | "fixed" | "math";
export type BrowserFontSettingsMode = "default" | "custom";
export type BrowserGraphicsMode = "automatic" | "high_performance" | "experimental";
export type BrowserLaunchMode = "auto" | "embedded" | "external";
export type BrowserRuntimeMode = "embedded" | "external";
export type InheritableBrowserLaunchMode = BrowserLaunchMode | "inherit";
export type BrowserProxySettingsMode = "system" | "custom";
export type BrowserCdnCompatibilityMode = "off" | "auto" | "on";
export type WorkspaceBackgroundStyle = "material" | "black";
export type WorkspaceGapSize = 1 | 2 | 4 | 6 | 8 | 12 | 16;

export type BrowserFontSettings = BrowserFontSettingsRecord;

export type BrowserProxySettings = BrowserProxySettingsRecord;

export type BrowserCdnCompatibilitySettings = BrowserCdnCompatibilityRecord;

export type BrowserNetworkSettings = BrowserNetworkSettingsRecord;

export type BrowserGraphicsSettings = BrowserGraphicsSettingsRecord;

export type WorkspaceAppearanceSettings = WorkspaceAppearanceSettingsRecord;

export type MacroBadgeHorizontalAlign = "left" | "center" | "right";

export type MacroBadgePositionSettings = MacroBadgePositionRecord;

export type GameBrowserSettings = GameBrowserSettingsRecord;

export type WebGraphicsAvailability = "available" | "unavailable" | "unknown";

export type WebGraphicsDiagnostics = StateWebGraphicsRecord;

export interface GraphicsDeviceDiagnostics {
  active?: boolean;
  deviceId?: number;
  deviceString?: string;
  driverVendor?: string;
  driverVersion?: string;
  vendorId?: number;
  vendorString?: string;
}

export interface ExternalGraphicsDiagnostics {
  error?: string;
  probe?: WebGraphicsDiagnostics;
  roleId: string;
  roleName: string;
  state: "ready" | "unavailable";
}

export interface GraphicsDiagnostics {
  appliedMode: BrowserGraphicsMode;
  collectedAt: string;
  embedded: WebGraphicsDiagnostics;
  externalRoles: ExternalGraphicsDiagnostics[];
  featureStatus: Record<string, string>;
  gpuDevice?: GraphicsDeviceDiagnostics;
  gpuInfoReady: boolean;
  hardwareAccelerationEnabled: boolean | null;
  platform: string;
  restartRequired: boolean;
  savedMode: BrowserGraphicsMode;
  versions: {
    chromium: string;
    electron: string;
    node: string;
  };
}

export type GameCompatibilityRunPhase = CompatibilityRunPhase;

export type GameCompatibilityRunStatus = CompatibilityRunStatusRecord;

export type GameCompatibilityLoadResult = StateCompatibilityLoadRecord;

export type GameCompatibilityChromeResult = StateCompatibilityChromeRecord;

export type GameCompatibilityRecommendation = StateCompatibilityRecommendationRecord;

export type GameCompatibilityObservations = StateCompatibilityObservationsRecord;

export type GameCompatibilityReport = StateCompatibilityReportRecord;

export type SystemFontFamily = SystemFontFamilyRecord;

export type LegalDocumentVersions = LegalDocumentVersionsRecord;

export type LegalAcceptanceStatus = LegalAcceptanceStatusRecord;

export type AcceptLegalDocumentsInput = LegalAcceptDocumentsInputRecord;

export type PortablePreferences = PortablePreferencesRecord;

export type PortableDataSelection = PortableDataSelectionRecord;

export interface PortableExportInput {
  preferences?: PortablePreferences;
  selection?: PortableDataSelection;
}

export interface PortableImportInput {
  importId: string;
  selection: PortableDataSelection;
  resolutions?: PortableMacroConflictResolution[];
}

export type PortableImportOperationSummary = PortableImportOperationSummaryRecord;

export type PortableImportOperations = PortableImportOperationsRecord;

export type PortableMacroConflictCandidate = PortableMacroConflictCandidateRecord;

export type PortableMacroConflict = PortableMacroConflictRecord;

export type PortableMacroConflictResolution = PortableMacroConflictResolutionRecord;

export type PortableRole = PortableRoleRecord;

export type PortableLaunchWorkspace = PortableLaunchWorkspaceRecord;

export type PortableGame = PortableGameRecord;

export type PortableMacro = PortableMacroRecord;

export type RionPortableDataV6 = PortableDataRecord;
export type RionPortableData = PortableDataRecord;

export interface PortableExportResult {
  filePath: string;
  gameCount: number;
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferencesIncluded: boolean;
  selection: PortableDataSelection;
}

export type PortableImportWarningCode = PortableImportWarningRecord["code"];

export type PortableImportWarning = PortableImportWarningRecord;

export type PortableImportPreview = PortableImportPreviewRecord;

export type PortableImportResult = PortableImportResultRecord;

export type ChromeProfileEntry = ChromeProfileEntryRecord;

export type ChromeProfileImportWarning = ChromeProfileImportWarningRecord;

export type ChromeProfileImportPreview = ChromeProfileImportPreviewRecord;

export type ChromeProfileImportInput = ChromeProfileImportRequest;

export type ChromeProfileImportResult = ChromeProfileImportResultRecord;

export interface ChromeProfileImportProgress {
  completedProfileCount: number;
  currentProfileId?: string;
  currentProfileName?: string;
  importId: string;
  phase: "preparing" | "importing" | "completed";
  totalProfileCount: number;
}

export type AppUpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "error";

export type AppUpdateInstallMode = "automatic" | "manual";

export interface AppUpdateStatus {
  currentVersion: string;
  installMode: AppUpdateInstallMode;
  isPackaged: boolean;
  state: AppUpdateState;
  availableVersion?: string;
  downloadProgress?: number;
  downloadUrl?: string;
  releasePageUrl?: string;
  installerName?: string;
  error?: string;
  checkedAt?: string;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = RustLogLevel;

export const LOG_SOURCES = [
  "main",
  "preload",
  "renderer",
  "ipc",
  "browser",
  "macro",
  "persistence",
  "update"
] as const;
export type LogSource = RustLogSource;

export type LogErrorDetails = RustLogErrorDetails;

export type LogEntry = RustLogEntry;

export type LogQuery = RustLogQuery;

export interface LogPage {
  entries: LogEntry[];
  nextCursor?: string;
}

export interface LogStorageStatus {
  currentLevel: LogLevel;
  fileCount: number;
  totalBytes: number;
  oldestTimestamp?: string;
  newestTimestamp?: string;
  retentionDays: number;
  maxBytes: number;
  directory: string;
}

export interface RendererLogEvent {
  event: "renderer_error" | "unhandled_rejection";
  message: string;
  stack?: string;
}

export interface DiagnosticExportResult {
  filePath: string;
  logFileCount: number;
}
