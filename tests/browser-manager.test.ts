import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserLaunchAuthError,
  BrowserManager,
  createRoleSessionPartition
} from "../src/main/browser/BrowserManager";
import { LOGIN_STORAGE_EXPRESSION } from "../src/main/auth/loginEvidence";
import type { Role } from "../src/shared/types";

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

describe("BrowserManager embedded views", () => {
  it("creates a persistent isolated partition for each role", () => {
    expect(createRoleSessionPartition("role:one/two")).toBe("persist:rion-role-role-one-two");
  });

  it("launches an authenticated role inside a hidden WebContentsView", async () => {
    const harness = createHarness();
    const overlayInstaller = vi.fn().mockResolvedValue(undefined);
    harness.manager.setMacroOverlayInstaller(overlayInstaller);

    await expect(harness.manager.launch(role)).resolves.toMatchObject({
      roleId: role.id,
      state: "running"
    });

    expect(harness.createView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:rion-role-role-1",
        preload: "/app/out/preload/embedded.cjs",
        sandbox: true
      })
    });
    expect(harness.host.contentView.addChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].setVisible).toHaveBeenCalledWith(false);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(1);
    expect(overlayInstaller).toHaveBeenCalledWith(role, harness.views[0].webContents);
  });

  it("focuses an existing role without creating a second view", async () => {
    const harness = createHarness();

    await harness.manager.launch(role);
    await harness.manager.launch(role);

    expect(harness.createView).toHaveBeenCalledTimes(1);
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(harness.host.focus).toHaveBeenCalledTimes(2);
  });

  it("hosts OAuth popups as another view inside the same app window", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const handler = harness.views[0].webContents.setWindowOpenHandler.mock.calls[0][0] as () => {
      action: string;
      createWindow: (options: { webPreferences?: Record<string, unknown> }) => unknown;
    };

    const response = handler();
    const popupContents = response.createWindow({ webPreferences: { javascript: true } });

    expect(response.action).toBe("allow");
    expect(popupContents).toBe(harness.views[1].webContents);
    expect(harness.createView).toHaveBeenNthCalledWith(2, {
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:rion-role-role-1",
        sandbox: true
      })
    });
    expect(harness.host.contentView.addChildView).toHaveBeenLastCalledWith(harness.views[1].view);
  });

  it("shows views only after the renderer reports stage bounds", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    harness.manager.updateViewBounds({
      visible: true,
      views: [{ roleId: role.id, bounds: { x: 260, y: 80, width: 700, height: 500 } }]
    });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 260, y: 80, width: 700, height: 500 });
    expect(harness.views[0].setVisible).toHaveBeenLastCalledWith(true);

    harness.manager.updateViewBounds({ visible: false, views: [] });
    expect(harness.views[0].setVisible).toHaveBeenLastCalledWith(false);
  });

  it("preserves workspace layout while launching multiple isolated views", async () => {
    const harness = createHarness();
    const secondRole = { ...role, id: "role-2", name: "Alt" };
    harness.manager.setActiveLayout({
      id: "workspace-1",
      mode: "workspace",
      name: "Party",
      slots: [
        { roleId: role.id, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { roleId: secondRole.id, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    });

    await harness.manager.launch(role, { preserveLayout: true, zoomFactor: 0.9 });
    await harness.manager.launch(secondRole, { preserveLayout: true, zoomFactor: 0.9 });

    expect(harness.createView).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ webPreferences: expect.objectContaining({ partition: "persist:rion-role-role-1" }) })
    );
    expect(harness.createView).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ webPreferences: expect.objectContaining({ partition: "persist:rion-role-role-2" }) })
    );
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[1].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.manager.getActiveLayout()?.slots).toHaveLength(2);
  });

  it("resets auth metadata and destroys a view when verification fails", async () => {
    const harness = createHarness({ bodyText: "Log in with Google", localStorage: {} });

    await expect(harness.manager.launch(role)).rejects.toBeInstanceOf(BrowserLaunchAuthError);

    expect(harness.roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
    expect(harness.host.contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("keeps the embedded login view open until authentication evidence appears", async () => {
    const harness = createHarness({
      snapshots: [
        { bodyText: "Log in with Google", localStorage: {} },
        { bodyText: "Welcome", localStorage: { authToken: "token-1" } }
      ]
    });

    await harness.manager.startLogin({ ...role, authState: "login_required" });
    await expect(harness.manager.waitForAuthentication(role.id)).resolves.toMatchObject({
      authState: "authenticated"
    });
    expect(harness.manager.listStatuses()).toMatchObject([{ roleId: role.id, state: "running" }]);
  });

  it("stops and removes the matching native view", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    await harness.manager.stop(role.id);

    expect(harness.host.contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.manager.getActiveLayout()).toBeNull();
  });
});

function createHarness(options: {
  bodyText?: string;
  localStorage?: Record<string, string>;
  snapshots?: Array<{ bodyText: string; localStorage: Record<string, string> }>;
} = {}) {
  const views: ReturnType<typeof createMockView>[] = [];
  const snapshots = options.snapshots ?? [
    {
      bodyText: options.bodyText ?? "Welcome",
      localStorage: options.localStorage ?? { authToken: "token-1" }
    }
  ];
  let snapshotIndex = 0;
  const createView = vi.fn(() => {
    const view = createMockView(() => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]);
    views.push(view);
    return view.view as never;
  });
  const host = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    },
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn()
  };
  const roleStore = {
    updateAuthState: vi.fn().mockImplementation(async (_id: string, authState: Role["authState"]) => ({
      ...role,
      authState
    }))
  };
  const manager = new BrowserManager(roleStore, {
    createView,
    embeddedPreloadPath: "/app/out/preload/embedded.cjs",
    getHostWindow: () => host as never,
    loginPollIntervalMs: 0
  });

  return { createView, host, manager, roleStore, views };
}

function createMockView(readSnapshot: () => { bodyText: string; localStorage: Record<string, string> }) {
  const emitter = new EventEmitter();
  let bounds = { x: -10_000, y: -10_000, width: 1, height: 1 };
  let currentUrl = "about:blank";
  let destroyed = false;
  const webContents = Object.assign(emitter, {
    id: Math.floor(Math.random() * 100_000),
    close: vi.fn(() => {
      destroyed = true;
    }),
    executeJavaScript: vi.fn(async (source: string) => {
      if (source === LOGIN_STORAGE_EXPRESSION) {
        const snapshot = readSnapshot();
        return {
          bodyText: snapshot.bodyText,
          indexedDb: {},
          localStorage: snapshot.localStorage,
          sessionStorage: {}
        };
      }
      return "";
    }),
    focus: vi.fn(),
    getURL: vi.fn(() => currentUrl),
    isDestroyed: vi.fn(() => destroyed),
    loadURL: vi.fn(async (url: string) => {
      currentUrl = url;
    }),
    mainFrame: { framesInSubtree: [] },
    sendInputEvent: vi.fn(),
    session: {
      cookies: {
        get: vi.fn().mockResolvedValue([])
      }
    },
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn()
  });
  const setBounds = vi.fn((nextBounds) => {
    bounds = nextBounds;
  });
  const setVisible = vi.fn();
  const view = {
    getBounds: vi.fn(() => bounds),
    setBounds,
    setVisible,
    webContents
  };

  return { setBounds, setVisible, view, webContents };
}
