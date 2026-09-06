import type { CoreCommand } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  createElectronCoreApiDispatcher,
  type ElectronCoreCommandPort
} from "../src/electron/main/coreApiDispatcher";
import type { RionApiDispatcher } from "../src/electron/main/registerIpcBridge";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";
import type { ElectronRuntimeLaunchPort } from
  "../src/electron/main/chromiumRuntimeLaunchCoordinator";
import type { ElectronChromiumRuntimeActionPort } from
  "../src/electron/main/chromiumRuntimeActionController";

const identity: RendererIdentity = {
  kind: "main-renderer",
  windowId: 1,
  webContentsId: 2,
  generation: 3
};

function harness(runtimeActions?: ElectronChromiumRuntimeActionPort,
  systemFonts?: (owner: RendererIdentity) => Promise<string[]>) {
  const coreInvoke = vi.fn(async (command: CoreCommand) => {
    if (command.type === "logsStatus") return { marker: "log-status" };
    return { command };
  });
  const fallbackInvoke = vi.fn(async (_identity, method) => ({ fallback: method }));
  const core = {
    invoke: coreInvoke as unknown as ElectronCoreCommandPort["invoke"]
  };
  const fallback = {
    invoke: fallbackInvoke as unknown as RionApiDispatcher["invoke"]
  };
  const launchRole = vi.fn(async () => ({ marker: "role-launch" }));
  const launchWorkspace = vi.fn(async () => ({ marker: "workspace-launch" }));
  const launches = {
    launchRole: launchRole as unknown as ElectronRuntimeLaunchPort["launchRole"],
    launchWorkspace:
      launchWorkspace as unknown as ElectronRuntimeLaunchPort["launchWorkspace"]
  };
  return {
    coreInvoke,
    dispatcher: createElectronCoreApiDispatcher(
      core,
      fallback,
      launches,
      runtimeActions,
      systemFonts
    ),
    fallbackInvoke,
    launchRole,
    launchWorkspace
  };
}

function runtimeActionHarness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const method = (name: string, value?: unknown) => vi.fn(async (...args: unknown[]) => {
    calls.push({ method: name, args });
    return value;
  });
  const actions = {
    updateGameWindow: method("updateGameWindow", { id: "window-1" }),
    showGameWindow: method("showGameWindow"),
    hideGameWindow: method("hideGameWindow", { operationId: "hide" }),
    stopGameWindow: method("stopGameWindow", { operationId: "stop-window" }),
    deleteGameWindow: method("deleteGameWindow", { operationId: "delete-window" }),
    showGameWindowTab: method("showGameWindowTab", { operationId: "show-tab" }),
    moveGameWindowTab: method("moveGameWindowTab", { operationId: "move-tab" }),
    moveGameWindowTabToNewWindow: method("moveGameWindowTabToNewWindow", {
      targetWindowId: "window-new"
    }),
    reorderGameWindowTab: method("reorderGameWindowTab", { operationId: "reorder" }),
    setGameWindowTabMuted: method("setGameWindowTabMuted", { operationId: "mute" }),
    setGameWindowTabHidden: method("setGameWindowTabHidden", { operationId: "hide-tab" }),
    stopGameWindowTab: method("stopGameWindowTab", { operationId: "stop-tab" }),
    restoreSavedGameWindows: method("restoreSavedGameWindows"),
    discardSavedGameWindows: method("discardSavedGameWindows"),
    updateRuntimeWindowPreferences: method("updateRuntimeWindowPreferences", {
      alwaysHideTabCloseButton: true,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    }),
    consumePendingQuickAccessRequest: method(
      "consumePendingQuickAccessRequest",
      { requestId: "quick-1" }
    ),
    presentQuickAccessRequest: method("presentQuickAccessRequest", true),
    resolveQuickAccessRequest: method("resolveQuickAccessRequest")
  } as unknown as ElectronChromiumRuntimeActionPort;
  return { actions, calls, ...harness(actions) };
}

describe("Electron Core-backed API dispatcher", () => {
  it("passes the authenticated Chromium font inventory to Rust", async () => {
    const fonts = vi.fn(async () => ["Arial", "PingFang TC"]);
    const h = harness(undefined, fonts);
    await h.dispatcher.invoke(identity, "listSystemFonts", []);
    expect(fonts).toHaveBeenCalledWith(identity);
    expect(h.coreInvoke).toHaveBeenCalledWith({ type: "systemFontsList", families: ["Arial", "PingFang TC"] });
  });

  it("does not cache a stale font document as successful fallback", async () => {
    const h = harness(undefined, async () => { throw new Error("retired document"); });
    await expect(h.dispatcher.invoke(identity, "listSystemFonts", [])).rejects.toThrow("retired document");
    expect(h.coreInvoke).not.toHaveBeenCalled();
  });

  it("routes read-only domain queries through the generated Rust command contract", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();

    await dispatcher.invoke(identity, "listGames", []);
    await dispatcher.invoke(identity, "listRoles", []);
    await dispatcher.invoke(identity, "listLaunchWorkspaces", []);
    await dispatcher.invoke(identity, "listMacros", []);
    await dispatcher.invoke(identity, "getGameBrowserSettings", []);
    await dispatcher.invoke(identity, "queryLogs", []);

    expect(coreInvoke.mock.calls.map(([command]) => command)).toEqual([
      { type: "gamesList" },
      { type: "rolesList" },
      { type: "workspacesList" },
      { type: "macrosList" },
      { type: "gameBrowserSettingsGet" },
      { type: "logsQuery", query: {} }
    ]);
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("normalizes renderer game and role inputs at the shared boundary", async () => {
    const { coreInvoke, dispatcher } = harness();

    await dispatcher.invoke(identity, "createGame", [{
      name: "Game",
      defaultLaunchUrl: "https://game.test",
      iconImageDataUrl: null,
      coverImageDataUrl: "data:image/png;base64,cover"
    }]);
    await dispatcher.invoke(identity, "updateGame", ["game-1", {
      name: "Renamed",
      iconImageDataUrl: null
    }]);
    await dispatcher.invoke(identity, "createRole", [{
      gameId: "game-1",
      name: "Role",
      coverImageDataUrl: null,
      coverImageDominantColor: "#123456"
    }]);
    await dispatcher.invoke(identity, "updateRole", ["role-1", {
      notes: "Updated",
      coverImageDataUrl: null,
      coverImageDominantColor: null
    }]);

    expect(coreInvoke.mock.calls.map(([command]) => command)).toEqual([
      {
        type: "gameCreate",
        input: {
          name: "Game",
          defaultLaunchUrl: "https://game.test",
          coverImageDataUrl: "data:image/png;base64,cover"
        }
      },
      {
        type: "gameUpdate",
        id: "game-1",
        input: {
          name: "Renamed",
          setIconImageDataUrl: true,
          setCoverImageDataUrl: false
        }
      },
      {
        type: "roleCreate",
        input: {
          gameId: "game-1",
          name: "Role",
          coverImageDominantColor: "#123456"
        }
      },
      {
        type: "roleUpdate",
        id: "role-1",
        input: {
          notes: "Updated",
          setCoverImageDataUrl: true,
          setCoverImageDominantColor: true
        }
      }
    ]);
  });

  it("creates a dormant Game Window definition through the authoritative Core", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();
    const input = {
      name: "Primary",
      targetDisplay: { id: 1 },
      placement: {
        normalBounds: { x: 40, y: 40, width: 1280, height: 800 },
        savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
        presentation: "maximized" as const
      }
    };

    await dispatcher.invoke(identity, "createGameWindow", [input]);

    expect(coreInvoke).toHaveBeenCalledWith({
      type: "gameWindowCreate",
      input
    });
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("preserves void results and returns the authoritative status after log mutations", async () => {
    const { coreInvoke, dispatcher } = harness();

    await expect(dispatcher.invoke(identity, "deleteGame", ["game-1"]))
      .resolves.toBeUndefined();
    await expect(dispatcher.invoke(identity, "setLogLevel", ["debug"]))
      .resolves.toEqual({ marker: "log-status" });
    await expect(dispatcher.invoke(identity, "clearLogs", []))
      .resolves.toEqual({ marker: "log-status" });

    expect(coreInvoke.mock.calls.map(([command]) => command)).toEqual([
      { type: "gameDelete", id: "game-1" },
      { type: "logsSetLevel", level: "debug" },
      { type: "logsStatus" },
      { type: "logsClear" },
      { type: "logsStatus" }
    ]);
  });

  it("routes destructive shared-profile and import commits through Core", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();
    const selection = {
      games: true,
      roles: true,
      launchWorkspaces: false,
      gameWindows: false,
      macros: true,
      preferences: true
    };

    await expect(dispatcher.invoke(identity, "clearGlobalWebProfile", []))
      .resolves.toBeUndefined();
    await dispatcher.invoke(identity, "applyPortableImport", [{
      importId: "portable-1",
      selection
    }]);
    await dispatcher.invoke(identity, "requestChromeQuitForImport", ["chrome-1"]);
    await dispatcher.invoke(identity, "applyChromeProfileImport", [{
      importId: "chrome-1",
      gameId: "game-1",
      consentAccepted: true,
      resolutions: []
    }]);

    expect(coreInvoke.mock.calls.map(([command]) => command)).toEqual([
      { type: "globalWebProfileClear" },
      {
        type: "portableApply",
        importId: "portable-1",
        selection,
        resolutions: []
      },
      { type: "chromeProfileRequestQuit", importId: "chrome-1" },
      {
        type: "chromeProfileApply",
        importId: "chrome-1",
        gameId: "game-1",
        consentAccepted: true,
        resolutions: []
      }
    ]);
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("routes stop and macro lifecycle through authoritative Core operations", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();

    await expect(dispatcher.invoke(identity, "stopRole", ["role-1"]))
      .resolves.toBeUndefined();
    await expect(dispatcher.invoke(identity, "stopLaunchWorkspace", ["workspace-1"]))
      .resolves.toBeUndefined();
    await dispatcher.invoke(identity, "startMacro", ["macro-1"]);
    await expect(dispatcher.invoke(identity, "stopMacro", ["macro-1"]))
      .resolves.toBeUndefined();

    expect(coreInvoke.mock.calls.map(([command]) => command)).toEqual([
      { type: "browserRoleStop", roleId: "role-1" },
      { type: "browserWorkspaceStop", workspaceId: "workspace-1" },
      {
        type: "macroStart",
        request: { macroId: "macro-1", sourceRoleId: null }
      },
      { type: "macroStop", macroId: "macro-1" }
    ]);
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("fails closed when tab audio mutation has no authenticated action lane", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();

    await expect(
      dispatcher.invoke(identity, "setGameWindowTabMuted", ["tab-1", true])
    ).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTIONS_UNAVAILABLE"
    });

    expect(coreInvoke).not.toHaveBeenCalled();
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("routes window, tab, recovery, preferences, and Quick Access through the authenticated action lane", async () => {
    const { dispatcher, calls, coreInvoke, fallbackInvoke } = runtimeActionHarness();
    const preferences = {
      alwaysHideTabCloseButton: true,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    };

    await dispatcher.invoke(identity, "updateGameWindow", ["window-1", { name: "Renamed" }]);
    await dispatcher.invoke(identity, "showGameWindow", ["window-1"]);
    await dispatcher.invoke(identity, "hideGameWindow", ["window-1"]);
    await dispatcher.invoke(identity, "stopGameWindow", ["window-1"]);
    await dispatcher.invoke(identity, "deleteGameWindow", ["window-1"]);
    await dispatcher.invoke(identity, "showGameWindowTab", ["tab-1"]);
    await dispatcher.invoke(identity, "moveGameWindowTab", ["tab-1", "window-2"]);
    await dispatcher.invoke(identity, "moveGameWindowTabToNewWindow", ["tab-1"]);
    await dispatcher.invoke(identity, "reorderGameWindowTab", ["tab-1", "tab-2"]);
    await dispatcher.invoke(identity, "setGameWindowTabMuted", ["tab-1", true]);
    await dispatcher.invoke(identity, "setGameWindowTabHidden", ["tab-1", true]);
    await dispatcher.invoke(identity, "stopGameWindowTab", ["tab-1"]);
    await dispatcher.invoke(identity, "restoreSavedGameWindows", [{ scope: "all" }]);
    await dispatcher.invoke(identity, "discardSavedGameWindows", [{ scope: "all" }]);
    await dispatcher.invoke(identity, "updateRuntimeWindowPreferences", [preferences]);
    await dispatcher.invoke(identity, "consumePendingQuickAccessRequest", []);
    await dispatcher.invoke(identity, "presentQuickAccessRequest", ["quick-1"]);
    await dispatcher.invoke(identity, "resolveQuickAccessRequest", ["quick-1", "cancel"]);

    expect(calls).toEqual([
      { method: "updateGameWindow", args: [identity, "window-1", { name: "Renamed" }] },
      { method: "showGameWindow", args: [identity, "window-1"] },
      { method: "hideGameWindow", args: [identity, "window-1"] },
      { method: "stopGameWindow", args: [identity, "window-1"] },
      { method: "deleteGameWindow", args: [identity, "window-1"] },
      { method: "showGameWindowTab", args: [identity, "tab-1"] },
      { method: "moveGameWindowTab", args: [identity, "tab-1", "window-2"] },
      { method: "moveGameWindowTabToNewWindow", args: [identity, "tab-1"] },
      { method: "reorderGameWindowTab", args: [identity, "tab-1", "tab-2"] },
      { method: "setGameWindowTabMuted", args: [identity, "tab-1", true] },
      { method: "setGameWindowTabHidden", args: [identity, "tab-1", true] },
      { method: "stopGameWindowTab", args: [identity, "tab-1"] },
      { method: "restoreSavedGameWindows", args: [identity, { scope: "all" }] },
      { method: "discardSavedGameWindows", args: [identity, { scope: "all" }] },
      { method: "updateRuntimeWindowPreferences", args: [identity, preferences] },
      { method: "consumePendingQuickAccessRequest", args: [identity] },
      { method: "presentQuickAccessRequest", args: [identity, "quick-1"] },
      { method: "resolveQuickAccessRequest", args: [identity, "quick-1", "cancel"] }
    ]);
    expect(coreInvoke).not.toHaveBeenCalled();
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("routes renderer launches through the v23 Chromium launch coordinator", async () => {
    const {
      coreInvoke,
      dispatcher,
      fallbackInvoke,
      launchRole,
      launchWorkspace
    } = harness();
    const destination = {
      kind: "game-window" as const,
      windowId: "10000000-0000-4000-8000-000000000001"
    };

    await expect(dispatcher.invoke(identity, "launchRole", [
      "20000000-0000-4000-8000-000000000001",
      destination
    ])).resolves.toEqual({ marker: "role-launch" });
    await expect(dispatcher.invoke(identity, "launchWorkspace", [
      "30000000-0000-4000-8000-000000000001"
    ])).resolves.toEqual({ marker: "workspace-launch" });

    expect(launchRole).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000001",
      destination
    );
    expect(launchWorkspace).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000001",
      undefined
    );
    expect(coreInvoke).not.toHaveBeenCalled();
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });

  it("never falls back from privileged runtime actions to an unsafe shell path", async () => {
    const { coreInvoke, dispatcher, fallbackInvoke } = harness();

    await expect(dispatcher.invoke(identity, "updateGameWindow", [
      "window-1",
      { name: "Renamed" }
    ])).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTIONS_UNAVAILABLE"
    });
    await dispatcher.invoke(identity, "clearRoleBrowserData", ["role-1"]);
    expect(coreInvoke).toHaveBeenCalledWith({
      type: "roleBrowserDataClear",
      roleId: "role-1"
    });
    expect(fallbackInvoke).not.toHaveBeenCalled();
  });
});
