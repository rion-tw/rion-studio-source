export interface MacroCoordinateMeasurement {
  xPercent: number;
  xPx: number;
  yPercent: number;
  yPx: number;
}

export function formatMacroCoordinateClipboard(measurement: MacroCoordinateMeasurement): string {
  return `X: ${measurement.xPx}px (${formatPercent(measurement.xPercent)}%), Y: ${measurement.yPx}px (${formatPercent(measurement.yPercent)}%)`;
}

export function parseMacroCoordinateClipboard(value: string): MacroCoordinateMeasurement | undefined {
  const match = /^\s*X\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*,\s*Y\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }

  const [xPx, xPercent, yPx, yPercent] = match.slice(1).map(Number);
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
    yPercent > 100
  ) {
    return undefined;
  }

  return {
    xPercent: roundPercent(xPercent),
    xPx: Math.round(xPx),
    yPercent: roundPercent(yPercent),
    yPx: Math.round(yPx)
  };
}

function formatPercent(value: number): string {
  return String(roundPercent(value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
