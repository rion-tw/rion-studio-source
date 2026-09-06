import type {
  AcceptLegalDocumentsInput,
  ApplicationShortcutCommand,
  AppLanguage,
  AppSnapshot,
  AppUpdateInstallAttempt,
  AppUpdateStatus,
  AppWindowState,
  BulkDeleteInput,
  BulkDeleteResult,
  BrowserFontCatalogEntry,
  BrowserFontInstallResult,
  BrowserFontRuntimePayload,
  BrowserFontSettings,
  ChromeProfileImportInput,
  ChromeProfileImportPreview,
  ChromeProfileImportProgress,
  ChromeProfileImportResult,
  CreateGameWindowInput,
  CreateGameInput,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  GameBrowserSettingsPatch,
  Game,
  DiagnosticExportResult,
  DiscardSavedGameWindowsInput,
  EmbeddedRuntimeState,
  DisplayTopology,
  GameWindow,
  LaunchWorkspace,
  LogEntry,
  LogLevel,
  LogPage,
  LogQuery,
  LogStorageStatus,
  RendererLogEvent,
  LegalAcceptanceStatus,
  Macro,
  MacroPageRequest,
  MacroRunStatus,
  MacroSettings,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  QuickAccessItemRef,
  QuickAccessPresentationRequest,
  QuickAccessPreferences,
  QuickAccessRequestResolution,
  ReorderItemsInput,
  RestoreSavedGameWindowsInput,
  ResolvedTheme,
  Role,
  RoleLaunchResult,
  RuntimeLaunchDestination,
  RolePaths,
  RoleStatus,
  RuntimeWindowPreferences,
  SystemFontFamily,
  UpdateLaunchWorkspaceInput,
  UpdateGameInput,
  UpdateGameWindowInput,
  UpdateMacroInput,
  UpdateRoleInput,
  WorkspaceLaunchResult
} from "./types";
import type {
  CoreErrorPayload,
  ApplicationLifecycleStatusRecord,
  RuntimeTabMoveResultRecord,
  SurfaceRecoveryAttemptRecord,
  SystemRuntimeOperationSummaryRecord
} from "./generated";

export interface RionStudioApi {
  notifyRendererReady: () => Promise<void>;
  getAppSnapshot: () => Promise<AppSnapshot>;
  getCurrentWindowState: () => Promise<AppWindowState>;
  getApplicationLifecycleStatus: () => Promise<ApplicationLifecycleStatusRecord>;
  getLegalAcceptanceStatus: () => Promise<LegalAcceptanceStatus>;
  acceptLegalDocuments: (input: AcceptLegalDocumentsInput) => Promise<LegalAcceptanceStatus>;
  quitApplication: () => Promise<void>;
  confirmApplicationQuit: () => Promise<void>;
  requestCurrentWindowClose: () => Promise<void>;
  minimizeCurrentWindow: () => Promise<SystemRuntimeOperationSummaryRecord>;
  startCurrentWindowDrag: () => Promise<SystemRuntimeOperationSummaryRecord>;
  toggleCurrentWindowMaximize: () => Promise<void>;
  executeApplicationShortcut: (command: ApplicationShortcutCommand) => Promise<void>;
  getEmbeddedRuntimeState: () => Promise<EmbeddedRuntimeState>;
  listGameWindows: () => Promise<GameWindow[]>;
  createGameWindow: (input: CreateGameWindowInput) => Promise<GameWindow>;
  updateGameWindow: (id: string, input: UpdateGameWindowInput) => Promise<GameWindow>;
  reorderGameWindows: (input: ReorderItemsInput) => Promise<GameWindow[]>;
  showGameWindow: (windowId: string) => Promise<void>;
  hideGameWindow: (windowId: string) => Promise<SystemRuntimeOperationSummaryRecord>;
  stopGameWindow: (windowId: string) => Promise<SystemRuntimeOperationSummaryRecord>;
  deleteGameWindow: (windowId: string) => Promise<SystemRuntimeOperationSummaryRecord>;
  showGameWindowTab: (tabId: string) => Promise<SystemRuntimeOperationSummaryRecord>;
  moveGameWindowTab: (
    tabId: string,
    windowId: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  moveGameWindowTabToNewWindow: (tabId: string) => Promise<RuntimeTabMoveResultRecord>;
  reorderGameWindowTab: (
    tabId: string,
    beforeTabId?: string
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  setGameWindowTabMuted: (
    tabId: string,
    muted: boolean
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  setGameWindowTabHidden: (
    tabId: string,
    hidden: boolean
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  stopGameWindowTab: (tabId: string) => Promise<SystemRuntimeOperationSummaryRecord>;
  restoreSavedGameWindows: (input: RestoreSavedGameWindowsInput) => Promise<void>;
  discardSavedGameWindows: (input: DiscardSavedGameWindowsInput) => Promise<void>;
  getRuntimeWindowPreferences: () => Promise<RuntimeWindowPreferences>;
  updateRuntimeWindowPreferences: (
    preferences: RuntimeWindowPreferences
  ) => Promise<RuntimeWindowPreferences>;
  setQuickAccessPinned: (
    item: QuickAccessItemRef,
    pinned: boolean
  ) => Promise<QuickAccessPreferences>;
  recordQuickAccessUse: (item: QuickAccessItemRef) => Promise<QuickAccessPreferences>;
  clearQuickAccessRecent: () => Promise<QuickAccessPreferences>;
  consumePendingQuickAccessRequest: () => Promise<QuickAccessPresentationRequest | null>;
  presentQuickAccessRequest: (requestId: string) => Promise<boolean>;
  resolveQuickAccessRequest: (
    requestId: string,
    resolution: QuickAccessRequestResolution
  ) => Promise<void>;
  listGames: () => Promise<Game[]>;
  createGame: (input: CreateGameInput) => Promise<Game>;
  updateGame: (id: string, input: UpdateGameInput) => Promise<Game>;
  resetBuiltinGame: (id: string) => Promise<Game>;
  deleteGame: (id: string) => Promise<void>;
  deleteGames: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  listRoles: () => Promise<Role[]>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  reorderRoles: (input: ReorderItemsInput) => Promise<Role[]>;
  deleteRole: (id: string) => Promise<void>;
  deleteRoles: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  clearRoleBrowserData: (id: string) => Promise<Role>;
  clearGlobalWebProfile: () => Promise<void>;
  getRolePaths: (id: string) => Promise<RolePaths>;
  launchRole: (
    id: string,
    destination?: RuntimeLaunchDestination
  ) => Promise<RoleLaunchResult>;
  stopRole: (id: string) => Promise<void>;
  listRoleStatuses: () => Promise<RoleStatus[]>;
  listLaunchWorkspaces: () => Promise<LaunchWorkspace[]>;
  createLaunchWorkspace: (input: CreateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  updateLaunchWorkspace: (id: string, input: UpdateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  reorderLaunchWorkspaces: (input: ReorderItemsInput) => Promise<LaunchWorkspace[]>;
  deleteLaunchWorkspace: (id: string) => Promise<void>;
  deleteLaunchWorkspaces: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  getDisplayTopology: () => Promise<DisplayTopology>;
  launchWorkspace: (
    id: string,
    destination?: RuntimeLaunchDestination
  ) => Promise<WorkspaceLaunchResult>;
  stopLaunchWorkspace: (id: string) => Promise<void>;
  listMacros: () => Promise<Macro[]>;
  createMacro: (input: CreateMacroInput) => Promise<Macro>;
  updateMacro: (id: string, input: UpdateMacroInput) => Promise<Macro>;
  deleteMacro: (id: string) => Promise<void>;
  deleteMacros: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  startMacro: (macroId: string) => Promise<MacroRunStatus[]>;
  stopMacro: (macroId: string) => Promise<void>;
  listMacroStatuses: () => Promise<MacroRunStatus[]>;
  getMacroSettings: () => Promise<MacroSettings>;
  updateMacroSettings: (settings: MacroSettings) => Promise<MacroSettings>;
  exportPortableData: (input?: PortableExportInput) => Promise<PortableExportResult | null>;
  previewPortableImport: () => Promise<PortableImportPreview | null>;
  applyPortableImport: (input: PortableImportInput) => Promise<PortableImportResult>;
  discardPortableImport: (importId: string) => Promise<void>;
  previewChromeProfileImport: () => Promise<ChromeProfileImportPreview | null>;
  requestChromeQuitForImport: (importId: string) => Promise<ChromeProfileImportPreview>;
  applyChromeProfileImport: (input: ChromeProfileImportInput) => Promise<ChromeProfileImportResult>;
  discardChromeProfileImport: (importId: string) => Promise<void>;
  getGameBrowserSettings: () => Promise<GameBrowserSettings>;
  updateGameBrowserSettings: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
  patchGameBrowserSettings: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>;
  listBrowserFontCatalog: () => Promise<BrowserFontCatalogEntry[]>;
  installBrowserFont: (catalogId: string) => Promise<BrowserFontInstallResult>;
  installGoogleFont: (family: string) => Promise<BrowserFontInstallResult>;
  removeBrowserFont: (catalogId: string) => Promise<BrowserFontInstallResult>;
  getBrowserFontPreview: (settings: BrowserFontSettings) => Promise<BrowserFontRuntimePayload>;
  getLogStatus: () => Promise<LogStorageStatus>;
  queryLogs: (query?: LogQuery) => Promise<LogPage>;
  setLogLevel: (level: LogLevel) => Promise<LogStorageStatus>;
  clearLogs: () => Promise<LogStorageStatus>;
  revealLogs: () => Promise<void>;
  exportDiagnostics: () => Promise<DiagnosticExportResult | null>;
  reportRendererLog: (event: RendererLogEvent) => void;
  listSystemFonts: () => Promise<SystemFontFamily[]>;
  consumePendingMacroPageRequest: () => Promise<MacroPageRequest | null>;
  setOverlayLanguage: (language: AppLanguage) => Promise<void>;
  setRuntimeTheme: (theme: ResolvedTheme) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<AppUpdateInstallAttempt>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onAppSnapshotChanged: (callback: (snapshot: AppSnapshot) => void) => () => void;
  onApplicationQuitRequested: (callback: () => void) => () => void;
  onCurrentWindowStateChanged: (callback: (state: AppWindowState) => void) => () => void;
  onApplicationLifecycleChanged: (
    callback: (status: ApplicationLifecycleStatusRecord) => void
  ) => () => void;
  onEmbeddedRuntimeStateChanged: (callback: (state: EmbeddedRuntimeState) => void) => () => void;
  onWindowLifecycleChanged: (
    callback: (receipt: SystemRuntimeOperationSummaryRecord) => void
  ) => () => void;
  onSurfaceRecoveryAttemptChanged: (
    callback: (attempt: SurfaceRecoveryAttemptRecord) => void
  ) => () => void;
  onGamesChanged: (callback: (games: Game[]) => void) => () => void;
  onRolesChanged: (callback: (roles: Role[]) => void) => () => void;
  onGameWindowsChanged: (callback: (gameWindows: GameWindow[]) => void) => () => void;
  onWorkspacesChanged: (callback: (workspaces: LaunchWorkspace[]) => void) => () => void;
  onDisplayTopologyChanged: (callback: (topology: DisplayTopology) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacrosChanged: (callback: (macros: Macro[]) => void) => () => void;
  onMacroPageRequested: (callback: (request: MacroPageRequest) => void) => () => void;
  onQuickAccessRequested: (
    callback: (request: QuickAccessPresentationRequest) => void
  ) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
  onShellError: (callback: (error: CoreErrorPayload) => void) => () => void;
  onLogEntryAdded: (callback: (entry: LogEntry) => void) => () => void;
  onChromeProfileImportProgress: (
    callback: (progress: ChromeProfileImportProgress) => void
  ) => () => void;

}
