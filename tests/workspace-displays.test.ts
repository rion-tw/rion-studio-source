import { describe, expect, it } from "vitest";

import { createWorkspaceDisplayInfos } from "../src/main/workspaces/workspaceDisplays";
import type { WorkspaceDisplayInfo } from "../src/shared/types";
import {
  createWorkspaceDisplayTarget,
  resolveWorkspaceDisplayTarget
} from "../src/shared/workspaceDisplays";

describe("workspace display inventory", () => {
  it("normalizes, filters, and spatially sorts displays using DIP topology", () => {
    const displays = createWorkspaceDisplayInfos(
      [
        display(4_294_967_294, " Side ", { x: 1200, y: 0, width: 1536, height: 864 }, false, 1.25),
        display(-1, "Invalid", { x: 0, y: 0, width: 1, height: 1 }, false),
        display(11, "Built-in", { x: 0, y: 0, width: 1200, height: 800 }, true),
        display(-22, "Upper", { x: 0, y: -900, width: 1200, height: 900 }, false)
      ],
      11
    );

    expect(displays.map((item) => item.id)).toEqual([-22, 11, 4_294_967_294]);
    expect(displays[1]).toMatchObject({
      id: 11,
      label: "Built-in",
      isPrimary: true,
      isInternal: true,
      scaleFactor: 2,
      resolution: { width: 2400, height: 1600 },
      workArea: { x: 0, y: 24, width: 1200, height: 776 }
    });
    expect(displays[2].label).toBe("Side");
    expect(displays[2]).toMatchObject({
      bounds: { x: 1200, y: 0, width: 1536, height: 864 },
      resolution: { width: 1920, height: 1080 },
      scaleFactor: 1.25
    });
  });

  it("preserves Windows work-area offsets and negative coordinates without physical-pixel conversion", () => {
    const displays = createWorkspaceDisplayInfos(
      [
        display(
          90,
          "Left",
          { x: -1280, y: -120, width: 1280, height: 1024 },
          false,
          1.5,
          { x: -1240, y: -120, width: 1240, height: 984 }
        ),
        display(
          91,
          "Primary",
          { x: 0, y: 0, width: 1920, height: 1080 },
          false,
          1,
          { x: 0, y: 0, width: 1920, height: 1040 }
        )
      ],
      91
    );

    expect(displays[0]).toMatchObject({
      id: 90,
      bounds: { x: -1280, y: -120, width: 1280, height: 1024 },
      workArea: { x: -1240, y: -120, width: 1240, height: 984 },
      resolution: { width: 1920, height: 1536 }
    });
  });
});

describe("workspace display targets", () => {
  it("rebinds a changed Windows runtime id by exact desktop fingerprint instead of a recycled id", () => {
    const selected = workspaceDisplay(1493485485, 2560);
    const target = createWorkspaceDisplayTarget(selected);
    const recycledIdOnWrongDisplay = workspaceDisplay(1493485485, 0, true);
    const sameDesktopPosition = workspaceDisplay(4_294_967_294, 2560);

    expect(resolveWorkspaceDisplayTarget(target, [recycledIdOnWrongDisplay, sameDesktopPosition]))
      .toEqual(sameDesktopPosition);
  });

  it("distinguishes identical monitor models by desktop position", () => {
    const target = createWorkspaceDisplayTarget(workspaceDisplay(22, -2560));
    const displays = [
      workspaceDisplay(31, 0, true),
      workspaceDisplay(32, 2560),
      workspaceDisplay(-22, -2560)
    ];

    expect(resolveWorkspaceDisplayTarget(target, displays)?.id).toBe(-22);
  });

  it("refuses ambiguous mirrored displays and changed display metrics", () => {
    const selected = workspaceDisplay(22, 2560);
    const target = createWorkspaceDisplayTarget(selected);
    const duplicate = { ...selected, id: 33 };
    const changedResolution = {
      ...selected,
      id: 44,
      resolution: { width: 1920, height: 1080 }
    };

    expect(resolveWorkspaceDisplayTarget(target, [selected, duplicate])).toBeUndefined();
    expect(resolveWorkspaceDisplayTarget(target, [changedResolution])).toBeUndefined();
  });

  it("keeps legacy id-only targets compatible without guessing", () => {
    const current = workspaceDisplay(22, 0, true);

    expect(resolveWorkspaceDisplayTarget({ id: 22 }, [current])).toEqual(current);
    expect(resolveWorkspaceDisplayTarget({ id: 99 }, [current])).toBeUndefined();
  });
});

function display(
  id: number,
  label: string,
  bounds: { x: number; y: number; width: number; height: number },
  internal: boolean,
  scaleFactor = 2,
  workArea = { ...bounds, y: bounds.y + 24, height: Math.max(1, bounds.height - 24) }
) {
  return {
    id,
    label,
    bounds,
    workArea,
    scaleFactor,
    internal
  } as Electron.Display;
}

function workspaceDisplay(id: number, x: number, isPrimary = false): WorkspaceDisplayInfo {
  return {
    id,
    label: "Q27G4Z",
    bounds: { x, y: 0, width: 2560, height: 1440 },
    workArea: { x, y: 0, width: 2560, height: 1400 },
    resolution: { width: 2560, height: 1440 },
    scaleFactor: 1,
    isPrimary,
    isInternal: false
  };
}
