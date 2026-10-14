import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi, type Mock } from "vitest";
import type { EmbeddedLaunchTargetRecord, EmbeddedTabEffectRecord } from "../../src/shared/generated";
import type { ChromiumRuntimeHostPort } from "../../src/electron/main/chromiumRuntimeHostPorts";
import type { WindowsBrowserWindowFactoryPort, WindowsRuntimeForegroundProbePort,
  WindowsRuntimeHostWindowPort } from "../../src/electron/main/chromiumRuntimeHostFactory";
import type { WindowsRuntimeInactivePresentationPort,
  WindowsRuntimeShortcutOwnerPort } from "../../src/electron/main/windowsRuntimeHostNativePorts";

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
  focus: Mock<() => void> = vi.fn();
  setIgnoreMenuShortcuts: Mock<(ignore: boolean) => void> = vi.fn();
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

export class FakeWindow {
  readonly contents = new FakeWebContents();
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
  destroyCalls = 0;
  destroyEmitsClosed = true;
  focusCalls = 0;
  showCalls = 0;
  showInactiveCalls = 0;
  maximizeCalls = 0;
  inactiveMaximizeCalls = 0;
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

  get webContents(): FakeWebContents {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.contents;
  }

  close(): void {
    this.closeCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.visible = false;
    if (this.destroyEmitsClosed) this.emit("closed");
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
    if (this.destroyed) throw new Error("Object has been destroyed");
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
    this.contents.currentUrl = pathToFileURL(path).href;
    return this.loadResult;
  }

  maximize(): void {
    this.maximizeCalls += 1;
    this.maximized = true;
    this.visible = true;
    this.focused = true;
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

export class FakeBrowserWindows {
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

export class FakeRuntimeForegroundProbe implements WindowsRuntimeForegroundProbePort {
  readonly readWindowsPhysicalModifierCodes = vi.fn(() => []);
  readonly readWindowsPhysicalInputSequence = vi.fn(() => "0");
  parentWasForeground = false;
  parentVisible = false;
  parentMinimized = false;
  parentIdentity: string | null = null;
  focusIdentity = "f".repeat(64);
  readonly readWindowsRuntimeForeground = vi.fn((handle: Buffer) => {
    return {
      parentIdentity: this.parentIdentity ??
        handle.readBigUInt64LE().toString(16).padStart(64, "0"),
      focusIdentity: this.focusIdentity,
      parentWasForeground: this.parentWasForeground,
      parentVisible: this.parentVisible,
      parentMinimized: this.parentMinimized
    };
  });
}

export class FakeRuntimeInactivePresentation implements WindowsRuntimeInactivePresentationPort {
  constructor(readonly browserWindows: FakeBrowserWindows) {}

  readonly readWindowsRuntimeForeground = vi.fn((handle: Buffer) => {
    const window = this.#window(handle);
    return { parentIdentity: window.nativeId.toString(16).padStart(64, "0"),
      focusIdentity: "f".repeat(64), parentWasForeground: window.focused,
      parentVisible: window.visible, parentMinimized: window.minimized };
  });

  readonly maximizeWindowsRuntimeParentInactive = vi.fn((handle: Buffer, expectedParentIdentity: string) => {
    const before = this.readWindowsRuntimeForeground(handle);
    if (before.parentIdentity !== expectedParentIdentity || before.parentWasForeground) {
      throw new Error("Inactive maximize lost its exact background native parent");
    }
    const window = this.#window(handle);
    window.inactiveMaximizeCalls += 1;
    window.visible = true;
    window.maximized = true;
    return this.readWindowsRuntimeForeground(handle);
  });

  #window(handle: Buffer): FakeWindow {
    const id = Number(handle.readBigUInt64LE());
    const candidates = this.browserWindows.windows.filter(window => window.nativeId === id && !window.destroyed);
    if (candidates.length !== 1) throw new Error("Inactive presentation has no exact native owner");
    return candidates[0]!;
  }
}

export class FakeRuntimeShortcutOwner implements WindowsRuntimeShortcutOwnerPort {
  readonly registrations: Array<Readonly<{
    handle: Buffer;
    ownerRevision: string;
  }>> = [];
  readonly unregisterCalls: Array<Readonly<{
    handle: Buffer;
    ownerRevision: string;
  }>> = [];

  registerWindowsRuntimeShortcutOwner(handle: Buffer, ownerRevision: string) {
    this.registrations.push({ handle: Buffer.from(handle), ownerRevision });
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

export const runtimeDocumentPath = resolve("/Rion/out/renderer/runtime-windows-host.html");
export const displays = {
  displayMatching: () => ({
    id: 7,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 }
  })
};

export function target(
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

export function tab(
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

export async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

export async function finishCreation(
  creation: Promise<ChromiumRuntimeHostPort>,
  window: FakeWindow,
  presentation: EmbeddedLaunchTargetRecord["presentation"] = "normal"
): Promise<ChromiumRuntimeHostPort> {
  window.webContents.emit("did-finish-load");
  window.emit("ready-to-show");
  if (presentation === "fullscreen") window.emit("enter-full-screen");
  return creation;
}

export async function applyWindowFence(
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
      audioMuted: false,
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
