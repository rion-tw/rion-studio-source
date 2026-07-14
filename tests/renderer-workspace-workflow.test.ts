import { describe, expect, it, vi } from "vitest";

import { runWorkspaceLaunch } from "../src/renderer/src/features/workspaces/workspaceLaunchUtils";
import type { WorkspaceDisplayLaunchOption, WorkspaceLaunchResult } from "../src/shared/types";

describe("workspace launch workflow", () => {
  it("returns statuses without prompting when the preferred display is free", async () => {
    const launched = launchResult(11);
    const launch = vi.fn().mockResolvedValue(launched);
    const selectDisplay = vi.fn();

    await expect(runWorkspaceLaunch({ launch, selectDisplay })).resolves.toEqual(launched);
    expect(launch).toHaveBeenCalledWith();
    expect(selectDisplay).not.toHaveBeenCalled();
  });

  it("re-prompts with fresh occupancy when a selected display loses a race", async () => {
    const firstSelection = selectionResult("target_occupied", [display(11, "Raid"), display(22)]);
    const secondSelection = selectionResult("target_occupied", [display(11, "Raid"), display(22, "Party"), display(33)]);
    const launched = launchResult(33);
    const launch = vi.fn()
      .mockResolvedValueOnce(firstSelection)
      .mockResolvedValueOnce(secondSelection)
      .mockResolvedValueOnce(launched);
    const selectDisplay = vi.fn()
      .mockResolvedValueOnce(22)
      .mockResolvedValueOnce(33);

    await expect(runWorkspaceLaunch({ launch, selectDisplay })).resolves.toEqual(launched);
    expect(launch.mock.calls).toEqual([[], [{ displayId: 22 }], [{ displayId: 33 }]]);
    expect(selectDisplay).toHaveBeenNthCalledWith(1, firstSelection);
    expect(selectDisplay).toHaveBeenNthCalledWith(2, secondSelection);
  });

  it("cancels without another launch when no display is selected", async () => {
    const selection = selectionResult("target_unavailable", [display(11, "Raid")]);
    const launch = vi.fn().mockResolvedValue(selection);
    const selectDisplay = vi.fn().mockResolvedValue(undefined);

    await expect(runWorkspaceLaunch({ launch, selectDisplay })).resolves.toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

function launchResult(displayId: number): Extract<WorkspaceLaunchResult, { kind: "launched" }> {
  return {
    kind: "launched",
    displayId,
    statuses: [{ roleId: "role-1", state: "running" }]
  };
}

function selectionResult(
  reason: "target_occupied" | "target_unavailable",
  displays: WorkspaceDisplayLaunchOption[]
): Extract<WorkspaceLaunchResult, { kind: "display_selection_required" }> {
  return { kind: "display_selection_required", reason, displays };
}

function display(id: number, occupiedBy?: string): WorkspaceDisplayLaunchOption {
  return {
    id,
    label: `Display ${id}`,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: id === 11,
    isInternal: id === 11,
    ...(occupiedBy
      ? { occupiedByWorkspace: { id: `workspace-${id}`, name: occupiedBy } }
      : {})
  };
}
