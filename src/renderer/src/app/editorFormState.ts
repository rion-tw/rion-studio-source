import { DEFAULT_LAUNCH_URL, type Game, type LaunchWorkspace, type Macro, type Role } from "../../../shared/types";
import type { GameFormState, MacroFormState, RoleFormState, WorkspaceFormState } from "./types";
import { createEmptyMacroForm, createMacroFormState } from "../features/macros/macroUtils";
import {
  createEmptyWorkspaceForm,
  createWorkspaceFormState
} from "../features/workspaces/workspaceLayoutUtils";
import type { Translator } from "../i18n";

export type EditorFormState = GameFormState | RoleFormState | WorkspaceFormState | MacroFormState;

export function createNewRoleForm(game?: Game): RoleFormState {
  return {
    gameId: game?.id ?? "",
    name: "",
    launchUrl: game?.defaultLaunchUrl ?? DEFAULT_LAUNCH_URL,
    notes: ""
  };
}

export function createRoleFormState(role: Role): RoleFormState {
  return {
    id: role.id,
    gameId: role.gameId,
    name: role.name,
    launchUrl: role.launchUrl,
    notes: role.notes,
    coverImageDataUrl: role.coverImageDataUrl,
    coverImageDominantColor: role.coverImageDominantColor
  };
}

export function createNewGameForm(): GameFormState {
  return {
    source: "custom",
    name: "",
    defaultLaunchUrl: "https://",
    browserLaunchMode: "inherit"
  };
}

export function createGameFormState(game: Game): GameFormState {
  return {
    id: game.id,
    source: game.source,
    name: game.name,
    iconImageDataUrl: game.iconImageDataUrl,
    coverImageDataUrl: game.coverImageDataUrl,
    defaultLaunchUrl: game.defaultLaunchUrl,
    browserLaunchMode: game.browserLaunchMode
  };
}

export function createNewWorkspaceForm(workspaces: LaunchWorkspace[], t: Translator): WorkspaceFormState {
  return createEmptyWorkspaceForm(workspaces, t);
}

export { createWorkspaceFormState };

export function createNewMacroForm(
  macros: Macro[],
  roles: Role[],
  t: Translator,
  requestedRoleId?: string
): MacroFormState {
  return createEmptyMacroForm(macros, roles, t, requestedRoleId);
}

export { createMacroFormState };

export function areEditorFormsEqual(a: EditorFormState, b: EditorFormState): boolean {
  return stableSerialize(a) === stableSerialize(b);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([aKey], [bKey]) => aKey.localeCompare(bKey))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
