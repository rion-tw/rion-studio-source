import type { Macro } from "./types";

type MacroDependencyNode = Pick<Macro, "id" | "steps">;

type MacroAssignmentNode = Pick<Macro, "id" | "roleIds" | "steps">;

function getMacroDependencyIds(macro: Pick<Macro, "steps">): string[] {
  return macro.steps.flatMap((step) => step.type === "macro" ? [step.macroId] : []);
}

export function macroDependsOn(
  macros: MacroDependencyNode[],
  sourceMacroId: string,
  targetMacroId: string
): boolean {
  const macroById = new Map(macros.map((macro) => [macro.id, macro]));
  const pending = [sourceMacroId];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (currentId === targetMacroId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = macroById.get(currentId);
    if (current) pending.push(...getMacroDependencyIds(current));
  }

  return false;
}

export function findUnassignedMacroDependency<T extends MacroAssignmentNode>(
  macros: T[],
  sourceMacroId: string
): T | undefined {
  const macroById = new Map(macros.map((macro) => [macro.id, macro]));
  const pending = [sourceMacroId];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const macroId = pending.pop()!;
    if (visited.has(macroId)) continue;
    visited.add(macroId);

    const macro = macroById.get(macroId);
    if (!macro) continue;
    if (macro.roleIds.length === 0) return macro;

    pending.push(...getMacroDependencyIds(macro));
  }

  return undefined;
}
