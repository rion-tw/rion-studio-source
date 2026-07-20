import type { MacroClickAnchor, MacroClickUnit } from "./types";

export const DEFAULT_MACRO_CLICK_ANCHOR: MacroClickAnchor = "top-left";

export const MACRO_CLICK_ANCHORS: readonly MacroClickAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right"
];

export interface MacroViewportSize {
  height: number;
  width: number;
}

export interface MacroCoordinateMeasurement {
  xPercent: number;
  xPx: number;
  viewportHeightPx?: number;
  viewportWidthPx?: number;
  yPercent: number;
  yPx: number;
}

export function formatMacroCoordinateClipboard(measurement: MacroCoordinateMeasurement): string {
  const viewportSuffix = measurement.viewportWidthPx !== undefined && measurement.viewportHeightPx !== undefined
    ? `, Viewport: ${measurement.viewportWidthPx}x${measurement.viewportHeightPx}px`
    : "";
  return `X: ${measurement.xPx}px (${formatPercent(measurement.xPercent)}%), Y: ${measurement.yPx}px (${formatPercent(measurement.yPercent)}%)${viewportSuffix}`;
}

export function parseMacroCoordinateClipboard(value: string): MacroCoordinateMeasurement | undefined {
  const match = /^\s*X\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*,\s*Y\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)(?:\s*,\s*Viewport\s*:\s*(\d+)\s*x\s*(\d+)\s*px)?\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }

  const [xPx, xPercent, yPx, yPercent] = match.slice(1, 5).map(Number);
  const viewportWidthPx = match[5] === undefined ? undefined : Number(match[5]);
  const viewportHeightPx = match[6] === undefined ? undefined : Number(match[6]);
  const roundedXPx = Math.round(xPx);
  const roundedYPx = Math.round(yPx);
  if (
    !Number.isFinite(xPx) ||
    !Number.isFinite(yPx) ||
    !Number.isFinite(xPercent) ||
    !Number.isFinite(yPercent) ||
    xPx < 0 ||
    yPx < 0 ||
    xPercent < 0 ||
    xPercent > 100 ||
    yPercent < 0 ||
    yPercent > 100 ||
    (viewportWidthPx !== undefined && (!isPositiveSafeInteger(viewportWidthPx) || roundedXPx >= viewportWidthPx)) ||
    (viewportHeightPx !== undefined && (!isPositiveSafeInteger(viewportHeightPx) || roundedYPx >= viewportHeightPx))
  ) {
    return undefined;
  }

  return {
    xPercent: roundPercent(xPercent),
    xPx: roundedXPx,
    ...(viewportHeightPx === undefined ? {} : { viewportHeightPx }),
    ...(viewportWidthPx === undefined ? {} : { viewportWidthPx }),
    yPercent: roundPercent(yPercent),
    yPx: roundedYPx
  };
}

export interface MacroClickOffset {
  anchor?: MacroClickAnchor;
  unit: MacroClickUnit;
  x: number;
  y: number;
}

export interface ResolvedMacroClickOffset {
  x: number;
  y: number;
}

export function resolveMacroClickOffset(
  click: MacroClickOffset,
  viewport: MacroViewportSize
): ResolvedMacroClickOffset {
  const anchor = getMacroClickAnchorBase(click.anchor);
  if (click.unit === "percent") {
    return {
      x: anchor.xPercent + click.x,
      y: anchor.yPercent + click.y
    };
  }

  return {
    x: (viewport.width * anchor.xPercent) / 100 + click.x,
    y: (viewport.height * anchor.yPercent) / 100 + click.y
  };
}

export function isMacroClickAnchor(value: unknown): value is MacroClickAnchor {
  return typeof value === "string" && MACRO_CLICK_ANCHORS.includes(value as MacroClickAnchor);
}

export function convertMacroCoordinateToOffset(
  measurement: MacroCoordinateMeasurement,
  anchorValue: MacroClickAnchor | undefined,
  unit: MacroClickUnit
): { x: number; y: number } | undefined {
  const anchor = getMacroClickAnchorBase(anchorValue);
  if (unit === "percent") {
    return {
      x: roundPercent(measurement.xPercent - anchor.xPercent),
      y: roundPercent(measurement.yPercent - anchor.yPercent)
    };
  }

  if (measurement.viewportWidthPx === undefined || measurement.viewportHeightPx === undefined) {
    return anchorValue === DEFAULT_MACRO_CLICK_ANCHOR || anchorValue === undefined
      ? { x: measurement.xPx, y: measurement.yPx }
      : undefined;
  }

  return {
    x: Math.round(measurement.xPx - (measurement.viewportWidthPx * anchor.xPercent) / 100),
    y: Math.round(measurement.yPx - (measurement.viewportHeightPx * anchor.yPercent) / 100)
  };
}

function getMacroClickAnchorBase(anchorValue: MacroClickAnchor | undefined): {
  xPercent: number;
  yPercent: number;
} {
  const anchor = anchorValue ?? DEFAULT_MACRO_CLICK_ANCHOR;
  const [vertical, horizontal] = anchor.split("-");
  return {
    xPercent: horizontal === "left" ? 0 : horizontal === "right" ? 100 : 50,
    yPercent: vertical === "top" ? 0 : vertical === "bottom" ? 100 : 50
  };
}

function formatPercent(value: number): string {
  return String(roundPercent(value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
