import { describe, expect, it } from "vitest";

import { createWorkspaceDisplayInfos } from "../src/main/workspaces/workspaceDisplays";

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
