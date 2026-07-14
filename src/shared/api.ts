import type {
  AcceptLegalDocumentsInput,
  AuthFlowStatus,
  AppLanguage,
  AppRendererReadyState,
  AppSnapshot,
  AppUpdateStatus,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  GameBrowserSettings,
  GraphicsDiagnostics,
  LaunchWorkspace,
  LegalAcceptanceStatus,
  Macro,
  MacroEditorRequest,
  MacroRunStatus,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview,
  PortableImportResult,
  ReorderItemsInput,
  Role,
  RolePaths,
  RoleStatus,
  SystemFontFamily,
  UpdateLaunchWorkspaceInput,
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
  restartApplication: () => Promise<void>;
  listRoles: () => Promise<Role[]>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  reorderRoles: (input: ReorderItemsInput) => Promise<Role[]>;
  deleteRole: (id: string) => Promise<void>;
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
  listWorkspaceDisplays: () => Promise<WorkspaceDisplayInfo[]>;
  launchWorkspace: (id: string, input?: WorkspaceLaunchInput) => Promise<WorkspaceLaunchResult>;
  stopLaunchWorkspace: (id: string) => Promise<void>;
  listMacros: () => Promise<Macro[]>;
  createMacro: (input: CreateMacroInput) => Promise<Macro>;
  updateMacro: (id: string, input: UpdateMacroInput) => Promise<Macro>;
  deleteMacro: (id: string) => Promise<void>;
  startMacro: (macroId: string) => Promise<MacroRunStatus[]>;
  stopMacro: (macroId: string) => Promise<void>;
  listMacroStatuses: () => Promise<MacroRunStatus[]>;
  exportPortableData: (input?: PortableExportInput) => Promise<PortableExportResult | null>;
  previewPortableImport: () => Promise<PortableImportPreview | null>;
  applyPortableImport: (importId: string) => Promise<PortableImportResult>;
  getGameBrowserSettings: () => Promise<GameBrowserSettings>;
  updateGameBrowserSettings: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>;
  getGraphicsDiagnostics: () => Promise<GraphicsDiagnostics>;
  listSystemFonts: () => Promise<SystemFontFamily[]>;
  consumePendingMacroEditorRequest: () => Promise<MacroEditorRequest | null>;
  setOverlayLanguage: (language: AppLanguage) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onWorkspaceDisplaysChanged: (callback: (displays: WorkspaceDisplayInfo[]) => void) => () => void;
  onAuthStatusChanged: (callback: (statuses: AuthFlowStatus[]) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacroEditorRequested: (callback: (request: MacroEditorRequest) => void) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
}
