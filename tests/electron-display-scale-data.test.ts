import { describe, expect, it } from "vitest";

import { ElectronDisplayTopologyController } from
  "../src/electron/main/electronDisplayTopologyController";
import type { ElectronDisplayDescriptor } from
  "../src/electron/main/appSnapshotProjection";
import { resolveElectronNewGameWindowTarget } from
  "../src/electron/main/electronNewGameWindowTarget";

// Synthetic data coverage, not evidence of OS DPI events or physical displays.
function inventory(platform: "macos" | "windows", scaleFactor: number) {
  const secondary: ElectronDisplayDescriptor = {
    id: 3,
    label: "Secondary",
    bounds: { x: -1920, y: -1080, width: 1920, height: 1080 },
    workArea: platform === "macos"
      ? { x: -1920, y: -1056, width: 1920, height: 1026 }
      : { x: -1920, y: -1080, width: 1920, height: 1040 },
    size: { width: 1920, height: 1080 },
    scaleFactor,
    internal: false
  };
  return {
    primaryDisplayId: 2,
    displays: [{
      ...secondary,
      id: 2,
      label: "Primary",
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1410 },
      size: { width: 2560, height: 1440 },
      scaleFactor: 2
    }, secondary]
  };
}

describe.each(["macos", "windows"] as const)("%s display-scale data", platform => {
  it.each([1, 1.25, 1.5, 1.75, 2, 3])(
    "preserves negative logical coordinates at scale %s without double scaling",
    scaleFactor => {
      const captured = inventory(platform, scaleFactor);
      const controller = new ElectronDisplayTopologyController({ capture: () => captured });
      const topology = controller.snapshot();
      const secondary = topology.displays.find(display => display.id === 3)!;
      expect(secondary.bounds).toEqual({ x: -1920, y: -1080, width: 1920, height: 1080 });
      expect(secondary.workArea).toEqual(captured.displays[1]!.workArea);
      expect(secondary.scaleFactor).toBe(scaleFactor);

      const target = resolveElectronNewGameWindowTarget({
        createWindowId: () => "scale-data-window",
        gameWindows: [],
        nativeDisplay: { id: 3, scaleFactor, workArea: secondary.workArea },
        topology
      });
      expect(target).toMatchObject({
        displayId: 3, scaleFactor, workArea: secondary.workArea, presentation: "normal"
      });
      expect(target.bounds).toEqual(platform === "macos"
        ? { x: -1728, y: -954, width: 1536, height: 821 }
        : { x: -1728, y: -976, width: 1536, height: 832 });
    }
  );

  it("fences a stale native scale and returns to the original logical placement", () => {
    let captured = inventory(platform, 2);
    const controller = new ElectronDisplayTopologyController({ capture: () => captured });
    const initial = controller.snapshot();
    const nativeDisplay = {
      id: 3, scaleFactor: 2, workArea: initial.displays[1]!.workArea
    };
    const input = { createWindowId: () => "scale-data-window", gameWindows: [], nativeDisplay };
    const initialTarget = resolveElectronNewGameWindowTarget({ ...input, topology: initial });

    // Real screen events drive refresh in production; this test supplies data directly.
    for (const [index, scaleFactor] of [1.25, 1.5, 1, 3, 2].entries()) {
      captured = inventory(platform, scaleFactor);
      const topology = controller.refresh("screen-display-metrics-changed");
      expect(topology.revision).toBe(index + 2);
      if (scaleFactor !== 2) {
        expect(() => resolveElectronNewGameWindowTarget({ ...input, topology }))
          .toThrowError(expect.objectContaining({ code: "ELECTRON_APPLICATION_SHORTCUT_DISPLAY_STALE" }));
      }
      const target = resolveElectronNewGameWindowTarget({
        ...input, nativeDisplay: { ...nativeDisplay, scaleFactor }, topology
      });
      expect(target.bounds).toEqual(initialTarget.bounds);
      expect(target.workArea).toEqual(initialTarget.workArea);
      expect(target.scaleFactor).toBe(scaleFactor);
      expect(controller.refresh("screen-display-metrics-changed")).toBe(topology);
    }
    expect(initial.revision).toBe(1);
    expect(initial.displays[1]!.scaleFactor).toBe(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid scale %s without replacing the last valid topology",
    scaleFactor => {
      let captured = inventory(platform, 2);
      const controller = new ElectronDisplayTopologyController({ capture: () => captured });
      const initial = controller.snapshot();
      captured = inventory(platform, scaleFactor);
      expect(() => controller.refresh("screen-display-metrics-changed"))
        .toThrowError(expect.objectContaining({ code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID" }));
      expect(controller.snapshot()).toBe(initial);
    }
  );
});
