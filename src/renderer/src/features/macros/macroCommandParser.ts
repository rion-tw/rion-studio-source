import type { Macro, MacroKeyModifier, MacroStep } from "../../../../shared/types";
import { MACRO_DELAY_MAX_MS } from "../../../../shared/macroSettings";
import {
  canonicalizeMacroKeyModifiers,
  isMacroModifierCode
} from "../../../../shared/macroKeys";

import {
  commonMacroKeyCodes,
  getMacroTargetUnavailableReason
} from "./macroUtils";

export const MACRO_COMMAND_MAX_STEPS = 100;

export type MacroCommandIssueCode =
  | "callToggle"
  | "invalidClick"
  | "invalidKeyCombination"
  | "invalidWait"
  | "missingMacro"
  | "stepLimit"
  | "unclosedQuote"
  | "unavailableMacro"
  | "unknownCommand"
  | "unknownKey"
  | "unsupported";

export interface MacroCommandIssue {
  code: MacroCommandIssueCode;
  detail?: string;
  token: string;
}

interface MacroCommandParseOptions {
  currentMacroId?: string;
  idFactory?: () => string;
  maxSteps?: number;
  macros?: Macro[];
}

export interface MacroCommandParseResult {
  issues: MacroCommandIssue[];
  steps: MacroStep[];
  tokens: string[];
}

const unsupportedCommands = new Set([
  "ATKAROUND",
  "ATKFRONT",
  "AUTOATK",
  "AUTOATKIT",
  "AUTOBERRY",
  "LOOKFORWARD",
  "SAY",
  "SEND",
  "STOP"
]);

const keyTokenToCode = new Map<string, string>([
  ["ESC", "Escape"],
  ["ESCAPE", "Escape"],
  ["SPACE", "Space"],
  ["TAB", "Tab"],
  ["BACKSPACE", "Backspace"],
  ["ENTER", "Enter"],
  ["↵", "Enter"],
  ["PAGEUP", "PageUp"],
  ["PAGEDOWN", "PageDown"],
  ["CAPS", "CapsLock"],
  ["CAPSLOCK", "CapsLock"],
  ["SHIFT", "ShiftLeft"],
  ["CONTROL", "ControlLeft"],
  ["CTRL", "ControlLeft"],
  ["ALT", "AltLeft"],
  ["ARROWUP", "ArrowUp"],
  ["↑", "ArrowUp"],
  ["UP", "ArrowUp"],
  ["ARROWDOWN", "ArrowDown"],
  ["↓", "ArrowDown"],
  ["DOWN", "ArrowDown"],
  ["ARROWLEFT", "ArrowLeft"],
  ["←", "ArrowLeft"],
  ["LEFT", "ArrowLeft"],
  ["ARROWRIGHT", "ArrowRight"],
  ["→", "ArrowRight"],
  ["RIGHT", "ArrowRight"],
  ["META", "MetaLeft"],
  ["COMMAND", "MetaLeft"],
  ["CMD", "MetaLeft"],
  ["WIN", "MetaLeft"],
  ["WINDOWS", "MetaLeft"]
]);

const keyModifierTokenToModifier = new Map<string, MacroKeyModifier>([
  ["PRIMARY", "primary"],
  ["CONTROL", "ctrl"],
  ["CTRL", "ctrl"],
  ["ALT", "alt"],
  ["SHIFT", "shift"],
  ["META", "meta"],
  ["COMMAND", "meta"],
  ["CMD", "meta"],
  ["WIN", "meta"],
  ["WINDOWS", "meta"]
]);

for (const code of commonMacroKeyCodes) {
  keyTokenToCode.set(code.toUpperCase(), code);
}

for (let digit = 0; digit <= 9; digit += 1) {
  keyTokenToCode.set(String(digit), `Digit${digit}`);
}

for (let codePoint = "A".charCodeAt(0); codePoint <= "Z".charCodeAt(0); codePoint += 1) {
  const letter = String.fromCharCode(codePoint);
  keyTokenToCode.set(letter, `Key${letter}`);
}

for (let functionKey = 1; functionKey <= 24; functionKey += 1) {
  keyTokenToCode.set(`F${functionKey}`, `F${functionKey}`);
}

export function parseMacroCommand(
  input: string,
  options: MacroCommandParseOptions = {}
): MacroCommandParseResult {
  const splitResult = splitCommandTokens(input);
  const issues: MacroCommandIssue[] = splitResult.unclosedQuote
    ? [{ code: "unclosedQuote", token: input.trim() }]
    : [];
  const steps: MacroStep[] = [];
  let generatedStepId = 0;
  const idFactory = options.idFactory ?? (() => `imported-step-${generatedStepId++}`);
  const macros = options.macros ?? [];

  splitResult.tokens.forEach((rawToken) => {
    const token = rawToken.trim();
    if (!token) {
      return;
    }

    const separatorIndex = token.indexOf(":");
    const rawHead = separatorIndex === -1 ? token : token.slice(0, separatorIndex);
    const head = rawHead.trim().toUpperCase();
    const argument = separatorIndex === -1 ? "" : token.slice(separatorIndex + 1).trim();

    if (head === "WAIT") {
      const ms = parseInteger(argument);
      if (ms === undefined || ms < 0 || ms > MACRO_DELAY_MAX_MS) {
        issues.push({ code: "invalidWait", token });
        return;
      }
      steps.push({ id: idFactory(), type: "delay", ms });
      return;
    }

    if (head === "CLICK") {
      const clickStep = parseClickStep(argument, idFactory);
      if (!clickStep) {
        issues.push({ code: "invalidClick", token });
        return;
      }
      steps.push(clickStep);
      return;
    }

    if (head === "CALL" || head === "START") {
      const target = macros.find((macro) => macro.name === argument);
      if (!target) {
        issues.push({ code: "missingMacro", detail: argument, token });
        return;
      }

      const unavailableReason = getMacroTargetUnavailableReason(
        macros,
        options.currentMacroId,
        target.id
      );
      if (unavailableReason) {
        issues.push({ code: "unavailableMacro", detail: argument, token });
        return;
      }

      const callMode = target.repeat.type === "loop" ? "trigger" : "wait";
      steps.push({ id: idFactory(), type: "macro", macroId: target.id, callMode });
      if (head === "CALL") {
        issues.push({ code: "callToggle", detail: argument, token });
      }
      return;
    }

    if (unsupportedCommands.has(head)) {
      issues.push({ code: "unsupported", token });
      return;
    }

    if (separatorIndex !== -1) {
      issues.push({ code: "unknownCommand", token });
      return;
    }

    const keyStep = parseKeyStep(token, idFactory);
    if (!keyStep) {
      issues.push({ code: token.includes("+") ? "invalidKeyCombination" : "unknownKey", token });
      return;
    }

    steps.push(keyStep);
  });

  if (options.maxSteps !== undefined && steps.length > options.maxSteps) {
    issues.push({
      code: "stepLimit",
      detail: String(options.maxSteps),
      token: String(steps.length)
    });
  }

  return {
    issues,
    steps,
    tokens: splitResult.tokens
  };
}

function parseKeyStep(token: string, idFactory: () => string): MacroStep | undefined {
  const parts = token.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return undefined;
  }

  if (parts.length === 1) {
    const code = keyTokenToCode.get(normalizeKeyToken(parts[0]));
    return code ? { id: idFactory(), type: "key", code, action: "tap" } : undefined;
  }

  const mainKeyToken = parts.at(-1);
  const code = mainKeyToken
    ? keyTokenToCode.get(normalizeKeyToken(mainKeyToken))
    : undefined;
  if (!code || isMacroModifierCode(code)) {
    return undefined;
  }

  const modifiers: MacroKeyModifier[] = [];
  for (const modifierToken of parts.slice(0, -1)) {
    const modifier = keyModifierTokenToModifier.get(normalizeKeyToken(modifierToken));
    if (!modifier || modifiers.includes(modifier)) {
      return undefined;
    }
    modifiers.push(modifier);
  }

  const normalizedModifiers = canonicalizeMacroKeyModifiers(modifiers);
  if (
    normalizedModifiers.includes("primary") &&
    normalizedModifiers.some((modifier) => modifier === "ctrl" || modifier === "meta")
  ) {
    return undefined;
  }

  return {
    id: idFactory(),
    type: "key",
    code,
    modifiers: normalizedModifiers,
    action: "tap"
  };
}

function parseClickStep(argument: string, idFactory: () => string): MacroStep | undefined {
  const coordinates = argument.split(",").map((value) => value.trim());
  if (coordinates.length !== 2) {
    return undefined;
  }

  const x = parseCoordinate(coordinates[0]);
  const y = parseCoordinate(coordinates[1]);
  if (!x || !y || x.unit !== y.unit) {
    return undefined;
  }

  if (x.unit === "px") {
    return {
      id: idFactory(),
      type: "click",
      unit: "px",
      xPx: x.value,
      yPx: y.value
    };
  }

  return {
    id: idFactory(),
    type: "click",
    xPercent: x.value,
    yPercent: y.value
  };
}

function parseCoordinate(value: string): { unit: "percent" | "px"; value: number } | undefined {
  const match = value.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(%|px)$/i);
  if (!match) {
    return undefined;
  }

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) {
    return undefined;
  }

  const unit = match[2].toLowerCase() === "px" ? "px" : "percent";
  if (unit === "percent" && (numericValue < -100 || numericValue > 100)) {
    return undefined;
  }
  if (unit === "px" && !Number.isSafeInteger(numericValue)) {
    return undefined;
  }

  return { unit, value: numericValue };
}

function parseInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeKeyToken(value: string): string {
  return value.trim().toUpperCase();
}

function splitCommandTokens(input: string): { tokens: string[]; unclosedQuote: boolean } {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;

  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ">" && !quoted) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  tokens.push(current);
  return { tokens, unclosedQuote: quoted };
}
