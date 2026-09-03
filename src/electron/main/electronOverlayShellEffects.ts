import type { MacroCoordinateRecord } from "../../shared/generated";
import type { MacroPageRequest } from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";

const COORDINATE_ANCHORS = new Set<MacroCoordinateRecord["anchor"]>([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right"
]);

export interface ElectronOverlayMainWindowPort {
  focus: () => void;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
}

export interface ElectronOverlayClipboardPort {
  readText: () => string;
  writeText: (text: string) => void;
}

export interface ElectronOverlayShellEffectsInput {
  readonly clipboard: ElectronOverlayClipboardPort;
  readonly mainWindow: () => ElectronOverlayMainWindowPort | null;
  readonly publishMacroPageRequested: (request: MacroPageRequest) => boolean;
}

function shellError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireIdentifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw shellError(
      "ELECTRON_OVERLAY_ROLE_ID_INVALID",
      "Core supplied an invalid overlay role identity."
    );
  }
  return value;
}

function requireSafePixel(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw shellError(
      "ELECTRON_OVERLAY_COORDINATE_INVALID",
      "Core supplied an invalid macro coordinate."
    );
  }
  return value;
}

function requireFinite(value: number): number {
  if (!Number.isFinite(value)) {
    throw shellError(
      "ELECTRON_OVERLAY_COORDINATE_INVALID",
      "Core supplied an invalid macro coordinate."
    );
  }
  return value;
}

function validateCoordinate(coordinate: MacroCoordinateRecord): void {
  const viewportWidth = requireSafePixel(coordinate.viewportWidthPx);
  const viewportHeight = requireSafePixel(coordinate.viewportHeightPx);
  const referenceWidth = requireSafePixel(coordinate.referenceViewportWidthPx);
  const referenceHeight = requireSafePixel(coordinate.referenceViewportHeightPx);
  const x = requireSafePixel(coordinate.xPx);
  const y = requireSafePixel(coordinate.yPx);
  const referenceX = requireSafePixel(coordinate.xReferencePx);
  const referenceY = requireSafePixel(coordinate.yReferencePx);
  const zoom = requireFinite(coordinate.appliedPageZoom);
  const xPercent = requireFinite(coordinate.xPercent);
  const yPercent = requireFinite(coordinate.yPercent);
  const withinReferenceRounding = (reference: number, css: number): boolean =>
    Math.abs(reference - Math.round(css * zoom)) <= 1;
  if (
    viewportWidth === 0 ||
    viewportHeight === 0 ||
    referenceWidth === 0 ||
    referenceHeight === 0 ||
    x >= viewportWidth ||
    y >= viewportHeight ||
    referenceX >= referenceWidth ||
    referenceY >= referenceHeight ||
    zoom <= 0 ||
    !withinReferenceRounding(referenceWidth, viewportWidth) ||
    !withinReferenceRounding(referenceHeight, viewportHeight) ||
    !withinReferenceRounding(referenceX, x) ||
    !withinReferenceRounding(referenceY, y) ||
    xPercent < 0 ||
    xPercent > 100 ||
    yPercent < 0 ||
    yPercent > 100 ||
    !COORDINATE_ANCHORS.has(coordinate.anchor)
  ) {
    throw shellError(
      "ELECTRON_OVERLAY_COORDINATE_INVALID",
      "Core supplied an invalid macro coordinate."
    );
  }
}

function formatPageZoomPercent(zoom: number): string {
  return (zoom * 100).toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function formatMacroCoordinateText(
  coordinate: MacroCoordinateRecord
): string {
  validateCoordinate(coordinate);
  return `X: ${coordinate.xReferencePx}px (${coordinate.xPercent}%), ` +
    `Y: ${coordinate.yReferencePx}px (${coordinate.yPercent}%), ` +
    `Anchor: ${coordinate.anchor}, ` +
    `ReferenceViewport: ${coordinate.referenceViewportWidthPx}x` +
    `${coordinate.referenceViewportHeightPx}px, ` +
    `CSS: X ${coordinate.xPx}px, Y ${coordinate.yPx}px, ` +
    `Viewport: ${coordinate.viewportWidthPx}x${coordinate.viewportHeightPx}px, ` +
    `Zoom: ${formatPageZoomPercent(coordinate.appliedPageZoom)}%`;
}

/**
 * Owns the two overlay effects that target the Electron application shell.
 * Runtime game-window ownership remains in the Chromium/AppKit executor.
 */
export class ElectronOverlayShellEffects {
  readonly #input: ElectronOverlayShellEffectsInput;
  #pendingMacroPageRequest: MacroPageRequest | null = null;

  constructor(input: ElectronOverlayShellEffectsInput) {
    this.#input = input;
  }

  openMacroPage(roleId: string): Readonly<MacroPageRequest> {
    const request = Object.freeze({ roleId: requireIdentifier(roleId) });
    const window = this.#input.mainWindow();
    if (!window || window.isDestroyed()) {
      throw shellError(
        "ELECTRON_MAIN_WINDOW_UNAVAILABLE",
        "The Rion Studio window is unavailable for the macro-page request."
      );
    }

    // Store before presentation and notification. A renderer reload or an IPC
    // delivery race can then consume the exact last request once it is ready.
    this.#pendingMacroPageRequest = request;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.#input.publishMacroPageRequested(request);
    return request;
  }

  consumePendingMacroPageRequest(): Readonly<MacroPageRequest> | null {
    const request = this.#pendingMacroPageRequest;
    this.#pendingMacroPageRequest = null;
    return request;
  }

  copyCoordinate(coordinate: MacroCoordinateRecord): Readonly<{ text: string }> {
    const text = formatMacroCoordinateText(coordinate);
    this.#input.clipboard.writeText(text);
    if (this.#input.clipboard.readText() !== text) {
      throw shellError(
        "ELECTRON_SHELL_CLIPBOARD_INDETERMINATE",
        "The system clipboard did not acknowledge the exact macro coordinate."
      );
    }
    return Object.freeze({ text });
  }
}
