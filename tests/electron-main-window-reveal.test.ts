import { describe, expect, it, vi } from "vitest";

import { revealElectronMainWindowOnStartupReady } from
  "../src/electron/main/electronMainWindowReveal";

describe("Electron main-window startup reveal", () => {
  it("reveals an initially hidden live window from document readiness", () => {
    let documentReady: (() => void) | undefined;
    let readyToShow: (() => void) | undefined;
    const show = vi.fn();

    revealElectronMainWindowOnStartupReady({
      isDestroyed: () => false,
      isVisible: () => false,
      webContents: {
        once: (_event, listener) => { documentReady = listener; }
      },
      once: (_event, listener) => { readyToShow = listener; },
      show
    });

    expect(show).not.toHaveBeenCalled();
    documentReady?.();
    expect(show).toHaveBeenCalledOnce();
    readyToShow?.();
    expect(show).toHaveBeenCalledOnce();
  });

  it("does not re-present an already visible or destroyed window", () => {
    for (const state of ["visible", "destroyed"] as const) {
      let readyToShow: (() => void) | undefined;
      const show = vi.fn();
      revealElectronMainWindowOnStartupReady({
        isDestroyed: () => state === "destroyed",
        isVisible: () => state === "visible",
        webContents: { once: vi.fn() },
        once: (_event, listener) => { readyToShow = listener; },
        show
      });
      readyToShow?.();
      expect(show).not.toHaveBeenCalled();
    }
  });
});
