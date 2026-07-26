import { describe, expect, it, vi } from "vitest";

import { WorkspaceLaunchCoordinator } from "../src/main/workspaces/WorkspaceLaunchCoordinator";
import type { LaunchWorkspace, Role, WorkspaceDisplayInfo } from "../src/shared/types";

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  name: "Nine roles",
  template: "single",
  browserZoomMode: "adaptive",
  browserZoomPercent: 100,
  slots: [{
    id: "slot-1",
    roleId: "role-1",
    rect: { x: 0, y: 0, width: 1, height: 1 }
  }],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z"
};

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Role 1",
  launchUrl: "https://example.com/play",
  notes: "",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z"
};

const display: WorkspaceDisplayInfo = {
  id: 1,
  label: "Primary",
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  workArea: { x: 0, y: 0, width: 1200, height: 760 },
  resolution: { width: 1200, height: 800 },
  scaleFactor: 1,
  isPrimary: true,
  isInternal: true
};

describe("WorkspaceLaunchCoordinator launch tracing", () => {
  it("records launch duration and event-loop delay without changing the result", async () => {
    const recordLaunchTelemetry = vi.fn();
    const launchWorkspace = vi.fn().mockResolvedValue([{
      roleId: role.id,
      runtimeMode: "embedded",
      state: "running"
    }]);
    const coordinator = new WorkspaceLaunchCoordinator({
      browserManager: {
        launchWorkspace,
        listWorkspaceDisplayReservations: () => []
      },
      getWorkspaceDisplays: () => [display],
      recordLaunchTelemetry,
      roleStore: { getRole: vi.fn().mockResolvedValue(role) },
      workspaceStore: { getWorkspace: vi.fn().mockResolvedValue(workspace) }
    });

    await expect(coordinator.launch(workspace.id)).resolves.toMatchObject({
      kind: "launched",
      displayId: display.id
    });

    expect(recordLaunchTelemetry).toHaveBeenCalledTimes(1);
    expect(recordLaunchTelemetry).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      eventLoopMaxMs: expect.any(Number),
      eventLoopP95Ms: expect.any(Number)
    });
    expect(recordLaunchTelemetry.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
