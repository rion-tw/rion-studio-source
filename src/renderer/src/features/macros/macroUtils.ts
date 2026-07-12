import type { Macro, MacroRepeat, MacroStep, MacroTrigger } from "../../../../shared/types";
import type { TranslationKey, Translator } from "../../i18n";

export const commonMacroKeyCodes = [
  "Escape",
  "Tab",
  "Space",
  "Enter",
  "Backspace",
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
  "KeyS",
  "KeyD",
  "KeyF",
  "KeyQ",
  "KeyW",
  "KeyE",
  "KeyR",
  "KeyZ",
  "KeyX",
  "KeyC",
  "KeyV",
  "Minus",
  "Equal"
] as const;

const codeLabels: Record<string, string> = {
  Backspace: "Backspace",
  Enter: "Enter",
  Equal: "=",
  Escape: "Esc",
  Minus: "-",
  Space: "Space",
  Tab: "Tab"
};

const macroStepLabelKeys: Record<MacroStep["type"], TranslationKey> = {
  click: "macro.step.click",
  delay: "macro.step.delay",
  key: "macro.step.key"
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

export function formatMacroRepeat(repeat: MacroRepeat, t: Translator): string {
  if (repeat.type === "once") {
    return t("macros.repeat.once");
  }

  return t("macros.repeat.loop").replace("{ms}", String(repeat.intervalMs));
}

export function summarizeMacroSteps(steps: MacroStep[], t: Translator): string {
  if (steps.length === 0) {
    return t("macros.steps.empty");
  }

  const summary = steps.slice(0, 4).map((step) => formatMacroStep(step, t));

  if (steps.length > summary.length) {
    summary.push(t("macros.steps.more").replace("{count}", String(steps.length - summary.length)));
  }

  return summary.join(" > ");
}

export function formatMacroStep(step: MacroStep, t: Translator): string {
  switch (step.type) {
    case "key":
      return `${t(macroStepLabelKeys.key)}:${formatMacroCode(step.code)}`;
    case "click":
      return `${t(macroStepLabelKeys.click)}:X ${step.xPercent}%, Y ${step.yPercent}%`;
    case "delay":
      return `${t(macroStepLabelKeys.delay)}:${step.ms}ms`;
  }
}

export function createMacroRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
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
