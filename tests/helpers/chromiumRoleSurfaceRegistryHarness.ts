import { posix, win32 } from "node:path";

import type { RolePathsRecord } from "../../src/shared/generated";
import { vi } from "vitest";

import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "../../src/electron/main/chromiumRoleSessionRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "../../src/electron/main/chromiumRoleSurfacePorts";
import {
  ChromiumRoleSurfaceRegistry,
  type CreateChromiumRoleSurfaceInput
} from "../../src/electron/main/chromiumRoleSurfaceRegistry";
import type { ChromiumRoleQuickAccessShortcutPort } from
  "../../src/electron/main/chromiumRoleQuickAccessShortcut";
import type { ChromiumRoleActiveMainFrameFailurePort } from
  "../../src/electron/main/chromiumRoleNavigationFailureReporter";
import type {
  ChromiumPopupOwnerLifecyclePort,
  ChromiumWindowOpenDetails,
  ChromiumWindowOpenHandlerResponse
} from
  "../../src/electron/main/chromiumPopupPorts";

type Listener = (...arguments_: unknown[]) => unknown;

interface PromiseControl<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export function controlledPromise<Value>(): PromiseControl<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class FakeWebContents implements ChromiumRoleSurfaceWebContentsPort {
  setIgnoreMenuShortcuts = vi.fn<(ignore: boolean) => void>();
  readonly focus = vi.fn<() => void>();
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
    | ((details: ChromiumWindowOpenDetails) => ChromiumWindowOpenHandlerResponse)
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
    handler: (details: ChromiumWindowOpenDetails) => ChromiumWindowOpenHandlerResponse
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

export class FakeWebContentsView implements ChromiumRoleWebContentsViewPort {
  readonly setBackgroundColor = vi.fn<(color: string) => void>();
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

export class FakeParent implements ChromiumRoleSurfaceParentPort {
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

export function fakeSession(
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

export function rolePaths(roleId: string, platform: "darwin" | "win32" = "darwin"): RolePathsRecord {
  const path = platform === "win32" ? win32 : posix;
  const browser = path.join(platform === "win32" ? "C:/RionData/roles" : "/RionData/roles", roleId, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: path.join(browser, "system-webview"),
    webview2UserDataDir: path.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: path.join(browser, "chromium"),
    webkitDataStoreKey: `role:${roleId}:wkwebview`,
    webkitDataStoreIdentifier: roleId
  };
}

interface Harness {
  readonly registry: ChromiumRoleSurfaceRegistry;
  readonly creationFailures: ReturnType<typeof vi.fn>;
  readonly sessionRegistry: ChromiumRoleSessionRegistry;
  readonly sessionStates: FakeSessionState[];
  readonly views: FakeWebContentsView[];
  readonly preferences: unknown[];
  readonly parent: FakeParent;
  readonly fromPath: ReturnType<typeof vi.fn>;
  readonly input: (roleId?: string, overrides?: Partial<CreateChromiumRoleSurfaceInput>) =>
    CreateChromiumRoleSurfaceInput;
}

export function harness(
  createSession: () => FakeSessionState = () => fakeSession(),
  createView: (session: ChromiumRoleSessionPort) => FakeWebContentsView =
    (session) => new FakeWebContentsView(session),
  nativeAttachments: ChromiumRoleSurfaceNativeAttachmentPort | null = null,
  quickAccess: ChromiumRoleQuickAccessShortcutPort | null = null,
  navigationFailures: ChromiumRoleActiveMainFrameFailurePort | null = null,
  popups: ChromiumPopupOwnerLifecyclePort | null = null,
  extensionFactory: Pick<
    ChromiumSessionFactoryPort,
    "prepareExtensions" | "releaseExtensions" | "retireExtensionSurface" | "reparentExtensionSurface"
  > = {},
  platform: "darwin" | "win32" = "darwin"
): Harness {
  const sessionStates: FakeSessionState[] = [];
  const fromPath = vi.fn((path: string) => {
    const state = createSession();
    Object.defineProperty(state.session, "storagePath", { value: path });
    sessionStates.push(state);
    return state.session;
  });
  const sessionRegistry = new ChromiumRoleSessionRegistry(
    { ...extensionFactory, fromPath } as ChromiumSessionFactoryPort,
    platform
  );
  const views: FakeWebContentsView[] = [];
  const preferences: unknown[] = [];
  const creationFailures = vi.fn();
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
    navigationFailures,
    creationFailures
  );
  const parent = new FakeParent();
  return {
    registry,
    creationFailures,
    sessionRegistry,
    sessionStates,
    views,
    preferences,
    parent,
    fromPath,
    input: (roleId = "role-1", overrides = {}) => ({
      roleId,
      tabId: "tab-1",
      rolePaths: rolePaths(roleId, platform),
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

export function preventableEvent() {
  return { preventDefault: vi.fn<() => void>() };
}

export function fakeNativeAttachments(
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

