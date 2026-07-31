import type { MacroKeyModifier } from "./types";

const MACRO_KEY_MODIFIER_ORDER = [
  "primary",
  "ctrl",
  "alt",
  "shift",
  "meta"
] as const satisfies readonly MacroKeyModifier[];

export function canonicalizeMacroKeyModifiers(
  modifiers: readonly MacroKeyModifier[]
): MacroKeyModifier[] {
  const modifierSet = new Set(modifiers);
  return MACRO_KEY_MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
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
