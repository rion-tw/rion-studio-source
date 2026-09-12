import { describe, expect, it, vi } from "vitest";

import type {
  ChromiumPopupAdmissionRecord,
  ChromiumPopupLifecycleActionRecord,
  ChromiumPopupLifecycleEventRecord,
  ChromiumPopupLifecycleReceiptRecord,
  ChromiumPopupOpenRequestRecord,
  CoreCommand,
  EmbeddedLaunchTargetRecord
} from "../src/shared/generated";
import {
  ChromiumPopupLifecycleCoordinator,
  resolveChromiumPopupParent,
  type ChromiumPopupLifecycleCoordinatorInput
} from "../src/electron/main/chromiumPopupLifecycleCoordinator";
import type {
  ChromiumPopupOwnerSource,
  ChromiumPopupWindowEventMap,
  ChromiumPopupWindowPort,
  ChromiumWindowOpenDetails,
  ChromiumWindowOpenHandlerResponse
} from "../src/electron/main/chromiumPopupPorts";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";

const POPUP_ID = "10000000-0000-4000-8000-000000000001";
const OPEN_OPERATION_ID = "20000000-0000-4000-8000-000000000001";

function controlledPromise(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
  throw new Error("Expected event-bound popup state was not observed.");
}

const parentTarget: EmbeddedLaunchTargetRecord = Object.freeze({
  windowId: "window-1",
  persistedName: "Parent",
  displayId: 7,
  scaleFactor: 2,
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  bounds: { x: 80, y: 60, width: 960, height: 640 },
  presentation: "normal"
});

class FakeCore {
  readonly commands: CoreCommand[] = [];
  readonly actions: ChromiumPopupLifecycleActionRecord[] = [];
  admissionGate: Promise<void> = Promise.resolve();
  phase: ChromiumPopupLifecycleReceiptRecord["phase"] = "admitted";
  revision = 1;
  closeReason: string | undefined;

  readonly invoke = vi.fn(async (command: CoreCommand): Promise<unknown> => {
    this.commands.push(command);
    if (command.type === "browserPopupOpenAdmit") {
      await this.admissionGate;
      return this.#admission(command.request);
    }
    if (command.type !== "browserPopupLifecycleCommit") {
      throw new Error(`Unexpected Core command ${command.type}.`);
    }
    return this.#commit(command.event);
  });

  #admission(request: ChromiumPopupOpenRequestRecord): ChromiumPopupAdmissionRecord {
    return {
      requestId: request.requestId,
      popupId: POPUP_ID,
      openOperationId: OPEN_OPERATION_ID,
      lifecycleRevision: 1,
      parent: request.parent,
      target: {
        ...request.parentTarget,
        windowId: `popup-${POPUP_ID}`,
        persistedName: "popup.example.test",
        bounds: { x: 120, y: 100, width: 800, height: 600 }
      },
      title: "popup.example.test",
      targetUrl: request.targetUrl,
      disposition: "newWindow",
      openerPolicy: request.openerPolicy,
      referrerUrl: request.referrerUrl,
      referrerPolicy: request.referrerPolicy,
      hasPostBody: request.hasPostBody
    };
  }

  #commit(event: ChromiumPopupLifecycleEventRecord): ChromiumPopupLifecycleReceiptRecord {
    this.actions.push(event.action);
    const action = event.action;
    let status: ChromiumPopupLifecycleReceiptRecord["status"] = "applied";
    let operationTerminal = false;
    let lifecycleTerminal = false;
    let closeNative = false;
    let failureCode: string | undefined;
    let completionScope: ChromiumPopupLifecycleReceiptRecord["completionScope"] =
      "stateCommit";
    if (action.type === "nativeReady") {
      this.phase = "nativeReady";
      completionScope = "nativeAcknowledgement";
    } else if (action.type === "pageReady") {
      this.phase = "ready";
      operationTerminal = true;
      completionScope = "pageFinished";
    } else if (action.type === "cancelled") {
      this.phase = "cancelled";
      status = "cancelled";
      operationTerminal = true;
      lifecycleTerminal = true;
      failureCode = action.failureCode;
    } else if (action.type === "closeRequested") {
      this.closeReason = action.reason;
      if (this.phase === "admitted") {
        const failed = action.reason === "loadFailed" ||
          action.reason === "navigationRejected";
        this.phase = failed ? "failed" : "cancelled";
        status = failed ? "failed" : "cancelled";
        operationTerminal = true;
        lifecycleTerminal = true;
      } else {
        this.phase = "closing";
        closeNative = true;
      }
    } else if (action.type === "nativeClosed") {
      this.phase = this.closeReason === "user" ? "closed" : "cancelled";
      status = this.closeReason === "user" ? "applied" : "cancelled";
      completionScope = "nativeDestroyed";
      operationTerminal = true;
      lifecycleTerminal = true;
    } else if (action.type === "failed") {
      this.phase = action.nativeStateUnknown ? "indeterminate" : "closing";
      status = action.nativeStateUnknown ? "indeterminate" : "failed";
      lifecycleTerminal = action.nativeStateUnknown;
      operationTerminal = action.nativeStateUnknown;
      closeNative = true;
      failureCode = action.failureCode;
    }
    this.revision += 1;
    return {
      eventId: event.eventId,
      popupId: event.popupId,
      operationId: OPEN_OPERATION_ID,
      lifecycleRevision: this.revision,
      phase: this.phase,
      status,
      completionScope,
      operationTerminal,
      lifecycleTerminal,
      closeNative,
      failureCode
    };
  }
}

type Listener = (...arguments_: unknown[]) => unknown;

class FakeContents implements ChromiumRoleSurfaceWebContentsPort {
  readonly listeners = new Map<keyof ChromiumRoleSurfaceEventMap, Set<Listener>>();
  readonly loadURL = vi.fn(async () => undefined);
  readonly reload = vi.fn();
  readonly close = vi.fn();
  readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => undefined);
  readonly send = vi.fn();
  readonly setAudioMuted = vi.fn();
  readonly setWindowOpenHandler = vi.fn((
    _handler: (details: ChromiumWindowOpenDetails) => ChromiumWindowOpenHandlerResponse
  ) => undefined);
  readonly stop = vi.fn();
  destroyed = false;
  url = "https://popup.example.test/start";
  zoomFactor = 1;

  constructor(
    readonly session: ChromiumRoleSessionPort,
    readonly opener: ChromiumRoleSurfaceWebContentsPort["opener"]
  ) {}

  getURL(): string { return this.url; }
  getZoomFactor(): number { return this.zoomFactor; }
  isAudioMuted(): boolean { return false; }
  isCurrentlyAudible(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  setZoomFactor(factor: number): void { this.zoomFactor = factor; }

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

  emit<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumRoleSurfaceEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }
}

class FakeWindow implements ChromiumPopupWindowPort {
  readonly id = 71;
  readonly listeners = new Map<keyof ChromiumPopupWindowEventMap, Set<Listener>>();
  readonly setBounds = vi.fn((bounds: ChromiumRoleSurfaceBounds) => {
    this.bounds = { ...bounds };
  });
  readonly setFocusable = vi.fn((focusable: boolean) => {
    this.focusable = focusable;
  });
  readonly setTitle = vi.fn((title: string) => { this.title = title; });
  readonly show = vi.fn(() => { this.visible = true; });
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.webContents.emit("destroyed");
    this.emit("closed");
  });
  bounds = { x: 0, y: 0, width: 640, height: 480 };
  destroyed = false;
  focusable = false;
  focused = false;
  visible = false;
  title = "Rion Popup — popup.example.test";

  constructor(
    readonly parent: Readonly<{ id: number; isDestroyed: () => boolean }>,
    readonly webContents: FakeContents
  ) {}

  getBounds(): ChromiumRoleSurfaceBounds { return { ...this.bounds }; }
  getContentBounds(): ChromiumRoleSurfaceBounds { return { ...this.bounds }; }
  getParentWindow() { return this.parent; }
  getTitle(): string { return this.title; }
  isDestroyed(): boolean { return this.destroyed; }
  isFocused(): boolean { return this.focused; }
  isVisible(): boolean { return this.visible; }

  on<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as unknown as Listener);
    this.listeners.set(event, listeners);
  }

  removeListener<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ): void {
    this.listeners.get(event)?.delete(listener as unknown as Listener);
  }

  emit<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumPopupWindowEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }

  userClose(): void {
    if (this.destroyed) return;
    this.emit("close");
    this.destroy();
  }
}

function runtimeSnapshot() {
  return {
    windows: [{
      windowId: "window-1",
      activeTabId: "tab-1",
      tabIds: ["tab-1"],
      displayId: 7,
      bounds: parentTarget.bounds,
      visible: true,
      focused: true,
      presentation: "normal" as const,
      windowGeneration: 1,
      topologyRevision: 9,
      parentNativeHostId: 41,
      target: parentTarget
    }],
    tabs: [{
      tabId: "tab-1",
      windowId: "window-1",
      audioMuted: false,
      audible: false,
      attemptGeneration: "attempt-1"
    }],
    roles: [{
      roleId: "role-1",
      tabId: "tab-1",
      windowId: "window-1",
      generation: 3,
      ownerGeneration: 5,
      zoomFactor: 1.25
    }],
    webSurfaces: []
  };
}

interface Harness {
  readonly core: FakeCore;
  readonly coordinator: ChromiumPopupLifecycleCoordinator;
  readonly details: ChromiumWindowOpenDetails;
  readonly nativeParent: Readonly<{ id: number; isDestroyed: () => boolean }>;
  readonly onError: ReturnType<typeof vi.fn>;
  readonly session: ChromiumRoleSessionPort;
  readonly source: ChromiumPopupOwnerSource;
  readonly snapshot: { current: ReturnType<typeof runtimeSnapshot> };
}

function harness(): Harness {
  const core = new FakeCore();
  const session = {} as ChromiumRoleSessionPort;
  const nativeParent = Object.freeze({ id: 41, isDestroyed: () => false });
  const parent = {
    id: 41,
    nativeWindow: nativeParent,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false
  };
  const openerFrame = Object.freeze({
    frameToken: "parent-frame-token",
    processId: 8,
    routingId: 13
  });
  const source: ChromiumPopupOwnerSource = {
    ownerKind: "role",
    ownerId: "role-1",
    nativeGeneration: 3,
    parent,
    session,
    openerFrame
  } as ChromiumPopupOwnerSource;
  const snapshot = { current: runtimeSnapshot() };
  const onError = vi.fn();
  const coordinator = new ChromiumPopupLifecycleCoordinator({
    core: { invoke: core.invoke } as ChromiumPopupLifecycleCoordinatorInput["core"],
    onError,
    platform: "win32",
    runtimeSnapshot: () => snapshot.current
  });
  return {
    core,
    coordinator,
    details: {
      url: "https://popup.example.test/start",
      disposition: "new-window",
      frameName: "thirdLoginWindow",
      features: "width=800,height=600,left=120,top=100",
      referrer: {
        url: "https://parent.example.test/",
        policy: "strict-origin-when-cross-origin"
      },
      postBody: null
    },
    nativeParent,
    onError,
    session,
    source,
    snapshot
  };
}

function createAllowedWindow(
  subject: Harness,
  details: ChromiumWindowOpenDetails = subject.details,
  opener: ChromiumRoleSurfaceWebContentsPort["opener"] = subject.source.openerFrame
): { decision: Extract<ChromiumWindowOpenHandlerResponse, { action: "allow" }>; window: FakeWindow } {
  const decision = subject.coordinator.handleWindowOpen(subject.source, details);
  expect(decision.action).toBe("allow");
  if (decision.action !== "allow") throw new Error("Popup was unexpectedly denied.");
  const contents = new FakeContents(subject.session, opener);
  const window = new FakeWindow(subject.nativeParent, contents);
  subject.coordinator.didCreateWindow(subject.source, window, details);
  return { decision, window };
}

describe("ChromiumPopupLifecycleCoordinator", () => {
  it("returns Electron allow without createWindow and fixes security-critical options", () => {
    const subject = harness();
    const decision = subject.coordinator.handleWindowOpen(subject.source, {
      ...subject.details,
      features: "width=900,height=700,transparent=yes,frame=no,modal=yes,alwaysOnTop=yes,nodeIntegration=yes"
    });
    expect(decision).toMatchObject({
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        alwaysOnTop: false,
        focusable: false,
        frame: true,
        modal: false,
        parent: subject.nativeParent,
        show: false,
        transparent: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          session: subject.session,
          webSecurity: true,
          webviewTag: false
        }
      }
    });
    expect(decision).not.toHaveProperty("createWindow");
    expect(decision.action === "allow" && decision.overrideBrowserWindowOptions.webPreferences)
      .not.toHaveProperty("preload");
  });

  it.each([
    [{ ...harness().details, disposition: "background-tab" }, "disposition"],
    [{ ...harness().details, url: "file:///tmp/popup" }, "scheme"],
    [{ ...harness().details, frameName: "_self" }, "reserved frame"],
    [{ ...harness().details, frameName: `bad\u0000name` }, "control frame"],
    [{ ...harness().details, frameName: `bad\u0085name` }, "Unicode control frame"],
    [{ ...harness().details, frameName: "x".repeat(257) }, "long frame"],
    [{ ...harness().details, features: `width=1\u0000` }, "control feature"],
    [{ ...harness().details, features: `width=1\u0085` }, "Unicode control feature"],
    [{ ...harness().details, features: "x".repeat(1025) }, "long feature"]
  ])("denies an unsafe request (%s)", (details) => {
    const subject = harness();
    expect(subject.coordinator.handleWindowOpen(subject.source, details))
      .toEqual({ action: "deny" });
    expect(subject.core.commands).toEqual([]);
  });

  it("adopts Electron's same WebContents, commits nativeReady, then enables and shows it", async () => {
    const subject = harness();
    const gate = controlledPromise();
    subject.core.admissionGate = gate.promise;
    const { decision, window } = createAllowedWindow(subject);
    await eventually(() => subject.core.commands.length === 1);
    expect(window.visible).toBe(false);
    expect(window.focusable).toBe(false);
    expect(window.webContents.loadURL).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
    expect(window.webContents.stop).not.toHaveBeenCalled();
    expect(window.webContents.session).toBe(subject.session);
    expect(decision.overrideBrowserWindowOptions.parent).toBe(subject.nativeParent);

    gate.resolve();
    await eventually(() => window.visible);
    expect(subject.core.actions).toEqual([
      expect.objectContaining({
        type: "nativeReady",
        host: expect.objectContaining({
          hostKind: "electronBrowserWindow",
          nativeHostId: window.id,
          platform: "windows"
        })
      })
    ]);
    expect(window.setBounds).toHaveBeenCalledWith({
      x: 120, y: 100, width: 800, height: 600
    });
    expect(window.webContents.zoomFactor).toBe(1.25);
    expect(window.setFocusable).toHaveBeenCalledWith(true);
    expect(window.show).toHaveBeenCalledOnce();
    await subject.coordinator.dispose();
  });

  it("preserves connected opener, named target, referrer, and POST metadata", async () => {
    const subject = harness();
    const details = {
      ...subject.details,
      postBody: { data: [{ type: "rawData", bytes: new Uint8Array([1, 2, 3]) }] }
    };
    const { window } = createAllowedWindow(subject, details);
    await eventually(() => window.visible);
    expect(subject.core.commands[0]).toMatchObject({
      type: "browserPopupOpenAdmit",
      request: {
        frameName: "thirdLoginWindow",
        hasPostBody: true,
        openerPolicy: "connectedOpener",
        rawFeatures: subject.details.features,
        referrerPolicy: "strict-origin-when-cross-origin",
        referrerUrl: "https://parent.example.test/",
        targetUrl: subject.details.url
      }
    });
    expect(window.webContents.loadURL).not.toHaveBeenCalled();
    await subject.coordinator.dispose();
  });

  it("preserves Electron's isolated noopener result", async () => {
    const subject = harness();
    const details = { ...subject.details, features: "noopener,noreferrer,width=800" };
    const { window } = createAllowedWindow(subject, details, null);
    await eventually(() => window.visible);
    expect(subject.core.commands[0]).toMatchObject({
      request: { openerPolicy: "isolatedNoopener" }
    });
    await subject.coordinator.dispose();
  });

  it("buffers an early page-ready event and commits it after nativeReady", async () => {
    const subject = harness();
    const gate = controlledPromise();
    subject.core.admissionGate = gate.promise;
    const { window } = createAllowedWindow(subject);
    window.webContents.url = "https://callback.example.test/complete";
    window.webContents.emit("did-finish-load");
    expect(window.visible).toBe(false);
    gate.resolve();
    await eventually(() => subject.core.actions.length === 2);
    expect(subject.core.actions).toEqual([
      expect.objectContaining({ type: "nativeReady" }),
      { type: "pageReady", finalUrl: "https://callback.example.test/complete" }
    ]);
    await subject.coordinator.dispose();
  });

  it("terminalizes an early script close without showing the provisional window", async () => {
    const subject = harness();
    const gate = controlledPromise();
    subject.core.admissionGate = gate.promise;
    const { window } = createAllowedWindow(subject);
    window.userClose();
    gate.resolve();
    await eventually(() => subject.coordinator.activeCount === 0);
    expect(window.show).not.toHaveBeenCalled();
    expect(subject.core.actions).toEqual([
      { type: "closeRequested", reason: "user" }
    ]);
    expect(subject.coordinator.readLifecycleJournal().observations).toEqual([
      expect.objectContaining({
        action: "closeRequested",
        closeReason: "user",
        lifecycleTerminal: true,
        operationTerminal: true
      })
    ]);
  });

  it("preserves an early main-frame load failure as the first terminal event", async () => {
    const subject = harness();
    const gate = controlledPromise();
    subject.core.admissionGate = gate.promise;
    const { window } = createAllowedWindow(subject);
    window.webContents.emit(
      "did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED",
      subject.details.url, true, 7, 11
    );
    window.userClose();
    gate.resolve();
    await eventually(() => subject.coordinator.activeCount === 0);
    expect(window.show).not.toHaveBeenCalled();
    expect(subject.core.actions).toEqual([
      { type: "closeRequested", reason: "loadFailed" }
    ]);
  });

  it.each(["opener", "session", "parent"] as const)(
    "destroys a did-create-window with a mismatched %s identity",
    async (mismatch) => {
      const subject = harness();
      const contents = new FakeContents(
        mismatch === "session" ? {} as ChromiumRoleSessionPort : subject.session,
        mismatch === "opener" ? { frameToken: "wrong" } : subject.source.openerFrame
      );
      const parent = mismatch === "parent"
        ? { id: 99, isDestroyed: () => false }
        : subject.nativeParent;
      const window = new FakeWindow(parent, contents);
      subject.coordinator.didCreateWindow(subject.source, window, subject.details);
      expect(window.destroy).toHaveBeenCalledOnce();
      expect(subject.core.commands).toEqual([]);
      expect(subject.onError).toHaveBeenCalledWith(expect.objectContaining({
        code: "ELECTRON_CHROMIUM_POPUP_NATIVE_IDENTITY_MISMATCH"
      }));
    }
  );

  it("blocks nested popup, scripted move/resize, untrusted title, and unsafe navigation", async () => {
    const subject = harness();
    const { window } = createAllowedWindow(subject);
    await eventually(() => window.visible);
    const nested = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(nested?.({ url: "https://nested.example.test/" }))
      .toEqual({ action: "deny" });
    const boundsEvent = { preventDefault: vi.fn() };
    window.webContents.emit("content-bounds-updated", boundsEvent, {
      x: 1, y: 1, width: 1, height: 1
    });
    const titleEvent = { preventDefault: vi.fn() };
    window.webContents.emit("page-title-updated", titleEvent, "Spoofed", true);
    expect(boundsEvent.preventDefault).toHaveBeenCalledOnce();
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce();

    window.webContents.url = "https://accounts.google.com/select";
    window.webContents.emit("did-navigate", {}, window.webContents.url, 200, "OK");
    expect(window.title).toBe("Rion Popup — accounts.google.com");
    const navigationEvent = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", navigationEvent, "file:///tmp/escape");
    await eventually(() => subject.coordinator.activeCount === 0);
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
    expect(subject.core.actions.map((action) => action.type)).toEqual([
      "nativeReady", "closeRequested", "nativeClosed"
    ]);
  });

  it("terminalizes user close, crash, owner retirement, and shutdown", async () => {
    const user = harness();
    const userWindow = createAllowedWindow(user).window;
    await eventually(() => userWindow.visible);
    userWindow.userClose();
    await eventually(() => user.coordinator.activeCount === 0);
    expect(user.core.actions.map((action) => action.type)).toEqual([
      "nativeReady", "closeRequested", "nativeClosed"
    ]);

    const crash = harness();
    const crashWindow = createAllowedWindow(crash).window;
    await eventually(() => crashWindow.visible);
    crashWindow.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    await eventually(() => crash.coordinator.activeCount === 0);
    expect(crash.core.closeReason).toBe("loadFailed");

    const retired = harness();
    const retiredWindow = createAllowedWindow(retired).window;
    await eventually(() => retiredWindow.visible);
    await retired.coordinator.retireOwner({
      ownerKind: "role", ownerId: "role-1", nativeGeneration: 3
    });
    expect(retired.core.closeReason).toBe("parentRetired");
    expect(retired.coordinator.readLifecycleJournal().observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "closeRequested",
          closeReason: "parentRetired"
        })
      ])
    );
    expect(retiredWindow.destroyed).toBe(true);

    const shutdown = harness();
    const shutdownWindow = createAllowedWindow(shutdown).window;
    await eventually(() => shutdownWindow.visible);
    await shutdown.coordinator.dispose();
    expect(shutdown.core.closeReason).toBe("applicationShutdown");
    expect(shutdownWindow.destroyed).toBe(true);
  });

  it("cancels admission when the exact parent becomes stale", async () => {
    const subject = harness();
    const gate = controlledPromise();
    subject.core.admissionGate = gate.promise;
    const { window } = createAllowedWindow(subject);
    subject.snapshot.current = { ...subject.snapshot.current, roles: [] };
    gate.resolve();
    await eventually(() => subject.coordinator.activeCount === 0);
    expect(window.show).not.toHaveBeenCalled();
    expect(subject.core.actions).toEqual([
      { type: "closeRequested", reason: "parentRetired" }
    ]);
  });

  it("keeps AppKit identity only on the parent fence", () => {
    const subject = harness();
    const identity = {
      logicalWindowId: "window-1",
      launchGeneration: "initial-host-tab-attempt",
      nativeGeneration: 6
    };
    const snapshot = {
      ...subject.snapshot.current,
      windows: [{
        ...subject.snapshot.current.windows[0]!,
        appKitIdentity: identity,
        windowGeneration: 2
      }],
      tabs: [{
        ...subject.snapshot.current.tabs[0]!,
        attemptGeneration: "active-second-tab-attempt"
      }]
    };
    expect(resolveChromiumPopupParent(snapshot, subject.source, "darwin"))
      .toMatchObject({
        parent: {
          parentAppkitIdentity: identity,
          parentAttemptGeneration: "active-second-tab-attempt",
          parentNativeHostId: 41,
          parentWindowGeneration: 2
        }
      });
  });

  it("applies popup zoom on the existing WebContents", async () => {
    const subject = harness();
    const { window } = createAllowedWindow(subject);
    await eventually(() => window.visible);
    const transaction = await subject.coordinator.prepareWindowZoomTransaction({
      nextZoomFactor: 1.2,
      previousZoomFactor: 1,
      topologyRevision: 9,
      windowGeneration: 1,
      windowId: "window-1"
    });
    transaction.apply();
    expect(window.webContents.zoomFactor).toBe(1.5);
    transaction.commit();
    expect(window.webContents.loadURL).not.toHaveBeenCalled();
    await subject.coordinator.dispose();
  });
});
