import type {
  Macro,
  MacroActivationMode,
  MacroRepeat,
  MacroRunStatus,
  MacroStep,
  MacroTrigger,
  Role
} from "../../../../shared/types";
import { macroDependsOn } from "../../../../shared/macroDependencies";
import { MACRO_DELAY_MAX_MS } from "../../../../shared/macroSettings";
import type { MacroFormState } from "../../app/types";
import type { TranslationKey, Translator } from "../../i18n";

export const MACRO_INTERVAL_PRESETS = [0, 250, 500, 1000, 2000, 5000, 10000] as const;
export const MACRO_INTERVAL_CUSTOM_VALUE = "custom";
export const MACRO_INTERVAL_OPTIONS = [...MACRO_INTERVAL_PRESETS, MACRO_INTERVAL_CUSTOM_VALUE] as const;

export function isCallableMacroTarget(
  macros: Macro[],
  currentMacroId: string | undefined,
  targetMacroId: string
): boolean {
  const target = macros.find((macro) => macro.id === targetMacroId);
  return Boolean(
    target &&
    target.repeat.type === "once" &&
    !target.steps.some((step) => step.type === "key" && step.action === "hold_until_stop") &&
    target.id !== currentMacroId &&
    !(currentMacroId && macroDependsOn(macros, target.id, currentMacroId))
  );
}

export function getCallableMacroTargets(
  macros: Macro[],
  currentMacroId?: string
): Macro[] {
  return macros.filter((macro) => isCallableMacroTarget(macros, currentMacroId, macro.id));
}

export function isMacroIntervalPreset(value: number): boolean {
  return MACRO_INTERVAL_PRESETS.some((preset) => preset === value);
}

export function isValidMacroInterval(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MACRO_DELAY_MAX_MS;
}

export function formatMacroIntervalPreset(value: number, t: Translator): string {
  if (value === 0) {
    return t("macroForm.intervalNone");
  }
  const translationKey = value < 1000
    ? "macroForm.intervalMilliseconds"
    : "macroForm.intervalSeconds";
  const displayValue = value < 1000 ? value : value / 1000;

  return t(translationKey).replace("{value}", String(displayValue));
}

export const commonMacroKeyCodes = [
  "Backquote",
  "Backspace",
  "Tab",
  "CapsLock",
  "ShiftLeft",
  "ControlLeft",
  "AltLeft",
  "MetaLeft",
  "ContextMenu",
  "ShiftRight",
  "AltRight",
  "ControlRight",
  "MetaRight",
  "Escape",
  "Insert",
  "Home",
  "PageUp",
  "Delete",
  "End",
  "PageDown",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "NumLock",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Equal",
  "Minus",
  "Space",
  "Backslash",
  "Slash",
  "Period",
  "Comma",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Enter",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadComma",
  "NumpadParenLeft",
  "NumpadParenRight",
  "NumpadClear",
  "NumpadClearEntry",
  "NumpadSign",
  "AudioVolumeMute",
  "AudioVolumeDown",
  "AudioVolumeUp",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "MediaStop",
  "MediaPlayPause",
  "MediaSelect",
  "LaunchMail",
  "LaunchMediaPlayer",
  "LaunchApp1",
  "LaunchApp2",
  "BrowserBack",
  "BrowserForward",
  "BrowserStop",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserFavorites",
  "BrowserHome",
  "IntlBackslash",
  "IntlYen",
  "IntlRo",
  "KanaMode",
  "Lang1",
  "Lang2",
  "Lang3",
  "Lang4",
  "Convert",
  "NonConvert",
  "Help",
  "Find",
  "Select",
  "Open",
  "Close",
  "Redo",
  "Undo",
  "Cut",
  "Copy",
  "Paste",
  "Back",
  "Forward",
  "Power",
  "Sleep",
  "WakeUp"
] as const;

const codeLabels: Record<string, string> = {
  Backspace: "Backspace",
  Enter: "Enter",
  Equal: "=",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Escape: "Esc",
  Minus: "-",
  Space: "Space",
  Tab: "Tab"
};

const macroStepLabelKeys: Record<MacroStep["type"], TranslationKey> = {
  click: "macro.step.click",
  delay: "macro.step.delay",
  key: "macro.step.key",
  macro: "macro.step.macro"
};

export function createEmptyMacroFormName(macros: Macro[], t: Translator): string {
  const baseName = t("macros.defaultName");
  const existingNames = new Set(macros.map((macro) => macro.name.toLocaleLowerCase()));

  if (!existingNames.has(baseName.toLocaleLowerCase())) {
    return baseName;
  }

  let index = 2;
  while (existingNames.has(`${baseName} ${index}`.toLocaleLowerCase())) {
    index += 1;
  }

  return `${baseName} ${index}`;
}

export function createEmptyMacroForm(
  macros: Macro[],
  roles: Role[],
  t: Translator,
  requestedRoleId?: string
): MacroFormState {
  const roleId =
    requestedRoleId && roles.some((role) => role.id === requestedRoleId)
      ? requestedRoleId
      : roles[0]?.id ?? "";

  return {
    enabled: true,
    activationMode: "toggle",
    name: createEmptyMacroFormName(macros, t),
    roleIds: roleId ? [roleId] : [],
    repeat: { type: "once" },
    steps: [
      {
        id: createClientId(),
        type: "key",
        code: "Tab",
        action: "tap",
        label: "Tab"
      }
    ]
  };
}

export function createMacroFormState(macro: Macro): MacroFormState {
  return {
    id: macro.id,
    enabled: macro.enabled,
    activationMode: macro.activationMode ?? "toggle",
    name: macro.name,
    roleIds: [...macro.roleIds],
    repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
    steps: macro.steps.map((step) => ({ ...step })),
    trigger: macro.trigger ? { ...macro.trigger } : undefined
  };
}

export function formatMacroCode(code: string): string {
  if (codeLabels[code]) {
    return codeLabels[code];
  }

  if (code.startsWith("Key")) {
    return code.slice(3);
  }

  if (code.startsWith("Digit")) {
    return code.slice(5);
  }

  if (code.startsWith("Numpad")) {
    return `Num ${code.slice(6)}`;
  }

  if (code.startsWith("Arrow")) {
    return code.slice(5);
  }

  return code;
}

export function formatMacroShortcut(trigger: MacroTrigger | undefined, t: Translator): string {
  if (!trigger) {
    return t("macros.noShortcut");
  }

  const parts = [
    trigger.ctrl ? "Ctrl" : undefined,
    trigger.alt ? "Alt" : undefined,
    trigger.shift ? "Shift" : undefined,
    trigger.meta ? "Meta" : undefined,
    formatMacroCode(trigger.code)
  ].filter((part): part is string => Boolean(part));

  return parts.join("+");
}

export function formatMacroActivationMode(mode: MacroActivationMode | undefined, t: Translator): string {
  return t(mode === "while_held"
    ? "macroForm.activation.whileHeld"
    : "macroForm.activation.toggle");
}

export function formatMacroRepeat(repeat: MacroRepeat, t: Translator): string {
  if (repeat.type === "once") {
    return t("macros.repeat.once");
  }

  return repeat.intervalMs === 0
    ? t("macros.repeat.loopImmediate")
    : t("macros.repeat.loop").replace("{ms}", String(repeat.intervalMs));
}

export function summarizeMacroSteps(
  steps: MacroStep[],
  t: Translator,
  macroNameById?: ReadonlyMap<string, string>
): string {
  if (steps.length === 0) {
    return t("macros.steps.empty");
  }

  const summary = steps.slice(0, 4).map((step) => formatMacroStep(step, t, macroNameById));

  if (steps.length > summary.length) {
    summary.push(t("macros.steps.more").replace("{count}", String(steps.length - summary.length)));
  }

  return summary.join(" > ");
}

export function formatMacroStep(
  step: MacroStep,
  t: Translator,
  macroNameById?: ReadonlyMap<string, string>
): string {
  switch (step.type) {
    case "key":
      return step.action === "hold_until_stop"
        ? `${t("macro.step.hold")}:${formatMacroCode(step.code)}`
        : `${t(macroStepLabelKeys.key)}:${formatMacroCode(step.code)}`;
    case "click":
      return `${t(macroStepLabelKeys.click)}:X ${step.xPercent}%, Y ${step.yPercent}%`;
    case "delay":
      return `${t(macroStepLabelKeys.delay)}:${step.ms}ms`;
    case "macro":
      return `${t(macroStepLabelKeys.macro)}:${macroNameById?.get(step.macroId) ?? t("macros.unknownMacro")}`;
  }
}

export function createMacroRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}

export function getMacroPartialStartCounts(
  macro: Macro | undefined,
  startedStatuses: MacroRunStatus[]
): { skippedCount: number; startedCount: number } | undefined {
  const startedCount = startedStatuses.length;
  const skippedCount = Math.max(0, (macro?.roleIds.length ?? startedCount) - startedCount);

  return skippedCount > 0 ? { skippedCount, startedCount } : undefined;
}

export function createClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `macro-step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isPureModifierCode(code: string): boolean {
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
