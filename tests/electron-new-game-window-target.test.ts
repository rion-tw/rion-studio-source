import { describe, expect, it } from "vitest";

import { resolveElectronNewGameWindowTarget } from
  "../src/electron/main/electronNewGameWindowTarget";

const display = {
  id: 42,
  label: "Main",
  bounds: { x: 0, y: 0, width: 1600, height: 1000 },
  workArea: { x: 0, y: 24, width: 1600, height: 976 },
  resolution: { width: 3200, height: 2000 },
  scaleFactor: 2,
  isPrimary: true,
  isInternal: true
};

describe("Electron New Game Window target", () => {
  it("matches retained v22 80-percent sizing and per-display cascade", () => {
    const result = resolveElectronNewGameWindowTarget({
      createWindowId: () => "window-new",
      gameWindows: [
        { targetDisplay: { id: 42 } },
        { targetDisplay: { id: 42 } },
        { targetDisplay: { id: 7 } }
      ] as never,
      nativeDisplay: {
        id: 42,
        scaleFactor: 2,
        workArea: display.workArea
      },
      topology: {
        revision: 3,
        capturedAt: "2026-08-31T00:00:00.000Z",
        cause: "test",
        displays: [display]
      }
    });

    expect(result).toEqual({
      windowId: "window-new",
      displayId: 42,
      scaleFactor: 2,
      workArea: display.workArea,
      bounds: {
        x: 208,
        y: 169,
        width: 1280,
        height: 781
      },
      presentation: "normal"
    });
  });

  it("fails closed when Electron screen and the revisioned topology disagree", () => {
    expect(() => resolveElectronNewGameWindowTarget({
      createWindowId: () => "window-new",
      gameWindows: [],
      nativeDisplay: {
        id: 42,
        scaleFactor: 1,
        workArea: display.workArea
      },
      topology: {
        revision: 3,
        capturedAt: "2026-08-31T00:00:00.000Z",
        cause: "test",
        displays: [display]
      }
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_APPLICATION_SHORTCUT_DISPLAY_STALE"
    }));
  });
});
