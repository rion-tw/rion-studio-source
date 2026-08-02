import type {
  GameSource,
  InheritableBrowserLaunchMode,
  LaunchWorkspaceSlot,
  MacroActivationMode,
  MacroRepeat,
  MacroStep,
  MacroTrigger,
  WorkspaceBrowserZoomPercent,
  WorkspaceBrowserZoomMode,
  WorkspaceDisplayTarget,
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
  browserZoomPercent: number;
}

export interface WorkspaceFormState {
  id?: string;
  name: string;
  template: WorkspaceLayoutTemplate;
  browserLaunchMode: InheritableBrowserLaunchMode;
  browserZoomMode: WorkspaceBrowserZoomMode;
  browserZoomPercent: WorkspaceBrowserZoomPercent;
  targetDisplay?: WorkspaceDisplayTarget;
  slots: LaunchWorkspaceSlot[];
}

export interface GameFormState {
  id?: string;
  source: GameSource;
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
  browserLaunchMode: InheritableBrowserLaunchMode;
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
