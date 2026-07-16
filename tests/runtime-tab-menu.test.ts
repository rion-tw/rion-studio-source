import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeTabMenuController } from "../src/main/menu/RuntimeTabMenu";
import type {
  EmbeddedRuntimeState,
  LaunchWorkspace,
  Role,
  WorkspaceDisplayInfo
} from "../src/shared/types";

const { buildFromTemplate, popup } = vi.hoisted(() => {
  const popup = vi.fn();
  return {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ popup, template })),
    popup
  };
});

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
  template: "single",
  browserLaunchMode: "inherit",
  browserZoomMode: "fixed",
  browserZoomPercent: 100,
  resourcePolicy: { mode: "unrestricted" },
  slots: [],
  targetDisplayId: 22,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const displays: WorkspaceDisplayInfo[] = [
  {
    id: 11,
    label: "Main display",
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    workArea: { x: 0, y: 24, width: 1200, height: 776 },
    resolution: { width: 1200, height: 800 },
    scaleFactor: 1,
    isPrimary: true,
    isInternal: true
  },
  {
    id: 22,
    label: "Side display",
    bounds: { x: 1200, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1200, y: 0, width: 1920, height: 1040 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: false,
    isInternal: false
  }
];

describe("RuntimeTabMenuController", () => {
  beforeEach(() => {
    buildFromTemplate.mockClear();
    popup.mockClear();
  });

  it("uses a native popup and locates running launcher items", async () => {
    const releaseRevealLock = vi.fn();
    const acquireRuntimeToolbarRevealLock = vi.fn(() => releaseRevealLock);
    const showRuntimeTab = vi.fn();
    const controller = createController({
      acquireRuntimeToolbarRevealLock,
      listEmbeddedRuntimeState: () => ({
        windows: [],
        tabs: [{
          id: "tab-1",
          type: "role",
          sourceId: role.id,
          name: role.name,
          displayId: 11,
          roleIds: [role.id],
          hidden: false,
          active: true
        }]
      }),
      showRuntimeTab
    });
    const window = { isDestroyed: () => false } as never;

    await controller.openLauncher(window, 11);

    expect(acquireRuntimeToolbarRevealLock).toHaveBeenCalledWith(11);
    expect(popup).toHaveBeenCalledWith({
      callback: releaseRevealLock,
      window
    });
    const popupOptions = popup.mock.calls[0][0];
    popupOptions.callback();
    expect(releaseRevealLock).toHaveBeenCalledOnce();
    const template = buildFromTemplate.mock.calls.at(-1)![0];
    const roleItem = getSubmenu(template, "Roles")[0];
    expect(roleItem).toMatchObject({ checked: true, type: "checkbox" });
    roleItem.click?.({} as never, undefined, {} as never);
    expect(showRuntimeTab).toHaveBeenCalledWith("tab-1");
  });

  it("routes stopped workspaces to their saved display and validates tab menu ownership", async () => {
    const workspaceLaunch = vi.fn().mockResolvedValue({ kind: "launched", statuses: [] });
    const moveRuntimeTab = vi.fn();
    const stopRuntimeTab = vi.fn().mockResolvedValue(undefined);
    const controller = createController({
      moveRuntimeTab,
      stopRuntimeTab,
      workspaceLaunch
    });
    const window = { isDestroyed: () => false } as never;

    await controller.openLauncher(window, 11);
    const launcherTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    getSubmenu(launcherTemplate, "Workspaces")[0].click?.({} as never, undefined, {} as never);
    await vi.waitFor(() => expect(workspaceLaunch).toHaveBeenCalledWith(workspace.id, { displayId: 22 }));

    controller.openTabMenu(window, 22, "tab-1");
    expect(buildFromTemplate).toHaveBeenCalledTimes(1);

    controller.openTabMenu(window, 11, "tab-1");
    const tabTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    const moveItems = getSubmenu(tabTemplate, "Move to Display");
    moveItems[1].click?.({} as never, undefined, {} as never);
    expect(moveRuntimeTab).toHaveBeenCalledWith("tab-1", 22);
    tabTemplate.at(-1)?.click?.({} as never, undefined, {} as never);
    await vi.waitFor(() => expect(stopRuntimeTab).toHaveBeenCalledWith("tab-1"));
  });

  it("starts login for an unauthenticated role on the source display", async () => {
    const startLogin = vi.fn();
    const unauthenticatedRole: Role = { ...role, authState: "login_required" };
    const controller = createController({
      listEmbeddedRuntimeState: () => ({ windows: [], tabs: [] }),
      role: unauthenticatedRole,
      startLogin
    });
    const window = { isDestroyed: () => false } as never;

    await controller.openLauncher(window, 11);
    const template = buildFromTemplate.mock.calls.at(-1)![0];
    getSubmenu(template, "Roles")[0].click?.({} as never, undefined, {} as never);

    await vi.waitFor(() => expect(startLogin).toHaveBeenCalledWith(unauthenticatedRole, {
      target: { displayId: 11, workArea: displays[0].workArea }
    }));
  });
});

function createController(overrides: {
  acquireRuntimeToolbarRevealLock?: ReturnType<typeof vi.fn>;
  listEmbeddedRuntimeState?: () => EmbeddedRuntimeState;
  moveRuntimeTab?: ReturnType<typeof vi.fn>;
  role?: Role;
  showRuntimeTab?: ReturnType<typeof vi.fn>;
  startLogin?: ReturnType<typeof vi.fn>;
  stopRuntimeTab?: ReturnType<typeof vi.fn>;
  workspaceLaunch?: ReturnType<typeof vi.fn>;
} = {}): RuntimeTabMenuController {
  const listEmbeddedRuntimeState = overrides.listEmbeddedRuntimeState ?? (() => ({
    windows: [],
    tabs: [{
      id: "tab-1",
      type: "role" as const,
      sourceId: role.id,
      name: role.name,
      displayId: 11,
      roleIds: [role.id],
      hidden: false,
      active: true
    }]
  }));
  const configuredRole = overrides.role ?? role;
  return new RuntimeTabMenuController({
    authManager: { startLogin: (overrides.startLogin ?? vi.fn()) as never },
    browserManager: {
      acquireRuntimeToolbarRevealLock: (overrides.acquireRuntimeToolbarRevealLock ??
        vi.fn(() => vi.fn())) as never,
      launch: vi.fn(),
      listEmbeddedRuntimeState,
      moveRuntimeTab: (overrides.moveRuntimeTab ?? vi.fn()) as never,
      showRuntimeTab: (overrides.showRuntimeTab ?? vi.fn()) as never,
      stopRuntimeTab: (overrides.stopRuntimeTab ?? vi.fn().mockResolvedValue(undefined)) as never
    },
    getWorkspaceDisplays: () => displays,
    onWorkspaceDisplaySelectionRequired: vi.fn(),
    roleStore: {
      getRole: vi.fn().mockResolvedValue(configuredRole),
      listRoles: vi.fn().mockResolvedValue([configuredRole])
    },
    workspaceLauncher: {
      launch: (overrides.workspaceLaunch ??
        vi.fn().mockResolvedValue({ kind: "launched", statuses: [] })) as never
    },
    workspaceStore: {
      getWorkspace: vi.fn().mockResolvedValue(workspace),
      listWorkspaces: vi.fn().mockResolvedValue([workspace])
    }
  });
}

function getSubmenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
}
