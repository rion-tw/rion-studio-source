import { describe, expect, it, vi } from "vitest";

import {
  installRuntimeTitlebarHeightReporter,
  type RuntimeWindowControlsOverlay
} from "../src/preload/runtimeTabsWindowControlsOverlay";

describe("runtime tabs window controls overlay", () => {
  it("reports the initial macOS titlebar height and subsequent geometry changes", () => {
    let geometryChangeListener: EventListener | undefined;
    const getTitlebarAreaRect = vi.fn()
      .mockReturnValueOnce({ height: 32 })
      .mockReturnValueOnce({ height: 38 });
    const overlay = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "geometrychange") geometryChangeListener = listener;
      }),
      getTitlebarAreaRect,
      removeEventListener: vi.fn()
    } as unknown as RuntimeWindowControlsOverlay;
    const report = vi.fn();

    const cleanup = installRuntimeTitlebarHeightReporter(
      "darwin",
      { windowControlsOverlay: overlay },
      report
    );
    expect(report).toHaveBeenLastCalledWith(32);

    geometryChangeListener?.(new Event("geometrychange"));
    expect(report).toHaveBeenLastCalledWith(38);

    cleanup?.();
    expect(overlay.removeEventListener).toHaveBeenCalledWith(
      "geometrychange",
      expect.any(Function)
    );
  });

  it("does nothing without a macOS window controls overlay", () => {
    const report = vi.fn();
    expect(installRuntimeTitlebarHeightReporter("darwin", {}, report)).toBeUndefined();
    expect(installRuntimeTitlebarHeightReporter(
      "win32",
      { windowControlsOverlay: {} as RuntimeWindowControlsOverlay },
      report
    )).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it("ignores transient geometry read failures", () => {
    const overlay = {
      addEventListener: vi.fn(),
      getTitlebarAreaRect: vi.fn(() => {
        throw new Error("geometry unavailable");
      }),
      removeEventListener: vi.fn()
    } as unknown as RuntimeWindowControlsOverlay;
    const report = vi.fn();

    expect(() => installRuntimeTitlebarHeightReporter(
      "darwin",
      { windowControlsOverlay: overlay },
      report
    )).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
});
