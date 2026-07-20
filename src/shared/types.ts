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

export type AuthState = "unknown" | "login_required" | "authenticated" | "auth_failed";
export type AuthFlowState =
  | "opening_app"
  | "opening_chrome"
  | "waiting_for_login"
  | "closing_login_window"
  | "waiting_for_chrome_close"
  | "waiting_for_user_data_release"
  | "checking_session"
  | "launching"
  | "failed";

export type GameSource = "builtin" | "custom";
export type BuiltinGameKey = "flyff-universe" | "feifei-infinite-universe";

export interface Game {
  id: string;
  source: GameSource;
  builtinKey?: BuiltinGameKey;
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
  loginUrl?: string;
  browserLaunchMode: InheritableBrowserLaunchMode;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGameInput {
  name: string;
  iconImageDataUrl?: string | null;
  coverImageDataUrl?: string | null;
  defaultLaunchUrl: string;
  loginUrl?: string | null;
  browserLaunchMode?: InheritableBrowserLaunchMode;
}

export type UpdateGameInput = Partial<CreateGameInput>;

export interface Role {
  id: string;
  gameId: string;
  name: string;
  launchUrl: string;
  notes: string;
  authState: AuthState;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
  lastAuthCheckAt?: string;
  lastSuccessfulLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  gameId: string;
  name: string;
  launchUrl?: string;
  notes?: string;
  coverImageDataUrl?: string | null;
  coverImageDominantColor?: string | null;
}

export type UpdateRoleInput = Partial<Omit<CreateRoleInput, "name">> & {
  name?: string;
};

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

export interface MacroTrigger {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export type MacroActivationMode = "toggle" | "while_held";

export type MacroKeyAction = "tap" | "hold_until_stop";

export type MacroKeyModifier = "primary" | "ctrl" | "alt" | "shift" | "meta";

export interface MacroSettings {
  startupDelayMs: number;
  keyHoldMs: number;
  postInputDelayMs: number;
  defaultLoopDelayMs: number;
}

export type MacroRepeat =
  | {
      type: "once";
    }
  | {
      type: "loop";
      intervalMs: number;
    };

export type MacroCallMode = "wait" | "trigger";
export type MacroClickUnit = "percent" | "px";

export type MacroStep =
  | {
      id: string;
      type: "key";
      code: string;
      modifiers?: MacroKeyModifier[];
      action?: MacroKeyAction;
      label?: string;
    }
  | {
      id: string;
      type: "click";
      unit?: "percent";
      xPercent: number;
      yPercent: number;
    }
  | {
      id: string;
      type: "click";
      unit: "px";
      xPx: number;
      yPx: number;
    }
  | {
      id: string;
      type: "delay";
      ms: number;
    }
  | {
      id: string;
      type: "macro";
      macroId: string;
      /** Defaults to wait for legacy macro step data. */
      callMode?: MacroCallMode;
    };

export interface Macro {
  id: string;
  enabled: boolean;
  activationMode?: MacroActivationMode;
  name: string;
  roleIds: string[];
  trigger?: MacroTrigger;
  repeat: MacroRepeat;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMacroInput {
  enabled?: boolean;
  activationMode?: MacroActivationMode;
  name: string;
  roleIds: string[];
  trigger?: MacroTrigger | null;
  repeat?: MacroRepeat;
  steps: MacroStep[];
}

export type UpdateMacroInput = Partial<CreateMacroInput>;

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
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface AuthFlowStatus {
  roleId: string;
  state: AuthFlowState;
  message?: string;
  startedAt: string;
  updatedAt: string;
}

export interface RolePaths {
  browserUserDataDir: string;
}

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaunchWorkspaceSlot {
  id: string;
  roleId?: string;
  browserZoomPercent?: WorkspaceSlotBrowserZoomPercent;
  rect: NormalizedRect;
}

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

export interface WorkspaceResourcePolicy {
  mode: WorkspaceResourceMode;
}

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceDisplayFingerprint {
  label: string;
  bounds: PixelBounds;
  resolution: {
    width: number;
    height: number;
  };
  scaleFactor: number;
  isPrimary: boolean;
  isInternal: boolean;
}

export interface WorkspaceDisplayTarget {
  /** Most recently observed runtime display id. */
  id: number;
  /** Absent only for launch workspaces migrated from the legacy id-only format. */
  fingerprint?: WorkspaceDisplayFingerprint;
}

export interface LaunchWorkspace {
  id: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserLaunchMode: InheritableBrowserLaunchMode;
  browserZoomMode: WorkspaceBrowserZoomMode;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  resourcePolicy: WorkspaceResourcePolicy;
  targetDisplay?: WorkspaceDisplayTarget;
  slots: LaunchWorkspaceSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLaunchWorkspaceInput {
  name: string;
  template?: WorkspaceLayoutTemplate;
  browserLaunchMode?: InheritableBrowserLaunchMode;
  browserZoomMode?: WorkspaceBrowserZoomMode;
  browserZoomPercent?: WorkspaceBrowserZoomPercent;
  resourcePolicy?: WorkspaceResourcePolicy;
  targetDisplay?: WorkspaceDisplayTarget | null;
  slots?: Array<Partial<Pick<LaunchWorkspaceSlot, "id" | "roleId" | "browserZoomPercent" | "rect">>>;
}

export type UpdateLaunchWorkspaceInput = Partial<CreateLaunchWorkspaceInput>;

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
  authStatuses: AuthFlowStatus[];
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

export interface BrowserFontSettings {
  mode: BrowserFontSettingsMode;
  families: Partial<Record<BrowserFontFamilyRole, string>>;
}

export interface BrowserProxySettings {
  mode: BrowserProxySettingsMode;
  server: string;
}

export interface BrowserCdnCompatibilitySettings {
  mode: BrowserCdnCompatibilityMode;
}

export interface BrowserNetworkSettings {
  cdnCompatibility: BrowserCdnCompatibilitySettings;
  proxy: BrowserProxySettings;
}

export interface BrowserGraphicsSettings {
  mode: BrowserGraphicsMode;
}

export interface WorkspaceAppearanceSettings {
  background: WorkspaceBackgroundStyle;
  gap: WorkspaceGapSize;
}

export type MacroBadgeHorizontalAlign = "left" | "center" | "right";

export interface MacroBadgePositionSettings {
  horizontalAlign: MacroBadgeHorizontalAlign;
  horizontalMarginPx: number;
  topPx: number;
}

export interface GameBrowserSettings {
  fonts: BrowserFontSettings;
  graphics: BrowserGraphicsSettings;
  launchMode: BrowserLaunchMode;
  macroBadgePosition: MacroBadgePositionSettings;
  network: BrowserNetworkSettings;
  workspace: WorkspaceAppearanceSettings;
}

export type WebGraphicsAvailability = "available" | "unavailable" | "unknown";

export interface WebGraphicsDiagnostics {
  error?: string;
  renderer?: string;
  vendor?: string;
  webgl: WebGraphicsAvailability;
  webgl2: WebGraphicsAvailability;
  webgpu: WebGraphicsAvailability;
}

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

export type GameCompatibilityRunPhase =
  | "preparing"
  | "loading"
  | "probing"
  | "cleaning_up";

export interface GameCompatibilityRunStatus {
  gameId: string;
  phase: GameCompatibilityRunPhase;
  startedAt: string;
  updatedAt: string;
}

export interface GameCompatibilityLoadResult {
  state: "available" | "failed" | "cancelled";
  durationMs: number;
  finalOrigin?: string;
  errorCode?: string;
}

export interface GameCompatibilityChromeResult {
  state: "available" | "unavailable";
}

export interface GameCompatibilityRecommendation {
  mode?: BrowserLaunchMode;
  reason: "embedded_available" | "external_recommended" | "chrome_required" | "graphics_unavailable";
}

export interface GameCompatibilityObservations {
  lastEmbeddedSuccessAt?: string;
  lastExternalSuccessAt?: string;
  lastFallbackAt?: string;
  lastLaunchFailureAt?: string;
  lastLaunchFailureCode?: string;
  lastAuthSuccessAt?: string;
  lastAuthFailureAt?: string;
}

export interface GameCompatibilityReport {
  gameId: string;
  checkedAt?: string;
  configurationFingerprint?: string;
  isStale: boolean;
  load?: GameCompatibilityLoadResult;
  graphics?: WebGraphicsDiagnostics;
  systemChrome?: GameCompatibilityChromeResult;
  recommendation?: GameCompatibilityRecommendation;
  observations: GameCompatibilityObservations;
}

export interface SystemFontFamily {
  family: string;
  label: string;
}

export interface LegalDocumentVersions {
  fairUse: string;
  privacy: string;
  terms: string;
}

export interface LegalAcceptanceStatus {
  acceptedAt?: string;
  acceptedFairUseVersion?: string;
  acceptedTermsVersion?: string;
  acknowledgedPrivacyVersion?: string;
  currentVersions: LegalDocumentVersions;
  isAccepted: boolean;
}

export interface AcceptLegalDocumentsInput {
  fairUseVersion: string;
  privacyVersion: string;
  termsVersion: string;
}

export interface PortablePreferences {
  gameBrowserSettings?: GameBrowserSettings;
  language?: AppLanguage;
  macroSettings?: MacroSettings;
  themeMode?: AppThemeMode;
}

export interface PortableDataSelection {
  games: boolean;
  roles: boolean;
  launchWorkspaces: boolean;
  macros: boolean;
  preferences: boolean;
}

export interface PortableExportInput {
  preferences?: PortablePreferences;
  selection?: PortableDataSelection;
}

export interface PortableImportInput {
  importId: string;
  selection: PortableDataSelection;
  resolutions?: PortableMacroConflictResolution[];
}

export interface PortableImportOperationSummary {
  create: number;
  update: number;
  unchanged: number;
  skip: number;
}

export interface PortableImportOperations {
  games: PortableImportOperationSummary;
  roles: PortableImportOperationSummary;
  launchWorkspaces: PortableImportOperationSummary;
  macros: PortableImportOperationSummary;
}

export interface PortableMacroConflictCandidate {
  id: string;
  name: string;
  roleNames: string[];
  stepCount: number;
  trigger?: MacroTrigger;
  updatedAt: string;
}

export interface PortableMacroConflict {
  id: string;
  macroId: string;
  name: string;
  roleNames: string[];
  candidates: PortableMacroConflictCandidate[];
}

export type PortableMacroConflictResolution =
  | { conflictId: string; action: "update"; targetMacroId: string }
  | { conflictId: string; action: "copy" }
  | { conflictId: string; action: "skip" };

export interface PortableRole {
  id: string;
  gameId?: string;
  /** Internal import marker; never emitted by exports. */
  gameRecovered?: boolean;
  name: string;
  launchUrl: string;
  notes: string;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
}

export interface PortableLaunchWorkspace {
  id: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserLaunchMode?: InheritableBrowserLaunchMode;
  /** Missing in exports created before adaptive browser zoom was introduced. */
  browserZoomMode?: WorkspaceBrowserZoomMode;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  resourcePolicy?: WorkspaceResourcePolicy;
  slots: LaunchWorkspaceSlot[];
}

export interface PortableGame {
  id: string;
  /** Internal import marker; never emitted by exports. */
  inferred?: boolean;
  source: GameSource;
  builtinKey?: BuiltinGameKey;
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
  loginUrl?: string;
  browserLaunchMode: InheritableBrowserLaunchMode;
}

export interface PortableMacro {
  id: string;
  enabled?: boolean;
  activationMode?: MacroActivationMode;
  name: string;
  roleIds: string[];
  trigger?: MacroTrigger;
  repeat: MacroRepeat;
  steps: MacroStep[];
}

export interface RionPortableDataV1 {
  app: "Rion Studio";
  schemaVersion: 1;
  exportedAt: string;
  appVersion: string;
  roles: PortableRole[];
  launchWorkspaces: PortableLaunchWorkspace[];
  macros: PortableMacro[];
  preferences?: PortablePreferences;
}

export interface RionPortableDataV2 {
  app: "Rion Studio";
  schemaVersion: 2;
  exportedAt: string;
  appVersion: string;
  games: PortableGame[];
  roles: PortableRole[];
  launchWorkspaces: PortableLaunchWorkspace[];
  macros: PortableMacro[];
  preferences?: PortablePreferences;
}

export interface RionPortableDataV3 {
  app: "Rion Studio";
  schemaVersion: 3;
  exportedAt: string;
  appVersion: string;
  games: PortableGame[];
  roles: PortableRole[];
  launchWorkspaces: PortableLaunchWorkspace[];
  macros: PortableMacro[];
  preferences?: PortablePreferences;
}

export interface RionPortableDataV4 {
  app: "Rion Studio";
  schemaVersion: 4;
  exportedAt: string;
  appVersion: string;
  games: PortableGame[];
  roles: PortableRole[];
  launchWorkspaces: PortableLaunchWorkspace[];
  macros: PortableMacro[];
  preferences?: PortablePreferences;
}

export interface RionPortableDataV5 {
  app: "Rion Studio";
  schemaVersion: 5;
  exportedAt: string;
  appVersion: string;
  games: PortableGame[];
  roles: PortableRole[];
  launchWorkspaces: PortableLaunchWorkspace[];
  macros: PortableMacro[];
  preferences?: PortablePreferences;
}

export interface RionPortableDataV6 extends Omit<RionPortableDataV5, "schemaVersion"> {
  schemaVersion: 6;
}

export type RionPortableData =
  | RionPortableDataV1
  | RionPortableDataV2
  | RionPortableDataV3
  | RionPortableDataV4
  | RionPortableDataV5
  | RionPortableDataV6;

export interface PortableExportResult {
  filePath: string;
  gameCount: number;
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferencesIncluded: boolean;
  selection: PortableDataSelection;
}

export type PortableImportWarningCode =
  | "GAME_NAME_RENAMED"
  | "BUILTIN_GAME_DEFAULTS_REPLACED"
  | "ROLE_GAME_RECOVERED"
  | "ROLE_NAME_RENAMED"
  | "WORKSPACE_NAME_RENAMED"
  | "WORKSPACE_ROLE_MISSING"
  | "MACRO_NAME_RENAMED"
  | "MACRO_ROLE_MISSING"
  | "MACRO_SHORTCUT_CLEARED_CONFLICT"
  | "MACRO_SHORTCUT_CLEARED_RESERVED"
  | "MACRO_SKIPPED_NO_ROLES"
  | "MACRO_SKIPPED_MISSING_DEPENDENCY";

export interface PortableImportWarning {
  code: PortableImportWarningCode;
  itemName?: string;
  replacementName?: string;
  count?: number;
}

export interface PortableImportPreview {
  importId: string;
  filePath: string;
  exportedAt: string;
  appVersion: string;
  gameCount: number;
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferences?: PortablePreferences;
  operations: PortableImportOperations;
  conflicts: PortableMacroConflict[];
  warnings: PortableImportWarning[];
}

export interface PortableImportResult {
  gameCount: number;
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferencesIncluded: boolean;
  preferences?: PortablePreferences;
  selection: PortableDataSelection;
  operations: PortableImportOperations;
  warnings: PortableImportWarning[];
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
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_SOURCES = [
  "main",
  "preload",
  "renderer",
  "ipc",
  "browser",
  "auth",
  "macro",
  "persistence",
  "update"
] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export interface LogErrorDetails {
  name: string;
  message: string;
  stack?: string;
  cause?: LogErrorDetails;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  event: string;
  message: string;
  sessionId: string;
  context?: Record<string, unknown>;
  error?: LogErrorDetails;
}

export interface LogQuery {
  levels?: LogLevel[];
  sources?: LogSource[];
  search?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

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
