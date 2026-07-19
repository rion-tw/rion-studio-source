import type { MacroBadgeHorizontalAlign, MacroBadgePositionSettings } from "./types";

export const macroBadgeVerticalPositions = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80] as const;
export const macroBadgeHorizontalMargins = [0, 5, 10, 15, 20] as const;

export const DEFAULT_MACRO_BADGE_POSITION: MacroBadgePositionSettings = {
  horizontalAlign: "center",
  horizontalMarginPercent: 0,
  topPercent: 20
};

export function normalizeMacroBadgePositionSettings(
  value: unknown,
  fallback: MacroBadgePositionSettings = DEFAULT_MACRO_BADGE_POSITION
): MacroBadgePositionSettings {
  const input = isRecord(value) ? value : {};

  return {
    horizontalAlign: normalizeHorizontalAlign(input.horizontalAlign, fallback.horizontalAlign),
    horizontalMarginPercent: normalizeHorizontalMargin(
      input.horizontalMarginPercent,
      fallback.horizontalMarginPercent
    ),
    topPercent: normalizeVerticalPosition(input.topPercent, fallback.topPercent)
  };
}

function normalizeHorizontalAlign(
  value: unknown,
  fallback: MacroBadgeHorizontalAlign
): MacroBadgeHorizontalAlign {
  return value === "left" || value === "center" || value === "right" ? value : fallback;
}

function normalizeHorizontalMargin(value: unknown, fallback: number): number {
  return isAllowedPercent(value, macroBadgeHorizontalMargins) ? value : fallback;
}

function normalizeVerticalPosition(value: unknown, fallback: number): number {
  return isAllowedPercent(value, macroBadgeVerticalPositions) ? value : fallback;
}

function isAllowedPercent<const T extends readonly number[]>(
  value: unknown,
  options: T
): value is T[number] {
  return typeof value === "number" && Number.isInteger(value) && options.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
