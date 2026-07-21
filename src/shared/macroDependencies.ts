import type { Macro } from "./types";

export type MacroDependencyNode = Pick<Macro, "id" | "steps">;

export type MacroAssignmentNode = Pick<Macro, "id" | "roleIds" | "steps">;

export type MacroDependencyIssue =
  | {
      type: "missing";
      macroId: string;
      targetMacroId: string;
    }
  | {
      type: "cycle";
      macroIds: string[];
    };

export function getMacroDependencyIds(macro: Pick<Macro, "steps">): string[] {
  return macro.steps.flatMap((step) => step.type === "macro" ? [step.macroId] : []);
}

export function findMacroDependencyIssue(
  macros: MacroDependencyNode[]
): MacroDependencyIssue | undefined {
  const macroById = new Map(macros.map((macro) => [macro.id, macro]));

  for (const macro of macros) {
    for (const targetMacroId of getMacroDependencyIds(macro)) {
      const target = macroById.get(targetMacroId);
      if (!target) {
        return { type: "missing", macroId: macro.id, targetMacroId };
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (macroId: string): string[] | undefined => {
    if (visiting.has(macroId)) {
      const cycleStart = path.indexOf(macroId);
      return [...path.slice(Math.max(0, cycleStart)), macroId];
    }
    if (visited.has(macroId)) {
      return undefined;
    }

    visiting.add(macroId);
    path.push(macroId);
    for (const targetMacroId of getMacroDependencyIds(macroById.get(macroId)!)) {
      const cycle = visit(targetMacroId);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(macroId);
    visited.add(macroId);
    return undefined;
  };

  for (const macro of macros) {
    const cycle = visit(macro.id);
    if (cycle) {
      return { type: "cycle", macroIds: cycle };
    }
  }

  return undefined;
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

export function getMacroReferrers(macros: Macro[], targetMacroId: string): Macro[] {
  return macros.filter((macro) => getMacroDependencyIds(macro).includes(targetMacroId));
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
