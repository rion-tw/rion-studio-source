import { describe, expect, it, vi } from "vitest";
import { appKitDisplays } from "../src/electron/main/macosAppKitDisplayResolver";
import { projectElectronDisplayTopology, type ElectronDisplayDescriptor } from
  "../src/electron/main/appSnapshotProjection";

function descriptor(): ElectronDisplayDescriptor {
  return { id: 7, label: "  Retina Display  ",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    workArea: { x: 0, y: 24, width: 1280, height: 696 },
    size: { width: 1280, height: 720 }, scaleFactor: 2, internal: true };
}
const windowBounds = { x: 40, y: 40, width: 960, height: 640 };

describe("current native AppKit display observation", () => {
  it("uses canonical display labels and Electron size without scaling the resolution", () => {
    const display = descriptor();
    const getDisplayMatching = vi.fn(() => display);
    const resolver = appKitDisplays({ getDisplayMatching, getPrimaryDisplay: () => ({ id: 7 }) });
    const current = resolver.displayMatching(windowBounds);
    const topology = projectElectronDisplayTopology({ displays: [display], primaryDisplayId: 7,
      revision: 1, capturedAt: "2026-10-15T02:00:00Z", cause: "test-native-display" });
    expect(current).toEqual(topology.displays[0]);
    expect(current.label).toBe("Retina Display");
    expect(current.resolution).toEqual({ width: 1280, height: 720 });
    expect(current.isPrimary).toBe(true);
    expect(getDisplayMatching).toHaveBeenCalledExactlyOnceWith(windowBounds);
    display.bounds.x = 20;
    display.size.width = 2000;
    expect(current.bounds.x).toBe(0);
    expect(current.resolution.width).toBe(1280);
  });

  it("captures changed metadata and primary ownership even when the display ID is unchanged", () => {
    let display = descriptor(), primaryId = 7;
    const resolver = appKitDisplays({ getDisplayMatching: () => display,
      getPrimaryDisplay: () => ({ id: primaryId }) });
    const before = resolver.displayMatching(windowBounds);
    display = { ...display, label: " ", scaleFactor: 1, internal: false,
      workArea: { x: 0, y: 32, width: 1280, height: 688 }, size: { width: 1440, height: 900 } };
    primaryId = 9;
    const after = resolver.displayMatching(windowBounds);
    expect(after).toMatchObject({ id: 7, label: "Display 7", scaleFactor: 1,
      isPrimary: false, isInternal: false, workArea: display.workArea,
      resolution: { width: 1440, height: 900 } });
    expect(before).toMatchObject({ label: "Retina Display", scaleFactor: 2, isPrimary: true });
  });

  it.each(["display-id", "primary-id", "scale", "bounds", "work-area", "size"] as const)(
    "rejects invalid current native %s instead of reusing saved metadata", field => {
      const display = descriptor();
      let primaryId = 7;
      if (field === "display-id") display.id = Number.NaN;
      if (field === "primary-id") primaryId = Number.NaN;
      if (field === "scale") display.scaleFactor = 0;
      if (field === "bounds") display.bounds.x = Number.NaN;
      if (field === "work-area") display.workArea.width = Number.NaN;
      if (field === "size") display.size.width = Number.NaN;
      const resolver = appKitDisplays({ getDisplayMatching: () => display,
        getPrimaryDisplay: () => ({ id: primaryId }) });
      expect(() => resolver.displayMatching(windowBounds)).toThrow();
    }
  );

  it("preserves native matching failure without another lookup or fallback", () => {
    const failure = new Error("Native display retired");
    const getDisplayMatching = vi.fn(() => { throw failure; });
    const getPrimaryDisplay = vi.fn(() => ({ id: 7 }));
    const resolver = appKitDisplays({ getDisplayMatching, getPrimaryDisplay });
    expect(() => resolver.displayMatching(windowBounds)).toThrow(failure);
    expect(getDisplayMatching).toHaveBeenCalledTimes(1);
    expect(getPrimaryDisplay).not.toHaveBeenCalled();
  });
});
