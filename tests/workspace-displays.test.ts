import { describe, expect, it } from "vitest";

import { createWorkspaceDisplayInfos } from "../src/main/workspaces/workspaceDisplays";

describe("workspace display inventory", () => {
  it("normalizes, filters, and spatially sorts Electron displays", () => {
    const displays = createWorkspaceDisplayInfos(
      [
        display(22, " Side ", { x: 1200, y: 0, width: 1920, height: 1080 }, false),
        display(-1, "Invalid", { x: 0, y: 0, width: 1, height: 1 }, false),
        display(11, "Built-in", { x: 0, y: 0, width: 1200, height: 800 }, true),
        display(33, "Upper", { x: 0, y: -900, width: 1200, height: 900 }, false)
      ],
      11
    );

    expect(displays.map((item) => item.id)).toEqual([33, 11, 22]);
    expect(displays[1]).toMatchObject({
      id: 11,
      label: "Built-in",
      isPrimary: true,
      isInternal: true,
      scaleFactor: 2,
      workArea: { x: 0, y: 24, width: 1200, height: 776 }
    });
    expect(displays[2].label).toBe("Side");
  });
});

function display(
  id: number,
  label: string,
  bounds: { x: number; y: number; width: number; height: number },
  internal: boolean
) {
  return {
    id,
    label,
    bounds,
    workArea: { ...bounds, y: bounds.y + 24, height: Math.max(1, bounds.height - 24) },
    scaleFactor: 2,
    internal
  } as Electron.Display;
}
