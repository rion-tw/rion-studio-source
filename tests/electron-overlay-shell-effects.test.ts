import type { MacroCoordinateRecord } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  ElectronOverlayShellEffects,
  formatMacroCoordinateText
} from "../src/electron/main/electronOverlayShellEffects";

function coordinate(): MacroCoordinateRecord {
  return {
    anchor: "top-left",
    appliedPageZoom: 0.75,
    referenceViewportHeightPx: 540,
    referenceViewportWidthPx: 960,
    xPercent: 22.27,
    xPx: 285,
    xReferencePx: 214,
    viewportHeightPx: 720,
    viewportWidthPx: 1280,
    yPercent: 0,
    yPx: 0,
    yReferencePx: 0
  };
}

function harness(input: Readonly<{ minimized?: boolean; destroyed?: boolean }> = {}) {
  let clipboardText = "";
  const window = {
    isDestroyed: vi.fn(() => input.destroyed ?? false),
    isMinimized: vi.fn(() => input.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  };
  const publishMacroPageRequested = vi.fn(() => true);
  const writeText = vi.fn((text: string) => { clipboardText = text; });
  const readText = vi.fn(() => clipboardText);
  const effects = new ElectronOverlayShellEffects({
    clipboard: { readText, writeText },
    mainWindow: () => window,
    publishMacroPageRequested
  });
  return {
    effects,
    publishMacroPageRequested,
    readText,
    window,
    writeText
  };
}

describe("Electron overlay shell effects", () => {
  it("presents the main window and preserves one exact pending macro-page request", () => {
    const test = harness({ minimized: true });

    expect(test.effects.openMacroPage("role-1")).toEqual({ roleId: "role-1" });
    expect(test.window.restore).toHaveBeenCalledOnce();
    expect(test.window.show).toHaveBeenCalledOnce();
    expect(test.window.focus).toHaveBeenCalledOnce();
    expect(test.publishMacroPageRequested).toHaveBeenCalledWith({ roleId: "role-1" });
    expect(test.effects.consumePendingMacroPageRequest()).toEqual({ roleId: "role-1" });
    expect(test.effects.consumePendingMacroPageRequest()).toBeNull();
  });

  it("retains the latest request when renderer delivery is unavailable", () => {
    const test = harness();
    test.publishMacroPageRequested.mockReturnValue(false);

    test.effects.openMacroPage("role-1");
    test.effects.openMacroPage("role-2");

    expect(test.effects.consumePendingMacroPageRequest()).toEqual({ roleId: "role-2" });
  });

  it("rejects malformed roles and a destroyed main window", () => {
    const malformed = harness();
    expect(() => malformed.effects.openMacroPage(" role-1"))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_OVERLAY_ROLE_ID_INVALID" }));

    const destroyed = harness({ destroyed: true });
    expect(() => destroyed.effects.openMacroPage("role-1"))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_MAIN_WINDOW_UNAVAILABLE" }));
    expect(destroyed.publishMacroPageRequested).not.toHaveBeenCalled();
  });

  it("formats and verifies the exact legacy-compatible coordinate text", () => {
    const test = harness();
    const expected = "X: 214px (22.27%), Y: 0px (0%), Anchor: top-left, " +
      "ReferenceViewport: 960x540px, CSS: X 285px, Y 0px, " +
      "Viewport: 1280x720px, Zoom: 75%";

    expect(formatMacroCoordinateText(coordinate())).toBe(expected);
    expect(test.effects.copyCoordinate(coordinate())).toEqual({ text: expected });
    expect(test.writeText).toHaveBeenCalledWith(expected);
    expect(test.readText).toHaveBeenCalledOnce();
  });

  it("fails closed when clipboard readback diverges or coordinates are invalid", () => {
    const test = harness();
    test.readText.mockReturnValue("replaced by another writer");
    expect(() => test.effects.copyCoordinate(coordinate()))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_SHELL_CLIPBOARD_INDETERMINATE"
      }));

    const invalid = coordinate();
    invalid.xPx = invalid.viewportWidthPx;
    expect(() => formatMacroCoordinateText(invalid))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_OVERLAY_COORDINATE_INVALID" }));

    const mismatchedReference = coordinate();
    mismatchedReference.xReferencePx = 1;
    expect(() => formatMacroCoordinateText(mismatchedReference))
      .toThrowError(expect.objectContaining({ code: "ELECTRON_OVERLAY_COORDINATE_INVALID" }));
  });
});
