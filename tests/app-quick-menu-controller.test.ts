import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { AppQuickMenu } from "../src/main/menu/AppQuickMenu";
import type { LaunchWorkspace, Role, WorkspaceDisplayLaunchOption } from "../src/shared/types";

const { buildFromTemplate } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ template }))
}));

vi.mock("electron", () => ({ Menu: { buildFromTemplate } }));

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
  slots: [{ id: "slot-1", roleId: role.id, rect: { x: 0, y: 0, width: 1, height: 1 } }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("AppQuickMenu", () => {
  it("loads shared state and hands display conflicts to the app", async () => {
    const display = createDisplay();
    const conflict = {
      kind: "display_selection_required" as const,
      reason: "target_occupied" as const,
      displays: [display]
    };
    const workspaceLauncher = { launch: vi.fn().mockResolvedValue(conflict) };
    const onWorkspaceDisplaySelectionRequired = vi.fn();
    const setMenu = vi.fn();
    const menu = new AppQuickMenu({
      authManager: { listStatuses: vi.fn(() => []), startLogin: vi.fn() },
      browserManager: {
        launch: vi.fn(),
        listStatuses: vi.fn(() => []),
        listWorkspaceRuntimeStatuses: vi.fn(() => []),
        stopAll: vi.fn(),
        stopWorkspace: vi.fn()
      },
      canUseApp: vi.fn().mockResolvedValue(true),
      includeQuit: true,
      onWorkspaceDisplaySelectionRequired,
      openApp: vi.fn(),
      quitApp: vi.fn(),
      roleStore: { getRole: vi.fn().mockResolvedValue(role), listRoles: vi.fn().mockResolvedValue([role]) },
      setMenu,
      workspaceLauncher,
      workspaceStore: { listWorkspaces: vi.fn().mockResolvedValue([workspace]) }
    });

    await menu.refresh();

    expect(setMenu).toHaveBeenCalledOnce();
    const template = buildFromTemplate.mock.calls[0][0];
    const workspaceItem = getSubmenu(template, "Workspaces")[0];
    workspaceItem.click?.({} as never, undefined, {} as never);

    await vi.waitFor(() => expect(workspaceLauncher.launch).toHaveBeenCalledWith(workspace.id));
    expect(onWorkspaceDisplaySelectionRequired).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      result: conflict
    });
  });

  it("stops an actually running workspace without relaunching it", async () => {
    const stopWorkspace = vi.fn().mockResolvedValue(undefined);
    const workspaceLauncher = { launch: vi.fn() };
    const menu = new AppQuickMenu({
      authManager: { listStatuses: vi.fn(() => []), startLogin: vi.fn() },
      browserManager: {
        launch: vi.fn(),
        listStatuses: vi.fn(() => [{ roleId: role.id, state: "running" as const }]),
        listWorkspaceRuntimeStatuses: vi.fn(() => [{ workspaceId: workspace.id, state: "running" as const }]),
        stopAll: vi.fn(),
        stopWorkspace
      },
      canUseApp: vi.fn().mockResolvedValue(true),
      includeQuit: false,
      onWorkspaceDisplaySelectionRequired: vi.fn(),
      openApp: vi.fn(),
      roleStore: { getRole: vi.fn().mockResolvedValue(role), listRoles: vi.fn().mockResolvedValue([role]) },
      setMenu: vi.fn(),
      workspaceLauncher,
      workspaceStore: { listWorkspaces: vi.fn().mockResolvedValue([workspace]) }
    });

    await menu.refresh();
    const template = buildFromTemplate.mock.calls.at(-1)![0];
    getSubmenu(template, "Workspaces")[0].click?.({} as never, undefined, {} as never);

    await vi.waitFor(() => expect(stopWorkspace).toHaveBeenCalledWith(workspace.id));
    expect(workspaceLauncher.launch).not.toHaveBeenCalled();
  });
});

function getSubmenu(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
}

function createDisplay(): WorkspaceDisplayLaunchOption {
  return {
    id: 11,
    label: "Main display",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: true,
    isInternal: true,
    occupiedByWorkspace: { id: "workspace-2", name: "Raid" }
  };
}
