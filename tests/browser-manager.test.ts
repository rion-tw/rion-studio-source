import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  BrowserGameLoadError,
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

  it("opens a single role in a standard framed work-area window without an inner control offset", async () => {
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
        frame: true,
        show: false,
        title: role.name
      })
    );
    expect(harness.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
    expect(overlayInstaller).toHaveBeenCalledWith(role, harness.views[0].webContents);
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

  it("lays out workspace roles edge-to-edge using normalized rectangles", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Party - Main, Alt" })
    );
    expect(harness.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 600, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenCalledWith({ x: 600, y: 0, width: 600, height: 800 });
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[1].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(applyBrowserFonts).toHaveBeenCalledWith(role, createRoleSessionPartition(role.id));
    expect(applyBrowserFonts).toHaveBeenCalledWith(secondRole, createRoleSessionPartition(secondRole.id));
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createView.mock.invocationCallOrder[0]
    );
  });

  it("draws a six-pixel black divider that is entirely draggable", async () => {
    const harness = createHarness();

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.createView).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        webPreferences: expect.objectContaining({ preload: "/app/out/preload/divider.cjs" })
      })
    );
    expect(harness.views[2].setBounds).toHaveBeenCalledWith({ x: 597, y: 0, width: 6, height: 800 });
    const dividerUrl = vi.mocked(harness.views[2].webContents.loadURL).mock.calls[0][0];
    const dividerHtml = decodeURIComponent(dividerUrl.split(",", 2)[1]);
    expect(dividerHtml).toContain("html,body");
    expect(dividerHtml).toContain("background:#000");
    expect(dividerHtml).not.toContain("class=\"line\"");
    expect(dividerHtml).toContain("cursor:col-resize");
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
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 720, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 720, y: 0, width: 480, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 717, y: 0, width: 6, height: 800 });

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 0
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 144, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 144, y: 0, width: 1056, height: 800 });
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
        { x: 597, y: 0, width: 6, height: 800 },
        { x: 0, y: 397, width: 1200, height: 6 }
      ])
    );
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

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 450, height: 600 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 450, y: 0, width: 450, height: 600 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 447, y: 0, width: 6, height: 600 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 450, height: 600 });
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

  it("treats closing the framed host as stopping every contained role", async () => {
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
  applyBrowserFonts?: ReturnType<typeof vi.fn>;
  applyBrowserProxy?: ReturnType<typeof vi.fn>;
  loadUrlHandlers?: Array<(url: string) => Promise<void>>;
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
    const loadUrlHandler = options.loadUrlHandlers?.[views.length];
    const view = createMockView(() => snapshot, loadUrlHandler);
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
    ...(options.applyBrowserFonts ? { applyBrowserFonts: options.applyBrowserFonts } : {}),
    ...(options.applyBrowserProxy ? { applyBrowserProxy: options.applyBrowserProxy } : {}),
    createHostWindow,
    createView,
    dividerPreloadPath: "/app/out/preload/divider.cjs",
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
    minimized: false,
    restore: vi.fn(),
    show: vi.fn()
  });
  host.isMinimized.mockImplementation(() => host.minimized);
  return host;
}

function createMockView(
  readSnapshot: () => { bodyText: string; localStorage: Record<string, string> },
  loadUrlHandler?: (url: string) => Promise<void>
) {
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
      if (loadUrlHandler) {
        await loadUrlHandler(url);
      }
      currentUrl = url;
    }),
    mainFrame: { framesInSubtree: [] },
    sendInputEvent: vi.fn(),
    session: { cookies: { get: vi.fn().mockResolvedValue([]) }, setProxy: vi.fn().mockResolvedValue(undefined) },
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
