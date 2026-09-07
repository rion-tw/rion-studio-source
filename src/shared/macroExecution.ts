import type { Macro } from "./types";

export function allowsMacroSource(macro: Pick<Macro, "executionMode" | "roleIds" | "shortcutSourceScope">, roleId: string): boolean {
  const scope = macro.shortcutSourceScope;
  return scope.type === "all_roles" || (scope.type === "selected_roles" ? scope.roleIds : macro.roleIds).includes(roleId);
}

export function sourceRoleDependencies(macros: Macro[], rootId: string): Macro[] {
  const byId = new Map(macros.map((macro) => [macro.id, macro]));
  const pending = [rootId];
  const visited = new Set<string>();
  const dynamic: Macro[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const macro = byId.get(id);
    if (!macro) continue;
    if (macro.executionMode === "source_role") dynamic.push(macro);
    pending.push(...macro.steps.flatMap((step) => step.type === "macro" ? [step.macroId] : []));
  }
  return dynamic;
}

export function allowsMacroChainSource(macros: Macro[], root: Macro, roleId: string): boolean {
  return (allowsMacroSource(root, roleId) || (root.executionMode !== "source_role" && root.roleIds.includes(roleId))) &&
    sourceRoleDependencies(macros, root.id).every((macro) => allowsMacroSource(macro, roleId));
}
