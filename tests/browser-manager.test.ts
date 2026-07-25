import { EventEmitter } from "node:events";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  BrowserGameLoadError,
  ElectronBrowserRuntime,
  type ElectronBrowserRuntimeOptions,
  type BrowserWorkspaceLaunchItem,
  classifyNativeZoomShortcut,
  classifyRuntimeTabSwitchShortcut,
  createRoleSessionPartition,
  isExpectedNativeZoomResult,
  normalizedRectToPixelBounds
} from "../src/main/browser/ElectronBrowserRuntime";
import { SystemWebViewRuntimePool } from "../src/main/browser/SystemWebViewRuntimePool";
import type {
  WebSurfaceLifecycleEvent,
  WebSurfacePort
} from "../src/main/browser/ports/WebSurfacePort";
import { WORKSPACE_RESIZE_INDICATOR_CHANNEL } from "../src/shared/internalIpc";
import type {
  BrowserRuntimeSnapshot,
  BrowserRoleStatusRecord,
  CoreCommand,
  CoreEffectAction,
  LayoutRoleInput,
  ResolvedBrowserEngine,
  RolePathsRecord,
  WorkspaceDividerDescriptor,
  WorkspaceDividerResizeInput,
  WorkspaceDividerResizeOutput,
  WorkspaceLayoutInput,
  WorkspaceLayoutOutput
} from "../src/shared/generated";
import type {
  LaunchWorkspace,
  PixelBounds,
  Role,
  WorkspaceAppearanceSettings,
  WorkspaceDisplayInfo,
  WorkspaceLayoutTemplate
} from "../src/shared/types";
import {
  getDefaultWorkspaceRects,
  MIN_WORKSPACE_SLOT_SIZE
} from "../src/shared/workspaceLayout";
import { snapWorkspaceResizePosition } from "../src/shared/workspaceResize";
import { createBrowserRuntimeState } from "./helpers/browserRuntimeState";
import { createEmbeddedKeyRuntimeState } from "./helpers/embeddedKeyRuntimeState";
import {
  normalizeTestWorkspaceRects,
  resolveTestAdaptiveZoom
} from "./helpers/workspaceLayoutState";
import { v1Case } from "./helpers/v1Parity";

type AnyMock = Mock;

interface DividerTestEvent {
  pointerId: number;
  preventDefault: () => void;
  screenX: number;
  type: string;
}

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  notes: "",
  browserSessionSource: "managed",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  browserLaunchMode: "inherit",
  browserZoomMode: "fixed",
  name: "Party",
  template: "two_columns",
  browserZoomPercent: 90,
  slots: [
    { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
    { id: "slot-2", roleId: "role-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
  ],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const runtimeDisplays: WorkspaceDisplayInfo[] = [
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

const persistedLayoutDividerCases: Array<[WorkspaceLayoutTemplate, PixelBounds[]]> = [
  ["single", []],
  ["two_columns", [{ x: 598, y: 0, width: 4, height: 800 }]],
  ["three_columns", [
    { x: 398, y: 0, width: 4, height: 800 },
    { x: 798, y: 0, width: 4, height: 800 }
  ]],
  ["main_left_stack_right", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 600, y: 398, width: 600, height: 4 }
  ]],
  ["main_right_stack_left", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 600, height: 4 }
  ]],
  ["main_center_side_stacks", [
    { x: 358, y: 0, width: 4, height: 800 },
    { x: 838, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 360, height: 4 },
    { x: 840, y: 398, width: 360, height: 4 }
  ]],
  ["three_top_two_bottom", [
    { x: 398, y: 0, width: 4, height: 400 },
    { x: 798, y: 0, width: 4, height: 400 },
    { x: 598, y: 400, width: 4, height: 400 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["two_top_three_bottom", [
    { x: 598, y: 0, width: 4, height: 400 },
    { x: 398, y: 400, width: 4, height: 400 },
    { x: 798, y: 400, width: 4, height: 400 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["quad", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["four_columns", [
    { x: 298, y: 0, width: 4, height: 800 },
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 898, y: 0, width: 4, height: 800 }
  ]],
  ["six_grid", [
    { x: 398, y: 0, width: 4, height: 800 },
    { x: 798, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["eight_grid", [
    { x: 298, y: 0, width: 4, height: 800 },
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 898, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]]
];

describe("ElectronBrowserRuntime game host windows", () => {
  it("creates a persistent isolated partition for each role", () => {
    expect(createRoleSessionPartition("role:one/two")).toBe("persist:rion-role-role-one-two");
  });

  it.each(["darwin", "win32"] as const)(
    "loads an embedded %s game directly after proxy and CDN preparation",
    async (platform) => {
      const applyBrowserProxy = vi.fn().mockResolvedValue(undefined);
      const applyCdnCompatibility = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness({ applyBrowserProxy, applyCdnCompatibility, platform });

      await harness.manager.launch(role);

      expect(applyBrowserProxy).toHaveBeenCalledOnce();
      expect(applyCdnCompatibility).toHaveBeenCalledOnce();
      expect(applyCdnCompatibility.mock.invocationCallOrder[0])
        .toBeLessThan(harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]);
      expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
      expect(harness.views[0].webContents.session.cookies.get).not.toHaveBeenCalled();
      v1Case(
        platform === "darwin"
          ? "browser-workspace-68b3526e056a"
          : "browser-workspace-323a842fef44",
        () => {
          expect(applyBrowserProxy).toHaveBeenCalledOnce();
          expect(applyCdnCompatibility).toHaveBeenCalledOnce();
          expect(applyCdnCompatibility.mock.invocationCallOrder[0])
            .toBeLessThan(harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]);
          expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
          expect(harness.views[0].webContents.session.cookies.get).not.toHaveBeenCalled();
        }
      );
    }
  );

  it.each(["darwin", "win32"] as const)(
    "shows a launching %s tab immediately and cancels without rereading a destroyed view",
    async (platform) => {
      let markLoadStarted!: () => void;
      let releaseLoad!: () => void;
      const loadStarted = new Promise<void>((resolve) => {
        markLoadStarted = resolve;
      });
      const harness = createHarness({
        loadUrlHandlers: [() => new Promise<void>((resolve) => {
          releaseLoad = resolve;
          markLoadStarted();
        })],
        platform
      });
      const launch = harness.manager.launch(role);
      await loadStarted;

      const runtimeTab = harness.manager.listEmbeddedRuntimeState().tabs[0];
      expect(runtimeTab).toMatchObject({ hidden: false, active: true });
      expect(harness.hosts[0].show).toHaveBeenCalledOnce();

      const mockView = harness.views[0];
      const originalWebContents = mockView.webContents;
      let destroyed = false;
      Object.defineProperty(mockView.view, "webContents", {
        configurable: true,
        get: () => destroyed ? undefined : originalWebContents
      });
      originalWebContents.isDestroyed.mockImplementation(() => destroyed);
      originalWebContents.close.mockImplementation(() => {
        destroyed = true;
        releaseLoad();
        originalWebContents.emit("destroyed");
      });

      await harness.manager.stopRuntimeTab(runtimeTab.id);
      await expect(launch).resolves.toBeNull();
      expect(harness.manager.listStatuses()).toEqual([]);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-adf3bbaca440"
          : "browser-workspace-80cad119482f",
        () => {
          expect(runtimeTab).toMatchObject({ hidden: false, active: true });
          expect(harness.hosts[0].show).toHaveBeenCalledOnce();
          expect(destroyed).toBe(true);
          expect(harness.manager.listStatuses()).toEqual([]);
        }
      );
    }
  );

  it.each(["darwin", "win32"] as const)(
    "activates a new %s tab before navigation and restores the previous tab on failure",
    async (platform) => {
      let markSecondLoadStarted!: () => void;
      let rejectSecondLoad!: (error: Error) => void;
      const secondLoadStarted = new Promise<void>((resolve) => {
        markSecondLoadStarted = resolve;
      });
      const harness = createHarness({
        loadUrlHandlers: [
          async () => undefined,
          () => new Promise<void>((_resolve, reject) => {
            rejectSecondLoad = reject;
            markSecondLoadStarted();
          })
        ],
        platform
      });
      await harness.manager.launch(role);
      const secondRole = createRole("role-2", "Alt");

      const secondLaunch = harness.manager.launch(secondRole);
      await secondLoadStarted;

      expect(harness.manager.listEmbeddedRuntimeState().tabs).toMatchObject([
        { active: false, sourceId: role.id },
        { active: true, hidden: false, sourceId: secondRole.id }
      ]);
      rejectSecondLoad(new Error("navigation failed"));
      await expect(secondLaunch).rejects.toBeInstanceOf(BrowserGameLoadError);
      expect(harness.manager.listEmbeddedRuntimeState().tabs).toMatchObject([
        { active: true, hidden: false, sourceId: role.id }
      ]);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-4cb5bcad4a14"
          : "browser-workspace-98fba36a7d38",
        () => {
          expect(harness.manager.listEmbeddedRuntimeState().tabs).toMatchObject([
            { active: true, hidden: false, sourceId: role.id }
          ]);
          expect(harness.views[0].webContents.loadURL).toHaveBeenCalledOnce();
        }
      );
    }
  );

  it.each(["darwin", "win32"] as const)(
    "shows a %s workspace while its game pages are still loading",
    async (platform) => {
      const releaseLoads: Array<() => void> = [];
      let markLoadsStarted!: () => void;
      const loadsStarted = new Promise<void>((resolve) => {
        markLoadsStarted = resolve;
      });
      const deferLoad = () => new Promise<void>((resolve) => {
        releaseLoads.push(resolve);
        if (releaseLoads.length === 2) markLoadsStarted();
      });
      const harness = createHarness({
        loadUrlHandlers: [deferLoad, deferLoad],
        platform
      });
      const secondRole = createRole("role-2", "Alt");

      const launch = harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ]);
      await loadsStarted;

      expect(harness.manager.listEmbeddedRuntimeState().tabs).toMatchObject([
        { active: true, hidden: false, sourceId: workspace.id }
      ]);
      expect(harness.hosts[0].show).toHaveBeenCalledOnce();
      expect(harness.manager.listStatuses()).toEqual([
        expect.objectContaining({ roleId: role.id, state: "launching" }),
        expect.objectContaining({ roleId: secondRole.id, state: "launching" })
      ]);

      releaseLoads.forEach((release) => release());
      await expect(launch).resolves.toEqual([
        expect.objectContaining({ roleId: role.id, state: "running" }),
        expect.objectContaining({ roleId: secondRole.id, state: "running" })
      ]);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-7b9e9324691b"
          : "browser-workspace-1a45b9a5a642",
        () => {
          expect(harness.hosts[0].show).toHaveBeenCalledOnce();
          expect(harness.manager.listStatuses()).toEqual([
            expect.objectContaining({ roleId: role.id, state: "running" }),
            expect.objectContaining({ roleId: secondRole.id, state: "running" })
          ]);
        }
      );
    }
  );

  it("cleans a destroyed game view without reading WebContentsView.webContents again", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    const mockView = harness.views[0];
    const originalWebContents = mockView.webContents;
    let destroyed = false;
    Object.defineProperty(mockView.view, "webContents", {
      configurable: true,
      get: () => destroyed ? undefined : originalWebContents
    });
    originalWebContents.isDestroyed.mockImplementation(() => destroyed);
    originalWebContents.close.mockImplementation(() => {
      destroyed = true;
      originalWebContents.emit("destroyed");
    });

    await expect(harness.manager.stop(role.id)).resolves.toBeUndefined();
  });

  it("stops roles from the authoritative Rust status query when the event cache is stale", async () => {
    const harness = createHarness();
    await Promise.resolve();
    expect(harness.manager.listStatuses()).toEqual([]);
    const tabId = harness.browserRuntimeState.invokeBrowserRuntime({
      type: "createTab",
      sourceId: role.id,
      name: role.name,
      displayId: 1,
      tabType: "role",
      roleIds: [role.id]
    }).createdTabId!;
    harness.browserRuntimeState.invokeBrowserRuntime({
      type: "roleTransition",
      roleId: role.id,
      runtime: "embedded",
      tabId,
      state: "launching"
    });
    harness.browserRuntimeState.invokeBrowserRuntime({
      type: "roleTransition",
      roleId: role.id,
      runtime: "embedded",
      tabId,
      state: "running",
      launchedAt: new Date().toISOString()
    });
    const invoke = vi.fn(async () => undefined);
    harness.browserRuntimeState.setTypedInvoker(invoke);

    await harness.manager.stopAll();

    expect(invoke).toHaveBeenCalledWith({
      type: "browserRoleStop",
      roleId: role.id
    });
  });

  it.each([
    ["darwin", {
      backgroundColor: "#000000",
      vibrancy: "under-window",
      visualEffectState: "followWindow"
    }],
    ["win32", {
      backgroundColor: "#202024",
      backgroundMaterial: "acrylic"
    }]
  ] as const)(
    "opens a single role in the shared display host without a legacy inner control offset on %s",
    async (platform, materialOptions) => {
      const onEmbeddedWebContentsCreated = vi.fn();
      const harness = createHarness({ platform, onEmbeddedWebContentsCreated });
      const overlayInstaller = vi.fn().mockResolvedValue(undefined);
      harness.manager.setMacroOverlayInstaller(overlayInstaller);

      await harness.manager.launch(role);

      expect(harness.createHostWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          x: 100,
          y: 50,
          width: 1200,
          height: 800,
          frame: true,
          show: false,
          title: "Rion Studio",
          ...materialOptions
        })
      );
      expect(harness.createHostWindow).toHaveBeenCalledWith(
        expect.not.objectContaining({ webPreferences: expect.anything() })
      );
      if (platform === "darwin") {
        expect(harness.createHostWindow).toHaveBeenCalledWith(
          expect.objectContaining({ acceptFirstMouse: true })
        );
      } else {
        expect(harness.createHostWindow).toHaveBeenCalledWith(
          expect.not.objectContaining({ acceptFirstMouse: expect.anything() })
        );
      }
      expect(harness.createView).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            backgroundThrottling: true,
            spellcheck: false,
            webgl: true
          })
        })
      );
      expect(harness.views[0].setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1200,
        height: 800
      });
      expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
      expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
      expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
      expect(overlayInstaller).toHaveBeenCalledWith(role, harness.views[0].webContents);
      expect(onEmbeddedWebContentsCreated).toHaveBeenCalledWith({
        hostId: expect.any(String),
        kind: "game",
        roleId: role.id
      }, harness.views[0].webContents);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-0585aa1b7a39"
          : "browser-workspace-74b6e4ce8055",
        () => {
          expect(harness.createHostWindow).toHaveBeenCalledWith(
            expect.objectContaining({ frame: true, show: false, ...materialOptions })
          );
          expect(harness.views[0].setBounds).toHaveBeenCalledWith({
            x: 0,
            y: 0,
            width: 1200,
            height: 800
          });
          expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
          expect(harness.hosts[0].show).toHaveBeenCalledOnce();
        }
      );
    }
  );

  it.each(["darwin", "win32"] as const)(
    "restores the last focused game view when the host regains focus on %s",
    async (platform) => {
      const harness = createHarness({ platform });
      const secondRole = createRole("role-2", "Alt");

      await harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ]);
      const firstView = harness.views[0];
      const secondView = harness.views[1];
      firstView.webContents.focus.mockClear();
      secondView.webContents.focus.mockClear();
      firstView.webContents.executeJavaScript.mockClear();
      secondView.webContents.executeJavaScript.mockClear();

      secondView.webContents.emit("focus");
      harness.hosts[0].emit("focus");

      expect(secondView.webContents.focus).toHaveBeenCalledOnce();
      expect(firstView.webContents.focus).not.toHaveBeenCalled();
      expect(firstView.webContents.executeJavaScript).not.toHaveBeenCalled();
      expect(secondView.webContents.executeJavaScript).not.toHaveBeenCalled();
      v1Case(
        platform === "darwin"
          ? "browser-workspace-becd0c0e6603"
          : "browser-workspace-2476cbdf7ddb",
        () => {
          expect(secondView.webContents.focus).toHaveBeenCalledOnce();
          expect(firstView.webContents.focus).not.toHaveBeenCalled();
          expect(firstView.webContents.executeJavaScript).not.toHaveBeenCalled();
          expect(secondView.webContents.executeJavaScript).not.toHaveBeenCalled();
        }
      );
    }
  );

  it("restores a focused popup and falls back to its game view after the popup closes", async () => {
    const harness = createHarness({ platform: "darwin" });

    await harness.manager.launch(role);
    const gameView = harness.views[0];
    const popupView = createOAuthPopup(gameView, harness.views);
    gameView.webContents.focus.mockClear();
    popupView.webContents.focus.mockClear();

    popupView.webContents.emit("focus");
    harness.hosts[0].emit("focus");

    expect(popupView.webContents.focus).toHaveBeenCalledOnce();
    expect(gameView.webContents.focus).not.toHaveBeenCalled();

    popupView.webContents.close();
    harness.hosts[0].emit("focus");

    expect(popupView.webContents.focus).toHaveBeenCalledOnce();
    expect(gameView.webContents.focus).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"] as const)(
    "tracks and applies embedded tab audio state on %s",
    async (platform) => {
      const harness = createHarness({ platform });

      await harness.manager.launch(role);
      const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      const gameWebContents = harness.views[0].webContents;

      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: false,
        audioMuted: false
      });

      gameWebContents.isCurrentlyAudible.mockReturnValue(true);
      gameWebContents.emit("audio-state-changed", {}, { audible: true });
      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: true,
        audioMuted: false
      });

      harness.manager.setRuntimeTabAudioMuted(tabId, true);
      expect(gameWebContents.setAudioMuted).toHaveBeenLastCalledWith(true);
      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: true,
        audioMuted: true
      });

      gameWebContents.isCurrentlyAudible.mockReturnValue(false);
      gameWebContents.emit("audio-state-changed", {}, { audible: false });
      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: false,
        audioMuted: true
      });

      harness.manager.setRuntimeTabAudioMuted(tabId, false);
      expect(gameWebContents.setAudioMuted).toHaveBeenLastCalledWith(false);
      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: false,
        audioMuted: false
      });
      v1Case(
        platform === "darwin"
          ? "browser-workspace-1f8900aaa15a"
          : "browser-workspace-e38d1abb9000",
        () => {
          expect(gameWebContents.setAudioMuted).toHaveBeenNthCalledWith(1, true);
          expect(gameWebContents.setAudioMuted).toHaveBeenLastCalledWith(false);
          expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
            audible: false,
            audioMuted: false
          });
        }
      );
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "owns, presents, moves, mutes, and destroys a %s native role surface",
    async (platform, resolvedEngine) => {
      const nativeSurfaces: ReturnType<typeof createMockSystemSurface>[] = [];
      const createSurface = () => {
        const surface = createMockSystemSurface();
        nativeSurfaces.push(surface);
        return surface.value;
      };
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => createSurface(),
        createWindowsSurface: () => createSurface(),
        platform
      });
      const getRolePaths = vi.fn(async (roleId: string) => createRolePaths(roleId));
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        getRolePaths,
        platform,
        resolvedEngine,
        systemRuntimePool: pool,
        workspaceDisplays: runtimeDisplays
      });

      await harness.manager.launch(role);

      expect(harness.views).toHaveLength(0);
      expect(nativeSurfaces).toHaveLength(1);
      expect(getRolePaths).toHaveBeenCalledWith(role.id);
      expect(nativeSurfaces[0].value.loadUrl).toHaveBeenCalledWith(role.launchUrl);
      expect(nativeSurfaces[0].value.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 0,
        width: 1200,
        height: 776
      });
      expect(nativeSurfaces[0].value.setVisible).toHaveBeenLastCalledWith(true);
      expect(nativeSurfaces[0].value.setZoomFactor).toHaveBeenLastCalledWith(1);
      expect(nativeSurfaces[0].value.focus).toHaveBeenCalledOnce();

      const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      nativeSurfaces[0].emit({ type: "audioChanged", audible: true });
      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: true,
        audioMuted: false
      });
      harness.manager.setRuntimeTabAudioMuted(tabId, true);
      await vi.waitFor(() => {
        expect(nativeSurfaces[0].value.setAudioMuted).toHaveBeenLastCalledWith(true);
      });

      await harness.manager.moveRuntimeTab(tabId, 22);

      expect(nativeSurfaces).toHaveLength(2);
      expect(nativeSurfaces[0].value.destroy).toHaveBeenCalledOnce();
      expect(nativeSurfaces[1].value.loadUrl).toHaveBeenCalledWith(role.launchUrl);
      expect(nativeSurfaces[1].value.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 0,
        width: 1920,
        height: 1040
      });
      expect(nativeSurfaces[1].value.setAudioMuted).toHaveBeenCalledWith(true);

      await harness.manager.stop(role.id);

      expect(nativeSurfaces[1].value.destroy).toHaveBeenCalledOnce();
      expect(pool.get(role.id)).toBeUndefined();
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "passes the resolved custom proxy into each recreated %s native surface",
    async (platform, resolvedEngine) => {
      const proxyServer = "socks5://127.0.0.1:1080";
      const nativeSurfaces: ReturnType<typeof createMockSystemSurface>[] = [];
      const createMacSurface = vi.fn(() => {
        const surface = createMockSystemSurface();
        nativeSurfaces.push(surface);
        return surface.value;
      });
      const createWindowsSurface = vi.fn(() => {
        const surface = createMockSystemSurface();
        nativeSurfaces.push(surface);
        return surface.value as never;
      });
      const getNativeSessionConfiguration = vi.fn(async () => ({ proxyServer }));
      const pool = new SystemWebViewRuntimePool({
        createMacSurface,
        createWindowsSurface,
        platform
      });
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        getNativeSessionConfiguration,
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool,
        workspaceDisplays: runtimeDisplays
      });

      await harness.manager.launch(role);
      const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      await harness.manager.moveRuntimeTab(tabId, 22);

      expect(getNativeSessionConfiguration).toHaveBeenCalledTimes(2);
      expect(getNativeSessionConfiguration).toHaveBeenNthCalledWith(1, role);
      expect(getNativeSessionConfiguration).toHaveBeenNthCalledWith(2, role);
      const factory = platform === "darwin" ? createMacSurface : createWindowsSurface;
      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ proxyServer })
      );
      expect(factory).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ proxyServer })
      );

      await harness.manager.stop(role.id);
    }
  );

  it("configures all resolved CDN rewrites before each WebView2 navigation", async () => {
    const cdnRewriteRules = [{
      id: "jquery",
      regexFilter: "^https://code\\.jquery\\.com/(.*)$",
      regexSubstitution: "https://cdn.example/\\1",
      sourceHost: "code.jquery.com"
    }];
    const nativeSurfaces: ReturnType<typeof createMockSystemSurface>[] = [];
    const createSurface = () => {
      const surface = createMockSystemSurface();
      nativeSurfaces.push(surface);
      return surface.value;
    };
    const pool = new SystemWebViewRuntimePool({
      createWindowsSurface: () => createSurface() as never,
      platform: "win32"
    });
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      getNativeSessionConfiguration: async () => ({ cdnRewriteRules }),
      getRolePaths: async (roleId) => createRolePaths(roleId),
      platform: "win32",
      resolvedEngine: "webview2",
      systemRuntimePool: pool,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);
    const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
    await harness.manager.moveRuntimeTab(tabId, 22);

    expect(nativeSurfaces).toHaveLength(2);
    for (const native of nativeSurfaces) {
      expect(native.value.configureRequestRewrites)
        .toHaveBeenCalledWith(cdnRewriteRules);
      expect(
        vi.mocked(native.value.configureRequestRewrites).mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(native.value.loadUrl).mock.invocationCallOrder[0]);
    }

    await harness.manager.stop(role.id);
  });

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "registers %s custom-font script before every native navigation",
    async (platform, resolvedEngine) => {
      const documentStartScript = "window.__rionFontsReady = true;";
      const nativeSurfaces: ReturnType<typeof createMockSystemSurface>[] = [];
      const createSurface = () => {
        const surface = createMockSystemSurface();
        nativeSurfaces.push(surface);
        return surface.value;
      };
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => createSurface(),
        createWindowsSurface: () => createSurface() as never,
        platform
      });
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        getNativeSessionConfiguration: async () => ({ documentStartScript }),
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool,
        workspaceDisplays: runtimeDisplays
      });

      await harness.manager.launch(role);
      const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      await harness.manager.moveRuntimeTab(tabId, 22);

      expect(nativeSurfaces).toHaveLength(2);
      for (const native of nativeSurfaces) {
        expect(native.value.addDocumentStartScript)
          .toHaveBeenCalledWith(documentStartScript);
        expect(
          vi.mocked(native.value.addDocumentStartScript).mock.invocationCallOrder[0]
        ).toBeLessThan(vi.mocked(native.value.loadUrl).mock.invocationCallOrder[0]);
      }

      await harness.manager.stop(role.id);
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "groups %s System and Electron tabs into separate physical hosts on one display",
    async (platform, systemEngine) => {
      const native = createMockSystemSurface();
      const electronRole: Role = {
        ...role,
        id: "role-electron-host",
        name: "Electron host role"
      };
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => native.value,
        createWindowsSurface: () => native.value,
        platform
      });
      const target = { displayId: 11, workArea: runtimeDisplays[0].workArea };
      const harness = createHarness({
        defaultLaunchTarget: target,
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine: (candidate) =>
          candidate.id === electronRole.id ? "electron" : systemEngine,
        systemRuntimePool: pool,
        workspaceDisplays: runtimeDisplays
      });

      await harness.manager.launch(role);
      const systemTabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      await harness.manager.launch(electronRole);

      expect(harness.hosts).toHaveLength(2);
      expect(harness.views).toHaveLength(1);
      expect(native.value.loadUrl).toHaveBeenCalledWith(role.launchUrl);
      expect(harness.hosts[0].hide).toHaveBeenCalled();
      expect(harness.hosts[1].show).toHaveBeenCalled();
      expect(harness.manager.listEmbeddedRuntimeState().windows).toHaveLength(1);

      await harness.manager.showRuntimeTab(systemTabId);

      expect(harness.hosts[1].hide).toHaveBeenCalled();
      expect(harness.hosts[0].show).toHaveBeenCalled();
      expect(native.value.setVisible).toHaveBeenLastCalledWith(true);
      expect(harness.manager.listEmbeddedRuntimeState().windows).toEqual([
        expect.objectContaining({
          activeTabId: systemTabId,
          displayId: 11,
          id: expect.any(String),
          tabCount: 2
        })
      ]);

      await harness.manager.stop(role.id);
      await harness.manager.stop(electronRole.id);
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "replaces an entire crashed %s native tab with Electron through the core effect",
    async (platform, resolvedEngine) => {
      const native = createMockSystemSurface();
      vi.mocked(native.value.getCookies).mockResolvedValue([{
        domain: ".example.com",
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "lax",
        secure: true,
        url: "https://example.com/",
        value: "runtime-cookie"
      }]);
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => native.value,
        createWindowsSurface: () => native.value,
        platform
      });
      const harness = createHarness({
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool
      });

      await harness.manager.launch(role);
      native.emit({ type: "navigationCompleted", url: "https://example.com/redirected" });
      native.emit({ type: "crashed", reason: "web-content-process-terminated" });

      await vi.waitFor(() => {
        expect(harness.views).toHaveLength(1);
      });
      expect(harness.hosts).toHaveLength(2);
      expect(harness.hosts[0].close).toHaveBeenCalledOnce();
      expect(harness.hosts[1].contentView.addChildView)
        .toHaveBeenCalledWith(harness.views[0].view);
      expect(native.value.destroy).toHaveBeenCalledOnce();
      expect(harness.views[0].webContents.session.cookies.set).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "session",
          value: "runtime-cookie"
        })
      );
      expect(
        harness.views[0].webContents.session.cookies.set.mock.invocationCallOrder[0]
      ).toBeLessThan(
        harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
      );
      expect(harness.views[0].webContents.loadURL)
        .toHaveBeenCalledWith("https://example.com/redirected");
      expect(harness.manager.listStatuses()).toEqual([
        expect.objectContaining({
          fallbackReason: "runtime-crashed",
          sessionContinuity: "verified"
        })
      ]);
      expect(harness.manager.getEmbeddedAutomationSession(role.id)).toBeDefined();
      expect(pool.get(role.id)).toBeUndefined();

      await harness.manager.stop(role.id);
      expect(harness.views[0].webContents.close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "keeps the %s Electron fallback visible but marks needs-login when cookie mirroring fails",
    async (platform, resolvedEngine) => {
      const native = createMockSystemSurface();
      vi.mocked(native.value.getCookies).mockRejectedValue(
        new Error("native cookie store unavailable")
      );
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => native.value,
        createWindowsSurface: () => native.value,
        platform
      });
      const harness = createHarness({
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await harness.manager.launch(role);
      native.emit({ type: "crashed", reason: "web-content-process-terminated" });

      await vi.waitFor(() => {
        expect(harness.manager.listStatuses()).toEqual([
          expect.objectContaining({
            fallbackReason: "auth-verification-failed",
            resolvedEngine: "electron",
            sessionContinuity: "needs-login"
          })
        ]);
      });
      expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
      warning.mockRestore();
      await harness.manager.stop(role.id);
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "installs and serves the %s native macro overlay message bridge",
    async (platform, resolvedEngine) => {
      const native = createMockSystemSurface();
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => native.value,
        createWindowsSurface: () => native.value,
        platform
      });
      const harness = createHarness({
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool
      });
      const invoke = vi.spyOn(harness.browserRuntimeState, "invoke");

      await harness.manager.launch(role);

      expect(native.value.evaluate).toHaveBeenCalledWith(
        expect.stringContaining("__rionStudioNativeOverlayBridge")
      );
      expect(native.value.evaluate).toHaveBeenCalledWith(
        expect.stringContaining("__rionStudioMacroOverlay")
      );
      native.emit({
        type: "bridgeMessage",
        messageJson: JSON.stringify({
          type: "overlayRequest",
          requestId: "overlay-7",
          payload: { type: "list" }
        })
      });

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
          type: "overlayRequest",
          roleId: role.id,
          requestJson: JSON.stringify({ type: "list" })
        }));
        expect(native.value.evaluate).toHaveBeenCalledWith(
          expect.stringContaining("\"overlay-7\",true")
        );
      });
      await harness.manager.stop(role.id);
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "preserves a %s popup intent while visibly falling the tab back to Electron",
    async (platform, resolvedEngine) => {
      const native = createMockSystemSurface();
      const pool = new SystemWebViewRuntimePool({
        createMacSurface: () => native.value,
        createWindowsSurface: () => native.value,
        platform
      });
      const harness = createHarness({
        getRolePaths: async (roleId) => createRolePaths(roleId),
        platform,
        resolvedEngine,
        systemRuntimePool: pool
      });

      await harness.manager.launch(role);
      native.emit({
        type: "popupRequested",
        url: "https://accounts.example.com/oauth"
      });

      await vi.waitFor(() => {
        expect(harness.views).toHaveLength(2);
      });
      expect(native.value.destroy).toHaveBeenCalledOnce();
      expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
      expect(harness.views[1].webContents.loadURL)
        .toHaveBeenCalledWith("https://accounts.example.com/oauth");
      expect(harness.manager.getEmbeddedAutomationSession(role.id)).toBeDefined();

      await harness.manager.stop(role.id);
      expect(harness.views[0].webContents.close).toHaveBeenCalledOnce();
      expect(harness.views[1].webContents.close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "keeps a successfully created %s popup in the native session",
    async (platform, resolvedEngine) => {
    const native = createMockSystemSurface();
    const pool = new SystemWebViewRuntimePool({
      createMacSurface: () => native.value,
      createWindowsSurface: () => native.value as never,
      platform
    });
    const harness = createHarness({
      getRolePaths: async (roleId) => createRolePaths(roleId),
      platform,
      resolvedEngine,
      systemRuntimePool: pool
    });

    await harness.manager.launch(role);
    native.emit({
      type: "popupCreated",
      url: "https://accounts.example.com/oauth"
    });

    await Promise.resolve();
    expect(native.value.destroy).not.toHaveBeenCalled();
    expect(harness.views).toHaveLength(0);
    expect(harness.manager.listStatuses()).toEqual([
      expect.objectContaining({ roleId: role.id, state: "running" })
    ]);

    native.emit({
      type: "popupClosed",
      url: "https://accounts.example.com/oauth"
    });
    await harness.manager.stop(role.id);
    }
  );

  it.each(["darwin", "win32"] as const)(
    "aggregates workspace role and popup audio and inherits mute on %s",
    async (platform) => {
      const harness = createHarness({ platform });
      const secondRole = createRole("role-2", "Alt");

      await harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ]);
      const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
      const popup = createOAuthPopup(harness.views[0], harness.views);
      harness.views[1].webContents.isCurrentlyAudible.mockReturnValue(true);
      popup.webContents.isCurrentlyAudible.mockReturnValue(true);
      harness.views[1].webContents.emit("audio-state-changed", {}, { audible: true });
      popup.webContents.emit("audio-state-changed", {}, { audible: true });

      expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({
        audible: true,
        audioMuted: false
      });

      harness.manager.setRuntimeTabAudioMuted(tabId, true);
      expect(harness.views[0].webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
      expect(harness.views[1].webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
      expect(popup.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);

      const newPopup = createOAuthPopup(harness.views[1], harness.views);
      expect(newPopup.webContents.setAudioMuted).toHaveBeenCalledWith(true);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-d08cac3d3f7d"
          : "browser-workspace-6b680bb8734e",
        () => {
          expect(harness.views[0].webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
          expect(harness.views[1].webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
          expect(popup.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
          expect(newPopup.webContents.setAudioMuted).toHaveBeenCalledWith(true);
        }
      );
    }
  );

  it("restores focus only to the active runtime tab", async () => {
    const harness = createHarness({ platform: "win32" });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launch(role);
    const firstView = harness.views[0];
    firstView.webContents.emit("focus");
    await harness.manager.launch(secondRole);
    const secondView = harness.views[1];
    firstView.webContents.focus.mockClear();
    secondView.webContents.focus.mockClear();

    harness.hosts[0].emit("focus");

    expect(secondView.webContents.focus).toHaveBeenCalledOnce();
    expect(firstView.webContents.focus).not.toHaveBeenCalled();
  });

  it("uses a frameless macOS BaseWindow with a secure overlay chrome view", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledWith(expect.objectContaining({
      frame: false,
      fullscreenable: true,
      show: false
    }));
    expect(harness.createTabbedHostWindow).not.toHaveBeenCalled();
    expect(harness.createRuntimeChromeView).toHaveBeenCalledWith(expect.objectContaining({
      webPreferences: expect.objectContaining({
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: "/app/out/preload/runtime-tabs.cjs",
        sandbox: true
      })
    }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 40
    });
    expect(harness.hosts[0].contentView.addChildView).toHaveBeenLastCalledWith(
      harness.chromeViews[0].view
    );
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ toolbarVisible: true, windowFullscreen: false })
    );
    expect(harness.manager.getRuntimeWindowForWebContents(harness.views[0].webContents.id)).toBeUndefined();
    expect(harness.manager.getRuntimeWindowForWebContents(harness.chromeViews[0].webContents.id))
      .toBe(harness.hosts[0]);

    createOAuthPopup(harness.views[0], harness.views);
    expect(harness.hosts[0].contentView.addChildView).toHaveBeenLastCalledWith(
      harness.chromeViews[0].view
    );
  });

  it("uses native AppKit tabs for framed macOS windows without HTML chrome polling", async () => {
    vi.useFakeTimers();
    const getCursorScreenPoint = vi.fn(() => ({ x: 100, y: 0 }));
    const handleRuntimeTabAction = vi.fn();
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      getCursorScreenPoint,
      handleRuntimeTabAction,
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledWith(expect.objectContaining({
      frame: true,
      fullscreenable: true,
      show: false,
      titleBarStyle: "default"
    }));
    expect(harness.createRuntimeChromeView).not.toHaveBeenCalled();
    expect(harness.createTabbedHostWindow).not.toHaveBeenCalled();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });
    expect(harness.nativeChromeControllers[0].setFullscreenPolicy)
      .toHaveBeenCalledWith("autoHide");
    expect(harness.nativeChromeControllers[0].update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayId: 11,
        tabs: [expect.objectContaining({ id: expect.any(String), name: "Main" })]
      })
    );

    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(false);

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 40,
      heightInset: 40
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);
    expect(harness.nativeChromeControllers[0].prepareFullscreenTransition)
      .toHaveBeenCalledWith(true);
    expect(
      harness.nativeChromeControllers[0].prepareFullscreenTransition.mock.invocationCallOrder[0]
    ).toBeLessThan(harness.hosts[0].setFullScreen.mock.invocationCallOrder[0]);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(getCursorScreenPoint).not.toHaveBeenCalled();

    const release = harness.manager.acquireRuntimeToolbarRevealLock(11);
    expect(harness.nativeChromeControllers[0].setRevealLocked).toHaveBeenLastCalledWith(true);
    release();
    expect(harness.nativeChromeControllers[0].setRevealLocked).toHaveBeenLastCalledWith(false);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    const nativePolicy = harness.nativeChromeControllers[0].setFullscreenPolicy;
    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    // Native fullscreen keeps one fixed full-size Electron root. Always-show
    // follows AppKit's safe content rect; auto-hide remains an overlay.
    const fixedContentBounds = { ...harness.hosts[0].contentBounds };
    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: false,
      yOffset: 0,
      heightInset: 0
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    expect(nativePolicy).toHaveBeenLastCalledWith("always");
    expect(harness.hosts[0].contentBounds).toEqual(fixedContentBounds);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    expect(nativePolicy.mock.invocationCallOrder.at(-1))
      .toBeLessThan(harness.views[0].setBounds.mock.invocationCallOrder.at(-1)!);

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 0,
      heightInset: 0
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(false);
    expect(nativePolicy).toHaveBeenLastCalledWith("autoHide");
    expect(harness.hosts[0].contentBounds).toEqual(fixedContentBounds);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    expect(nativePolicy.mock.invocationCallOrder.at(-1))
      .toBeLessThan(harness.views[0].setBounds.mock.invocationCallOrder.at(-1)!);
    await vi.advanceTimersByTimeAsync(500);
    expect(getCursorScreenPoint).not.toHaveBeenCalled();
    harness.nativeChromeControllers[0].emitAction({ type: "activate", tabId: "native-tab" });
    expect(handleRuntimeTabAction).toHaveBeenCalledWith(
      harness.hosts[0],
      11,
      { type: "activate", tabId: "native-tab" }
    );
    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 8,
      heightInset: 8
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.nativeChromeControllers[0].prepareFullscreenTransition)
      .toHaveBeenLastCalledWith(false);
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });

    harness.views[0].webContents.emit("enter-html-full-screen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    harness.views[0].webContents.emit("leave-html-full-screen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 8,
      width: 1200,
      height: 768
    });
    expect(harness.nativeChromeControllers[0].getContentLayout).toHaveBeenCalled();

    harness.hosts[0].emit("closed");
    expect(harness.nativeChromeControllers[0].destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("insets native workspace Views below windowed and visible fullscreen chrome", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const popup = createOAuthPopup(harness.views[0], harness.views);
    const divider = harness.views[2];
    const fixedRootBounds = { ...harness.hosts[0].contentBounds };

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    const windowedGameBounds = harness.views[0].setBounds.mock.lastCall![0];
    expect(windowedGameBounds.y + windowedGameBounds.height).toBe(776);

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 40,
      heightInset: 40
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].contentBounds).toEqual(fixedRootBounds);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 40,
      heightInset: 40
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    expect(harness.hosts[0].contentBounds).toEqual(fixedRootBounds);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 40, height: 736 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 40, height: 736 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 40, height: 736 })
    );

    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    divider.setBounds.mockClear();
    harness.nativeChromeControllers[0].emitContentLayout({
      valid: true,
      yOffset: 42,
      heightInset: 42
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).toHaveBeenCalledOnce();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 42, height: 734 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 42, height: 734 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 42, height: 734 })
    );

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 0,
      heightInset: 0
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(false);
    expect(harness.hosts[0].contentBounds.height).toBe(776);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );

    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    divider.setBounds.mockClear();
    const releaseRevealLock = harness.manager.acquireRuntimeToolbarRevealLock(11);
    harness.nativeChromeControllers[0].emitContentLayout({
      valid: true,
      yOffset: 40,
      heightInset: 40
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRevealLock();
    expect(harness.views[0].setBounds).not.toHaveBeenCalled();
    expect(popup.setBounds).not.toHaveBeenCalled();
    expect(divider.setBounds).not.toHaveBeenCalled();

    harness.nativeChromeControllers[0].getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 8,
      heightInset: 8
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
  });

  it("keeps auto-hide overlaid while entering fullscreen and follows AppKit while exiting", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      deferFullscreenTransitions: true,
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const popup = createOAuthPopup(harness.views[0], harness.views);
    const divider = harness.views[2];
    const controller = harness.nativeChromeControllers[0];
    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 6,
      heightInset: 6
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );

    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    divider.setBounds.mockClear();
    controller.emitContentLayout({ valid: true, yOffset: 40, heightInset: 40 });
    controller.emitContentLayout({ valid: true, yOffset: 8, heightInset: 8 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).not.toHaveBeenCalled();
    expect(popup.setBounds).not.toHaveBeenCalled();
    expect(divider.setBounds).not.toHaveBeenCalled();

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 0,
      heightInset: 0
    });
    harness.hosts[0].completeFullScreenTransition();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 0, height: 776 })
    );

    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    divider.setBounds.mockClear();
    controller.emitContentLayout({ valid: true, yOffset: 40, heightInset: 40 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).not.toHaveBeenCalled();
    expect(popup.setBounds).not.toHaveBeenCalled();
    expect(divider.setBounds).not.toHaveBeenCalled();

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 20,
      heightInset: 20
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 20, height: 756 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 20, height: 756 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 20, height: 756 })
    );

    harness.views[0].setBounds.mockClear();
    popup.setBounds.mockClear();
    divider.setBounds.mockClear();
    controller.emitContentLayout({ valid: true, yOffset: 8, heightInset: 8 });
    controller.emitContentLayout({ valid: true, yOffset: 8, heightInset: 8 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).toHaveBeenCalledOnce();
    expect(popup.setBounds).toHaveBeenCalledOnce();
    expect(divider.setBounds).toHaveBeenCalledOnce();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(popup.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
    expect(divider.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 8,
      heightInset: 8
    });
    harness.hosts[0].completeFullScreenTransition();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
  });

  it("follows AppKit layout changes while always-show enters and exits fullscreen", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      deferFullscreenTransitions: true,
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    const controller = harness.nativeChromeControllers[0];
    harness.manager.setAlwaysShowToolbarInFullScreen(true);

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 6,
      heightInset: 6
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 6, height: 770 })
    );

    harness.views[0].setBounds.mockClear();
    controller.emitContentLayout({ valid: true, yOffset: 4, heightInset: 4 });
    controller.emitContentLayout({ valid: true, yOffset: 3, heightInset: 3 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).toHaveBeenCalledOnce();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 3, height: 773 })
    );

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 40,
      heightInset: 40
    });
    harness.hosts[0].completeFullScreenTransition();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 40, height: 736 })
    );

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 20,
      heightInset: 20
    });
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 20, height: 756 })
    );

    harness.views[0].setBounds.mockClear();
    controller.emitContentLayout({ valid: true, yOffset: 8, heightInset: 8 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.views[0].setBounds).toHaveBeenCalledOnce();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );

    controller.getContentLayout.mockReturnValue({
      valid: true,
      yOffset: 8,
      heightInset: 8
    });
    harness.hosts[0].completeFullScreenTransition();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ y: 8, height: 768 })
    );
  });

  it("rolls back a failed native macOS fullscreen preflight without wedging the window", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const preflightError = new Error("preflight failed");
    const rollbackError = new Error("rollback failed");
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    const prepareFullscreenTransition =
      harness.nativeChromeControllers[0].prepareFullscreenTransition;
    prepareFullscreenTransition
      .mockImplementationOnce(() => {
        throw preflightError;
      })
      .mockImplementationOnce(() => {
        throw rollbackError;
      });

    expect(() => {
      harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    }).toThrow(preflightError);
    expect(harness.hosts[0].setFullScreen).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to roll back macOS fullscreen preflight.",
      rollbackError
    );

    prepareFullscreenTransition.mockReset();
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(prepareFullscreenTransition).toHaveBeenCalledWith(true);
    expect(harness.hosts[0].setFullScreen).toHaveBeenCalledWith(true);
    consoleError.mockRestore();
  });

  it("falls back to secure HTML chrome when native macOS attachment fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      macNativeChromeError: new Error("native unavailable"),
      platform: "darwin",
      useMacNativeChrome: true,
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ frame: true, titleBarStyle: "default" })
    );
    expect(harness.hosts[0].close).toHaveBeenCalledOnce();
    expect(harness.createHostWindow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ frame: false, fullscreenable: true })
    );
    expect(harness.createRuntimeChromeView).toHaveBeenCalledOnce();
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to attach native macOS runtime tabs; using the HTML fallback.",
      expect.any(Error)
    );
    consoleError.mockRestore();
  });

  it.each([
    { platform: "darwin" as const, excluded: true },
    { platform: "win32" as const, excluded: undefined }
  ])(
    "sets the shown-windows-menu exclusion only for $platform game hosts",
    async ({ platform, excluded }) => {
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        platform,
        useTabbedHostWindow: true,
        workspaceDisplays: runtimeDisplays
      });

      await harness.manager.launch(role);

      expect(
        (harness.hosts[0] as { excludedFromShownWindowsMenu?: boolean })
          .excludedFromShownWindowsMenu
      ).toBe(excluded);
    }
  );

  it("keeps Windows native caption buttons and title-bar overlay", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "win32",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);

    expect(harness.createHostWindow).not.toHaveBeenCalled();
    expect(harness.createTabbedHostWindow).toHaveBeenCalledWith(expect.objectContaining({
      autoHideMenuBar: true,
      frame: true,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 40 },
      webPreferences: expect.objectContaining({
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: "/app/out/preload/runtime-tabs.cjs",
        sandbox: true
      })
    }));
    expect(harness.createTabbedHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ tabbingIdentifier: expect.anything() })
    );
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    expect((harness.hosts[0] as ReturnType<typeof createMockBrowserHost>).webContents.send)
      .toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ toolbarVisible: true, windowFullscreen: false })
    );
  });

  it("sends a cached role game icon only through the runtime chrome state", async () => {
    const iconDataUrl = "data:image/png;base64,cnVudGltZS1pY29u";
    const getRuntimeTabGameIcon = vi.fn().mockResolvedValue(iconDataUrl);
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      getRuntimeTabGameIcon,
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launch(role);
    const [tab] = harness.manager.listEmbeddedRuntimeState().tabs;

    expect(getRuntimeTabGameIcon).toHaveBeenCalledOnce();
    expect(getRuntimeTabGameIcon).toHaveBeenCalledWith(role);
    expect(tab).not.toHaveProperty("gameIconDataUrl");
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({
        tabIconDataUrls: { [tab.id]: iconDataUrl },
        tabWorkspaceTemplates: {}
      })
    );

    harness.manager.setRuntimeTabsLanguage("ja");
    expect(getRuntimeTabGameIcon).toHaveBeenCalledOnce();
  });

  it("keeps workspace tabs on their layout marker without resolving game icons", async () => {
    const getRuntimeTabGameIcon = vi.fn().mockResolvedValue("data:image/png;base64,dW51c2Vk");
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      getRuntimeTabGameIcon,
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await harness.manager.launchWorkspace(
      workspace,
      [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }]
    );

    expect(getRuntimeTabGameIcon).not.toHaveBeenCalled();
    const [tab] = harness.manager.listEmbeddedRuntimeState().tabs;
    expect(harness.manager.listEmbeddedRuntimeState().tabs).toMatchObject([
      { type: "workspace", roleNames: [role.name] }
    ]);
    expect(tab).not.toHaveProperty("workspaceTemplate");
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({
        tabIconDataUrls: {},
        tabWorkspaceTemplates: { [tab.id]: workspace.template }
      })
    );
  });

  it("falls back without failing launch when the runtime game icon resolver rejects", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      getRuntimeTabGameIcon: vi.fn().mockRejectedValue(new Error("bad icon")),
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });

    await expect(harness.manager.launch(role)).resolves.toMatchObject({
      roleId: role.id,
      state: "running"
    });
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ tabIconDataUrls: {}, tabWorkspaceTemplates: {} })
    );
  });

  it("switches and reorders tabs without reloading their game views", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launch(role);
    await harness.manager.launch(secondRole);
    const initialState = harness.manager.listEmbeddedRuntimeState();
    const [firstTab, secondTab] = initialState.tabs;

    expect(initialState.windows).toMatchObject([{ displayId: 11, tabCount: 2 }]);
    expect(harness.createTabbedHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.views[0].view.setVisible).toHaveBeenLastCalledWith(false);
    expect(harness.views[1].view.setVisible).toHaveBeenLastCalledWith(true);
    expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );

    await harness.manager.showRuntimeTab(firstTab.id);
    expect(harness.views[0].view.setVisible).toHaveBeenLastCalledWith(true);
    expect(harness.views[1].view.setVisible).toHaveBeenLastCalledWith(false);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.loadURL).toHaveBeenCalledTimes(1);

    harness.manager.reorderRuntimeTab(secondTab.id, firstTab.id);
    await vi.waitFor(() => {
      expect(harness.manager.listEmbeddedRuntimeState().tabs.map((tab) => tab.id)).toEqual([
        secondTab.id,
        firstTab.id
      ]);
    });
    expect(harness.manager.listEmbeddedRuntimeState().tabs.map((tab) => tab.id)).toEqual([
      secondTab.id,
      firstTab.id
    ]);
  });

  it.each(["darwin", "win32"] as const)(
    "cycles visible runtime tabs with Ctrl+Tab and Ctrl+Shift+Tab on %s",
    async (platform) => {
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        platform,
        useTabbedHostWindow: true,
        workspaceDisplays: runtimeDisplays
      });
      const secondRole = createRole("role-2", "Alt");

      await harness.manager.launch(role);
      await harness.manager.launch(secondRole);
      const [firstTab, secondTab] = harness.manager.listEmbeddedRuntimeState().tabs;
      const nextEvent = { preventDefault: vi.fn() };

      harness.manager.setGameInputContext(harness.views[1].webContents.id, true);
      harness.views[1].webContents.emit("before-input-event", nextEvent, {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: false,
        type: "keyDown"
      });

      await vi.waitFor(() => expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ active: true, id: firstTab.id }),
          expect.objectContaining({ active: false, id: secondTab.id })
        ])
      ));
      expect(nextEvent.preventDefault).toHaveBeenCalledOnce();

      const previousEvent = { preventDefault: vi.fn() };
      harness.views[0].webContents.emit("before-input-event", previousEvent, {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: true,
        type: "keyDown"
      });

      await vi.waitFor(() => expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ active: false, id: firstTab.id }),
          expect.objectContaining({ active: true, id: secondTab.id })
        ])
      ));
      expect(previousEvent.preventDefault).toHaveBeenCalledOnce();

      await harness.manager.hideRuntimeTab(firstTab.id);
      const oneVisibleTabEvent = { preventDefault: vi.fn() };
      harness.views[1].webContents.emit("before-input-event", oneVisibleTabEvent, {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: false,
        type: "keyDown"
      });

      await vi.waitFor(() => expect(oneVisibleTabEvent.preventDefault).toHaveBeenCalledOnce());
      expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ active: true, id: secondTab.id }),
        expect.objectContaining({ hidden: true, id: firstTab.id })
      ]));
      v1Case(
        platform === "darwin"
          ? "browser-workspace-3702d1aea9ee"
          : "browser-workspace-87c65787a1f3",
        () => {
          expect(nextEvent.preventDefault).toHaveBeenCalledOnce();
          expect(previousEvent.preventDefault).toHaveBeenCalledOnce();
          expect(oneVisibleTabEvent.preventDefault).toHaveBeenCalledOnce();
          expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ active: true, id: secondTab.id }),
              expect.objectContaining({ hidden: true, id: firstTab.id })
            ])
          );
        }
      );
    }
  );

  it.each(["darwin", "win32"] as const)(
    "orders consecutive runtime tab shortcuts in Rust without refocusing the window on %s",
    async (platform) => {
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        platform,
        useTabbedHostWindow: true,
        workspaceDisplays: runtimeDisplays
      });
      const secondRole = createRole("role-2", "Alt");
      const thirdRole = createRole("role-3", "Third");

      await harness.manager.launch(role);
      await harness.manager.launch(secondRole);
      await harness.manager.launch(thirdRole);
      const [firstTab, secondTab, thirdTab] = harness.manager.listEmbeddedRuntimeState().tabs;
      const windowFocusCalls = harness.hosts[0].focus.mock.calls.length;
      const firstViewFocusCalls = harness.views[0].webContents.focus.mock.calls.length;
      const secondViewFocusCalls = harness.views[1].webContents.focus.mock.calls.length;
      const thirdViewFocusCalls = harness.views[2].webContents.focus.mock.calls.length;
      const nextEvents = [{ preventDefault: vi.fn() }, { preventDefault: vi.fn() }];
      const previousEvents = [{ preventDefault: vi.fn() }, { preventDefault: vi.fn() }];

      harness.views.forEach((view) => harness.manager.setGameInputContext(view.webContents.id, true));
      harness.views[2].webContents.emit("before-input-event", nextEvents[0], {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: false,
        type: "keyDown"
      });
      harness.views[0].webContents.emit("before-input-event", nextEvents[1], {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: false,
        type: "keyDown"
      });

      await vi.waitFor(() => {
        expect(harness.views[0].webContents.focus).toHaveBeenCalledTimes(
          firstViewFocusCalls + 1
        );
        expect(harness.views[1].webContents.focus).toHaveBeenCalledTimes(
          secondViewFocusCalls + 1
        );
      });
      expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ active: false, id: firstTab.id }),
        expect.objectContaining({ active: true, id: secondTab.id }),
        expect.objectContaining({ active: false, id: thirdTab.id })
      ]));
      nextEvents.forEach((event) => expect(event.preventDefault).toHaveBeenCalledOnce());
      expect(harness.hosts[0].focus).toHaveBeenCalledTimes(windowFocusCalls);
      expect(harness.views[0].webContents.focus).toHaveBeenCalledTimes(firstViewFocusCalls + 1);
      expect(harness.views[1].webContents.focus).toHaveBeenCalledTimes(secondViewFocusCalls + 1);
      expect(harness.views[2].webContents.focus).toHaveBeenCalledTimes(thirdViewFocusCalls);

      harness.views[1].webContents.emit("before-input-event", previousEvents[0], {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: true,
        type: "keyDown"
      });
      harness.views[0].webContents.emit("before-input-event", previousEvents[1], {
        alt: false,
        code: "Tab",
        control: true,
        isComposing: false,
        key: "Tab",
        meta: false,
        shift: true,
        type: "keyDown"
      });

      await vi.waitFor(() => {
        expect(harness.views[0].webContents.focus).toHaveBeenCalledTimes(
          firstViewFocusCalls + 2
        );
        expect(harness.views[2].webContents.focus).toHaveBeenCalledTimes(
          thirdViewFocusCalls + 1
        );
      });
      expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ active: false, id: firstTab.id }),
        expect.objectContaining({ active: false, id: secondTab.id }),
        expect.objectContaining({ active: true, id: thirdTab.id })
      ]));
      previousEvents.forEach((event) => expect(event.preventDefault).toHaveBeenCalledOnce());
      expect(harness.hosts[0].focus).toHaveBeenCalledTimes(windowFocusCalls);
      expect(harness.views[0].webContents.focus).toHaveBeenCalledTimes(firstViewFocusCalls + 2);
      expect(harness.views[1].webContents.focus).toHaveBeenCalledTimes(secondViewFocusCalls + 1);
      expect(harness.views[2].webContents.focus).toHaveBeenCalledTimes(thirdViewFocusCalls + 1);
      v1Case(
        platform === "darwin"
          ? "browser-workspace-f1eb2035ac59"
          : "browser-workspace-2bbe60d17f9d",
        () => {
          expect(harness.manager.listEmbeddedRuntimeState().tabs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ active: false, id: firstTab.id }),
              expect.objectContaining({ active: false, id: secondTab.id }),
              expect.objectContaining({ active: true, id: thirdTab.id })
            ])
          );
          expect(harness.hosts[0].focus).toHaveBeenCalledTimes(windowFocusCalls);
        }
      );
    }
  );

  it("overlays macOS fullscreen chrome without relaying out or reloading the game", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);

    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 2
    });
    const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;

    harness.manager.handleRuntimeToolbarPointer(11, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 0
    }));
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ fullscreen: true, toolbarVisible: true, windowFullscreen: true })
    );

    harness.manager.handleRuntimeToolbarPointer(11, false);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 2,
      y: 0
    }));
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);

    harness.manager.handleRuntimeToolbarPointer(11, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 0
    }));

    harness.manager.handleRuntimeToolbarPointer(11, false);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 2,
      y: 0
    }));
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
    vi.useRealTimers();
  });

  it.each([24, 30, 38])(
    "does not duplicate a %i DIP persistent menu-bar inset already applied to the content origin",
    async (safeArea) => {
      const display: WorkspaceDisplayInfo = {
        ...runtimeDisplays[0],
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        workArea: { x: 0, y: safeArea, width: 1200, height: 800 - safeArea }
      };
      const harness = createHarness({
        defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
        platform: "darwin",
        useTabbedHostWindow: true,
        workspaceDisplays: [display]
      });
      await harness.manager.launch(role);
      harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
      const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;

      harness.manager.handleRuntimeToolbarPointer(display.id, true);

      expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 0,
        width: 1200,
        height: 40
      });
      expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
      const caseId = {
        24: "browser-workspace-afd704ddddba",
        30: "browser-workspace-b839fe3129c1",
        38: "browser-workspace-4b6fa7f40ee5"
      }[safeArea]!;
      v1Case(caseId, () => {
        expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
          x: 0,
          y: 0,
          width: 1200,
          height: 40
        });
        expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
      });
      harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    }
  );

  it.each([24, 30, 38])(
    "positions fullscreen chrome below a %i DIP macOS menu-bar safe area",
    async (safeArea) => {
      const display: WorkspaceDisplayInfo = {
        ...runtimeDisplays[0],
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        workArea: { x: 0, y: safeArea, width: 1200, height: 800 - safeArea }
      };
      const harness = createHarness({
        defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
        platform: "darwin",
        useTabbedHostWindow: true,
        workspaceDisplays: [display]
      });
      await harness.manager.launch(role);
      harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1200, height: 800 };
      harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
      const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;

      harness.manager.handleRuntimeToolbarPointer(display.id, true);

      expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: safeArea,
        width: 1200,
        height: 40
      });
      expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
      const caseId = {
        24: "browser-workspace-df82c8ac9176",
        30: "browser-workspace-8e058324104c",
        38: "browser-workspace-bec19daf196c"
      }[safeArea]!;
      v1Case(caseId, () => {
        expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
          x: 0,
          y: safeArea,
          width: 1200,
          height: 40
        });
        expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
      });
      harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    }
  );

  it("converts the macOS menu-bar bottom into a chrome-view offset", async () => {
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: -1200, y: -100, width: 1200, height: 800 },
      workArea: { x: -1200, y: -70, width: 1200, height: 770 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    harness.hosts[0].contentBounds = { x: -1200, y: -90, width: 1200, height: 790 };
    const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;

    harness.manager.handleRuntimeToolbarPointer(display.id, true);

    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 20,
      width: 1200,
      height: 40
    });
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
  });

  it("uses a 30 DIP fallback when macOS never reports a menu-bar height", async () => {
    vi.useFakeTimers();
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 0, width: 1200, height: 800 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;

    harness.manager.handleRuntimeToolbarPointer(display.id, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    harness.manager.handleRuntimeToolbarPointer(display.id, false);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 2,
      y: 0
    }));

    harness.manager.handleRuntimeToolbarPointer(display.id, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    vi.useRealTimers();
  });

  it("keeps an always-visible macOS toolbar and game in one static layout group", async () => {
    vi.useFakeTimers();
    let cursor = { x: 100, y: 100 };
    const getCursorScreenPoint = vi.fn(() => cursor);
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 30, width: 1200, height: 770 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      getCursorScreenPoint,
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    display.workArea = { x: 0, y: 0, width: 1200, height: 800 };
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1200, height: 800 };
    harness.manager.handleDisplayMetricsChanged(display.id, display.workArea);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 0
    }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 760
    });

    const chromeBoundsCalls = harness.chromeViews[0].setBounds.mock.calls.length;
    const gameBoundsCalls = harness.views[0].setBounds.mock.calls.length;
    cursor = { x: 100, y: 0 };
    await vi.advanceTimersByTimeAsync(50);
    cursor = { x: 100, y: 100 };
    await vi.advanceTimersByTimeAsync(750);
    expect(getCursorScreenPoint).not.toHaveBeenCalled();
    expect(harness.chromeViews[0].setBounds).toHaveBeenCalledTimes(chromeBoundsCalls);
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);

    const release = harness.manager.acquireRuntimeToolbarRevealLock(display.id);
    release();
    expect(harness.chromeViews[0].setBounds).toHaveBeenCalledTimes(chromeBoundsCalls);
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(gameBoundsCalls);

    display.workArea = { x: 0, y: 38, width: 1200, height: 762 };
    harness.manager.handleDisplayMetricsChanged(display.id, display.workArea);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 40
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 760
    });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    harness.manager.setAlwaysShowToolbarInFullScreen(false);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 2
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 800
    });
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    vi.useRealTimers();
  });

  it("keeps workspace roles, popups, and dividers below an always-visible toolbar", async () => {
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 30, width: 1200, height: 770 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const popup = createOAuthPopup(harness.views[0], harness.views);

    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");

    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 40
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      y: 40,
      height: 730
    }));
    expect(popup.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      y: 40,
      height: 730
    }));
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      y: 40,
      height: 730
    }));
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.loadURL).toHaveBeenCalledTimes(1);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
  });

  it("reserves static macOS game space when always-show changes during HTML fullscreen", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);

    harness.views[0].webContents.emit("enter-html-full-screen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 0, height: 776 }));
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 2,
      y: 0
    }));
    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 0
    }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 40,
      width: 1200,
      height: 736
    });
    harness.manager.setAlwaysShowToolbarInFullScreen(false);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 2 }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 1200,
      height: 776
    });
    harness.views[0].webContents.emit("leave-html-full-screen");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
  });

  it("keeps fullscreen chrome revealed while a native menu holds its lock", async () => {
    vi.useFakeTimers();
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 0, width: 1200, height: 800 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      getCursorScreenPoint: () => ({ x: 100, y: 120 }),
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");

    const release = harness.manager.acquireRuntimeToolbarRevealLock(display.id);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    release();
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 2,
      y: 0
    }));
    vi.useRealTimers();
  });

  it("handles fullscreen hot-zone events independently on multiple displays", async () => {
    vi.useFakeTimers();
    const displays: WorkspaceDisplayInfo[] = [
      {
        ...runtimeDisplays[0],
        id: 33,
        bounds: { x: -1200, y: 0, width: 1200, height: 800 },
        workArea: { x: -1200, y: 0, width: 1200, height: 800 }
      },
      { ...runtimeDisplays[1], id: 44, bounds: { x: 0, y: 0, width: 1200, height: 800 },
        workArea: { x: 0, y: 0, width: 1200, height: 800 } }
    ];
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 33, workArea: displays[0].workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: displays
    });
    await harness.manager.launch(role);
    await harness.manager.launch(createRole("role-2", "Alt"), {
      target: { displayId: 44, workArea: displays[1].workArea }
    });
    harness.manager.handleRuntimeWindowControl(33, "toggleFullscreen");
    harness.manager.handleRuntimeWindowControl(44, "toggleFullscreen");

    harness.manager.handleRuntimeToolbarPointer(33, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    expect(harness.chromeViews[1].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 2 }));
    harness.manager.handleRuntimeToolbarPointer(44, true);
    expect(harness.chromeViews[1].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.loadURL).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("ignores fullscreen hot-zone events after hiding a native-fullscreen host", async () => {
    vi.useFakeTimers();
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 0, width: 1200, height: 800 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    harness.manager.handleRuntimeToolbarPointer(display.id, true);
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 30
    }));

    harness.manager.handleRuntimeWindowControl(display.id, "close");
    const chromeBoundsCalls = harness.chromeViews[0].setBounds.mock.calls.length;
    harness.manager.handleRuntimeToolbarPointer(display.id, true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.hosts[0].hide).toHaveBeenCalled();
    expect(harness.chromeViews[0].setBounds).toHaveBeenCalledTimes(chromeBoundsCalls);
    vi.useRealTimers();
  });

  it("keeps macOS native fullscreen active when the game receives Escape", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);

    harness.manager.handleRuntimeWindowControl(11, "minimize");
    expect(harness.hosts[0].minimize).toHaveBeenCalledOnce();
    harness.manager.handleRuntimeWindowControl(11, "zoom");
    harness.manager.handleRuntimeWindowControl(11, "zoom");
    expect(harness.hosts[0].maximize).toHaveBeenCalledOnce();
    expect(harness.hosts[0].unmaximize).toHaveBeenCalledOnce();

    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    harness.manager.handleRuntimeWindowControl(11, "minimize");
    expect(harness.hosts[0].minimize).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    harness.views[0].webContents.emit("before-input-event", { preventDefault }, {
      type: "keyDown",
      key: "Escape"
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.hosts[0].setFullScreen).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);

    const shortcutEvent = { preventDefault: vi.fn() };
    harness.views[0].webContents.emit("before-input-event", shortcutEvent, {
      control: true,
      isAutoRepeat: false,
      key: "f",
      meta: true,
      type: "keyDown"
    });
    expect(shortcutEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);

    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    harness.views[0].webContents.emit("enter-html-full-screen");
    harness.views[0].webContents.emit("before-input-event", { preventDefault }, {
      type: "keyDown",
      key: "Escape"
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);
    harness.views[0].webContents.emit("leave-html-full-screen");
    harness.manager.handleRuntimeWindowControl(11, "close");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.hosts[0].hide).toHaveBeenCalled();
  });

  it("tracks macOS native fullscreen only after the asynchronous window events", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      deferFullscreenTransitions: true,
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);

    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    harness.manager.handleRuntimeWindowControl(11, "minimize");
    harness.manager.handleRuntimeWindowControl(11, "zoom");

    expect(harness.hosts[0].setFullScreen).toHaveBeenCalledOnce();
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);
    expect(harness.hosts[0].minimize).not.toHaveBeenCalled();
    expect(harness.hosts[0].maximize).not.toHaveBeenCalled();
    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ windowFullscreen: false })
    );

    harness.hosts[0].completeFullScreenTransition();

    expect(harness.chromeViews[0].webContents.send).toHaveBeenLastCalledWith(
      "runtime-tabs:state",
      expect.objectContaining({ windowFullscreen: true })
    );
  });

  it("waits for native fullscreen to leave before destroying the last macOS host", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      deferFullscreenTransitions: true,
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");

    await harness.manager.stopRuntimeTab(tabId);
    expect(harness.hosts[0].close).not.toHaveBeenCalled();

    harness.hosts[0].completeFullScreenTransition();
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.hosts[0].close).not.toHaveBeenCalled();

    harness.hosts[0].completeFullScreenTransition();
    expect(harness.hosts[0].close).toHaveBeenCalledOnce();
    expect(harness.hosts[0].hide).not.toHaveBeenCalled();
  });

  it("retains the Windows fullscreen content inset behavior", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "win32",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 2 }));

    const preventDefault = vi.fn();
    harness.views[0].webContents.emit("before-input-event", { preventDefault }, {
      type: "keyDown",
      key: "Escape"
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.hosts[0].setFullScreen).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(true);

    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
    harness.manager.setAlwaysShowToolbarInFullScreen(false);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 2 }));
    harness.manager.handleRuntimeToolbarPointer(11, true);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
    harness.manager.handleRuntimeWindowControl(11, "toggleFullscreen");
    expect(harness.hosts[0].setFullScreen).toHaveBeenLastCalledWith(false);
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
  });

  it("moves a runtime tab to another display without reloading its session", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    const tabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;

    await harness.manager.moveRuntimeTab(tabId, 22);

    expect(harness.manager.listEmbeddedRuntimeState()).toMatchObject({
      windows: [{ displayId: 22, tabCount: 1 }],
      tabs: [{ id: tabId, displayId: 22, active: true }]
    });
    expect(harness.createTabbedHostWindow).toHaveBeenCalledTimes(2);
    expect(harness.hosts[0].contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.hosts[1].contentView.addChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
  });

  it("merges tabs into the Studio display host when a display is removed", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launch(role);
    await harness.manager.launch(secondRole, {
      target: { displayId: 22, workArea: runtimeDisplays[1].workArea }
    });
    const sourceState = harness.manager.listEmbeddedRuntimeState();
    const primaryTabId = sourceState.tabs.find((tab) => tab.sourceId === role.id)!.id;

    harness.manager.handleDisplayRemoved(22, 11);
    await vi.waitFor(() => expect(harness.hosts[1].close).toHaveBeenCalledTimes(1));

    const merged = harness.manager.listEmbeddedRuntimeState();
    expect(merged.windows).toMatchObject([{ displayId: 11, activeTabId: primaryTabId, tabCount: 2 }]);
    expect(merged.tabs.map((tab) => tab.displayId)).toEqual([11, 11]);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.hosts[1].close).toHaveBeenCalledTimes(1);
  });

  it("clamps a display host into its changed work area", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    await harness.manager.launch(role);
    harness.hosts[0].contentBounds = { x: -200, y: -100, width: 1500, height: 1000 };

    harness.manager.handleDisplayMetricsChanged(11, { x: 20, y: 30, width: 1000, height: 700 });

    expect(harness.hosts[0].setBounds).toHaveBeenLastCalledWith({
      x: 20,
      y: 30,
      width: 1000,
      height: 700
    });
  });

  it("keeps always-show layout fixed while refreshing the macOS menu-bar height cache", async () => {
    const display: WorkspaceDisplayInfo = {
      ...runtimeDisplays[0],
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      workArea: { x: 0, y: 24, width: 1200, height: 776 }
    };
    const harness = createHarness({
      defaultLaunchTarget: { displayId: display.id, workArea: display.workArea },
      platform: "darwin",
      useTabbedHostWindow: true,
      workspaceDisplays: [display]
    });
    await harness.manager.launch(role);
    harness.manager.setAlwaysShowToolbarInFullScreen(true);
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 0 }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ y: 40 }));
    harness.hosts[0].setBounds.mockClear();
    display.workArea = { x: 0, y: 38, width: 1200, height: 762 };
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1200, height: 800 };

    harness.manager.handleDisplayMetricsChanged(display.id, display.workArea);

    expect(harness.hosts[0].setBounds).not.toHaveBeenCalled();
    expect(harness.chromeViews[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      height: 40,
      y: 0
    }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      y: 40,
      height: 760
    }));
    harness.manager.handleRuntimeWindowControl(display.id, "toggleFullscreen");
  });

  it("wraps game page load failures with a stable user-facing error and cleans up the host", async () => {
    const harness = createHarness({
      loadUrlHandlers: [
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });

    const launchPromise = harness.manager.launch(role);

    await expect(launchPromise).rejects.toThrow(BrowserGameLoadError);
    await expect(launchPromise).rejects.toThrow(
      "Unable to load the game page. If you use a game accelerator, enable global, TUN, or system proxy mode, or set a local proxy in Game settings."
    );
    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.hosts[0].contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
  });

  it("applies browser font preferences before creating a new role view", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts });

    await harness.manager.launch(role);

    expect(applyBrowserFonts).toHaveBeenCalledWith(role, createRoleSessionPartition(role.id));
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createView.mock.invocationCallOrder[0]
    );
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
    );
    v1Case("browser-workspace-074d6b7f91fa", () => {
      expect(applyBrowserFonts).toHaveBeenCalledWith(
        role,
        createRoleSessionPartition(role.id)
      );
      expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
        harness.createView.mock.invocationCallOrder[0]
      );
    });
  });

  it("applies browser proxy settings before loading the game page", async () => {
    const applyBrowserProxy = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserProxy });

    await harness.manager.launch(role);

    expect(applyBrowserProxy).toHaveBeenCalledWith(
      role,
      createRoleSessionPartition(role.id),
      harness.views[0].webContents.session
    );
    expect(applyBrowserProxy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
    );
  });

  it("applies CDN compatibility after the proxy and before loading the game page", async () => {
    const applyBrowserProxy = vi.fn().mockResolvedValue(undefined);
    const applyCdnCompatibility = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserProxy, applyCdnCompatibility });

    await harness.manager.launch(role);

    expect(applyBrowserProxy).toHaveBeenCalledTimes(1);
    expect(applyCdnCompatibility).toHaveBeenCalledTimes(1);
    expect(applyBrowserProxy.mock.invocationCallOrder[0]).toBeLessThan(
      applyCdnCompatibility.mock.invocationCallOrder[0]
    );
    expect(applyCdnCompatibility.mock.invocationCallOrder[0]).toBeLessThan(
      harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
    );
  });

  it("fails open when CDN compatibility setup fails", async () => {
    const applyCdnCompatibility = vi.fn().mockRejectedValue(new Error("Mirror setup failed."));
    const harness = createHarness({ applyCdnCompatibility });

    await expect(harness.manager.launch(role)).resolves.toMatchObject({ state: "running" });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
  });

  it("cleans up the host when browser proxy setup fails", async () => {
    const applyBrowserProxy = vi.fn().mockRejectedValue(new Error("Proxy setup failed."));
    const harness = createHarness({ applyBrowserProxy });

    await expect(harness.manager.launch(role)).rejects.toThrow("Proxy setup failed.");

    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.views[0].webContents.loadURL).not.toHaveBeenCalled();
    expect(harness.hosts[0].contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
  });

  it("focuses an existing single-role host instead of opening another window", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts });

    await harness.manager.launch(role);
    applyBrowserFonts.mockClear();
    harness.views[0].webContents.loadURL.mockClear();
    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createView).toHaveBeenCalledTimes(1);
    expect(applyBrowserFonts).not.toHaveBeenCalled();
    expect(harness.views[0].webContents.loadURL).not.toHaveBeenCalled();
    expect(harness.hosts[0].focus).toHaveBeenCalledTimes(2);
  });

  it("leaves a four-pixel material gap between workspace roles on macOS", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts, platform: "darwin" });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: "#000000",
        closable: true,
        maximizable: true,
        minimizable: true,
        resizable: true,
        title: "Rion Studio",
        titleBarStyle: "default",
        vibrancy: "under-window",
        visualEffectState: "followWindow"
      })
    );
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ transparent: true })
    );
    expect(harness.hosts[0].contentView.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[1].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[0].webContents.getZoomFactor()).toBe(0.9);
    expect(harness.views[1].webContents.getZoomFactor()).toBe(0.9);
    expect(applyBrowserFonts).toHaveBeenCalledWith(role, createRoleSessionPartition(role.id));
    expect(applyBrowserFonts).toHaveBeenCalledWith(secondRole, createRoleSessionPartition(secondRole.id));
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createView.mock.invocationCallOrder[0]
    );
  });

  it.each([25, 90, 125] as const)(
    "keeps %s percent browser zoom after initial and cross-origin navigation",
    async (browserZoomPercent) => {
      const harness = createHarness();
      const zoomWorkspace = { ...workspace, browserZoomPercent };

      await harness.manager.launchWorkspace(zoomWorkspace, [
        { role, rect: zoomWorkspace.slots[0].rect }
      ]);

      expect(harness.createView).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          webPreferences: expect.objectContaining({ zoomFactor: browserZoomPercent / 100 })
        })
      );
      expect(harness.views[0].webContents.getZoomFactor()).toBe(browserZoomPercent / 100);

      await harness.views[0].webContents.loadURL("https://accounts.example.net/redirect");

      expect(harness.views[0].webContents.getZoomFactor()).toBe(browserZoomPercent / 100);
      const caseId = {
        25: "browser-workspace-f288ec9f3e41",
        90: "browser-workspace-5935bacd1051",
        125: "browser-workspace-3019794f93b7"
      }[browserZoomPercent];
      v1Case(caseId, () => {
        expect(harness.views[0].webContents.getZoomFactor()).toBe(browserZoomPercent / 100);
        expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(
          "https://accounts.example.net/redirect"
        );
      });
    }
  );

  it.each([
    ["darwin", { code: "Equal", control: false, meta: true, shift: true }, "in"],
    ["darwin", { code: "NumpadSubtract", control: false, meta: true, shift: false }, "out"],
    ["darwin", { code: "Digit0", control: false, meta: true, shift: false }, "reset"],
    ["win32", { code: "NumpadAdd", control: true, meta: false, shift: false }, "in"],
    ["win32", { code: "Minus", control: true, meta: false, shift: false }, "out"],
    ["win32", { code: "Numpad0", control: true, meta: false, shift: false }, "reset"]
  ] as const)("classifies native browser zoom on %s", (platform, modifiers, expected) => {
    expect(classifyNativeZoomShortcut({
      alt: false,
      isComposing: false,
      key: modifiers.code,
      type: "keyDown",
      ...modifiers
    }, platform)).toBe(expected);
    expect(classifyNativeZoomShortcut({
      alt: true,
      isComposing: false,
      key: modifiers.code,
      type: "keyDown",
      ...modifiers
    }, platform)).toBeUndefined();
    expect(classifyNativeZoomShortcut({
      alt: false,
      isComposing: true,
      key: modifiers.code,
      type: "keyDown",
      ...modifiers
    }, platform)).toBeUndefined();
    expect(classifyNativeZoomShortcut({
      alt: false,
      code: modifiers.code,
      control: true,
      isComposing: false,
      key: modifiers.code,
      meta: true,
      shift: modifiers.shift,
      type: "keyDown"
    }, platform)).toBeUndefined();
    expect(classifyNativeZoomShortcut({
      alt: false,
      isComposing: false,
      key: modifiers.code,
      type: "keyUp",
      ...modifiers
    }, platform)).toBeUndefined();
    if (expected !== "in") {
      expect(classifyNativeZoomShortcut({
        alt: false,
        isComposing: false,
        key: modifiers.code,
        type: "keyDown",
        ...modifiers,
        shift: true
      }, platform)).toBeUndefined();
    }
    const caseId = ({
      "darwin:Equal": "browser-workspace-3ba42c388c15",
      "darwin:NumpadSubtract": "browser-workspace-4bbcc3605a5c",
      "darwin:Digit0": "browser-workspace-ead7ec740aab",
      "win32:NumpadAdd": "browser-workspace-19acd98432da",
      "win32:Minus": "browser-workspace-0ca1210d6eef",
      "win32:Numpad0": "browser-workspace-f2f0e81d61c8"
    } as Record<string, string>)[`${platform}:${modifiers.code}`]!;
    v1Case(caseId, () => {
      expect(classifyNativeZoomShortcut({
        alt: false,
        isComposing: false,
        key: modifiers.code,
        type: "keyDown",
        ...modifiers
      }, platform)).toBe(expected);
    });
  });

  it.each([
    [false, "next"],
    [true, "previous"]
  ] as const)("classifies Ctrl+Tab runtime tab switching", (shift, expected) => {
    const input = {
      alt: false,
      code: "Tab",
      control: true,
      isComposing: false,
      key: "Tab",
      meta: false,
      shift,
      type: "keyDown"
    };

    expect(classifyRuntimeTabSwitchShortcut(input)).toBe(expected);
    expect(classifyRuntimeTabSwitchShortcut({ ...input, alt: true })).toBeUndefined();
    expect(classifyRuntimeTabSwitchShortcut({ ...input, control: false })).toBeUndefined();
    expect(classifyRuntimeTabSwitchShortcut({ ...input, meta: true })).toBeUndefined();
    expect(classifyRuntimeTabSwitchShortcut({ ...input, type: "keyUp" })).toBeUndefined();
    v1Case(
      shift ? "browser-workspace-7f991a0d8f29" : "browser-workspace-c978143f30b8",
      () => {
        expect(classifyRuntimeTabSwitchShortcut(input)).toBe(expected);
        expect(classifyRuntimeTabSwitchShortcut({ ...input, alt: true })).toBeUndefined();
        expect(classifyRuntimeTabSwitchShortcut({ ...input, type: "keyUp" })).toBeUndefined();
      }
    );
  });

  it.each([
    ["in", 90, 100, true],
    ["in", 90, 90, false],
    ["in", 300, 300, true],
    ["out", 90, 80, true],
    ["out", 90, 100, false],
    ["out", 50, 50, true],
    ["reset", 90, 100, true],
    ["reset", 90, 90, false]
  ] as const)(
    "validates native zoom result %s from %s to %s",
    (action, previousPercent, nextPercent, expected) => {
      expect(isExpectedNativeZoomResult(action, previousPercent, nextPercent)).toBe(expected);
      const caseId = ({
        "in:90:100": "browser-workspace-889b5c73962c",
        "in:90:90": "browser-workspace-0e9f68cb0180",
        "in:300:300": "browser-workspace-140e8f7adf23",
        "out:90:80": "browser-workspace-a885357bb42b",
        "out:90:100": "browser-workspace-18902d65009b",
        "out:50:50": "browser-workspace-687f83dcb393",
        "reset:90:100": "browser-workspace-d6db27cb5ba6",
        "reset:90:90": "browser-workspace-87b82c305dcc"
      } as Record<string, string>)[`${action}:${previousPercent}:${nextPercent}`]!;
      v1Case(caseId, () => {
        expect(isExpectedNativeZoomResult(action, previousPercent, nextPercent)).toBe(expected);
      });
    }
  );

  it("uses a workspace role zoom override instead of adaptive zoom", async () => {
    const harness = createHarness();
    const adaptiveWorkspace = { ...workspace, browserZoomMode: "adaptive" as const };

    await harness.manager.launchWorkspace(adaptiveWorkspace, [{
      role,
      rect: adaptiveWorkspace.slots[0].rect,
      browserZoomPercent: 110
    }]);

    expect(harness.views[0].webContents.getZoomFactor()).toBe(1.1);
    harness.hosts[0].contentBounds.width = 700;
    harness.hosts[0].emit("resize");
    expect(harness.views[0].webContents.getZoomFactor()).toBe(1.1);
  });

  it.each(["darwin", "win32"] as const)(
    "targets native role zoom and debounces workspace persistence on %s",
    async (platform) => {
      vi.useFakeTimers();
      try {
        const persistWorkspaceRoleZoom = vi.fn().mockResolvedValue(undefined);
        const performNativeZoom = createMockNativeZoomPerformer();
        const harness = createHarness({ platform, performNativeZoom, persistWorkspaceRoleZoom });
        const adaptiveWorkspace = { ...workspace, browserZoomMode: "adaptive" as const };
        await harness.manager.launchWorkspace(adaptiveWorkspace, [{
          role,
          rect: adaptiveWorkspace.slots[0].rect
        }]);
        const webContents = harness.views[0].webContents;
        harness.manager.setGameInputContext(webContents.id, true);
        const input = {
          alt: false,
          code: "Equal",
          control: platform === "win32",
          isAutoRepeat: false,
          isComposing: false,
          key: "+",
          meta: platform === "darwin",
          shift: true,
          type: "keyDown"
        };
        const initialZoomFactor = webContents.getZoomFactor();

        const nativeEvent = { preventDefault: vi.fn() };
        webContents.emit("before-input-event", nativeEvent, input);
        await vi.advanceTimersByTimeAsync(0);
        const firstZoomFactor = getMockNativeZoomFactor("in", initialZoomFactor);

        expect(nativeEvent.preventDefault).not.toHaveBeenCalled();
        expect(webContents.getZoomFactor()).toBe(firstZoomFactor);
        expect(webContents.setIgnoreMenuShortcuts.mock.calls.slice(-2)).toEqual([[true], [true]]);
        expect(performNativeZoom).toHaveBeenLastCalledWith(
          "in",
          harness.hosts[0],
          webContents,
          {
            altKey: false,
            ctrlKey: platform === "win32",
            metaKey: platform === "darwin",
            shiftKey: true,
            triggeredByAccelerator: true
          }
        );
        expect(persistWorkspaceRoleZoom).not.toHaveBeenCalled();

        const repeatEvent = { preventDefault: vi.fn() };
        webContents.emit("before-input-event", repeatEvent, {
          ...input,
          isAutoRepeat: true
        });
        await vi.advanceTimersByTimeAsync(0);
        const secondZoomFactor = getMockNativeZoomFactor("in", firstZoomFactor);
        expect(repeatEvent.preventDefault).not.toHaveBeenCalled();
        expect(webContents.getZoomFactor()).toBe(secondZoomFactor);
        await vi.advanceTimersByTimeAsync(199);
        expect(persistWorkspaceRoleZoom).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(persistWorkspaceRoleZoom).toHaveBeenCalledOnce();
        expect(persistWorkspaceRoleZoom).toHaveBeenCalledWith(
          workspace.id,
          role.id,
          Math.round(secondZoomFactor * 100)
        );
        harness.hosts[0].contentBounds.width = 700;
        harness.hosts[0].emit("resize");
        expect(webContents.getZoomFactor()).toBe(secondZoomFactor);
        v1Case(
          platform === "darwin"
            ? "browser-workspace-7fad93d9b2f7"
            : "browser-workspace-5ac6e4515a71",
          () => {
            expect(performNativeZoom).toHaveBeenCalledTimes(2);
            expect(persistWorkspaceRoleZoom).toHaveBeenCalledOnce();
            expect(persistWorkspaceRoleZoom).toHaveBeenCalledWith(
              workspace.id,
              role.id,
              Math.round(secondZoomFactor * 100)
            );
            expect(webContents.getZoomFactor()).toBe(secondZoomFactor);
          }
        );
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("zooms only the role view that emitted the shortcut", async () => {
    vi.useFakeTimers();
    try {
      const secondRole = createRole("role-2", "Alt");
      const performNativeZoom = createMockNativeZoomPerformer();
      const persistWorkspaceRoleZoom = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness({
        performNativeZoom,
        persistWorkspaceRoleZoom,
        platform: "win32"
      });
      await harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ]);
      const firstWebContents = harness.views[0].webContents;
      const secondWebContents = harness.views[1].webContents;
      const firstZoomFactor = firstWebContents.getZoomFactor();
      const secondZoomFactor = secondWebContents.getZoomFactor();
      harness.manager.setGameInputContext(secondWebContents.id, true);

      secondWebContents.emit("before-input-event", { preventDefault: vi.fn() }, {
        alt: false,
        code: "Minus",
        control: true,
        isAutoRepeat: false,
        isComposing: false,
        key: "-",
        meta: false,
        shift: false,
        type: "keyDown"
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(performNativeZoom).toHaveBeenCalledWith(
        "out",
        harness.hosts[0],
        secondWebContents,
        expect.objectContaining({ ctrlKey: true, triggeredByAccelerator: true })
      );
      expect(firstWebContents.getZoomFactor()).toBe(firstZoomFactor);
      expect(secondWebContents.getZoomFactor()).toBe(
        getMockNativeZoomFactor("out", secondZoomFactor)
      );
      expect(persistWorkspaceRoleZoom).toHaveBeenCalledWith(
        workspace.id,
        secondRole.id,
        Math.round(getMockNativeZoomFactor("out", secondZoomFactor) * 100)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("targets a role popup and synchronizes its native zoom with the main game view", async () => {
    vi.useFakeTimers();
    try {
      const performNativeZoom = createMockNativeZoomPerformer();
      const persistWorkspaceRoleZoom = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness({
        performNativeZoom,
        persistWorkspaceRoleZoom,
        platform: "win32"
      });
      await harness.manager.launchWorkspace(workspace, [{ role, rect: workspace.slots[0].rect }]);
      const mainWebContents = harness.views[0].webContents;
      const popup = createOAuthPopup(harness.views[0], harness.views);
      const initialZoomFactor = popup.webContents.getZoomFactor();
      const event = { preventDefault: vi.fn() };

      popup.webContents.emit("before-input-event", event, {
        alt: false,
        code: "Equal",
        control: true,
        isAutoRepeat: false,
        isComposing: false,
        key: "+",
        meta: false,
        shift: true,
        type: "keyDown"
      });
      await vi.advanceTimersByTimeAsync(200);
      const nextZoomFactor = getMockNativeZoomFactor("in", initialZoomFactor);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(performNativeZoom).toHaveBeenCalledWith(
        "in",
        harness.hosts[0],
        popup.webContents,
        expect.objectContaining({ ctrlKey: true, triggeredByAccelerator: true })
      );
      expect(popup.webContents.setIgnoreMenuShortcuts.mock.calls.slice(-2)).toEqual([[true], [false]]);
      expect(mainWebContents.getZoomFactor()).toBe(nextZoomFactor);
      expect(popup.webContents.getZoomFactor()).toBe(nextZoomFactor);
      expect(persistWorkspaceRoleZoom).toHaveBeenCalledWith(
        workspace.id,
        role.id,
        Math.round(nextZoomFactor * 100)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current native zoom when workspace persistence fails", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const persistWorkspaceRoleZoom = vi.fn().mockRejectedValue(new Error("disk full"));
      const performNativeZoom = createMockNativeZoomPerformer();
      const harness = createHarness({ platform: "win32", performNativeZoom, persistWorkspaceRoleZoom });
      await harness.manager.launchWorkspace(workspace, [{ role, rect: workspace.slots[0].rect }]);
      const webContents = harness.views[0].webContents;
      const initialZoomFactor = webContents.getZoomFactor();
      harness.manager.setGameInputContext(webContents.id, true);

      webContents.emit("before-input-event", { preventDefault: vi.fn() }, {
        alt: false,
        code: "Equal",
        control: true,
        isAutoRepeat: false,
        isComposing: false,
        key: "+",
        meta: false,
        shift: true,
        type: "keyDown"
      });
      await vi.advanceTimersByTimeAsync(200);
      const nextZoomFactor = getMockNativeZoomFactor("in", initialZoomFactor);

      expect(persistWorkspaceRoleZoom).toHaveBeenCalledWith(
        workspace.id,
        role.id,
        Math.round(nextZoomFactor * 100)
      );
      expect(webContents.getZoomFactor()).toBe(nextZoomFactor);
      harness.hosts[0].contentBounds.width = 700;
      harness.hosts[0].emit("resize");
      expect(webContents.getZoomFactor()).toBe(nextZoomFactor);
      expect(warning).toHaveBeenCalledWith(
        "Failed to persist workspace role browser zoom.",
        expect.any(Error)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist or stop adaptive zoom when the targeted native role does not change", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const performNativeZoom = vi.fn<NonNullable<ElectronBrowserRuntimeOptions["performNativeZoom"]>>(
        () => true
      );
      const persistWorkspaceRoleZoom = vi.fn().mockResolvedValue(undefined);
      const harness = createHarness({
        performNativeZoom,
        persistWorkspaceRoleZoom,
        platform: "win32"
      });
      const adaptiveWorkspace = { ...workspace, browserZoomMode: "adaptive" as const };
      await harness.manager.launchWorkspace(adaptiveWorkspace, [{
        role,
        rect: adaptiveWorkspace.slots[0].rect
      }]);
      const webContents = harness.views[0].webContents;
      const initialZoomFactor = webContents.getZoomFactor();
      harness.manager.setGameInputContext(webContents.id, true);

      webContents.emit("before-input-event", { preventDefault: vi.fn() }, {
        alt: false,
        code: "Equal",
        control: true,
        isAutoRepeat: false,
        isComposing: false,
        key: "+",
        meta: false,
        shift: true,
        type: "keyDown"
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(webContents.getZoomFactor()).toBe(initialZoomFactor);
      expect(persistWorkspaceRoleZoom).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        "Native browser zoom did not change the targeted game role as expected.",
        expect.objectContaining({ roleId: role.id, zoomAction: "in" })
      );

      harness.hosts[0].contentBounds.width = 1600;
      harness.hosts[0].emit("resize");
      expect(webContents.getZoomFactor()).not.toBe(initialZoomFactor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adapts each embedded viewport zoom across divider and window resizes", async () => {
    const harness = createHarness();
    const adaptiveWorkspace = { ...workspace, browserZoomMode: "adaptive" as const };

    await harness.manager.launchWorkspace(adaptiveWorkspace, [
      { role, rect: adaptiveWorkspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: adaptiveWorkspace.slots[1].rect }
    ]);

    expect(harness.views[0].webContents.getZoomFactor()).toBe(0.5);
    expect(harness.views[1].webContents.getZoomFactor()).toBe(0.5);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 720
    });

    expect(harness.views[0].webContents.getZoomFactor()).toBe(0.5);
    expect(harness.views[1].webContents.getZoomFactor()).toBe(0.33);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    expect(popup.webContents.getZoomFactor()).toBe(0.5);

    harness.hosts[0].contentBounds.width = 1600;
    harness.hosts[0].emit("resize");

    expect(harness.views[0].webContents.getZoomFactor()).toBe(0.75);
    expect(harness.views[1].webContents.getZoomFactor()).toBe(0.5);
    expect(popup.webContents.getZoomFactor()).toBe(0.75);

    await harness.views[0].webContents.loadURL("https://accounts.example.net/redirect");
    expect(harness.views[0].webContents.getZoomFactor()).toBe(0.75);
  });

  it("inherits workspace zoom in popups and resets an existing session to 100 percent", async () => {
    const harness = createHarness();
    const zoomWorkspace = { ...workspace, browserZoomPercent: 75 as const };

    await harness.manager.launchWorkspace(zoomWorkspace, [
      { role, rect: zoomWorkspace.slots[0].rect }
    ]);
    const popup = createOAuthPopup(harness.views[0], harness.views);
    await popup.webContents.loadURL("https://accounts.example.net/oauth");

    expect(harness.createView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ zoomFactor: 0.75 })
      })
    );
    expect(popup.webContents.getZoomFactor()).toBe(0.75);

    await harness.manager.launch(role);

    expect(harness.views[0].webContents.getZoomFactor()).toBe(1);
    expect(popup.webContents.getZoomFactor()).toBe(1);
  });

  it("uses an acrylic workspace material on Windows", async () => {
    const harness = createHarness({ platform: "win32" });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: "#202024",
        backgroundMaterial: "acrylic"
      })
    );
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ transparent: true })
    );
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
  });

  it("focuses the first workspace role without attaching a CPU throttle debugger", async () => {
    const harness = createHarness({ platform: "win32" });
    const secondRole = createRole("role-2", "Alt");
    const priorityWorkspace: LaunchWorkspace = { ...workspace };

    const statuses = await harness.manager.launchWorkspace(priorityWorkspace, [
      { role, rect: priorityWorkspace.slots[0].rect },
      { role: secondRole, rect: priorityWorkspace.slots[1].rect }
    ]);

    v1Case("resource-platform-46bfa38c2810", () => {
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: role.id }),
        expect.objectContaining({ roleId: secondRole.id })
      ]));
      expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
      expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    });
    v1Case("resource-platform-458efe9621a6", () => {
      expect(harness.views[0].webContents.focus).toHaveBeenCalledOnce();
      expect(harness.views[1].webContents.focus).not.toHaveBeenCalled();
    });

    harness.views[1].webContents.emit("focus");
    await Promise.resolve();
    expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );
  });

  it.each(["darwin", "win32"] as const)(
    "keeps two single-role tabs responsive through switch, hide, system close, stop, and runtime end on %s",
    async (platform) => {
      const harness = createHarness({
        defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
        platform,
        ...(platform === "darwin"
          ? { useMacNativeChrome: true }
          : { useTabbedHostWindow: true }),
        workspaceDisplays: runtimeDisplays
      });
      const secondRole = createRole("role-2", "Alt");

      await harness.manager.launch(role);
      await harness.manager.launch(secondRole);
      const [firstTab, secondTab] = harness.manager.listEmbeddedRuntimeState().tabs;

      for (let index = 0; index < 4; index += 1) {
        await harness.manager.showRuntimeTab(index % 2 === 0 ? firstTab.id : secondTab.id);
      }
      await harness.manager.hideRuntimeTab(firstTab.id);

      const closeEvent = { preventDefault: vi.fn() };
      harness.hosts[0].emit("close", closeEvent);
      expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
      expect(harness.hosts[0].hide).toHaveBeenCalled();
      expect(harness.manager.listStatuses()).toEqual([
        expect.objectContaining({ roleId: role.id, state: "running" }),
        expect.objectContaining({ roleId: secondRole.id, state: "running" })
      ]);

      await harness.manager.stopRuntimeTab(secondTab.id);
      expect(harness.manager.listStatuses()).toEqual([
        expect.objectContaining({ roleId: role.id, state: "running" })
      ]);
      await harness.manager.stopAll();
      expect(harness.manager.listStatuses()).toEqual([]);
      expect(harness.manager.listEmbeddedRuntimeState()).toMatchObject({
        tabs: [],
        windows: []
      });

      for (const view of harness.views) {
        expect(view.debuggerApi.attach).not.toHaveBeenCalled();
        expect(view.debuggerApi.isAttached()).toBe(false);
        expect(view.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
          "Target.setAutoAttach",
          expect.anything()
        );
        expect(view.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
          "Emulation.setCPUThrottlingRate",
          expect.anything()
        );
      }
      for (const [viewOptions] of harness.createView.mock.calls) {
        expect(viewOptions).toEqual(expect.objectContaining({
          webPreferences: expect.objectContaining({ backgroundThrottling: true })
        }));
      }
    }
  );

  it("leaves inactive single-role tabs to native background throttling", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "win32",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launch(role);
    await harness.manager.launch(secondRole);

    v1Case("browser-workspace-8855d2f20327", () => {
      expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
      expect(harness.manager.listStatuses().find((status) => status.roleId === role.id))
        .toMatchObject({ roleId: role.id, state: "running" });
    });
    expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );
    expect(harness.manager.listStatuses().find((status) => status.roleId === secondRole.id))
      .toMatchObject({ roleId: secondRole.id, state: "running" });
  });

  it("switches, hides, moves, and closes tabs without custom CPU throttling", async () => {
    const harness = createHarness({
      defaultLaunchTarget: { displayId: 11, workArea: runtimeDisplays[0].workArea },
      platform: "win32",
      useTabbedHostWindow: true,
      workspaceDisplays: runtimeDisplays
    });
    const firstWorkspace: LaunchWorkspace = {
      ...workspace,
      id: "adaptive-tab-1"
    };
    const secondRole = createRole("role-2", "Alt");
    const secondWorkspace: LaunchWorkspace = {
      ...workspace,
      id: "adaptive-tab-2"
    };

    await harness.manager.launchWorkspace(firstWorkspace, [
      { role, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);
    const firstTabId = harness.manager.listEmbeddedRuntimeState().tabs[0].id;
    await harness.manager.launchWorkspace(secondWorkspace, [
      { role: secondRole, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);

    expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );
    expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );
    v1Case("resource-platform-4de9ca596dee", () => {
      expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
      expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    });
    v1Case("resource-platform-dafdc0585039", () => {
      expect(harness.views[0].debuggerApi.attach).not.toHaveBeenCalled();
      expect(harness.views[1].debuggerApi.attach).not.toHaveBeenCalled();
    });
    v1Case("resource-platform-bbfb276cd2a9", () => {
      expect(harness.views.every(
        (view) => !view.debuggerApi.sendCommand.mock.calls.some(
          ([method]) => method === "Emulation.setCPUThrottlingRate"
        )
      )).toBe(true);
    });

    harness.hosts[0].emit("hide");
    await Promise.resolve();
    v1Case("resource-platform-d62f2ca98a7b", () => {
      expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    });

    await harness.manager.showRuntimeTab(firstTabId);

    expect(harness.views[0].view.setVisible).toHaveBeenLastCalledWith(true);
    v1Case("resource-platform-308caa9fe2ea", () => {
      expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    });

    await harness.manager.hideRuntimeTab(firstTabId);
    expect(harness.views[1].view.setVisible).toHaveBeenLastCalledWith(true);
    expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );

    await harness.manager.moveRuntimeTab(firstTabId, 22);
    expect(harness.manager.listEmbeddedRuntimeState().tabs.find((tab) => tab.id === firstTabId))
      .toMatchObject({ active: true, displayId: 22, hidden: false });
    expect(harness.views[0].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Emulation.setCPUThrottlingRate",
      expect.anything()
    );

    const thirdRole = createRole("role-3", "Third");
    const thirdWorkspace: LaunchWorkspace = {
      ...workspace,
      id: "adaptive-tab-3"
    };
    await harness.manager.launchWorkspace(thirdWorkspace, [
      { role: thirdRole, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);
    const thirdTabId = harness.manager.listEmbeddedRuntimeState().tabs.find(
      (tab) => tab.sourceId === thirdWorkspace.id
    )!.id;
    await harness.manager.stopRuntimeTab(thirdTabId);

    expect(harness.manager.listEmbeddedRuntimeState().tabs.find((tab) => tab.sourceId === secondWorkspace.id))
      .toMatchObject({ active: true, displayId: 11, hidden: false });
    v1Case("resource-platform-378cb6d68a6d", () => {
      expect(harness.views[1].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
      expect(harness.views[2].debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    });
  });

  it("launches every role concurrently", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const loadUrlHandlers = Array.from({ length: 4 }, (_, index) => async () => {
      started.push(index);
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
    });
    const harness = createHarness({ loadUrlHandlers });
    const rects = getDefaultWorkspaceRects("quad");
    const roles = Array.from({ length: 4 }, (_, index) => createRole(`role-${index + 1}`, `Role ${index + 1}`));
    const launch = harness.manager.launchWorkspace(
      workspace,
      roles.map((item, index) => ({ role: item, rect: rects[index] }))
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.forEach((release) => release());

    await expect(launch).resolves.toHaveLength(4);
    v1Case("browser-workspace-af651bceaeb9", () => {
      expect(started).toEqual([0, 1, 2, 3]);
      expect(harness.manager.listStatuses()).toHaveLength(4);
    });
  });

  it("waits for every concurrent embedded load before reporting workspace failure", async () => {
    let releaseFirst!: () => void;
    let secondStarted = false;
    const firstLoad = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const harness = createHarness({
      loadUrlHandlers: [
        () => firstLoad,
        async () => {
          secondStarted = true;
          throw new Error("second role failed");
        }
      ]
    });
    const secondRole = createRole("role-2", "Alt");
    let settled = false;
    const launch = harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(secondStarted).toBe(true));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFirst();
    await expect(launch).rejects.toBeInstanceOf(BrowserGameLoadError);

    v1Case("browser-workspace-89d17e35538d", () => {
      expect(secondStarted).toBe(true);
      expect(settled).toBe(true);
      expect(harness.hosts[0].close).toHaveBeenCalledOnce();
      expect(harness.manager.listStatuses()).toEqual([]);
    });
  });

  it.each(["darwin", "win32"] as const)(
    "hides a %s host closed during a failing workspace launch",
    async (platform) => {
      let rejectLoad!: (error: Error) => void;
      const harness = createHarness({
        loadUrlHandlers: [
          () => new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          })
        ],
        platform
      });
      const launch = harness.manager.launchWorkspace(workspace, [
        { role, rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]);
      await vi.waitFor(() => expect(rejectLoad).toBeTypeOf("function"));
      const closeEvent = { preventDefault: vi.fn() };

      harness.hosts[0].emit("close", closeEvent);
      rejectLoad(new Error("view closed during load"));
      await expect(launch).rejects.toBeInstanceOf(BrowserGameLoadError);

      v1Case(
        platform === "darwin"
          ? "browser-workspace-682b219b6d10"
          : "browser-workspace-42a9d8ab83ad",
        () => {
          expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
          expect(harness.hosts[0].hide).toHaveBeenCalled();
          expect(harness.manager.listStatuses()).toEqual([]);
        }
      );
    }
  );

  it("draws a four-pixel glass divider that is entirely draggable", async () => {
    const harness = createHarness();

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.createView).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          backgroundThrottling: true,
          preload: "/app/out/preload/divider.cjs"
        })
      })
    );
    expect(harness.views[2].setBounds).toHaveBeenCalledWith({ x: 598, y: 0, width: 4, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[2].view.setBackgroundBlur).not.toHaveBeenCalled();
    const dividerUrl = vi.mocked(harness.views[2].webContents.loadURL).mock.calls[0][0];
    const dividerHtml = decodeURIComponent(dividerUrl.split(",", 2)[1]);
    expect(dividerHtml).toContain("html,body");
    expect(dividerHtml).toContain("background:transparent");
    expect(dividerHtml).not.toContain("class=\"line\"");
    expect(dividerHtml).toContain("cursor:col-resize");
    expect(dividerHtml).toContain("touch-action:none");
    expect(dividerHtml).not.toContain("body.dragging");
    expect(dividerHtml).toContain("setDragging(true)");
    expect(dividerHtml).toContain('addEventListener("pointermove"');
    expect(dividerHtml).toContain("{passive:true}");
    expect(dividerHtml).toContain("requestAnimationFrame(flushMove)");
    expect(dividerHtml).toContain("flushMove();setDragging(false);end()");
    expect(dividerHtml).toContain("const reset=()=>{cancelMove()");
    expect(dividerHtml).toContain('addEventListener("dblclick"');
    expect(dividerHtml).toContain('phase:"reset"');
  });

  it("keeps the divider transparent when reduced transparency is preferred", async () => {
    const harness = createHarness({ prefersReducedTransparency: () => true });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.views[2].view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[2].view.setBackgroundBlur).not.toHaveBeenCalled();
  });

  it("coalesces divider moves, flushes pointerup, and cancels reset work", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const dividerUrl = vi.mocked(harness.views[2].webContents.loadURL).mock.calls[0][0];
    const dividerHtml = decodeURIComponent(dividerUrl.split(",", 2)[1]);
    const frames = new Map<number, FrameRequestCallback>();
    const sendPointer = vi.fn();
    const cancelFrame = vi.fn((frameId: number) => frames.delete(frameId));
    const listeners = new Map<string, {
      listener: (event: DividerTestEvent) => void;
      options?: AddEventListenerOptions | boolean;
    }>();
    let nextFrameId = 1;
    const script = dividerHtml.match(/<script>([\s\S]*)<\/script>/)?.[1];
    if (!script) throw new Error("Expected generated divider script.");
    const installDivider = new Function(
      "window",
      "document",
      "addEventListener",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      script
    ) as (
      dividerWindow: { rionStudioDivider: { sendPointer: (payload: unknown) => void } },
      dividerDocument: { body: { setPointerCapture: (pointerId: number) => void } },
      addListener: (
        type: string,
        listener: (event: DividerTestEvent) => void,
        options?: AddEventListenerOptions | boolean
      ) => void,
      requestFrame: (callback: FrameRequestCallback) => number,
      cancelScheduledFrame: (frameId: number) => void
    ) => void;
    installDivider(
      { rionStudioDivider: { sendPointer } },
      { body: { setPointerCapture: vi.fn() } },
      (type, listener, options) => listeners.set(type, { listener, options }),
      (callback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, callback);
        return frameId;
      },
      cancelFrame
    );
    const dispatch = (type: string, screenX: number): boolean => {
      const preventDefault = vi.fn();
      listeners.get(type)?.listener({ preventDefault, screenX, type, pointerId: 1 });
      return !preventDefault.mock.calls.length;
    };

    expect(listeners.get("pointermove")?.options).toEqual({ passive: true });
    expect(dispatch("pointerdown", 100)).toBe(false);
    dispatch("pointermove", 120);
    dispatch("pointermove", 140);
    expect(frames.size).toBe(1);
    expect(sendPointer).toHaveBeenCalledTimes(1);

    runAnimationFrame(frames, 1);
    expect(sendPointer).toHaveBeenLastCalledWith({ phase: "move", screenPosition: 140 });

    dispatch("pointermove", 160);
    dispatch("pointerup", 180);
    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(frames.size).toBe(0);
    expect(sendPointer.mock.calls.slice(-2)).toEqual([
      [{ phase: "move", screenPosition: 180 }],
      [{ phase: "end" }]
    ]);

    dispatch("pointerdown", 200);
    dispatch("pointermove", 230);
    expect(frames.has(3)).toBe(true);
    expect(dispatch("dblclick", 230)).toBe(false);
    expect(cancelFrame).toHaveBeenCalledWith(3);
    expect(frames.size).toBe(0);
    expect(sendPointer).toHaveBeenLastCalledWith({ phase: "reset" });
  });

  it("uses a one-pixel gap with a solid black workspace background", async () => {
    const harness = createHarness({
      getWorkspaceAppearanceSettings: () => ({ background: "black", gap: 1 })
    });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 601, y: 0, width: 599, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 600, y: 0, width: 1, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenLastCalledWith("#FF000000");
  });

  it("immediately updates the gap and background of open workspaces", async () => {
    const harness = createHarness();

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.setWorkspaceAppearanceSettings({ background: "black", gap: 16 });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 592, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 608, y: 0, width: 592, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 592, y: 0, width: 16, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenLastCalledWith("#FF000000");
  });

  it("resizes adjacent roles when the divider is dragged and enforces minimum cell size", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 718, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 722, y: 0, width: 478, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 718, y: 0, width: 4, height: 800 });

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 0
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 142, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 146, y: 0, width: 1054, height: 800 });
  });

  it("shows snapped resize ratios during an active divider drag and hides them on end", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const divider = harness.views[2];

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "start",
      screenPosition: 600
    });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "show", label: "50% × 100%" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "show", label: "50% × 100%" }
    );

    const firstRoleLayoutCalls = harness.views[0].setBounds.mock.calls.length;
    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "move",
      screenPosition: 622
    });
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleLayoutCalls);
    expect(harness.views[0].webContents.send).toHaveBeenCalledTimes(1);

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "move",
      screenPosition: 636
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 658, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 662, y: 0, width: 538, height: 800 });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "update", label: "55% × 100%" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "update", label: "45% × 100%" }
    );

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "end",
      screenPosition: 636
    });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
  });

  it("clears active resize indicators when the workspace closes mid-drag", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "start",
      screenPosition: 600
    });
    await harness.manager.stopWorkspace(workspace.id);

    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
  });

  it("resets a game divider to its launch position when double-clicked", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    harness.manager.handleDividerPointer(harness.views[2].webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 598, y: 0, width: 4, height: 800 });
  });

  it("uses the Rust workspace layout decision as the Electron object adapter boundary", async () => {
    const workspaceLayoutResolver = vi.fn(async () => ({
      dividers: [{ bounds: { x: 490, y: 0, width: 20, height: 800 }, index: 0 }],
      roles: [
        { bounds: { x: 0, y: 0, width: 490, height: 800 }, roleId: role.id },
        { bounds: { x: 510, y: 0, width: 690, height: 800 }, roleId: "role-2" }
      ],
      visible: true
    }));
    const harness = createHarness({ workspaceLayoutResolver });
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(workspaceLayoutResolver).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      contentBounds: { x: 0, y: 0, width: 1200, height: 800 },
      gap: 4,
      hidden: false,
      windowVisible: true
    }));
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 490, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 510, y: 0, width: 690, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 490, y: 0, width: 20, height: 800 });
  });

  it("creates crossing resize dividers for a quad workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("quad");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(6);
    expect(harness.views.slice(4).map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        { x: 598, y: 0, width: 4, height: 800 },
        { x: 0, y: 398, width: 1200, height: 4 }
      ])
    );
  });

  it("creates linked column and row dividers for a six-grid workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("six_grid");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(9);
    expect(harness.views.slice(6).map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        { x: 398, y: 0, width: 4, height: 800 },
        { x: 798, y: 0, width: 4, height: 800 },
        { x: 0, y: 398, width: 1200, height: 4 }
      ])
    );

    harness.manager.handleDividerPointer(harness.views[6].webContents.id, {
      phase: "start",
      screenPosition: 400
    });
    expect(harness.views.slice(0, 6).map((view) => view.webContents.send.mock.calls.length)).toEqual([
      1,
      1,
      0,
      1,
      1,
      0
    ]);
  });

  it.each(persistedLayoutDividerCases)(
    "creates the complete, non-overlapping divider geometry for persisted %s layouts",
    async (template, expectedDividerBounds) => {
      const harness = createHarness();
      const rects = toLegacyStoredRects(template);

      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`persisted-${template}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      const dividerBounds = harness.views
        .slice(rects.length)
        .map((view) => view.view.getBounds());
      expect(dividerBounds).toHaveLength(expectedDividerBounds.length);
      expect(dividerBounds).toEqual(expect.arrayContaining(expectedDividerBounds));
      const caseId = ({
        single: "browser-workspace-930306bbcd8d",
        two_columns: "browser-workspace-2ace2b258565",
        three_columns: "browser-workspace-186a683fc2ba",
        main_left_stack_right: "browser-workspace-356c619b93d1",
        main_right_stack_left: "browser-workspace-c112ef604a75",
        main_center_side_stacks: "browser-workspace-aad1d0b35db3",
        three_top_two_bottom: "browser-workspace-73c9e64971cb",
        two_top_three_bottom: "browser-workspace-6c0e0d9dd9cc",
        quad: "browser-workspace-4dcb867cdda3",
        four_columns: "browser-workspace-465b721df9d6",
        six_grid: "browser-workspace-0f4355309e0a",
        eight_grid: "browser-workspace-0cf07f76f758"
      } as Record<string, string>)[template]!;
      v1Case(caseId, () => {
        expect(dividerBounds).toHaveLength(expectedDividerBounds.length);
        expect(dividerBounds).toEqual(expect.arrayContaining(expectedDividerBounds));
      });
    }
  );

  it.each([
    ["darwin", 1001, 701],
    ["win32", 5121, 1441]
  ] as const)(
    "keeps persisted six-grid gaps pixel-perfect on %s at %sx%s",
    async (platform, width, height) => {
      const harness = createHarness({ platform });
      const rects = toLegacyStoredRects("six_grid");
      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`sized-${platform}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      harness.hosts[0].contentBounds = { x: 0, y: 0, width, height };
      harness.hosts[0].emit("resize");

      const firstColumnEnd = Math.round(0.3333 * width);
      const secondColumnEnd = Math.round(0.6667 * width);
      const firstRowEnd = Math.round(0.5 * height);
      const columnBounds = [
        { x: 0, width: firstColumnEnd - 2 },
        { x: firstColumnEnd + 2, width: secondColumnEnd - firstColumnEnd - 4 },
        { x: secondColumnEnd + 2, width: width - secondColumnEnd - 2 }
      ];
      const expectedSessionBounds = [0, 1].flatMap((rowIndex) =>
        columnBounds.map((column) => ({
          ...column,
          y: rowIndex === 0 ? 0 : firstRowEnd + 2,
          height: rowIndex === 0 ? firstRowEnd - 2 : height - firstRowEnd - 2
        }))
      );
      expect(harness.views.slice(0, 6).map((view) => view.view.getBounds())).toEqual(expectedSessionBounds);
      expect(harness.views.slice(6).map((view) => view.view.getBounds())).toEqual(expect.arrayContaining([
        { x: firstColumnEnd - 2, y: 0, width: 4, height },
        { x: secondColumnEnd - 2, y: 0, width: 4, height },
        { x: 0, y: firstRowEnd - 2, width, height: 4 }
      ]));
      v1Case(
        platform === "darwin"
          ? "browser-workspace-d8f506fd5278"
          : "browser-workspace-0b240ba8ff6f",
        () => {
          expect(harness.views.slice(0, 6).map((view) => view.view.getBounds()))
            .toEqual(expectedSessionBounds);
          expect(harness.views.slice(6).map((view) => view.view.getBounds()))
            .toEqual(expect.arrayContaining([
              { x: firstColumnEnd - 2, y: 0, width: 4, height },
              { x: secondColumnEnd - 2, y: 0, width: 4, height },
              { x: 0, y: firstRowEnd - 2, width, height: 4 }
            ]));
        }
      );
    }
  );

  it.each(["three_top_two_bottom", "two_top_three_bottom"] as const)(
    "keeps every persisted %s divider draggable and scoped to its row",
    async (template) => {
      const harness = createHarness();
      const rects = toLegacyStoredRects(template);
      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`mixed-${template}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      const dividers = harness.views.slice(rects.length);
      const targetVerticalBounds = template === "three_top_two_bottom"
        ? { x: 798, y: 0, width: 4, height: 400 }
        : { x: 798, y: 400, width: 4, height: 400 };
      const verticalDivider = dividers.find((view) =>
        equalPixelBounds(view.view.getBounds(), targetVerticalBounds)
      );
      const horizontalDivider = dividers.find((view) =>
        equalPixelBounds(view.view.getBounds(), { x: 0, y: 398, width: 1200, height: 4 })
      );
      expect(verticalDivider).toBeDefined();
      expect(horizontalDivider).toBeDefined();
      if (!verticalDivider || !horizontalDivider) {
        throw new Error("Expected mixed-layout dividers to exist.");
      }

      harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
        phase: "start",
        screenPosition: 800
      });
      const verticalRoleIndexes = template === "three_top_two_bottom" ? [1, 2] : [3, 4];
      expect(harness.views.slice(0, 5).map((view) => view.webContents.send.mock.calls.length)).toEqual(
        [0, 1, 2, 3, 4].map((index) => verticalRoleIndexes.includes(index) ? 1 : 0)
      );
      harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
        phase: "move",
        screenPosition: 900
      });
      harness.manager.handleDividerPointer(verticalDivider.webContents.id, { phase: "end" });

      const afterVerticalBounds = template === "three_top_two_bottom"
        ? [
            { x: 0, y: 0, width: 398, height: 398 },
            { x: 402, y: 0, width: 496, height: 398 },
            { x: 902, y: 0, width: 298, height: 398 },
            { x: 0, y: 402, width: 598, height: 398 },
            { x: 602, y: 402, width: 598, height: 398 }
          ]
        : [
            { x: 0, y: 0, width: 598, height: 398 },
            { x: 602, y: 0, width: 598, height: 398 },
            { x: 0, y: 402, width: 398, height: 398 },
            { x: 402, y: 402, width: 496, height: 398 },
            { x: 902, y: 402, width: 298, height: 398 }
          ];
      expect(harness.views.slice(0, 5).map((view) => view.view.getBounds())).toEqual(afterVerticalBounds);

      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
        phase: "start",
        screenPosition: 400
      });
      harness.views.slice(0, 5).forEach((view) => {
        expect(view.webContents.send).toHaveBeenLastCalledWith(
          WORKSPACE_RESIZE_INDICATOR_CHANNEL,
          expect.objectContaining({ type: "show" })
        );
      });
      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
        phase: "move",
        screenPosition: 480
      });
      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, { phase: "end" });

      const topRoleCount = template === "three_top_two_bottom" ? 3 : 2;
      expect(harness.views.slice(0, 5).map((view) => view.view.getBounds())).toEqual(
        afterVerticalBounds.map((bounds, index) => ({
          ...bounds,
          y: index < topRoleCount ? 0 : 482,
          height: index < topRoleCount ? 478 : 318
        }))
      );
      expect(horizontalDivider.view.getBounds()).toEqual({ x: 0, y: 478, width: 1200, height: 4 });
      expect(verticalDivider.view.getBounds()).toEqual(
        template === "three_top_two_bottom"
          ? { x: 898, y: 0, width: 4, height: 480 }
          : { x: 898, y: 480, width: 4, height: 320 }
      );
      v1Case(
        template === "three_top_two_bottom"
          ? "browser-workspace-dc742dfec033"
          : "browser-workspace-62d4bfbdd2db",
        () => {
          expect(horizontalDivider.view.getBounds()).toEqual({
            x: 0,
            y: 478,
            width: 1200,
            height: 4
          });
          expect(verticalDivider.view.getBounds()).toEqual(
            template === "three_top_two_bottom"
              ? { x: 898, y: 0, width: 4, height: 480 }
              : { x: 898, y: 480, width: 4, height: 320 }
          );
        }
      );
    }
  );

  it("resets a snapped three-column divider to its exact one-third launch position", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("three_columns");
    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    harness.manager.handleDividerPointer(harness.views[3].webContents.id, {
      phase: "move",
      screenPosition: 540
    });
    harness.manager.handleDividerPointer(harness.views[3].webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 398, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 402, y: 0, width: 396, height: 800 });
  });

  it("keeps centered-main row dividers out of the main pane while resizing both side stacks", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("main_center_side_stacks");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(9);
    const dividerViews = harness.views.slice(5);
    const horizontalDividers = dividerViews.filter((view) => {
      const bounds = vi.mocked(view.setBounds).mock.calls[0][0];
      return bounds.height === 4;
    });
    expect(horizontalDividers.map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual([
      { x: 0, y: 398, width: 360, height: 4 },
      { x: 840, y: 398, width: 360, height: 4 }
    ]);

    harness.manager.handleDividerPointer(horizontalDividers[0].webContents.id, {
      phase: "move",
      screenPosition: 480
    });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 362, y: 0, width: 476, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 358, height: 478 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 482, width: 358, height: 318 });
    expect(harness.views[3].setBounds).toHaveBeenLastCalledWith({ x: 842, y: 0, width: 358, height: 478 });
    expect(harness.views[4].setBounds).toHaveBeenLastCalledWith({ x: 842, y: 482, width: 358, height: 318 });
    expect(horizontalDividers[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 478, width: 360, height: 4 });
    expect(horizontalDividers[1].setBounds).toHaveBeenLastCalledWith({ x: 840, y: 478, width: 360, height: 4 });
  });

  it("resets only the double-clicked divider in a multi-divider game workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("quad");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    const verticalDivider = harness.views[4];
    const horizontalDivider = harness.views[5];
    harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
      phase: "move",
      screenPosition: 480
    });
    harness.manager.handleDividerPointer(verticalDivider.webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 478 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 478 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 482, width: 598, height: 318 });
    expect(harness.views[3].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 482, width: 598, height: 318 });
    expect(verticalDivider.setBounds).toHaveBeenLastCalledWith({ x: 598, y: 0, width: 4, height: 800 });
    expect(horizontalDivider.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 478, width: 1200, height: 4 });
  });

  it("recalculates every role and popup when the host content size changes", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1000, height: 700 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 498, height: 700 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 502, y: 0, width: 498, height: 700 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 498, height: 700 });
  });

  it("does not resize game views while the host window is minimized", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    const firstRoleCalls = harness.views[0].setBounds.mock.calls.length;
    const secondRoleCalls = harness.views[1].setBounds.mock.calls.length;
    const dividerCalls = harness.views[2].setBounds.mock.calls.length;
    const popupCalls = popup.setBounds.mock.calls.length;

    harness.hosts[0].minimized = true;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 1 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleCalls);
    expect(harness.views[1].setBounds).toHaveBeenCalledTimes(secondRoleCalls);
    expect(harness.views[2].setBounds).toHaveBeenCalledTimes(dividerCalls);
    expect(popup.setBounds).toHaveBeenCalledTimes(popupCalls);
  });

  it("recalculates game views after a minimized host is restored", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    harness.hosts[0].minimized = true;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 1 };
    harness.hosts[0].emit("resize");

    harness.hosts[0].minimized = false;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 900, height: 600 };
    harness.hosts[0].emit("restore");

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 448, height: 600 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 452, y: 0, width: 448, height: 600 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 448, y: 0, width: 4, height: 600 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 448, height: 600 });
  });

  it("does not resize game views when host content bounds collapse", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const firstRoleCalls = harness.views[0].setBounds.mock.calls.length;
    const secondRoleCalls = harness.views[1].setBounds.mock.calls.length;
    const dividerCalls = harness.views[2].setBounds.mock.calls.length;

    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 0, height: 0 };
    harness.hosts[0].emit("resize");
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 800 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleCalls);
    expect(harness.views[1].setBounds).toHaveBeenCalledTimes(secondRoleCalls);
    expect(harness.views[2].setBounds).toHaveBeenCalledTimes(dividerCalls);
  });

  it("places non-overlapping workspaces on the same display into one tabbed host", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [{ role, rect: workspace.slots[0].rect }]);
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Second" };
    const secondRole = createRole("role-3", "Third");

    await harness.manager.launchWorkspace(secondWorkspace, [
      { role: secondRole, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toHaveLength(2);
    expect(harness.manager.listEmbeddedRuntimeState()).toMatchObject({
      windows: [{ displayId: 0, tabCount: 2 }],
      tabs: [
        { sourceId: workspace.id, type: "workspace" },
        { sourceId: secondWorkspace.id, type: "workspace" }
      ]
    });
  });

  it("releases a target display when workspace navigation fails", async () => {
    const harness = createHarness({
      loadUrlHandlers: [vi.fn().mockRejectedValue(new Error("navigation failed"))]
    });

    await expect(
      harness.manager.launchWorkspace(
        workspace,
        [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }],
        { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } }
      )
    ).rejects.toBeInstanceOf(BrowserGameLoadError);
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([]);
  });

  it("blocks an entire workspace before creating a window when a role is already running", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    await expect(
      harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
      ])
    ).rejects.toMatchObject({
      code: "ROLE_ALREADY_RUNNING",
      roleNames: ["Main"]
    });
    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
  });

  it("does not inspect or reject workspace roles based on login-page snapshots", async () => {
    const harness = createHarness();

    await expect(harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
      ])).resolves.toEqual([
        expect.objectContaining({ roleId: "role-1", state: "running" }),
        expect.objectContaining({ roleId: "role-2", state: "running" })
      ]);

    expect(harness.views[0].webContents.session.cookies.get).not.toHaveBeenCalled();
    expect(harness.views[1].webContents.session.cookies.get).not.toHaveBeenCalled();
  });

  it("stops the actual launched host by workspace id", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    await harness.manager.stopWorkspace(workspace.id);

    expect(harness.beforeRolesStop).not.toHaveBeenCalled();
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it.each([
    ["macOS native chrome", { platform: "darwin", useMacNativeChrome: true }],
    ["macOS HTML fallback", { platform: "darwin", useTabbedHostWindow: true }],
    ["Windows HTML chrome", { platform: "win32", useTabbedHostWindow: true }]
  ] as const)("hides a display host on system close without stopping its roles on %s", async (name, options) => {
    const harness = createHarness(options);
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.hosts[0].emit("close", event);

    expect(harness.manager.listStatuses()).toEqual([
      expect.objectContaining({ roleId: role.id, state: "running" })
    ]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].hide).toHaveBeenCalledTimes(1);
    expect(harness.beforeRolesStop).not.toHaveBeenCalled();
    const caseId = {
      "macOS native chrome": "browser-workspace-fa75912a292c",
      "macOS HTML fallback": "browser-workspace-8dcdbe109c2f",
      "Windows HTML chrome": "browser-workspace-f0a8dbde711c"
    }[name];
    v1Case(caseId, () => {
      expect(harness.manager.listStatuses()).toEqual([
        expect.objectContaining({ roleId: role.id, state: "running" })
      ]);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(harness.hosts[0].hide).toHaveBeenCalledOnce();
      expect(harness.beforeRolesStop).not.toHaveBeenCalled();
    });
  });

  it.each(["darwin", "win32"] as const)(
    "stops and destroys the active runtime tab on %s",
    async (platform) => {
      const harness = createHarness(
        platform === "darwin"
          ? { platform, useMacNativeChrome: true }
          : { platform, useTabbedHostWindow: true }
      );
      await harness.manager.launch(role);
      const [tab] = harness.manager.listEmbeddedRuntimeState().tabs;

      await harness.manager.stopRuntimeTab(tab.id);

      expect(harness.beforeRolesStop).not.toHaveBeenCalled();
      expect(harness.views[0].webContents.close).toHaveBeenCalledOnce();
      expect(harness.hosts[0].close).toHaveBeenCalledOnce();
      expect(harness.manager.listStatuses()).toEqual([]);
      expect(harness.manager.listEmbeddedRuntimeState()).toMatchObject({
        tabs: [],
        windows: []
      });
      v1Case(
        platform === "darwin"
          ? "browser-workspace-b4596ee467b5"
          : "browser-workspace-5e94d5625e01",
        () => {
          expect(harness.views[0].webContents.close).toHaveBeenCalledOnce();
          expect(harness.hosts[0].close).toHaveBeenCalledOnce();
          expect(harness.manager.listStatuses()).toEqual([]);
          expect(harness.manager.listEmbeddedRuntimeState()).toMatchObject({
            tabs: [],
            windows: []
          });
        }
      );
    }
  );

  it("hides the current runtime tab for Cmd/Ctrl+W from a game view", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.views[0].webContents.emit("before-input-event", event, {
      control: true,
      key: "w",
      meta: false,
      type: "keyDown"
    });

    await vi.waitFor(() => expect(harness.hosts[0].hide).toHaveBeenCalledTimes(1));
    expect(harness.hosts[0].hide).toHaveBeenCalledTimes(1);
    expect(harness.manager.listEmbeddedRuntimeState().tabs[0]).toMatchObject({ hidden: true });
    expect(harness.manager.listStatuses()).toEqual([
      expect.objectContaining({ roleId: role.id, state: "running" })
    ]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each(["darwin", "win32"] as const)(
    "suspends native menu and close shortcuts while game input is active on %s",
    async (platform) => {
      const harness = createHarness({ platform, useTabbedHostWindow: true });
      await harness.manager.launch(role);
      const webContents = harness.views[0].webContents;
      const closeEvent = { preventDefault: vi.fn() };

      harness.manager.setGameInputContext(webContents.id, true);

      expect(webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
      webContents.emit("before-input-event", closeEvent, {
        control: platform === "win32",
        key: "w",
        meta: platform === "darwin",
        type: "keyDown"
      });
      expect(closeEvent.preventDefault).not.toHaveBeenCalled();
      expect(harness.hosts[0].hide).not.toHaveBeenCalled();

      if (platform === "darwin") {
        const fullscreenEvent = { preventDefault: vi.fn() };
        webContents.emit("before-input-event", fullscreenEvent, {
          control: true,
          isAutoRepeat: false,
          key: "f",
          meta: true,
          type: "keyDown"
        });
        expect(fullscreenEvent.preventDefault).not.toHaveBeenCalled();
        expect(harness.hosts[0].setFullScreen).not.toHaveBeenCalled();
      }

      webContents.emit("blur");
      expect(webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      harness.manager.setGameInputContext(webContents.id, true);
      webContents.emit("did-start-navigation", {}, "https://example.com/play", false, true);
      expect(webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      webContents.emit("before-input-event", closeEvent, {
        control: platform === "win32",
        key: "w",
        meta: platform === "darwin",
        type: "keyDown"
      });
      await vi.waitFor(() => expect(harness.hosts[0].hide).toHaveBeenCalledOnce());
      expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
      expect(harness.hosts[0].hide).toHaveBeenCalledOnce();
      v1Case(
        platform === "darwin"
          ? "browser-workspace-310227ef70a3"
          : "browser-workspace-77373ff70243",
        () => {
          expect(webContents.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
          expect(webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
          expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
          expect(harness.hosts[0].hide).toHaveBeenCalledOnce();
        }
      );
    }
  );

  it("keeps popup shortcuts active while the parent game canvas is protected", async () => {
    const harness = createHarness({ platform: "darwin", useTabbedHostWindow: true });
    await harness.manager.launch(role);
    const gameWebContents = harness.views[0].webContents;
    harness.manager.setGameInputContext(gameWebContents.id, true);
    const popup = createOAuthPopup(harness.views[0], harness.views);
    const event = { preventDefault: vi.fn() };

    popup.webContents.emit("before-input-event", event, {
      key: "w",
      meta: true,
      type: "keyDown"
    });

    await vi.waitFor(() => expect(harness.hosts[0].hide).toHaveBeenCalledOnce());
    expect(gameWebContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.hosts[0].hide).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"] as const)(
    "hosts OAuth popups over the matching role cell with native background throttling on %s",
    async (platform) => {
      const onEmbeddedWebContentsCreated = vi.fn();
      const harness = createHarness({ onEmbeddedWebContentsCreated, platform });
      await harness.manager.launch(role);

      const popup = createOAuthPopup(harness.views[0], harness.views);

      expect(popup.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
      expect(harness.createView).toHaveBeenLastCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            backgroundThrottling: true,
            spellcheck: false,
            webgl: true
          })
        })
      );
      expect(harness.hosts[0].contentView.addChildView).toHaveBeenLastCalledWith(popup.view);
      expect(onEmbeddedWebContentsCreated).toHaveBeenLastCalledWith({
        hostId: expect.any(String),
        kind: "popup",
        roleId: role.id
      }, popup.webContents);
      expect(popup.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
        "Emulation.setCPUThrottlingRate",
        expect.anything()
      );
    }
  );

});

describe("normalizedRectToPixelBounds", () => {
  it("uses shared rounded edges so adjacent views have no gap", () => {
    expect(normalizedRectToPixelBounds({ x: 0, y: 0, width: 1 / 3, height: 1 }, { x: 0, y: 0, width: 1000, height: 700 }))
      .toEqual({ x: 0, y: 0, width: 333, height: 700 });
    expect(normalizedRectToPixelBounds({ x: 1 / 3, y: 0, width: 2 / 3, height: 1 }, { x: 0, y: 0, width: 1000, height: 700 }))
      .toEqual({ x: 333, y: 0, width: 667, height: 700 });
  });

  it.each([
    ["three_columns", [
      { x: 0, y: 0, width: 400, height: 800 },
      { x: 400, y: 0, width: 400, height: 800 },
      { x: 800, y: 0, width: 400, height: 800 }
    ]],
    ["main_left_stack_right", [
      { x: 0, y: 0, width: 600, height: 800 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["main_right_stack_left", [
      { x: 600, y: 0, width: 600, height: 800 },
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 }
    ]],
    ["quad", [
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["four_columns", [
      { x: 0, y: 0, width: 300, height: 800 },
      { x: 300, y: 0, width: 300, height: 800 },
      { x: 600, y: 0, width: 300, height: 800 },
      { x: 900, y: 0, width: 300, height: 800 }
    ]],
    ["three_top_two_bottom", [
      { x: 0, y: 0, width: 400, height: 400 },
      { x: 400, y: 0, width: 400, height: 400 },
      { x: 800, y: 0, width: 400, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["two_top_three_bottom", [
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 400, height: 400 },
      { x: 400, y: 400, width: 400, height: 400 },
      { x: 800, y: 400, width: 400, height: 400 }
    ]],
    ["six_grid", [
      { x: 0, y: 0, width: 400, height: 400 },
      { x: 400, y: 0, width: 400, height: 400 },
      { x: 800, y: 0, width: 400, height: 400 },
      { x: 0, y: 400, width: 400, height: 400 },
      { x: 400, y: 400, width: 400, height: 400 },
      { x: 800, y: 400, width: 400, height: 400 }
    ]],
    ["eight_grid", [
      { x: 0, y: 0, width: 300, height: 400 },
      { x: 300, y: 0, width: 300, height: 400 },
      { x: 600, y: 0, width: 300, height: 400 },
      { x: 900, y: 0, width: 300, height: 400 },
      { x: 0, y: 400, width: 300, height: 400 },
      { x: 300, y: 400, width: 300, height: 400 },
      { x: 600, y: 400, width: 300, height: 400 },
      { x: 900, y: 400, width: 300, height: 400 }
    ]]
  ] as const)("maps %s without title or control-bar offsets", (template, expected) => {
    const actual = getDefaultWorkspaceRects(template).map((rect) =>
      normalizedRectToPixelBounds(rect, { x: 0, y: 0, width: 1200, height: 800 })
    );
    expect(actual).toEqual(expected);
    const caseId = {
      three_columns: "browser-workspace-2cc368780200",
      main_left_stack_right: "browser-workspace-f500fa56e6a2",
      main_right_stack_left: "browser-workspace-e303c7cf7ff7",
      quad: "browser-workspace-e726b29ab04b",
      four_columns: "browser-workspace-cfa845f242c2",
      three_top_two_bottom: "browser-workspace-3998a3495cb6",
      two_top_three_bottom: "browser-workspace-b75a0c498770",
      six_grid: "browser-workspace-e4d2ccbeb3ce",
      eight_grid: "browser-workspace-dda21739e52f"
    }[template];
    v1Case(caseId, () => {
      expect(actual).toEqual(expected);
    });
  });
});

function createRole(id: string, name: string): Role {
  return { ...role, id, name };
}

function toLegacyStoredRects(template: WorkspaceLayoutTemplate) {
  return getDefaultWorkspaceRects(template).map((rect) => ({
    x: roundLegacyRectValue(rect.x),
    y: roundLegacyRectValue(rect.y),
    width: roundLegacyRectValue(rect.width),
    height: roundLegacyRectValue(rect.height)
  }));
}

function roundLegacyRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function equalPixelBounds(left: PixelBounds, right: PixelBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function resolveTestWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayoutOutput {
  const roleRects = new Map(input.roles.map(({ rect, roleId }) => [roleId, rect]));
  const beforeInset = Math.floor(input.gap / 2);
  const afterInset = input.gap - beforeInset;
  return {
    visible: input.active && !input.hidden && input.windowVisible,
    roles: input.roles.map(({ rect, roleId }) => {
      const bounds = normalizedRectToPixelBounds(rect, input.contentBounds);
      input.dividers.forEach((divider) => {
        if (divider.axis === "vertical") {
          if (divider.beforeRoleIds.includes(roleId)) bounds.width -= beforeInset;
          if (divider.afterRoleIds.includes(roleId)) {
            bounds.x += afterInset;
            bounds.width -= afterInset;
          }
        } else {
          if (divider.beforeRoleIds.includes(roleId)) bounds.height -= beforeInset;
          if (divider.afterRoleIds.includes(roleId)) {
            bounds.y += afterInset;
            bounds.height -= afterInset;
          }
        }
      });
      return {
        bounds: { ...bounds, height: Math.max(1, bounds.height), width: Math.max(1, bounds.width) },
        roleId
      };
    }),
    dividers: input.dividers.flatMap((divider, index) => {
      const before = divider.beforeRoleIds.flatMap((roleId) => {
        const rect = roleRects.get(roleId);
        return rect ? [rect] : [];
      });
      const after = divider.afterRoleIds.flatMap((roleId) => {
        const rect = roleRects.get(roleId);
        return rect ? [rect] : [];
      });
      if (before.length === 0 || after.length === 0) return [];
      const vertical = divider.axis === "vertical";
      const all = [...before, ...after];
      const position = vertical ? after[0].x : after[0].y;
      const start = Math.min(...all.map((rect) => vertical ? rect.y : rect.x));
      const end = Math.max(
        ...all.map((rect) => vertical ? rect.y + rect.height : rect.x + rect.width)
      );
      const bounds = vertical
        ? {
            x: input.contentBounds.x + Math.round(position * input.contentBounds.width) - beforeInset,
            y: input.contentBounds.y + Math.round(start * input.contentBounds.height),
            width: input.gap,
            height: Math.max(1, Math.round(end * input.contentBounds.height) - Math.round(start * input.contentBounds.height))
          }
        : {
            x: input.contentBounds.x + Math.round(start * input.contentBounds.width),
            y: input.contentBounds.y + Math.round(position * input.contentBounds.height) - beforeInset,
            width: Math.max(1, Math.round(end * input.contentBounds.width) - Math.round(start * input.contentBounds.width)),
            height: input.gap
          };
      return [{ bounds, index }];
    })
  };
}

function resolveTestWorkspaceDividers(roles: LayoutRoleInput[]): WorkspaceDividerDescriptor[] {
  const epsilon = 0.000_001;
  const segments: Array<WorkspaceDividerDescriptor & { end: number; start: number }> = [];
  const add = (before: LayoutRoleInput, after: LayoutRoleInput, axis: "horizontal" | "vertical") => {
    const vertical = axis === "vertical";
    const position = vertical
      ? before.rect.x + before.rect.width
      : before.rect.y + before.rect.height;
    const afterPosition = vertical ? after.rect.x : after.rect.y;
    if (Math.abs(position - afterPosition) >= epsilon) return;
    const start = Math.max(
      vertical ? before.rect.y : before.rect.x,
      vertical ? after.rect.y : after.rect.x
    );
    const end = Math.min(
      vertical ? before.rect.y + before.rect.height : before.rect.x + before.rect.width,
      vertical ? after.rect.y + after.rect.height : after.rect.x + after.rect.width
    );
    if (end - start <= epsilon) return;
    segments.push({
      afterRoleIds: [after.roleId],
      axis,
      beforeRoleIds: [before.roleId],
      defaultPosition: position,
      end,
      start
    });
  };
  roles.forEach((left, leftIndex) => {
    roles.slice(leftIndex + 1).forEach((right) => {
      add(left, right, "vertical");
      add(right, left, "vertical");
      add(left, right, "horizontal");
      add(right, left, "horizontal");
    });
  });
  segments.sort((left, right) =>
    (left.axis === right.axis ? 0 : left.axis === "vertical" ? -1 : 1) ||
    left.defaultPosition - right.defaultPosition || left.start - right.start
  );
  const groups: typeof segments = [];
  segments.forEach((segment) => {
    const group = groups.find((candidate) =>
      candidate.axis === segment.axis &&
      Math.abs(candidate.defaultPosition - segment.defaultPosition) < epsilon &&
      segment.start <= candidate.end + epsilon && candidate.start <= segment.end + epsilon
    );
    if (!group) {
      groups.push({ ...segment });
      return;
    }
    group.start = Math.min(group.start, segment.start);
    group.end = Math.max(group.end, segment.end);
    group.beforeRoleIds = [...new Set([...group.beforeRoleIds, ...segment.beforeRoleIds])];
    group.afterRoleIds = [...new Set([...group.afterRoleIds, ...segment.afterRoleIds])];
  });
  return groups.map(({ afterRoleIds, axis, beforeRoleIds, defaultPosition }) => ({
    afterRoleIds,
    axis,
    beforeRoleIds,
    defaultPosition
  }));
}

function resizeTestWorkspaceDivider(
  input: WorkspaceDividerResizeInput
): WorkspaceDividerResizeOutput {
  const divider = input.dividers[input.dividerIndex];
  const linked = input.dividers.filter((candidate) =>
    candidate.axis === divider.axis &&
    Math.abs(candidate.defaultPosition - divider.defaultPosition) < 0.000_001
  );
  const beforeRoleIds = [...new Set(linked.flatMap(({ beforeRoleIds }) => beforeRoleIds))];
  const afterRoleIds = [...new Set(linked.flatMap(({ afterRoleIds }) => afterRoleIds))];
  const before = input.roles.filter(({ roleId }) => beforeRoleIds.includes(roleId));
  const after = input.roles.filter(({ roleId }) => afterRoleIds.includes(roleId));
  const vertical = divider.axis === "vertical";
  const start = (role: LayoutRoleInput) => vertical ? role.rect.x : role.rect.y;
  const size = (role: LayoutRoleInput) => vertical ? role.rect.width : role.rect.height;
  const position = snapWorkspaceResizePosition(input.requestedPosition, {
    initialPosition: divider.defaultPosition,
    min: Math.max(...before.map((role) => start(role) + MIN_WORKSPACE_SLOT_SIZE)),
    max: Math.min(...after.map((role) => start(role) + size(role) - MIN_WORKSPACE_SLOT_SIZE)),
    ...(input.previousPosition === undefined ? {} : { previousPosition: input.previousPosition })
  });
  const changed = Math.abs(position - start(after[0])) >= 0.000_001;
  const roles = input.roles.map((role) => {
    if (!changed) return role;
    if (beforeRoleIds.includes(role.roleId)) {
      return {
        ...role,
        rect: vertical
          ? { ...role.rect, width: position - role.rect.x }
          : { ...role.rect, height: position - role.rect.y }
      };
    }
    if (afterRoleIds.includes(role.roleId)) {
      return {
        ...role,
        rect: vertical
          ? { ...role.rect, x: position, width: role.rect.x + role.rect.width - position }
          : { ...role.rect, y: position, height: role.rect.y + role.rect.height - position }
      };
    }
    return role;
  });
  return { changed, position, roleIds: [...beforeRoleIds, ...afterRoleIds], roles };
}

function createRolePaths(roleId: string): RolePathsRecord {
  return {
    browserUserDataDir: `/roles/${roleId}/browser`,
    electronBrowserUserDataDir: `/roles/${roleId}/browser/electron`,
    systemBrowserDataDir: `/roles/${roleId}/browser/system`,
    webkitDataStoreIdentifier: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    webkitDataStoreKey: `rion.role.${roleId}`,
    webview2UserDataDir: `C:\\roles\\${roleId}\\browser\\webview2`
  };
}

function createMockSystemSurface() {
  const listeners = new Set<(event: WebSurfaceLifecycleEvent) => void>();
  const callDevToolsProtocolMethod = vi.fn(async () => undefined);
  const evaluate = vi.fn(async () => true);
  const value: WebSurfacePort & {
    callDevToolsProtocolMethod: <T = unknown>(
      method: string,
      parameters?: Record<string, unknown>
    ) => Promise<T>;
  } = {
    addDocumentStartScript: vi.fn(async () => undefined),
    callDevToolsProtocolMethod: callDevToolsProtocolMethod as never,
    clearStorage: vi.fn(async () => undefined),
    configureRequestRewrites: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    evaluate: evaluate as never,
    focus: vi.fn(async () => undefined),
    getCookies: vi.fn(async () => []),
    loadUrl: vi.fn(async () => undefined),
    onLifecycleEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    setAudioMuted: vi.fn(async () => undefined),
    setBounds: vi.fn(async () => undefined),
    setCookies: vi.fn(async (cookies) => cookies.length),
    setVisible: vi.fn(async () => undefined),
    setZoomFactor: vi.fn(async () => undefined)
  };
  return {
    emit: (event: WebSurfaceLifecycleEvent) => {
      listeners.forEach((listener) => listener(event));
    },
    value
  };
}

function createHarness(options: {
  applyCdnCompatibility?: AnyMock;
  applyBrowserFonts?: AnyMock;
  applyBrowserProxy?: AnyMock;
  deferFullscreenTransitions?: boolean;
  getCursorScreenPoint?: () => { x: number; y: number };
  getRuntimeTabGameIcon?: (role: Role) => string | undefined | Promise<string | undefined>;
  getWorkspaceAppearanceSettings?: () =>
    | WorkspaceAppearanceSettings
    | Promise<WorkspaceAppearanceSettings>;
  loadUrlHandlers?: Array<(url: string) => Promise<void>>;
  macNativeChromeError?: Error;
  handleRuntimeTabAction?: ElectronBrowserRuntimeOptions["handleRuntimeTabAction"];
  onEmbeddedWebContentsCreated?: ElectronBrowserRuntimeOptions["onEmbeddedWebContentsCreated"];
  performNativeZoom?: ElectronBrowserRuntimeOptions["performNativeZoom"];
  persistWorkspaceRoleZoom?: ElectronBrowserRuntimeOptions["persistWorkspaceRoleZoom"];
  platform?: NodeJS.Platform;
  prefersReducedTransparency?: () => boolean;
  resolvedEngine?:
    | Extract<ResolvedBrowserEngine, "electron" | "webview2" | "wkwebview">
    | ((role: Role) => Extract<ResolvedBrowserEngine, "electron" | "webview2" | "wkwebview">);
  systemRuntimePool?: SystemWebViewRuntimePool;
  getRolePaths?: (roleId: string) => Promise<RolePathsRecord>;
  getNativeSessionConfiguration?: ElectronBrowserRuntimeOptions["getNativeSessionConfiguration"];
  defaultLaunchTarget?: { displayId: number; workArea: PixelBounds };
  workspaceDisplays?: WorkspaceDisplayInfo[];
  workspaceLayoutResolver?: ElectronBrowserRuntimeOptions["workspaceLayoutResolver"];
  useTabbedHostWindow?: boolean;
  useMacNativeChrome?: boolean;
} = {}) {
  const hosts: ReturnType<typeof createMockHost>[] = [];
  const chromeViews: ReturnType<typeof createMockView>[] = [];
  const nativeChromeControllers: Array<{
    destroy: ReturnType<typeof vi.fn>;
    emitAction: (action: Parameters<NonNullable<ElectronBrowserRuntimeOptions["handleRuntimeTabAction"]>>[2]) => void;
    emitContentLayout: (layout: { heightInset: number; valid: boolean; yOffset: number }) => void;
    getContentLayout: ReturnType<typeof vi.fn>;
    prepareFullscreenTransition: ReturnType<typeof vi.fn>;
    setFullscreenPolicy: ReturnType<typeof vi.fn>;
    setRevealLocked: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  }> = [];
  const views: ReturnType<typeof createMockView>[] = [];
  const createHostWindow = vi.fn((windowOptions: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }) => {
    const host = createMockHost(options.deferFullscreenTransitions);
    host.contentBounds = {
      x: options.platform === "darwin" && options.useTabbedHostWindow ? windowOptions.x ?? 0 : 0,
      y: options.platform === "darwin" && options.useTabbedHostWindow ? windowOptions.y ?? 0 : 0,
      width: windowOptions.width ?? 1200,
      height: windowOptions.height ?? 800
    };
    hosts.push(host);
    return host as never;
  });
  const createTabbedHostWindow = vi.fn((windowOptions: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }) => {
    const host = createMockBrowserHost(options.deferFullscreenTransitions);
    host.contentBounds = {
      x: windowOptions.x ?? 0,
      y: windowOptions.y ?? 0,
      width: windowOptions.width ?? 1200,
      height: windowOptions.height ?? 800
    };
    hosts.push(host);
    return host as never;
  });
  const createView = vi.fn((viewOptions: { webPreferences?: { zoomFactor?: number } }) => {
    const loadUrlHandler = options.loadUrlHandlers?.[views.length];
    const view = createMockView(
      loadUrlHandler,
      viewOptions.webPreferences?.zoomFactor ?? 1
    );
    views.push(view);
    return view.view as never;
  });
  const createRuntimeChromeView = vi.fn(() => {
    const view = createMockView();
    chromeViews.push(view);
    return view.view as never;
  });
  const createMacRuntimeTabsController = vi.fn((
    _window,
    onAction,
    onContentLayoutChange
  ) => {
    if (options.macNativeChromeError) throw options.macNativeChromeError;
    const controller = {
      destroy: vi.fn(),
      emitAction: onAction,
      emitContentLayout: onContentLayoutChange,
      getContentLayout: vi.fn(() => ({
        heightInset: 8,
        valid: true,
        yOffset: 8
      })),
      prepareFullscreenTransition: vi.fn(),
      setFullscreenPolicy: vi.fn(),
      setRevealLocked: vi.fn(),
      update: vi.fn()
    };
    nativeChromeControllers.push(controller);
    return controller;
  });
  const beforeRolesStop = vi.fn().mockResolvedValue(undefined);
  const browserRuntimeState = createBrowserRuntimeState();
  const manager = new ElectronBrowserRuntime({
    browserRuntimeState,
    adaptiveZoomResolver: resolveTestAdaptiveZoom,
    ...(options.applyCdnCompatibility ? { applyCdnCompatibility: options.applyCdnCompatibility } : {}),
    ...(options.applyBrowserFonts ? { applyBrowserFonts: options.applyBrowserFonts } : {}),
    ...(options.applyBrowserProxy ? { applyBrowserProxy: options.applyBrowserProxy } : {}),
    createHostWindow,
    ...(options.useMacNativeChrome ? { createMacRuntimeTabsController } : {}),
    ...(options.useTabbedHostWindow ? { createRuntimeChromeView } : {}),
    ...(options.useTabbedHostWindow ? { createTabbedHostWindow } : {}),
    createView,
    dividerPreloadPath: "/app/out/preload/divider.cjs",
    embeddedKeyRuntime: createEmbeddedKeyRuntimeState(),
    embeddedPreloadPath: "/app/out/preload/embedded.cjs",
    runtimeTabsPageUrl: "data:text/html,runtime-tabs",
    runtimeTabsPreloadPath: "/app/out/preload/runtime-tabs.cjs",
    ...(options.getCursorScreenPoint ? { getCursorScreenPoint: options.getCursorScreenPoint } : {}),
    ...(options.getRuntimeTabGameIcon
      ? { getRuntimeTabGameIcon: options.getRuntimeTabGameIcon }
      : {}),
    ...(options.getRolePaths ? { getRolePaths: options.getRolePaths } : {}),
    ...(options.getNativeSessionConfiguration
      ? { getNativeSessionConfiguration: options.getNativeSessionConfiguration }
      : {}),
    ...(options.getWorkspaceAppearanceSettings
      ? { getWorkspaceAppearanceSettings: options.getWorkspaceAppearanceSettings }
      : {}),
    ...(options.handleRuntimeTabAction
      ? { handleRuntimeTabAction: options.handleRuntimeTabAction }
      : {}),
    ...(options.onEmbeddedWebContentsCreated
      ? { onEmbeddedWebContentsCreated: options.onEmbeddedWebContentsCreated }
      : {}),
    ...(options.performNativeZoom
      ? { performNativeZoom: options.performNativeZoom }
      : {}),
    ...(options.persistWorkspaceRoleZoom
      ? { persistWorkspaceRoleZoom: options.persistWorkspaceRoleZoom }
      : {}),
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    ...(options.defaultLaunchTarget ? { getDefaultLaunchTarget: () => options.defaultLaunchTarget! } : {}),
    ...(options.workspaceDisplays ? { getWorkspaceDisplays: () => options.workspaceDisplays! } : {}),
    platform: options.platform ?? (options.useTabbedHostWindow ? "win32" : process.platform),
    ...(options.prefersReducedTransparency
      ? { prefersReducedTransparency: options.prefersReducedTransparency }
      : {}),
    ...(options.systemRuntimePool ? { systemRuntimePool: options.systemRuntimePool } : {}),
    workspaceDividerResolver: resolveTestWorkspaceDividers,
    workspaceDividerResizeResolver: resizeTestWorkspaceDivider,
    workspaceLayoutResolver: options.workspaceLayoutResolver ?? resolveTestWorkspaceLayout
  });
  const seededRoles = new Map<string, Role>();
  const seededWorkspaces = new Map<string, {
    items: BrowserWorkspaceLaunchItem[];
    workspace: Pick<
      LaunchWorkspace,
      "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "template"
    >;
  }>();
  const executeEmbedded = (action: CoreEffectAction): Promise<unknown> =>
    manager.executeEmbeddedEffect(
      action as Parameters<ElectronBrowserRuntime["executeEmbeddedEffect"]>[0]
    );
  const resolvedEngineFor = (
    role: Role
  ): Extract<ResolvedBrowserEngine, "electron" | "webview2" | "wkwebview"> =>
    typeof options.resolvedEngine === "function"
      ? options.resolvedEngine(role)
      : options.resolvedEngine ?? "electron";
  const applyRuntime = async (
    snapshot: BrowserRuntimeSnapshot,
    target?: { displayId: number; workArea: PixelBounds },
    revealDisplayIds: number[] = [],
    focusTabId?: string,
    focusWindowDisplayIds: number[] = []
  ): Promise<BrowserRuntimeSnapshot> => {
    await executeEmbedded({
      type: "embeddedApplyRuntime",
      snapshot,
      target,
      revealDisplayIds,
      focusWindowDisplayIds,
      focusTabId
    });
    return snapshot;
  };
  const removeRoleRuntime = (roleId: string): void => {
    const runtime = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
    const roleRuntime = runtime.roles.find((candidate) => candidate.roleId === roleId);
    if (!roleRuntime) return;
    browserRuntimeState.invokeBrowserRuntime({ type: "removeRole", roleId });
    const tab = roleRuntime.tabId
      ? runtime.tabs.find((candidate) => candidate.id === roleRuntime.tabId)
      : undefined;
    if (tab && tab.roleIds.length <= 1) {
      browserRuntimeState.invokeBrowserRuntime({ type: "removeTab", tabId: tab.id });
      if (roleRuntime.workspaceId) {
        browserRuntimeState.invokeBrowserRuntime({
          type: "removeWorkspace",
          workspaceId: roleRuntime.workspaceId
        });
      }
    }
  };
  browserRuntimeState.setTypedInvoker(async (command: CoreCommand) => {
    if (command.type === "browserRoleLaunch") {
      command = {
        type: "embeddedRoleLaunch",
        roleId: command.roleId,
        target: command.target,
        ...(command.zoomFactor === undefined ? {} : { zoomFactor: command.zoomFactor })
      };
    } else if (command.type === "browserWorkspaceLaunch") {
      command = {
        type: "embeddedWorkspaceLaunch",
        workspaceId: command.workspaceId,
        target: command.target
      };
    } else if (command.type === "browserRoleStop") {
      command = { type: "embeddedRoleStop", roleId: command.roleId };
    } else if (command.type === "browserWorkspaceStop") {
      command = { type: "embeddedWorkspaceStop", workspaceId: command.workspaceId };
    }
    switch (command.type) {
      case "overlayRequest":
        return {
          detached: false,
          language: "en",
          macroBadgePosition: {
            horizontalAlign: "center",
            horizontalMarginPx: 8,
            topPx: 128
          },
          macros: [],
          statuses: []
        };
      case "embeddedRoleLaunch": {
        const seededRole = seededRoles.get(command.roleId);
        if (!seededRole) throw new Error(`Role not found: ${command.roleId}`);
        const current = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const running = current.roles.find((candidate) => candidate.roleId === command.roleId);
        if (running?.tabId) {
          const activated = browserRuntimeState.invokeBrowserRuntime({
            type: "activateTab",
            tabId: running.tabId
          }).snapshot;
          await applyRuntime(
            activated,
            undefined,
            [command.target.displayId],
            undefined,
            [command.target.displayId]
          );
          await executeEmbedded({
            type: "embeddedFocusRole",
            roleId: command.roleId,
            zoomFactor: command.zoomFactor ?? 1
          });
          return [{
            launchedAt: running.launchedAt ?? new Date().toISOString(),
            roleId: command.roleId,
            runtimeMode: "embedded",
            state: "running"
          }];
        }
        const created = browserRuntimeState.invokeBrowserRuntime({
          type: "createTab",
          sourceId: seededRole.id,
          name: seededRole.name,
          displayId: command.target.displayId,
          tabType: "role",
          roleIds: [seededRole.id]
        });
        const tabId = created.createdTabId!;
        browserRuntimeState.invokeBrowserRuntime({
          type: "roleTransition",
          roleId: seededRole.id,
          runtime: "embedded",
          tabId,
          state: "launching"
        });
        const activated = browserRuntimeState.invokeBrowserRuntime({
          type: "activateTab",
          tabId
        }).snapshot;
        try {
          await executeEmbedded({
            type: "embeddedCreateTab",
            tab: {
              tabId,
              sourceId: seededRole.id,
              name: seededRole.name,
              workspaceAppearance: options.getWorkspaceAppearanceSettings
                ? await options.getWorkspaceAppearanceSettings()
                : { background: "material", gap: 4 },
              target: command.target,
              roles: [{
                role: seededRole,
                resolvedEngine: resolvedEngineFor(seededRole),
                rect: { x: 0, y: 0, width: 1, height: 1 },
                zoomFactor: command.zoomFactor ?? 1,
                zoomMode: "fixed"
              }]
            }
          });
          await applyRuntime(
            activated,
            command.target,
            [command.target.displayId],
            undefined,
            [command.target.displayId]
          );
          await executeEmbedded({
            type: "embeddedConfigureRoleSessions",
            roleIds: [seededRole.id]
          });
          await executeEmbedded({
            type: "embeddedLoadRoles",
            roles: [{
              roleId: seededRole.id,
              resolvedEngine: resolvedEngineFor(seededRole),
              url: seededRole.launchUrl,
              zoomFactor: command.zoomFactor ?? 1
            }]
          });
          await executeEmbedded({
            type: "embeddedInstallOverlays",
            roleIds: [seededRole.id]
          });
          await executeEmbedded({
            type: "embeddedFocusRole",
            roleId: seededRole.id
          });
        } catch (error) {
          await executeEmbedded({ type: "embeddedDestroyTab", tabId });
          removeRoleRuntime(seededRole.id);
          await applyRuntime(
            browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot,
            undefined,
            [command.target.displayId]
          );
          throw error;
        }
        const launchedAt = new Date().toISOString();
        const runningSnapshot = browserRuntimeState.invokeBrowserRuntime({
          type: "roleTransition",
          roleId: seededRole.id,
          runtime: "embedded",
          tabId,
          state: "running",
          launchedAt
        }).snapshot;
        await applyRuntime(runningSnapshot);
        return [{ launchedAt, roleId: seededRole.id, runtimeMode: "embedded", state: "running" }];
      }
      case "embeddedWorkspaceLaunch": {
        const seeded = seededWorkspaces.get(command.workspaceId);
        if (!seeded) throw new Error(`Workspace not found: ${command.workspaceId}`);
        const roleIds = seeded.items.map(({ role }) => role.id);
        const current = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const runningRoleIds = current.roles
          .filter(({ roleId }) => roleIds.includes(roleId))
          .map(({ roleId }) => roleId);
        if (runningRoleIds.length > 0) {
          throw Object.assign(new Error("One or more roles are already running."), {
            code: "ROLE_ALREADY_RUNNING",
            roleNames: runningRoleIds.map(
              (roleId) => seededRoles.get(roleId)?.name ?? roleId
            )
          });
        }
        browserRuntimeState.invokeBrowserRuntime({
          type: "beginWorkspace",
          workspaceId: seeded.workspace.id,
          name: seeded.workspace.name,
          displayId: command.target.displayId,
          roleIds
        });
        const created = browserRuntimeState.invokeBrowserRuntime({
          type: "createTab",
          sourceId: seeded.workspace.id,
          name: seeded.workspace.name,
          displayId: command.target.displayId,
          tabType: "workspace",
          workspaceId: seeded.workspace.id,
          roleIds
        });
        const tabId = created.createdTabId!;
        for (const roleId of roleIds) {
          browserRuntimeState.invokeBrowserRuntime({
            type: "roleTransition",
            roleId,
            runtime: "embedded",
            workspaceId: seeded.workspace.id,
            tabId,
            state: "launching"
          });
        }
        const activated = browserRuntimeState.invokeBrowserRuntime({
          type: "activateTab",
          tabId
        }).snapshot;
        try {
          await executeEmbedded({
            type: "embeddedCreateTab",
            tab: {
              tabId,
              sourceId: seeded.workspace.id,
              name: seeded.workspace.name,
              workspaceId: seeded.workspace.id,
              workspaceTemplate: seeded.workspace.template,
              workspaceAppearance: options.getWorkspaceAppearanceSettings
                ? await options.getWorkspaceAppearanceSettings()
                : { background: "material", gap: 4 },
              target: command.target,
              roles: seeded.items.map((item) => ({
                role: item.role,
                resolvedEngine: resolvedEngineFor(item.role),
                rect: item.rect,
                zoomFactor: (
                  item.browserZoomPercent ?? seeded.workspace.browserZoomPercent
                ) / 100,
                zoomMode: item.browserZoomPercent === undefined
                  ? seeded.workspace.browserZoomMode
                  : "fixed"
              }))
            }
          });
          await applyRuntime(
            activated,
            command.target,
            [command.target.displayId],
            undefined,
            [command.target.displayId]
          );
          await executeEmbedded({
            type: "embeddedConfigureRoleSessions",
            roleIds
          });
          await executeEmbedded({
            type: "embeddedLoadRoles",
            roles: seeded.items.map((item) => ({
              roleId: item.role.id,
              resolvedEngine: resolvedEngineFor(item.role),
              url: item.role.launchUrl,
              zoomFactor: (
                item.browserZoomPercent ?? seeded.workspace.browserZoomPercent
              ) / 100
            }))
          });
          await executeEmbedded({
            type: "embeddedInstallOverlays",
            roleIds
          });
          await executeEmbedded({
            type: "embeddedFocusRole",
            roleId: roleIds[0]
          });
        } catch (error) {
          await executeEmbedded({ type: "embeddedDestroyTab", tabId });
          roleIds.forEach(removeRoleRuntime);
          browserRuntimeState.invokeBrowserRuntime({
            type: "removeWorkspace",
            workspaceId: seeded.workspace.id
          });
          await applyRuntime(
            browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot,
            undefined,
            [command.target.displayId]
          );
          throw error;
        }
        const launchedAt = new Date().toISOString();
        for (const roleId of roleIds) {
          browserRuntimeState.invokeBrowserRuntime({
            type: "roleTransition",
            roleId,
            runtime: "embedded",
            workspaceId: seeded.workspace.id,
            tabId,
            state: "running",
            launchedAt
          });
        }
        const runningSnapshot = browserRuntimeState.invokeBrowserRuntime({
          type: "setWorkspaceState",
          workspaceId: seeded.workspace.id,
          state: "running"
        }).snapshot;
        await applyRuntime(runningSnapshot);
        return roleIds.map((roleId) => ({
          launchedAt,
          roleId,
          runtimeMode: "embedded",
          state: "running"
        }));
      }
      case "embeddedRoleStop": {
        const snapshot = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const roleRuntime = snapshot.roles.find(({ roleId }) => roleId === command.roleId);
        if (!roleRuntime?.tabId) return { stopped: true };
        const tab = snapshot.tabs.find(({ id }) => id === roleRuntime.tabId);
        if ((tab?.roleIds.length ?? 1) <= 1) {
          const display = tab
            ? snapshot.displays.find(({ displayId }) => displayId === tab.displayId)
            : undefined;
          const nextActiveTabId = display?.tabIds.find(
            (tabId) => tabId !== roleRuntime.tabId &&
              !snapshot.tabs.find(({ id }) => id === tabId)?.hidden
          );
          await executeEmbedded({
            type: "embeddedDestroyTab",
            tabId: roleRuntime.tabId,
            nextActiveTabId
          });
        } else {
          await executeEmbedded({ type: "embeddedDestroyRole", roleId: command.roleId });
        }
        removeRoleRuntime(command.roleId);
        await applyRuntime(
          browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot
        );
        return { stopped: true };
      }
      case "embeddedSystemSurfaceFailed": {
        const snapshot = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const runtimeRole = snapshot.roles.find(({ roleId }) => roleId === command.roleId);
        const tab = runtimeRole?.tabId
          ? snapshot.tabs.find(({ id }) => id === runtimeRole.tabId)
          : undefined;
        if (!tab) throw new Error(`Runtime tab not found for ${command.roleId}`);
        const fallback = await executeEmbedded({
          type: "embeddedFallbackTabToElectron",
          tabId: tab.id,
          roleIds: tab.roleIds
        }) as {
          roles?: Array<{
            authVerified?: boolean;
            roleId?: string;
          }>;
        };
        const statuses: BrowserRoleStatusRecord[] = tab.roleIds.map((roleId) => ({
          roleId,
          runtimeMode: "embedded",
          state: "running" as const,
          preferredEngine: "system",
          resolvedEngine: "electron",
          hostKind: "electron",
          fallbackReason: fallback.roles?.find((role) => role.roleId === roleId)
            ?.authVerified === false
            ? "auth-verification-failed"
            : "runtime-crashed",
          sessionContinuity: fallback.roles?.find((role) => role.roleId === roleId)
            ?.authVerified === false
            ? "needs-login"
            : "verified"
        }));
        browserRuntimeState.publishBrowserStatuses(statuses);
        return statuses;
      }
      case "embeddedWorkspaceStop": {
        const snapshot = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const runtime = snapshot.workspaces.find(
          ({ workspaceId }) => workspaceId === command.workspaceId
        );
        if (!runtime?.tabId) return { stopped: true };
        const tab = snapshot.tabs.find(({ id }) => id === runtime.tabId);
        const display = tab
          ? snapshot.displays.find(({ displayId }) => displayId === tab.displayId)
          : undefined;
        const nextActiveTabId = display?.tabIds.find(
          (tabId) => tabId !== runtime.tabId &&
            !snapshot.tabs.find(({ id }) => id === tabId)?.hidden
        );
        await executeEmbedded({
          type: "embeddedDestroyTab",
          tabId: runtime.tabId,
          nextActiveTabId
        });
        runtime.roleIds.forEach(removeRoleRuntime);
        const stoppedSnapshot = browserRuntimeState.invokeBrowserRuntime({
          type: "removeWorkspace",
          workspaceId: command.workspaceId
        }).snapshot;
        await applyRuntime(stoppedSnapshot);
        return { stopped: true };
      }
      case "embeddedWindowsShow": {
        const current = browserRuntimeState.invokeBrowserRuntime({ type: "snapshot" }).snapshot;
        const displayIds = command.displayId === undefined
          ? current.displays.map(({ displayId }) => displayId)
          : [command.displayId];
        let snapshot = current;
        for (const displayId of displayIds) {
          snapshot = browserRuntimeState.invokeBrowserRuntime({
            type: "showDisplay",
            displayId
          }).snapshot;
        }
        return applyRuntime(snapshot, undefined, displayIds, undefined, displayIds);
      }
      case "embeddedTabActivate": {
        const snapshot = browserRuntimeState.invokeBrowserRuntime({
          type: "activateTab",
          tabId: command.tabId
        }).snapshot;
        const displayId = snapshot.tabs.find(({ id }) => id === command.tabId)!.displayId;
        return applyRuntime(
          snapshot,
          undefined,
          [displayId],
          command.tabId,
          [displayId]
        );
      }
      case "embeddedTabActivateAdjacent": {
        const snapshot = browserRuntimeState.invokeBrowserRuntime({
          type: "activateAdjacentTab",
          displayId: command.displayId,
          direction: command.direction
        }).snapshot;
        const activeTabId = snapshot.displays.find(
          ({ displayId }) => displayId === command.displayId
        )?.activeTabId;
        return applyRuntime(snapshot, undefined, [command.displayId], activeTabId);
      }
      case "embeddedTabHide":
        return applyRuntime(browserRuntimeState.invokeBrowserRuntime({
          type: "hideTab",
          tabId: command.tabId
        }).snapshot);
      case "embeddedTabReorder":
        return applyRuntime(browserRuntimeState.invokeBrowserRuntime({
          type: "reorderTab",
          tabId: command.tabId,
          ...(command.beforeTabId ? { beforeTabId: command.beforeTabId } : {})
        }).snapshot);
      case "embeddedTabMove":
        return applyRuntime(browserRuntimeState.invokeBrowserRuntime({
          type: "moveTab",
          tabId: command.tabId,
          displayId: command.target.displayId
        }).snapshot, command.target, [command.target.displayId], command.tabId, [
          command.target.displayId
        ]);
      case "embeddedDisplayRemove":
        return applyRuntime(browserRuntimeState.invokeBrowserRuntime({
          type: "moveDisplayTabs",
          sourceDisplayId: command.displayId,
          targetDisplayId: command.fallback.displayId
        }).snapshot, command.fallback, [command.fallback.displayId]);
      default:
        throw new Error(`Unexpected typed command in ElectronBrowserRuntime test: ${command.type}`);
    }
  });
  const launch = manager.launch.bind(manager);
  manager.launch = ((launchRole, launchOptions) => {
    seededRoles.set(launchRole.id, launchRole);
    return launch(launchRole, launchOptions);
  }) as ElectronBrowserRuntime["launch"];
  const launchWorkspace = manager.launchWorkspace.bind(manager);
  manager.launchWorkspace = ((launchWorkspaceRecord, items, target, launchMode) => {
    items.forEach(({ role: itemRole }) => seededRoles.set(itemRole.id, itemRole));
    const normalizedRects = normalizeTestWorkspaceRects(items.map(({ rect }) => rect));
    seededWorkspaces.set(launchWorkspaceRecord.id, {
      items: items.map((item, index) => ({
        ...item,
        rect: normalizedRects[index]
      })),
      workspace: launchWorkspaceRecord
    });
    return launchWorkspace(launchWorkspaceRecord, items, target, launchMode);
  }) as ElectronBrowserRuntime["launchWorkspace"];
  manager.setBeforeRolesStop(beforeRolesStop);

  return {
    beforeRolesStop,
    browserRuntimeState,
    chromeViews,
    createHostWindow,
    createMacRuntimeTabsController,
    createRuntimeChromeView,
    createTabbedHostWindow,
    createView,
    hosts,
    manager,
    nativeChromeControllers,
    views
  };
}

function createMockHost(deferFullscreenTransitions = false) {
  let visible = false;
  let pendingFullscreenTransition: boolean | undefined;
  const host = Object.assign(new EventEmitter(), {
    id: Math.floor(Math.random() * 100_000),
    close: vi.fn(),
    completeFullScreenTransition: vi.fn(() => {
      if (pendingFullscreenTransition === undefined) return;
      const fullscreen = pendingFullscreenTransition;
      pendingFullscreenTransition = undefined;
      host.fullscreen = fullscreen;
      host.emit(fullscreen ? "enter-full-screen" : "leave-full-screen");
    }),
    contentBounds: { x: 0, y: 0, width: 1200, height: 800 },
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
      setBackgroundColor: vi.fn()
    },
    focus: vi.fn(),
    getBounds: vi.fn(() => host.contentBounds),
    getContentBounds: vi.fn(() => host.contentBounds),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => host.fullscreen),
    isMaximized: vi.fn(() => host.maximized),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    fullscreen: false,
    maximize: vi.fn(() => {
      host.maximized = true;
    }),
    maximized: false,
    minimize: vi.fn(),
    minimized: false,
    restore: vi.fn(),
    setBounds: vi.fn((bounds: PixelBounds) => {
      host.contentBounds = bounds;
    }),
    setFullScreen: vi.fn((value: boolean) => {
      pendingFullscreenTransition = value;
      if (!deferFullscreenTransitions) host.completeFullScreenTransition();
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    unmaximize: vi.fn(() => {
      host.maximized = false;
    })
  });
  host.isMinimized.mockImplementation(() => host.minimized);
  return host;
}

function createMockBrowserHost(deferFullscreenTransitions = false) {
  const host = createMockHost(deferFullscreenTransitions);
  const webContents = Object.assign(new EventEmitter(), {
    id: Math.floor(Math.random() * 100_000),
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  });
  return Object.assign(host, {
    loadURL: vi.fn(async () => {
      webContents.emit("did-finish-load");
    }),
    webContents
  });
}

function createMockNativeZoomPerformer() {
  const perform: NonNullable<ElectronBrowserRuntimeOptions["performNativeZoom"]> = (
    action,
    _window,
    targetWebContents
  ) => {
    targetWebContents.setZoomFactor(
      getMockNativeZoomFactor(action, targetWebContents.getZoomFactor())
    );
    return true;
  };
  return vi.fn(perform);
}

function getMockNativeZoomFactor(
  action: "in" | "out" | "reset",
  currentZoomFactor: number
): number {
  if (action === "reset") {
    return 1;
  }
  const delta = action === "in" ? 0.1 : -0.1;
  return Number(Math.min(3, Math.max(0.5, currentZoomFactor + delta)).toFixed(2));
}

function createMockView(
  loadUrlHandler?: (url: string) => Promise<void>,
  initialZoomFactor = 1
) {
  const emitter = new EventEmitter();
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  let currentUrl = "about:blank";
  let currentZoomFactor = initialZoomFactor;
  let destroyed = false;
  let audioMuted = false;
  const audible = false;
  let debuggerAttached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => {
      debuggerAttached = true;
    }),
    detach: vi.fn(() => {
      debuggerAttached = false;
    }),
    isAttached: vi.fn(() => debuggerAttached),
    sendCommand: vi.fn().mockResolvedValue({})
  });
  const processId = Math.floor(Math.random() * 100_000) + 1;
  const webContents = Object.assign(emitter, {
    debugger: debuggerApi,
    id: Math.floor(Math.random() * 100_000),
    close: vi.fn(() => {
      destroyed = true;
    }),
    executeJavaScript: vi.fn(async () => true),
    focus: vi.fn(),
    getOSProcessId: vi.fn(() => processId),
    getURL: vi.fn(() => currentUrl),
    getZoomFactor: vi.fn(() => currentZoomFactor),
    isAudioMuted: vi.fn(() => audioMuted),
    isCurrentlyAudible: vi.fn(() => audible),
    isDestroyed: vi.fn(() => destroyed),
    isDevToolsOpened: vi.fn(() => false),
    loadURL: vi.fn(async (url: string) => {
      if (loadUrlHandler) {
        await loadUrlHandler(url);
      }
      currentUrl = url;
      currentZoomFactor = 1;
      emitter.emit("did-finish-load");
    }),
    mainFrame: { framesInSubtree: [] },
    send: vi.fn(),
    sendInputEvent: vi.fn(),
    session: {
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        set: vi.fn().mockResolvedValue(undefined)
      },
      flushStorageData: vi.fn(),
      setProxy: vi.fn().mockResolvedValue(undefined)
    },
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    setAudioMuted: vi.fn((muted: boolean) => {
      audioMuted = muted;
    }),
    setZoomFactor: vi.fn((zoomFactor: number) => {
      currentZoomFactor = zoomFactor;
    })
  });
  const setBounds = vi.fn((nextBounds) => {
    bounds = nextBounds;
  });
  const view = {
    getBounds: vi.fn(() => bounds),
    setBackgroundBlur: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBounds,
    setVisible: vi.fn(),
    webContents
  };

  return { debuggerApi, setBounds, view, webContents };
}

function createOAuthPopup(
  opener: ReturnType<typeof createMockView>,
  views: Array<ReturnType<typeof createMockView>>
) {
  const popupIndex = views.length;
  const handler = opener.webContents.setWindowOpenHandler.mock.calls[0][0] as () => {
    action: string;
    createWindow: (options: { webPreferences?: Record<string, unknown> }) => unknown;
  };
  const response = handler();
  response.createWindow({ webPreferences: { javascript: true } });
  return views[popupIndex];
}

function runAnimationFrame(
  frames: Map<number, FrameRequestCallback>,
  frameId: number
): void {
  const callback = frames.get(frameId);
  frames.delete(frameId);
  callback?.(frameId * 16);
}
