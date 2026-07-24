import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  type BrowserWorkspaceLaunchTarget,
  type ElectronBrowserRuntime,
  type EmbeddedRestoreTabInput
} from "../src/main/browser/ElectronBrowserRuntime";
import { RuntimeSessionManager } from "../src/main/browser/RuntimeSessionManager";
import type { AppCoreClient } from "../src/main/core/nativeCore";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import type {
  CoreCommand,
  RuntimeRestoreSessionRecord
} from "../src/shared/generated";
import type {
  EmbeddedRuntimeState,
  EmbeddedRuntimeTabSummary,
  Game,
  Role,
  RuntimeWindowPreferences,
  WorkspaceDisplayInfo
} from "../src/shared/types";
import { createWorkspaceDisplayFingerprint } from "../src/shared/workspaceDisplays";

describe("RuntimeSessionManager", () => {
  it("restores two clean windows by fingerprint and fallback without losing tab state", async () => {
    const fallbackDisplay = display(11, "Built-in", 0);
    const remappedDisplay = display(22, "Studio", 1920);
    const session = savedSession({
      cleanExit: true,
      lastFocusedWindowId: "window-b",
      windows: [
        savedWindow(
          "window-a",
          {
            id: 999,
            fingerprint: createWorkspaceDisplayFingerprint(remappedDisplay)
          },
          [
            savedTab("role-1", { audioMuted: true }),
            savedTab("role-2", { hidden: true })
          ],
          "role-1"
        ),
        savedWindow(
          "window-b",
          {
            id: 404,
            fingerprint: {
              ...createWorkspaceDisplayFingerprint(display(404, "Missing", 4000)),
              label: "Disconnected"
            }
          },
          [savedTab("role-3")],
          "role-3"
        )
      ]
    });
    const harness = createHarness({
      displays: [fallbackDisplay, remappedDisplay],
      fallbackDisplay,
      roles: [role("role-1"), role("role-2"), role("role-3")],
      session
    });

    await harness.manager.initialize();
    await harness.manager.restoreOnStartupIfEligible(true);

    expect(harness.browser.launched.map(({ input, target }) => [
      input.sourceId,
      target.displayId,
      input.hidden,
      input.audioMuted
    ])).toEqual([
      ["role-1", 22, false, true],
      ["role-2", 22, true, false],
      ["role-3", 11, false, false]
    ]);
    expect(harness.browser.prepared).toEqual([
      [22, "window-a"],
      [11, "window-b"]
    ]);
    expect(harness.browser.finished).toEqual([22, 11]);
    expect(harness.browser.activations).toEqual(["runtime-role-1", "runtime-role-3"]);
    expect(harness.browser.listEmbeddedRuntimeState().windows).toMatchObject([
      { id: "window-a", displayId: 22 },
      { id: "window-b", displayId: 11, focused: true }
    ]);
    expect(harness.manager.getProjection()).toEqual({});

    await harness.manager.flushForQuit();
    expect(harness.core.session.cleanExit).toBe(true);
    expect(harness.core.session.windows).toHaveLength(2);
    expect(harness.core.session.windows[0].tabs).toMatchObject([
      { sourceId: "role-1", audioMuted: true, hidden: false },
      { sourceId: "role-2", audioMuted: false, hidden: true }
    ]);
  });

  it.each(["darwin", "win32"] as const)(
    "merges missing saved windows on the current Rion display on %s",
    async () => {
      const fallbackDisplay = display(7, "Current", 0);
      const session = savedSession({
        cleanExit: true,
        lastFocusedWindowId: "window-1",
        windows: [
          savedWindow("window-1", { id: 81 }, [savedTab("role-1")], "role-1"),
          savedWindow("window-2", { id: 82 }, [savedTab("role-2")], "role-2")
        ]
      });
      const harness = createHarness({
        displays: [fallbackDisplay],
        fallbackDisplay,
        roles: [role("role-1"), role("role-2")],
        session
      });

      await harness.manager.initialize();
      await harness.manager.restoreOnStartupIfEligible(true);

      expect(harness.browser.prepared).toEqual([[7, "window-1"]]);
      expect(harness.browser.finished).toEqual([7]);
      expect(harness.browser.launched.map(({ input }) => input.sourceId)).toEqual([
        "role-1",
        "role-2"
      ]);
      expect(harness.browser.listEmbeddedRuntimeState().windows).toMatchObject([
        { id: "window-1", displayId: 7, tabCount: 2 }
      ]);
      expect(harness.browser.activations).toEqual(["runtime-role-1"]);
    }
  );

  it("requires manual recovery after an unclean exit and respects startup gates", async () => {
    const fallbackDisplay = display(1, "Main", 0);
    const unclean = createHarness({
      displays: [fallbackDisplay],
      fallbackDisplay,
      roles: [role("role-1")],
      session: savedSession({
        cleanExit: false,
        windows: [
          savedWindow("window-1", { id: 1 }, [savedTab("role-1")], "role-1")
        ]
      })
    });
    await unclean.manager.initialize();

    expect(unclean.manager.getProjection().recovery).toEqual({
      reason: "unclean-exit",
      windowCount: 1,
      tabCount: 1
    });
    await unclean.manager.restoreOnStartupIfEligible(true);
    expect(unclean.browser.launched).toEqual([]);
    await unclean.manager.restore({ scope: "last-visible" });
    expect(unclean.browser.launched).toHaveLength(1);

    for (const { legalAccepted, restoreGameWindowsOnStartup } of [
      { legalAccepted: false, restoreGameWindowsOnStartup: true },
      { legalAccepted: true, restoreGameWindowsOnStartup: false }
    ]) {
      const gated = createHarness({
        canRestoreSavedWindows: legalAccepted,
        displays: [fallbackDisplay],
        fallbackDisplay,
        preferences: {
          alwaysShowToolbarInFullScreen: false,
          restoreGameWindowsOnStartup
        },
        roles: [role("role-1")],
        session: savedSession({
          cleanExit: true,
          windows: [
            savedWindow("window-1", { id: 1 }, [savedTab("role-1")], "role-1")
          ]
        })
      });
      await gated.manager.initialize();
      await gated.manager.restoreOnStartupIfEligible(legalAccepted);
      expect(gated.browser.launched).toEqual([]);
      expect(gated.manager.getProjection().savedWindows).toHaveLength(1);
      if (!legalAccepted) {
        await expect(gated.manager.restore({ scope: "all" })).rejects.toThrow(
          "legal terms"
        );
      }
    }
  });

  it("prunes deleted sources and never starts External Chrome during restore", async () => {
    const fallbackDisplay = display(1, "Main", 0);
    const externalGame = game("game-external", "external");
    const harness = createHarness({
      displays: [fallbackDisplay],
      fallbackDisplay,
      games: [externalGame],
      roles: [role("role-external", externalGame.id)],
      session: savedSession({
        cleanExit: false,
        windows: [
          savedWindow("window-1", { id: 1 }, [
            savedTab("deleted-role"),
            savedTab("role-external")
          ], "role-external")
        ]
      })
    });

    await harness.manager.initialize();
    expect(harness.manager.getProjection().savedWindows?.[0].tabCount).toBe(1);

    await harness.manager.restore({ scope: "all" });

    expect(harness.browser.launched).toEqual([]);
    expect(harness.manager.getProjection().savedWindows).toMatchObject([
      { id: "window-1", state: "failed", tabCount: 1 }
    ]);
    await harness.manager.discard({ scope: "window", windowId: "window-1" });
    expect(harness.manager.getProjection()).toEqual({});
  });

  it("keeps transient failures retryable without blocking later tabs", async () => {
    const fallbackDisplay = display(1, "Main", 0);
    const harness = createHarness({
      displays: [fallbackDisplay],
      fallbackDisplay,
      roles: [role("role-1"), role("role-2")],
      session: savedSession({
        cleanExit: true,
        windows: [
          savedWindow("window-1", { id: 1 }, [
            savedTab("role-1"),
            savedTab("role-2")
          ], "role-1")
        ]
      })
    });
    harness.browser.failNextLaunch("role-1");

    await harness.manager.initialize();
    await harness.manager.restoreOnStartupIfEligible(true);

    expect(harness.browser.launched.map(({ input }) => input.sourceId)).toEqual([
      "role-1",
      "role-2"
    ]);
    expect(harness.manager.getProjection().savedWindows).toMatchObject([
      { id: "window-1", state: "failed", tabCount: 1 }
    ]);
    await harness.manager.restore({ scope: "window", windowId: "window-1" });
    expect(harness.browser.launched.map(({ input }) => input.sourceId)).toEqual([
      "role-1",
      "role-2",
      "role-1"
    ]);
    expect(harness.manager.getProjection()).toEqual({});
  });
});

class FakeBrowserRuntime extends EventEmitter {
  readonly activations: string[] = [];
  readonly finished: number[] = [];
  readonly launched: Array<{
    input: EmbeddedRestoreTabInput;
    target: BrowserWorkspaceLaunchTarget;
  }> = [];
  readonly prepared: Array<[number, string]> = [];
  private preferredWindowIdByDisplay: Record<number, string> = {};
  private projection?: () => Pick<EmbeddedRuntimeState, "savedWindows" | "recovery">;
  private state: EmbeddedRuntimeState = { tabs: [], windows: [] };
  private readonly transientFailureCountBySource: Record<string, number> = {};

  constructor(private readonly runningRoleIds: string[]) {
    super();
  }

  setRuntimeSessionProjectionProvider(
    provider: () => Pick<EmbeddedRuntimeState, "savedWindows" | "recovery">
  ): void {
    this.projection = provider;
  }

  publishRuntimeSessionChange(): void {
    this.emit("runtimeChange", this.listEmbeddedRuntimeState());
  }

  listEmbeddedRuntimeState(): EmbeddedRuntimeState {
    return structuredClone({
      ...this.state,
      ...(this.projection?.() ?? {})
    });
  }

  listStatuses(): Array<{ roleId: string; state: "running" }> {
    return this.runningRoleIds.map((roleId) => ({ roleId, state: "running" }));
  }

  prepareRestoredWindow(displayId: number, windowId: string): void {
    this.prepared.push([displayId, windowId]);
    this.preferredWindowIdByDisplay[displayId] = windowId;
  }

  finishRestoredWindow(displayId: number): void {
    this.finished.push(displayId);
    delete this.preferredWindowIdByDisplay[displayId];
  }

  failNextLaunch(sourceId: string): void {
    this.transientFailureCountBySource[sourceId] =
      (this.transientFailureCountBySource[sourceId] ?? 0) + 1;
  }

  async launchEmbeddedRestoreTab(
    input: EmbeddedRestoreTabInput,
    target: BrowserWorkspaceLaunchTarget
  ): Promise<EmbeddedRuntimeTabSummary> {
    this.launched.push({ input: { ...input }, target: structuredClone(target) });
    if ((this.transientFailureCountBySource[input.sourceId] ?? 0) > 0) {
      this.transientFailureCountBySource[input.sourceId] -= 1;
      throw new Error("Temporary load failure");
    }
    let window = this.state.windows.find((candidate) => candidate.displayId === target.displayId);
    if (!window) {
      window = {
        id: this.preferredWindowIdByDisplay[target.displayId],
        displayId: target.displayId,
        bounds: { ...target.workArea },
        visible: false,
        focused: false,
        tabCount: 0
      };
      this.state.windows.push(window);
    }
    const tab: EmbeddedRuntimeTabSummary = {
      id: `runtime-${input.sourceId}`,
      type: input.type,
      sourceId: input.sourceId,
      name: input.sourceId,
      displayId: target.displayId,
      roleIds: input.type === "role" ? [input.sourceId] : [],
      hidden: input.hidden,
      active: false,
      audible: false,
      audioMuted: input.audioMuted
    };
    this.state.tabs.push(tab);
    window.tabCount += 1;
    return structuredClone(tab);
  }

  async showRuntimeTab(tabId: string): Promise<void> {
    this.activations.push(tabId);
    const active = this.state.tabs.find((tab) => tab.id === tabId);
    if (!active) return;
    this.state.tabs.forEach((tab) => {
      tab.active = tab.id === tabId;
    });
    active.hidden = false;
    this.state.windows.forEach((window) => {
      const focused = window.displayId === active.displayId;
      window.visible = focused || window.visible;
      window.focused = focused;
      if (focused) window.activeTabId = tabId;
    });
  }

  async showEmbeddedRuntimeWindows(): Promise<void> {
    this.state.windows.forEach((window) => {
      window.visible = true;
    });
  }

  async stopRuntimeWindow(): Promise<void> {
    this.state = { tabs: [], windows: [] };
  }
}

function createHarness({
  canRestoreSavedWindows = true,
  displays,
  fallbackDisplay,
  games = [game("game-1", "inherit")],
  preferences = {
    alwaysShowToolbarInFullScreen: false,
    restoreGameWindowsOnStartup: true
  },
  roles,
  session
}: {
  canRestoreSavedWindows?: boolean;
  displays: WorkspaceDisplayInfo[];
  fallbackDisplay: WorkspaceDisplayInfo;
  games?: Game[];
  preferences?: RuntimeWindowPreferences;
  roles: Role[];
  session: RuntimeRestoreSessionRecord;
}): {
  browser: FakeBrowserRuntime;
  core: { session: RuntimeRestoreSessionRecord };
  manager: RuntimeSessionManager;
} {
  const browser = new FakeBrowserRuntime(roles.map((item) => item.id));
  const coreState = {
    session: structuredClone(session)
  };
  const invoke = vi.fn(async (command: CoreCommand) => {
    if (command.type === "runtimeRestoreSessionGet") {
      return structuredClone(coreState.session);
    }
    if (command.type === "runtimeRestoreSessionReplace") {
      coreState.session = structuredClone(command.session);
      return structuredClone(coreState.session);
    }
    throw new Error(`Unexpected command: ${command.type}`);
  });
  const manager = new RuntimeSessionManager({
    browserManager: browser as unknown as ElectronBrowserRuntime,
    canRestoreSavedWindows: async () => canRestoreSavedWindows,
    core: { invoke } as unknown as Pick<AppCoreClient, "invoke">,
    gameBrowserSettingsStore: {
      getSettings: async () => structuredClone(DEFAULT_GAME_BROWSER_SETTINGS)
    },
    gameStore: {
      listGames: async () => structuredClone(games)
    },
    getDefaultLaunchTarget: () => ({
      displayId: fallbackDisplay.id,
      workArea: { ...fallbackDisplay.workArea }
    }),
    getPreferences: () => ({ ...preferences }),
    getWorkspaceDisplays: () => structuredClone(displays),
    logger: {
      error: vi.fn(),
      warn: vi.fn()
    },
    roleStore: {
      listRoles: async () => structuredClone(roles)
    },
    workspaceStore: {
      listWorkspaces: async () => []
    }
  });
  return { browser, core: coreState, manager };
}

function savedSession(
  overrides: Partial<RuntimeRestoreSessionRecord>
): RuntimeRestoreSessionRecord {
  return {
    schemaVersion: 1,
    updatedAt: "2026-07-25T00:00:00.000Z",
    cleanExit: true,
    windows: [],
    ...overrides
  };
}

function savedWindow(
  id: string,
  targetDisplay: RuntimeRestoreSessionRecord["windows"][number]["targetDisplay"],
  tabs: RuntimeRestoreSessionRecord["windows"][number]["tabs"],
  activeSourceId?: string
): RuntimeRestoreSessionRecord["windows"][number] {
  return {
    id,
    targetDisplay,
    wasVisible: true,
    ...(activeSourceId ? { activeSourceId } : {}),
    tabs
  };
}

function savedTab(
  sourceId: string,
  overrides: Partial<RuntimeRestoreSessionRecord["windows"][number]["tabs"][number]> = {}
): RuntimeRestoreSessionRecord["windows"][number]["tabs"][number] {
  return {
    tabType: "role",
    sourceId,
    name: sourceId,
    roleIds: [sourceId],
    hidden: false,
    audioMuted: false,
    ...overrides
  };
}

function display(id: number, label: string, x: number): WorkspaceDisplayInfo {
  return {
    id,
    label,
    bounds: { x, y: 0, width: 1920, height: 1080 },
    workArea: { x, y: 0, width: 1920, height: 1040 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: x === 0,
    isInternal: x === 0
  };
}

function game(id: string, browserLaunchMode: Game["browserLaunchMode"]): Game {
  return {
    id,
    source: "custom",
    name: id,
    defaultLaunchUrl: `https://${id}.example.test/play`,
    browserLaunchMode,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function role(id: string, gameId = "game-1"): Role {
  return {
    id,
    gameId,
    name: id,
    launchUrl: `https://${id}.example.test/play`,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
