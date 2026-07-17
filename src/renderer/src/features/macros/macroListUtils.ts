import type { Macro, Role } from "../../../../shared/types";
import type { Translator } from "../../i18n";
import {
  formatMacroActivationMode,
  formatMacroRepeat,
  formatMacroShortcut,
  summarizeMacroSteps
} from "./macroUtils";

export type MacroListSortKey = "name" | "roles" | "shortcut" | "repeat" | "steps";
export type MacroListSortDirection = "asc" | "desc";

export interface MacroListSortState {
  direction: MacroListSortDirection;
  key: MacroListSortKey;
}

export const DEFAULT_MACRO_LIST_SORT: MacroListSortState = {
  direction: "asc",
  key: "roles"
};

interface GetMacroListItemsOptions {
  macros: Macro[];
  query: string;
  roleFilterId: string;
  roles: Role[];
  sort: MacroListSortState;
  t: Translator;
}

interface IndexedMacro {
  index: number;
  macro: Macro;
}

export function getMacroListItems({
  macros,
  query,
  roleFilterId,
  roles,
  sort,
  t
}: GetMacroListItemsOptions): Macro[] {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const macroNameById = new Map(macros.map((macro) => [macro.id, macro.name]));
  const normalizedQuery = query.trim().toLowerCase();

  return macros
    .map((macro, index) => ({ index, macro }))
    .filter(({ macro }) => {
      if (roleFilterId && !macro.roleIds.includes(roleFilterId)) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const roleNames = macro.roleIds.map((roleId) => roleById.get(roleId)?.name ?? t("macros.unknownRole"));

      return [
        macro.name,
        ...roleNames,
        formatMacroShortcut(macro.trigger, t),
        formatMacroActivationMode(macro.activationMode, t),
        formatMacroRepeat(macro.repeat, t),
        summarizeMacroSteps(macro.steps, t, macroNameById)
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((a, b) => compareMacroListItems(a, b, roles, roleById, macroNameById, sort, t))
    .map(({ macro }) => macro);
}

function compareMacroListItems(
  a: IndexedMacro,
  b: IndexedMacro,
  roles: Role[],
  roleById: Map<string, Role>,
  macroNameById: Map<string, string>,
  sort: MacroListSortState,
  t: Translator
): number {
  const primary = compareBySortKey(a.macro, b.macro, roles, roleById, macroNameById, sort.key, t);
  if (primary !== 0) {
    return sort.direction === "asc" ? primary : -primary;
  }

  return compareRoleNameAndCreatedAt(a, b, roles, roleById);
}

function compareBySortKey(
  a: Macro,
  b: Macro,
  roles: Role[],
  roleById: Map<string, Role>,
  macroNameById: Map<string, string>,
  sortKey: MacroListSortKey,
  t: Translator
): number {
  switch (sortKey) {
    case "name":
      return compareText(a.name, b.name);
    case "roles":
      return compareMacroRoles(a, b, roles, roleById);
    case "shortcut":
      return compareText(
        `${formatMacroShortcut(a.trigger, t)} ${formatMacroActivationMode(a.activationMode, t)}`,
        `${formatMacroShortcut(b.trigger, t)} ${formatMacroActivationMode(b.activationMode, t)}`
      );
    case "repeat":
      return compareText(formatMacroRepeat(a.repeat, t), formatMacroRepeat(b.repeat, t));
    case "steps":
      return compareText(
        summarizeMacroSteps(a.steps, t, macroNameById),
        summarizeMacroSteps(b.steps, t, macroNameById)
      );
  }
}

function compareRoleNameAndCreatedAt(
  a: IndexedMacro,
  b: IndexedMacro,
  roles: Role[],
  roleById: Map<string, Role>
): number {
  return (
    compareMacroRoles(a.macro, b.macro, roles, roleById) ||
    compareText(a.macro.name, b.macro.name) ||
    a.macro.createdAt.localeCompare(b.macro.createdAt) ||
    a.index - b.index
  );
}

function compareMacroRoles(a: Macro, b: Macro, roles: Role[], roleById: Map<string, Role>): number {
  return (
    getMacroRoleSortIndex(a, roles) - getMacroRoleSortIndex(b, roles) ||
    compareText(formatMacroRoleNames(a, roleById), formatMacroRoleNames(b, roleById))
  );
}

function getMacroRoleSortIndex(macro: Macro, roles: Role[]): number {
  const roleIndexById = new Map(roles.map((role, index) => [role.id, index]));
  const roleIndexes = macro.roleIds.map((roleId) => roleIndexById.get(roleId) ?? Number.MAX_SAFE_INTEGER);
  return roleIndexes.length > 0 ? Math.min(...roleIndexes) : Number.MAX_SAFE_INTEGER;
}

function formatMacroRoleNames(macro: Macro, roleById: Map<string, Role>): string {
  return macro.roleIds.map((roleId) => roleById.get(roleId)?.name ?? roleId).join(" ");
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
