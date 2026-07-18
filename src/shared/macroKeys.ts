import type { MacroKeyModifier } from "./types";

export interface MacroKeyInput {
  code: string;
  modifiers?: MacroKeyModifier[];
}

export const MACRO_KEY_MODIFIER_ORDER = [
  "primary",
  "ctrl",
  "alt",
  "shift",
  "meta"
] as const satisfies readonly MacroKeyModifier[];

const macroKeyModifierSet = new Set<string>(MACRO_KEY_MODIFIER_ORDER);

export function isMacroKeyModifier(value: unknown): value is MacroKeyModifier {
  return typeof value === "string" && macroKeyModifierSet.has(value);
}

export function canonicalizeMacroKeyModifiers(
  modifiers: readonly MacroKeyModifier[]
): MacroKeyModifier[] {
  const modifierSet = new Set(modifiers);
  return MACRO_KEY_MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
}

export function hasPrimaryModifierConflict(modifiers: readonly MacroKeyModifier[]): boolean {
  return modifiers.includes("primary") &&
    (modifiers.includes("ctrl") || modifiers.includes("meta"));
}

export function isMacroModifierCode(code: string): boolean {
  return [
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "MetaLeft",
    "MetaRight",
    "ShiftLeft",
    "ShiftRight"
  ].includes(code);
}

export function resolveMacroKeyInput(
  input: MacroKeyInput,
  platform: string
): { code: string; modifierCodes: string[] } {
  const modifierCodes = canonicalizeMacroKeyModifiers(input.modifiers ?? []).map((modifier) => {
    switch (modifier) {
      case "primary":
        return platform === "darwin" ? "MetaLeft" : "ControlLeft";
      case "ctrl":
        return "ControlLeft";
      case "alt":
        return "AltLeft";
      case "shift":
        return "ShiftLeft";
      case "meta":
        return "MetaLeft";
    }
  });

  return { code: input.code, modifierCodes: [...new Set(modifierCodes)] };
}

export function getMacroModifierForCode(code: string): Exclude<MacroKeyModifier, "primary"> | undefined {
  if (code === "ControlLeft" || code === "ControlRight") return "ctrl";
  if (code === "AltLeft" || code === "AltRight") return "alt";
  if (code === "ShiftLeft" || code === "ShiftRight") return "shift";
  if (code === "MetaLeft" || code === "MetaRight") return "meta";
  return undefined;
}
