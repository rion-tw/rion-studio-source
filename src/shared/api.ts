import type {
  AcceptLegalDocumentsInput,
  ApplicationShortcutCommand,
  AppLanguage,
  AppSnapshot,
  AppUpdateStatus,
  AppWindowState,
  BulkDeleteInput,
  BulkDeleteResult,
  BrowserFontCatalogEntry,
  BrowserFontInstallResult,
  BrowserFontRuntimePayload,
  BrowserFontSettings,
  BrowserPerformanceDiagnostics,
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
  DisplayInfo,
  GameWindow,
  LaunchWorkspace,
  LegacySessionRestore,
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
  ReorderItemsInput,
  RestoreSavedGameWindowsInput,
  Role,
  RoleLaunchInput,
  RoleLaunchResult,
  RolePaths,
  RoleStatus,
  RuntimeWindowPreferences,
  SystemFontFamily,
  UpdateLaunchWorkspaceInput,
  UpdateGameInput,
  UpdateGameWindowInput,
  UpdateMacroInput,
  UpdateRoleInput,
  WorkspaceLaunchInput,
  WorkspaceLaunchResult
} from "./types";
import type { CoreErrorPayload } from "./generated";

export interface RionStudioApi {
  notifyRendererReady: () => Promise<void>;
  getAppSnapshot: () => Promise<AppSnapshot>;
  getCurrentWindowState: () => Promise<AppWindowState>;
  getLegalAcceptanceStatus: () => Promise<LegalAcceptanceStatus>;
  acceptLegalDocuments: (input: AcceptLegalDocumentsInput) => Promise<LegalAcceptanceStatus>;
  quitApplication: () => Promise<void>;
  requestCurrentWindowClose: () => void;
  startCurrentWindowDrag: () => Promise<void>;
  toggleCurrentWindowMaximize: () => Promise<void>;
  executeApplicationShortcut: (command: ApplicationShortcutCommand) => Promise<void>;
  getEmbeddedRuntimeState: () => Promise<EmbeddedRuntimeState>;
  listGameWindows: () => Promise<GameWindow[]>;
  createGameWindow: (input: CreateGameWindowInput) => Promise<GameWindow>;
  updateGameWindow: (id: string, input: UpdateGameWindowInput) => Promise<GameWindow>;
  reorderGameWindows: (input: ReorderItemsInput) => Promise<GameWindow[]>;
  showGameWindow: (windowId: string) => Promise<void>;
  closeGameWindow: (windowId: string) => Promise<void>;
  stopGameWindow: (windowId: string) => Promise<void>;
  deleteGameWindow: (windowId: string) => Promise<void>;
  showGameWindowTab: (tabId: string) => Promise<void>;
  moveGameWindowTab: (tabId: string, windowId: string) => Promise<void>;
  moveGameWindowTabToNewWindow: (tabId: string) => Promise<GameWindow>;
  setGameWindowTabMuted: (tabId: string, muted: boolean) => Promise<void>;
  setGameWindowTabHidden: (tabId: string, hidden: boolean) => Promise<void>;
  stopGameWindowTab: (tabId: string) => Promise<void>;
  restoreSavedGameWindows: (input: RestoreSavedGameWindowsInput) => Promise<void>;
  discardSavedGameWindows: (input: DiscardSavedGameWindowsInput) => Promise<void>;
  getRuntimeWindowPreferences: () => Promise<RuntimeWindowPreferences>;
  updateRuntimeWindowPreferences: (
    preferences: RuntimeWindowPreferences
  ) => Promise<RuntimeWindowPreferences>;
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
  getRolePaths: (id: string) => Promise<RolePaths>;
  launchRole: (id: string, input?: RoleLaunchInput) => Promise<RoleLaunchResult>;
  stopRole: (id: string) => Promise<void>;
  listRoleStatuses: () => Promise<RoleStatus[]>;
  listLaunchWorkspaces: () => Promise<LaunchWorkspace[]>;
  createLaunchWorkspace: (input: CreateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  updateLaunchWorkspace: (id: string, input: UpdateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  reorderLaunchWorkspaces: (input: ReorderItemsInput) => Promise<LaunchWorkspace[]>;
  deleteLaunchWorkspace: (id: string) => Promise<void>;
  deleteLaunchWorkspaces: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  listDisplays: () => Promise<DisplayInfo[]>;
  launchWorkspace: (id: string, input?: WorkspaceLaunchInput) => Promise<WorkspaceLaunchResult>;
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
  removeBrowserFont: (catalogId: string) => Promise<BrowserFontInstallResult>;
  getBrowserFontPreview: (settings: BrowserFontSettings) => Promise<BrowserFontRuntimePayload>;
  getLogStatus: () => Promise<LogStorageStatus>;
  queryLogs: (query?: LogQuery) => Promise<LogPage>;
  setLogLevel: (level: LogLevel) => Promise<LogStorageStatus>;
  clearLogs: () => Promise<LogStorageStatus>;
  revealLogs: () => Promise<void>;
  collectBrowserPerformanceDiagnostics: () => Promise<BrowserPerformanceDiagnostics>;
  exportDiagnostics: () => Promise<DiagnosticExportResult | null>;
  reportRendererLog: (event: RendererLogEvent) => void;
  listSystemFonts: () => Promise<SystemFontFamily[]>;
  consumePendingMacroPageRequest: () => Promise<MacroPageRequest | null>;
  setOverlayLanguage: (language: AppLanguage) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onCurrentWindowStateChanged: (callback: (state: AppWindowState) => void) => () => void;
  onEmbeddedRuntimeStateChanged: (callback: (state: EmbeddedRuntimeState) => void) => () => void;
  onGamesChanged: (callback: (games: Game[]) => void) => () => void;
  onRolesChanged: (callback: (roles: Role[]) => void) => () => void;
  onGameWindowsChanged: (callback: (gameWindows: GameWindow[]) => void) => () => void;
  onWorkspacesChanged: (callback: (workspaces: LaunchWorkspace[]) => void) => () => void;
  onDisplaysChanged: (callback: (displays: DisplayInfo[]) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacrosChanged: (callback: (macros: Macro[]) => void) => () => void;
  onMacroPageRequested: (callback: (request: MacroPageRequest) => void) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
  onShellError: (callback: (error: CoreErrorPayload) => void) => () => void;
  onLogEntryAdded: (callback: (entry: LogEntry) => void) => () => void;
  onChromeProfileImportProgress: (
    callback: (progress: ChromeProfileImportProgress) => void
  ) => () => void;
  onLegacySessionsRestored: (callback: (records: LegacySessionRestore[]) => void) => () => void;
}
