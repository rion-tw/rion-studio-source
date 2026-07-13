import type { LaunchWorkspace, Macro, Role, RoleDefaults } from "../../../shared/types";
import type { MacroFormState, RoleFormState, WorkspaceFormState } from "./types";
import { createEmptyRoleForm } from "./roleDefaults";
import { createEmptyMacroForm, createMacroFormState } from "../features/macros/macroUtils";
import {
  createEmptyWorkspaceForm,
  createWorkspaceFormState
} from "../features/workspaces/workspaceLayoutUtils";
import type { Translator } from "../i18n";

export type EditorFormState = RoleFormState | WorkspaceFormState | MacroFormState;

export function createNewRoleForm(roleDefaults: RoleDefaults): RoleFormState {
  return createEmptyRoleForm(roleDefaults);
}

export function createRoleFormState(role: Role): RoleFormState {
  return {
    id: role.id,
    name: role.name,
    launchUrl: role.launchUrl,
    windowWidth: role.windowWidth,
    windowHeight: role.windowHeight,
    notes: role.notes,
    launchPreset: role.launchPreset,
    coverImageDataUrl: role.coverImageDataUrl,
    coverImageDominantColor: role.coverImageDominantColor
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
