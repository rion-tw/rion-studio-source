import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { IPC_CHANNELS } from "../src/shared/ipc";
import type { AuthManager } from "../src/main/auth/AuthManager";
import {
  BrowserWorkspaceDisplayOccupiedError,
  type BrowserManager
} from "../src/main/browser/BrowserManager";
import { registerIpcHandlers } from "../src/main/ipc/registerHandlers";
import type { MacroManager } from "../src/main/macros/MacroManager";
import type { MacroStore } from "../src/main/macros/MacroStore";
import type { RoleStore } from "../src/main/roles/RoleStore";
import type { AppUpdateManager } from "../src/main/updates/AppUpdateManager";
import type { LaunchWorkspaceStore } from "../src/main/workspaces/LaunchWorkspaceStore";
import {
  DEFAULT_BROWSER_NETWORK_SETTINGS,
  DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
} from "../src/shared/browserFonts";
import type {
  GameBrowserSettings,
  LaunchWorkspace,
  Macro,
  Role,
  SystemFontFamily,
  WorkspaceDisplayInfo
} from "../src/shared/types";

type AnyMock = Mock;

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
  let roleStore: Pick<RoleStore, "deleteRole" | "getRole" | "listRoles" | "reorderRoles">;
  let workspaceStore: Pick<
    LaunchWorkspaceStore,
    "clearRole" | "createWorkspace" | "getWorkspace" | "listWorkspaces" | "reorderWorkspaces" | "updateWorkspace"
  >;
  let browserManager: Pick<
    BrowserManager,
    | "launch"
    | "launchWorkspace"
    | "listStatuses"
    | "listWorkspaceDisplayReservations"
    | "on"
    | "runRoleOperation"
    | "stop"
    | "stopRoleAndRunMutation"
    | "stopWorkspace"
  >;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let onOverlayLanguageChanged: AnyMock;
  let onRendererReady: AnyMock;
  let onLegalAccepted: AnyMock;
  let onRolesChanged: AnyMock;
  let onWorkspacesChanged: AnyMock;
  let quitApplication: AnyMock;
  let legalAcceptanceStore: {
    accept: AnyMock;
    getStatus: AnyMock;
  };
  let workspaceDisplays: WorkspaceDisplayInfo[];

  beforeEach(() => {
    handlers.clear();
    roleStore = {
      deleteRole: vi.fn().mockResolvedValue(undefined),
      getRole: vi.fn(async (id: string) => ({
        ...authenticatedRole,
        id,
        authState: id === "role-2" ? "authenticated" : authenticatedRole.authState
      })),
      listRoles: vi.fn().mockResolvedValue([authenticatedRole]),
      reorderRoles: vi.fn().mockResolvedValue([authenticatedRole])
    };
    workspaceStore = {
      clearRole: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue(workspace),
      getWorkspace: vi.fn().mockResolvedValue(workspace),
      listWorkspaces: vi.fn().mockResolvedValue([workspace]),
      reorderWorkspaces: vi.fn().mockResolvedValue([workspace]),
      updateWorkspace: vi.fn().mockResolvedValue(workspace)
    };
    browserManager = {
      launch: vi.fn(async (role: Role) => ({ roleId: role.id, state: "running" as const })),
      launchWorkspace: vi.fn(async (_workspace: LaunchWorkspace, items: Array<{ role: Role }>) =>
        items.map(({ role }) => ({ roleId: role.id, state: "running" as const }))
      ),
      listStatuses: vi.fn(() => []),
      listWorkspaceDisplayReservations: vi.fn(() => []),
      on: vi.fn(),
      runRoleOperation: vi.fn(async (_roleIds: string[], operation: () => Promise<unknown>) => operation()) as never,
      stop: vi.fn().mockResolvedValue(undefined),
      stopRoleAndRunMutation: vi.fn(async (roleId: string, operation: () => Promise<unknown>) => {
        await browserManager.stop(roleId);
        return operation();
      }) as never,
      stopWorkspace: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    onOverlayLanguageChanged = vi.fn();
    onRendererReady = vi.fn();
    onLegalAccepted = vi.fn();
    onRolesChanged = vi.fn();
    onWorkspacesChanged = vi.fn();
    quitApplication = vi.fn();
    const pendingLegalStatus = {
      currentVersions: { terms: "2026-07-14", fairUse: "2026-07-14", privacy: "2026-07-14" },
      isAccepted: false
    };
    legalAcceptanceStore = {
      accept: vi.fn().mockResolvedValue({ ...pendingLegalStatus, isAccepted: true }),
      getStatus: vi.fn().mockResolvedValue(pendingLegalStatus)
    };
    workspaceDisplays = [
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

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        legalAcceptanceStore,
        getDefaultWorkspaceDisplayId: () => 11,
        getWorkspaceDisplays: () => workspaceDisplays,
        onLegalAccepted,
        onOverlayLanguageChanged,
        onRendererReady,
        onRolesChanged,
        onWorkspacesChanged,
        quitApplication
      }
    );
  });

  it("returns initial renderer data through one snapshot handler", async () => {
    await expect(handlers.get(IPC_CHANNELS.appSnapshot)?.({})).resolves.toEqual({
      roles: [authenticatedRole],
      roleStatuses: [],
      authStatuses: [],
      launchWorkspaces: [workspace],
      workspaceDisplays,
      macros: [],
      macroStatuses: []
    });
    expect(roleStore.listRoles).toHaveBeenCalledOnce();
    expect(workspaceStore.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("persists role and workspace orders and reports both collections changed", async () => {
    const roleInput = { orderedIds: ["role-1"] };
    const workspaceInput = { orderedIds: ["workspace-1"] };

    await expect(handlers.get(IPC_CHANNELS.rolesReorder)?.({}, roleInput)).resolves.toEqual([authenticatedRole]);
    await expect(handlers.get(IPC_CHANNELS.workspacesReorder)?.({}, workspaceInput)).resolves.toEqual([workspace]);

    expect(roleStore.reorderRoles).toHaveBeenCalledWith(roleInput);
    expect(workspaceStore.reorderWorkspaces).toHaveBeenCalledWith(workspaceInput);
    expect(onRolesChanged).toHaveBeenCalledOnce();
    expect(onWorkspacesChanged).toHaveBeenCalledOnce();
  });

  it("validates workspace role references inside the role operation lock", async () => {
    const input = { name: "Party", slots: workspace.slots };

    await expect(handlers.get(IPC_CHANNELS.workspacesCreate)?.({}, input)).resolves.toEqual(workspace);

    expect(browserManager.runRoleOperation).toHaveBeenCalledWith(["role-1", "role-2"], expect.any(Function));
    expect(roleStore.getRole).toHaveBeenCalledWith("role-1");
    expect(roleStore.getRole).toHaveBeenCalledWith("role-2");
    expect(workspaceStore.createWorkspace).toHaveBeenCalledWith(input);

    vi.mocked(roleStore.getRole).mockRejectedValueOnce(new Error("Role not found."));
    await expect(
      handlers.get(IPC_CHANNELS.workspacesUpdate)?.({}, workspace.id, { slots: workspace.slots })
    ).rejects.toThrow("Role not found.");
    expect(workspaceStore.updateWorkspace).not.toHaveBeenCalled();
  });

  it("syncs the overlay language preference", async () => {
    await handlers.get(IPC_CHANNELS.preferencesSetOverlayLanguage)?.({}, "zh-CN");

    expect(onOverlayLanguageChanged).toHaveBeenCalledWith("zh-CN");
    expect(() => handlers.get(IPC_CHANNELS.preferencesSetOverlayLanguage)?.({}, "fr")).toThrow(
      "Language setting is invalid."
    );
  });

  it("exposes versioned legal acceptance and application quit handlers", async () => {
    const input = {
      termsVersion: "2026-07-14",
      fairUseVersion: "2026-07-14",
      privacyVersion: "2026-07-14"
    };

    await expect(handlers.get(IPC_CHANNELS.legalStatus)?.({})).resolves.toMatchObject({ isAccepted: false });
    await expect(handlers.get(IPC_CHANNELS.legalAccept)?.({}, input)).resolves.toMatchObject({ isAccepted: true });
    expect(legalAcceptanceStore.accept).toHaveBeenCalledWith(input);
    expect(onLegalAccepted).toHaveBeenCalledOnce();

    await handlers.get(IPC_CHANNELS.appQuit)?.({});
    expect(quitApplication).toHaveBeenCalledOnce();
  });

  it("rejects malformed legal acceptance input", async () => {
    await expect(handlers.get(IPC_CHANNELS.legalAccept)?.({}, { termsVersion: "2026-07-14" })).rejects.toThrow(
      "Legal acceptance input is invalid"
    );
    expect(legalAcceptanceStore.accept).not.toHaveBeenCalled();
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

    expect(result).toEqual({
      kind: "launched",
      displayId: 11,
      statuses: [
        { roleId: "role-1", state: "running" },
        { roleId: "role-2", state: "running" }
      ]
    });
    expect(browserManager.launchWorkspace).toHaveBeenCalledWith(
      workspace,
      [
        { role: expect.objectContaining({ id: "role-1" }), rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: expect.objectContaining({ id: "role-2" }), rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ],
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } }
    );
    expect(browserManager.launch).not.toHaveBeenCalled();
  });

  it("lists displays and launches on a saved or one-time target without changing the workspace", async () => {
    const fixedWorkspace = { ...workspace, targetDisplayId: 22 };
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue(fixedWorkspace);

    expect(handlers.get(IPC_CHANNELS.workspacesDisplays)?.({})).toEqual(workspaceDisplays);
    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, fixedWorkspace.id)).resolves.toMatchObject({
      kind: "launched",
      displayId: 22
    });
    expect(browserManager.launchWorkspace).toHaveBeenLastCalledWith(
      fixedWorkspace,
      expect.any(Array),
      { displayId: 22, workArea: workspaceDisplays[1].workArea }
    );

    await expect(
      handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, fixedWorkspace.id, { displayId: 11 })
    ).resolves.toMatchObject({ kind: "launched", displayId: 11 });
    expect(workspaceStore.getWorkspace).toHaveBeenCalledTimes(2);
    expect(browserManager.launchWorkspace).toHaveBeenLastCalledWith(
      fixedWorkspace,
      expect.any(Array),
      { displayId: 11, workArea: workspaceDisplays[0].workArea }
    );
  });

  it("accepts an opaque negative Windows display ID for a one-time launch", async () => {
    const windowsDisplay = {
      ...workspaceDisplays[1],
      id: -22,
      label: "Portrait display",
      bounds: { x: -1024, y: -200, width: 1024, height: 1280 },
      workArea: { x: -984, y: -200, width: 984, height: 1280 },
      resolution: { width: 1280, height: 1600 },
      scaleFactor: 1.25
    };
    workspaceDisplays.push(windowsDisplay);

    await expect(
      handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id, { displayId: -22 })
    ).resolves.toMatchObject({ kind: "launched", displayId: -22 });
    expect(browserManager.launchWorkspace).toHaveBeenLastCalledWith(
      workspace,
      expect.any(Array),
      { displayId: -22, workArea: windowsDisplay.workArea }
    );
  });

  it("requests a new display when the target is occupied or unavailable", async () => {
    vi.mocked(browserManager.listWorkspaceDisplayReservations).mockReturnValue([
      { workspaceId: "workspace-2", workspaceName: "Raid", displayId: 11 }
    ]);

    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id)).resolves.toMatchObject({
      kind: "display_selection_required",
      reason: "target_occupied",
      displays: [
        { id: 11, occupiedByWorkspace: { id: "workspace-2", name: "Raid" } },
        { id: 22 }
      ]
    });
    expect(browserManager.launchWorkspace).not.toHaveBeenCalled();

    workspaceStore.getWorkspace = vi.fn().mockResolvedValue({ ...workspace, targetDisplayId: 99 });
    vi.mocked(browserManager.listWorkspaceDisplayReservations).mockReturnValue([]);
    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id)).resolves.toMatchObject({
      kind: "display_selection_required",
      reason: "target_unavailable"
    });
  });

  it("returns the latest occupancy when an atomic display reservation loses a race", async () => {
    vi.mocked(browserManager.launchWorkspace).mockRejectedValueOnce(
      new BrowserWorkspaceDisplayOccupiedError(11, "workspace-2")
    );
    vi.mocked(browserManager.listWorkspaceDisplayReservations)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ workspaceId: "workspace-2", workspaceName: "Raid", displayId: 11 }]);

    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id)).resolves.toMatchObject({
      kind: "display_selection_required",
      reason: "target_occupied",
      displays: [
        { id: 11, occupiedByWorkspace: { id: "workspace-2", name: "Raid" } },
        { id: 22 }
      ]
    });
  });

  it("rejects malformed one-time display selections", async () => {
    await expect(
      handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, workspace.id, { displayId: -1 })
    ).rejects.toThrow("Launch workspace display selection is invalid.");
    expect(browserManager.launchWorkspace).not.toHaveBeenCalled();
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
      ]),
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } }
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
      ]),
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } }
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
    roleIds: ["role-1"],
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };

  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<
    BrowserManager,
    "launch" | "listStatuses" | "on" | "runRoleOperation" | "stop" | "stopRoleAndRunMutation"
  >;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let macroStore: Pick<
    MacroStore,
    "createMacro" | "deleteMacro" | "deleteRoleMacros" | "listMacros" | "updateMacro"
  >;
  let macroManager: Pick<
    MacroManager,
    "listStatuses" | "on" | "runStoppedMutation" | "start" | "stop" | "stopAndRunMutation" | "stopRole"
  >;
  let consumePendingMacroEditorRequest: AnyMock;

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
      runRoleOperation: vi.fn(async (_roleIds: string[], operation: () => Promise<unknown>) => operation()) as never,
      stop: vi.fn().mockResolvedValue(undefined),
      stopRoleAndRunMutation: vi.fn(async (roleId: string, operation: () => Promise<unknown>) => {
        await browserManager.stop(roleId);
        return operation();
      }) as never
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
      start: vi.fn().mockResolvedValue([
        {
          roleId: "role-1",
          macroId: "macro-1",
          state: "running",
          startedAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z"
        }
      ]),
      runStoppedMutation: vi.fn(async (_macroId: string, operation: () => Promise<unknown>) => operation()) as never,
      stop: vi.fn().mockResolvedValue(undefined),
      stopAndRunMutation: vi.fn(async (_macroId: string, operation: () => Promise<unknown>) => operation()) as never,
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
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).resolves.toEqual(macro);
    await expect(handlers.get(IPC_CHANNELS.macrosUpdate)?.({}, "macro-1", { name: "Updated" })).resolves.toMatchObject({
      name: "Updated"
    });

    await expect(handlers.get(IPC_CHANNELS.macrosStart)?.({}, "macro-1")).resolves.toMatchObject([
      {
        macroId: "macro-1",
        roleId: "role-1",
        state: "running"
      }
    ]);
    await expect(handlers.get(IPC_CHANNELS.macrosStop)?.({}, "macro-1")).resolves.toBeUndefined();
    expect(handlers.get(IPC_CHANNELS.macrosStatuses)?.({})).toMatchObject([
      { roleId: "role-1", macroId: "macro-1" }
    ]);

    expect(macroManager.start).toHaveBeenCalledWith("macro-1");
    expect(macroManager.stop).toHaveBeenCalledWith("macro-1");
  });

  it("rejects a macro role reference that disappears before persistence", async () => {
    vi.mocked(roleStore.getRole).mockRejectedValueOnce(new Error("Role not found."));

    await expect(
      handlers.get(IPC_CHANNELS.macrosCreate)?.({}, {
        name: "Auto heal",
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "key", code: "F2" }]
      })
    ).rejects.toThrow("Role not found.");

    expect(browserManager.runRoleOperation).toHaveBeenCalledWith(["role-1"], expect.any(Function));
    expect(macroStore.createMacro).not.toHaveBeenCalled();
  });

  it("stops and deletes running macro instances before deleting a macro", async () => {
    await handlers.get(IPC_CHANNELS.macrosDelete)?.({}, "macro-1");

    expect(macroManager.stopAndRunMutation).toHaveBeenCalledWith("macro-1", expect.any(Function));
    expect(macroStore.deleteMacro).toHaveBeenCalledWith("macro-1");
  });

  it("deletes stored macros after the browser manager stops a deleted role", async () => {
    await handlers.get(IPC_CHANNELS.rolesDelete)?.({}, "role-1");

    expect(browserManager.stop).toHaveBeenCalledWith("role-1");
    expect(macroStore.deleteRoleMacros).toHaveBeenCalledWith("role-1");
  });
});

describe("registerIpcHandlers game browser settings handlers", () => {
  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<
    BrowserManager,
    "listStatuses" | "on" | "setWorkspaceAppearanceSettings" | "stop"
  >;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let gameBrowserSettingsStore: {
    getSettings: AnyMock;
    updateSettings: AnyMock;
  };
  let systemFontService: {
    listFonts: AnyMock;
  };
  let getGraphicsDiagnostics: AnyMock;
  let restartApplication: AnyMock;
  const settings: GameBrowserSettings = {
    fonts: {
      families: {
        fixed: "Courier New",
        standard: "Arial"
      },
      mode: "custom"
    },
    graphics: { mode: "automatic" },
    launchMode: "auto",
    network: DEFAULT_BROWSER_NETWORK_SETTINGS,
    workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
  };
  const fonts: SystemFontFamily[] = [
    { family: "Arial", label: "Arial" },
    { family: "Courier New", label: "Courier New" }
  ];

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
      setWorkspaceAppearanceSettings: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    gameBrowserSettingsStore = {
      getSettings: vi.fn().mockResolvedValue(settings),
      updateSettings: vi.fn().mockResolvedValue(settings)
    };
    systemFontService = {
      listFonts: vi.fn().mockResolvedValue(fonts)
    };
    getGraphicsDiagnostics = vi.fn().mockResolvedValue({ appliedMode: "automatic" });
    restartApplication = vi.fn();

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        gameBrowserSettingsStore,
        getGraphicsDiagnostics,
        restartApplication,
        systemFontService
      }
    );
  });

  it("exposes get, update, and font list handlers", async () => {
    await expect(handlers.get(IPC_CHANNELS.gameBrowserSettingsGet)?.({})).resolves.toEqual(settings);
    await expect(handlers.get(IPC_CHANNELS.gameBrowserSettingsUpdate)?.({}, settings)).resolves.toEqual(settings);
    await expect(handlers.get(IPC_CHANNELS.systemFontsList)?.({})).resolves.toEqual(fonts);

    expect(gameBrowserSettingsStore.getSettings).toHaveBeenCalledTimes(1);
    expect(gameBrowserSettingsStore.updateSettings).toHaveBeenCalledWith(settings);
    expect(browserManager.setWorkspaceAppearanceSettings).toHaveBeenCalledWith(settings.workspace);
    expect(systemFontService.listFonts).toHaveBeenCalledTimes(1);
  });

  it("collects diagnostics from the requesting renderer and protects application restart", async () => {
    const sender = { id: 42 };
    await expect(
      handlers.get(IPC_CHANNELS.graphicsDiagnosticsGet)?.({ sender })
    ).resolves.toEqual({ appliedMode: "automatic" });
    expect(getGraphicsDiagnostics).toHaveBeenCalledWith(sender);

    await handlers.get(IPC_CHANNELS.appRestart)?.({});
    expect(restartApplication).toHaveBeenCalledOnce();

    vi.mocked(browserManager.listStatuses).mockReturnValueOnce([
      { roleId: "role-1", state: "running", runtimeMode: "embedded" }
    ]);
    expect(() => handlers.get(IPC_CHANNELS.appRestart)?.({})).toThrow(
      "Stop all running roles before restarting Rion Studio."
    );
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

describe("registerIpcHandlers portable data handlers", () => {
  const allPortableData = {
    roles: true,
    launchWorkspaces: true,
    macros: true,
    preferences: true
  } as const;
  let roleStore: Pick<RoleStore, "deleteRole" | "getRole">;
  let workspaceStore: Pick<LaunchWorkspaceStore, "clearRole" | "getWorkspace">;
  let browserManager: Pick<
    BrowserManager,
    "listStatuses" | "on" | "setWorkspaceAppearanceSettings" | "stop"
  >;
  let authManager: Pick<AuthManager, "listStatuses" | "on">;
  let portableDataManager: {
    applyImport: AnyMock;
    exportData: AnyMock;
    previewImport: AnyMock;
  };
  let gameBrowserSettingsStore: {
    getSettings: AnyMock;
    updateSettings: AnyMock;
  };
  let onMacrosChanged: AnyMock;
  let onRolesChanged: AnyMock;
  let onWorkspacesChanged: AnyMock;

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
      setWorkspaceAppearanceSettings: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    };
    authManager = {
      listStatuses: vi.fn(() => []),
      on: vi.fn()
    };
    portableDataManager = {
      applyImport: vi.fn().mockResolvedValue({
        roleCount: 1,
        workspaceCount: 1,
        macroCount: 1,
        preferencesIncluded: true,
        selection: allPortableData,
        warnings: []
      }),
      exportData: vi.fn().mockResolvedValue({
        filePath: "/tmp/rion.json",
        roleCount: 1,
        workspaceCount: 0,
        macroCount: 0,
        preferencesIncluded: false,
        selection: { ...allPortableData, launchWorkspaces: false, macros: false, preferences: false }
      }),
      previewImport: vi.fn().mockResolvedValue({ importId: "import-1", roleCount: 1, workspaceCount: 1, macroCount: 1, warnings: [] })
    };
    gameBrowserSettingsStore = {
      getSettings: vi.fn(),
      updateSettings: vi.fn().mockResolvedValue(undefined)
    };
    onMacrosChanged = vi.fn();
    onRolesChanged = vi.fn();
    onWorkspacesChanged = vi.fn();

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        gameBrowserSettingsStore,
        onMacrosChanged,
        onRolesChanged,
        onWorkspacesChanged,
        portableDataManager
      }
    );
  });

  it("exposes portable export, preview, and apply handlers", async () => {
    const importInput = { importId: "import-1", selection: allPortableData };

    await expect(
      handlers.get(IPC_CHANNELS.portableExport)?.({}, { preferences: { language: "zh-TW", themeMode: "dark" } })
    ).resolves.toMatchObject({ filePath: "/tmp/rion.json" });
    await expect(handlers.get(IPC_CHANNELS.portableImportPreview)?.({})).resolves.toMatchObject({
      importId: "import-1"
    });
    await expect(handlers.get(IPC_CHANNELS.portableImportApply)?.({}, importInput)).resolves.toMatchObject({
      roleCount: 1,
      workspaceCount: 1,
      macroCount: 1
    });

    expect(portableDataManager.exportData).toHaveBeenCalledWith({
      preferences: { language: "zh-TW", themeMode: "dark" }
    });
    expect(portableDataManager.previewImport).toHaveBeenCalledTimes(1);
    expect(portableDataManager.applyImport).toHaveBeenCalledWith(importInput);
    expect(onRolesChanged).toHaveBeenCalledTimes(1);
    expect(onWorkspacesChanged).toHaveBeenCalledTimes(1);
    expect(onMacrosChanged).toHaveBeenCalledTimes(1);
  });

  it("applies imported game browser settings after portable import", async () => {
    const importedSettings: GameBrowserSettings = {
      fonts: {
        families: {
          math: "Noto Sans Math",
          standard: "Arial"
        },
        mode: "custom"
      },
      graphics: { mode: "automatic" },
      launchMode: "auto",
      network: DEFAULT_BROWSER_NETWORK_SETTINGS,
      workspace: { background: "black", gap: 16 }
    };
    portableDataManager.applyImport.mockResolvedValueOnce({
      macroCount: 0,
      preferencesIncluded: true,
      preferences: {
        gameBrowserSettings: importedSettings
      },
      roleCount: 0,
      selection: {
        roles: false,
        launchWorkspaces: false,
        macros: false,
        preferences: true
      },
      warnings: [],
      workspaceCount: 0
    });
    gameBrowserSettingsStore.updateSettings.mockResolvedValueOnce(importedSettings);

    await handlers.get(IPC_CHANNELS.portableImportApply)?.({}, {
      importId: "import-1",
      selection: { roles: false, launchWorkspaces: false, macros: false, preferences: true }
    });

    expect(gameBrowserSettingsStore.updateSettings).toHaveBeenCalledWith(importedSettings);
    expect(browserManager.setWorkspaceAppearanceSettings).toHaveBeenCalledWith(importedSettings.workspace);
    expect(onRolesChanged).not.toHaveBeenCalled();
    expect(onWorkspacesChanged).not.toHaveBeenCalled();
    expect(onMacrosChanged).not.toHaveBeenCalled();
  });
});
