import type {
  AppThemeMode as SharedAppThemeMode,
  Game,
  GameSource,
  LaunchWorkspaceSlot,
  MacroActivationMode,
  MacroRepeat,
  MacroShortcutSourceScope,
  MacroStep,
  MacroTrigger,
  ResolvedTheme as SharedResolvedTheme,
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
  builtinKey?: Game["builtinKey"];
  name: string;
  iconImageDataUrl?: string;
  coverImageDataUrl?: string;
  defaultLaunchUrl: string;
}

export interface MacroFormState {
  id?: string;
  enabled: boolean;
  activationMode?: MacroActivationMode;
  name: string;
  roleIds: string[];
  shortcutSourceScope: MacroShortcutSourceScope;
  repeat: MacroRepeat;
  steps: MacroStep[];
  trigger?: MacroTrigger;
}

export type SidebarFilter = "all" | "running" | "stopped";
export type ThemeMode = SharedAppThemeMode;
export type ResolvedTheme = SharedResolvedTheme;

export interface AppStats {
  total: number;
  running: number;
  stopped: number;
}
