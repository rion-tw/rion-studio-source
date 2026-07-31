import type { MacroTrigger } from "./types";

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

export function isReservedBrowserZoomMacroTrigger(
  trigger: MacroTrigger | null | undefined
): boolean {
  if (
    !trigger ||
    trigger.alt ||
    trigger.ctrl === trigger.meta ||
    (!trigger.ctrl && !trigger.meta)
  ) {
    return false;
  }

  if (trigger.code === "Equal" || trigger.code === "Plus" || trigger.code === "NumpadAdd") {
    return true;
  }
  if (trigger.shift) {
    return false;
  }
  return (
    trigger.code === "Minus" ||
    trigger.code === "NumpadSubtract" ||
    trigger.code === "Digit0" ||
    trigger.code === "Numpad0"
  );
}

export function isReservedRuntimeTabSwitchMacroTrigger(
  trigger: MacroTrigger | null | undefined
): boolean {
  return Boolean(
    trigger &&
      trigger.code === "Tab" &&
      trigger.ctrl &&
      !trigger.alt &&
      !trigger.meta
  );
}
