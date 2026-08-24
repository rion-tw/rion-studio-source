import { describe, expect, it } from "vitest";

import { getDashboardMacroItems } from "../src/renderer/src/features/dashboard/dashboardUtils";
import { createMacroListRunActionState } from "../src/renderer/src/features/macros/MacroListControls";
import { isApplicationLifecycleInputAvailable } from "../src/renderer/src/hooks/useApplicationLifecycle";
import type { Macro, MacroRunStatus, Role, RoleStatus } from "../src/shared/types";

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

function macroListState(status: RoleStatus, runtimeInputAvailable = true) {
  return createMacroListRunActionState({
    busyMacroIds: new Set(),
    busyRunKeys: new Set(),
    hasUnassignedDependency: false,
    macro,
    macroStatusByRun: new Map(),
    runtimeInputAvailable,
    statusByRole: new Map([[status.roleId, status]])
  });
}

function dashboardState(status: RoleStatus, runtimeInputAvailable = true) {
  return getDashboardMacroItems({
    busyMacroIds: new Set(),
    busyRunKeys: new Set(),
    macroStatusByRun: new Map(),
    macros: [macro],
    roles: [role],
    runtimeInputAvailable,
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

  it("disables new starts while the application lifecycle is fenced", () => {
    const readyStatus: RoleStatus = {
      roleId: role.id,
      state: "running",
      automationState: "ready",
      pageHealth: "healthy"
    };

    expect(macroListState(readyStatus, false)).toMatchObject({
      canStart: false,
      disabled: true,
      disabledReason: "runtimeNotActive"
    });
    expect(dashboardState(readyStatus, false)).toMatchObject({
      disabled: true,
      disabledReason: "runtimeNotActive"
    });
  });

  it("admits input only for active or degraded lifecycle states", () => {
    expect(isApplicationLifecycleInputAvailable(null)).toBe(false);
    const status = (state: "active" | "degraded" | "resuming" | "suspended") => ({
      capturedAt: "2026-08-24T00:00:00.000Z",
      lifecycleEpoch: 3,
      platform: "macos" as const,
      reason: "test",
      revision: 3,
      state
    });
    expect(isApplicationLifecycleInputAvailable(status("active"))).toBe(true);
    expect(isApplicationLifecycleInputAvailable(status("degraded"))).toBe(true);
    expect(isApplicationLifecycleInputAvailable(status("resuming"))).toBe(false);
    expect(isApplicationLifecycleInputAvailable(status("suspended"))).toBe(false);
  });

  it("keeps a recovering macro active and stoppable", () => {
    const readyStatus: RoleStatus = {
      roleId: role.id,
      state: "running",
      automationState: "ready",
      pageHealth: "healthy"
    };
    const recoveringStatus: MacroRunStatus = {
      roleId: role.id,
      macroId: macro.id,
      state: "recovering",
      startedAt: macro.createdAt,
      updatedAt: macro.updatedAt
    };
    const macroStatusByRun = new Map([[`${role.id}:${macro.id}`, recoveringStatus]]);

    expect(createMacroListRunActionState({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      hasUnassignedDependency: false,
      macro,
      macroStatusByRun,
      runtimeInputAvailable: false,
      statusByRole: new Map([[role.id, readyStatus]])
    })).toMatchObject({ canStop: true, disabled: false, isRunning: true, kind: "stop" });
    expect(getDashboardMacroItems({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      macroStatusByRun,
      macros: [macro],
      roles: [role],
      runtimeInputAvailable: false,
      statusByRole: new Map([[role.id, readyStatus]])
    })[0]).toMatchObject({ action: { disabled: false, isRunning: true, kind: "stop" }, runningCount: 1 });
  });
});
