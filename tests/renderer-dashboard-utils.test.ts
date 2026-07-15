import { describe, expect, it } from "vitest";

import {
  createDashboardSummary,
  getDashboardMacroItems,
  getDashboardRoleItems,
  getDashboardWorkspaceItems,
  getPendingAuthItems
} from "../src/renderer/src/features/dashboard/dashboardUtils";
import type {
  AuthFlowStatus,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../src/shared/types";

describe("renderer dashboard helpers", () => {
  it("summarizes only statuses that belong to known roles and macros", () => {
    expect(
      createDashboardSummary({
        roles: [
          role({ id: "r1", authState: "authenticated" }),
          role({ id: "r2", authState: "login_required" })
        ],
        roleStatuses: [
          { roleId: "r1", state: "running" },
          { roleId: "missing", state: "running" }
        ],
        workspaces: [workspace({ id: "w1" })],
        macros: [macro({ id: "m1", roleIds: ["r1"] })],
        macroStatuses: [
          macroStatus({ macroId: "m1", roleId: "r1", state: "running" }),
          macroStatus({ macroId: "m1", roleId: "r2", state: "running" }),
          macroStatus({ macroId: "m1", roleId: "missing", state: "running" }),
          macroStatus({ macroId: "missing", roleId: "r1", state: "running" })
        ]
      })
    ).toEqual({
      rolesNeedingLogin: 1,
      runningMacros: 1,
      runningRoles: 1,
      totalMacros: 1,
      totalRoles: 2,
      workspaceCount: 1
    });
  });

  it("sorts quick-launch roles by active state, launchability, and recency", () => {
    const roles = [
      role({ id: "needs-login", authState: "login_required", updatedAt: "2026-01-04T00:00:00.000Z" }),
      role({ id: "launchable", authState: "authenticated", updatedAt: "2026-01-03T00:00:00.000Z" }),
      role({ id: "running", authState: "authenticated", updatedAt: "2026-01-01T00:00:00.000Z" }),
      role({ id: "launching", authState: "authenticated", updatedAt: "2026-01-02T00:00:00.000Z" })
    ];

    expect(
      getDashboardRoleItems({
        authStatusByRole: new Map(),
        busyRoleIds: new Set(),
        roles,
        statusByRole: new Map<string, RoleStatus>([
          ["running", { roleId: "running", state: "running" }],
          ["launching", { roleId: "launching", state: "launching" }]
        ])
      }).map((item) => item.role.id)
    ).toEqual(["running", "launching", "launchable", "needs-login"]);
  });

  it("classifies and prioritizes roles that need authentication attention", () => {
    const roles = [
      role({ id: "login", authState: "login_required", updatedAt: "2026-01-04T00:00:00.000Z" }),
      role({ id: "failed", authState: "auth_failed", updatedAt: "2026-01-03T00:00:00.000Z" }),
      role({ id: "flow", authState: "login_required", updatedAt: "2026-01-02T00:00:00.000Z" }),
      role({ id: "ready", authState: "authenticated", updatedAt: "2026-01-01T00:00:00.000Z" })
    ];
    const items = getPendingAuthItems({
      authStatusByRole: new Map<string, AuthFlowStatus>([
        ["flow", authStatus({ roleId: "flow", state: "checking_session" })],
        ["failed", authStatus({ roleId: "failed", state: "failed" })]
      ]),
      busyRoleIds: new Set(["login"]),
      roles,
      statusByRole: new Map()
    });

    expect(items.map((item) => [item.role.id, item.pendingKind])).toEqual([
      ["flow", "authFlow"],
      ["failed", "authFailed"],
      ["login", "loginRequired"]
    ]);
    expect(items.find((item) => item.role.id === "flow")?.action).toMatchObject({ disabled: true, isBusy: true });
    expect(items.find((item) => item.role.id === "login")?.action).toMatchObject({ disabled: true, isBusy: true });
  });

  it("derives workspace launch and stop availability", () => {
    const empty = workspace({ id: "empty", slots: [] });
    const ready = workspace({ id: "ready", slots: [{ id: "s1", roleId: "r2", rect: rect() }] });
    const running = workspace({ id: "running", slots: [{ id: "s1", roleId: "r1", rect: rect() }] });
    const busy = workspace({ id: "busy", slots: [{ id: "s1", roleId: "r3", rect: rect() }] });
    const items = getDashboardWorkspaceItems({
      busyWorkspaceIds: new Set(["busy"]),
      statusByRole: new Map<string, RoleStatus>([["r1", { roleId: "r1", state: "running" }]]),
      workspaces: [empty, ready, running, busy]
    });
    const byId = new Map(items.map((item) => [item.workspace.id, item]));

    expect(byId.get("empty")?.action).toMatchObject({ disabled: true, kind: "launch" });
    expect(byId.get("ready")?.action).toMatchObject({ disabled: false, kind: "launch" });
    expect(byId.get("running")?.action).toMatchObject({ disabled: false, kind: "stop" });
    expect(byId.get("busy")?.action).toMatchObject({ disabled: true, kind: "launch" });
  });

  it("derives macro start and stop availability from assigned running roles", () => {
    const roles = [
      role({ id: "r1", authState: "authenticated" }),
      role({ id: "r2", authState: "authenticated" })
    ];
    const readyMacro = macro({ id: "ready", roleIds: ["r1", "r2"] });
    const blockedMacro = macro({ id: "blocked", roleIds: ["r1", "r2"] });
    const runningMacro = macro({ id: "running", roleIds: ["r1", "r2"] });
    const noRoleMacro = macro({ id: "no-role", roleIds: [] });
    const disabledMacro = macro({ id: "disabled", enabled: false, roleIds: ["r1"] });
    const items = getDashboardMacroItems({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      macroStatusByRun: new Map<string, MacroRunStatus>([
        ["r1:running", macroStatus({ macroId: "running", roleId: "r1", state: "running" })]
      ]),
      macros: [readyMacro, blockedMacro, runningMacro, noRoleMacro, disabledMacro],
      roles,
      statusByRole: new Map<string, RoleStatus>([
        ["r1", { roleId: "r1", state: "running" }],
        ["r2", { roleId: "r2", state: "running" }]
      ])
    });
    const byId = new Map(items.map((item) => [item.macro.id, item]));

    expect(byId.get("ready")?.action).toMatchObject({ disabled: false, kind: "start" });
    expect(byId.get("running")?.action).toMatchObject({ disabled: false, kind: "stop" });
    expect(byId.get("no-role")?.action).toMatchObject({
      disabled: true,
      disabledReason: "noRoles",
      kind: "start"
    });
    expect(byId.get("disabled")?.action).toMatchObject({
      disabled: true,
      disabledReason: "macroDisabled",
      kind: "start"
    });

    const partiallyReady = getDashboardMacroItems({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      macroStatusByRun: new Map(),
      macros: [blockedMacro],
      roles,
      statusByRole: new Map<string, RoleStatus>([["r1", { roleId: "r1", state: "running" }]])
    })[0];

    expect(partiallyReady.action).toMatchObject({
      disabled: false,
      kind: "start"
    });

    const blocked = getDashboardMacroItems({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      macroStatusByRun: new Map(),
      macros: [blockedMacro],
      roles,
      statusByRole: new Map()
    })[0];

    expect(blocked.action).toMatchObject({
      disabled: true,
      disabledReason: "rolesNotRunning",
      kind: "start"
    });

    const unavailable = getDashboardMacroItems({
      busyMacroIds: new Set(),
      busyRunKeys: new Set(),
      macroStatusByRun: new Map(),
      macros: [readyMacro],
      roles,
      statusByRole: new Map([
        ["r1", { roleId: "r1", state: "running", automationState: "unavailable" }],
        ["r2", { roleId: "r2", state: "running", automationState: "unavailable" }]
      ])
    })[0];

    expect(unavailable.action).toMatchObject({
      disabled: true,
      disabledReason: "automationUnavailable",
      kind: "start"
    });
  });
});

function role(overrides: Partial<Role>): Role {
  return {
    id: "role",
    gameId: "game-1",
    name: "Role",
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    launchPreset: "performance",
    authState: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function authStatus(overrides: Partial<AuthFlowStatus>): AuthFlowStatus {
  return {
    roleId: "role",
    state: "waiting_for_login",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function workspace(overrides: Partial<LaunchWorkspace>): LaunchWorkspace {
  return {
    id: "workspace",
    browserLaunchMode: "inherit",
    name: "Workspace",
    template: "two_columns",
    browserZoomPercent: 100,
    slots: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    resourcePolicy: overrides.resourcePolicy ?? { mode: "unrestricted", backgroundCpuThrottleRate: 2 }
  };
}

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: "macro",
    enabled: true,
    name: "Macro",
    roleIds: [],
    repeat: { type: "once" },
    steps: [{ id: "step", type: "key", code: "Tab", label: "Tab" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function macroStatus(overrides: Partial<MacroRunStatus>): MacroRunStatus {
  return {
    roleId: "role",
    macroId: "macro",
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function rect() {
  return {
    height: 1,
    width: 1,
    x: 0,
    y: 0
  };
}
