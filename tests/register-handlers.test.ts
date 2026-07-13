import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC_CHANNELS } from "../src/shared/ipc";
import type { AuthManager } from "../src/main/auth/AuthManager";
import type { BrowserManager } from "../src/main/browser/BrowserManager";
import { registerIpcHandlers } from "../src/main/ipc/registerHandlers";
import type { MacroManager } from "../src/main/macros/MacroManager";
import type { MacroStore } from "../src/main/macros/MacroStore";
import type { RoleStore } from "../src/main/roles/RoleStore";
import type { AppUpdateManager } from "../src/main/updates/AppUpdateManager";
import type { LaunchWorkspaceStore } from "../src/main/workspaces/LaunchWorkspaceStore";
import type { LaunchWorkspace, Macro, Role } from "../src/shared/types";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    })
  },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1000, height: 800 }
    }))
  }
}));

const authenticatedRole: Role = {
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

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  name: "Party",
  template: "two_columns",
  browserZoomPercent: 100,
  slots: [
    {
      id: "slot-1",
      roleId: "role-1",
      rect: { x: 0, y: 0, width: 0.5, height: 1 }
    },
    {
      id: "slot-2",
      roleId: "role-2",
      rect: { x: 0.5, y: 0, width: 0.5, height: 1 }
    }
  ],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("registerIpcHandlers workspace handlers", () => {
  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<
    BrowserManager,
    "launch" | "launchWorkspace" | "listStatuses" | "on" | "stop" | "stopWorkspace"
  >;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let onOverlayLanguageChanged: ReturnType<typeof vi.fn>;
  let onRendererReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.clear();
    roleStore = {
      deleteRole: vi.fn().mockResolvedValue(undefined),
      getRole: vi.fn(async (id: string) => ({
        ...authenticatedRole,
        id,
        authState: id === "role-2" ? "authenticated" : authenticatedRole.authState
      }))
    };
    workspaceStore = {
      clearRole: vi.fn().mockResolvedValue(undefined),
      getWorkspace: vi.fn().mockResolvedValue(workspace)
    };
    browserManager = {
      launch: vi.fn(async (role: Role) => ({ roleId: role.id, state: "running" as const })),
      launchWorkspace: vi.fn(async (_workspace: LaunchWorkspace, items: Array<{ role: Role }>) =>
        items.map(({ role }) => ({ roleId: role.id, state: "running" as const }))
      ),
      listStatuses: vi.fn(() => []),
      on: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      stopWorkspace: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    onOverlayLanguageChanged = vi.fn();
    onRendererReady = vi.fn();

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        onOverlayLanguageChanged,
        onRendererReady
      }
    );
  });

  it("syncs the overlay language preference", async () => {
    await handlers.get(IPC_CHANNELS.preferencesSetOverlayLanguage)?.({}, "zh-CN");

    expect(onOverlayLanguageChanged).toHaveBeenCalledWith("zh-CN");
    expect(() => handlers.get(IPC_CHANNELS.preferencesSetOverlayLanguage)?.({}, "fr")).toThrow(
      "Language setting is invalid."
    );
  });

  it("accepts renderer readiness only for valid settled states", async () => {
    await handlers.get(IPC_CHANNELS.appRendererReady)?.({ sender: { id: 42 } }, "ready");
    await handlers.get(IPC_CHANNELS.appRendererReady)?.({ sender: { id: 43 } }, "failed");

    expect(onRendererReady).toHaveBeenNthCalledWith(1, 42, "ready");
    expect(onRendererReady).toHaveBeenNthCalledWith(2, 43, "failed");
    expect(() => handlers.get(IPC_CHANNELS.appRendererReady)?.({ sender: { id: 44 } }, "loading")).toThrow(
      "Renderer readiness state is invalid."
    );
  });

  it("launches workspace roles atomically in one game host", async () => {
    const result = await handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id);

    expect(result).toEqual([
      { roleId: "role-1", state: "running" },
      { roleId: "role-2", state: "running" }
    ]);
    expect(browserManager.launchWorkspace).toHaveBeenCalledWith(workspace, [
      { role: expect.objectContaining({ id: "role-1" }), rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { role: expect.objectContaining({ id: "role-2" }), rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ]);
    expect(browserManager.launch).not.toHaveBeenCalled();
  });

  it("launches three-column workspace roles with each saved column bound", async () => {
    const threeColumnWorkspace: LaunchWorkspace = {
      ...workspace,
      id: "workspace-3",
      template: "three_columns",
      browserZoomPercent: 90,
      slots: [
        { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
        { id: "slot-2", roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.35, height: 1 } },
        { id: "slot-3", roleId: "role-3", rect: { x: 0.55, y: 0, width: 0.45, height: 1 } }
      ]
    };
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue(threeColumnWorkspace);

    await handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, threeColumnWorkspace.id);

    expect(browserManager.launchWorkspace).toHaveBeenCalledWith(
      threeColumnWorkspace,
      expect.arrayContaining([
        { role: expect.objectContaining({ id: "role-3" }), rect: { x: 0.55, y: 0, width: 0.45, height: 1 } }
      ])
    );
  });

  it("launches four-column workspace roles with each saved column bound", async () => {
    const fourColumnWorkspace: LaunchWorkspace = {
      ...workspace,
      id: "workspace-4",
      template: "four_columns",
      browserZoomPercent: 90,
      slots: [
        { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.2, height: 1 } },
        { id: "slot-2", roleId: "role-2", rect: { x: 0.2, y: 0, width: 0.3, height: 1 } },
        { id: "slot-3", roleId: "role-3", rect: { x: 0.5, y: 0, width: 0.18, height: 1 } },
        { id: "slot-4", roleId: "role-4", rect: { x: 0.68, y: 0, width: 0.32, height: 1 } }
      ]
    };
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue(fourColumnWorkspace);

    await handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, fourColumnWorkspace.id);

    expect(browserManager.launchWorkspace).toHaveBeenCalledWith(
      fourColumnWorkspace,
      expect.arrayContaining([
        { role: expect.objectContaining({ id: "role-4" }), rect: { x: 0.68, y: 0, width: 0.32, height: 1 } }
      ])
    );
  });

  it("blocks workspace launch when any role needs login", async () => {
    roleStore.getRole = vi.fn(async (id: string): Promise<Role> => ({
      ...authenticatedRole,
      id,
      authState: id === "role-2" ? "login_required" : "authenticated"
    }));

    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id)).rejects.toThrow(
      "Login required. Use Login before launching every role in this workspace."
    );
    expect(browserManager.launchWorkspace).not.toHaveBeenCalled();
  });

  it("stops every role assigned to the workspace", async () => {
    await handlers.get(IPC_CHANNELS.workspacesStop)?.({}, workspace.id);

    expect(browserManager.stopWorkspace).toHaveBeenCalledWith(workspace.id);
  });

  it("clears deleted role references from workspaces", async () => {
    await handlers.get(IPC_CHANNELS.rolesDelete)?.({}, "role-1");

    expect(browserManager.stop).toHaveBeenCalledWith("role-1");
    expect(roleStore.deleteRole).toHaveBeenCalledWith("role-1");
    expect(workspaceStore.clearRole).toHaveBeenCalledWith("role-1");
  });
});

describe("registerIpcHandlers macro handlers", () => {
  const macro: Macro = {
    id: "macro-1",
    name: "Auto heal",
    roleId: "role-1",
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };

  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<BrowserManager, "launch" | "listStatuses" | "on" | "stop">;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let macroStore: Pick<
    MacroStore,
    "createMacro" | "deleteMacro" | "deleteRoleMacros" | "listMacros" | "updateMacro"
  >;
  let macroManager: Pick<MacroManager, "listStatuses" | "on" | "start" | "stop" | "stopRole">;
  let consumePendingMacroEditorRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.clear();
    roleStore = {
      deleteRole: vi.fn().mockResolvedValue(undefined),
      getRole: vi.fn().mockResolvedValue(authenticatedRole)
    };
    workspaceStore = {
      clearRole: vi.fn().mockResolvedValue(undefined),
      getWorkspace: vi.fn().mockResolvedValue(workspace)
    };
    browserManager = {
      launch: vi.fn(async (role: Role) => ({ roleId: role.id, state: "running" as const })),
      listStatuses: vi.fn(() => []),
      on: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    macroStore = {
      createMacro: vi.fn().mockResolvedValue(macro),
      deleteMacro: vi.fn().mockResolvedValue(undefined),
      deleteRoleMacros: vi.fn().mockResolvedValue(undefined),
      listMacros: vi.fn().mockResolvedValue([macro]),
      updateMacro: vi.fn().mockResolvedValue({ ...macro, name: "Updated" })
    };
    macroManager = {
      listStatuses: vi.fn(() => [
        {
          roleId: "role-1",
          macroId: "macro-1",
          state: "running" as const,
          startedAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z"
        }
      ]),
      on: vi.fn(),
      start: vi.fn().mockResolvedValue({
        roleId: "role-1",
        macroId: "macro-1",
        state: "running",
        startedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      stopRole: vi.fn().mockResolvedValue(undefined)
    };
    consumePendingMacroEditorRequest = vi.fn(() => ({ macroId: "macro-1", roleId: "role-1" }));

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        consumePendingMacroEditorRequest,
        macroManager: macroManager as MacroManager,
        macroStore: macroStore as MacroStore
      }
    );
  });

  it("consumes pending macro editor requests", () => {
    expect(handlers.get(IPC_CHANNELS.macrosConsumeEditorRequest)?.({})).toEqual({
      macroId: "macro-1",
      roleId: "role-1"
    });

    expect(consumePendingMacroEditorRequest).toHaveBeenCalledTimes(1);
  });

  it("registers macro CRUD and run handlers", async () => {
    await expect(handlers.get(IPC_CHANNELS.macrosList)?.({})).resolves.toEqual([macro]);
    await expect(
      handlers.get(IPC_CHANNELS.macrosCreate)?.({}, {
        name: "Auto heal",
        roleId: "role-1",
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).resolves.toEqual(macro);
    await expect(handlers.get(IPC_CHANNELS.macrosUpdate)?.({}, "macro-1", { name: "Updated" })).resolves.toMatchObject({
      name: "Updated"
    });

    await expect(handlers.get(IPC_CHANNELS.macrosStart)?.({}, "role-1", "macro-1")).resolves.toMatchObject({
      macroId: "macro-1",
      roleId: "role-1",
      state: "running"
    });
    await expect(handlers.get(IPC_CHANNELS.macrosStop)?.({}, "role-1", "macro-1")).resolves.toBeUndefined();
    expect(handlers.get(IPC_CHANNELS.macrosStatuses)?.({})).toMatchObject([
      { roleId: "role-1", macroId: "macro-1" }
    ]);

    expect(macroManager.start).toHaveBeenCalledWith("role-1", "macro-1");
    expect(macroManager.stop).toHaveBeenCalledWith("role-1", "macro-1");
  });

  it("stops and deletes running macro instances before deleting a macro", async () => {
    await handlers.get(IPC_CHANNELS.macrosDelete)?.({}, "macro-1");

    expect(macroManager.stop).toHaveBeenCalledWith("role-1", "macro-1");
    expect(macroStore.deleteMacro).toHaveBeenCalledWith("macro-1");
  });

  it("deletes stored macros after the browser manager stops a deleted role", async () => {
    await handlers.get(IPC_CHANNELS.rolesDelete)?.({}, "role-1");

    expect(browserManager.stop).toHaveBeenCalledWith("role-1");
    expect(macroStore.deleteRoleMacros).toHaveBeenCalledWith("role-1");
  });
});

describe("registerIpcHandlers update handlers", () => {
  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<BrowserManager, "listStatuses" | "on" | "stop">;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let updateManager: Pick<
    AppUpdateManager,
    "checkForUpdates" | "getStatus" | "installDownloadedUpdate" | "on" | "openUpdateDownload"
  >;

  beforeEach(() => {
    handlers.clear();
    roleStore = {
      deleteRole: vi.fn().mockResolvedValue(undefined),
      getRole: vi.fn().mockResolvedValue(authenticatedRole)
    };
    workspaceStore = {
      clearRole: vi.fn().mockResolvedValue(undefined),
      getWorkspace: vi.fn().mockResolvedValue(workspace)
    };
    browserManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    updateManager = {
      checkForUpdates: vi.fn().mockResolvedValue({
        currentVersion: "0.2.0",
        installMode: "automatic" as const,
        isPackaged: true,
        state: "not_available" as const
      }),
      getStatus: vi.fn(() => ({
        currentVersion: "0.1.0",
        installMode: "automatic" as const,
        isPackaged: true,
        state: "idle" as const
      })),
      installDownloadedUpdate: vi.fn(),
      on: vi.fn(),
      openUpdateDownload: vi.fn().mockResolvedValue(undefined)
    };

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        updateManager: updateManager as AppUpdateManager
      }
    );
  });

  it("exposes app version and update commands", async () => {
    expect(handlers.get(IPC_CHANNELS.appVersion)?.({})).toBe("0.1.0");
    expect(handlers.get(IPC_CHANNELS.updatesStatus)?.({})).toMatchObject({ state: "idle" });
    await expect(handlers.get(IPC_CHANNELS.updatesCheck)?.({})).resolves.toMatchObject({ state: "not_available" });
    expect(updateManager.checkForUpdates).toHaveBeenCalledTimes(1);

    await handlers.get(IPC_CHANNELS.updatesOpenDownload)?.({});
    expect(updateManager.openUpdateDownload).toHaveBeenCalledTimes(1);

    handlers.get(IPC_CHANNELS.updatesInstall)?.({});
    expect(updateManager.installDownloadedUpdate).toHaveBeenCalledTimes(1);
  });
});
