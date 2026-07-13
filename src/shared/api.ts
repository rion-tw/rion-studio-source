import type {
  AuthFlowStatus,
  AppLanguage,
  AppRendererReadyState,
  AppUpdateStatus,
  CreateLaunchWorkspaceInput,
  CreateMacroInput,
  CreateRoleInput,
  LaunchWorkspace,
  Macro,
  MacroEditorRequest,
  MacroRunStatus,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview,
  PortableImportResult,
  Role,
  RolePaths,
  RoleStatus,
  UpdateLaunchWorkspaceInput,
  UpdateMacroInput,
  UpdateRoleInput
} from "./types";

export interface RionStudioApi {
  notifyAppReady: (state: AppRendererReadyState) => Promise<void>;
  listRoles: () => Promise<Role[]>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
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
  deleteLaunchWorkspace: (id: string) => Promise<void>;
  launchWorkspace: (id: string) => Promise<RoleStatus[]>;
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
  consumePendingMacroEditorRequest: () => Promise<MacroEditorRequest | null>;
  setOverlayLanguage: (language: AppLanguage) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<AppUpdateStatus>;
  checkForUpdates: () => Promise<AppUpdateStatus>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
  onRoleStatusChanged: (callback: (statuses: RoleStatus[]) => void) => () => void;
  onAuthStatusChanged: (callback: (statuses: AuthFlowStatus[]) => void) => () => void;
  onMacroStatusChanged: (callback: (statuses: MacroRunStatus[]) => void) => () => void;
  onMacroEditorRequested: (callback: (request: MacroEditorRequest) => void) => () => void;
  onUpdateStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void;
}
