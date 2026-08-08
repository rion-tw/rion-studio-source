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

interface MacroViewportSize {
  appliedPageZoom?: number;
  height: number;
  width: number;
}

interface MacroCoordinateMeasurement {
  anchor?: MacroClickAnchor;
  appliedPageZoom?: number;
  referenceViewportHeightPx?: number;
  referenceViewportWidthPx?: number;
  xPercent: number;
  xPx: number;
  xReferencePx?: number;
  viewportHeightPx?: number;
  viewportWidthPx?: number;
  yPercent: number;
  yPx: number;
  yReferencePx?: number;
}

export function formatMacroCoordinateClipboard(measurement: MacroCoordinateMeasurement): string {
  const anchor = measurement.anchor ?? findNearestMacroClickAnchor(measurement);
  const anchorSuffix = anchor === undefined ? "" : `, Anchor: ${anchor}`;
  if (hasReferenceCoordinateSpace(measurement) && anchor !== undefined) {
    return [
      `X: ${Math.round(measurement.xReferencePx)}px (${formatPercent(measurement.xPercent)}%)`,
      `Y: ${Math.round(measurement.yReferencePx)}px (${formatPercent(measurement.yPercent)}%)`,
      `Anchor: ${anchor}`,
      `ReferenceViewport: ${measurement.referenceViewportWidthPx}x${measurement.referenceViewportHeightPx}px`,
      `CSS: X ${Math.round(measurement.xPx)}px, Y ${Math.round(measurement.yPx)}px`,
      `Viewport: ${measurement.viewportWidthPx}x${measurement.viewportHeightPx}px`,
      `Zoom: ${formatPercent(measurement.appliedPageZoom * 100)}%`
    ].join(", ");
  }
  const viewportSuffix = measurement.viewportWidthPx !== undefined && measurement.viewportHeightPx !== undefined
    ? `, Viewport: ${measurement.viewportWidthPx}x${measurement.viewportHeightPx}px`
    : "";
  return `X: ${measurement.xPx}px (${formatPercent(measurement.xPercent)}%), Y: ${measurement.yPx}px (${formatPercent(measurement.yPercent)}%)${anchorSuffix}${viewportSuffix}`;
}

export function parseMacroCoordinateClipboard(value: string): MacroCoordinateMeasurement | undefined {
  const referenceMatch = /^\s*X\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*,\s*Y\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*,\s*Anchor\s*:\s*([A-Za-z]+(?:-[A-Za-z]+)*)\s*,\s*ReferenceViewport\s*:\s*(\d+)\s*x\s*(\d+)\s*px\s*,\s*CSS\s*:\s*X\s*(\d+(?:\.\d+)?)\s*px\s*,\s*Y\s*(\d+(?:\.\d+)?)\s*px\s*,\s*Viewport\s*:\s*(\d+)\s*x\s*(\d+)\s*px\s*,\s*Zoom\s*:\s*(\d+(?:\.\d+)?)\s*%\s*$/i.exec(value);
  if (referenceMatch) {
    const xReferencePx = Math.round(Number(referenceMatch[1]));
    const xPercent = Number(referenceMatch[2]);
    const yReferencePx = Math.round(Number(referenceMatch[3]));
    const yPercent = Number(referenceMatch[4]);
    const anchorValue = referenceMatch[5]?.toLowerCase();
    const referenceViewportWidthPx = Number(referenceMatch[6]);
    const referenceViewportHeightPx = Number(referenceMatch[7]);
    const xPx = Math.round(Number(referenceMatch[8]));
    const yPx = Math.round(Number(referenceMatch[9]));
    const viewportWidthPx = Number(referenceMatch[10]);
    const viewportHeightPx = Number(referenceMatch[11]);
    const appliedPageZoom = Number(referenceMatch[12]) / 100;
    if (
      anchorValue === undefined ||
      !isMacroClickAnchor(anchorValue) ||
      !validCoordinatePercent(xPercent) ||
      !validCoordinatePercent(yPercent) ||
      !isPositiveSafeInteger(referenceViewportWidthPx) ||
      !isPositiveSafeInteger(referenceViewportHeightPx) ||
      !isPositiveSafeInteger(viewportWidthPx) ||
      !isPositiveSafeInteger(viewportHeightPx) ||
      !Number.isFinite(appliedPageZoom) ||
      appliedPageZoom <= 0 ||
      xReferencePx < 0 ||
      xReferencePx >= referenceViewportWidthPx ||
      yReferencePx < 0 ||
      yReferencePx >= referenceViewportHeightPx ||
      xPx < 0 ||
      xPx >= viewportWidthPx ||
      yPx < 0 ||
      yPx >= viewportHeightPx ||
      Math.abs(referenceViewportWidthPx - Math.round(viewportWidthPx * appliedPageZoom)) > 1 ||
      Math.abs(referenceViewportHeightPx - Math.round(viewportHeightPx * appliedPageZoom)) > 1 ||
      Math.abs(xReferencePx - Math.round(xPx * appliedPageZoom)) > 1 ||
      Math.abs(yReferencePx - Math.round(yPx * appliedPageZoom)) > 1
    ) {
      return undefined;
    }
    return {
      anchor: anchorValue,
      appliedPageZoom,
      referenceViewportHeightPx,
      referenceViewportWidthPx,
      xPercent: roundPercent(xPercent),
      xPx,
      xReferencePx,
      viewportHeightPx,
      viewportWidthPx,
      yPercent: roundPercent(yPercent),
      yPx,
      yReferencePx
    };
  }

  const match = /^\s*X\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*,\s*Y\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)(?:\s*,\s*Anchor\s*:\s*([A-Za-z]+(?:-[A-Za-z]+)*))?(?:\s*,\s*Viewport\s*:\s*(\d+)\s*x\s*(\d+)\s*px)?\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }

  const [xPx, xPercent, yPx, yPercent] = match.slice(1, 5).map(Number);
  const anchorValue = match[5]?.toLowerCase();
  const parsedAnchor = anchorValue !== undefined && isMacroClickAnchor(anchorValue)
    ? anchorValue
    : undefined;
  const viewportWidthPx = match[6] === undefined ? undefined : Number(match[6]);
  const viewportHeightPx = match[7] === undefined ? undefined : Number(match[7]);
  const roundedXPx = Math.round(xPx);
  const roundedYPx = Math.round(yPx);
  if (
    !Number.isFinite(xPx) ||
    !Number.isFinite(yPx) ||
    !validCoordinatePercent(xPercent) ||
    !validCoordinatePercent(yPercent) ||
    xPx < 0 ||
    yPx < 0 ||
    (anchorValue !== undefined && parsedAnchor === undefined) ||
    (viewportWidthPx !== undefined && (!isPositiveSafeInteger(viewportWidthPx) || roundedXPx >= viewportWidthPx)) ||
    (viewportHeightPx !== undefined && (!isPositiveSafeInteger(viewportHeightPx) || roundedYPx >= viewportHeightPx))
  ) {
    return undefined;
  }

  return {
    ...(parsedAnchor === undefined ? {} : { anchor: parsedAnchor }),
    xPercent: roundPercent(xPercent),
    xPx: roundedXPx,
    ...(viewportHeightPx === undefined ? {} : { viewportHeightPx }),
    ...(viewportWidthPx === undefined ? {} : { viewportWidthPx }),
    yPercent: roundPercent(yPercent),
    yPx: roundedYPx
  };
}

export function findNearestMacroClickAnchor(
  measurement: Pick<MacroCoordinateMeasurement, "xPx" | "yPx" | "viewportWidthPx" | "viewportHeightPx">
): MacroClickAnchor | undefined {
  const { viewportHeightPx: height, viewportWidthPx: width } = measurement;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(measurement.xPx) ||
    !Number.isFinite(measurement.yPx)
  ) {
    return undefined;
  }

  let nearestAnchor: MacroClickAnchor | undefined;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const anchor of MACRO_CLICK_ANCHORS) {
    const base = getMacroClickAnchorBase(anchor);
    const anchorX = (width * base.xPercent) / 100;
    const anchorY = (height * base.yPercent) / 100;
    const deltaX = measurement.xPx - anchorX;
    const deltaY = measurement.yPx - anchorY;
    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestAnchor = anchor;
    }
  }

  return nearestAnchor;
}

interface MacroClickOffset {
  anchor?: MacroClickAnchor;
  unit: MacroClickUnit;
  x: number;
  y: number;
}

interface ResolvedMacroClickOffset {
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

  if (click.unit === "reference-px") {
    const zoom = viewport.appliedPageZoom;
    if (zoom === undefined || !Number.isFinite(zoom) || zoom <= 0) {
      throw new Error("Reference-pixel coordinates require an applied page zoom.");
    }
    return {
      x: (viewport.width * anchor.xPercent) / 100 + click.x / zoom,
      y: (viewport.height * anchor.yPercent) / 100 + click.y / zoom
    };
  }

  return {
    x: (viewport.width * anchor.xPercent) / 100 + click.x,
    y: (viewport.height * anchor.yPercent) / 100 + click.y
  };
}

function isMacroClickAnchor(value: unknown): value is MacroClickAnchor {
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

  if (unit === "reference-px") {
    if (!hasReferenceCoordinateSpace(measurement)) {
      return undefined;
    }
    return {
      x: Math.round(
        measurement.xReferencePx - (measurement.referenceViewportWidthPx * anchor.xPercent) / 100
      ),
      y: Math.round(
        measurement.yReferencePx - (measurement.referenceViewportHeightPx * anchor.yPercent) / 100
      )
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

function validCoordinatePercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function hasReferenceCoordinateSpace(
  measurement: MacroCoordinateMeasurement
): measurement is MacroCoordinateMeasurement & {
  appliedPageZoom: number;
  referenceViewportHeightPx: number;
  referenceViewportWidthPx: number;
  viewportHeightPx: number;
  viewportWidthPx: number;
  xReferencePx: number;
  yReferencePx: number;
} {
  return (
    typeof measurement.appliedPageZoom === "number" &&
    Number.isFinite(measurement.appliedPageZoom) &&
    measurement.appliedPageZoom > 0 &&
    isPositiveSafeInteger(measurement.referenceViewportHeightPx ?? 0) &&
    isPositiveSafeInteger(measurement.referenceViewportWidthPx ?? 0) &&
    isPositiveSafeInteger(measurement.viewportHeightPx ?? 0) &&
    isPositiveSafeInteger(measurement.viewportWidthPx ?? 0) &&
    Number.isFinite(measurement.xReferencePx) &&
    Number.isFinite(measurement.yReferencePx)
  );
}
