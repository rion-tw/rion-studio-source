import type {
  AcceptLegalDocumentsInput,
  AuthFlowStatus,
  AppLanguage,
  AppRendererReadyState,
  AppSnapshot,
  AppUpdateStatus,
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
  LaunchWorkspace,
  LegalAcceptanceStatus,
  Macro,
  MacroPageRequest,
  MacroRunStatus,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  ReorderItemsInput,
  Role,
  RoleDefaults,
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
  getLegalAcceptanceStatus: () => Promise<LegalAcceptanceStatus>;
  acceptLegalDocuments: (input: AcceptLegalDocumentsInput) => Promise<LegalAcceptanceStatus>;
  quitApplication: () => Promise<void>;
  requestCurrentWindowClose: () => void;
  restartApplication: () => Promise<void>;
  listGames: () => Promise<Game[]>;
  createGame: (input: CreateGameInput) => Promise<Game>;
  updateGame: (id: string, input: UpdateGameInput) => Promise<Game>;
  resetBuiltinGame: (id: string) => Promise<Game>;
  deleteGame: (id: string) => Promise<void>;
  deleteGames: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  listGameCompatibilityReports: () => Promise<GameCompatibilityReport[]>;
  runGameCompatibilityCheck: (id: string, fallbackRoleDefaults: RoleDefaults) => Promise<GameCompatibilityReport>;
  cancelGameCompatibilityCheck: (id: string) => Promise<void>;
  listRoles: () => Promise<Role[]>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  reorderRoles: (input: ReorderItemsInput) => Promise<Role[]>;
  deleteRole: (id: string) => Promise<void>;
  deleteRoles: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  getRolePaths: (id: string) => Promise<RolePaths>;
  startLogin: (id: string) => Promise<AuthFlowStatus>;
  listAuthStatuses: () => Promise<AuthFlowStatus[]>;
  launchRole: (id: string) => Promise<RoleStatus>;
  openSystemLoginWindow: (id: string) => Promise<void>;
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
  listMacros: () => Promise<Macro[]>;
  createMacro: (input: CreateMacroInput) => Promise<Macro>;
  updateMacro: (id: string, input: UpdateMacroInput) => Promise<Macro>;
  deleteMacro: (id: string) => Promise<void>;
  deleteMacros: (input: BulkDeleteInput) => Promise<BulkDeleteResult>;
  startMacro: (macroId: string) => Promise<MacroRunStatus[]>;
  stopMacro: (macroId: string) => Promise<void>;
  listMacroStatuses: () => Promise<MacroRunStatus[]>;
  exportPortableData: (input?: PortableExportInput) => Promise<PortableExportResult | null>;
  previewPortableImport: () => Promise<PortableImportPreview | null>;
  applyPortableImport: (input: PortableImportInput) => Promise<PortableImportResult>;
  discardPortableImport: (importId: string) => Promise<void>;
  getGameBrowserSettings: () => Promise<GameBrowserSettings>;
  updateGameBrowserSettings: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
  getGraphicsDiagnostics: () => Promise<GraphicsDiagnostics>;
  listSystemFonts: () => Promise<SystemFontFamily[]>;
  consumePendingMacroPageRequest: () => Promise<MacroPageRequest | null>;
  setOverlayLanguage: (language: AppLanguage) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onGamesChanged: (callback: (games: Game[]) => void) => () => void;
  onGameCompatibilityChanged: (
    callback: (reports: GameCompatibilityReport[], statuses: GameCompatibilityRunStatus[]) => void
  ) => () => void;
  onWorkspaceDisplaysChanged: (callback: (displays: WorkspaceDisplayInfo[]) => void) => () => void;
  onAuthStatusChanged: (callback: (statuses: AuthFlowStatus[]) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacrosChanged: (callback: (macros: Macro[]) => void) => () => void;
  onMacroPageRequested: (callback: (request: MacroPageRequest) => void) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
}
