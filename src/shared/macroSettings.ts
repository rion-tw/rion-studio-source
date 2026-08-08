import type { MacroSettings } from "./types";

export const MACRO_DELAY_MAX_MS = 86_400_000;
export const MACRO_KEY_HOLD_DURATION_MIN_MS = 20;
export const DEFAULT_MACRO_KEY_HOLD_DURATION_MS = 1_000;

export function isValidMacroKeyHoldDuration(value: number): boolean {
  return Number.isInteger(value) &&
    value >= MACRO_KEY_HOLD_DURATION_MIN_MS &&
    value <= MACRO_DELAY_MAX_MS;
}

export const MACRO_SETTINGS_CONSTRAINTS = {
  startupDelayMs: { min: 0, max: 10_000, recommendedMin: 100 },
  keyHoldMs: { min: 20, max: 1_000, recommendedMin: 30 },
  postInputDelayMs: { min: 10, max: 1_000, recommendedMin: 30 },
  defaultLoopDelayMs: { min: 0, max: MACRO_DELAY_MAX_MS, recommendedMin: 250 }
} as const;

export const DEFAULT_MACRO_SETTINGS: MacroSettings = {
  startupDelayMs: 100,
  keyHoldMs: 30,
  postInputDelayMs: 30,
  defaultLoopDelayMs: 1_000
};

export function normalizeMacroSettings(value: unknown): MacroSettings {
  const settings = isRecord(value) ? value : {};

  return {
    startupDelayMs: normalizeField(settings.startupDelayMs, "startupDelayMs"),
    keyHoldMs: normalizeField(settings.keyHoldMs, "keyHoldMs"),
    postInputDelayMs: normalizeField(settings.postInputDelayMs, "postInputDelayMs"),
    defaultLoopDelayMs: normalizeField(settings.defaultLoopDelayMs, "defaultLoopDelayMs")
  };
}

export function isValidMacroSettingValue(
  key: keyof MacroSettings,
  value: number
): boolean {
  const constraint = MACRO_SETTINGS_CONSTRAINTS[key];
  return Number.isInteger(value) && value >= constraint.min && value <= constraint.max;
}

function normalizeField(settingsValue: unknown, key: keyof MacroSettings): number {
  return typeof settingsValue === "number" && isValidMacroSettingValue(key, settingsValue)
    ? settingsValue
    : DEFAULT_MACRO_SETTINGS[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
