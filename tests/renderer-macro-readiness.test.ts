import { describe, expect, it } from "vitest";

import { getDashboardMacroItems } from "../src/renderer/src/features/dashboard/dashboardUtils";
import { createMacroListRunActionState } from "../src/renderer/src/features/macros/MacroListControls";
import type { Macro, Role, RoleStatus } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  enabled: true,
  name: "Ready-only macro",
  roleIds: ["role-1"],
  shortcutSourceScope: { type: "all_execution_roles" },
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "Digit1" }],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z"
};

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Role 1",
  launchUrl: "https://example.test/",
  notes: "",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z"
};

function macroListState(status: RoleStatus) {
  return createMacroListRunActionState({
    busyMacroIds: new Set(),
    busyRunKeys: new Set(),
    hasUnassignedDependency: false,
    macro,
    macroStatusByRun: new Map(),
    statusByRole: new Map([[status.roleId, status]])
  });
}

function dashboardState(status: RoleStatus) {
  return getDashboardMacroItems({
    busyMacroIds: new Set(),
    busyRunKeys: new Set(),
    macroStatusByRun: new Map(),
    macros: [macro],
    roles: [role],
    statusByRole: new Map([[status.roleId, status]])
  })[0].action;
}

describe("macro readiness admission", () => {
  it("keeps both UI start actions disabled while a running role is not page-ready", () => {
    const pendingStatus: RoleStatus = { roleId: role.id, state: "running" };

    expect(macroListState(pendingStatus)).toMatchObject({
      canStart: false,
      disabled: true,
      disabledReason: "automationUnavailable"
    });
    expect(dashboardState(pendingStatus)).toMatchObject({
      disabled: true,
      disabledReason: "automationUnavailable"
    });
  });

  it("enables both UI start actions only after authoritative readiness", () => {
    const readyStatus: RoleStatus = {
      roleId: role.id,
      state: "running",
      automationState: "ready",
      pageHealth: "healthy"
    };

    expect(macroListState(readyStatus)).toMatchObject({ canStart: true, disabled: false });
    expect(dashboardState(readyStatus)).toMatchObject({ disabled: false, kind: "start" });
  });
});
