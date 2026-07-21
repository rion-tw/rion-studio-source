import type {
  AcceptLegalDocumentsInput,
  AppLanguage,
  AppRendererReadyState,
  AppSnapshot,
  AppUpdateStatus,
  AppWindowState,
  BulkDeleteInput,
  BulkDeleteResult,
  CreateGameInput,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  Game,
  GameCompatibilityReport,
  GameCompatibilityRunStatus,
  GraphicsDiagnostics,
  DiagnosticExportResult,
  EmbeddedRuntimeState,
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
  PendingWorkspaceLaunchRequest,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  ChromeProfileImportInput,
  ChromeProfileImportPreview,
  ChromeProfileImportProgress,
  ChromeProfileImportResult,
  ReorderItemsInput,
  Role,
  RolePaths,
  RoleStatus,
  SystemFontFamily,
  UpdateLaunchWorkspaceInput,
  UpdateGameInput,
  UpdateMacroInput,
  UpdateRoleInput,
  WorkspaceDisplayInfo,
  WorkspaceLaunchInput,
  WorkspaceLaunchResult
} from "./types";

export interface RionStudioApi {
  notifyAppReady: (state: AppRendererReadyState) => Promise<void>;
  getAppSnapshot: () => Promise<AppSnapshot>;
  getCurrentWindowState: () => Promise<AppWindowState>;
  getLegalAcceptanceStatus: () => Promise<LegalAcceptanceStatus>;
  acceptLegalDocuments: (input: AcceptLegalDocumentsInput) => Promise<LegalAcceptanceStatus>;
  quitApplication: () => Promise<void>;
  requestCurrentWindowClose: () => void;
  restartApplication: () => Promise<void>;
  getEmbeddedRuntimeState: () => Promise<EmbeddedRuntimeState>;
  showEmbeddedRuntimeWindows: (displayId?: number) => Promise<void>;
  showEmbeddedRuntimeTab: (tabId: string) => Promise<void>;
  moveEmbeddedRuntimeTab: (tabId: string, displayId: number) => Promise<void>;
  listGames: () => Promise<Game[]>;
  createGame: (input: CreateGameInput) => Promise<Game>;
  updateGame: (id: string, input: UpdateGameInput) => Promise<Game>;
  resetBuiltinGame: (id: string) => Promise<Game>;
  deleteGame: (id: string) => Promise<void>;
  deleteGames: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  listGameCompatibilityReports: () => Promise<GameCompatibilityReport[]>;
  runGameCompatibilityCheck: (id: string) => Promise<GameCompatibilityReport>;
  cancelGameCompatibilityCheck: (id: string) => Promise<void>;
  listRoles: () => Promise<Role[]>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  reorderRoles: (input: ReorderItemsInput) => Promise<Role[]>;
  deleteRole: (id: string) => Promise<void>;
  deleteRoles: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  clearRoleBrowserData: (id: string) => Promise<Role>;
  getRolePaths: (id: string) => Promise<RolePaths>;
  launchRole: (id: string) => Promise<RoleStatus | null>;
  captureExternalRoleDiagnostics: (id: string) => Promise<void>;
  recoverExternalRole: (id: string) => Promise<RoleStatus>;
  stopRole: (id: string) => Promise<void>;
  listRoleStatuses: () => Promise<RoleStatus[]>;
  listLaunchWorkspaces: () => Promise<LaunchWorkspace[]>;
  createLaunchWorkspace: (input: CreateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  updateLaunchWorkspace: (id: string, input: UpdateLaunchWorkspaceInput) => Promise<LaunchWorkspace>;
  reorderLaunchWorkspaces: (input: ReorderItemsInput) => Promise<LaunchWorkspace[]>;
  deleteLaunchWorkspace: (id: string) => Promise<void>;
  deleteLaunchWorkspaces: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  listWorkspaceDisplays: () => Promise<WorkspaceDisplayInfo[]>;
  launchWorkspace: (id: string, input?: WorkspaceLaunchInput) => Promise<WorkspaceLaunchResult>;
  stopLaunchWorkspace: (id: string) => Promise<void>;
  consumePendingWorkspaceLaunchRequest: () => Promise<PendingWorkspaceLaunchRequest | null>;
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
  closeChromeForImport: () => Promise<void>;
  applyChromeProfileImport: (input: ChromeProfileImportInput) => Promise<ChromeProfileImportResult>;
  discardChromeProfileImport: (importId: string) => Promise<void>;
  getGameBrowserSettings: () => Promise<GameBrowserSettings>;
  updateGameBrowserSettings: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
  getGraphicsDiagnostics: () => Promise<GraphicsDiagnostics>;
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
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onCurrentWindowStateChanged: (callback: (state: AppWindowState) => void) => () => void;
  onEmbeddedRuntimeStateChanged: (callback: (state: EmbeddedRuntimeState) => void) => () => void;
  onGamesChanged: (callback: (games: Game[]) => void) => () => void;
  onWorkspacesChanged: (callback: (workspaces: LaunchWorkspace[]) => void) => () => void;
  onGameCompatibilityChanged: (
    callback: (reports: GameCompatibilityReport[], statuses: GameCompatibilityRunStatus[]) => void
  ) => () => void;
  onWorkspaceDisplaysChanged: (callback: (displays: WorkspaceDisplayInfo[]) => void) => () => void;
  onWorkspaceLaunchRequested: (callback: (request: PendingWorkspaceLaunchRequest) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacrosChanged: (callback: (macros: Macro[]) => void) => () => void;
  onMacroPageRequested: (callback: (request: MacroPageRequest) => void) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
  onChromeProfileImportProgress: (callback: (progress: ChromeProfileImportProgress) => void) => () => void;
  onLogEntryAdded: (callback: (entry: LogEntry) => void) => () => void;
}
