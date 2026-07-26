import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  ElectronBrowserRuntime,
  classifyNativeZoomShortcut,
  classifyRuntimeTabSwitchShortcut,
  isExpectedNativeZoomResult,
  normalizedRectToPixelBounds
} from "../src/main/browser/ElectronBrowserRuntime";
import { SystemWebViewRuntimePool } from "../src/main/browser/SystemWebViewRuntimePool";
import type {
  WebSurfaceLifecycleEvent,
  WebSurfacePort
} from "../src/main/browser/ports/WebSurfacePort";
import type {
  BrowserRuntimeSnapshot,
  EmbeddedTabEffectRecord,
  ResolvedBrowserEngine,
  RolePathsRecord,
  WorkspaceLayoutInput
} from "../src/shared/generated";
import type { PixelBounds, Role } from "../src/shared/types";
import { createEmbeddedKeyRuntimeState } from "./helpers/embeddedKeyRuntimeState";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  notes: "",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("system-only game runtime", () => {
  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "creates, loads, focuses, and destroys a %s native role",
    async (platform, engine) => {
      const native = createMockSystemSurface();
      const harness = createHarness(platform, engine, () => native.surface);

      await harness.manager.executeEmbeddedEffect(createTabEffect(engine, [role]));
      await harness.manager.executeEmbeddedEffect({
        type: "embeddedApplyRuntime",
        snapshot: runningSnapshot([role]),
        target: launchTarget,
        revealDisplayIds: [11],
        focusWindowDisplayIds: [11],
        focusTabId: "tab-1"
      });
      await harness.manager.executeEmbeddedEffect({
        type: "embeddedConfigureRoleSessions",
        roleIds: [role.id]
      });
      await harness.manager.executeEmbeddedEffect({
        type: "embeddedLoadRoles",
        roles: [{
          roleId: role.id,
          resolvedEngine: engine,
          url: role.launchUrl,
          zoomFactor: 1
        }]
      });
      await harness.manager.executeEmbeddedEffect({
        type: "embeddedInstallOverlays",
        roleIds: [role.id]
      });
      await harness.manager.executeEmbeddedEffect({
        type: "embeddedFocusRole",
        roleId: role.id,
        zoomFactor: 1.1
      });

      expect(native.surface.loadUrl).toHaveBeenCalledWith(role.launchUrl);
      expect(native.surface.addDocumentStartScript).toHaveBeenCalled();
      expect(native.surface.setVisible).toHaveBeenCalledWith(true);
      expect(native.surface.focus).toHaveBeenCalled();
      expect(native.surface.setZoomFactor).toHaveBeenCalledWith(1.1);
      expect(harness.host.show).toHaveBeenCalled();

      await harness.manager.executeEmbeddedEffect({
        type: "embeddedDestroyTab",
        tabId: "tab-1"
      });
      expect(native.surface.destroy).toHaveBeenCalledOnce();
      expect(harness.host.close).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["darwin", "wkwebview"],
    ["win32", "webview2"]
  ] as const)(
    "keeps %s workspace layouts native for 1, 3, 6, and 9 roles",
    async (platform, engine) => {
      for (const count of [1, 3, 6, 9]) {
        const surfaces: ReturnType<typeof createMockSystemSurface>[] = [];
        const harness = createHarness(platform, engine, () => {
          const surface = createMockSystemSurface();
          surfaces.push(surface);
          return surface.surface;
        });
        const roles = Array.from({ length: count }, (_, index) => ({
          ...role,
          id: `role-${index + 1}`,
          name: `Role ${index + 1}`
        }));
        await harness.manager.executeEmbeddedEffect(createTabEffect(engine, roles));
        await harness.manager.executeEmbeddedEffect({
          type: "embeddedApplyRuntime",
          snapshot: runningSnapshot(roles),
          target: launchTarget,
          revealDisplayIds: [11],
          focusWindowDisplayIds: [],
          focusTabId: "tab-1"
        });

        expect(surfaces).toHaveLength(count);
        for (const surface of surfaces) {
          expect(surface.surface.setBounds).toHaveBeenCalledWith(
            expect.objectContaining({
              height: expect.any(Number),
              width: expect.any(Number),
              x: expect.any(Number),
              y: expect.any(Number)
            })
          );
          expect(surface.surface.setVisible).toHaveBeenLastCalledWith(true);
        }

        await harness.manager.executeEmbeddedEffect({
          type: "embeddedDestroyTab",
          tabId: "tab-1"
        });
      }
    }
  );

  it("reports and rebuilds a crashed native surface with the same engine", async () => {
    const native = createMockSystemSurface();
    const recovered = createMockSystemSurface();
    const createSurface = vi.fn()
      .mockReturnValueOnce(native.surface)
      .mockReturnValueOnce(recovered.surface);
    const harness = createHarness("darwin", "wkwebview", createSurface);
    await harness.manager.executeEmbeddedEffect(createTabEffect("wkwebview", [role]));

    native.emit({ type: "crashed", reason: "web-content-process-terminated" });

    await vi.waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith({
        type: "embeddedSystemSurfaceFailed",
        roleId: role.id,
        reason: "web-content-process-terminated"
      });
      expect(harness.invoke).toHaveBeenCalledWith({
        type: "embeddedSystemSurfaceRecovered",
        roleId: role.id
      });
    });
    expect(createSurface).toHaveBeenCalledTimes(2);
    expect(harness.createView).not.toHaveBeenCalled();
  });

  it("rejects a platform engine mismatch before loading a role", async () => {
    const harness = createHarness(
      "darwin",
      "wkwebview",
      () => createMockSystemSurface().surface
    );
    await expect(
      harness.manager.executeEmbeddedEffect(createTabEffect("webview2", [role]))
    ).rejects.toMatchObject({ code: "SYSTEM_RUNTIME_ENGINE_MISMATCH" });
  });

  it("preserves shortcut classification as shell-only behavior", () => {
    expect(classifyNativeZoomShortcut({
      alt: false,
      code: "Equal",
      control: false,
      isComposing: false,
      key: "+",
      meta: true,
      shift: true,
      type: "keyDown"
    }, "darwin")).toBe("in");
    expect(classifyRuntimeTabSwitchShortcut({
      alt: false,
      code: "Tab",
      control: true,
      isComposing: false,
      key: "Tab",
      meta: false,
      shift: true,
      type: "keyDown"
    })).toBe("previous");
    expect(isExpectedNativeZoomResult("reset", 125, 100)).toBe(true);
  });

  it("converts normalized role rectangles using explicit host bounds", () => {
    expect(normalizedRectToPixelBounds(
      { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
      { x: 100, y: 20, width: 1200, height: 800 }
    )).toEqual({ x: 400, y: 420, width: 600, height: 400 });
  });
});

const launchTarget = {
  displayId: 11,
  workArea: { x: 100, y: 20, width: 1200, height: 800 }
};

function createTabEffect(
  engine: ResolvedBrowserEngine,
  roles: Role[]
): Extract<Parameters<ElectronBrowserRuntime["executeEmbeddedEffect"]>[0], {
  type: "embeddedCreateTab";
}> {
  const columns = Math.ceil(Math.sqrt(roles.length));
  const rows = Math.ceil(roles.length / columns);
  const tab: EmbeddedTabEffectRecord = {
    tabId: "tab-1",
    sourceId: roles.length === 1 ? roles[0].id : "workspace-1",
    name: roles.length === 1 ? roles[0].name : "Workspace",
    target: launchTarget,
    workspaceAppearance: { background: "material", gap: 4 },
    ...(roles.length === 1 ? {} : {
      workspaceId: "workspace-1",
      workspaceTemplate: "six_grid"
    }),
    roles: roles.map((item, index) => ({
      role: item,
      resolvedEngine: engine,
      rect: {
        x: (index % columns) / columns,
        y: Math.floor(index / columns) / rows,
        width: 1 / columns,
        height: 1 / rows
      },
      zoomFactor: 1,
      zoomMode: "fixed"
    }))
  };
  return { type: "embeddedCreateTab", tab };
}

function runningSnapshot(roles: Role[]): BrowserRuntimeSnapshot {
  return {
    displays: [{ displayId: 11, activeTabId: "tab-1", tabIds: ["tab-1"] }],
    roles: roles.map((item) => ({
      roleId: item.id,
      runtime: "embedded",
      tabId: "tab-1",
      state: "running"
    })),
    tabs: [{
      id: "tab-1",
      sourceId: roles.length === 1 ? roles[0].id : "workspace-1",
      name: roles.length === 1 ? roles[0].name : "Workspace",
      displayId: 11,
      tabType: roles.length === 1 ? "role" : "workspace",
      ...(roles.length === 1 ? {} : { workspaceId: "workspace-1" }),
      roleIds: roles.map(({ id }) => id),
      hidden: false
    }],
    workspaces: roles.length === 1 ? [] : [{
      workspaceId: "workspace-1",
      name: "Workspace",
      runtime: "embedded",
      displayId: 11,
      exclusiveDisplay: true,
      tabId: "tab-1",
      roleIds: roles.map(({ id }) => id),
      state: "running"
    }]
  };
}

function createHarness(
  platform: "darwin" | "win32",
  engine: ResolvedBrowserEngine,
  createSurface: () => WebSurfacePort
) {
  const host = createMockHost();
  const createView = vi.fn(() => createMockView() as never);
  const invoke = vi.fn(async (command: { type: string }) => {
    if (command.type === "browserStatuses" || command.type === "browserWorkspaceStatuses") {
      return [];
    }
    if (command.type === "overlayRequest") {
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
    }
    if (command.type === "embeddedSystemSurfaceFailed") return [];
    return undefined;
  });
  const pool = new SystemWebViewRuntimePool({
    platform,
    ...(platform === "darwin"
      ? { createMacSurface: () => createSurface() }
      : { createWindowsSurface: () => createSurface() as never })
  });
  const manager = new ElectronBrowserRuntime({
    browserRuntimeState: {
      invoke: invoke as never,
      subscribe: vi.fn(() => () => undefined)
    },
    adaptiveZoomResolver: async (_viewportWidth, currentPercent = 100) => currentPercent,
    createHostWindow: vi.fn(() => host as never),
    createView,
    dividerPreloadPath: "/app/divider.cjs",
    embeddedKeyRuntime: createEmbeddedKeyRuntimeState(),
    embeddedPreloadPath: "/app/embedded.cjs",
    getLaunchWorkArea: () => launchTarget.workArea,
    getRolePaths: async (roleId) => createRolePaths(roleId),
    platform,
    systemRuntimePool: pool,
    workspaceDividerResolver: () => [],
    workspaceDividerResizeResolver: (input) => ({
      changed: false,
      position: input.requestedPosition,
      roleIds: input.roles.map(({ roleId }) => roleId),
      roles: input.roles
    }),
    workspaceLayoutResolver: (input) => resolveLayout(input)
  });
  void engine;
  return { createView, host, invoke, manager };
}

function resolveLayout(input: WorkspaceLayoutInput) {
  return {
    contentBounds: input.contentBounds,
    dividers: [],
    roles: input.roles.map((item) => ({
      roleId: item.roleId,
      bounds: normalizedRectToPixelBounds(item.rect, input.contentBounds)
    })),
    visible: input.active && !input.hidden && input.windowVisible
  };
}

function createRolePaths(roleId: string): RolePathsRecord {
  return {
    browserUserDataDir: `/roles/${roleId}/browser`,
    systemBrowserDataDir: `/roles/${roleId}/browser/system`,
    webkitDataStoreIdentifier: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    webkitDataStoreKey: `rion.role.${roleId}`,
    webview2UserDataDir: `C:\\roles\\${roleId}\\browser\\webview2`
  };
}

function createMockSystemSurface() {
  const listeners = new Set<(event: WebSurfaceLifecycleEvent) => void>();
  const surface: WebSurfacePort = {
    addDocumentStartScript: vi.fn(async () => undefined),
    clearStorage: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => true) as never,
    focus: vi.fn(async () => undefined),
    loadUrl: vi.fn(async () => undefined),
    onLifecycleEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    setAudioMuted: vi.fn(async () => undefined),
    setBounds: vi.fn(async () => undefined),
    setVisible: vi.fn(async () => undefined),
    setZoomFactor: vi.fn(async () => undefined)
  };
  return {
    emit: (event: WebSurfaceLifecycleEvent) => listeners.forEach((listener) => listener(event)),
    surface
  };
}

function createMockHost() {
  const emitter = new EventEmitter();
  let visible = false;
  let destroyed = false;
  let focused = false;
  let bounds: PixelBounds = { ...launchTarget.workArea };
  const children: unknown[] = [];
  return Object.assign(emitter, {
    close: vi.fn(() => {
      destroyed = true;
      visible = false;
      emitter.emit("closed");
    }),
    contentView: {
      addChildView: vi.fn((view) => children.push(view)),
      children,
      removeChildView: vi.fn((view) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
      setBackgroundColor: vi.fn()
    },
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    focus: vi.fn(() => {
      focused = true;
    }),
    getBounds: vi.fn(() => ({ ...bounds })),
    getContentBounds: vi.fn(() => ({ ...bounds, x: 0, y: 0 })),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: vi.fn(() => destroyed),
    isFocused: vi.fn(() => focused),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    maximize: vi.fn(),
    minimize: vi.fn(),
    restore: vi.fn(),
    setBounds: vi.fn((next) => {
      bounds = { ...bounds, ...next };
    }),
    setFullScreen: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    setParentWindow: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    unmaximize: vi.fn()
  });
}

function createMockView() {
  const webContents = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    focus: vi.fn(),
    id: Math.floor(Math.random() * 100_000),
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    send: vi.fn()
  });
  return {
    setBackgroundColor: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents
  };
}
