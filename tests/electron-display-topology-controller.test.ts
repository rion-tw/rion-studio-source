import { describe, expect, it, vi } from "vitest";

import {
  ElectronDisplayTopologyController,
  type ElectronDisplayInventorySnapshot
} from "../src/electron/main/electronDisplayTopologyController";
import type { ElectronDisplayDescriptor } from
  "../src/electron/main/appSnapshotProjection";

function display(
  id: number,
  overrides: Partial<ElectronDisplayDescriptor> = {}
): ElectronDisplayDescriptor {
  return {
    id,
    label: `Display ${id}`,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 876 },
    size: { width: 2880, height: 1800 },
    scaleFactor: 2,
    internal: id === 41,
    ...overrides
  };
}

describe("Electron display-topology semantic revision", () => {
  it("replays one immutable revision for normalized-equivalent native captures", () => {
    let inventory: ElectronDisplayInventorySnapshot = {
      primaryDisplayId: 41,
      displays: [
        display(41, {
          label: "  Built-in Display  ",
          bounds: { x: 0.1, y: 0.1, width: 1439.9, height: 900.1 }
        }),
        display(99, {
          bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
          workArea: { x: 1440, y: 0, width: 1920, height: 1040 },
          size: { width: 1920, height: 1080 },
          scaleFactor: 1,
          internal: false
        })
      ]
    };
    let clock = 0;
    const controller = new ElectronDisplayTopologyController({
      capture: () => inventory,
      now: () => `2026-08-30T00:00:0${clock++}.000Z`
    });

    const initial = controller.refresh("electron-initial");
    expect(initial).toMatchObject({
      revision: 1,
      cause: "electron-initial",
      capturedAt: "2026-08-30T00:00:00.000Z",
      primaryDisplayId: "41"
    });
    expect(initial.displays.map((item) => item.id)).toEqual([41, 99]);
    expect(initial.displays[0]?.label).toBe("Built-in Display");
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.displays)).toBe(true);

    inventory = {
      primaryDisplayId: 41,
      displays: [
        inventory.displays[1]!,
        display(41, {
          label: "Built-in Display",
          bounds: { x: 0.4, y: 0.4, width: 1440.4, height: 899.6 }
        })
      ]
    };
    const replay = controller.refresh("screen-display-metrics-changed");
    expect(replay).toBe(initial);
    expect(replay.revision).toBe(1);
    expect(replay.cause).toBe("electron-initial");
    expect(controller.snapshot()).toBe(initial);
  });

  it("advances only for real work-area, scale, or primary-display changes", () => {
    let inventory: ElectronDisplayInventorySnapshot = {
      primaryDisplayId: 41,
      displays: [display(41), display(99, { internal: false })]
    };
    const controller = new ElectronDisplayTopologyController({
      capture: () => inventory,
      now: () => "2026-08-30T01:00:00.000Z"
    });

    expect(controller.refresh("electron-initial").revision).toBe(1);
    inventory = {
      ...inventory,
      displays: [
        display(41, { workArea: { x: 0, y: 30, width: 1440, height: 870 } }),
        inventory.displays[1]!
      ]
    };
    expect(controller.refresh("screen-display-metrics-changed")).toMatchObject({
      revision: 2,
      cause: "screen-display-metrics-changed"
    });

    inventory = {
      ...inventory,
      displays: [
        display(41, {
          workArea: { x: 0, y: 30, width: 1440, height: 870 },
          scaleFactor: 1.5
        }),
        inventory.displays[1]!
      ]
    };
    expect(controller.refresh("screen-display-metrics-changed").revision).toBe(3);

    inventory = { ...inventory, primaryDisplayId: 99 };
    const primaryChanged = controller.refresh("screen-display-added");
    expect(primaryChanged.revision).toBe(4);
    expect(primaryChanged.primaryDisplayId).toBe("99");
    expect(primaryChanged.displays.find((item) => item.id === 99)?.isPrimary).toBe(true);
  });

  it("bounds the captured display array before publication", () => {
    const controller = new ElectronDisplayTopologyController({
      capture: () => ({
        primaryDisplayId: 1,
        displays: Array.from({ length: 65 }, (_, index) => display(index + 1))
      })
    });

    expect(() => controller.refresh("electron-initial")).toThrowError(
      expect.objectContaining({ code: "ELECTRON_DISPLAY_TOPOLOGY_REVISION_INVALID" })
    );
  });

  it("publishes only semantic revisions with listener isolation and unsubscribe", () => {
    let inventory: ElectronDisplayInventorySnapshot = {
      primaryDisplayId: 41,
      displays: [display(41)]
    };
    const listenerError = vi.fn();
    const first = vi.fn(() => {
      throw new Error("listener failed");
    });
    const second = vi.fn();
    const controller = new ElectronDisplayTopologyController({
      capture: () => inventory,
      onListenerError: listenerError,
      now: () => "2026-08-30T02:00:00.000Z"
    });
    controller.refresh("electron-initial");
    controller.onChanged(first);
    const unsubscribe = controller.onChanged(second);

    expect(controller.refresh("screen-display-metrics-changed").revision).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    inventory = {
      ...inventory,
      displays: [display(41, {
        workArea: { x: 0, y: 28, width: 1440, height: 872 }
      })]
    };
    const changed = controller.refresh("screen-display-metrics-changed");
    expect(first).toHaveBeenCalledWith(changed);
    expect(second).toHaveBeenCalledWith(changed);
    expect(listenerError).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    inventory = {
      ...inventory,
      displays: [display(41, {
        workArea: { x: 0, y: 32, width: 1440, height: 868 }
      })]
    };
    controller.refresh("screen-display-metrics-changed");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("disposes listeners and rejects later capture or subscription", () => {
    let inventory: ElectronDisplayInventorySnapshot = {
      primaryDisplayId: 41,
      displays: [display(41)]
    };
    const listener = vi.fn();
    const controller = new ElectronDisplayTopologyController({
      capture: () => inventory
    });
    controller.refresh("electron-initial");
    controller.onChanged(listener);
    controller.dispose();
    controller.dispose();
    inventory = {
      ...inventory,
      displays: [display(41, { scaleFactor: 1.5 })]
    };

    expect(() => controller.refresh("screen-display-metrics-changed"))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_DISPLAY_TOPOLOGY_REVISION_INVALID"
      }));
    expect(() => controller.onChanged(listener)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_DISPLAY_TOPOLOGY_REVISION_INVALID" })
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
