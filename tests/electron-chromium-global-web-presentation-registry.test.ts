import { describe, expect, it, vi } from "vitest";

import type { GlobalWebProfilePathsRecord } from "../src/shared/generated";
import {
  ChromiumGlobalWebPresentationRegistry
} from "../src/electron/main/chromiumGlobalWebPresentationRegistry";
import {
  WORKSPACE_WEB_CHROME_ACTION_CHANNEL,
  WORKSPACE_WEB_CHROME_SHELL_SESSION,
  WORKSPACE_WEB_CHROME_STATE_CHANNEL
} from "../src/shared/workspaceWebChrome";
import { ChromiumGlobalWebSessionRegistry } from
  "../src/electron/main/chromiumGlobalWebSessionRegistry";
import { ChromiumGlobalWebSurfaceRegistry } from
  "../src/electron/main/chromiumGlobalWebSurfaceRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";

type Listener = (...arguments_: unknown[]) => unknown;

class FakeContents implements ChromiumRoleSurfaceWebContentsPort {
  readonly listeners = new Map<keyof ChromiumRoleSurfaceEventMap, Set<Listener>>();
  readonly loadedUrls: string[] = [];
  readonly sent: Array<Readonly<{ channel: string; value: unknown }>> = [];
  readonly close = vi.fn();
  readonly session: ChromiumRoleSessionPort;
  currentUrl = "";
  destroyed = false;
  audioMuted = false;
  zoomFactor = 1;
  historyIndex = 0;
  history = ["https://fixture.test/start"];
  windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | null = null;
  readonly navigationHistory = {
    canGoBack: () => this.historyIndex > 0,
    canGoForward: () => this.historyIndex < this.history.length - 1,
    goBack: () => {
      this.historyIndex -= 1;
      this.currentUrl = this.history[this.historyIndex]!;
    },
    goForward: () => {
      this.historyIndex += 1;
      this.currentUrl = this.history[this.historyIndex]!;
    }
  };
  readonly reload = vi.fn();

  constructor(session: ChromiumRoleSessionPort) {
    this.session = session;
  }

  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  getURL(): string { return this.currentUrl; }
  getZoomFactor(): number { return this.zoomFactor; }
  isAudioMuted(): boolean { return this.audioMuted; }
  isCurrentlyAudible(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }

  on<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as unknown as Listener);
    this.listeners.set(event, listeners);
  }

  removeListener<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ): void {
    this.listeners.get(event)?.delete(listener as unknown as Listener);
  }

  send(channel: string, value: unknown): void {
    this.sent.push({ channel, value });
  }

  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" }
  ): void {
    this.windowOpenHandler = handler;
  }

  setAudioMuted(muted: boolean): void { this.audioMuted = muted; }
  setZoomFactor(factor: number): void { this.zoomFactor = factor; }

  emit<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumRoleSurfaceEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
  }

  finish(url: string): void {
    this.currentUrl = url;
    if (url.startsWith("http")) {
      if (this.history[this.historyIndex] !== url) {
        this.history = [...this.history.slice(0, this.historyIndex + 1), url];
        this.historyIndex = this.history.length - 1;
      }
    }
    this.emit("did-finish-load");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView implements ChromiumRoleWebContentsViewPort {
  readonly webContents: FakeContents;
  bounds: ChromiumRoleSurfaceBounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  ignoreNextVisibility = false;

  constructor(session: ChromiumRoleSessionPort) {
    this.webContents = new FakeContents(session);
  }

  getBounds(): ChromiumRoleSurfaceBounds { return { ...this.bounds }; }
  getVisible(): boolean { return this.visible; }
  setBounds(bounds: ChromiumRoleSurfaceBounds): void { this.bounds = { ...bounds }; }
  setVisible(visible: boolean): void {
    if (this.ignoreNextVisibility) {
      this.ignoreNextVisibility = false;
      return;
    }
    this.visible = visible;
  }
}

class FakeParent implements ChromiumRoleSurfaceParentPort {
  readonly id = 1;
  readonly children: ChromiumRoleWebContentsViewPort[] = [];
  readonly contentView = {
    addChildView: (view: ChromiumRoleWebContentsViewPort) => {
      this.children.push(view);
    },
    removeChildView: (view: ChromiumRoleWebContentsViewPort) => {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
    }
  };
  isDestroyed(): boolean { return false; }
}

function fakeSession(storagePath: string | null): ChromiumRoleSessionPort {
  return {
    storagePath,
    on: vi.fn(),
    cookies: { flushStore: vi.fn(async () => undefined) },
    flushStorageData: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn(),
    webRequest: { onErrorOccurred: vi.fn() }
  } as unknown as ChromiumRoleSessionPort;
}

function profile(platform: "darwin" | "win32" = "darwin"): GlobalWebProfilePathsRecord {
  return {
    profileKey: "global-web",
    chromiumUserDataDir: platform === "win32"
      ? "C:\\RionData\\web-profiles\\global-web\\chromium"
      : "/RionData/web-profiles/global-web/chromium"
  };
}

function harness(shellStoragePath: string | null = null, platform: "darwin" | "win32" = "darwin") {
  const contentSession = fakeSession(profile(platform).chromiumUserDataDir);
  const shellSession = fakeSession(shellStoragePath);
  const sessions = new ChromiumGlobalWebSessionRegistry(
    { fromPath: vi.fn(() => contentSession) },
    platform
  );
  const views: FakeView[] = [];
  const preferences: Array<Record<string, unknown>> = [];
  const factory = {
    create: (options: { webPreferences: Record<string, unknown> }) => {
      preferences.push(options.webPreferences);
      const view = new FakeView(
        options.webPreferences.session as ChromiumRoleSessionPort
      );
      views.push(view);
      return view;
    }
  };
  const content = new ChromiumGlobalWebSurfaceRegistry(
    sessions,
    factory as never
  );
  let ipcListener: ((event: { sender: object }, value: unknown) => void) | null = null;
  const ipcMain = {
    on: vi.fn((_channel, listener) => { ipcListener = listener; }),
    removeListener: vi.fn()
  };
  const errors = vi.fn();
  const subject = new ChromiumGlobalWebPresentationRegistry({
    content,
    views: factory as never,
    shell: {
      documentPath: "/Rion/out/renderer/runtime-web-chrome-electron.html",
      ipcMain,
      preloadPath: "/Rion/out/preload/workspaceWebChrome.cjs",
      session: shellSession,
      sessionIdentity: WORKSPACE_WEB_CHROME_SHELL_SESSION
    },
    onError: errors
  });
  const parent = new FakeParent();
  return {
    subject,
    parent,
    views,
    preferences,
    contentSession,
    shellSession,
    errors,
    ipcMain,
    emitAction: (sender: object, value: unknown) => ipcListener?.({ sender }, value),
    input: {
      attemptGeneration: "attempt-web-1",
      surfaceId: "web-tab-1-1",
      slotId: "slot-web-1",
      generation: 1,
      profile: profile(platform),
      parent,
      url: "https://fixture.test/start",
      bounds: { x: 10, y: 20, width: 700, height: 500 },
      visible: true,
      zoomFactor: 1,
      audioMuted: false,
      tabId: "tab-web-1",
      windowGeneration: 2,
      windowId: "window-web-1"
    }
  };
}

async function finishCreate(subject: ReturnType<typeof harness>) {
  const creation = subject.subject.create(subject.input);
  await vi.waitFor(() => expect(subject.views).toHaveLength(2));
  const shell = subject.views[0]!.webContents;
  const content = subject.views[1]!.webContents;
  shell.finish(shell.loadedUrls[0]!);
  content.finish("https://fixture.test/start");
  await creation;
  return { shell, content };
}

describe("Chromium paired Workspace Web presentation", () => {
  it.each(["darwin", "win32"] as const)("terminalizes a rejected shell navigation without a load event on %s", async platform => {
    const subject = harness(null, platform);
    const failure = new Error("ERR_ABORTED: local shell navigation cancelled");
    let rejectNavigation!: (error: Error) => void;
    const navigation = new Promise<void>((_resolve, reject) => { rejectNavigation = reject; });
    const load = vi.spyOn(FakeContents.prototype, "loadURL")
      .mockImplementationOnce(() => navigation);
    try {
      const creation = subject.subject.create(subject.input);
      const outcome = creation.then(() => null, error => error);
      await vi.waitFor(() => expect(subject.views).toHaveLength(2));
      const shell = subject.views[0]!.webContents;
      const content = subject.views[1]!.webContents;
      shell.close.mockImplementation(() => shell.destroy());
      content.close.mockImplementation(() => content.destroy());
      rejectNavigation(failure);
      await vi.waitFor(() => expect(shell.close).toHaveBeenCalledOnce());
      expect(await outcome).toBe(failure);
      expect(subject.subject.activeCount).toBe(0);
      expect(subject.parent.children).toEqual([]);
      await subject.subject.dispose();
    } finally {
      load.mockRestore();
    }
  });

  it("isolates persistent remote content from local Rion-owned chrome", async () => {
    const subject = harness();
    const { shell } = await finishCreate(subject);
    const evidence = subject.subject.runtimeEvidence("web-tab-1-1", 1);

    expect(subject.preferences[0]).toMatchObject({
      preload: "/Rion/out/preload/workspaceWebChrome.cjs",
      session: subject.shellSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    });
    expect(subject.preferences[1]).toMatchObject({
      disableHtmlFullscreenWindowResize: true,
      session: subject.contentSession
    });
    expect(subject.preferences[1]).not.toHaveProperty("preload");
    expect(evidence).toMatchObject({
      contentProfilePath: "/RionData/web-profiles/global-web/chromium",
      contentSession: "global-web-persistent",
      contentSessionStoragePath: "/RionData/web-profiles/global-web/chromium",
      contentUrl: "https://fixture.test/start",
      chromeShellSession: "rion-web-chrome-shell:memory",
      chromeShellStoragePath: null,
      isolatedSessions: true,
      containedFullscreen: false,
      containedFullscreenRevision: 0,
      chromeBounds: { x: 10, y: 20, width: 700, height: 34 },
      chromeVisible: true,
      contentBounds: { x: 10, y: 54, width: 700, height: 466 },
      contentVisible: true
    });
    expect(shell.windowOpenHandler?.({ url: "https://popup.test" }))
      .toEqual({ action: "deny" });
    expect(subject.parent.children).toEqual(subject.views);
  });

  it("rejects a forged local-shell identity backed by persistent native storage", () => {
    expect(() => harness("/RionData/forged-persistent-shell"))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_WORKSPACE_WEB_CHROME_SHELL_INVALID"
      }));
  });

  it("accepts visible chrome actions only from the exact local sender", async () => {
    const subject = harness();
    const { shell, content } = await finishCreate(subject);
    subject.emitAction({}, {
      surfaceId: "web-tab-1-1",
      generation: 1,
      type: "ready"
    });
    expect(subject.errors).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_WORKSPACE_WEB_CHROME_SENDER_STALE"
    }));

    subject.emitAction(shell, {
      surfaceId: "web-tab-1-1",
      generation: 1,
      type: "navigate",
      url: "https://fixture.test/next"
    });
    await vi.waitFor(() => expect(content.loadedUrls.at(-1))
      .toBe("https://fixture.test/next"));
    content.finish("https://fixture.test/next");
    await vi.waitFor(() => expect(shell.sent.at(-1)).toEqual({
      channel: WORKSPACE_WEB_CHROME_STATE_CHANNEL,
      value: expect.objectContaining({
        url: "https://fixture.test/next",
        canGoBack: true
      })
    }));
    expect(WORKSPACE_WEB_CHROME_ACTION_CHANNEL)
      .toBe("rion:workspace-web-chrome:action");
  });

  it("projects slot geometry as a paired chrome/content transaction and drains both", async () => {
    const subject = harness();
    const { shell, content } = await finishCreate(subject);
    subject.subject.setBounds("web-tab-1-1", 1, {
      x: 40, y: 60, width: 900, height: 640
    });
    subject.subject.setVisible("web-tab-1-1", 1, false);

    expect(subject.views[0]!.bounds).toEqual({ x: 40, y: 60, width: 900, height: 34 });
    expect(subject.views[1]!.bounds).toEqual({ x: 40, y: 94, width: 900, height: 606 });
    expect(subject.subject.readProjection("web-tab-1-1", 1)).toEqual({
      bounds: { x: 40, y: 60, width: 900, height: 640 },
      visible: false,
      zoomFactor: 1
    });

    const close = subject.subject.closeSurface("web-tab-1-1", 1);
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalledOnce());
    shell.destroy();
    await vi.waitFor(() => expect(content.close).toHaveBeenCalledOnce());
    content.destroy();
    await expect(close).resolves.toBe(true);
    expect(subject.subject.activeCount).toBe(0);
    expect(subject.parent.children).toEqual([]);
    await subject.subject.dispose();
    expect(subject.ipcMain.removeListener).toHaveBeenCalledOnce();
  });

  it("contains Chromium HTML fullscreen to the Web slot and restores exact paired bounds", async () => {
    const subject = harness();
    const { content } = await finishCreate(subject);

    content.emit("enter-html-full-screen");
    expect(subject.subject.runtimeEvidence("web-tab-1-1", 1)).toMatchObject({
      containedFullscreen: true,
      containedFullscreenRevision: 1,
      chromeBounds: { x: 10, y: 20, width: 700, height: 34 },
      chromeVisible: false,
      contentBounds: { x: 10, y: 20, width: 700, height: 500 },
      contentVisible: true,
      slotBounds: { x: 10, y: 20, width: 700, height: 500 }
    });

    subject.subject.setBounds("web-tab-1-1", 1, {
      x: 30, y: 40, width: 800, height: 600
    });
    expect(subject.subject.runtimeEvidence("web-tab-1-1", 1)).toMatchObject({
      containedFullscreen: true,
      containedFullscreenRevision: 1,
      chromeBounds: { x: 30, y: 40, width: 800, height: 34 },
      chromeVisible: false,
      contentBounds: { x: 30, y: 40, width: 800, height: 600 },
      slotBounds: { x: 30, y: 40, width: 800, height: 600 }
    });

    content.emit("leave-html-full-screen");
    expect(subject.subject.runtimeEvidence("web-tab-1-1", 1)).toMatchObject({
      containedFullscreen: false,
      containedFullscreenRevision: 2,
      chromeBounds: { x: 30, y: 40, width: 800, height: 34 },
      chromeVisible: true,
      contentBounds: { x: 30, y: 74, width: 800, height: 566 },
      contentVisible: true,
      slotBounds: { x: 30, y: 40, width: 800, height: 600 }
    });
    expect(subject.errors).not.toHaveBeenCalled();
  });

  it("fails closed on two-sided native readback mismatch and compensates visibility", async () => {
    const subject = harness();
    await finishCreate(subject);
    subject.views[1]!.ignoreNextVisibility = true;

    expect(() => subject.subject.setVisible("web-tab-1-1", 1, false))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_WORKSPACE_WEB_PRESENTATION_READBACK_FAILED"
      }));
    expect(subject.subject.readProjection("web-tab-1-1", 1)).toEqual({
      bounds: { x: 10, y: 20, width: 700, height: 500 },
      visible: true,
      zoomFactor: 1
    });

    subject.views[0]!.bounds = {
      ...subject.views[0]!.bounds,
      width: subject.views[0]!.bounds.width - 1
    };
    expect(() => subject.subject.readProjection("web-tab-1-1", 1))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_WORKSPACE_WEB_PRESENTATION_READBACK_FAILED"
      }));
  });
});
