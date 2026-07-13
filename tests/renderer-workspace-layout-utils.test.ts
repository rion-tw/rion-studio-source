import { describe, expect, it } from "vitest";

import type { LaunchWorkspaceSlot } from "../src/shared/types";
import {
  getDefaultWorkspaceBrowserZoomPercent,
  getDefaultWorkspaceRects
} from "../src/shared/workspaceLayout";
import {
  applyWorkspaceSplits,
  applyWorkspaceTemplate,
  assignRoleToWorkspaceSlot,
  createWorkspaceFormState,
  getWorkspaceSplitRange,
  getWorkspaceSplits,
  readRoleDragId,
  readWorkspaceSlotDragIndex,
  swapWorkspaceSlotRoles
} from "../src/renderer/src/features/workspaces/workspaceLayoutUtils";

describe("renderer workspace layout helpers", () => {
  it("uses compact-layout browser zoom defaults", () => {
    expect(getDefaultWorkspaceBrowserZoomPercent("three_columns")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("quad")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("four_columns")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("six_grid")).toBe(80);
    expect(getDefaultWorkspaceBrowserZoomPercent("two_columns")).toBe(100);
    expect(getDefaultWorkspaceBrowserZoomPercent("main_left_stack_right")).toBe(100);
    expect(getDefaultWorkspaceBrowserZoomPercent("main_right_stack_left")).toBe(100);
  });

  it("loads the saved browser zoom into the workspace form", () => {
    expect(
      createWorkspaceFormState({
        id: "workspace-1",
        name: "Party",
        template: "three_columns",
        browserZoomPercent: 125,
        slots: applyWorkspaceTemplate([], "three_columns"),
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      })
    ).toMatchObject({ browserZoomPercent: 125, template: "three_columns" });
  });

  it("applies a template while preserving slot ids and assigned roles by index", () => {
    expect(
      applyWorkspaceTemplate(
        [
          slot("custom-1", "p1"),
          slot("custom-2", "p2"),
          slot("custom-3", "p3")
        ],
        "two_columns"
      )
    ).toEqual([
      { id: "custom-1", roleId: "p1", rect: getDefaultWorkspaceRects("two_columns")[0] },
      { id: "custom-2", roleId: "p2", rect: getDefaultWorkspaceRects("two_columns")[1] }
    ]);
  });

  it("creates stable slot ids when applying a template to empty slots", () => {
    expect(applyWorkspaceTemplate([], "main_left_stack_right")).toEqual([
      { id: "slot-1", rect: getDefaultWorkspaceRects("main_left_stack_right")[0] },
      { id: "slot-2", rect: getDefaultWorkspaceRects("main_left_stack_right")[1] },
      { id: "slot-3", rect: getDefaultWorkspaceRects("main_left_stack_right")[2] }
    ]);
    expect(applyWorkspaceTemplate([], "main_right_stack_left")).toEqual([
      { id: "slot-1", rect: getDefaultWorkspaceRects("main_right_stack_left")[0] },
      { id: "slot-2", rect: getDefaultWorkspaceRects("main_right_stack_left")[1] },
      { id: "slot-3", rect: getDefaultWorkspaceRects("main_right_stack_left")[2] }
    ]);
  });

  it("assigns a role to one slot and clears duplicate assignments", () => {
    expect(assignRoleToWorkspaceSlot([slot("slot-1", "p1"), slot("slot-2", "p2")], 1, "p1")).toEqual([
      { ...slot("slot-1"), roleId: undefined },
      slot("slot-2", "p1")
    ]);
  });

  it("swaps roles between slots", () => {
    expect(swapWorkspaceSlotRoles([slot("slot-1", "p1"), slot("slot-2")], 0, 1)).toEqual([
      { ...slot("slot-1"), roleId: undefined },
      slot("slot-2", "p1")
    ]);
  });

  it("does not misread a dragged role as slot zero", () => {
    const event = dragEvent({
      "application/x-rion-role": "role-1",
      "text/plain": "role:role-1"
    });

    expect(readWorkspaceSlotDragIndex(event)).toBeUndefined();
    expect(readRoleDragId(event)).toBe("role-1");
  });

  it("reads a dragged workspace slot index", () => {
    expect(
      readWorkspaceSlotDragIndex(
        dragEvent({
          "application/x-rion-workspace-slot": "2",
          "text/plain": "slot:2"
        })
      )
    ).toBe(2);
  });

  it("reads and applies custom split positions", () => {
    const slots = applyWorkspaceSplits("quad", applyWorkspaceTemplate([], "quad"), {
      horizontal: [0.7],
      vertical: [0.3]
    });

    expect(getWorkspaceSplits("quad", slots)).toEqual({ horizontal: [0.7], vertical: [0.3] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.3, height: 0.7 },
      { x: 0.3, y: 0, width: 0.7, height: 0.7 },
      { x: 0, y: 0.7, width: 0.3, height: 0.30000000000000004 },
      { x: 0.3, y: 0.7, width: 0.7, height: 0.30000000000000004 }
    ]);
  });

  it("reads and applies right-main left-stack split positions", () => {
    const initialSlots = applyWorkspaceTemplate([], "main_right_stack_left");
    const slots = applyWorkspaceSplits("main_right_stack_left", initialSlots, {
      horizontal: [0.65],
      vertical: [0.35]
    });

    expect(getWorkspaceSplits("main_right_stack_left", slots)).toEqual({ horizontal: [0.65], vertical: [0.35] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0.35, y: 0, width: 0.65, height: 1 },
      { x: 0, y: 0, width: 0.35, height: 0.65 },
      { x: 0, y: 0.65, width: 0.35, height: 0.35 }
    ]);
  });

  it("adjusts one three-column divider while preserving the other boundary", () => {
    const initialSlots = applyWorkspaceTemplate([], "three_columns");
    const initialSplits = getWorkspaceSplits("three_columns", initialSlots);
    const slots = applyWorkspaceSplits("three_columns", initialSlots, {
      ...initialSplits,
      vertical: [0.45, 2 / 3]
    });

    expect(initialSplits).toEqual({ horizontal: [], vertical: [1 / 3, 2 / 3] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.45, height: 1 },
      { x: 0.45, y: 0, width: 2 / 3 - 0.45, height: 1 },
      { x: 2 / 3, y: 0, width: 1 - 2 / 3, height: 1 }
    ]);
    expect(getWorkspaceSplitRange("three_columns", initialSplits, "vertical", 0)).toEqual({
      min: 0.12,
      max: 2 / 3 - 0.12
    });
  });

  it("adjusts one four-column divider while preserving the other boundaries", () => {
    const initialSlots = applyWorkspaceTemplate([], "four_columns");
    const initialSplits = getWorkspaceSplits("four_columns", initialSlots);
    const slots = applyWorkspaceSplits("four_columns", initialSlots, {
      ...initialSplits,
      vertical: [0.25, 0.62, 0.75]
    });

    expect(initialSplits).toEqual({ horizontal: [], vertical: [0.25, 0.5, 0.75] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 1 },
      { x: 0.25, y: 0, width: 0.37, height: 1 },
      { x: 0.62, y: 0, width: 0.13, height: 1 },
      { x: 0.75, y: 0, width: 0.25, height: 1 }
    ]);
    expect(getWorkspaceSplitRange("four_columns", initialSplits, "vertical", 1)).toEqual({
      min: 0.37,
      max: 0.63
    });
  });

  it("adjusts linked columns and rows in a six-grid workspace", () => {
    const initialSlots = applyWorkspaceTemplate([], "six_grid");
    const initialSplits = getWorkspaceSplits("six_grid", initialSlots);
    const slots = applyWorkspaceSplits("six_grid", initialSlots, {
      horizontal: [0.6],
      vertical: [0.25, 0.7]
    });

    expect(initialSplits).toEqual({ horizontal: [0.5], vertical: [1 / 3, 2 / 3] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 0.6 },
      { x: 0.25, y: 0, width: 0.44999999999999996, height: 0.6 },
      { x: 0.7, y: 0, width: 0.30000000000000004, height: 0.6 },
      { x: 0, y: 0.6, width: 0.25, height: 0.4 },
      { x: 0.25, y: 0.6, width: 0.44999999999999996, height: 0.4 },
      { x: 0.7, y: 0.6, width: 0.30000000000000004, height: 0.4 }
    ]);
    expect(getWorkspaceSplits("six_grid", slots)).toEqual({
      horizontal: [0.6],
      vertical: [0.25, 0.7]
    });
    expect(getWorkspaceSplitRange("six_grid", initialSplits, "horizontal", 0)).toEqual({
      min: 0.2,
      max: 0.8
    });
  });
});

function slot(id: string, roleId?: string): LaunchWorkspaceSlot {
  return {
    id,
    ...(roleId ? { roleId } : {}),
    rect: { x: 0, y: 0, width: 1, height: 1 }
  };
}

function dragEvent(
  values: Record<string, string>
): Parameters<typeof readWorkspaceSlotDragIndex>[0] {
  return {
    dataTransfer: {
      getData: (type: string) => values[type] ?? ""
    }
  } as Parameters<typeof readWorkspaceSlotDragIndex>[0];
}
