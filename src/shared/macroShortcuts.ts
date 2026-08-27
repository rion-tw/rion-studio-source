import type { MacroShortcutSourceScope, MacroTrigger } from "./types";

export const MACRO_OVERLAY_TRIGGER: MacroTrigger = {
  code: "KeyM",
  ctrl: true,
  alt: false,
  shift: true,
  meta: false
};

function isKeyboardMacroTrigger(
  trigger: MacroTrigger | null | undefined
): trigger is Extract<MacroTrigger, { code: string }> {
  return Boolean(trigger && "code" in trigger);
}

function isMiddleButtonMacroTrigger(
  trigger: MacroTrigger | null | undefined
): trigger is Extract<MacroTrigger, { button: "middle" }> {
  return Boolean(trigger && "button" in trigger && trigger.button === "middle");
}

export function areMacroTriggersEqual(
  left: MacroTrigger | null | undefined,
  right: MacroTrigger | null | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      ((isKeyboardMacroTrigger(left) &&
        isKeyboardMacroTrigger(right) &&
        left.code === right.code) ||
        (isMiddleButtonMacroTrigger(left) && isMiddleButtonMacroTrigger(right))) &&
      left.ctrl === right.ctrl &&
      left.alt === right.alt &&
      left.shift === right.shift &&
      left.meta === right.meta
  );
}

function macroRoleAssignmentsOverlap(left: string[], right: string[]): boolean {
  const rightRoleIds = new Set(right);
  return left.some((roleId) => rightRoleIds.has(roleId));
}

function getMacroShortcutSourceRoleIds(
  macro: { roleIds: string[]; shortcutSourceScope: MacroShortcutSourceScope }
): string[] {
  return macro.shortcutSourceScope.type === "selected_roles"
    ? macro.shortcutSourceScope.roleIds
    : macro.roleIds;
}

export function macroShortcutSourcesOverlap(
  left: { roleIds: string[]; shortcutSourceScope: MacroShortcutSourceScope },
  right: { roleIds: string[]; shortcutSourceScope: MacroShortcutSourceScope }
): boolean {
  return macroRoleAssignmentsOverlap(
    getMacroShortcutSourceRoleIds(left),
    getMacroShortcutSourceRoleIds(right)
  );
}

export function isReservedBrowserZoomMacroTrigger(
  trigger: MacroTrigger | null | undefined
): boolean {
  if (
    !isKeyboardMacroTrigger(trigger) ||
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
    isKeyboardMacroTrigger(trigger) &&
      trigger.code === "Tab" &&
      trigger.ctrl &&
      !trigger.alt &&
      !trigger.meta
  );
}

export function isReservedQuickAccessMacroTrigger(
  trigger: MacroTrigger | null | undefined
): boolean {
  return Boolean(
    isKeyboardMacroTrigger(trigger) &&
      trigger.code === "KeyK" &&
      !trigger.alt &&
      !trigger.shift &&
      trigger.ctrl !== trigger.meta
  );
}
