import { posix } from "node:path";

import type { RolePathsRecord } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { CHROMIUM_ROLE_OVERLAY_WORLD_ID } from
  "../src/electron/ipc/chromiumRoleOverlayProtocol";
import { CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL } from
  "../src/electron/ipc/chromiumRoleFontsProtocol";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "../src/electron/main/chromiumRoleSessionRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import {
  ChromiumRoleSurfaceRegistry,
  type CreateChromiumRoleSurfaceInput
} from "../src/electron/main/chromiumRoleSurfaceRegistry";
import type { ChromiumRoleQuickAccessShortcutPort } from
  "../src/electron/main/chromiumRoleQuickAccessShortcut";
import type { ChromiumRoleActiveMainFrameFailurePort } from
  "../src/electron/main/chromiumRoleNavigationFailureReporter";
import type { ChromiumPopupOwnerLifecyclePort } from
  "../src/electron/main/chromiumPopupPorts";

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
  readonly audioMutedValues: boolean[] = [];
  readonly isolatedWorldExecutions: Array<Readonly<{
    worldId: number;
    scripts: Array<Readonly<{ code: string; url?: string }>>;
    userGesture?: boolean;
  }>> = [];
  readonly listeners = new Map<keyof ChromiumRoleSurfaceEventMap, Set<Listener>>();
  readonly loadedUrls: string[] = [];
  readonly sentMessages: Array<readonly [string, ...unknown[]]> = [];
  readonly zoomFactors: number[] = [];
  readonly closeOptions: Array<{ readonly waitForBeforeUnload?: boolean } | undefined> = [];
  readonly session: ChromiumRoleSessionPort;
  mainFrame: Readonly<{ readonly frameToken: string }> = Object.freeze({
    frameToken: "frame-token-1"
  });
  currentUrl = "";
  destroyed = false;
  windowOpenHandler:
    | ((details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>)
    | null = null;
  loadResult: Promise<void> = Promise.resolve();
  currentAudioMuted = false;
  currentAudible = false;
  currentZoomFactor = 1;
  reloadCount = 0;
  isolatedWorldResult: unknown = undefined;

  constructor(session: ChromiumRoleSessionPort) {
    this.session = session;
  }

  close(options?: { readonly waitForBeforeUnload?: boolean }): void {
    this.closeOptions.push(options);
  }

  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<Readonly<{ code: string; url?: string }>>,
    userGesture?: boolean
  ): Promise<unknown> {
    this.isolatedWorldExecutions.push({ worldId, scripts, userGesture });
    return Promise.resolve(this.isolatedWorldResult);
  }

  getURL(): string {
    return this.currentUrl;
  }

  getZoomFactor(): number {
    return this.currentZoomFactor;
  }

  isAudioMuted(): boolean {
    return this.currentAudioMuted;
  }

  isCurrentlyAudible(): boolean {
    return this.currentAudible;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return this.loadResult;
  }

  reload(): void {
    this.reloadCount += 1;
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

  send(channel: string, ...arguments_: unknown[]): void {
    this.sentMessages.push([channel, ...arguments_]);
  }

  setWindowOpenHandler(
    handler: (details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>
  ): void {
    this.windowOpenHandler = handler;
  }

  setAudioMuted(muted: boolean): void {
    this.audioMutedValues.push(muted);
    this.currentAudioMuted = muted;
  }

  setZoomFactor(factor: number): void {
    this.zoomFactors.push(factor);
    this.currentZoomFactor = factor;
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

class FakeWebContentsView implements ChromiumRoleWebContentsViewPort {
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
  readonly added: ChromiumRoleWebContentsViewPort[] = [];
  readonly removed: ChromiumRoleWebContentsViewPort[] = [];
  readonly id: number;
  destroyed = false;
  failAdd = false;
  failRemove = false;
  readonly contentView = {
    addChildView: (view: ChromiumRoleWebContentsViewPort): void => {
      if (this.failAdd) throw new Error("native add rejected");
      this.added.push(view);
    },
    removeChildView: (view: ChromiumRoleWebContentsViewPort): void => {
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

interface FakeSessionState {
  readonly session: ChromiumRoleSessionPort;
  readonly flushStorageData: ReturnType<typeof vi.fn>;
  readonly flushCookies: ReturnType<typeof vi.fn>;
  readonly onErrorOccurred: ReturnType<typeof vi.fn>;
  readonly emitNetworkError: (details: Readonly<{
    resourceType: string;
    url: string;
    webContents?: object;
    webContentsId?: number;
  }>) => void;
}

function fakeSession(
  flushCookies: () => Promise<void> = async () => undefined
): FakeSessionState {
  const flushStorageData = vi.fn();
  const cookieFlush = vi.fn(flushCookies);
  let networkErrorListener: ((details: Readonly<{
    resourceType: string;
    url: string;
    webContents?: object;
    webContentsId?: number;
  }>) => void) | null = null;
  const onErrorOccurred = vi.fn((listener) => {
    networkErrorListener = listener;
  });
  const session = {
    on: vi.fn(),
    cookies: { flushStore: cookieFlush },
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
    flushCookies: cookieFlush,
    onErrorOccurred,
    emitNetworkError: (details) => networkErrorListener?.(details)
  };
}

function rolePaths(roleId: string): RolePathsRecord {
  const browser = posix.join("/RionData/roles", roleId, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: posix.join(browser, "system-webview"),
    webview2UserDataDir: posix.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: posix.join(browser, "chromium"),
    webkitDataStoreKey: `role:${roleId}:wkwebview`,
    webkitDataStoreIdentifier: roleId
  };
}

interface Harness {
  readonly registry: ChromiumRoleSurfaceRegistry;
  readonly sessionRegistry: ChromiumRoleSessionRegistry;
  readonly sessionStates: FakeSessionState[];
  readonly views: FakeWebContentsView[];
  readonly preferences: unknown[];
  readonly parent: FakeParent;
  readonly fromPath: ReturnType<typeof vi.fn>;
  readonly input: (roleId?: string, overrides?: Partial<CreateChromiumRoleSurfaceInput>) =>
    CreateChromiumRoleSurfaceInput;
}

function harness(
  createSession: () => FakeSessionState = () => fakeSession(),
  createView: (session: ChromiumRoleSessionPort) => FakeWebContentsView =
    (session) => new FakeWebContentsView(session),
  nativeAttachments: ChromiumRoleSurfaceNativeAttachmentPort | null = null,
  quickAccess: ChromiumRoleQuickAccessShortcutPort | null = null,
  navigationFailures: ChromiumRoleActiveMainFrameFailurePort | null = null,
  popups: ChromiumPopupOwnerLifecyclePort | null = null
): Harness {
  const sessionStates: FakeSessionState[] = [];
  const fromPath = vi.fn((path: string) => {
    const state = createSession();
    Object.defineProperty(state.session, "storagePath", { value: path });
    sessionStates.push(state);
    return state.session;
  });
  const sessionRegistry = new ChromiumRoleSessionRegistry(
    { fromPath } as ChromiumSessionFactoryPort,
    "darwin"
  );
  const views: FakeWebContentsView[] = [];
  const preferences: unknown[] = [];
  const viewFactory: ChromiumWebContentsViewFactoryPort = {
    create: (options) => {
      preferences.push(options.webPreferences);
      const view = createView(options.webPreferences.session);
      views.push(view);
      return view;
    }
  };
  const registry = new ChromiumRoleSurfaceRegistry(
    sessionRegistry,
    viewFactory,
    nativeAttachments,
    popups,
    quickAccess,
    navigationFailures
  );
  const parent = new FakeParent();
  return {
    registry,
    sessionRegistry,
    sessionStates,
    views,
    preferences,
    parent,
    fromPath,
    input: (roleId = "role-1", overrides = {}) => ({
      roleId,
      tabId: "tab-1",
      rolePaths: rolePaths(roleId),
      generation: 1,
      parent,
      url: "https://game.test/launch",
      preloadPath: "/Rion/app/out/preload/index.js",
      bounds: { x: 8, y: 12, width: 1280, height: 720 },
      visible: true,
      zoomFactor: 1.25,
      audioMuted: false,
      ...overrides
    })
  };
}

function preventableEvent() {
  return { preventDefault: vi.fn() };
}

function fakeNativeAttachments(
  retire: ChromiumRoleSurfaceNativeAttachmentPort["retire"]
): ChromiumRoleSurfaceNativeAttachmentPort {
  return {
    attach: async (input) => {
      input.attach();
    },
    reparent: async (input) => {
      input.detachSource();
      try {
        input.attachTarget();
      } catch (error) {
        input.restoreSource();
        throw error;
      }
    },
    retire
  };
}

describe("Electron Chromium role-surface registry", () => {
  it.each([
    ["darwin", { control: false, meta: true }],
    ["win32", { control: true, meta: false }]
  ] as const)(
    "intercepts the exact %s managed-page Quick Access chord before page delivery",
    async (platform, modifiers) => {
      const request = vi.fn();
      const onError = vi.fn();
      const subject = harness(
        undefined,
        undefined,
        null,
        { platform, request, onError }
      );
      const creation = subject.registry.create(subject.input());
      const contents = subject.views[0].webContents;
      contents.finish("https://game.test/launch");
      await creation;

      const keyDown = preventableEvent();
      contents.emit("before-input-event", keyDown, {
        alt: false,
        code: "KeyK",
        ...modifiers,
        isAutoRepeat: false,
        key: "k",
        shift: false,
        type: "keyDown"
      });
      const keyUp = preventableEvent();
      contents.emit("before-input-event", keyUp, {
        alt: false,
        code: "KeyK",
        ...modifiers,
        isAutoRepeat: false,
        key: "k",
        shift: false,
        type: "keyUp"
      });
      const repeated = preventableEvent();
      contents.emit("before-input-event", repeated, {
        alt: false,
        code: "KeyK",
        ...modifiers,
        isAutoRepeat: true,
        key: "k",
        shift: false,
        type: "keyDown"
      });
      const wrongChord = preventableEvent();
      contents.emit("before-input-event", wrongChord, {
        alt: false,
        code: "KeyK",
        control: !modifiers.control,
        meta: !modifiers.meta,
        isAutoRepeat: false,
        key: "k",
        shift: false,
        type: "keyDown"
      });

      expect(keyDown.preventDefault).toHaveBeenCalledOnce();
      expect(keyUp.preventDefault).toHaveBeenCalledOnce();
      expect(repeated.preventDefault).toHaveBeenCalledOnce();
      expect(wrongChord.preventDefault).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("tab-1");
      expect(onError).not.toHaveBeenCalled();
    }
  );

  it("owns Windows F11 above the managed page and submits only one fullscreen intent", async () => {
    const requestFullscreen = vi.fn();
    const request = vi.fn();
    const subject = harness(
      undefined,
      undefined,
      null,
      { platform: "win32", request, requestFullscreen, onError: vi.fn() }
    );
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;

    const events = [
      { type: "keyDown", isAutoRepeat: false },
      { type: "keyDown", isAutoRepeat: true },
      { type: "keyUp", isAutoRepeat: false }
    ] as const;
    const nativeEvents = events.map(() => preventableEvent());
    events.forEach((inputEvent, index) => contents.emit(
      "before-input-event",
      nativeEvents[index],
      {
        alt: false,
        code: "F11",
        control: false,
        isAutoRepeat: inputEvent.isAutoRepeat,
        key: "F11",
        meta: false,
        shift: false,
        type: inputEvent.type
      }
    ));

    expect(nativeEvents.every(
      (event) => event.preventDefault.mock.calls.length === 1
    )).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledWith("tab-1");
    expect(request).not.toHaveBeenCalled();
  });

  it("creates one secure WebContentsView and settles only from did-finish-load", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    let result: unknown;
    void creation.then((value) => { result = value; });

    await Promise.resolve();
    expect(result).toBeUndefined();
    expect(view.webContents.loadedUrls).toEqual(["https://game.test/launch"]);
    expect(subject.parent.added).toEqual([view]);
    expect(view.bounds).toEqual([{ x: 8, y: 12, width: 1280, height: 720 }]);
    expect(view.visibility).toEqual([true]);
    expect(view.webContents.zoomFactors).toEqual([1.25]);
    expect(subject.preferences[0]).toMatchObject({
      session: subject.sessionStates[0].session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: false
    });

    view.webContents.finish("https://game.test/launch");
    await expect(creation).resolves.toEqual({
      roleId: "role-1",
      generation: 1,
      parentId: 1,
      url: "https://game.test/launch"
    });
    expect(Object.isFrozen(await creation)).toBe(true);
  });

  it("publishes initial native-load commitment before resolving the surface", async () => {
    const initialLoadCommitted = vi.fn();
    const nativeAttachments = {
      ...fakeNativeAttachments(async () => undefined),
      initialLoadCommitted
    };
    const subject = harness(undefined, undefined, nativeAttachments);
    const creation = subject.registry.create(subject.input());

    subject.views[0].webContents.finish("https://game.test/launch");

    await expect(creation).resolves.toMatchObject({ roleId: "role-1" });
    expect(initialLoadCommitted).toHaveBeenCalledOnce();
    expect(initialLoadCommitted).toHaveBeenCalledWith(
      "role-1",
      1,
      subject.parent
    );
  });

  it("authorizes only the exact live main frame and its Chromium frame token", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;

    const openingIdentity = subject.registry.authorizeOverlayFrame(
      contents,
      contents.mainFrame,
      "frame-token-1"
    );
    expect(openingIdentity).toEqual({
      roleId: "role-1",
      generation: 1,
      frame: contents.mainFrame,
      frameToken: "frame-token-1",
      documentInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u)
    });
    expect(openingIdentity.documentInstanceId).not.toBe(openingIdentity.frameToken);
    expect(() => subject.registry.authorizeOverlayFrame(
      contents,
      { frameToken: "frame-token-1" },
      "frame-token-1"
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED"
    }));
    expect(() => subject.registry.authorizeOverlayFrame(
      contents,
      contents.mainFrame,
      "forged-token"
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED"
    }));
    expect(subject.registry.currentRolePreloadFrame("role-1", 1).frame)
      .toBe(contents.mainFrame);
    expect(() => subject.registry.currentOverlayFrame("role-1", 1))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SURFACE_NOT_ACTIVE"
      }));

    contents.finish("https://game.test/launch");
    await creation;
    expect(subject.registry.currentOverlayFrame("role-1", 1).frame)
      .toBe(contents.mainFrame);
    const supersededFrame = contents.mainFrame;
    contents.mainFrame = Object.freeze({ frameToken: "frame-token-2" });
    expect(subject.registry.isSupersededOverlayFrame(
      contents,
      supersededFrame,
      "frame-token-1"
    )).toBe(true);
    expect(subject.registry.isSupersededOverlayFrame(
      {},
      supersededFrame,
      "frame-token-1"
    )).toBe(false);

    const closing = subject.registry.closeRole("role-1", 1);
    expect(subject.registry.isSupersededOverlayFrame(
      contents,
      contents.mainFrame,
      contents.mainFrame.frameToken
    )).toBe(true);
    expect(() => subject.registry.authorizeOverlayFrame(
      contents,
      contents.mainFrame,
      "frame-token-1"
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED"
    }));
    contents.destroy();
    await closing;
    expect(subject.registry.isSupersededOverlayFrame(
      contents,
      contents.mainFrame,
      contents.mainFrame.frameToken
    )).toBe(true);
  });

  it("resolves trusted clicks from exact live bounds, zoom, frame, and generation", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    const frame = subject.registry.currentTrustedInputFrame("role-1", 1);

    expect(subject.registry.resolveInputSurface("role-1")).toEqual({
      roleId: "role-1",
      surfaceGeneration: 1,
      documentInstanceId: frame.documentInstanceId,
      state: "active"
    });
    expect(subject.registry.resolveTrustedInputClick({
      roleId: "role-1",
      action: {
        type: "click",
        anchor: "center",
        unit: "percent",
        x: 10,
        y: -10,
        button: "left"
      }
    }, frame)).toEqual({ clientX: 614, clientY: 230, zoomFactor: 1.25 });
    expect(subject.registry.resolveTrustedInputClick({
      roleId: "role-1",
      action: {
        type: "click",
        anchor: "bottom-right",
        unit: "reference-px",
        x: -125,
        y: -125,
        button: "right"
      }
    }, frame)).toEqual({ clientX: 924, clientY: 476, zoomFactor: 1.25 });

    contents.mainFrame = Object.freeze({ frameToken: "frame-token-2" });
    expect(() => subject.registry.resolveTrustedInputClick({
      roleId: "role-1",
      action: {
        type: "click",
        anchor: null,
        unit: "px",
        x: 1,
        y: 1,
        button: "left"
      }
    }, frame)).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_TRUSTED_INPUT_DOCUMENT_SUPERSEDED"
    }));
  });

  it.each([1, 1.25, 2])(
    "keeps slot-local CSS coordinates canonical at zoom %s",
    async (zoomFactor) => {
      const subject = harness();
      const creation = subject.registry.create(subject.input("role-1", {
        bounds: { x: 73, y: 57, width: 800, height: 600 },
        zoomFactor
      }));
      const contents = subject.views[0].webContents;
      contents.finish("https://game.test/launch");
      await creation;
      const frame = subject.registry.currentTrustedInputFrame("role-1", 1);

      expect(subject.registry.resolveTrustedInputClick({
        roleId: "role-1",
        action: {
          type: "click",
          anchor: null,
          unit: "percent",
          x: 25,
          y: 25,
          button: "left"
        }
      }, frame)).toEqual({
        clientX: Math.round(200 / zoomFactor),
        clientY: Math.round(150 / zoomFactor),
        zoomFactor
      });
    }
  );

  it("submits refresh only into world 1004 with an exact live-frame receipt", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    const expected = subject.registry.currentOverlayFrame("role-1", 1);
    const refreshId = "00000000-0000-4000-8000-000000000001";
    contents.isolatedWorldResult = Object.freeze({
      frameToken: expected.frameToken,
      refreshId,
      status: "submitted"
    });

    await expect(subject.registry.executeOverlayRefresh(expected, refreshId))
      .resolves.toEqual({
        roleId: "role-1",
        generation: 1,
        frameToken: "frame-token-1",
        refreshId,
        status: "submitted",
        worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
      });
    expect(contents.isolatedWorldExecutions).toHaveLength(1);
    expect(contents.isolatedWorldExecutions[0]).toMatchObject({
      worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID,
      userGesture: false,
      scripts: [{
        code: expect.stringContaining(`refreshFromNative(refreshId)`),
        url: "rion-studio://chromium-role-overlay-refresh.js"
      }]
    });

    contents.isolatedWorldResult = Object.freeze({
      frameToken: expected.frameToken,
      refreshId,
      status: "applied"
    });
    await expect(subject.registry.executeOverlayRefresh(expected, refreshId))
      .rejects.toMatchObject({
        code: "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED"
      });

    contents.mainFrame = Object.freeze({ frameToken: "frame-token-2" });
    await expect(subject.registry.executeOverlayRefresh(expected, refreshId))
      .rejects.toMatchObject({
        code: "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED"
      });
  });

  it("submits a font refresh only to the exact sandboxed main-frame preload", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    const expected = subject.registry.currentOverlayFrame("role-1", 1);
    const control = Object.freeze({
      frameToken: expected.frameToken,
      generation: expected.generation,
      refreshId: "00000000-0000-4000-8000-000000000002",
      roleId: expected.roleId
    });

    await expect(subject.registry.submitRoleFontsRefresh(expected, control))
      .resolves.toEqual({ ...control, status: "submitted" });
    expect(contents.sentMessages.at(-1)).toEqual([
      CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL,
      control
    ]);

    contents.mainFrame = Object.freeze({ frameToken: "frame-token-2" });
    await expect(subject.registry.submitRoleFontsRefresh(expected, control))
      .rejects.toMatchObject({
        code: "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED"
      });
    expect(contents.sentMessages).toHaveLength(1);
  });

  it("emits only authoritative document and retirement lifecycle events", async () => {
    const subject = harness();
    const events: unknown[] = [];
    const unsubscribe = subject.registry.subscribeOverlayLifecycle((event) => {
      events.push(event);
    });
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;

    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true
    });
    contents.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false
    });
    expect(events).toEqual([]);
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false
    });
    expect(events).toEqual([{
      roleId: "role-1",
      generation: 1,
      reason: "document-superseded"
    }]);

    const close = subject.registry.closeRole("role-1", 1);
    contents.destroy();
    await close;
    expect(events).toEqual([
      { roleId: "role-1", generation: 1, reason: "document-superseded" },
      { roleId: "role-1", generation: 1, reason: "surface-retired" }
    ]);
    unsubscribe();
  });

  it.each([
    "",
    "game.test",
    "https:game.test",
    " file:///tmp/game.html",
    "file:///tmp/game.html",
    "data:text/html,game",
    "javascript:alert(1)",
    "ftp://game.test",
    "https://user:secret@game.test",
    "https://game.test/path with space",
    "https:\\game.test"
  ])("rejects unsafe launch URL %j before allocating a session", (url) => {
    const subject = harness();
    expect(() => subject.registry.create(subject.input("role-1", { url })))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_ROLE_SURFACE_URL_INVALID"
      }));
    expect(subject.fromPath).not.toHaveBeenCalled();
    expect(subject.views).toHaveLength(0);
  });

  it("denies popups, embedded webviews, and non-HTTP(S) navigation", () => {
    const subject = harness();
    void subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;

    expect(contents.windowOpenHandler?.({ url: "https://popup.test" })).toEqual({
      action: "deny"
    });
    const webview = preventableEvent();
    contents.emit("will-attach-webview", webview);
    expect(webview.preventDefault).toHaveBeenCalledOnce();

    const unsafeNavigation = preventableEvent();
    contents.emit("will-navigate", unsafeNavigation, "file:///tmp/escape");
    expect(unsafeNavigation.preventDefault).toHaveBeenCalledOnce();
    const credentialRedirect = preventableEvent();
    contents.emit("will-redirect", credentialRedirect, "https://u:p@game.test", false, true, 1, 1);
    expect(credentialRedirect.preventDefault).toHaveBeenCalledOnce();
    const safeNavigation = preventableEvent();
    contents.emit("will-navigate", safeNavigation, "https://other-game.test/play");
    expect(safeNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores subframe failures and reports a sanitized main-frame failure", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    let settled = false;
    void creation.catch(() => { settled = true; });

    contents.emit(
      "did-fail-load",
      {},
      -3,
      "native secret error",
      "https://secret.example/account",
      false,
      1,
      1
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    const rejection = expect(creation).rejects.toMatchObject({
      code: "ELECTRON_ROLE_SURFACE_LOAD_FAILED",
      message: "The Chromium role surface did not finish its main-frame load."
    });
    contents.emit(
      "did-fail-load",
      {},
      -105,
      "native secret error",
      "https://secret.example/account",
      true,
      1,
      1
    );
    await rejection;
  });

  it("reports one active main-frame failure per navigation after initial load", async () => {
    const report = vi.fn();
    const subject = harness(undefined, undefined, null, null, { report });
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    expect(contents.listeners.get("did-finish-load")?.size).toBe(1);
    expect(contents.listeners.get("did-fail-load")?.size).toBe(1);

    contents.emit(
      "did-fail-load", {}, -105, "subframe failed",
      "https://game.test/frame", false, 1, 2
    );
    contents.emit(
      "did-fail-load", {}, -3, "navigation aborted",
      "https://game.test/next", true, 1, 1
    );
    expect(report).not.toHaveBeenCalled();

    contents.emit(
      "did-fail-load", {}, -105, "name not resolved",
      "https://game.test/next", true, 1, 1
    );
    contents.emit(
      "did-fail-load", {}, -105, "duplicate native event",
      "https://game.test/next", true, 1, 1
    );
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      errorCode: -105,
      roleId: "role-1",
      surfaceGeneration: 1,
      tabId: "tab-1",
      validatedUrl: "https://game.test/next"
    });

    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false
    });
    contents.emit(
      "did-fail-load", {}, -106, "connection failed",
      "https://game.test/retry", true, 1, 1
    );
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports an exact active main-frame network failure without waiting for did-fail-load", async () => {
    const report = vi.fn();
    const subject = harness(undefined, undefined, null, null, { report });
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    const session = subject.sessionStates[0]!;

    session.emitNetworkError({
      resourceType: "subFrame",
      url: "https://game.test/frame",
      webContents: contents
    });
    session.emitNetworkError({
      resourceType: "mainFrame",
      url: "https://game.test/wrong-owner",
      webContents: {}
    });
    expect(report).not.toHaveBeenCalled();

    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false
    });
    session.emitNetworkError({
      resourceType: "mainFrame",
      url: "https://game.test/offline",
      webContents: contents
    });
    contents.emit(
      "did-fail-load", {}, -105, "duplicate native failure",
      "https://game.test/offline", true, 1, 1
    );

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      errorCode: 0,
      roleId: "role-1",
      surfaceGeneration: 1,
      tabId: "tab-1",
      validatedUrl: "https://game.test/offline"
    });
  });

  it("keeps controlled reload event-bound and fences only new popup admission", async () => {
    const requestOpen = vi.fn();
    const popups: ChromiumPopupOwnerLifecyclePort = {
      requestOpen,
      retireOwner: async () => undefined,
      retireOwnerPopupsForMove: async () => undefined
    };
    const subject = harness(
      undefined,
      undefined,
      null,
      null,
      null,
      popups
    );
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;
    const events: unknown[] = [];
    subject.registry.subscribeNavigationLifecycle((event) => {
      events.push(event);
      return event.type === "page-failed";
    });

    const preparation = subject.registry.acquireControlledReloadFence(
      subject.registry.preflightControlledReload("role-1", 1),
      "reload-1"
    );
    expect(preparation).toEqual({
      documentInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      navigationSequence: 0,
      roleId: "role-1",
      surfaceGeneration: 1,
      tabId: "tab-1"
    });
    contents.windowOpenHandler?.({ url: "https://popup.test/blocked" });
    expect(requestOpen).not.toHaveBeenCalled();

    subject.registry.submitControlledReload(preparation, "reload-1");
    expect(contents.reloadCount).toBe(1);
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false
    });
    contents.mainFrame = Object.freeze({ frameToken: "frame-token-1" });
    contents.finish("https://game.test/launch");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
        generation: 1,
        navigationSequence: 1,
        previousDocumentInstanceId: preparation.documentInstanceId,
        roleId: "role-1",
        tabId: "tab-1",
        type: "document-started"
      });
    expect(events[1]).toEqual({
        documentInstanceId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        generation: 1,
        navigationSequence: 1,
        roleId: "role-1",
        tabId: "tab-1",
        type: "page-finished",
        validatedUrl: "https://game.test/launch"
      });
    const replacementDocument = (events[1] as {
      documentInstanceId: string;
    }).documentInstanceId;
    expect(replacementDocument).not.toBe(preparation.documentInstanceId);
    expect(subject.registry.releaseControlledReloadFence(
      "role-1",
      1,
      "reload-1",
      replacementDocument
    )).toBe(true);
    contents.windowOpenHandler?.({ url: "https://popup.test/admitted" });
    expect(requestOpen).toHaveBeenCalledOnce();
  });

  it("tears down the active failure listener with the exact surface", async () => {
    const report = vi.fn();
    const subject = harness(undefined, undefined, null, null, { report });
    const creation = subject.registry.create(subject.input());
    const contents = subject.views[0].webContents;
    contents.finish("https://game.test/launch");
    await creation;

    const close = subject.registry.closeRole("role-1", 1);
    contents.destroy();
    await close;
    expect(contents.listeners.get("did-fail-load")?.size ?? 0).toBe(0);
    expect(subject.sessionStates[0]?.onErrorOccurred).toHaveBeenLastCalledWith(null);
    contents.emit(
      "did-fail-load", {}, -105, "late failure",
      "https://game.test/late", true, 1, 1
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("fails closed on role, parent, and generation ownership conflicts", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    subject.views[0].webContents.finish("https://game.test/launch");
    await creation;

    expect(() => subject.registry.create(subject.input())).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SURFACE_OWNERSHIP_CONFLICT" })
    );
    expect(subject.fromPath).toHaveBeenCalledOnce();
    expect(() => subject.registry.setVisible("role-1", 2, false)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SURFACE_STALE_GENERATION" })
    );

    const conflictingParent = new FakeParent(1);
    expect(() => subject.registry.create(subject.input("role-2", {
      rolePaths: rolePaths("role-2"),
      parent: conflictingParent
    }))).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_SURFACE_PARENT_CONFLICT"
    }));

    const deadParent = new FakeParent(2);
    deadParent.destroyed = true;
    expect(() => subject.registry.create(subject.input("role-2", {
      rolePaths: rolePaths("role-2"),
      parent: deadParent
    }))).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_SURFACE_PARENT_INVALID"
    }));
  });

  it("rejects a native WebContentsView alias without reattaching or destroying it", async () => {
    let sharedView: FakeWebContentsView | undefined;
    const subject = harness(
      () => fakeSession(),
      (session) => sharedView ??= new FakeWebContentsView(session)
    );
    const first = subject.registry.create(subject.input("role-1"));
    subject.views[0].webContents.finish("https://game.test/one");
    await first;

    await expect(subject.registry.create(subject.input("role-2", {
      rolePaths: rolePaths("role-2"),
      generation: 2
    }))).rejects.toMatchObject({ code: "ELECTRON_ROLE_SURFACE_NATIVE_ALIAS" });
    expect(subject.views[1]).toBe(subject.views[0]);
    expect(subject.parent.added).toEqual([subject.views[0]]);
    expect(subject.views[0].webContents.closeOptions).toHaveLength(0);
    expect(subject.registry.activeCount).toBe(1);
    expect(subject.sessionRegistry.activeCount).toBe(1);
  });

  it("destroys an unattached session-mismatched view before releasing storage", async () => {
    const foreignSession = fakeSession().session;
    const subject = harness(
      () => fakeSession(),
      () => new FakeWebContentsView(foreignSession)
    );
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    const rejection = expect(creation).rejects.toMatchObject({
      code: "ELECTRON_ROLE_SURFACE_SESSION_MISMATCH"
    });

    expect(view.webContents.closeOptions).toEqual([{ waitForBeforeUnload: false }]);
    expect(subject.parent.added).toHaveLength(0);
    expect(subject.sessionStates[0].flushStorageData).not.toHaveBeenCalled();
    view.webContents.destroy();
    await rejection;
    expect(subject.sessionStates[0].flushStorageData).toHaveBeenCalledOnce();
    expect(subject.sessionRegistry.activeCount).toBe(0);
  });

  it("updates bounds, visibility, audio, and zoom only for the active generation", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    view.webContents.finish("https://game.test/launch");
    await creation;

    subject.registry.setBounds("role-1", 1, { x: -5, y: 20, width: 640, height: 480 });
    subject.registry.setVisible("role-1", 1, false);
    subject.registry.setAudioMuted("role-1", 1, true);
    subject.registry.setZoomFactor("role-1", 1, 2);
    view.webContents.currentAudible = true;
    expect(view.bounds.at(-1)).toEqual({ x: -5, y: 20, width: 640, height: 480 });
    expect(view.visibility.at(-1)).toBe(false);
    expect(subject.registry.audioMuted("role-1", 1)).toBe(true);
    expect(subject.registry.isCurrentlyAudible("role-1", 1)).toBe(true);
    expect(view.webContents.audioMutedValues).toEqual([false, true]);
    expect(view.webContents.zoomFactors.at(-1)).toBe(2);
    expect(() => subject.registry.setAudioMuted("role-1", 2, false)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SURFACE_STALE_GENERATION" })
    );
    expect(() => subject.registry.setZoomFactor("role-1", 1, 5.1)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SURFACE_ZOOM_INVALID" })
    );
    expect(() => subject.registry.isCurrentlyAudible("role-1", 2)).toThrowError(
      expect.objectContaining({ code: "ELECTRON_ROLE_SURFACE_STALE_GENERATION" })
    );
    const close = subject.registry.closeRole("role-1", 1);
    expect(subject.registry.isCurrentlyAudible("role-1", 1)).toBe(false);
    view.webContents.destroy();
    await close;
  });

  it("reparents one exact live generation between native AppKit hosts", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    view.webContents.finish("https://game.test/launch");
    await creation;
    const target = new FakeParent(2);

    await subject.registry.reparentRole("role-1", 1, target);

    expect(subject.parent.removed).toEqual([view]);
    expect(target.added).toEqual([view]);
    const close = subject.registry.closeRole("role-1", 1);
    view.webContents.destroy();
    await expect(close).resolves.toBe(true);
    expect(target.removed).toEqual([view]);
  });

  it("restores the exact prior AppKit parent when target attachment fails", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    view.webContents.finish("https://game.test/launch");
    await creation;
    const target = new FakeParent(2);
    target.failAdd = true;

    await expect(subject.registry.reparentRole("role-1", 1, target))
      .rejects.toEqual(expect.objectContaining({
        code: "ELECTRON_ROLE_SURFACE_REPARENT_FAILED"
      }));
    expect(subject.parent.removed).toEqual([view]);
    expect(subject.parent.added).toEqual([view, view]);
    const close = subject.registry.closeRole("role-1", 1);
    view.webContents.destroy();
    await expect(close).resolves.toBe(true);
    expect(subject.parent.removed).toEqual([view, view]);
  });

  it("waits for AppKit retirement after a spontaneous Chromium destroy", async () => {
    const retirement = controlledPromise<void>();
    const retire = vi.fn(() => retirement.promise);
    const subject = harness(
      () => fakeSession(),
      (session) => new FakeWebContentsView(session),
      fakeNativeAttachments(retire)
    );
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://game.test/launch");
    await creation;

    view.webContents.destroy();
    const termination = subject.registry.closeRole("role-1", 1);

    expect(retire).toHaveBeenCalledWith("role-1", 1, subject.parent);
    expect(subject.parent.removed).toEqual([]);
    expect(subject.sessionStates[0].flushStorageData).not.toHaveBeenCalled();
    expect(subject.sessionStates[0].flushCookies).not.toHaveBeenCalled();
    expect(subject.registry.activeCount).toBe(1);
    expect(subject.sessionRegistry.activeCount).toBe(1);

    retirement.resolve();
    await expect(termination).resolves.toBe(true);
    expect(subject.parent.removed).toEqual([view]);
    expect(subject.sessionStates[0].flushStorageData).toHaveBeenCalledOnce();
    expect(subject.registry.activeCount).toBe(0);
    expect(subject.sessionRegistry.activeCount).toBe(0);
  });

  it("quarantines a spontaneously destroyed surface when AppKit retirement fails", async () => {
    const retire = vi.fn().mockRejectedValue(new Error("native retire failed"));
    const subject = harness(
      () => fakeSession(),
      (session) => new FakeWebContentsView(session),
      fakeNativeAttachments(retire)
    );
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://game.test/launch");
    await creation;

    view.webContents.destroy();
    await expect(subject.registry.closeRole("role-1", 1))
      .rejects.toThrow("native retire failed");

    expect(subject.parent.removed).toEqual([]);
    expect(subject.sessionStates[0].flushStorageData).not.toHaveBeenCalled();
    expect(subject.sessionStates[0].flushCookies).not.toHaveBeenCalled();
    expect(subject.registry.activeCount).toBe(1);
    expect(subject.sessionRegistry.activeCount).toBe(1);
    expect(subject.registry.resolveInputSurface("role-1")).toBeNull();
  });

  it("keeps attachment and session ownership quarantined when native removal fails", async () => {
    const retire = vi.fn(async () => undefined);
    const subject = harness(
      () => fakeSession(),
      (session) => new FakeWebContentsView(session),
      fakeNativeAttachments(retire)
    );
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    await vi.waitFor(() => expect(view.webContents.loadedUrls).toHaveLength(1));
    view.webContents.finish("https://game.test/launch");
    await creation;
    subject.parent.failRemove = true;

    await expect(subject.registry.closeRole("role-1", 1)).rejects.toMatchObject({
      code: "ELECTRON_ROLE_SURFACE_NATIVE_DETACH_FAILED"
    });
    expect(retire).toHaveBeenCalledOnce();
    expect(subject.parent.removed).toEqual([]);
    expect(view.webContents.closeOptions).toEqual([]);
    expect(subject.sessionStates[0].flushStorageData).not.toHaveBeenCalled();
    expect(subject.sessionStates[0].flushCookies).not.toHaveBeenCalled();
    expect(subject.registry.activeCount).toBe(1);
    expect(subject.sessionRegistry.activeCount).toBe(1);

    subject.parent.failRemove = false;
    const retry = subject.registry.closeRole("role-1", 1);
    await vi.waitFor(() => expect(view.webContents.closeOptions).toHaveLength(1));
    expect(retire).toHaveBeenCalledOnce();
    expect(subject.parent.removed).toEqual([view]);
    view.webContents.destroy();
    await expect(retry).resolves.toBe(true);
    expect(subject.registry.activeCount).toBe(0);
    expect(subject.sessionRegistry.activeCount).toBe(0);
  });

  it("waits for destroyed and cookie flush, with one concurrent close operation", async () => {
    const cookies = controlledPromise<void>();
    const subject = harness(() => fakeSession(() => cookies.promise));
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    view.webContents.finish("https://game.test/launch");
    await creation;

    const first = subject.registry.closeRole("role-1", 1);
    const second = subject.registry.closeRole("role-1", 1);
    expect(first).toBe(second);
    expect(subject.parent.removed).toEqual([view]);
    expect(view.visibility.at(-1)).toBe(false);
    expect(view.webContents.closeOptions).toEqual([{ waitForBeforeUnload: false }]);
    expect(subject.sessionStates[0].flushStorageData).not.toHaveBeenCalled();

    view.webContents.destroy();
    await Promise.resolve();
    expect(subject.sessionStates[0].flushStorageData).toHaveBeenCalledOnce();
    expect(subject.sessionStates[0].flushCookies).toHaveBeenCalledOnce();
    expect(subject.registry.activeCount).toBe(1);
    cookies.resolve();
    await expect(first).resolves.toBe(true);
    expect(subject.registry.activeCount).toBe(0);
    await expect(subject.registry.closeRole("role-1", 1)).resolves.toBe(false);
  });

  it("retains the exact contents owner after Electron invalidates the destroyed view getter", async () => {
    const subject = harness();
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    const contents = view.webContents;
    contents.finish("https://game.test/launch");
    await creation;

    const close = subject.registry.closeRole("role-1", 1);
    view.invalidateWebContentsAfterDestroy = true;
    contents.destroy();

    await expect(close).resolves.toBe(true);
    expect([...contents.listeners.values()].every((listeners) => listeners.size === 0))
      .toBe(true);
    expect(subject.registry.activeCount).toBe(0);
  });

  it("allows an exact close retry when the cookie flush fails", async () => {
    const flushCookies = vi.fn()
      .mockRejectedValueOnce(new Error("flush failed"))
      .mockResolvedValueOnce(undefined);
    const subject = harness(() => fakeSession(flushCookies));
    const creation = subject.registry.create(subject.input());
    const view = subject.views[0];
    view.webContents.finish("https://game.test/launch");
    await creation;

    const close = subject.registry.closeRole("role-1", 1);
    view.webContents.destroy();
    await expect(close).rejects.toThrow("flush failed");
    expect(subject.registry.activeCount).toBe(1);
    await expect(subject.registry.closeRole("role-1", 1)).resolves.toBe(true);
    expect(flushCookies).toHaveBeenCalledTimes(2);
    expect(subject.registry.activeCount).toBe(0);
  });

  it("drains every native view before disposing the sole session owner", async () => {
    const subject = harness();
    const first = subject.registry.create(subject.input("role-1"));
    const second = subject.registry.create(subject.input("role-2", {
      rolePaths: rolePaths("role-2"),
      generation: 2
    }));
    subject.views[0].webContents.finish("https://game.test/one");
    subject.views[1].webContents.finish("https://game.test/two");
    await Promise.all([first, second]);

    const dispose = subject.registry.dispose();
    expect(subject.registry.dispose()).toBe(dispose);
    expect(() => subject.registry.create(subject.input("role-3", {
      rolePaths: rolePaths("role-3")
    }))).toThrowError(expect.objectContaining({
      code: "ELECTRON_ROLE_SURFACE_REGISTRY_DRAINING"
    }));
    subject.views[0].webContents.destroy();
    subject.views[1].webContents.destroy();
    await dispose;
    expect(subject.registry.activeCount).toBe(0);
    expect(subject.sessionRegistry.activeCount).toBe(0);
  });
});
