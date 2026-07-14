export const DEFAULT_LAUNCH_URL = "https://universe.flyff.com/play";
export const DEFAULT_ROLE_WINDOW_WIDTH = 1440;
export const DEFAULT_ROLE_WINDOW_HEIGHT = 900;

export type LaunchPreset = "balanced" | "performance";
export type WorkspaceLayoutTemplate =
  | "single"
  | "two_columns"
  | "three_columns"
  | "main_left_stack_right"
  | "main_right_stack_left"
  | "main_center_side_stacks"
  | "quad"
  | "four_columns"
  | "six_grid"
  | "eight_grid";
export type WorkspaceBrowserZoomPercent = 75 | 80 | 90 | 100 | 110 | 125;
export type AppLanguage = "en" | "zh-TW" | "zh-CN" | "ja";
export type AppThemeMode = "system" | "light" | "dark";
export type AppRendererReadyState = "failed" | "ready";
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

export interface ReorderItemsInput {
  orderedIds: string[];
}

export type RoleRunState = "launching" | "running" | "stopping";

export interface RoleStatus {
  roleId: string;
  state: RoleRunState;
  launchedAt?: string;
  notice?: string;
  runtimeMode?: BrowserRuntimeMode;
  automationState?: "ready" | "unavailable";
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
  roleIds: string[];
  trigger?: MacroTrigger;
  repeat: MacroRepeat;
  steps: MacroStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMacroInput {
  name: string;
  roleIds: string[];
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

export interface RoleDefaults {
  windowWidth: number;
  windowHeight: number;
  launchPreset: LaunchPreset;
}

export type BrowserFontFamilyRole = "standard" | "serif" | "sansserif" | "fixed" | "math";
export type BrowserFontSettingsMode = "default" | "custom";
export type BrowserLaunchMode = "auto" | "embedded" | "external";
export type BrowserRuntimeMode = "embedded" | "external";
export type BrowserProxySettingsMode = "system" | "custom";
export type BrowserCdnCompatibilityMode = "off" | "auto" | "on";

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

export interface GameBrowserSettings {
  fonts: BrowserFontSettings;
  launchMode: BrowserLaunchMode;
  network: BrowserNetworkSettings;
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
  roleDefaults?: RoleDefaults;
  themeMode?: AppThemeMode;
}

export interface PortableExportInput {
  preferences?: PortablePreferences;
}

export interface PortableRole {
  id: string;
  name: string;
  launchUrl: string;
  windowWidth: number;
  windowHeight: number;
  notes: string;
  launchPreset: LaunchPreset;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
}

export interface PortableLaunchWorkspace {
  id: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  slots: LaunchWorkspaceSlot[];
}

export interface PortableMacro {
  id: string;
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

export interface PortableExportResult {
  filePath: string;
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
}

export type PortableImportWarningCode =
  | "ROLE_NAME_RENAMED"
  | "WORKSPACE_NAME_RENAMED"
  | "WORKSPACE_ROLE_MISSING"
  | "MACRO_NAME_RENAMED"
  | "MACRO_ROLE_MISSING"
  | "MACRO_SKIPPED_NO_ROLES";

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
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferences?: PortablePreferences;
  warnings: PortableImportWarning[];
}

export interface PortableImportResult {
  roleCount: number;
  workspaceCount: number;
  macroCount: number;
  preferences?: PortablePreferences;
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
