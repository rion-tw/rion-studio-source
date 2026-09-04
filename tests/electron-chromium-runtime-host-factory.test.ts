import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ChromiumPopupAdmissionRecord,
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";
import { WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL } from
  "../src/shared/windowsRuntimeHost";

import type { ChromiumRuntimeHostPort } from "../src/electron/main/chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeWindowStateObservation } from
  "../src/electron/main/chromiumRuntimeHostPorts";
import { normalizeRionBridgeError, RionBridgeError } from
  "../src/electron/ipc/errors";
import {
  buildWindowsRuntimeHostWindowOptions,
  ChromiumPlatformRuntimeHostFactory,
  WINDOWS_RUNTIME_CHROME_INSET,
  WindowsElectronChromiumRuntimeHostFactory,
  type MacosAppKitRuntimeHostFactoryPort,
  type WindowsBrowserWindowFactoryPort,
  type WindowsRuntimeForegroundProbePort,
  type WindowsRuntimeHostWindowPort
} from "../src/electron/main/chromiumRuntimeHostFactory";
import type { WindowsRuntimeShortcutOwnerPort } from
  "../src/electron/main/windowsRuntimeHostNativePorts";

type Listener = (...arguments_: unknown[]) => unknown;

class FakeSession {
  storagePath: string | null = null;
  permissionCheck: (() => false) | null = null;
  permissionRequest:
    | ((contents: unknown, permission: string, callback: (granted: false) => void) => void)
    | null = null;
  devicePermission: (() => false) | null = null;
  displayMedia:
    | ((request: unknown, callback: (streams: object) => void) => void)
    | null = null;
  bluetoothPairing:
    | ((details: unknown, callback: (response: { confirmed: false }) => void) => void)
    | null = null;

  setPermissionCheckHandler(handler: () => false): void {
    this.permissionCheck = handler;
  }

  setPermissionRequestHandler(
    handler: (
      contents: unknown,
      permission: string,
      callback: (granted: false) => void
    ) => void
  ): void {
    this.permissionRequest = handler;
  }

  setDevicePermissionHandler(handler: () => false): void {
    this.devicePermission = handler;
  }

  setDisplayMediaRequestHandler(
    handler: (request: unknown, callback: (streams: object) => void) => void
  ): void {
    this.displayMedia = handler;
  }

  setBluetoothPairingHandler(
    handler: (
      details: unknown,
      callback: (response: { confirmed: false }) => void
    ) => void
  ): void {
    this.bluetoothPairing = handler;
  }
}

class FakeWebContents {
  readonly session = new FakeSession();
  readonly listeners = new Map<string, Set<Listener>>();
  currentUrl = "";
  readonly sent: Array<readonly [string, unknown]> = [];
  windowOpenHandler:
    | ((details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>)
    | null = null;

  getURL(): string {
    return this.currentUrl;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  setWindowOpenHandler(
    handler: (details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>
  ): void {
    this.windowOpenHandler = handler;
  }

  send(channel: string, value: unknown): void {
    this.sent.push([channel, value]);
  }

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
  }
}

class FakeWindow {
  readonly webContents = new FakeWebContents();
  readonly listeners = new Map<string, Set<Listener>>();
  readonly loadedFiles: string[] = [];
  readonly contentView = {
    children: [] as unknown[],
    addChildView: vi.fn((view: unknown) => {
      this.contentView.children.push(view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const index = this.contentView.children.indexOf(view);
      if (index >= 0) this.contentView.children.splice(index, 1);
    })
  };
  readonly nativeId: number;
  closeCalls = 0;
  focusCalls = 0;
  showCalls = 0;
  showInactiveCalls = 0;
  maximizeCalls = 0;
  fullscreenValues: boolean[] = [];
  destroyed = false;
  focused = false;
  fullscreen = false;
  maximized = false;
  minimized = false;
  visible = false;
  contentBounds = { x: 100, y: 200, width: 960, height: 680 };
  liveBounds = { x: 100, y: 200, width: 960, height: 680 };
  loadResult: Promise<void> = Promise.resolve();

  constructor(id: number) {
    this.nativeId = id;
  }

  get id(): number {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.nativeId;
  }

  close(): void {
    this.closeCalls += 1;
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }

  focus(): void {
    this.focusCalls += 1;
    this.focused = true;
  }

  getBounds() {
    return { ...this.liveBounds };
  }

  getContentBounds() {
    return { ...this.contentBounds };
  }

  getNormalBounds() {
    return { ...this.contentBounds };
  }

  getNativeWindowHandle(): Buffer {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(this.nativeId));
    return handle;
  }

  hide(): void {
    this.visible = false;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    return this.focused;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isVisible(): boolean {
    return this.visible;
  }

  loadFile(path: string): Promise<void> {
    this.loadedFiles.push(path);
    this.webContents.currentUrl = pathToFileURL(path).href;
    return this.loadResult;
  }

  maximize(): void {
    this.maximizeCalls += 1;
    this.maximized = true;
  }

  minimize(): void {
    this.minimized = true;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  setFullScreen(fullscreen: boolean): void {
    this.fullscreenValues.push(fullscreen);
    this.fullscreen = fullscreen;
  }

  unmaximize(): void {
    this.maximized = false;
  }

  setBounds(bounds: typeof this.contentBounds): void {
    this.contentBounds = { ...bounds };
    this.liveBounds = { ...bounds };
  }

  show(): void {
    this.showCalls += 1;
    this.visible = true;
  }

  showInactive(): void {
    this.showInactiveCalls += 1;
    this.visible = true;
  }

  emit(event: string, ...arguments_: unknown[]): void {
    if (event === "closed") this.destroyed = true;
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
  }
}

class FakeBrowserWindows {
  readonly options: unknown[] = [];
  readonly windows: FakeWindow[] = [];
  readonly queued: FakeWindow[] = [];
  nextId = 1;

  queue(window: FakeWindow): void {
    this.queued.push(window);
  }

  readonly port: WindowsBrowserWindowFactoryPort = {
    create: (options) => {
      this.options.push(options);
      const window = this.queued.shift() ?? new FakeWindow(this.nextId++);
      this.windows.push(window);
      return window as unknown as WindowsRuntimeHostWindowPort;
    }
  };
}

class FakeRuntimeForegroundProbe implements WindowsRuntimeForegroundProbePort {
  parentWasForeground = false;
  parentVisible = false;
  parentMinimized = false;
  parentIdentity: string | null = null;
  readonly readWindowsRuntimeForeground = vi.fn((handle: Buffer) => {
    return {
      parentIdentity: this.parentIdentity ??
        handle.readBigUInt64LE().toString(16).padStart(64, "0"),
      parentWasForeground: this.parentWasForeground,
      parentVisible: this.parentVisible,
      parentMinimized: this.parentMinimized
    };
  });
}

class FakeRuntimeShortcutOwner implements WindowsRuntimeShortcutOwnerPort {
  readonly acknowledgementCalls: Array<Readonly<{
    handle: Buffer;
    ownerRevision: string;
  }>> = [];
  readonly registrations: Array<Readonly<{
    callback: () => void;
    failureCallback: (message: string) => void;
    handle: Buffer;
    ownerRevision: string;
  }>> = [];
  readonly unregisterCalls: Array<Readonly<{
    handle: Buffer;
    ownerRevision: string;
  }>> = [];

  acknowledgeWindowsRuntimeShortcutOwner(
    handle: Buffer,
    ownerRevision: string
  ) {
    this.acknowledgementCalls.push({
      handle: Buffer.from(handle),
      ownerRevision
    });
    return { ownerRevision, registered: true, uiThreadId: 17 };
  }

  registerWindowsRuntimeShortcutOwner(
    handle: Buffer,
    ownerRevision: string,
    callback: () => void,
    failureCallback: (message: string) => void
  ) {
    this.registrations.push({
      callback,
      failureCallback,
      handle: Buffer.from(handle),
      ownerRevision
    });
    return { ownerRevision, registered: true, uiThreadId: 17 };
  }

  unregisterWindowsRuntimeShortcutOwner(
    handle: Buffer,
    ownerRevision: string
  ) {
    this.unregisterCalls.push({
      handle: Buffer.from(handle),
      ownerRevision
    });
    return { ownerRevision, registered: true, uiThreadId: 17 };
  }
}

const runtimeDocumentPath = resolve("/Rion/out/renderer/runtime-windows-host.html");
const displays = {
  displayMatching: () => ({
    id: 7,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })
};

function target(
  overrides: Partial<EmbeddedLaunchTargetRecord> = {}
): EmbeddedLaunchTargetRecord {
  return {
    windowId: "window-1",
    persistedName: "Game Window 1",
    displayId: 7,
    scaleFactor: 1.5,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 100, y: 80, width: 960, height: 680 },
    presentation: "normal",
    ...overrides
  };
}

function tab(
  launchTarget: EmbeddedLaunchTargetRecord,
  overrides: Partial<EmbeddedTabEffectRecord> = {}
): EmbeddedTabEffectRecord {
  return {
    tabId: "tab-1",
    attemptGeneration: "launch-generation-1",
    sourceId: "role-1",
    name: "Role 1",
    target: launchTarget,
    workspaceAppearance: {},
    slots: [],
    roles: [],
    ...overrides
  } as EmbeddedTabEffectRecord;
}

function popupAdmission(): ChromiumPopupAdmissionRecord {
  const popupId = "10000000-0000-4000-8000-000000000001";
  const popupTarget = target({
    windowId: `popup-${popupId}`,
    persistedName: "popup.example.test",
    bounds: { x: 120, y: 100, width: 800, height: 600 }
  });
  return {
    requestId: "30000000-0000-4000-8000-000000000001",
    popupId,
    openOperationId: "20000000-0000-4000-8000-000000000001",
    lifecycleRevision: 1,
    parent: {
      ownerKind: "role",
      ownerId: "role-1",
      ownerNativeGeneration: 3,
      roleOwnerGeneration: 5,
      parentWindowId: "window-1",
      parentWindowGeneration: 1,
      parentTopologyRevision: 9,
      parentTabId: "tab-1",
      parentAttemptGeneration: "attempt-1",
      parentNativeHostId: 41
    },
    target: popupTarget,
    title: "popup.example.test",
    creationUrl: "about:blank",
    targetUrl: "https://popup.example.test/path",
    disposition: "newWindow",
    openerPolicy: "isolatedNoopener"
  };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

async function finishCreation(
  creation: Promise<ChromiumRuntimeHostPort>,
  window: FakeWindow,
  presentation: EmbeddedLaunchTargetRecord["presentation"] = "normal"
): Promise<ChromiumRuntimeHostPort> {
  window.webContents.emit("did-finish-load");
  window.emit("ready-to-show");
  if (presentation === "maximized") window.emit("maximize");
  if (presentation === "fullscreen") window.emit("enter-full-screen");
  return creation;
}

async function applyWindowFence(
  host: ChromiumRuntimeHostPort,
  windowGeneration = 4,
  topologyRevision = 9
): Promise<void> {
  await host.applyWindowsChromeProjection?.({
    activeTabId: "tab-1",
    contentBounds: { x: 0, y: 40, width: 960, height: 640 },
    moveTargets: [],
    tabs: [{
      active: true,
      hidden: false,
      name: "Role 1",
      phase: "ready",
      tabId: "tab-1"
    }],
    topologyRevision,
    windowGeneration,
    workspaceDividers: [],
    windowId: "window-1"
  });
}

function preventableEvent() {
  return { preventDefault: vi.fn() };
}

const invalidRequestCases: Array<[
  name: string,
  buildTab: (target: EmbeddedLaunchTargetRecord) => EmbeddedTabEffectRecord,
  targetOverride?: Partial<EmbeddedLaunchTargetRecord>
]> = [
  ["missing generation", (value) => tab(value, { attemptGeneration: undefined })],
  ["mismatched target", () => tab(target({ windowId: "window-2" }))],
  ["small bounds", (value) => tab(value), {
    bounds: { x: 0, y: 0, width: 639, height: 480 }
  }],
  ["outside work area", (value) => tab(value), {
    bounds: { x: 1500, y: 0, width: 640, height: 480 }
  }],
  ["invalid scale", (value) => tab(value), { scaleFactor: 0 }]
];

describe("Windows Electron Chromium runtime-host factory", () => {
  it("rejects a legacy runtime-host document name before native creation", () => {
    const browserWindows = new FakeBrowserWindows();

    expect(() => new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      resolve("/Rion/out/renderer/runtime-window.html"),
      displays
    )).toThrowError(expect.objectContaining({
      code: "ELECTRON_RUNTIME_HOST_DOCUMENT_INVALID"
    }));
    expect(browserWindows.windows).toHaveLength(0);
  });

  it("requires exact Win32 foreground before reporting Electron focus", async () => {
    const browserWindows = new FakeBrowserWindows();
    const foreground = new FakeRuntimeForegroundProbe();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      lifecycleEpoch: () => 3,
      runtimeDocumentPath,
      runtimeForegroundProbe: foreground
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    window.visible = true;
    window.focused = true;
    foreground.parentVisible = true;

    expect(host.readRuntimeWindowState?.()).toEqual({
      platform: "windows",
      source: "initial",
      sequence: 1,
      lifecycleEpoch: 3,
      logicalWindowId: "window-1",
      nativeHostId: window.id,
      nativeGeneration: 1,
      windowGeneration: 4,
      topologyRevision: 9,
      visible: true,
      minimized: false,
      focused: false,
      foreground: false
    });

    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    const unsubscribe = host.bindRuntimeWindowState?.((observation) => {
      observations.push(observation);
    });
    host.showInactive?.();
    expect(window.showInactiveCalls).toBe(1);
    expect(window.focusCalls).toBe(0);
    expect(observations).toEqual([]);

    foreground.parentWasForeground = true;
    window.emit("focus");
    expect(observations).toEqual([expect.objectContaining({
      source: "focus",
      sequence: 2,
      visible: true,
      minimized: false,
      focused: true,
      foreground: true
    })]);
    unsubscribe?.();
    unsubscribe?.();
    window.focused = false;
    foreground.parentWasForeground = false;
    window.emit("blur");
    expect(observations).toHaveLength(1);
  });

  it("owns physical Windows F11 on the exact native runtime host", async () => {
    const browserWindows = new FakeBrowserWindows();
    const shortcutOwner = new FakeRuntimeShortcutOwner();
    const foreground = new FakeRuntimeForegroundProbe();
    const requestFullscreen = vi.fn();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      onRuntimeTabFullscreen: requestFullscreen,
      runtimeForegroundProbe: foreground,
      runtimeDocumentPath,
      runtimeShortcutOwner: shortcutOwner
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    expect(shortcutOwner.registrations).toHaveLength(1);
    expect(shortcutOwner.registrations[0]).toMatchObject({ ownerRevision: "1" });
    expect(shortcutOwner.registrations[0]?.handle.readBigUInt64LE()).toBe(1n);

    foreground.parentVisible = true;
    foreground.parentWasForeground = true;
    window.visible = true;
    window.focused = true;
    shortcutOwner.registrations[0]?.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledWith(
      "tab-1",
      "windows-native-foreground"
    );
    expect(shortcutOwner.acknowledgementCalls).toHaveLength(1);
    const close = host.close();
    expect(shortcutOwner.unregisterCalls).toHaveLength(1);
    expect(shortcutOwner.unregisterCalls[0]).toMatchObject({ ownerRevision: "1" });
    expect(shortcutOwner.unregisterCalls[0]?.handle.readBigUInt64LE()).toBe(1n);
    window.emit("closed");
    await close;
    shortcutOwner.registrations[0]?.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shortcutOwner.acknowledgementCalls).toHaveLength(1);
  });

  it("carries exact native F11 foreground admission into Core", async () => {
    const browserWindows = new FakeBrowserWindows();
    const shortcutOwner = new FakeRuntimeShortcutOwner();
    const requestFullscreen = vi.fn();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      onRuntimeTabFullscreen: requestFullscreen,
      runtimeDocumentPath,
      runtimeShortcutOwner: shortcutOwner
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    shortcutOwner.registrations[0]?.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledWith(
      "tab-1",
      "windows-native-foreground"
    );
    expect(shortcutOwner.acknowledgementCalls).toEqual([{
      handle: expect.any(Buffer),
      ownerRevision: "1"
    }]);
  });

  it("retains WebContents F11 suppression as a delivery fallback", async () => {
    const browserWindows = new FakeBrowserWindows();
    const requestFullscreen = vi.fn();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      onRuntimeTabFullscreen: requestFullscreen,
      runtimeDocumentPath
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    const events = [
      { type: "keyDown", isAutoRepeat: false },
      { type: "keyDown", isAutoRepeat: true },
      { type: "keyUp", isAutoRepeat: false }
    ] as const;
    const nativeEvents = events.map(() => preventableEvent());
    events.forEach((input, index) => window.webContents.emit(
      "before-input-event",
      nativeEvents[index],
      {
        alt: false,
        code: "",
        control: false,
        isAutoRepeat: input.isAutoRepeat,
        key: "F11",
        meta: false,
        shift: false,
        type: input.type
      }
    ));
    const wrongKey = preventableEvent();
    window.webContents.emit("before-input-event", wrongKey, {
      alt: false,
      code: "F10",
      control: false,
      isAutoRepeat: false,
      key: "F10",
      meta: false,
      shift: false,
      type: "keyDown"
    });

    expect(nativeEvents.every(
      (event) => event.preventDefault.mock.calls.length === 1
    )).toBe(true);
    expect(wrongKey.preventDefault).not.toHaveBeenCalled();
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).toHaveBeenCalledWith("tab-1");
  });

  it("streams exact native state events and retires observers before replacement", async () => {
    const browserWindows = new FakeBrowserWindows();
    const foreground = new FakeRuntimeForegroundProbe();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      runtimeDocumentPath,
      runtimeForegroundProbe: foreground
    });
    const launchTarget = target();
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    const unsubscribe = host.bindRuntimeWindowState?.((observation) => {
      observations.push(observation);
    });
    expect(host.readRuntimeWindowState?.().sequence).toBe(1);

    foreground.parentVisible = true;
    window.visible = true;
    window.emit("show");
    foreground.parentWasForeground = true;
    window.focused = true;
    window.emit("focus");
    foreground.parentWasForeground = false;
    window.focused = false;
    window.emit("blur");
    foreground.parentMinimized = true;
    window.minimized = true;
    window.emit("minimize");
    foreground.parentMinimized = false;
    window.minimized = false;
    window.emit("restore");
    foreground.parentVisible = false;
    window.visible = false;
    window.emit("hide");

    const close = host.close();
    window.emit("closed");
    await close;
    expect(observations.map(({ source, sequence }) => [source, sequence])).toEqual([
      ["show", 2],
      ["focus", 3],
      ["blur", 4],
      ["minimize", 5],
      ["restore", 6],
      ["hide", 7],
      ["closed", 8]
    ]);
    expect(observations.at(-1)).toMatchObject({
      visible: false,
      minimized: false,
      focused: false,
      foreground: false
    });
    unsubscribe?.();

    const replacement = new FakeWindow(window.nativeId);
    browserWindows.queue(replacement);
    const replacementCreation = factory.create(launchTarget, tab(launchTarget, {
      attemptGeneration: "launch-generation-2"
    }));
    const replacementHost = await finishCreation(replacementCreation, replacement);
    await applyWindowFence(replacementHost, 5, 10);
    const replacementObservations: ChromiumRuntimeWindowStateObservation[] = [];
    replacementHost.bindRuntimeWindowState?.((observation) => {
      replacementObservations.push(observation);
    });
    expect(replacementHost.readRuntimeWindowState?.()).toMatchObject({
      sequence: 1,
      nativeGeneration: 2,
      windowGeneration: 5,
      topologyRevision: 10
    });
    window.emit("show");
    expect(replacementObservations).toEqual([]);
    foreground.parentVisible = true;
    replacement.visible = true;
    replacement.emit("show");
    expect(replacementObservations).toEqual([
      expect.objectContaining({ source: "show", sequence: 2 })
    ]);
  });

  it.each(["unresponsive", "render-process-gone"] as const)(
    "terminalizes the exact state stream when the host reports %s",
    async (failureEvent) => {
      const browserWindows = new FakeBrowserWindows();
      const foreground = new FakeRuntimeForegroundProbe();
      const factory = new ChromiumPlatformRuntimeHostFactory({
        platform: "win32",
        browserWindows: browserWindows.port,
        displays,
        runtimeDocumentPath,
        runtimeForegroundProbe: foreground
      });
      const creation = factory.create(target(), tab(target()));
      const window = browserWindows.windows[0]!;
      const host = await finishCreation(creation, window);
      await applyWindowFence(host);
      const observations: ChromiumRuntimeWindowStateObservation[] = [];
      host.bindRuntimeWindowState?.((observation) => observations.push(observation));
      host.readRuntimeWindowState?.();

      if (failureEvent === "render-process-gone") {
        window.webContents.emit(failureEvent, {}, {});
      } else {
        window.emit(failureEvent);
      }
      expect(observations).toEqual([expect.objectContaining({
        source: "failed",
        sequence: 2,
        failureCode: failureEvent === "render-process-gone"
          ? "ELECTRON_RUNTIME_HOST_RENDERER_GONE"
          : "ELECTRON_RUNTIME_HOST_UNRESPONSIVE"
      })]);
      window.emit("focus");
      expect(observations).toHaveLength(1);
    }
  );

  it("terminalizes a malformed foreground identity as stream failure", async () => {
    const browserWindows = new FakeBrowserWindows();
    const foreground = new FakeRuntimeForegroundProbe();
    const onError = vi.fn();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      onError,
      runtimeDocumentPath,
      runtimeForegroundProbe: foreground
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    host.bindRuntimeWindowState?.((observation) => observations.push(observation));
    host.readRuntimeWindowState?.();
    foreground.parentIdentity = "not-an-opaque-native-identity";

    window.emit("show");
    expect(observations).toEqual([expect.objectContaining({
      source: "failed",
      sequence: 2,
      failureCode: "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_FAILED"
    })]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_FAILED"
    }));
  });

  it("publishes cached stream failure before close when live fences cannot be read", async () => {
    const browserWindows = new FakeBrowserWindows();
    const foreground = new FakeRuntimeForegroundProbe();
    const onError = vi.fn();
    let lifecycleReadable = true;
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      lifecycleEpoch: () => {
        if (!lifecycleReadable) throw new Error("lifecycle unavailable");
        return 3;
      },
      onError,
      runtimeDocumentPath,
      runtimeForegroundProbe: foreground
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    host.bindRuntimeWindowState?.((observation) => observations.push(observation));
    host.readRuntimeWindowState?.();
    lifecycleReadable = false;

    const close = host.close();
    window.emit("closed");
    await close;
    expect(observations).toEqual([expect.objectContaining({
      source: "failed",
      sequence: 2,
      lifecycleEpoch: 3,
      windowGeneration: 4,
      topologyRevision: 9,
      failureCode: "ELECTRON_WINDOWS_RUNTIME_WINDOW_STATE_STREAM_FAILED"
    })]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "lifecycle unavailable"
    }));
  });

  it("publishes one Reload rejection without holding later tab commands", async () => {
    const browserWindows = new FakeBrowserWindows();
    const onError = vi.fn();
    let tabControlError: RionBridgeError | null = null;
    let windowControlError: RionBridgeError | null = null;
    const onTabControl = vi.fn(async () => {
      if (tabControlError) throw tabControlError;
    });
    const onWindowControl = vi.fn(async () => {
      if (windowControlError) throw windowControlError;
    });
    let rejectReload!: (error: unknown) => void;
    const onTabReload = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectReload = reject;
    }));
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      lifecycleEpoch: () => 3,
      onError: (error) => onError(normalizeRionBridgeError(
        error,
        "ELECTRON_WINDOWS_RUNTIME_COMMAND_FAILED"
      )),
      onTabControl,
      onTabReload,
      onWindowControl,
      runtimeDocumentPath
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await host.applyWindowsChromeProjection!({
      activeTabId: "tab-1",
      contentBounds: { x: 0, y: 40, width: 960, height: 640 },
      moveTargets: [],
      tabs: [{
        active: true,
        hidden: false,
        name: "Role 1",
        phase: "ready",
        tabId: "tab-1"
      }],
      topologyRevision: 9,
      windowGeneration: 4,
      windowId: "window-1",
      workspaceDividers: []
    });
    const projection = window.webContents.sent.at(-1)![1] as {
      projectionRevision: number;
    };
    window.webContents.emit("ipc-message", {}, WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL, {
      lifecycleEpoch: 3,
      projectionRevision: projection.projectionRevision,
      tabId: "tab-1",
      topologyRevision: 9,
      type: "reloadTab",
      windowGeneration: 4,
      windowId: "window-1"
    });
    await vi.waitFor(() => expect(onTabReload).toHaveBeenCalledOnce());
    window.webContents.emit("ipc-message", {}, WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL, {
      projectionRevision: projection.projectionRevision,
      tabId: "tab-1",
      type: "closeTab",
      windowId: "window-1"
    });
    await vi.waitFor(() => expect(onTabControl).toHaveBeenCalledOnce());

    rejectReload(new RionBridgeError({
      code: "CORE_RELOAD_INDETERMINATE",
      message: "Core reload became indeterminate"
    }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenLastCalledWith({
      code: "CORE_RELOAD_INDETERMINATE",
      message: "Core reload became indeterminate"
    });

    tabControlError = new RionBridgeError({
      code: "CORE_TAB_CLOSE_REJECTED",
      message: "Core rejected tab close"
    });
    const afterReload = window.webContents.sent.at(-1)![1] as {
      projectionRevision: number;
    };
    window.webContents.emit("ipc-message", {}, WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL, {
      projectionRevision: afterReload.projectionRevision,
      tabId: "tab-1",
      type: "closeTab",
      windowId: "window-1"
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenLastCalledWith({
      code: "CORE_TAB_CLOSE_REJECTED",
      message: "Core rejected tab close"
    });

    windowControlError = new RionBridgeError({
      code: "CORE_WINDOW_CLOSE_REJECTED",
      message: "Core rejected window close"
    });
    const afterTab = window.webContents.sent.at(-1)![1] as {
      projectionRevision: number;
    };
    window.webContents.emit("ipc-message", {}, WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL, {
      projectionRevision: afterTab.projectionRevision,
      type: "closeWindow",
      windowId: "window-1"
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3));
    expect(onError).toHaveBeenLastCalledWith({
      code: "CORE_WINDOW_CLOSE_REJECTED",
      message: "Core rejected window close"
    });
  });

  it("resolves only the exact active logical host to its native owner generation", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      runtimeDocumentPath
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);

    expect(factory.resolveWindowsInputParent(host)).toEqual({
      identity: { nativeGeneration: 1, ownerRevision: "1" },
      logicalParent: host,
      window
    });
    expect(factory.resolveWindowsInputParent({
      id: host.id,
      contentView: host.contentView,
      isDestroyed: host.isDestroyed
    })).toBeNull();

    const close = host.close();
    window.emit("closed");
    await close;
    expect(factory.resolveWindowsInputParent(host)).toBeNull();
  });

  it("publishes move and resize through exact native placement readback", async () => {
    const browserWindows = new FakeBrowserWindows();
    const observations: unknown[] = [];
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "win32",
      browserWindows: browserWindows.port,
      displays,
      runtimeDocumentPath,
      onRuntimeWindowPlacement: async (current) => {
        observations.push(current.readRuntimeWindowPlacement?.());
      }
    });
    const creation = factory.create(target(), tab(target()));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await host.applyWindowsChromeProjection?.({
      activeTabId: "tab-1",
      contentBounds: { x: 0, y: 40, width: 960, height: 640 },
      moveTargets: [],
      tabs: [{
        active: true,
        hidden: false,
        name: "Role 1",
        phase: "ready",
        tabId: "tab-1"
      }],
      topologyRevision: 9,
      windowGeneration: 4,
      workspaceDividers: [],
      windowId: "window-1"
    });

    window.contentBounds = { x: 140, y: 110, width: 1000, height: 720 };
    window.liveBounds = { ...window.contentBounds };
    window.emit("move");
    await vi.waitFor(() => expect(observations).toHaveLength(1));

    expect(observations[0]).toEqual({
      nativeHostId: window.id,
      nativeGeneration: 1,
      windowId: "window-1",
      windowGeneration: 4,
      topologyRevision: 9,
      displayId: 7,
      normalBounds: { x: 140, y: 110, width: 1000, height: 720 },
      savedWorkArea: { x: 0, y: 0, width: 1920, height: 1080 },
      presentation: "normal"
    });
  });

  it("projects a hidden popup host and binds exact close/layout receipts", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.createPopup(popupAdmission());
    const window = browserWindows.windows[0]!;
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    const created = await creation;
    expect(created.receipt).toEqual({
      platform: "windows",
      nativeHostId: window.id,
      logicalWindowId: popupAdmission().target.windowId,
      windowGeneration: 1,
      topologyRevision: 1
    });
    expect(created.host.isVisible()).toBe(false);
    const observer = {
      closeRequested: vi.fn(),
      closed: vi.fn(),
      layoutChanged: vi.fn()
    };
    created.host.bindPopupLifecycle?.(observer);
    const closeEvent = preventableEvent();
    window.emit("close", closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(observer.closeRequested).toHaveBeenCalledOnce();
    window.emit("resize");
    expect(observer.layoutChanged).toHaveBeenCalledWith({
      x: 0,
      y: WINDOWS_RUNTIME_CHROME_INSET,
      width: 960,
      height: 640
    });
    const close = created.host.close();
    window.emit("closed");
    await close;
    expect(observer.closed).toHaveBeenCalledOnce();
  });

  it("creates an invisible empty host from exact Core provision fences", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 4,
      topologyRevision: 9
    });
    const window = browserWindows.windows[0]!;

    const host = await finishCreation(creation, window);

    expect(host.logicalWindowId).toBe("window-1");
    expect(host.isVisible()).toBe(false);
    expect(window.showCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
  });

  it("rejects malformed empty-host Core fences before native creation", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );

    expect(() => factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1",
      windowGeneration: 0,
      topologyRevision: 1
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_RUNTIME_HOST_CORE_FENCE_MISSING"
    }));
    expect(browserWindows.windows).toHaveLength(0);
  });

  it("builds a secure frameless Mica host at exact Rust DIP bounds", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];

    expect(browserWindows.options[0]).toEqual(buildWindowsRuntimeHostWindowOptions(
      launchTarget,
      resolve("/Rion/out/preload/runtimeWindowsHost.cjs")
    ));
    expect(browserWindows.options[0]).toMatchObject({
      title: "Game Window 1",
      x: 100,
      y: 80,
      width: 960,
      height: 680,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundMaterial: "mica",
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        devTools: false,
        javascript: true,
        partition: "rion-runtime-shell",
        preload: resolve("/Rion/out/preload/runtimeWindowsHost.cjs")
      }
    });
    expect(window.loadedFiles).toEqual([runtimeDocumentPath]);

    await expectPending(creation);
    window.webContents.emit("did-finish-load");
    await expectPending(creation);
    window.emit("ready-to-show");
    const host = await creation;
    expect(host.logicalWindowId).toBe("window-1");
    expect(host.id).toBe(window.id);
    expect(host.readProjection()).toEqual({
      displayId: 7,
      bounds: { x: 100, y: 200, width: 960, height: 680 },
      visible: false,
      focused: false,
      presentation: "normal"
    });
    expect(window.showCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
  });

  it("installs deny-by-default popup, navigation, webview, and permission policy", () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    void factory.create(launchTarget, tab(launchTarget));
    const contents = browserWindows.windows[0].webContents;

    expect(contents.windowOpenHandler?.({ url: "https://popup.test" })).toEqual({
      action: "deny"
    });
    for (const eventName of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      const event = preventableEvent();
      contents.emit(eventName, event, "https://navigation.test", false, true, 1, 1);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(contents.session.permissionCheck?.()).toBe(false);
    const permission = vi.fn();
    contents.session.permissionRequest?.({}, "notifications", permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(contents.session.devicePermission?.()).toBe(false);
    const display = vi.fn();
    contents.session.displayMedia?.({}, display);
    expect(display).toHaveBeenCalledWith({});
    const bluetooth = vi.fn();
    contents.session.bluetoothPairing?.({}, bluetooth);
    expect(bluetooth).toHaveBeenCalledWith({ confirmed: false });
  });

  it("fails closed when Electron aliases the local shell to persistent storage", async () => {
    const browserWindows = new FakeBrowserWindows();
    const window = new FakeWindow(44);
    window.webContents.session.storagePath = "/persistent/runtime-shell";
    browserWindows.queue(window);
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(target(), tab(target()));
    const rejection = expect(creation).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_SESSION_PERSISTENT"
    });

    expect(window.closeCalls).toBe(1);
    window.emit("closed");
    await rejection;
  });

  it("falls back to the repository's opaque Windows host when Mica creation fails", () => {
    const options: unknown[] = [];
    const window = new FakeWindow(9);
    const create = vi.fn((value: unknown) => {
      options.push(value);
      if (options.length === 1) throw new Error("Mica is unavailable");
      return window as unknown as WindowsRuntimeHostWindowPort;
    });
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      { create },
      runtimeDocumentPath,
      displays
    );
    void factory.create(launchTarget, tab(launchTarget));

    expect(create).toHaveBeenCalledTimes(2);
    expect(options[1]).toMatchObject({
      frame: false,
      transparent: false,
      backgroundColor: "#111318",
      backgroundMaterial: "none"
    });
  });

  it.each([
    ["maximized" as const, "maximize" as const],
    ["fullscreen" as const, "enter-full-screen" as const]
  ])("waits for exact %s presentation acknowledgement", async (presentation, event) => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target({ presentation });
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];

    expect(window.maximizeCalls).toBe(presentation === "maximized" ? 1 : 0);
    expect(window.fullscreenValues).toEqual(
      presentation === "fullscreen" ? [true] : []
    );
    window.webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    await expectPending(creation);
    window.emit(event);
    await expect(creation).resolves.toMatchObject({ logicalWindowId: "window-1" });
  });

  it("ignores loadFile Promise completion and subframe failures", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];

    await Promise.resolve();
    await expectPending(creation);
    window.webContents.emit(
      "did-fail-load",
      {},
      -3,
      "native subframe error",
      "https://secret.example",
      false,
      1,
      1
    );
    await expectPending(creation);
    await finishCreation(creation, window);
  });

  it("classifies a main-frame load failure and closes before rejecting", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];
    const rejection = expect(creation).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_LOAD_FAILED",
      message: "The packaged Windows runtime-host document failed to load."
    });

    window.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "native secret failure",
      "file:///secret/location.html",
      true,
      1,
      1
    );
    expect(window.closeCalls).toBe(1);
    await expectPending(creation);
    window.emit("closed");
    await rejection;
  });

  it("uses the exact closed event for one idempotent close operation", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];
    const host = await finishCreation(creation, window);
    const retainedNativeId = window.id;

    const first = host.close();
    const second = host.close();
    expect(first).toBe(second);
    expect(window.closeCalls).toBe(1);
    await expectPending(first);
    window.emit("closed");
    await expect(first).resolves.toBeUndefined();
    expect(host.isDestroyed()).toBe(true);
    expect(() => host.show()).toThrowError(expect.objectContaining({
      code: "ELECTRON_RUNTIME_HOST_STALE_GENERATION"
    }));

    const replacement = new FakeWindow(retainedNativeId);
    browserWindows.queue(replacement);
    const replacementCreation = factory.create(launchTarget, tab(launchTarget, {
      attemptGeneration: "launch-generation-2"
    }));
    const replacementHost = await finishCreation(replacementCreation, replacement);
    window.emit("closed");
    replacementHost.show();
    expect(replacement.showCalls).toBe(1);
  });

  it("rejects did-finish-load from any document except the exact packaged host", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0];
    const rejection = expect(creation).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_DOCUMENT_MISMATCH"
    });

    window.webContents.currentUrl = "file:///Rion/out/renderer/index.html";
    window.webContents.emit("did-finish-load");
    expect(window.closeCalls).toBe(1);
    window.emit("closed");
    await rejection;
  });

  it("returns exact live DIP content bounds below the 40px runtime chrome", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const creation = factory.create(launchTarget, tab(launchTarget));
    const host = await finishCreation(creation, browserWindows.windows[0]);

    expect(WINDOWS_RUNTIME_CHROME_INSET).toBe(40);
    expect(host.getContentBounds()).toEqual({
      x: 0,
      y: 40,
      width: 960,
      height: 640
    });
  });

  it("resolves a maximized or fullscreen display from live bounds while retaining normal bounds", async () => {
    for (const presentation of ["maximized", "fullscreen"] as const) {
      const browserWindows = new FakeBrowserWindows();
      const launchTarget = target({ presentation });
      const matchedBounds: Array<Readonly<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>> = [];
      const factory = new WindowsElectronChromiumRuntimeHostFactory(
        browserWindows.port,
        runtimeDocumentPath,
        {
          displayMatching: (bounds) => {
            matchedBounds.push({ ...bounds });
            return {
              id: bounds.x >= 1920 ? 8 : 7,
              workArea: bounds.x >= 1920
                ? { x: 1920, y: 0, width: 2560, height: 1440 }
                : { x: 0, y: 0, width: 1920, height: 1080 }
            };
          }
        }
      );
      const creation = factory.create(launchTarget, tab(launchTarget));
      const window = browserWindows.windows[0];
      window.contentBounds = { x: 100, y: 80, width: 960, height: 680 };
      window.liveBounds = { x: 1920, y: 0, width: 2560, height: 1440 };
      const host = await finishCreation(creation, window, presentation);

      expect(host.readProjection()).toEqual({
        displayId: 8,
        bounds: { x: 100, y: 80, width: 960, height: 680 },
        visible: false,
        focused: false,
        presentation
      });
      expect(matchedBounds).toEqual([
        { x: 1920, y: 0, width: 2560, height: 1440 }
      ]);
    }
  });

  it("fences logical-window and native-window identity conflicts", async () => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target();
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );
    const firstCreation = factory.create(launchTarget, tab(launchTarget));
    await finishCreation(firstCreation, browserWindows.windows[0]);
    expect(() => factory.create(launchTarget, tab(launchTarget))).toThrowError(
      expect.objectContaining({ code: "ELECTRON_RUNTIME_HOST_OWNERSHIP_CONFLICT" })
    );

    const alias = new FakeWindow(browserWindows.windows[0].id);
    browserWindows.queue(alias);
    const secondTarget = target({ windowId: "window-2" });
    const aliasCreation = factory.create(secondTarget, tab(secondTarget, {
      tabId: "tab-2",
      attemptGeneration: "launch-generation-2"
    }));
    const rejection = expect(aliasCreation).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_NATIVE_ALIAS"
    });
    expect(alias.closeCalls).toBe(1);
    alias.emit("closed");
    await rejection;
    expect(browserWindows.windows[0].destroyed).toBe(false);
  });

  it.each(invalidRequestCases)("rejects %s before BrowserWindow creation", (
    _name: string,
    buildTab: (target: EmbeddedLaunchTargetRecord) => EmbeddedTabEffectRecord,
    targetOverride: Partial<EmbeddedLaunchTargetRecord> = {}
  ) => {
    const browserWindows = new FakeBrowserWindows();
    const launchTarget = target(targetOverride);
    const factory = new WindowsElectronChromiumRuntimeHostFactory(
      browserWindows.port,
      runtimeDocumentPath,
      displays
    );

    expect(() => factory.create(launchTarget, buildTab(launchTarget))).toThrow();
    expect(browserWindows.windows).toHaveLength(0);
  });

  it("bundles a CSP-confined, local-only Windows host document with native controls", async () => {
    const document = await readFile("src/renderer/runtime-windows-host.html", "utf8");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("script-src 'self'");
    expect(document).toContain("runtime-windows-host.css");
    expect(document).toContain("runtime-windows-host.ts");
    expect(document).toContain('data-window-command="minimizeWindow"');
    expect(document).toContain('data-window-command="toggleMaximizeWindow"');
    expect(document).toContain('data-window-command="closeWindow"');
  });
});

describe("macOS AppKit runtime-host boundary", () => {
  it("fails closed without a Rust/N-API AppKit adapter", async () => {
    const launchTarget = target();
    const factory = new ChromiumPlatformRuntimeHostFactory({ platform: "darwin" });
    await expect(factory.create(launchTarget, tab(launchTarget))).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE"
    });
  });

  it("delegates to the branded AppKit adapter without constructing BrowserWindow", async () => {
    const launchTarget = target();
    const appKitHost: ChromiumRuntimeHostPort = {
      id: 81,
      logicalWindowId: launchTarget.windowId,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      close: vi.fn(async () => undefined),
      focus: vi.fn(),
      hide: vi.fn(),
      getContentBounds: () => ({ x: 0, y: 40, width: 960, height: 640 }),
      readProjection: () => ({
        displayId: 7,
        bounds: { x: 100, y: 80, width: 960, height: 680 },
        visible: true,
        focused: false,
        presentation: "normal"
      }),
      isDestroyed: () => false,
      isVisible: () => true,
      show: vi.fn()
    };
    const appKit: MacosAppKitRuntimeHostFactoryPort = {
      nativeHostKind: "rust-napi-appkit",
      applyWindowName: vi.fn(),
      applyWindowPreferences: vi.fn(),
      captureChromiumSurfaceFocusLease: vi.fn(() => null),
      captureHostObservations: vi.fn(() => []),
      create: vi.fn(async () => appKitHost),
      createEmpty: vi.fn(async () => appKitHost),
      createPopup: vi.fn(),
      quarantineHost: vi.fn()
    };
    const factory = new ChromiumPlatformRuntimeHostFactory({
      platform: "darwin",
      appKit
    });

    await expect(factory.create(launchTarget, tab(launchTarget))).resolves.toBe(appKitHost);
    expect(appKit.create).toHaveBeenCalledWith(launchTarget, tab(launchTarget));
  });
});
