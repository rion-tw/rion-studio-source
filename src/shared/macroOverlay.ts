import type { MacroBadgeHorizontalAlign, MacroBadgePositionSettings } from "./types";

export const macroBadgeTopPositionsPx = Array.from({ length: 41 }, (_value, index) => index * 8);
export const macroBadgeHorizontalMarginsPx = Array.from({ length: 17 }, (_value, index) => index * 8);

export const DEFAULT_MACRO_BADGE_POSITION: MacroBadgePositionSettings = {
  horizontalAlign: "center",
  horizontalMarginPx: 8,
  topPx: 128
};

export function normalizeMacroBadgePositionSettings(
  value: unknown,
  fallback: MacroBadgePositionSettings = DEFAULT_MACRO_BADGE_POSITION
): MacroBadgePositionSettings {
  const input = isRecord(value) ? value : {};

  return {
    horizontalAlign: normalizeHorizontalAlign(input.horizontalAlign, fallback.horizontalAlign),
    horizontalMarginPx: normalizePx(
      input.horizontalMarginPx,
      macroBadgeHorizontalMarginsPx,
      fallback.horizontalMarginPx
    ),
    topPx: normalizePx(input.topPx, macroBadgeTopPositionsPx, fallback.topPx)
  };
}

function normalizeHorizontalAlign(
  value: unknown,
  fallback: MacroBadgeHorizontalAlign
): MacroBadgeHorizontalAlign {
  return value === "left" || value === "center" || value === "right" ? value : fallback;
}

function normalizePx<const T extends readonly number[]>(
  value: unknown,
  options: T,
  fallback: number
): number {
  return typeof value === "number" && Number.isInteger(value) && options.includes(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
