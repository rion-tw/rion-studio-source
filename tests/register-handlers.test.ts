import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { IPC_CHANNELS } from "../src/shared/ipc";
import { DEFAULT_MACRO_BADGE_POSITION } from "../src/shared/macroOverlay";
import type { AuthManager } from "../src/main/auth/AuthManager";
import {
  BrowserWorkspaceDisplayOccupiedError,
  type BrowserManager
} from "../src/main/browser/BrowserManager";
import { registerIpcHandlers } from "../src/main/ipc/registerHandlers";
import type { ChromeProfileImportManager } from "../src/main/browser/ChromeProfileImportManager";
import type { MacroManager } from "../src/main/macros/MacroManager";
import type { MacroStore } from "../src/main/macros/MacroStore";
import type { GameStore } from "../src/main/games/GameStore";
import type { GameCompatibilityManager } from "../src/main/games/GameCompatibilityManager";
import type { RoleStore } from "../src/main/roles/RoleStore";
import type { AppUpdateManager } from "../src/main/updates/AppUpdateManager";
import type { LaunchWorkspaceStore } from "../src/main/workspaces/LaunchWorkspaceStore";
import {
  DEFAULT_BROWSER_NETWORK_SETTINGS,
  DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
} from "../src/shared/browserFonts";
import type {
  GameBrowserSettings,
  Game,
  LaunchWorkspace,
  Macro,
  MacroSettings,
  Role,
  SystemFontFamily,
  WorkspaceDisplayInfo
} from "../src/shared/types";
import { createWorkspaceDisplayTarget } from "../src/shared/workspaceDisplays";

type AnyMock = Mock;

const { fromWebContents, handlers, listeners } = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(channel, listener);
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
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  notes: "",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const customGame: Game = {
  id: "game-1",
  source: "custom",
  name: "Example",
  defaultLaunchUrl: "https://example.com/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  browserLaunchMode: "inherit",
  browserZoomMode: "fixed",
  name: "Party",
  template: "two_columns",
  browserZoomPercent: 100,
  resourcePolicy: { mode: "unrestricted" },
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
  let roleStore: Pick<RoleStore, "createRole" | "deleteRole" | "getRole" | "listRoles" | "reorderRoles" | "updateRole">;
  let gameStore: Pick<GameStore, "createGame" | "deleteGame" | "getGame" | "listGames" | "resetBuiltinGame" | "updateGame">;
  let gameCompatibilityManager: Pick<GameCompatibilityManager, "cancelCheck" | "deleteGame" | "listReports" | "listStatuses" | "on" | "recordObservation" | "runCheck">;
  let workspaceStore: Pick<
    LaunchWorkspaceStore,
    "clearRole" | "createWorkspace" | "deleteWorkspace" | "getWorkspace" | "listWorkspaces" | "reorderWorkspaces" | "updateWorkspace"
  >;
  let browserManager: Pick<
    BrowserManager,
    | "launch"
    | "launchWorkspace"
    | "listEmbeddedRuntimeState"
    | "listStatuses"
    | "listWorkspaceDisplayReservations"
    | "moveRuntimeTab"
    | "on"
    | "runRoleOperation"
    | "showEmbeddedRuntimeWindows"
    | "showRuntimeTab"
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
  let roleBrowserDataManager: { clear: AnyMock };
  let chromeProfileImportManager: Pick<ChromeProfileImportManager, "applyImport" | "closeChrome" | "discardImport" | "previewImport">;
  let consumePendingWorkspaceLaunchRequest: AnyMock;
  let quitApplication: AnyMock;
  let legalAcceptanceStore: {
    accept: AnyMock;
    getStatus: AnyMock;
  };
  let workspaceDisplays: WorkspaceDisplayInfo[];

  beforeEach(() => {
    handlers.clear();
    roleStore = {
      createRole: vi.fn(async (input) => ({ ...authenticatedRole, ...input })),
      deleteRole: vi.fn().mockResolvedValue(undefined),
      getRole: vi.fn(async (id: string) => ({
        ...authenticatedRole,
        id,
        authState: id === "role-2" ? "authenticated" : authenticatedRole.authState
      })),
      listRoles: vi.fn().mockResolvedValue([authenticatedRole]),
      reorderRoles: vi.fn().mockResolvedValue([authenticatedRole]),
      updateRole: vi.fn(async (_id, input) => ({ ...authenticatedRole, ...input }))
    };
    gameStore = {
      createGame: vi.fn(async (input) => ({ ...customGame, ...input })),
      deleteGame: vi.fn().mockResolvedValue(undefined),
      getGame: vi.fn(async (id) => ({ ...customGame, id })),
      listGames: vi.fn().mockResolvedValue([customGame]),
      resetBuiltinGame: vi.fn().mockResolvedValue(customGame),
      updateGame: vi.fn(async (_id, input) => ({ ...customGame, ...input }))
    };
    gameCompatibilityManager = {
      cancelCheck: vi.fn().mockResolvedValue(undefined),
      deleteGame: vi.fn().mockResolvedValue(undefined),
      listReports: vi.fn().mockResolvedValue([]),
      listStatuses: vi.fn(() => []),
      on: vi.fn(),
      recordObservation: vi.fn().mockResolvedValue(undefined),
      runCheck: vi.fn().mockResolvedValue({ gameId: customGame.id, isStale: false, observations: {} })
    };
    workspaceStore = {
      clearRole: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue(workspace),
      deleteWorkspace: vi.fn().mockResolvedValue(undefined),
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
      listEmbeddedRuntimeState: vi.fn(() => ({ windows: [], tabs: [] })),
      listStatuses: vi.fn(() => []),
      listWorkspaceDisplayReservations: vi.fn(() => []),
      moveRuntimeTab: vi.fn(),
      on: vi.fn(),
      runRoleOperation: vi.fn(async (_roleIds: string[], operation: () => Promise<unknown>) => operation()) as never,
      showEmbeddedRuntimeWindows: vi.fn(),
      showRuntimeTab: vi.fn(),
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
    roleBrowserDataManager = {
      clear: vi.fn(async (id: string) => ({ ...authenticatedRole, id, authState: "login_required" as const }))
    };
    chromeProfileImportManager = {
      applyImport: vi.fn(async (_input, onProgress) => {
        onProgress?.({
          completedProfileCount: 1,
          importId: "import-1",
          phase: "completed",
          totalProfileCount: 1
        });
        return {
          roles: [{ ...authenticatedRole, id: "imported-role" }],
          verifications: [{
            embedded: { mode: "embedded" as const, state: "authenticated" as const },
            external: { mode: "external" as const, state: "authenticated" as const },
            profileId: "Default",
            profileName: "Primary",
            roleId: "imported-role"
          }],
          warnings: [{ code: "passwords_excluded" as const }]
        };
      }),
      closeChrome: vi.fn().mockResolvedValue(undefined),
      discardImport: vi.fn().mockResolvedValue(undefined),
      previewImport: vi.fn().mockResolvedValue({
        importId: "import-1",
        profiles: [{ directoryName: "Default", id: "Default", name: "Primary" }],
        sourceLabel: "Chrome",
        warnings: [{ code: "passwords_excluded" as const }]
      })
    };
    consumePendingWorkspaceLaunchRequest = vi.fn(() => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      result: {
        kind: "display_selection_required",
        reason: "target_occupied",
        displays: []
      }
    }));
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
        consumePendingWorkspaceLaunchRequest,
        gameCompatibilityManager,
        gameStore,
        legalAcceptanceStore,
        getDefaultWorkspaceDisplayId: () => 11,
        getWorkspaceDisplays: () => workspaceDisplays,
        onLegalAccepted,
        onOverlayLanguageChanged,
        onRendererReady,
        onRolesChanged,
        onWorkspacesChanged,
        quitApplication,
        roleBrowserDataManager,
        chromeProfileImportManager
      }
    );
  });

  it("returns initial renderer data through one snapshot handler", async () => {
    await expect(handlers.get(IPC_CHANNELS.appSnapshot)?.({})).resolves.toEqual({
      games: [customGame],
      gameCompatibilityReports: [],
      gameCompatibilityStatuses: [],
      roles: [authenticatedRole],
      roleStatuses: [],
      authStatuses: [],
      launchWorkspaces: [workspace],
      embeddedRuntimeState: { windows: [], tabs: [] },
      workspaceDisplays,
      macros: [],
      macroStatuses: []
    });
    expect(roleStore.listRoles).toHaveBeenCalledOnce();
    expect(workspaceStore.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("exposes validated runtime window and tab controls", async () => {
    const runtimeState = {
      windows: [{
        displayId: 11,
        bounds: workspaceDisplays[0].workArea,
        visible: false,
        activeTabId: "tab-1",
        tabCount: 1
      }],
      tabs: [{
        id: "tab-1",
        type: "role" as const,
        sourceId: authenticatedRole.id,
        name: authenticatedRole.name,
        displayId: 11,
        roleIds: [authenticatedRole.id],
        hidden: false,
        active: false,
        audible: false,
        audioMuted: false
      }]
    };
    vi.mocked(browserManager.listEmbeddedRuntimeState).mockReturnValue(runtimeState);

    expect(await handlers.get(IPC_CHANNELS.runtimeState)?.({})).toEqual(runtimeState);
    await handlers.get(IPC_CHANNELS.runtimeShowWindows)?.({}, 11);
    await handlers.get(IPC_CHANNELS.runtimeShowTab)?.({}, "tab-1");
    await handlers.get(IPC_CHANNELS.runtimeMoveTab)?.({}, "tab-1", 22);

    expect(browserManager.showEmbeddedRuntimeWindows).toHaveBeenCalledWith(11);
    expect(browserManager.showRuntimeTab).toHaveBeenCalledWith("tab-1");
    expect(browserManager.moveRuntimeTab).toHaveBeenCalledWith("tab-1", 22);
    expect(() => handlers.get(IPC_CHANNELS.runtimeMoveTab)?.({}, "", 1.5)).toThrow(
      "Runtime tab move is invalid."
    );
  });

  it("consumes pending native-menu workspace launch requests", () => {
    expect(handlers.get(IPC_CHANNELS.workspacesConsumeLaunchRequest)?.({})).toMatchObject({
      workspaceId: workspace.id,
      result: { kind: "display_selection_required", reason: "target_occupied" }
    });
    expect(consumePendingWorkspaceLaunchRequest).toHaveBeenCalledOnce();
  });

  it("exposes game CRUD and validates role game references", async () => {
    await expect(handlers.get(IPC_CHANNELS.gamesList)?.({})).resolves.toEqual([customGame]);
    await expect(handlers.get(IPC_CHANNELS.gamesCreate)?.({}, {
      name: "Another",
      defaultLaunchUrl: "https://another.test"
    })).resolves.toMatchObject({ name: "Another" });
    await expect(handlers.get(IPC_CHANNELS.gamesUpdate)?.({}, customGame.id, {
      browserLaunchMode: "external"
    })).resolves.toMatchObject({ browserLaunchMode: "external" });
    await expect(handlers.get(IPC_CHANNELS.gamesResetBuiltin)?.({}, customGame.id)).resolves.toBe(customGame);
    await expect(handlers.get(IPC_CHANNELS.gamesDelete)?.({}, customGame.id)).resolves.toBeUndefined();

    vi.mocked(gameStore.getGame).mockResolvedValueOnce({
      ...customGame,
      defaultLaunchUrl: "https://defaults.test/play"
    });
    await handlers.get(IPC_CHANNELS.rolesCreate)?.({}, { gameId: customGame.id, name: "Defaults" });
    expect(roleStore.createRole).toHaveBeenLastCalledWith(expect.objectContaining({
      gameId: customGame.id,
      launchUrl: "https://defaults.test/play"
    }));
    vi.mocked(roleStore.createRole).mockClear();

    vi.mocked(gameStore.getGame).mockRejectedValueOnce(new Error("Game not found."));
    await expect(handlers.get(IPC_CHANNELS.rolesCreate)?.({}, {
      gameId: "missing",
      name: "Invalid"
    })).rejects.toThrow("Game not found");
    expect(roleStore.createRole).not.toHaveBeenCalled();
  });

  it("runs ordinary data edits through the shared mutation coordinator", async () => {
    const withDataMutation = vi.fn((operation: () => Promise<unknown>) => operation());
    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        gameCompatibilityManager,
        gameStore,
        withDataMutation: withDataMutation as never
      }
    );

    await handlers.get(IPC_CHANNELS.gamesCreate)?.({}, {
      name: "Coordinated",
      defaultLaunchUrl: "https://coordinated.example/play"
    });

    expect(withDataMutation).toHaveBeenCalledTimes(1);
    expect(gameStore.createGame).toHaveBeenCalledTimes(1);
  });

  it("bulk deletes games in order, de-duplicates ids, and reports protected or in-use games", async () => {
    vi.mocked(gameStore.deleteGame).mockImplementation(async (id) => {
      if (id === "builtin") {
        throw Object.assign(new Error("Built-in games cannot be deleted."), {
          code: "GAME_BUILTIN_DELETE_FORBIDDEN"
        });
      }
      if (id === "in-use") {
        throw Object.assign(new Error("Move or delete assigned roles before deleting this game."), {
          code: "GAME_IN_USE",
          details: { roleNames: ["Main"] }
        });
      }
    });

    await expect(handlers.get(IPC_CHANNELS.gamesDeleteMany)?.({}, {
      ids: ["ok", "builtin", "in-use", "ok"]
    })).resolves.toEqual({
      deletedIds: ["ok"],
      skipped: [
        { id: "builtin", reason: "protected" },
        { id: "in-use", reason: "in_use", relatedNames: ["Main"] }
      ]
    });
    expect(gameStore.deleteGame).toHaveBeenCalledTimes(3);
    expect(gameCompatibilityManager.deleteGame).toHaveBeenCalledOnce();
    expect(gameCompatibilityManager.deleteGame).toHaveBeenCalledWith("ok");
  });

  it("bulk deletes roles and workspaces while continuing after missing records", async () => {
    vi.mocked(roleStore.deleteRole).mockImplementation(async (id) => {
      if (id === "role-missing") {
        throw Object.assign(new Error("Role not found."), { code: "ROLE_NOT_FOUND" });
      }
    });
    vi.mocked(workspaceStore.deleteWorkspace).mockImplementation(async (id) => {
      if (id === "workspace-missing") {
        throw Object.assign(new Error("Launch workspace not found."), { code: "WORKSPACE_NOT_FOUND" });
      }
    });

    await expect(handlers.get(IPC_CHANNELS.rolesDeleteMany)?.({}, {
      ids: ["role-1", "role-missing", "role-2"]
    })).resolves.toEqual({
      deletedIds: ["role-1", "role-2"],
      skipped: [{ id: "role-missing", reason: "not_found" }]
    });
    expect(workspaceStore.clearRole).toHaveBeenCalledTimes(2);

    await expect(handlers.get(IPC_CHANNELS.workspacesDeleteMany)?.({}, {
      ids: ["workspace-1", "workspace-missing"]
    })).resolves.toEqual({
      deletedIds: ["workspace-1"],
      skipped: [{ id: "workspace-missing", reason: "not_found" }]
    });
    expect(browserManager.stopWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(browserManager.stopWorkspace).toHaveBeenCalledWith("workspace-missing");
  });

  it("rejects malformed bulk delete inputs", async () => {
    await expect(handlers.get(IPC_CHANNELS.rolesDeleteMany)?.({}, { ids: ["role-1", ""] }))
      .rejects.toThrow("Bulk delete input is invalid.");
    expect(roleStore.deleteRole).not.toHaveBeenCalled();
  });

  it("runs compatibility checks from the current work area", async () => {
    await handlers.get(IPC_CHANNELS.gamesCompatibilityRun)?.({}, customGame.id);

    expect(gameCompatibilityManager.runCheck).toHaveBeenCalledWith(customGame.id);
  });

  it("records launch mode, fallback, and stable failures as game observations", async () => {
    vi.mocked(browserManager.launch).mockResolvedValueOnce({
      roleId: authenticatedRole.id,
      state: "running",
      runtimeMode: "external",
      notice: "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support."
    });
    await handlers.get(IPC_CHANNELS.rolesLaunch)?.({}, authenticatedRole.id);
    expect(gameCompatibilityManager.recordObservation).toHaveBeenCalledWith(customGame.id, expect.objectContaining({
      lastExternalSuccessAt: expect.any(String),
      lastFallbackAt: expect.any(String)
    }));

    vi.mocked(browserManager.launch).mockRejectedValueOnce(Object.assign(new Error("failed"), { code: "GAME_PAGE_LOAD_FAILED" }));
    await expect(handlers.get(IPC_CHANNELS.rolesLaunch)?.({}, authenticatedRole.id)).rejects.toThrow("failed");
    expect(gameCompatibilityManager.recordObservation).toHaveBeenLastCalledWith(customGame.id, expect.objectContaining({
      lastLaunchFailureAt: expect.any(String),
      lastLaunchFailureCode: "GAME_PAGE_LOAD_FAILED"
    }));
  });

  it("stops a role before changing its game or launch URL but not for metadata-only edits", async () => {
    await expect(handlers.get(IPC_CHANNELS.rolesUpdate)?.({}, authenticatedRole.id, {
      notes: "Metadata only"
    })).resolves.toMatchObject({ notes: "Metadata only" });
    expect(browserManager.stopRoleAndRunMutation).not.toHaveBeenCalled();

    await expect(handlers.get(IPC_CHANNELS.rolesUpdate)?.({}, authenticatedRole.id, {
      gameId: "game-2"
    })).resolves.toMatchObject({ gameId: "game-2" });
    expect(gameStore.getGame).toHaveBeenCalledWith("game-2");
    expect(browserManager.stopRoleAndRunMutation).toHaveBeenCalledWith(
      authenticatedRole.id,
      expect.any(Function)
    );
  });

  it("clears isolated role browser data and returns the updated authentication state", async () => {
    await expect(
      handlers.get(IPC_CHANNELS.rolesClearBrowserData)?.({}, authenticatedRole.id)
    ).resolves.toMatchObject({
      id: authenticatedRole.id,
      authState: "login_required"
    });

    expect(roleBrowserDataManager.clear).toHaveBeenCalledWith(authenticatedRole.id);
    expect(onRolesChanged).toHaveBeenCalledOnce();
  });

  it("requires consent and coordinates Chrome profile import through the mutation lock", async () => {
    await expect(handlers.get(IPC_CHANNELS.chromeProfileImportPreview)?.({})).resolves.toMatchObject({
      importId: "import-1"
    });
    expect(() => handlers.get(IPC_CHANNELS.chromeProfileImportApply)?.({}, {
      consentAccepted: false,
      gameId: customGame.id,
      importId: "import-1",
      profileIds: ["Default"]
    })).toThrow("Chrome profile import input is invalid.");

    const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const result = await handlers.get(IPC_CHANNELS.chromeProfileImportApply)?.({ sender }, {
      consentAccepted: true,
      gameId: customGame.id,
      importId: "import-1",
      profileIds: ["Default"]
    });
    expect(result).toMatchObject({ roles: [{ id: "imported-role" }] });
    expect(chromeProfileImportManager.applyImport).toHaveBeenCalledWith(
      {
        consentAccepted: true,
        gameId: customGame.id,
        importId: "import-1",
        profileIds: ["Default"]
      },
      expect.any(Function)
    );
    expect(onRolesChanged).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      IPC_CHANNELS.chromeProfileImportProgress,
      expect.objectContaining({ completedProfileCount: 1, totalProfileCount: 1 })
    );

    await handlers.get(IPC_CHANNELS.chromeProfileImportDiscard)?.({}, "import-1");
    expect(chromeProfileImportManager.discardImport).toHaveBeenCalledWith("import-1");
  });

  it("coordinates the graceful Chrome close request through IPC", async () => {
    await handlers.get(IPC_CHANNELS.chromeProfileImportCloseChrome)?.({});

    expect(chromeProfileImportManager.closeChrome).toHaveBeenCalledOnce();
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

  it("canonicalizes a rebound target display before persisting workspace input", async () => {
    const oldTarget = createWorkspaceDisplayTarget({ ...workspaceDisplays[1], id: 1493485485 });

    await handlers.get(IPC_CHANNELS.workspacesCreate)?.({}, {
      name: "Rebound display",
      targetDisplay: oldTarget
    });

    expect(workspaceStore.createWorkspace).toHaveBeenCalledWith({
      name: "Rebound display",
      targetDisplay: createWorkspaceDisplayTarget(workspaceDisplays[1])
    });
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

  it("closes only the window that requested it and ignores a missing owner window", () => {
    const sender = { id: 42 };
    const close = vi.fn();
    fromWebContents.mockReturnValueOnce({ close });

    listeners.get(IPC_CHANNELS.appWindowClose)?.({ sender });

    expect(fromWebContents).toHaveBeenCalledWith(sender);
    expect(close).toHaveBeenCalledOnce();

    fromWebContents.mockReturnValueOnce(null);
    expect(() => listeners.get(IPC_CHANNELS.appWindowClose)?.({ sender })).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns fullscreen state only for the requesting window", async () => {
    const sender = { id: 42 };
    const isFullScreen = vi.fn(() => true);
    fromWebContents.mockReturnValueOnce({ isFullScreen });

    expect(handlers.get(IPC_CHANNELS.appWindowState)?.({ sender })).toEqual({ fullscreen: true });
    expect(fromWebContents).toHaveBeenCalledWith(sender);
    expect(isFullScreen).toHaveBeenCalledOnce();

    fromWebContents.mockReturnValueOnce(null);
    expect(() => handlers.get(IPC_CHANNELS.appWindowState)?.({ sender })).toThrow(
      "Current window is not available."
    );
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
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } },
      "embedded"
    );
    expect(browserManager.launch).not.toHaveBeenCalled();
  });

  it("uses a workspace explicit launch mode independently of role game modes", async () => {
    const externalWorkspace = { ...workspace, browserLaunchMode: "external" as const };
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue(externalWorkspace);

    await handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, externalWorkspace.id);

    expect(browserManager.launchWorkspace).toHaveBeenCalledWith(
      externalWorkspace,
      expect.any(Array),
      expect.any(Object),
      "external"
    );
  });

  it("lists displays and launches on a saved or one-time target without changing the workspace", async () => {
    const fixedWorkspace = {
      ...workspace,
      targetDisplay: createWorkspaceDisplayTarget({ ...workspaceDisplays[1], id: 1493485485 })
    };
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue(fixedWorkspace);

    expect(handlers.get(IPC_CHANNELS.workspacesDisplays)?.({})).toEqual(workspaceDisplays);
    await expect(handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, fixedWorkspace.id)).resolves.toMatchObject({
      kind: "launched",
      displayId: 22
    });
    expect(browserManager.launchWorkspace).toHaveBeenLastCalledWith(
      fixedWorkspace,
      expect.any(Array),
      { displayId: 22, workArea: workspaceDisplays[1].workArea },
      "embedded"
    );

    await expect(
      handlers.get(IPC_CHANNELS.workspacesLaunch)?.({}, fixedWorkspace.id, { displayId: 11 })
    ).resolves.toMatchObject({ kind: "launched", displayId: 11 });
    expect(workspaceStore.getWorkspace).toHaveBeenCalledTimes(2);
    expect(browserManager.launchWorkspace).toHaveBeenLastCalledWith(
      fixedWorkspace,
      expect.any(Array),
      { displayId: 11, workArea: workspaceDisplays[0].workArea },
      "embedded"
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
      { displayId: -22, workArea: windowsDisplay.workArea },
      "embedded"
    );
  });

  it("requests a new display when an external target is occupied or unavailable", async () => {
    workspaceStore.getWorkspace = vi.fn().mockResolvedValue({
      ...workspace,
      browserLaunchMode: "external"
    });
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

    workspaceStore.getWorkspace = vi.fn().mockResolvedValue({
      ...workspace,
      browserLaunchMode: "external",
      targetDisplay: { id: 99 }
    });
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
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } },
      "embedded"
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
      { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } },
      "embedded"
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
    enabled: true,
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
    "clearRoleAssignment" | "createMacro" | "deleteMacro" | "deleteMacros" | "listMacros" | "updateMacro"
  >;
  let macroManager: Pick<
    MacroManager,
    "listStatuses" | "on" | "runStoppedMutation" | "start" | "stop" |
    "stopAndRunMutation" | "stopAndRunMutations" | "stopRole"
  >;
  let consumePendingMacroPageRequest: AnyMock;

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
      deleteMacros: vi.fn(async (ids: string[]) => ({ deletedIds: ids, skipped: [] })),
      clearRoleAssignment: vi.fn().mockResolvedValue(undefined),
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
      stopAndRunMutations: vi.fn(async (_macroIds: string[], operation: () => Promise<unknown>) => operation()) as never,
      stopRole: vi.fn().mockResolvedValue(undefined)
    };
    consumePendingMacroPageRequest = vi.fn(() => ({ roleId: "role-1" }));

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        consumePendingMacroPageRequest,
        macroManager: macroManager as MacroManager,
        macroStore: macroStore as MacroStore
      }
    );
  });

  it("consumes pending macro page requests", () => {
    expect(handlers.get(IPC_CHANNELS.macrosConsumePageRequest)?.({})).toEqual({
      roleId: "role-1"
    });

    expect(consumePendingMacroPageRequest).toHaveBeenCalledTimes(1);
  });

  it("forwards validated macro overlay requests with the complete sender", async () => {
    const onMacroOverlayRequest = vi.fn().mockResolvedValue({ macros: [], statuses: [] });
    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      { onMacroOverlayRequest }
    );
    const sender = { id: 42 };

    await expect(
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.({ sender }, { type: "list" })
    ).resolves.toEqual({ macros: [], statuses: [] });
    expect(onMacroOverlayRequest).toHaveBeenCalledWith(sender, { type: "list" });
    await expect(
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.({ sender }, { type: "open" })
    ).resolves.toEqual({ macros: [], statuses: [] });
    expect(onMacroOverlayRequest).toHaveBeenCalledWith(sender, { type: "open" });
    await expect(
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.(
        { sender },
        { type: "game-input-context", active: true }
      )
    ).resolves.toEqual({ macros: [], statuses: [] });
    expect(onMacroOverlayRequest).toHaveBeenCalledWith(sender, {
      type: "game-input-context",
      active: true
    });
    expect(() =>
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.(
        { sender },
        { type: "game-input-context", active: "yes" }
      )
    ).toThrow("Macro overlay request is invalid.");
    expect(() =>
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.({ sender }, { type: "unknown" })
    ).toThrow("Macro overlay request is invalid.");
  });

  it("rejects macro overlay requests when the callback is unavailable", () => {
    expect(() =>
      handlers.get(IPC_CHANNELS.macrosOverlayRequest)?.({ sender: { id: 42 } }, { type: "list" })
    ).toThrow("Macro overlay request is invalid.");
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

  it("stops a running macro before disabling it", async () => {
    await handlers.get(IPC_CHANNELS.macrosUpdate)?.({}, macro.id, { enabled: false });

    expect(macroManager.stopAndRunMutation).toHaveBeenCalledWith(macro.id, expect.any(Function));
    expect(macroManager.runStoppedMutation).not.toHaveBeenCalled();
    expect(macroStore.updateMacro).toHaveBeenCalledWith(macro.id, { enabled: false });
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

  it("bulk-stops selected macros and applies one atomic dependency-aware deletion", async () => {
    vi.mocked(macroStore.deleteMacros).mockResolvedValue({
      deletedIds: ["macro-1", "macro-2"],
      skipped: [{ id: "macro-missing", reason: "not_found" }]
    });

    await expect(handlers.get(IPC_CHANNELS.macrosDeleteMany)?.({}, {
      ids: ["macro-1", "macro-missing", "macro-2", "macro-1"]
    })).resolves.toEqual({
      deletedIds: ["macro-1", "macro-2"],
      skipped: [{ id: "macro-missing", reason: "not_found" }]
    });
    expect(macroManager.stopAndRunMutations).toHaveBeenCalledWith(
      ["macro-1", "macro-missing", "macro-2"],
      expect.any(Function)
    );
    expect(macroStore.deleteMacros).toHaveBeenCalledWith([
      "macro-1",
      "macro-missing",
      "macro-2"
    ]);
  });

  it("clears stored macro assignments after the browser manager stops a deleted role", async () => {
    await handlers.get(IPC_CHANNELS.rolesDelete)?.({}, "role-1");

    expect(browserManager.stop).toHaveBeenCalledWith("role-1");
    expect(macroStore.clearRoleAssignment).toHaveBeenCalledWith("role-1");
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
  let macroSettingsStore: {
    getSettings: AnyMock;
    updateSettings: AnyMock;
  };
  let systemFontService: {
    listFonts: AnyMock;
  };
  let getGraphicsDiagnostics: AnyMock;
  let restartApplication: AnyMock;
  let onGameBrowserSettingsChanged: AnyMock;
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
    macroBadgePosition: DEFAULT_MACRO_BADGE_POSITION,
    network: DEFAULT_BROWSER_NETWORK_SETTINGS,
    workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
  };
  const fonts: SystemFontFamily[] = [
    { family: "Arial", label: "Arial" },
    { family: "Courier New", label: "Courier New" }
  ];
  const macroSettings: MacroSettings = {
    startupDelayMs: 100,
    keyHoldMs: 30,
    postInputDelayMs: 30,
    defaultLoopDelayMs: 1000
  };

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
    macroSettingsStore = {
      getSettings: vi.fn().mockResolvedValue(macroSettings),
      updateSettings: vi.fn().mockResolvedValue(macroSettings)
    };
    systemFontService = {
      listFonts: vi.fn().mockResolvedValue(fonts)
    };
    getGraphicsDiagnostics = vi.fn().mockResolvedValue({ appliedMode: "automatic" });
    restartApplication = vi.fn();
    onGameBrowserSettingsChanged = vi.fn();

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        gameBrowserSettingsStore,
        macroSettingsStore,
        getGraphicsDiagnostics,
        restartApplication,
        systemFontService,
        onGameBrowserSettingsChanged
      }
    );
  });

  it("exposes get, update, and font list handlers", async () => {
    await expect(handlers.get(IPC_CHANNELS.gameBrowserSettingsGet)?.({})).resolves.toEqual(settings);
    await expect(handlers.get(IPC_CHANNELS.gameBrowserSettingsUpdate)?.({}, settings)).resolves.toEqual(settings);
    await expect(handlers.get(IPC_CHANNELS.macroSettingsGet)?.({})).resolves.toEqual(macroSettings);
    await expect(handlers.get(IPC_CHANNELS.macroSettingsUpdate)?.({}, macroSettings)).resolves.toEqual(macroSettings);
    await expect(handlers.get(IPC_CHANNELS.systemFontsList)?.({})).resolves.toEqual(fonts);

    expect(gameBrowserSettingsStore.getSettings).toHaveBeenCalledTimes(1);
    expect(gameBrowserSettingsStore.updateSettings).toHaveBeenCalledWith(settings);
    expect(macroSettingsStore.getSettings).toHaveBeenCalledTimes(1);
    expect(macroSettingsStore.updateSettings).toHaveBeenCalledWith(macroSettings);
    expect(browserManager.setWorkspaceAppearanceSettings).toHaveBeenCalledWith(settings.workspace);
    expect(onGameBrowserSettingsChanged).toHaveBeenCalledTimes(1);
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
    discardImport: AnyMock;
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
  let onGameBrowserSettingsChanged: AnyMock;

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
      discardImport: vi.fn(),
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
    onGameBrowserSettingsChanged = vi.fn();

    registerIpcHandlers(
      roleStore as RoleStore,
      workspaceStore as LaunchWorkspaceStore,
      browserManager as BrowserManager,
      authManager as AuthManager,
      {
        gameBrowserSettingsStore,
        onMacrosChanged,
        onGameBrowserSettingsChanged,
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
    expect(handlers.get(IPC_CHANNELS.portableImportDiscard)?.({}, "import-1")).toBeUndefined();

    expect(portableDataManager.exportData).toHaveBeenCalledWith({
      preferences: { language: "zh-TW", themeMode: "dark" }
    });
    expect(portableDataManager.previewImport).toHaveBeenCalledTimes(1);
    expect(portableDataManager.applyImport).toHaveBeenCalledWith(importInput);
    expect(portableDataManager.discardImport).toHaveBeenCalledWith("import-1");
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
      macroBadgePosition: DEFAULT_MACRO_BADGE_POSITION,
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

    expect(gameBrowserSettingsStore.updateSettings).not.toHaveBeenCalled();
    expect(browserManager.setWorkspaceAppearanceSettings).toHaveBeenCalledWith(importedSettings.workspace);
    expect(onRolesChanged).not.toHaveBeenCalled();
    expect(onWorkspacesChanged).not.toHaveBeenCalled();
    expect(onMacrosChanged).not.toHaveBeenCalled();
    expect(onGameBrowserSettingsChanged).toHaveBeenCalledTimes(1);
  });
});
