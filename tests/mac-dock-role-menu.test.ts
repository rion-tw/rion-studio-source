import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildAppQuickMenuTemplate,
  type AppQuickMenuActions,
  type AppQuickMenuState
} from "../src/main/menu/AppQuickMenuTemplate";
import type { AuthFlowStatus, LaunchWorkspace, Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  name: "Party",
  template: "two_columns",
  browserLaunchMode: "inherit",
  browserZoomPercent: 90,
  resourcePolicy: { mode: "unrestricted" },
  slots: [
    { id: "slot-1", roleId: role.id, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
    { id: "slot-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
  ],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("AppQuickMenuTemplate", () => {
  it("shows empty Roles and Workspaces submenus", () => {
    const template = buildAppQuickMenuTemplate(createState({ roles: [], workspaces: [] }), createActions());

    expect(getSubmenu(template, "Roles")).toEqual([{ label: "No Roles", enabled: false }]);
    expect(getSubmenu(template, "Workspaces")).toEqual([{ label: "No Workspaces", enabled: false }]);
  });

  it("preserves role launch, focus, and login behavior", () => {
    const actions = createActions();
    const stopped = buildAppQuickMenuTemplate(createState(), actions);
    click(getSubmenu(stopped, "Roles")[0]);
    expect(actions.launchRole).toHaveBeenCalledWith(role.id);

    const running = buildAppQuickMenuTemplate(createState({
      statuses: [{ roleId: role.id, state: "running" }]
    }), actions);
    expect(getSubmenu(running, "Roles")[0]).toMatchObject({
      type: "checkbox",
      checked: true,
      enabled: true,
      sublabel: "Running"
    });

    const loginActions = createActions();
    const loginRequired = buildAppQuickMenuTemplate(createState({
      roles: [{ ...role, authState: "login_required" }]
    }), loginActions);
    click(getSubmenu(loginRequired, "Roles")[0]);
    expect(loginActions.startLogin).toHaveBeenCalledWith(role.id);
  });

  it("keeps failed role auth flows retryable", () => {
    const authStatus: AuthFlowStatus = {
      roleId: role.id,
      state: "failed",
      message: "Login failed.",
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z"
    };
    const actions = createActions();
    const template = buildAppQuickMenuTemplate(createState({
      authStatuses: [authStatus],
      roles: [{ ...role, authState: "auth_failed" }]
    }), actions);

    expect(getSubmenu(template, "Roles")[0]).toMatchObject({ enabled: true, sublabel: "Login failed" });
    click(getSubmenu(template, "Roles")[0]);
    expect(actions.startLogin).toHaveBeenCalledWith(role.id);
  });

  it("launches a stopped workspace and stops a checked running workspace", () => {
    const actions = createActions();
    const stopped = buildAppQuickMenuTemplate(createState(), actions);
    click(getSubmenu(stopped, "Workspaces")[0]);
    expect(actions.launchWorkspace).toHaveBeenCalledWith(workspace.id);

    const running = buildAppQuickMenuTemplate(createState({
      workspaceStatuses: [{ workspaceId: workspace.id, state: "running" }]
    }), actions);
    expect(getSubmenu(running, "Workspaces")[0]).toMatchObject({
      type: "checkbox",
      checked: true,
      enabled: true,
      sublabel: "Running"
    });
    click(getSubmenu(running, "Workspaces")[0]);
    expect(actions.stopWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it.each(["launching", "stopping"] as const)("disables a %s workspace", (state) => {
    const template = buildAppQuickMenuTemplate(createState({
      workspaceStatuses: [{ workspaceId: workspace.id, state }]
    }), createActions());

    expect(getSubmenu(template, "Workspaces")[0]).toMatchObject({
      checked: false,
      enabled: false,
      sublabel: state === "launching" ? "Launching" : "Stopping"
    });
  });

  it("disables unlaunchable workspaces and all actions before legal acceptance", () => {
    const noRoles = buildAppQuickMenuTemplate(createState({
      workspaces: [{ ...workspace, slots: workspace.slots.map((slot) => ({ ...slot, roleId: undefined })) }]
    }), createActions());
    expect(getSubmenu(noRoles, "Workspaces")[0]).toMatchObject({
      enabled: false,
      sublabel: "No assigned roles"
    });

    const unauthenticated = buildAppQuickMenuTemplate(createState({
      roles: [{ ...role, authState: "login_required" }]
    }), createActions());
    expect(getSubmenu(unauthenticated, "Workspaces")[0]).toMatchObject({
      enabled: false,
      sublabel: "Login required"
    });

    const blocked = buildAppQuickMenuTemplate(createState({ legalAccepted: false }), createActions());
    expect(getSubmenu(blocked, "Roles")[0]).toMatchObject({ enabled: false });
    expect(getSubmenu(blocked, "Workspaces")[0]).toMatchObject({ enabled: false });
  });

  it("adds Stop All conditionally and appends Quit only for Windows", () => {
    const actions = createActions();
    const template = buildAppQuickMenuTemplate(createState({
      includeQuit: true,
      statuses: [{ roleId: role.id, state: "running" }]
    }), actions);

    expect(template.map((item) => item.label).filter(Boolean)).toEqual([
      "Open Rion Studio",
      "Roles",
      "Workspaces",
      "Stop All Running Roles",
      "Quit Rion Studio"
    ]);
    click(template.find((item) => item.label === "Stop All Running Roles")!);
    click(template.find((item) => item.label === "Quit Rion Studio")!);
    expect(actions.stopAll).toHaveBeenCalledOnce();
    expect(actions.quitApp).toHaveBeenCalledOnce();
  });
});

function createState(overrides: Partial<AppQuickMenuState> = {}): AppQuickMenuState {
  return {
    authStatuses: [],
    includeQuit: false,
    legalAccepted: true,
    roles: [role],
    statuses: [],
    workspaces: [workspace],
    workspaceStatuses: [],
    ...overrides
  };
}

function createActions(): AppQuickMenuActions {
  return {
    launchRole: vi.fn(),
    launchWorkspace: vi.fn(),
    openApp: vi.fn(),
    quitApp: vi.fn(),
    startLogin: vi.fn(),
    stopAll: vi.fn(),
    stopWorkspace: vi.fn()
  };
}

function getSubmenu(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
}

function click(item: MenuItemConstructorOptions): void {
  item.click?.({} as never, undefined, {} as never);
}
