import { describe, expect, it } from "vitest";

import type { LaunchWorkspaceSlot } from "../src/shared/types";
import { getDefaultWorkspaceRects } from "../src/shared/workspaceLayout";
import {
  applyWorkspaceSplits,
  applyWorkspaceTemplate,
  assignRoleToWorkspaceSlot,
  getWorkspaceSplits,
  swapWorkspaceSlotRoles
} from "../src/renderer/src/features/workspaces/workspaceLayoutUtils";

describe("renderer workspace layout helpers", () => {
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

  it("reads and applies custom split positions", () => {
    const slots = applyWorkspaceSplits("quad", applyWorkspaceTemplate([], "quad"), 0.3, 0.7);

    expect(getWorkspaceSplits("quad", slots)).toEqual({ splitX: 0.3, splitY: 0.7 });
    expect(slots.map((item) => item.rect)).toEqual([
      { x: 0, y: 0, width: 0.3, height: 0.7 },
      { x: 0.3, y: 0, width: 0.7, height: 0.7 },
      { x: 0, y: 0.7, width: 0.3, height: 0.30000000000000004 },
      { x: 0.3, y: 0.7, width: 0.7, height: 0.30000000000000004 }
    ]);
  });
});

function slot(id: string, roleId?: string): LaunchWorkspaceSlot {
  return {
    id,
    ...(roleId ? { roleId } : {}),
    rect: { x: 0, y: 0, width: 1, height: 1 }
  };
}
