import type { MacroTrigger } from "./types";

export const MACRO_OVERLAY_CONTROLLER_KEY = "__rionStudioMacroOverlay";

export const MACRO_OVERLAY_TRIGGER: MacroTrigger = {
  code: "KeyM",
  ctrl: true,
  alt: false,
  shift: true,
  meta: false
};

export function areMacroTriggersEqual(
  left: MacroTrigger | null | undefined,
  right: MacroTrigger | null | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.code === right.code &&
      left.ctrl === right.ctrl &&
      left.alt === right.alt &&
      left.shift === right.shift &&
      left.meta === right.meta
  );
}

export function macroRoleAssignmentsOverlap(left: string[], right: string[]): boolean {
  const rightRoleIds = new Set(right);
  return left.some((roleId) => rightRoleIds.has(roleId));
}

export function createMacroShortcutSuppressionSource(code: string): string {
  return `window[${JSON.stringify(MACRO_OVERLAY_CONTROLLER_KEY)}]?.suppressNextShortcut?.(${JSON.stringify(code)})`;
}

export function createMacroShortcutSuppressionClearSource(code: string): string {
  return `window[${JSON.stringify(MACRO_OVERLAY_CONTROLLER_KEY)}]?.clearSuppressedShortcut?.(${JSON.stringify(code)})`;
}
