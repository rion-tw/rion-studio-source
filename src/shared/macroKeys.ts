import type { MacroKeyModifier } from "./types";

const MACRO_KEY_MODIFIER_ORDER = [
  "primary",
  "ctrl",
  "alt",
  "shift",
  "meta"
] as const satisfies readonly MacroKeyModifier[];

/**
 * Numpad DOM codes accepted as Macro shortcut triggers. A keyboard shortcut is
 * redelivered to the game as managed input, so every trusted and compatible
 * output lane must support these codes as well.
 */
export const NUMPAD_MACRO_KEY_CODES = Object.freeze([
  "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5",
  "Numpad6", "Numpad7", "Numpad8", "Numpad9", "NumpadDecimal", "NumpadAdd",
  "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadEnter"
] as const);

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
