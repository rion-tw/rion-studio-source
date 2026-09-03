import { describe, expect, it, vi } from "vitest";

import type { GlobalWebProfilePathsRecord } from "../src/shared/generated";
import {
  ChromiumGlobalWebSessionRegistry
} from "../src/electron/main/chromiumGlobalWebSessionRegistry";
import {
  ChromiumGlobalWebSurfaceRegistry,
  type ChromiumGlobalWebActiveMainFrameFailurePort,
  type ChromiumGlobalWebNativeAttachmentInput,
  type ChromiumGlobalWebNativeAttachmentPort,
  type CreateChromiumGlobalWebSurfaceInput
} from "../src/electron/main/chromiumGlobalWebSurfaceRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import type {
  ChromiumRoleSessionPort,
  ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";

type Listener = (...arguments_: unknown[]) => unknown;

interface PromiseControl<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

function controlledPromise<Value>(): PromiseControl<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeWebContents implements ChromiumRoleSurfaceWebContentsPort {
  static nextId = 1;
  readonly id = FakeWebContents.nextId++;
  readonly listeners = new Map<keyof ChromiumRoleSurfaceEventMap, Set<Listener>>();
  readonly loadedUrls: string[] = [];
  readonly closeOptions: Array<Readonly<{
    waitForBeforeUnload?: boolean;
  }> | undefined> = [];
  readonly audioValues: boolean[] = [];
  readonly zoomFactors: number[] = [];
  readonly session: ChromiumRoleSessionPort;
  currentUrl = "";
  destroyed = false;
  audible = false;
  audioMuted = false;
  zoomFactor = 1;
  loadFailure: unknown = null;
  windowOpenHandler:
    | ((details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>)
    | null = null;

  constructor(session: ChromiumRoleSessionPort) {
    this.session = session;
  }

  close(options?: Readonly<{ waitForBeforeUnload?: boolean }>): void {
    this.closeOptions.push(options);
  }

  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  getURL(): string {
    return this.currentUrl;
  }

  getZoomFactor(): number {
    return this.zoomFactor;
  }

  isAudioMuted(): boolean {
    return this.audioMuted;
  }

  isCurrentlyAudible(): boolean {
    return this.audible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    if (this.loadFailure) return Promise.reject(this.loadFailure);
    return Promise.resolve();
  }

  reload(): void {}

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

  send(): void {}

  setWindowOpenHandler(
    handler: (details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>
  ): void {
    this.windowOpenHandler = handler;
  }

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted;
    this.audioValues.push(muted);
  }

  setZoomFactor(factor: number): void {
    this.zoomFactors.push(factor);
    this.zoomFactor = factor;
  }

  emit<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumRoleSurfaceEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }

  finish(url: string): void {
    this.currentUrl = url;
    this.emit("did-finish-load");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

class FakeView implements ChromiumRoleWebContentsViewPort {
  readonly bounds: ChromiumRoleSurfaceBounds[] = [];
  readonly visibility: boolean[] = [];
  readonly ownedWebContents: FakeWebContents;
  invalidateWebContentsAfterDestroy = false;

  constructor(session: ChromiumRoleSessionPort) {
    this.ownedWebContents = new FakeWebContents(session);
  }

  get webContents(): FakeWebContents {
    if (this.invalidateWebContentsAfterDestroy && this.ownedWebContents.destroyed) {
      return undefined as unknown as FakeWebContents;
    }
    return this.ownedWebContents;
  }

  getBounds(): ChromiumRoleSurfaceBounds {
    return this.bounds.at(-1) ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  getVisible(): boolean {
    return this.visibility.at(-1) ?? false;
  }

  setBounds(bounds: ChromiumRoleSurfaceBounds): void {
    this.bounds.push(bounds);
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }
}

class FakeParent implements ChromiumRoleSurfaceParentPort {
  readonly id: number;
  readonly added: ChromiumRoleWebContentsViewPort[] = [];
  readonly removed: ChromiumRoleWebContentsViewPort[] = [];
  destroyed = false;
  failAdd = false;
  failRemove = false;
  readonly contentView = {
    addChildView: (view: ChromiumRoleWebContentsViewPort) => {
      if (this.failAdd) throw new Error("native add rejected");
      this.added.push(view);
    },
    removeChildView: (view: ChromiumRoleWebContentsViewPort) => {
      if (this.failRemove) throw new Error("native remove rejected");
      this.removed.push(view);
    }
  };

  constructor(id = 1) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function profile(): GlobalWebProfilePathsRecord {
  return {
    profileKey: "global-web",
    chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium"
  };
}

function fakeSession(path = profile().chromiumUserDataDir) {
  const flushStorageData = vi.fn();
  const flushStore = vi.fn(async () => undefined);
  let networkErrorListener: ((details: Readonly<{
    error: string;
    resourceType: string;
    url: string;
    webContents?: object;
    webContentsId?: number;
  }>) => void) | null = null;
  const onErrorOccurred = vi.fn((listener) => { networkErrorListener = listener; });
  const session = {
    on: vi.fn(),
    storagePath: path,
    cookies: { flushStore },
    flushStorageData,
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setBluetoothPairingHandler: vi.fn(),
    webRequest: { onErrorOccurred }
  } as unknown as ChromiumRoleSessionPort;
  return {
    session,
    flushStorageData,
    flushStore,
    onErrorOccurred,
    emitNetworkError: (details: Readonly<{
      error: string;
      resourceType: string;
      url: string;
      webContents?: object;
      webContentsId?: number;
    }>) => networkErrorListener?.(details)
  };
}

function harness(
  nativeAttachments: ChromiumGlobalWebNativeAttachmentPort | null = null,
  activeMainFrameFailures: ChromiumGlobalWebActiveMainFrameFailurePort | null =
    null
) {
  const nativeSession = fakeSession();
  const fromPath = vi.fn(() => nativeSession.session);
  const sessions = new ChromiumGlobalWebSessionRegistry(
    { fromPath } as ChromiumSessionFactoryPort,
    "darwin"
  );
  const views: FakeView[] = [];
  const preferences: Array<Record<string, unknown>> = [];
  const surfaces = new ChromiumGlobalWebSurfaceRegistry(
    sessions,
    {
      create: (options) => {
        preferences.push(options.webPreferences as unknown as Record<string, unknown>);
        const view = new FakeView(options.webPreferences.session);
        views.push(view);
        return view;
      }
    },
    nativeAttachments,
    null,
    activeMainFrameFailures
  );
  const parent = new FakeParent();
  const input = (
    surfaceId = "web-tab-1-1",
    overrides: Partial<CreateChromiumGlobalWebSurfaceInput> = {}
  ): CreateChromiumGlobalWebSurfaceInput => ({
    attemptGeneration: `attempt-${surfaceId}`,
    surfaceId,
    slotId: `slot-${surfaceId}`,
    generation: 1,
    profile: profile(),
    parent,
    url: `https://${surfaceId}.example.test/start`,
    bounds: { x: 0, y: 44, width: 640, height: 480 },
    visible: true,
    zoomFactor: 1.25,
    audioMuted: false,
    tabId: `tab-${surfaceId}`,
    windowGeneration: 2,
    windowId: `window-${surfaceId}`,
    ...overrides
  });
  return {
    surfaces,
    sessions,
    nativeSession,
    fromPath,
    views,
    preferences,
    parent,
    input
  };
}

function fakeNativeAttachments(
  beforeDetach: () => Promise<void> = async () => undefined
) {
  let ownership: ChromiumGlobalWebNativeAttachmentInput | null = null;
  const detachNonInputSurface = vi.fn(async (
    surfaceId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ) => {
    await beforeDetach();
    if (
      !ownership || ownership.surfaceId !== surfaceId ||
      ownership.generation !== generation || ownership.parent !== parent
    ) {
      throw new Error("native retirement identity mismatch");
    }
    ownership.detach();
    ownership = null;
  });
  const port: ChromiumGlobalWebNativeAttachmentPort = {
    attachNonInputSurface: async (input) => {
      input.attach();
      ownership = input;
    },
    detachNonInputSurface
  };
  return { port, detachNonInputSurface };
}

describe("Electron Chromium global Web surface registry", () => {
  it("shares one exact session while giving remote Web pages no preload bridge", async () => {
    const subject = harness();
    const first = subject.surfaces.create(subject.input("web-one"));
    const second = subject.surfaces.create(subject.input("web-two"));

    subject.views[0]!.webContents.finish("https://web-one.example.test/start");
    subject.views[1]!.webContents.finish("https://web-two.example.test/start");

    await expect(first).resolves.toMatchObject({
      surfaceId: "web-one",
      slotId: "slot-web-one",
      generation: 1,
      parentId: 1
    });
    await expect(second).resolves.toMatchObject({ surfaceId: "web-two" });
    expect(subject.fromPath).toHaveBeenCalledTimes(1);
    expect(subject.sessions.activeSurfaceCount).toBe(2);
    expect(subject.preferences).toHaveLength(2);
    expect(subject.preferences[0]).not.toHaveProperty("preload");
    expect(subject.preferences[0]).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      disableHtmlFullscreenWindowResize: true,
      devTools: false
    });
  });

  it("projects exact Chromium contained-fullscreen enter and leave events", async () => {
    const subject = harness();
    const onContainedFullscreenChange = vi.fn();
    const created = subject.surfaces.create(subject.input(
      "web-contained-fullscreen",
      { onContainedFullscreenChange }
    ));
    const contents = subject.views[0]!.webContents;
    contents.finish("https://web-contained-fullscreen.example.test/start");
    await created;

    contents.emit("enter-html-full-screen");
    contents.emit("leave-html-full-screen");

    expect(onContainedFullscreenChange.mock.calls).toEqual([[true], [false]]);
    const close = subject.surfaces.closeSurface("web-contained-fullscreen", 1);
    contents.destroy();
    await close;
    expect(contents.listeners.get("enter-html-full-screen")?.size ?? 0).toBe(0);
    expect(contents.listeners.get("leave-html-full-screen")?.size ?? 0).toBe(0);
  });

  it("denies popups, webviews, unsafe navigation, and every permission", async () => {
    const subject = harness();
    const created = subject.surfaces.create(subject.input());
    const contents = subject.views[0]!.webContents;
    contents.finish("https://web-tab-1-1.example.test/start");
    await created;

    expect(contents.windowOpenHandler?.({ url: "https://popup.test" }))
      .toEqual({ action: "deny" });
    const webviewEvent = { preventDefault: vi.fn() };
    contents.emit("will-attach-webview", webviewEvent);
    expect(webviewEvent.preventDefault).toHaveBeenCalledOnce();
    const unsafeEvent = { preventDefault: vi.fn() };
    contents.emit("will-navigate", unsafeEvent, "javascript:alert(1)");
    expect(unsafeEvent.preventDefault).toHaveBeenCalledOnce();
    const safeEvent = { preventDefault: vi.fn() };
    contents.emit("will-navigate", safeEvent, "https://allowed.test/path");
    expect(safeEvent.preventDefault).not.toHaveBeenCalled();

    const native = subject.nativeSession.session as unknown as {
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    };
    expect(native.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(native.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(native.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
    const permissionCallback = vi.fn();
    native.setPermissionRequestHandler.mock.calls[0]![0](
      {}, "geolocation", permissionCallback
    );
    expect(permissionCallback).toHaveBeenCalledWith(false);
  });

  it("reports an exact active main-frame failure but not an initial-load failure", async () => {
    const report = vi.fn();
    const initial = harness(null, { report });
    const initialCreation = initial.surfaces.create(initial.input());
    initial.views[0]!.webContents.emit(
      "did-fail-load",
      {} as never,
      -105,
      "NAME_NOT_RESOLVED",
      "https://web-tab-1-1.example.test/start",
      true,
      0,
      0
    );
    await expect(initialCreation).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_SURFACE_LOAD_FAILED"
    });
    expect(report).not.toHaveBeenCalled();

    const subject = harness(null, { report });
    const created = subject.surfaces.create(subject.input());
    const contents = subject.views[0]!.webContents;
    contents.finish("https://web-tab-1-1.example.test/start");
    await created;

    const navigation = subject.surfaces.navigate(
      "web-tab-1-1",
      1,
      "https://offline.example.test/"
    );
    contents.emit(
      "did-fail-load",
      {} as never,
      -105,
      "NAME_NOT_RESOLVED",
      "https://offline.example.test/",
      true,
      0,
      0
    );

    await expect(navigation).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_NAVIGATION_FAILED"
    });
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      attemptGeneration: "attempt-web-tab-1-1",
      errorCode: -105,
      surfaceGeneration: 1,
      surfaceId: "web-tab-1-1",
      tabId: "tab-web-tab-1-1",
      validatedUrl: "https://offline.example.test/",
      windowGeneration: 2,
      windowId: "window-web-tab-1-1"
    });
  });

  it("uses the exact loadURL rejection terminal when Electron omits the listener event", async () => {
    const report = vi.fn();
    const subject = harness(null, { report });
    const created = subject.surfaces.create(subject.input());
    const contents = subject.views[0]!.webContents;
    contents.finish("https://web-tab-1-1.example.test/start");
    await created;
    contents.loadFailure = Object.assign(new Error("connection reset"), {
      errorCode: -101
    });

    await expect(subject.surfaces.navigate(
      "web-tab-1-1",
      1,
      "https://offline.example.test/"
    )).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_NAVIGATION_FAILED"
    });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: -101,
      surfaceGeneration: 1,
      surfaceId: "web-tab-1-1",
      validatedUrl: "https://offline.example.test/"
    }));
  });

  it("reports an active main-frame Session request failure through exact WebContents", async () => {
    const report = vi.fn();
    const subject = harness(null, { report });
    const created = subject.surfaces.create(subject.input());
    const contents = subject.views[0]!.webContents;
    contents.finish("https://web-tab-1-1.example.test/start");
    await created;

    subject.nativeSession.emitNetworkError({
      error: "net::ERR_CONNECTION_RESET",
      resourceType: "mainFrame",
      url: "https://offline.example.test/",
      webContentsId: contents.id
    });

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      attemptGeneration: "attempt-web-tab-1-1",
      surfaceId: "web-tab-1-1",
      validatedUrl: "https://offline.example.test/"
    }));
  });

  it("applies bounds, visibility, zoom, audible state, and exact mute readback", async () => {
    const subject = harness();
    const created = subject.surfaces.create(subject.input());
    const view = subject.views[0]!;
    view.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;

    subject.surfaces.setBounds("web-tab-1-1", 1, {
      x: 10, y: 20, width: 800, height: 600
    });
    subject.surfaces.setVisible("web-tab-1-1", 1, false);
    subject.surfaces.setZoomFactor("web-tab-1-1", 1, 1.5);
    view.webContents.audible = true;
    subject.surfaces.setAudioMuted("web-tab-1-1", 1, true);

    expect(view.bounds.at(-1)).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    expect(view.visibility.at(-1)).toBe(false);
    expect(view.webContents.zoomFactors.at(-1)).toBe(1.5);
    expect(subject.surfaces.audioMuted("web-tab-1-1", 1)).toBe(true);
    expect(subject.surfaces.isCurrentlyAudible("web-tab-1-1", 1)).toBe(true);

    const close = subject.surfaces.closeSurface("web-tab-1-1", 1);
    expect(subject.surfaces.isCurrentlyAudible("web-tab-1-1", 1)).toBe(false);
    view.webContents.destroy();
    await close;
  });

  it("releases a shared lease only after exact destruction and flushes on the last", async () => {
    const subject = harness();
    const firstCreate = subject.surfaces.create(subject.input("web-one"));
    const secondCreate = subject.surfaces.create(subject.input("web-two"));
    subject.views[0]!.webContents.finish("https://web-one.example.test/start");
    subject.views[1]!.webContents.finish("https://web-two.example.test/start");
    await Promise.all([firstCreate, secondCreate]);

    const firstClose = subject.surfaces.closeSurface("web-one", 1);
    await vi.waitFor(() => {
      expect(subject.views[0]!.webContents.closeOptions).toHaveLength(1);
    });
    expect(subject.views[0]!.webContents.closeOptions).toEqual([
      { waitForBeforeUnload: false }
    ]);
    subject.views[0]!.webContents.destroy();
    await expect(firstClose).resolves.toBe(true);
    expect(subject.sessions.activeSurfaceCount).toBe(1);
    expect(subject.nativeSession.flushStore).not.toHaveBeenCalled();

    const secondClose = subject.surfaces.closeSurface("web-two", 1);
    subject.views[1]!.webContents.destroy();
    await expect(secondClose).resolves.toBe(true);
    expect(subject.nativeSession.flushStorageData).toHaveBeenCalledOnce();
    expect(subject.nativeSession.flushStore).toHaveBeenCalledOnce();
    expect(subject.sessions.activeSurfaceCount).toBe(0);
    expect(subject.surfaces.activeCount).toBe(0);
  });

  it("retains the exact contents owner after Electron invalidates the destroyed view getter", async () => {
    const subject = harness();
    const created = subject.surfaces.create(subject.input());
    const view = subject.views[0]!;
    const contents = view.webContents;
    contents.finish("https://web-tab-1-1.example.test/start");
    await created;

    const close = subject.surfaces.closeSurface("web-tab-1-1", 1);
    view.invalidateWebContentsAfterDestroy = true;
    contents.destroy();

    await expect(close).resolves.toBe(true);
    expect([...contents.listeners.values()].every((listeners) => listeners.size === 0))
      .toBe(true);
    expect(subject.surfaces.activeCount).toBe(0);
  });

  it("retains final ownership after a failed cookie flush and retries exactly", async () => {
    const subject = harness();
    subject.nativeSession.flushStore
      .mockRejectedValueOnce(new Error("flush unavailable"))
      .mockResolvedValueOnce(undefined);
    const created = subject.surfaces.create(subject.input());
    subject.views[0]!.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;

    const firstClose = subject.surfaces.closeSurface("web-tab-1-1", 1);
    subject.views[0]!.webContents.destroy();
    await expect(firstClose).rejects.toThrow("flush unavailable");
    expect(subject.sessions.activeSurfaceCount).toBe(1);
    expect(subject.surfaces.activeCount).toBe(1);

    await expect(subject.surfaces.closeSurface("web-tab-1-1", 1))
      .resolves.toBe(true);
    expect(subject.nativeSession.flushStore).toHaveBeenCalledTimes(2);
    expect(subject.surfaces.activeCount).toBe(0);
  });

  it("waits for AppKit retirement after a spontaneous Chromium destroy", async () => {
    const retirement = controlledPromise<void>();
    const native = fakeNativeAttachments(() => retirement.promise);
    const subject = harness(native.port);
    const created = subject.surfaces.create(subject.input());
    const view = subject.views[0]!;
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;

    view.webContents.destroy();
    const termination = subject.surfaces.closeSurface("web-tab-1-1", 1);
    await vi.waitFor(() => {
      expect(native.detachNonInputSurface).toHaveBeenCalledOnce();
    });

    expect(subject.parent.removed).toEqual([]);
    expect(subject.nativeSession.flushStorageData).not.toHaveBeenCalled();
    expect(subject.nativeSession.flushStore).not.toHaveBeenCalled();
    expect(subject.surfaces.activeCount).toBe(1);
    expect(subject.sessions.activeSurfaceCount).toBe(1);

    retirement.resolve();
    await expect(termination).resolves.toBe(true);
    expect(subject.parent.removed).toEqual([view]);
    expect(subject.nativeSession.flushStorageData).toHaveBeenCalledOnce();
    expect(subject.nativeSession.flushStore).toHaveBeenCalledOnce();
    expect(subject.surfaces.activeCount).toBe(0);
    expect(subject.sessions.activeSurfaceCount).toBe(0);
  });

  it("quarantines a spontaneously destroyed surface when AppKit retirement fails", async () => {
    const native = fakeNativeAttachments(async () => {
      throw new Error("native retirement failed");
    });
    const subject = harness(native.port);
    const created = subject.surfaces.create(subject.input());
    const view = subject.views[0]!;
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;

    view.webContents.destroy();
    await expect(subject.surfaces.closeSurface("web-tab-1-1", 1))
      .rejects.toThrow("native retirement failed");

    expect(subject.parent.removed).toEqual([]);
    expect(subject.nativeSession.flushStorageData).not.toHaveBeenCalled();
    expect(subject.nativeSession.flushStore).not.toHaveBeenCalled();
    expect(subject.surfaces.activeCount).toBe(1);
    expect(subject.sessions.activeSurfaceCount).toBe(1);
  });

  it("keeps the shared lease quarantined until failed native removal retries", async () => {
    const native = fakeNativeAttachments();
    const subject = harness(native.port);
    const created = subject.surfaces.create(subject.input());
    const view = subject.views[0]!;
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;
    subject.parent.failRemove = true;

    await expect(subject.surfaces.closeSurface("web-tab-1-1", 1))
      .rejects.toMatchObject({
        code: "ELECTRON_GLOBAL_WEB_SURFACE_NATIVE_DETACH_FAILED"
      });
    expect(native.detachNonInputSurface).toHaveBeenCalledOnce();
    expect(subject.parent.removed).toEqual([]);
    expect(view.webContents.closeOptions).toEqual([]);
    expect(subject.nativeSession.flushStorageData).not.toHaveBeenCalled();
    expect(subject.nativeSession.flushStore).not.toHaveBeenCalled();
    expect(subject.surfaces.activeCount).toBe(1);
    expect(subject.sessions.activeSurfaceCount).toBe(1);

    subject.parent.failRemove = false;
    const retry = subject.surfaces.closeSurface("web-tab-1-1", 1);
    await vi.waitFor(() => expect(view.webContents.closeOptions).toHaveLength(1));
    expect(native.detachNonInputSurface).toHaveBeenCalledTimes(2);
    expect(subject.parent.removed).toEqual([view]);
    view.webContents.destroy();
    await expect(retry).resolves.toBe(true);
    expect(subject.surfaces.activeCount).toBe(0);
    expect(subject.sessions.activeSurfaceCount).toBe(0);
  });

  it("serializes AppKit non-input attachment before navigation and retirement", async () => {
    const nativeOrder: string[] = [];
    let attachment: ChromiumGlobalWebNativeAttachmentInput | undefined;
    let resolveAttach!: () => void;
    const attachGate = new Promise<void>((resolve) => { resolveAttach = resolve; });
    const subject = harness();
    const surfaces = new ChromiumGlobalWebSurfaceRegistry(
      subject.sessions,
      {
        create: (options) => {
          const view = new FakeView(options.webPreferences.session);
          subject.views.push(view);
          return view;
        }
      },
      {
        attachNonInputSurface: (input) => {
          attachment = input;
          nativeOrder.push("attach-requested");
          return attachGate.then(() => {
            input.attach();
            nativeOrder.push("attached");
          });
        },
        detachNonInputSurface: async (_surfaceId, _generation, _parent) => {
          nativeOrder.push("detach-requested");
          attachment!.detach();
        }
      }
    );

    const created = surfaces.create(subject.input());
    expect(subject.views.at(-1)!.webContents.loadedUrls).toEqual([]);
    resolveAttach();
    await attachGate;
    await Promise.resolve();
    expect(subject.views.at(-1)!.webContents.loadedUrls).toEqual([
      "https://web-tab-1-1.example.test/start"
    ]);
    subject.views.at(-1)!.webContents.finish(
      "https://web-tab-1-1.example.test/start"
    );
    await created;

    const close = surfaces.closeSurface("web-tab-1-1", 1);
    await vi.waitFor(() => {
      expect(nativeOrder).toContain("detach-requested");
    });
    expect(nativeOrder).toEqual([
      "attach-requested", "attached", "detach-requested"
    ]);
    subject.views.at(-1)!.webContents.destroy();
    await close;
  });

  it("reparents through the AppKit FIFO and restores the old host on target failure", async () => {
    const subject = harness();
    const firstParent = subject.parent;
    const secondParent = new FakeParent(2);
    const ownership = new Map<number, ChromiumGlobalWebNativeAttachmentInput>();
    let failTarget = false;
    const surfaces = new ChromiumGlobalWebSurfaceRegistry(
      subject.sessions,
      {
        create: (options) => {
          const view = new FakeView(options.webPreferences.session);
          subject.views.push(view);
          return view;
        }
      },
      {
        attachNonInputSurface: async (input) => {
          if (failTarget && input.parent.id === secondParent.id) {
            throw new Error("target rejected");
          }
          input.attach();
          ownership.set(input.parent.id, input);
        },
        detachNonInputSurface: async (_surfaceId, _generation, parent) => {
          const input = ownership.get(parent.id)!;
          input.detach();
          ownership.delete(parent.id);
        }
      }
    );
    const created = surfaces.create(subject.input());
    subject.views.at(-1)!.webContents.finish(
      "https://web-tab-1-1.example.test/start"
    );
    await created;

    failTarget = true;
    await expect(surfaces.reparentSurface("web-tab-1-1", 1, secondParent))
      .rejects.toMatchObject({
        code: "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_FAILED"
      });
    expect(ownership.has(firstParent.id)).toBe(true);
    failTarget = false;
    await surfaces.reparentSurface("web-tab-1-1", 1, secondParent);
    expect(firstParent.removed.length).toBeGreaterThanOrEqual(2);
    expect(secondParent.added).toHaveLength(1);
    expect(ownership.has(secondParent.id)).toBe(true);
    const close = surfaces.closeSurface("web-tab-1-1", 1);
    await vi.waitFor(() => {
      expect(subject.views.at(-1)!.webContents.closeOptions).toHaveLength(1);
    });
    subject.views.at(-1)!.webContents.destroy();
    await close;
  });

  it("rejects malformed Core surface descriptors before native mutation", () => {
    const subject = harness();

    expect(() => subject.surfaces.create(subject.input("bad/id")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SURFACE_ID_INVALID"
      }));
    expect(() => subject.surfaces.create(subject.input("web-one", {
      url: "javascript:alert(1)"
    }))).toThrowError(expect.objectContaining({
      code: "ELECTRON_GLOBAL_WEB_SURFACE_URL_INVALID"
    }));
    expect(() => subject.surfaces.create(subject.input("web-one", {
      bounds: { x: 0, y: 0, width: -1, height: 10 }
    }))).toThrowError(expect.objectContaining({
      code: "ELECTRON_GLOBAL_WEB_SURFACE_BOUNDS_INVALID"
    }));
    expect(subject.fromPath).not.toHaveBeenCalled();
  });

  it("drains every exact view before the shared session and rejects new work", async () => {
    const subject = harness();
    const created = subject.surfaces.create(subject.input());
    subject.views[0]!.webContents.finish("https://web-tab-1-1.example.test/start");
    await created;

    const disposal = subject.surfaces.dispose();
    expect(() => subject.surfaces.create(subject.input("web-late")))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_GLOBAL_WEB_SURFACE_REGISTRY_DRAINING"
      }));
    subject.views[0]!.webContents.destroy();
    await disposal;
    expect(subject.surfaces.activeCount).toBe(0);
    await expect(subject.surfaces.dispose()).resolves.toBeUndefined();
  });
});
