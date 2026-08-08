import type {
  AppUpdateInstallAttemptRecord,
  AppUpdateStatusRecord,
  BrowserHostKind as RustBrowserHostKind,
  BrowserFontSettingsRecord,
  BrowserFontSelectionRecord,
  BrowserFontCatalogEntryRecord,
  BrowserFontInstallResultRecord,
  BrowserFontRuntimePayloadRecord,
  BrowserPerformanceDiagnosticsRecord,
  BrowserPerformanceSettingsRecord,
  ChromeProfileImportPreviewRecord,
  ChromeProfileImportProgressRecord,
  ChromeProfileImportResolutionRecord,
  ChromeProfileImportResultRecord,
  DiagnosticExportResultRecord,
  DisplayInfoRecord,
  DisplayTopologySnapshotRecord,
  DisplayTargetRecord,
  EngineCapabilitySnapshotRecord as RustEngineCapabilitySnapshotRecord,
  SystemWebViewIssueReason as RustSystemWebViewIssueReason,
  GameCreateRequest,
  GameBrowserSettingsPatchRecord,
  GameBrowserSettingsRecord,
  GameUpdateRequest,
  GameWindowCreateInputRecord,
  GameWindowPlacementRecord,
  GameWindowUpdateInputRecord,
  LegalAcceptDocumentsInputRecord,
  LegalAcceptanceStatusRecord,
  LegalDocumentVersionsRecord,
  LogEntry as RustLogEntry,
  LogLevel as RustLogLevel,
  LogPageRecord,
  LogQuery as RustLogQuery,
  LogSource as RustLogSource,
  LogStorageStatusRecord,
  MacroCreateRequest,
  MacroBadgePositionRecord,
  MacroRepeat as RustMacroRepeat,
  MacroSettingsRecord,
  MacroShortcutSourceScope as RustMacroShortcutSourceScope,
  MacroStepDefinition,
  MacroTrigger as RustMacroTrigger,
  MacroUpdateRequest,
  NativeWindowStateRecord,
  PortableDataSelectionRecord,
  PortableExportResultRecord,
  PortableImportOperationsRecord,
  PortableImportPreviewRecord,
  PortableImportResultRecord,
  PortableImportWarningRecord,
  PortableMacroConflictResolutionRecord,
  PortablePreferencesRecord,
  StateGameRecord,
  StateGameWindowRecord,
  StateLaunchWorkspaceRecord,
  StateMacroRecord,
  StateNormalizedRectRecord,
  StatePixelBoundsRecord,
  StateRoleRecord,
  StateWorkspaceSlotRecord,
  SystemFontFamilyRecord,
  WorkspaceAppearanceSettingsRecord,
  RoleCreateRequest,
  RolePathsRecord,
  RoleUpdateRequest,
  RuntimeRoleSlotRecord,
  RuntimeWindowPreferencesRecord,
  ResolvedBrowserEngine as RustResolvedBrowserEngine,
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
export type WorkspaceSlotBrowserZoomPercent = number;
export type AppLanguage = "en" | "zh-TW" | "zh-CN" | "ja";
export type AppThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export type AppWindowState = NativeWindowStateRecord;

export type ApplicationShortcutCommand =
  | "newGameWindow"
  | "toggleFullscreen"
  | "zoomReset"
  | "zoomIn"
  | "zoomOut";

export type GameSource = "builtin" | "custom";

export type Game = StateGameRecord;

export type CreateGameInput = GameCreateRequest;

export type UpdateGameInput = GameUpdateRequest;

export type Role = StateRoleRecord;

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
  /** Availability of the native in-page macro overlay and shortcuts. */
  overlayState?: "ready" | "unavailable";
  /** Health reported by the active system WebView surface. */
  pageHealth?: "healthy" | "unresponsive";
  resolvedEngine?: ResolvedBrowserEngine;
  hostKind?: BrowserHostKind;
  issueReason?: SystemWebViewIssueReason;
  capabilitySnapshot?: EngineCapabilitySnapshot;
}

export type EmbeddedRuntimeTabType = "role" | "workspace";

export interface EmbeddedRuntimeTabSummary {
  id: string;
  type: EmbeddedRuntimeTabType;
  sourceId: string;
  name: string;
  windowId: string;
  roleIds: string[];
  slots: RuntimeRoleSlotRecord[];
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
  id: string;
  windowId: string;
  displayId: number;
  bounds: PixelBounds;
  visible: boolean;
  focused?: boolean;
  activeTabId?: string;
  tabCount: number;
  presentation?: GameWindowPresentation;
}

type SavedGameWindowState = "saved" | "restoring" | "failed";

export interface SavedEmbeddedRuntimeWindowSummary {
  id: string;
  displayId: number;
  displayLabel: string;
  wasVisible: boolean;
  activeSourceId?: string;
  tabCount: number;
  roleCount: number;
  tabNames: string[];
  state: SavedGameWindowState;
  failureMessage?: string;
}

export interface RuntimeSessionRecoverySummary {
  reason: "unclean-exit";
  windowCount: number;
  tabCount: number;
  interruptedWindowIds?: string[];
  sessionGeneration?: number;
}

export interface EmbeddedRuntimeState {
  revision: number;
  capturedAt: string;
  windows: EmbeddedRuntimeWindowSummary[];
  tabs: EmbeddedRuntimeTabSummary[];
  savedWindows?: SavedEmbeddedRuntimeWindowSummary[];
  recovery?: RuntimeSessionRecoverySummary;
}

export type RuntimeWindowPreferences = RuntimeWindowPreferencesRecord;

export type RestoreSavedGameWindowsInput =
  | { scope: "last-visible" | "all" }
  | { scope: "window"; windowId: string };

export type DiscardSavedGameWindowsInput =
  | { scope: "all" }
  | { scope: "window"; windowId: string };

export type MacroTrigger = RustMacroTrigger;

export type MacroActivationMode = "toggle" | "while_held";

export type MacroKeyAction = "tap" | "hold_until_stop";

export type MacroKeyModifier = "primary" | "ctrl" | "alt" | "shift" | "meta";

export type MacroSettings = MacroSettingsRecord;

export type MacroShortcutSourceScope = RustMacroShortcutSourceScope;

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

export type PixelBounds = StatePixelBoundsRecord;

export type DisplayTarget = DisplayTargetRecord;

type GameWindowPresentation = GameWindowPlacementRecord["presentation"];

export type GameWindow = StateGameWindowRecord;

export type CreateGameWindowInput = GameWindowCreateInputRecord;

export type UpdateGameWindowInput = Pick<
  GameWindowUpdateInputRecord,
  "name" | "targetDisplay" | "placement" | "tabs" | "activeTabId"
>;

export type LaunchWorkspace = StateLaunchWorkspaceRecord;

export type CreateLaunchWorkspaceInput = WorkspaceCreateRequest;

export type UpdateLaunchWorkspaceInput = WorkspaceUpdateRequest;

export type DisplayInfo = DisplayInfoRecord;
export type DisplayTopology = DisplayTopologySnapshotRecord;
export interface AppSnapshot {
  embeddedRuntimeState: EmbeddedRuntimeState;
  games: Game[];
  gameWindows: GameWindow[];
  roles: Role[];
  roleStatuses: RoleStatus[];
  launchWorkspaces: LaunchWorkspace[];
  displayTopology: DisplayTopology;
  macros: Macro[];
  macroStatuses: MacroRunStatus[];
}

export interface RoleLaunchResult {
  launchReceipt: import("./generated").RuntimeLaunchIntentReceiptRecord;
  windowId: string;
  status: RoleStatus | null;
}

export interface WorkspaceLaunchResult {
  kind: "launched";
  launchReceipt: import("./generated").RuntimeLaunchIntentReceiptRecord;
  windowId: string;
  statuses: RoleStatus[];
}

export type BrowserFontSlot = "cjk" | "latin" | "numeric" | "monospace" | "math";
export type BrowserFontSettingsMode = "default" | "custom";
export type BrowserFontCjkVariant = "auto" | "tc" | "sc" | "jp";
export type BrowserFontSelection = BrowserFontSelectionRecord;
export type BrowserFontCategory = "sans" | "serif" | "handwriting" | "display" | "monospace" | "math";

export type BrowserFontCatalogEntry = BrowserFontCatalogEntryRecord;
export type BrowserFontInstallResult = BrowserFontInstallResultRecord;
export type BrowserFontRuntimePayload = BrowserFontRuntimePayloadRecord;
export type BrowserRuntimeMode = "embedded";
export type ResolvedBrowserEngine = RustResolvedBrowserEngine;
export type BrowserHostKind = RustBrowserHostKind;
export type SystemWebViewIssueReason = RustSystemWebViewIssueReason;
export type EngineCapabilitySnapshot = RustEngineCapabilitySnapshotRecord;
export type WorkspaceBackgroundStyle = "material" | "black";
export type WorkspaceGapSize = 1 | 2 | 4 | 6 | 8 | 12 | 16;

export type BrowserFontSettings = BrowserFontSettingsRecord;

export type BrowserPerformanceSettings = BrowserPerformanceSettingsRecord;

export type WorkspaceAppearanceSettings = WorkspaceAppearanceSettingsRecord;

export type MacroBadgeHorizontalAlign = "left" | "center" | "right";

export type MacroBadgePositionSettings = MacroBadgePositionRecord;

export type GameBrowserSettings = GameBrowserSettingsRecord;
export type GameBrowserSettingsPatch = GameBrowserSettingsPatchRecord;

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

export type PortableImportOperations = PortableImportOperationsRecord;

export type PortableMacroConflictResolution = PortableMacroConflictResolutionRecord;

export type PortableExportResult = PortableExportResultRecord;

export type PortableImportWarningCode = PortableImportWarningRecord["code"];

export type PortableImportWarning = PortableImportWarningRecord;

export type PortableImportPreview = PortableImportPreviewRecord;

export type PortableImportResult = PortableImportResultRecord;

export type ChromeProfileImportPreview = ChromeProfileImportPreviewRecord;

export type ChromeProfileImportResolution = ChromeProfileImportResolutionRecord;

export type ChromeProfileImportResult = ChromeProfileImportResultRecord;

export type ChromeProfileImportProgress = ChromeProfileImportProgressRecord;

export interface ChromeProfileImportInput {
  importId: string;
  gameId: string;
  consentAccepted: boolean;
  resolutions: ChromeProfileImportResolution[];
}

export type AppUpdateInstallAttempt = AppUpdateInstallAttemptRecord;
export type AppUpdateStatus = AppUpdateStatusRecord;
export type LogLevel = RustLogLevel;
export type LogSource = RustLogSource;

export type LogEntry = RustLogEntry;

export type LogQuery = RustLogQuery;

export type LogPage = LogPageRecord;

export type LogStorageStatus = LogStorageStatusRecord;

export interface RendererLogEvent {
  event: "renderer_error" | "unhandled_rejection";
  message: string;
  stack?: string;
}

export type DiagnosticExportResult = DiagnosticExportResultRecord;

export type BrowserPerformanceDiagnostics = BrowserPerformanceDiagnosticsRecord;
