import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { buildDockRoleMenuTemplate, type DockRoleMenuActions } from "../src/main/dock/DockRoleMenuTemplate";
import type { AuthFlowStatus, Role, RoleStatus } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  launchPreset: "performance",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("DockRoleMenuTemplate", () => {
  it("shows an empty Roles submenu when no roles exist", () => {
    const template = buildDockRoleMenuTemplate(
      {
        roles: [],
        statuses: [],
        authStatuses: [],
        legalAccepted: true
      },
      createActions()
    );

    expect(getRolesSubmenu(template)).toEqual([
      {
        label: "No Roles",
        enabled: false
      }
    ]);
  });

  it("launches authenticated stopped roles", () => {
    const actions = createActions();
    const template = buildDockRoleMenuTemplate(
      {
        roles: [role],
        statuses: [],
        authStatuses: [],
        legalAccepted: true
      },
      actions
    );

    clickFirstRole(template);

    expect(actions.launchRole).toHaveBeenCalledWith(role.id);
    expect(actions.startLogin).not.toHaveBeenCalled();
  });

  it("shows running roles as checked and focuses through launch", () => {
    const actions = createActions();
    const status: RoleStatus = {
      roleId: role.id,
      state: "running",
      launchedAt: "2026-07-10T00:01:00.000Z"
    };
    const template = buildDockRoleMenuTemplate(
      {
        roles: [role],
        statuses: [status],
        authStatuses: [],
        legalAccepted: true
      },
      actions
    );
    const [item] = getRolesSubmenu(template);

    expect(item).toMatchObject({
      label: "Main",
      type: "checkbox",
      checked: true,
      enabled: true,
      sublabel: "Running"
    });

    clickFirstRole(template);
    expect(actions.launchRole).toHaveBeenCalledWith(role.id);
  });

  it("starts login for login-required roles", () => {
    const actions = createActions();
    const loginRequiredRole: Role = {
      ...role,
      authState: "login_required"
    };
    const template = buildDockRoleMenuTemplate(
      {
        roles: [loginRequiredRole],
        statuses: [],
        authStatuses: [],
        legalAccepted: true
      },
      actions
    );

    clickFirstRole(template);

    expect(actions.startLogin).toHaveBeenCalledWith(role.id);
    expect(actions.launchRole).not.toHaveBeenCalled();
  });

  it("keeps failed auth flows retryable", () => {
    const actions = createActions();
    const authStatus: AuthFlowStatus = {
      roleId: role.id,
      state: "failed",
      message: "Login failed.",
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z"
    };
    const template = buildDockRoleMenuTemplate(
      {
        roles: [{ ...role, authState: "auth_failed" }],
        statuses: [],
        authStatuses: [authStatus],
        legalAccepted: true
      },
      actions
    );
    const [item] = getRolesSubmenu(template);

    expect(item.enabled).toBe(true);

    clickFirstRole(template);
    expect(actions.startLogin).toHaveBeenCalledWith(role.id);
  });

  it("adds Stop All Running Roles only when statuses exist", () => {
    const actions = createActions();
    const stoppedTemplate = buildDockRoleMenuTemplate(
      {
        roles: [role],
        statuses: [],
        authStatuses: [],
        legalAccepted: true
      },
      actions
    );
    const runningTemplate = buildDockRoleMenuTemplate(
      {
        roles: [role],
        statuses: [{ roleId: role.id, state: "running" }],
        authStatuses: [],
        legalAccepted: true
      },
      actions
    );

    expect(stoppedTemplate.some((item) => item.label === "Stop All Running Roles")).toBe(false);

    const stopItem = runningTemplate.find((item) => item.label === "Stop All Running Roles");
    expect(stopItem).toBeDefined();
    stopItem?.click?.({} as never, undefined, {} as never);
    expect(actions.stopAll).toHaveBeenCalledTimes(1);
  });

  it("blocks role actions until legal documents are accepted", () => {
    const actions = createActions();
    const template = buildDockRoleMenuTemplate(
      {
        roles: [role],
        statuses: [],
        authStatuses: [],
        legalAccepted: false
      },
      actions
    );

    expect(getRolesSubmenu(template)[0]).toMatchObject({
      enabled: false,
      sublabel: "Review terms in app"
    });

    const reviewItem = template.find((item) => item.label === "Review terms in Rion Studio");
    reviewItem?.click?.({} as never, undefined, {} as never);
    expect(actions.openApp).toHaveBeenCalledOnce();
  });
});

function createActions(): DockRoleMenuActions {
  return {
    openApp: vi.fn(),
    launchRole: vi.fn(),
    startLogin: vi.fn(),
    stopAll: vi.fn()
  };
}

function getRolesSubmenu(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const item = template.find((menuItem) => menuItem.label === "Roles");
  return item?.submenu as MenuItemConstructorOptions[];
}

function clickFirstRole(template: MenuItemConstructorOptions[]): void {
  const [item] = getRolesSubmenu(template);
  item.click?.({} as never, undefined, {} as never);
}
