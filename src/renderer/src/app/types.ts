import type {
  GameSource,
  InheritableBrowserLaunchMode,
  LaunchPreset,
  LaunchWorkspaceSlot,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate
} from "../../../shared/types";

export interface RoleFormState {
  id?: string;
  gameId: string;
  name: string;
  launchUrl: string;
  windowWidth: number;
  windowHeight: number;
  notes: string;
  launchPreset: LaunchPreset;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
}

export interface WorkspaceFormState {
  id?: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserLaunchMode: InheritableBrowserLaunchMode;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  targetDisplayId?: number;
  slots: LaunchWorkspaceSlot[];
}

export interface GameFormState {
  id?: string;
  source: GameSource;
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
  loginUrl: string;
  usesGlobalRoleDefaults: boolean;
  windowWidth: number;
  windowHeight: number;
  launchPreset: LaunchPreset;
  browserLaunchMode: InheritableBrowserLaunchMode;
}

export interface MacroFormState {
  id?: string;
  name: string;
  roleIds: string[];
  repeat: MacroRepeat;
  steps: MacroStep[];
  trigger?: MacroTrigger;
}

export type SidebarFilter = "all" | "running" | "stopped" | "needsLogin";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface AppStats {
  total: number;
  running: number;
  stopped: number;
  needsLogin: number;
  authFailed: number;
}
