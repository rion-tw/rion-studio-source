import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserLaunchAuthError,
  BrowserManager,
  createRoleSessionPartition,
  normalizedRectToPixelBounds
} from "../src/main/browser/BrowserManager";
import { LOGIN_STORAGE_EXPRESSION } from "../src/main/auth/loginEvidence";
import type { LaunchWorkspace, Role } from "../src/shared/types";
import { getDefaultWorkspaceRects } from "../src/shared/workspaceLayout";

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

const workspace: LaunchWorkspace = {
  id: "workspace-1",
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

describe("BrowserManager game host windows", () => {
  it("creates a persistent isolated partition for each role", () => {
    expect(createRoleSessionPartition("role:one/two")).toBe("persist:rion-role-role-one-two");
  });

  it("opens a single role in a borderless work-area window without a control offset", async () => {
    const harness = createHarness();
    const overlayInstaller = vi.fn().mockResolvedValue(undefined);
    harness.manager.setMacroOverlayInstaller(overlayInstaller);

    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 100,
        y: 50,
        width: 1200,
        height: 800,
        backgroundColor: "#000000",
        frame: false,
        show: false,
        title: role.name
      })
    );
    expect(harness.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
    expect(overlayInstaller).toHaveBeenCalledWith(role, harness.views[0].webContents);
  });

  it("focuses an existing single-role host instead of opening another window", async () => {
    const harness = createHarness();

    await harness.manager.launch(role);
    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createView).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].focus).toHaveBeenCalledTimes(2);
  });

  it("lays out workspace roles edge-to-edge using normalized rectangles", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 600, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenCalledWith({ x: 600, y: 0, width: 600, height: 800 });
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[1].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
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

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 500, height: 700 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 500, y: 0, width: 500, height: 700 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 500, height: 700 });
  });

  it("allows non-overlapping workspaces to run in separate windows", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [{ role, rect: workspace.slots[0].rect }]);
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Second" };
    const secondRole = createRole("role-3", "Third");

    await harness.manager.launchWorkspace(secondWorkspace, [
      { role: secondRole, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(2);
    expect(harness.manager.listStatuses()).toHaveLength(2);
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

  it("rolls back the complete workspace when a later role fails auth verification", async () => {
    const harness = createHarness({
      snapshotsByView: [
        { bodyText: "Welcome", localStorage: { authToken: "token-1" } },
        { bodyText: "Log in with Google", localStorage: {} }
      ]
    });

    await expect(
      harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
      ])
    ).rejects.toBeInstanceOf(BrowserLaunchAuthError);

    expect(harness.beforeRolesStop).toHaveBeenCalledWith(["role-1", "role-2"]);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("stops the actual launched host by workspace id", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    await harness.manager.stopWorkspace(workspace.id);

    expect(harness.beforeRolesStop).toHaveBeenCalledWith(["role-1", "role-2"]);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("treats closing the borderless host as stopping every contained role", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.hosts[0].emit("close", event);

    await vi.waitFor(() => expect(harness.manager.listStatuses()).toEqual([]));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.beforeRolesStop).toHaveBeenCalledWith([role.id]);
  });

  it("closes the containing host for Cmd/Ctrl+W from a game view", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.views[0].webContents.emit("before-input-event", event, {
      control: true,
      key: "w",
      meta: false,
      type: "keyDown"
    });

    await vi.waitFor(() => expect(harness.hosts[0].close).toHaveBeenCalledTimes(1));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("hosts OAuth popups over the matching role cell", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    const popup = createOAuthPopup(harness.views[0], harness.views);

    expect(popup.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(harness.hosts[0].contentView.addChildView).toHaveBeenLastCalledWith(popup.view);
  });

  it("keeps a login host open until authentication evidence appears", async () => {
    const harness = createHarness({
      snapshotsByView: [{ bodyText: "Welcome", localStorage: { authToken: "token-1" } }]
    });

    await harness.manager.startLogin({ ...role, authState: "login_required" });
    await expect(harness.manager.waitForAuthentication(role.id)).resolves.toMatchObject({
      authState: "authenticated"
    });
    expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toMatchObject([{ roleId: role.id, state: "running" }]);
  });
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
    ]]
  ] as const)("maps %s without title or control-bar offsets", (template, expected) => {
    expect(
      getDefaultWorkspaceRects(template).map((rect) =>
        normalizedRectToPixelBounds(rect, { x: 0, y: 0, width: 1200, height: 800 })
      )
    ).toEqual(expected);
  });
});

function createRole(id: string, name: string): Role {
  return { ...role, id, name };
}

function createHarness(options: {
  snapshotsByView?: Array<{ bodyText: string; localStorage: Record<string, string> }>;
} = {}) {
  const hosts: ReturnType<typeof createMockHost>[] = [];
  const views: ReturnType<typeof createMockView>[] = [];
  const defaultSnapshot = { bodyText: "Welcome", localStorage: { authToken: "token-1" } };
  const createHostWindow = vi.fn(() => {
    const host = createMockHost();
    hosts.push(host);
    return host as never;
  });
  const createView = vi.fn(() => {
    const snapshot = options.snapshotsByView?.[views.length] ?? defaultSnapshot;
    const view = createMockView(() => snapshot);
    views.push(view);
    return view.view as never;
  });
  const roleStore = {
    updateAuthState: vi.fn().mockImplementation(async (_id: string, authState: Role["authState"]) => ({
      ...role,
      authState
    }))
  };
  const beforeRolesStop = vi.fn().mockResolvedValue(undefined);
  const manager = new BrowserManager(roleStore, {
    createHostWindow,
    createView,
    embeddedPreloadPath: "/app/out/preload/embedded.cjs",
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    loginPollIntervalMs: 0
  });
  manager.setBeforeRolesStop(beforeRolesStop);

  return { beforeRolesStop, createHostWindow, createView, hosts, manager, roleStore, views };
}

function createMockHost() {
  const host = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    contentBounds: { x: 0, y: 0, width: 1200, height: 800 },
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    },
    focus: vi.fn(),
    getContentBounds: vi.fn(() => host.contentBounds),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn()
  });
  return host;
}

function createMockView(readSnapshot: () => { bodyText: string; localStorage: Record<string, string> }) {
  const emitter = new EventEmitter();
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
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
    session: { cookies: { get: vi.fn().mockResolvedValue([]) } },
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn()
  });
  const setBounds = vi.fn((nextBounds) => {
    bounds = nextBounds;
  });
  const view = {
    getBounds: vi.fn(() => bounds),
    setBounds,
    webContents
  };

  return { setBounds, view, webContents };
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
