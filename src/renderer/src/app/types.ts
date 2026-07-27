import type {
  GameSource,
  LaunchWorkspaceSlot,
  MacroActivationMode,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  WorkspaceLayoutTemplate
} from "../../../shared/types";

export interface RoleFormState {
  id?: string;
  gameId: string;
  name: string;
  launchUrl: string;
  notes: string;
  coverImageDataUrl?: string;
  coverImageDominantColor?: string;
  localStorageSourceRoleId?: string;
}

export interface WorkspaceFormState {
  id?: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  slots: LaunchWorkspaceSlot[];
}

export interface GameFormState {
  id?: string;
  source: GameSource;
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
  localStorageSyncKeys: string[];
}

export interface MacroFormState {
  id?: string;
  enabled: boolean;
  activationMode?: MacroActivationMode;
  name: string;
  roleIds: string[];
  repeat: MacroRepeat;
  steps: MacroStep[];
  trigger?: MacroTrigger;
}

export type SidebarFilter = "all" | "running" | "stopped";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface AppStats {
  total: number;
  running: number;
  stopped: number;
}
