export const DEFAULT_LAUNCH_URL = "https://universe.flyff.com/play";
export const DEFAULT_ROLE_WINDOW_WIDTH = 1440;
export const DEFAULT_ROLE_WINDOW_HEIGHT = 900;

export type LaunchPreset = "balanced" | "performance";
export type WorkspaceLayoutTemplate =
  | "single"
  | "two_columns"
  | "three_columns"
  | "main_left_stack_right"
  | "quad"
  | "four_columns";
export type WorkspaceBrowserZoomPercent = 80 | 90 | 100 | 110 | 125;
export type AppLanguage = "en" | "zh-TW" | "zh-CN" | "ja";
export type AppRendererReadyState = "failed" | "ready";
export type AuthState = "unknown" | "login_required" | "authenticated" | "auth_failed";
export type AuthFlowState =
  | "opening_chrome"
  | "waiting_for_login"
  | "closing_login_window"
  | "waiting_for_chrome_close"
  | "waiting_for_user_data_release"
  | "checking_session"
  | "launching"
  | "failed";

export interface Role {
  id: string;
  name: string;
  launchUrl: string;
  windowWidth: number;
  windowHeight: number;
  notes: string;
  launchPreset: LaunchPreset;
  authState: AuthState;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
  lastAuthCheckAt?: string;
  lastSuccessfulLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  name: string;
  launchUrl?: string;
  windowWidth?: number;
  windowHeight?: number;
  notes?: string;
  launchPreset?: LaunchPreset;
  coverImageDataUrl?: string | null;
  coverImageDominantColor?: string | null;
}

export type UpdateRoleInput = Partial<Omit<CreateRoleInput, "name">> & {
  name?: string;
};

export type RoleRunState = "launching" | "running" | "stopping";

export interface RoleStatus {
  roleId: string;
  state: RoleRunState;
  launchedAt?: string;
}

export interface MacroTrigger {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export type MacroRepeat =
  | {
      type: "once";
    }
  | {
      type: "loop";
      intervalMs: number;
    };

export type MacroStep =
  | {
      id: string;
      type: "key";
      code: string;
      label?: string;
    }
  | {
      id: string;
      type: "click";
      xPercent: number;
      yPercent: number;
    }
  | {
      id: string;
      type: "delay";
      ms: number;
    };

export interface Macro {
  id: string;
  name: string;
  roleId: string;
  trigger?: MacroTrigger;
  repeat: MacroRepeat;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMacroInput {
  name: string;
  roleId: string;
  trigger?: MacroTrigger | null;
  repeat?: MacroRepeat;
  steps: MacroStep[];
}

export type UpdateMacroInput = Partial<CreateMacroInput>;

export interface MacroEditorRequest {
  roleId: string;
  macroId?: string;
}

export type MacroRunState = "running" | "stopping";

export interface MacroRunStatus {
  roleId: string;
  macroId: string;
  state: MacroRunState;
  startedAt: string;
  updatedAt: string;
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
  rect: NormalizedRect;
}

export interface LaunchWorkspace {
  id: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  slots: LaunchWorkspaceSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLaunchWorkspaceInput {
  name: string;
  template?: WorkspaceLayoutTemplate;
  browserZoomPercent?: WorkspaceBrowserZoomPercent;
  slots?: Array<Partial<Pick<LaunchWorkspaceSlot, "id" | "roleId" | "rect">>>;
}

export type UpdateLaunchWorkspaceInput = Partial<CreateLaunchWorkspaceInput>;

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppErrorPayload {
  code: string;
  message: string;
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
