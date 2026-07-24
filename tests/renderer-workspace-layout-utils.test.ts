import { describe, expect, it } from "vitest";

import type { LaunchWorkspaceSlot, Role } from "../src/shared/types";
import {
  getDefaultWorkspaceBrowserZoomPercent,
  getDefaultWorkspaceRects,
  isWorkspaceBrowserZoomPercent,
  workspaceBrowserZoomPercents
} from "../src/shared/workspaceLayout";
import {
  applyWorkspaceSplits,
  applyWorkspaceTemplate,
  assignRoleToWorkspaceSlot,
  createWorkspaceFormState,
  createWorkspaceSlotBackground,
  getWorkspaceHorizontalResizeHandles,
  getWorkspaceResizeAffectedSlotIndexes,
  getWorkspaceSplitRange,
  getWorkspaceSplits,
  getWorkspaceVerticalResizeHandles,
  readRoleDragId,
  readWorkspaceSlotDragIndex,
  swapWorkspaceSlotRoles
} from "../src/renderer/src/features/workspaces/workspaceLayoutUtils";
import {
  DEFAULT_ROLE_COVER_COLOR,
  roleCoverPlaceholderUrl
} from "../src/renderer/src/app/roleCoverPlaceholder";

describe("renderer workspace layout helpers", () => {
  it("uses the default cover placeholder only for assigned roles without a cover", () => {
    expect(createWorkspaceSlotBackground(undefined)).toBeUndefined();
    expect(createWorkspaceSlotBackground(role())).toEqual({
      backgroundColor: DEFAULT_ROLE_COVER_COLOR,
      backgroundImage: `url("${roleCoverPlaceholderUrl}")`
    });
  });

  it("prefers an uploaded role cover and dominant color", () => {
    expect(
      createWorkspaceSlotBackground(
        role({ coverImageDataUrl: "data:image/png;base64,AAAA", coverImageDominantColor: "#123456" })
      )
    ).toEqual({
      backgroundColor: "#123456",
      backgroundImage: 'url("data:image/png;base64,AAAA")'
    });
  });

  it("uses compact-layout browser zoom defaults", () => {
    expect(getDefaultWorkspaceBrowserZoomPercent("eight_grid")).toBe(75);
    expect(getDefaultWorkspaceBrowserZoomPercent("three_columns")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("quad")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("four_columns")).toBe(90);
    expect(getDefaultWorkspaceBrowserZoomPercent("six_grid")).toBe(80);
    expect(getDefaultWorkspaceBrowserZoomPercent("main_center_side_stacks")).toBe(80);
    expect(getDefaultWorkspaceBrowserZoomPercent("three_top_two_bottom")).toBe(80);
    expect(getDefaultWorkspaceBrowserZoomPercent("two_top_three_bottom")).toBe(80);
    expect(getDefaultWorkspaceBrowserZoomPercent("two_columns")).toBe(100);
    expect(getDefaultWorkspaceBrowserZoomPercent("main_left_stack_right")).toBe(100);
    expect(getDefaultWorkspaceBrowserZoomPercent("main_right_stack_left")).toBe(100);
  });

  it("offers and validates every supported browser zoom percentage", () => {
    expect(workspaceBrowserZoomPercents).toEqual([25, 33, 50, 67, 75, 80, 90, 100, 110, 125]);
    expect(workspaceBrowserZoomPercents.every(isWorkspaceBrowserZoomPercent)).toBe(true);
    expect(isWorkspaceBrowserZoomPercent(34)).toBe(false);
  });

  it("loads the saved browser zoom into the workspace form", () => {
    expect(
      createWorkspaceFormState({
        id: "workspace-1",
        browserLaunchMode: "inherit",
        browserZoomMode: "fixed",
        name: "Party",
        template: "three_columns",
        browserZoomPercent: 125,
        targetDisplay: { id: 22 },
        slots: applyWorkspaceTemplate([], "three_columns"),
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      })
    ).toMatchObject({
      browserZoomMode: "fixed",
      browserZoomPercent: 125,
      targetDisplay: { id: 22 },
      template: "three_columns"
    });
  });

  it("preserves a saved single layout and its assigned role in the workspace form", () => {
    const slots: LaunchWorkspaceSlot[] = [{
      id: "slot-1",
      roleId: "role-1",
      browserZoomPercent: 110,
      rect: { x: 0, y: 0, width: 1, height: 1 }
    }];

    expect(createWorkspaceFormState({
      id: "workspace-1",
      browserLaunchMode: "inherit",
      browserZoomMode: "adaptive",
      name: "Solo",
      template: "single",
      browserZoomPercent: 100,
      slots,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    })).toMatchObject({
      template: "single",
      slots
    });
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

    const eightSlots = Array.from({ length: 8 }, (_value, index) => slot(`custom-${index + 1}`, `p${index + 1}`));
    expect(applyWorkspaceTemplate(eightSlots, "eight_grid").map((item) => item.roleId)).toEqual([
      "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"
    ]);

    expect(applyWorkspaceTemplate(eightSlots, "nine_grid").map((item) => item.roleId)).toEqual([
      "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", undefined
    ]);

    expect(applyWorkspaceTemplate([
      { ...slot("custom-1", "p1"), browserZoomPercent: 110 },
      { ...slot("custom-2", "p2"), browserZoomPercent: 90 }
    ], "single")).toEqual([
      {
        id: "custom-1",
        roleId: "p1",
        browserZoomPercent: 110,
        rect: getDefaultWorkspaceRects("single")[0]
      }
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
    expect(applyWorkspaceTemplate([], "main_center_side_stacks")).toEqual(
      getDefaultWorkspaceRects("main_center_side_stacks").map((rect, index) => ({
        id: `slot-${index + 1}`,
        rect
      }))
    );
    expect(applyWorkspaceTemplate([], "three_top_two_bottom")).toEqual(
      getDefaultWorkspaceRects("three_top_two_bottom").map((rect, index) => ({
        id: `slot-${index + 1}`,
        rect
      }))
    );
    expect(applyWorkspaceTemplate([], "two_top_three_bottom")).toEqual(
      getDefaultWorkspaceRects("two_top_three_bottom").map((rect, index) => ({
        id: `slot-${index + 1}`,
        rect
      }))
    );
  });

  it("assigns a role to one slot and clears duplicate assignments", () => {
    expect(assignRoleToWorkspaceSlot([slot("slot-1", "p1"), slot("slot-2", "p2")], 1, "p1")).toEqual([
      { ...slot("slot-1"), roleId: undefined },
      slot("slot-2", "p1")
    ]);
  });

  it("moves and clears browser zoom overrides with role assignments", () => {
    const slots: LaunchWorkspaceSlot[] = [
      { ...slot("slot-1", "p1"), browserZoomPercent: 110 },
      { ...slot("slot-2", "p2"), browserZoomPercent: 90 },
      slot("slot-3")
    ];

    expect(assignRoleToWorkspaceSlot(slots, 2, "p1")).toEqual([
      slot("slot-1"),
      { ...slot("slot-2", "p2"), browserZoomPercent: 90 },
      { ...slot("slot-3", "p1"), browserZoomPercent: 110 }
    ]);
    expect(assignRoleToWorkspaceSlot(slots, 0, undefined)[0]).toEqual(slot("slot-1"));
    expect(swapWorkspaceSlotRoles(slots, 0, 1)).toEqual([
      { ...slot("slot-1", "p2"), browserZoomPercent: 90 },
      { ...slot("slot-2", "p1"), browserZoomPercent: 110 },
      slot("slot-3")
    ]);
    expect(applyWorkspaceTemplate(slots, "two_columns")).toEqual([
      {
        id: "slot-1",
        roleId: "p1",
        browserZoomPercent: 110,
        rect: getDefaultWorkspaceRects("two_columns")[0]
      },
      {
        id: "slot-2",
        roleId: "p2",
        browserZoomPercent: 90,
        rect: getDefaultWorkspaceRects("two_columns")[1]
      }
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

  it("adjusts four linked columns and two linked rows in an eight-grid workspace", () => {
    const initialSlots = applyWorkspaceTemplate([], "eight_grid");
    const initialSplits = getWorkspaceSplits("eight_grid", initialSlots);
    const slots = applyWorkspaceSplits("eight_grid", initialSlots, {
      horizontal: [0.6],
      vertical: [0.2, 0.45, 0.8]
    });

    expect(initialSplits).toEqual({ horizontal: [0.5], vertical: [0.25, 0.5, 0.75] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.2, height: 0.6 },
      { x: 0.2, y: 0, width: 0.25, height: 0.6 },
      { x: 0.45, y: 0, width: 0.35000000000000003, height: 0.6 },
      { x: 0.8, y: 0, width: 0.19999999999999996, height: 0.6 },
      { x: 0, y: 0.6, width: 0.2, height: 0.4 },
      { x: 0.2, y: 0.6, width: 0.25, height: 0.4 },
      { x: 0.45, y: 0.6, width: 0.35000000000000003, height: 0.4 },
      { x: 0.8, y: 0.6, width: 0.19999999999999996, height: 0.4 }
    ]);
    expect(getWorkspaceSplits("eight_grid", slots)).toEqual({
      horizontal: [0.6],
      vertical: [0.2, 0.45, 0.8]
    });
    expect(getWorkspaceSplitRange("eight_grid", initialSplits, "vertical", 1)).toEqual({
      min: 0.37,
      max: 0.63
    });
    expect(getWorkspaceSplitRange("eight_grid", initialSplits, "horizontal", 0)).toEqual({
      min: 0.2,
      max: 0.8
    });
  });

  it("adjusts two horizontal and two vertical dividers in a nine-grid workspace", () => {
    const initialSlots = applyWorkspaceTemplate([], "nine_grid");
    const initialSplits = getWorkspaceSplits("nine_grid", initialSlots);
    const adjustedSplits = {
      horizontal: [0.4, 0.72],
      vertical: [0.2, 0.48]
    };
    const slots = applyWorkspaceSplits("nine_grid", initialSlots, adjustedSplits);

    expect(initialSlots).toHaveLength(9);
    expect(initialSplits).toEqual({ horizontal: [1 / 3, 2 / 3], vertical: [1 / 3, 2 / 3] });
    expect(slots).toHaveLength(9);
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.2, height: 0.4 },
      { x: 0.2, y: 0, width: 0.27999999999999997, height: 0.4 },
      { x: 0.48, y: 0, width: 0.52, height: 0.4 },
      { x: 0, y: 0.4, width: 0.2, height: 0.31999999999999995 },
      { x: 0.2, y: 0.4, width: 0.27999999999999997, height: 0.31999999999999995 },
      { x: 0.48, y: 0.4, width: 0.52, height: 0.31999999999999995 },
      { x: 0, y: 0.72, width: 0.2, height: 0.28 },
      { x: 0.2, y: 0.72, width: 0.27999999999999997, height: 0.28 },
      { x: 0.48, y: 0.72, width: 0.52, height: 0.28 }
    ]);
    expect(getWorkspaceSplits("nine_grid", slots)).toEqual(adjustedSplits);
    expect(getWorkspaceHorizontalResizeHandles("nine_grid", adjustedSplits)).toEqual([
      { splitIndex: 0, x: 0.5, y: 0.4 },
      { splitIndex: 1, x: 0.5, y: 0.72 }
    ]);
    expect(getWorkspaceVerticalResizeHandles("nine_grid", adjustedSplits)).toEqual([
      { splitIndex: 0, x: 0.2, y: 0.5 },
      { splitIndex: 1, x: 0.48, y: 0.5 }
    ]);
    expect(getWorkspaceResizeAffectedSlotIndexes("nine_grid", initialSlots, "horizontal", 0)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
    expect(getWorkspaceResizeAffectedSlotIndexes("nine_grid", initialSlots, "horizontal", 1)).toEqual([
      3, 4, 5, 6, 7, 8
    ]);
    expect(getWorkspaceResizeAffectedSlotIndexes("nine_grid", initialSlots, "vertical", 0)).toEqual([
      0, 1, 3, 4, 6, 7
    ]);
    expect(getWorkspaceSplitRange("nine_grid", initialSplits, "horizontal", 0)).toEqual({
      min: 0.2,
      max: 2 / 3 - 0.2
    });
  });

  it("adjusts three top columns independently from two bottom columns", () => {
    const template = "three_top_two_bottom";
    const initialSlots = applyWorkspaceTemplate([], template);
    const initialSplits = getWorkspaceSplits(template, initialSlots);
    const adjustedSplits = {
      horizontal: [0.6],
      vertical: [0.25, 0.7, 0.4]
    };
    const slots = applyWorkspaceSplits(template, initialSlots, adjustedSplits);

    expect(initialSplits).toEqual({ horizontal: [0.5], vertical: [1 / 3, 2 / 3, 0.5] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.25, height: 0.6 },
      { x: 0.25, y: 0, width: 0.7 - 0.25, height: 0.6 },
      { x: 0.7, y: 0, width: 1 - 0.7, height: 0.6 },
      { x: 0, y: 0.6, width: 0.4, height: 1 - 0.6 },
      { x: 0.4, y: 0.6, width: 1 - 0.4, height: 1 - 0.6 }
    ]);
    expect(getWorkspaceSplits(template, slots)).toEqual(adjustedSplits);
    expect(getWorkspaceSplitRange(template, initialSplits, "vertical", 0)).toEqual({
      min: 0.12,
      max: 2 / 3 - 0.12
    });
    expect(getWorkspaceSplitRange(template, initialSplits, "vertical", 2)).toEqual({
      min: 0.12,
      max: 0.88
    });
    expect(getWorkspaceVerticalResizeHandles(template, adjustedSplits)).toEqual([
      { splitIndex: 0, x: 0.25, y: 0.3 },
      { splitIndex: 1, x: 0.7, y: 0.3 },
      { splitIndex: 2, x: 0.4, y: 0.8 }
    ]);
  });

  it("adjusts two top columns independently from three bottom columns", () => {
    const template = "two_top_three_bottom";
    const initialSlots = applyWorkspaceTemplate([], template);
    const initialSplits = getWorkspaceSplits(template, initialSlots);
    const adjustedSplits = {
      horizontal: [0.4],
      vertical: [0.45, 0.2, 0.75]
    };
    const slots = applyWorkspaceSplits(template, initialSlots, adjustedSplits);

    expect(initialSplits).toEqual({ horizontal: [0.5], vertical: [0.5, 1 / 3, 2 / 3] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.45, height: 0.4 },
      { x: 0.45, y: 0, width: 1 - 0.45, height: 0.4 },
      { x: 0, y: 0.4, width: 0.2, height: 1 - 0.4 },
      { x: 0.2, y: 0.4, width: 0.75 - 0.2, height: 1 - 0.4 },
      { x: 0.75, y: 0.4, width: 1 - 0.75, height: 1 - 0.4 }
    ]);
    expect(getWorkspaceSplits(template, slots)).toEqual(adjustedSplits);
    expect(getWorkspaceSplitRange(template, initialSplits, "vertical", 0)).toEqual({
      min: 0.12,
      max: 0.88
    });
    expect(getWorkspaceSplitRange(template, initialSplits, "vertical", 1)).toEqual({
      min: 0.12,
      max: 2 / 3 - 0.12
    });
    expect(getWorkspaceVerticalResizeHandles(template, adjustedSplits)).toEqual([
      { splitIndex: 0, x: 0.45, y: 0.2 },
      { splitIndex: 1, x: 0.2, y: 0.7 },
      { splitIndex: 2, x: 0.75, y: 0.7 }
    ]);
  });

  it("identifies every slot affected by linked workspace dividers", () => {
    const twoColumns = applyWorkspaceTemplate([], "two_columns");
    expect(getWorkspaceResizeAffectedSlotIndexes("two_columns", twoColumns, "vertical", 0)).toEqual([0, 1]);

    const quad = applyWorkspaceTemplate([], "quad");
    expect(getWorkspaceResizeAffectedSlotIndexes("quad", quad, "vertical", 0)).toEqual([0, 1, 2, 3]);
    expect(getWorkspaceResizeAffectedSlotIndexes("quad", quad, "horizontal", 0)).toEqual([0, 1, 2, 3]);

    const sixGrid = applyWorkspaceTemplate([], "six_grid");
    expect(getWorkspaceResizeAffectedSlotIndexes("six_grid", sixGrid, "vertical", 0)).toEqual([0, 1, 3, 4]);

    const eightGrid = applyWorkspaceTemplate([], "eight_grid");
    expect(getWorkspaceResizeAffectedSlotIndexes("eight_grid", eightGrid, "vertical", 1)).toEqual([1, 2, 5, 6]);
  });

  it("limits indicators to the connected side stacks and mixed-layout rows", () => {
    const centered = applyWorkspaceTemplate([], "main_center_side_stacks");
    expect(getWorkspaceResizeAffectedSlotIndexes("main_center_side_stacks", centered, "vertical", 0)).toEqual([
      0,
      1,
      2
    ]);
    expect(getWorkspaceResizeAffectedSlotIndexes("main_center_side_stacks", centered, "horizontal", 0)).toEqual([
      1,
      2,
      3,
      4
    ]);

    const threeTop = applyWorkspaceTemplate([], "three_top_two_bottom");
    expect(getWorkspaceResizeAffectedSlotIndexes("three_top_two_bottom", threeTop, "vertical", 0)).toEqual([0, 1]);
    expect(getWorkspaceResizeAffectedSlotIndexes("three_top_two_bottom", threeTop, "vertical", 2)).toEqual([3, 4]);
    expect(getWorkspaceResizeAffectedSlotIndexes("three_top_two_bottom", threeTop, "horizontal", 0)).toEqual([
      0,
      1,
      2,
      3,
      4
    ]);

    const twoTop = applyWorkspaceTemplate([], "two_top_three_bottom");
    expect(getWorkspaceResizeAffectedSlotIndexes("two_top_three_bottom", twoTop, "vertical", 0)).toEqual([0, 1]);
    expect(getWorkspaceResizeAffectedSlotIndexes("two_top_three_bottom", twoTop, "vertical", 1)).toEqual([2, 3]);
  });

  it("adjusts side columns and linked rows around a centered main pane", () => {
    const initialSlots = applyWorkspaceTemplate([], "main_center_side_stacks");
    const initialSplits = getWorkspaceSplits("main_center_side_stacks", initialSlots);
    const slots = applyWorkspaceSplits("main_center_side_stacks", initialSlots, {
      horizontal: [0.6],
      vertical: [0.2, 0.7]
    });

    expect(initialSplits).toEqual({ horizontal: [0.5], vertical: [0.3, 0.7] });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0.2, y: 0, width: 0.49999999999999994, height: 1 },
      { x: 0, y: 0, width: 0.2, height: 0.6 },
      { x: 0, y: 0.6, width: 0.2, height: 0.4 },
      { x: 0.7, y: 0, width: 0.30000000000000004, height: 0.6 },
      { x: 0.7, y: 0.6, width: 0.30000000000000004, height: 0.4 }
    ]);
    expect(getWorkspaceSplits("main_center_side_stacks", slots)).toEqual({
      horizontal: [0.6],
      vertical: [0.2, 0.7]
    });
    const leftSplitRange = getWorkspaceSplitRange("main_center_side_stacks", initialSplits, "vertical", 0);
    expect(leftSplitRange.min).toBe(0.12);
    expect(leftSplitRange.max).toBeCloseTo(0.5);
    expect(getWorkspaceSplitRange("main_center_side_stacks", initialSplits, "vertical", 1)).toEqual({
      min: 0.5,
      max: 0.88
    });
    expect(getWorkspaceSplitRange("main_center_side_stacks", initialSplits, "horizontal", 0)).toEqual({
      min: 0.2,
      max: 0.8
    });
  });

  it("keeps centered-main horizontal resize handles inside both side columns", () => {
    expect(
      getWorkspaceHorizontalResizeHandles("main_center_side_stacks", {
        horizontal: [0.5],
        vertical: [0.3, 0.7]
      })
    ).toEqual([
      { splitIndex: 0, x: 0.15, y: 0.5 },
      { splitIndex: 0, x: 0.85, y: 0.5 }
    ]);

    expect(
      getWorkspaceHorizontalResizeHandles("main_center_side_stacks", {
        horizontal: [0.6],
        vertical: [0.2, 0.7]
      })
    ).toEqual([
      { splitIndex: 0, x: 0.1, y: 0.6 },
      { splitIndex: 0, x: 0.85, y: 0.6 }
    ]);
  });

  it("preserves horizontal resize handle positions for other workspace templates", () => {
    expect(
      getWorkspaceHorizontalResizeHandles("quad", {
        horizontal: [0.5],
        vertical: [0.5]
      })
    ).toEqual([{ splitIndex: 0, x: 0.25, y: 0.5 }]);
    expect(
      getWorkspaceHorizontalResizeHandles("main_left_stack_right", {
        horizontal: [0.5],
        vertical: [0.4]
      })
    ).toEqual([{ splitIndex: 0, x: 0.7, y: 0.5 }]);
    expect(
      getWorkspaceHorizontalResizeHandles("two_columns", {
        horizontal: [],
        vertical: [0.5]
      })
    ).toEqual([]);
  });
});

function slot(id: string, roleId?: string): LaunchWorkspaceSlot {
  return {
    id,
    ...(roleId ? { roleId } : {}),
    rect: { x: 0, y: 0, width: 1, height: 1 }
  };
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Knight",
    launchUrl: "https://universe.flyff.com/play",
    notes: "",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
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
