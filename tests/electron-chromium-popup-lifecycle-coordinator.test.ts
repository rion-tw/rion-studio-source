import { Buffer } from "node:buffer";

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
  ChromiumPopupWindowCreateOptions,
  ChromiumPopupWindowEventMap,
  ChromiumPopupWindowPort
} from "../src/electron/main/chromiumPopupPorts";
import type {
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import type { ChromiumRuntimeHostPort } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";

const POPUP_ID = "10000000-0000-4000-8000-000000000001";
const OPEN_OPERATION_ID = "20000000-0000-4000-8000-000000000001";

function indexedIdentifier(prefix: "1" | "2" | "3", index: number): string {
  return `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 80; index += 1) {
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
  readonly openOperations = new Map<string, string>();
  admissionGate: Promise<void> = Promise.resolve();
  admissionCount = 0;
  phase = "admitted";
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
    this.admissionCount += 1;
    const popupId = indexedIdentifier("1", this.admissionCount);
    const openOperationId = indexedIdentifier("2", this.admissionCount);
    this.openOperations.set(popupId, openOperationId);
    return {
      requestId: request.requestId,
      popupId,
      openOperationId,
      lifecycleRevision: 1,
      parent: request.parent,
      target: {
        ...request.parentTarget,
        windowId: `popup-${popupId}`,
        persistedName: "popup.example.test",
        bounds: { x: 120, y: 100, width: 800, height: 600 }
      },
      title: "popup.example.test",
      creationUrl: "about:blank",
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
        this.phase = "cancelled";
        status = "cancelled";
        operationTerminal = true;
        lifecycleTerminal = true;
        failureCode = "CHROMIUM_POPUP_CLOSED_BEFORE_READY";
      } else {
        this.phase = "closing";
        closeNative = true;
      }
    } else if (action.type === "nativeClosed") {
      completionScope = "nativeDestroyed";
      operationTerminal = true;
      lifecycleTerminal = true;
      if (this.phase === "closing") {
        this.phase = this.closeReason === "user" ? "closed" : "cancelled";
        status = this.closeReason === "user" ? "applied" : "cancelled";
        if (
          this.closeReason === "parentRetired" ||
          this.closeReason === "applicationShutdown"
        ) {
          failureCode = "CHROMIUM_POPUP_OWNER_RETIRED";
        }
      } else {
        this.phase = "indeterminate";
        status = "indeterminate";
        failureCode = "CHROMIUM_POPUP_UNREQUESTED_NATIVE_CLOSE";
      }
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
      operationId: this.openOperations.get(event.popupId) ?? OPEN_OPERATION_ID,
      lifecycleRevision: this.revision,
      phase: this.phase as ChromiumPopupLifecycleReceiptRecord["phase"],
      status,
      completionScope,
      operationTerminal,
      lifecycleTerminal,
      closeNative,
      failureCode
    };
  }
}

class FakeView {
  readonly listeners = new Map<string, Set<(...arguments_: never[]) => void>>();
  readonly close = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  });
  readonly loadURL = vi.fn(async (
    _url: string,
    _options?: Parameters<ChromiumRoleSurfaceWebContentsPort["loadURL"]>[1]
  ) => undefined);
  readonly setBounds = vi.fn((bounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>) => {
    this.bounds = { ...bounds };
  });
  readonly setVisible = vi.fn();
  readonly stop = vi.fn();
  readonly windowOpen = vi.fn();
  readonly webContents: ChromiumRoleSurfaceWebContentsPort;
  readonly port: ChromiumRoleWebContentsViewPort;
  dropPortWebContentsOnDestroy = false;
  destroyed = false;
  bounds = { x: 0, y: 0, width: 800, height: 560 };
  url = "about:blank";
  zoomFactor = 1;

  constructor(readonly session: object, opener: object | null = null) {
    this.webContents = {
      opener,
      session,
      close: this.close,
      executeJavaScriptInIsolatedWorld: vi.fn(),
      getURL: () => this.url,
      getZoomFactor: () => this.zoomFactor,
      isAudioMuted: () => false,
      isCurrentlyAudible: () => false,
      isDestroyed: () => this.destroyed,
      loadURL: this.loadURL,
      on: (event: string, listener: (...arguments_: never[]) => void) => {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
      },
      removeListener: (event: string, listener: (...arguments_: never[]) => void) => {
        this.listeners.get(event)?.delete(listener);
      },
      send: vi.fn(),
      setWindowOpenHandler: this.windowOpen,
      stop: this.stop,
      setAudioMuted: vi.fn(),
      setZoomFactor: vi.fn((zoomFactor: number) => {
        this.zoomFactor = zoomFactor;
      })
    } as unknown as ChromiumRoleSurfaceWebContentsPort;
    const readPortWebContents = () =>
      this.dropPortWebContentsOnDestroy && this.destroyed
        ? undefined as unknown as ChromiumRoleSurfaceWebContentsPort
        : this.webContents;
    this.port = {
      get webContents() {
        return readPortWebContents();
      },
      getBounds: () => ({ ...this.bounds }),
      getVisible: () => true,
      setBounds: this.setBounds,
      setVisible: this.setVisible
    };
  }

  emit<EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumRoleSurfaceEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...arguments_);
    }
  }
}

class FakePopupWindow implements ChromiumPopupWindowPort {
  readonly id = 72;
  readonly listeners = new Map<
    keyof ChromiumPopupWindowEventMap,
    Set<(...arguments_: never[]) => void>
  >();
  readonly titles: string[] = [];
  readonly focusableValues: boolean[] = [false];
  readonly webContents: ChromiumRoleSurfaceWebContentsPort;
  destroyed = false;
  focused = false;
  visible = false;
  bounds = { x: 0, y: 0, width: 640, height: 480 };

  constructor(readonly view: FakeView) {
    this.webContents = view.webContents;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.focused = false;
    this.view.destroyed = true;
    this.view.emit("destroyed");
    this.emit("closed");
  }

  focus(): void {
    if (!this.destroyed && this.visible) this.focused = true;
  }

  getBounds(): typeof this.bounds {
    return { ...this.bounds };
  }

  getContentBounds(): typeof this.bounds {
    return { ...this.bounds };
  }

  getTitle(): string { return this.titles.at(-1) ?? ""; }

  hide(): void {
    this.visible = false;
    this.focused = false;
  }

  isDestroyed(): boolean { return this.destroyed; }
  isFocused(): boolean { return this.focused; }
  isVisible(): boolean { return this.visible; }

  on<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as unknown as (...arguments_: never[]) => void);
    this.listeners.set(event, listeners);
  }

  removeListener<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ): void {
    this.listeners.get(event)?.delete(
      listener as unknown as (...arguments_: never[]) => void
    );
  }

  setBounds(bounds: typeof this.bounds): void {
    this.bounds = { ...bounds };
  }

  setFocusable(focusable: boolean): void {
    this.focusableValues.push(focusable);
  }

  setTitle(title: string): void {
    this.titles.push(title);
  }

  show(): void { this.visible = true; }
  showInactive(): void { this.visible = true; }

  emit<EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    ...arguments_: Parameters<ChromiumPopupWindowEventMap[EventName]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...arguments_);
    }
  }
}

class FakeHost {
  readonly addChildView = vi.fn();
  readonly removeChildView = vi.fn();
  readonly show = vi.fn(() => {
    this.visible = true;
  });
  observer: Parameters<NonNullable<ChromiumRuntimeHostPort["bindPopupLifecycle"]>>[0]
    | null = null;
  destroyed = false;
  visible = false;
  throwContentBounds = false;
  bounds = { x: 120, y: 100, width: 800, height: 600 };

  readonly host: ChromiumRuntimeHostPort = {
    id: 71,
    logicalWindowId: `popup-${POPUP_ID}`,
    contentView: {
      addChildView: this.addChildView,
      removeChildView: this.removeChildView
    },
    bindPopupLifecycle: (observer) => {
      this.observer = observer;
    },
    close: vi.fn(async () => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.observer?.closed();
    }),
    focus: vi.fn(),
    hide: vi.fn(),
    getContentBounds: () => {
      if (this.throwContentBounds) throw new Error("layout failed");
      return { x: 0, y: 40, width: 800, height: 560 };
    },
    readProjection: () => ({
      displayId: 7,
      bounds: { ...this.bounds },
      visible: this.visible,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => this.destroyed,
    isVisible: () => this.visible,
    show: this.show
  };

  unexpectedClose(): void {
    this.destroyed = true;
    this.observer?.closed();
  }
}

interface RuntimeRoleFixture {
  readonly generation: number;
  readonly ownerGeneration: number;
  readonly roleId: string;
  readonly tabId: string;
  readonly windowId: string;
}

function harness(roleOwners: readonly RuntimeRoleFixture[] = [{
  roleId: "role-1",
  tabId: "tab-1",
  windowId: "window-1",
  generation: 3,
  ownerGeneration: 5
}], options: Readonly<{
  opener?: "connected" | "equivalent" | "isolated" | "mismatch";
  ownerKind?: "globalWeb" | "role";
}> = {}): {
  core: FakeCore;
  coordinator: ChromiumPopupLifecycleCoordinator;
  host: FakeHost;
  hostCreate: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  popupCreate: ReturnType<typeof vi.fn>;
  popupWindow: FakePopupWindow;
  source: ChromiumPopupOwnerSource;
  view: FakeView;
  viewPreferences: Array<Record<string, unknown>>;
} {
  const core = new FakeCore();
  const session = {};
  const parent = {
    id: 41,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false
  };
  const openerFrame = Object.freeze({ frameToken: "parent-main-frame" });
  const source = {
    ownerKind: options.ownerKind ?? "role",
    ownerId: options.ownerKind === "globalWeb" ? "web-surface-1" : "role-1",
    ...(options.ownerKind === "globalWeb" ? { slotId: "slot-1" } : {}),
    nativeGeneration: 3,
    parent,
    session,
    openerFrame
  } as unknown as ChromiumPopupOwnerSource;
  const host = new FakeHost();
  const popupOpener = options.opener === "mismatch"
      ? Object.freeze({ frameToken: "wrong-frame" })
      : options.opener === "equivalent"
        ? Object.freeze({ frameToken: "parent-main-frame" })
        : options.opener === "isolated" ? null : openerFrame;
  const view = new FakeView(session, popupOpener);
  const popupWindow = new FakePopupWindow(view);
  const popupCreate = vi.fn((
    _options: ChromiumPopupWindowCreateOptions
  ): ChromiumPopupWindowPort => popupWindow);
  const hostCreate = vi.fn(async () => ({
    host: host.host,
    receipt: {
      platform: "windows" as const,
      hostKind: "electronBrowserWindow" as const,
      nativeHostId: 71,
      logicalWindowId: `popup-${POPUP_ID}`,
      windowGeneration: 1,
      topologyRevision: 1
    }
  }));
  const onError = vi.fn();
  const viewPreferences: Array<Record<string, unknown>> = [];
  const coordinator = new ChromiumPopupLifecycleCoordinator({
    core: { invoke: core.invoke } as unknown as ChromiumPopupLifecycleCoordinatorInput["core"],
    hosts: { createPopup: hostCreate },
    onError,
    platform: "win32",
    popupWindows: { create: popupCreate },
    runtimeSnapshot: () => ({
      windows: [{
        windowId: "window-1",
        activeTabId: "tab-1",
        tabIds: ["tab-1"],
        displayId: 7,
        bounds: parentTarget.bounds,
        visible: true,
        focused: true,
        presentation: "normal",
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
      roles: options.ownerKind === "globalWeb" ? [] : roleOwners,
      webSurfaces: options.ownerKind === "globalWeb"
        ? [{
            surfaceId: "web-surface-1",
            slotId: "slot-1",
            tabId: "tab-1",
            windowId: "window-1",
            generation: 3,
            zoomFactor: 1
          }]
        : []
    }),
    views: {
      create: (options) => {
        viewPreferences.push(
          options.webPreferences as unknown as Record<string, unknown>
        );
        return view.port;
      }
    }
  });
  return {
    core,
    coordinator,
    host,
    hostCreate,
    onError,
    popupCreate,
    popupWindow,
    source,
    view,
    viewPreferences
  };
}

function open(coordinator: ChromiumPopupLifecycleCoordinator, source: ChromiumPopupOwnerSource) {
  coordinator.requestOpen(source, {
    url: "https://popup.example.test/path",
    disposition: "new-window",
    frameName: "_blank",
    features: "noopener,noreferrer",
    referrer: {
      url: "https://parent.example.test/",
      policy: "strict-origin-when-cross-origin"
    },
    postBody: null
  });
}

describe("ChromiumPopupLifecycleCoordinator", () => {
  it("returns a connected WindowProxy for an iQIYI-style named OAuth popup", async () => {
    const {
      coordinator,
      core,
      popupCreate,
      popupWindow,
      source,
      view
    } = harness(undefined, { ownerKind: "globalWeb" });
    const oauthUrl = "https://accounts.google.com/v3/signin/accountchooser";
    const admissionGate = deferred();
    core.admissionGate = admissionGate.promise;
    const features = [
      "height=450",
      "width=500",
      "top=100",
      "left=200",
      "toolbar=no",
      "menubar=no",
      "scrollbars=yes",
      "resizable=yes",
      "location=no",
      "status=no"
    ].join(",");
    const response = coordinator.handleWindowOpen(source, {
      url: oauthUrl,
      disposition: "new-window",
      frameName: "thirdLoginWindow",
      features,
      referrer: {
        url: "https://www.iq.com/",
        policy: "strict-origin-when-cross-origin"
      }
    });
    expect(response.action).toBe("allow");
    if (response.action !== "allow") throw new Error("Expected popup admission.");
    const returnedContents = response.createWindow({
      webContents: view.webContents,
      webPreferences: { nodeIntegration: true, preload: "/unsafe" }
    });
    expect(returnedContents).toBe(view.webContents);
    expect(view.stop).toHaveBeenCalledOnce();
    expect(response.outlivesOpener).toBe(false);
    expect(response.overrideBrowserWindowOptions).toEqual(expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: source.session
      })
    }));
    expect(core.commands).toEqual([]);
    expect(popupWindow.visible).toBe(false);
    expect(popupWindow.focused).toBe(false);
    expect(popupCreate).toHaveBeenCalledWith(expect.objectContaining({
      autoHideMenuBar: true,
      focusable: false,
      frame: true,
      fullscreenable: false,
      show: false,
      title: "Rion Popup — accounts.google.com",
      webContents: view.webContents,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        paintWhenInitiallyHidden: false,
        sandbox: true,
        session: source.session,
        webviewTag: false
      })
    }));

    const initialNavigation = {
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: oauthUrl
    };
    view.emit("will-frame-navigate", initialNavigation);
    expect(initialNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(popupWindow.visible).toBe(false);
    await eventually(() => core.commands.length === 1);
    expect(view.loadURL).not.toHaveBeenCalled();
    expect(core.actions).toEqual([]);
    admissionGate.resolve();
    await eventually(() => view.loadURL.mock.calls.length === 1);

    expect(core.commands[0]).toMatchObject({
      request: {
        frameName: "thirdLoginWindow",
        openerPolicy: "connectedOpener",
        parent: expect.objectContaining({ ownerKind: "globalWeb" }),
        rawFeatures: features,
        referrerPolicy: "strict-origin-when-cross-origin",
        referrerUrl: "https://www.iq.com/",
        targetUrl: oauthUrl
      },
      type: "browserPopupOpenAdmit"
    });
    expect(core.actions[0]).toMatchObject({
      host: {
        hostKind: "electronBrowserWindow",
        nativeHostId: popupWindow.id,
        platform: "windows"
      },
      type: "nativeReady"
    });
    expect(popupWindow.focusableValues).toEqual([false, true]);
    expect(popupWindow.visible).toBe(true);
    expect(view.loadURL).toHaveBeenCalledWith(oauthUrl, {
      httpReferrer: {
        policy: "strict-origin-when-cross-origin",
        url: "https://www.iq.com/"
      }
    });

    view.emit("did-navigate", {}, "https://passport.iq.com/intl/callback", 200, "OK");
    expect(popupWindow.titles.at(-1)).toBe("Rion Popup — passport.iq.com");
    const titleEvent = { preventDefault: vi.fn() };
    view.emit("page-title-updated", titleEvent, "Untrusted title", true);
    expect(titleEvent.preventDefault).toHaveBeenCalledOnce();

    view.url = "https://passport.iq.com/intl/callback";
    view.emit("did-finish-load");
    await eventually(() => core.actions.some((action) => action.type === "pageReady"));
    view.emit(
      "did-fail-load",
      {},
      -3,
      "ERR_ABORTED",
      "",
      true,
      1,
      1
    );
    await Promise.resolve();
    expect(core.actions.some((action) => action.type === "closeRequested"))
      .toBe(false);
    const scriptClose = { preventDefault: vi.fn() };
    popupWindow.emit("close", scriptClose);
    expect(scriptClose.preventDefault).toHaveBeenCalledOnce();
    await eventually(() => coordinator.activeCount === 0);
    expect(core.actions.map((action) => action.type)).toEqual([
      "nativeReady",
      "pageReady",
      "closeRequested",
      "nativeClosed"
    ]);
    await coordinator.dispose();
    expect(popupWindow.destroyed).toBe(true);
  });

  it("admits after synchronously stopping an initial navigation event missed by Electron", async () => {
    const { coordinator, core, popupWindow, source, view } = harness(
      undefined,
      { ownerKind: "globalWeb" }
    );
    const response = coordinator.handleWindowOpen(source, {
      url: "https://popup.example.test/early-navigation",
      disposition: "new-window",
      frameName: "earlyPopup",
      features: "width=500,height=450"
    });
    if (response.action !== "allow") throw new Error("Expected popup admission.");
    response.createWindow({ webContents: view.webContents });

    expect(view.stop).toHaveBeenCalledOnce();
    expect(core.commands).toEqual([]);
    await eventually(() => core.admissionCount === 1);
    await eventually(() => view.loadURL.mock.calls.length === 1);
    expect(core.commands[0]).toMatchObject({
      request: {
        openerPolicy: "connectedOpener",
        targetUrl: "https://popup.example.test/early-navigation"
      }
    });
    expect(popupWindow.visible).toBe(true);
    await coordinator.dispose();
  });

  it("preserves explicit noopener and rejects unsafe named popup inputs", async () => {
    const isolated = harness(undefined, { opener: "equivalent" });
    const response = isolated.coordinator.handleWindowOpen(isolated.source, {
      url: "https://accounts.example.test/oauth",
      disposition: "new-window",
      frameName: "oauthWindow",
      features: "noopener,noreferrer,width=500,height=450"
    });
    expect(response.action).toBe("allow");
    if (response.action !== "allow") throw new Error("Expected popup admission.");
    response.createWindow({ webContents: isolated.view.webContents });
    isolated.view.emit("will-frame-navigate", {
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: "https://accounts.example.test/oauth"
    });
    await eventually(() => isolated.core.admissionCount === 1);
    expect(isolated.core.commands[0]).toMatchObject({
      request: { openerPolicy: "isolatedNoopener" }
    });
    await isolated.coordinator.dispose();

    const relIsolated = harness(undefined, { opener: "isolated" });
    const relResponse = relIsolated.coordinator.handleWindowOpen(relIsolated.source, {
      url: "https://accounts.example.test/rel-noopener",
      disposition: "new-window",
      frameName: "",
      features: "width=500,height=450"
    });
    if (relResponse.action !== "allow") throw new Error("Expected popup admission.");
    relResponse.createWindow({ webContents: relIsolated.view.webContents });
    await eventually(() => relIsolated.core.admissionCount === 1);
    expect(relIsolated.core.commands[0]).toMatchObject({
      request: { openerPolicy: "isolatedNoopener" }
    });
    await relIsolated.coordinator.dispose();

    const rejected = harness();
    for (const details of [
      {
        url: "https://popup.example.test/",
        disposition: "new-window",
        frameName: "_top",
        features: "width=500"
      },
      {
        url: "https://popup.example.test/",
        disposition: "new-window",
        frameName: "thirdLoginWindow",
        features: "nodeIntegration=yes"
      }
    ]) {
      expect(rejected.coordinator.handleWindowOpen(rejected.source, details))
        .toEqual({ action: "deny" });
    }
    expect(rejected.popupCreate).not.toHaveBeenCalled();
    await rejected.coordinator.dispose();
  });

  it("destroys a provisional BrowserWindow whose opener is not the parent frame", async () => {
    const mismatch = harness(undefined, { opener: "mismatch" });
    const response = mismatch.coordinator.handleWindowOpen(mismatch.source, {
      url: "https://popup.example.test/oauth",
      disposition: "new-window",
      frameName: "oauthWindow",
      features: "width=500,height=450"
    });
    if (response.action !== "allow") throw new Error("Expected popup admission.");
    response.createWindow({ webContents: mismatch.view.webContents });
    mismatch.view.emit("will-frame-navigate", {
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: "https://popup.example.test/oauth"
    });
    expect(mismatch.popupWindow.destroyed).toBe(true);
    expect(mismatch.core.commands).toEqual([]);
    expect(mismatch.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_POPUP_OPENER_MISMATCH"
    }));
    await mismatch.coordinator.dispose();
  });

  it("admits a normal target-blank left click and denies background dispositions", async () => {
    const foreground = harness();
    foreground.coordinator.requestOpen(foreground.source, {
      url: "https://popup.example.test/left-click",
      disposition: "foreground-tab",
      frameName: "_blank",
      features: "noopener"
    });
    await eventually(() => foreground.host.observer !== null);
    expect(foreground.core.admissionCount).toBe(1);
    expect(foreground.core.commands[0]).toMatchObject({
      request: {
        disposition: "newWindow",
        openerPolicy: "isolatedNoopener",
        targetUrl: "https://popup.example.test/left-click"
      },
      type: "browserPopupOpenAdmit"
    });
    await foreground.coordinator.dispose();

    const background = harness();
    background.coordinator.requestOpen(background.source, {
      url: "https://popup.example.test/background",
      disposition: "background-tab",
      frameName: "_blank",
      features: "noopener"
    });
    await Promise.resolve();
    expect(background.core.commands).toEqual([]);
    expect(background.hostCreate).not.toHaveBeenCalled();
    await background.coordinator.dispose();
  });

  it("derives the exact macOS AppKit identity from the native host snapshot", () => {
    const { source } = harness();
    const identity = {
      logicalWindowId: "window-1",
      launchGeneration: "initial-host-tab-attempt",
      nativeGeneration: 6
    };
    const snapshot = {
      windows: [{
        windowId: "window-1",
        activeTabId: "tab-1",
        tabIds: ["tab-1"],
        displayId: 7,
        bounds: parentTarget.bounds,
        visible: true,
        focused: true,
        presentation: "normal" as const,
        windowGeneration: 2,
        topologyRevision: 9,
        parentNativeHostId: 41,
        appKitIdentity: identity,
        target: parentTarget
      }],
      tabs: [{
        tabId: "tab-1",
        windowId: "window-1",
        audioMuted: false,
        audible: false,
        attemptGeneration: "active-second-tab-attempt"
      }],
      roles: [{
        roleId: "role-1",
        tabId: "tab-1",
        windowId: "window-1",
        generation: 3,
        ownerGeneration: 5
      }],
      webSurfaces: []
    };
    expect(resolveChromiumPopupParent(snapshot, source, "darwin"))
      .toMatchObject({
        parent: {
          parentWindowGeneration: 2,
          parentTopologyRevision: 9,
          parentAttemptGeneration: "active-second-tab-attempt",
          parentNativeHostId: 41,
          parentAppkitIdentity: identity
        }
      });
    expect(resolveChromiumPopupParent(snapshot, {
      ...source,
      parent: { ...source.parent, id: 42 }
    }, "darwin")).toBeNull();
  });

  it("orders admission, native/page receipts, exact Session projection, and close", async () => {
    const { core, coordinator, host, source, view, viewPreferences } = harness();
    open(coordinator, source);
    await eventually(() => host.observer !== null && view.loadURL.mock.calls.length === 1);
    expect(view.webContents.session).toBe(source.session);
    expect(core.commands[0]).toMatchObject({
      request: { hasPostBody: false },
      type: "browserPopupOpenAdmit"
    });
    expect(viewPreferences[0]).toMatchObject({
      disableHtmlFullscreenWindowResize: true,
      sandbox: true,
      nodeIntegration: false
    });
    expect(host.addChildView).toHaveBeenCalledWith(view.port);
    const nestedHandler = view.windowOpen.mock.calls[0]?.[0] as
      ((details: { url: string }) => { action: "deny" }) | undefined;
    expect(nestedHandler?.({ url: "https://nested.test/" }))
      .toEqual({ action: "deny" });
    view.url = "https://popup.example.test/ready";
    view.emit("did-finish-load");
    await eventually(() => core.actions.some((action) => action.type === "pageReady"));
    host.observer!.closeRequested();
    await eventually(() => coordinator.activeCount === 0);
    expect(core.actions.map((action) => action.type)).toEqual([
      "nativeReady",
      "pageReady",
      "closeRequested",
      "nativeClosed"
    ]);
    const journal = coordinator.readLifecycleJournal();
    expect(journal.capacity).toBe(256);
    expect(journal.journalVersion).toBe(1);
    expect(journal.observations.map((observation) => observation.action)).toEqual([
      "nativeReady",
      "pageReady",
      "closeRequested",
      "nativeClosed"
    ]);
    expect(journal.observations[0]).toMatchObject({
      openOperationId: OPEN_OPERATION_ID,
      operationTerminal: false,
      parent: {
        ownerId: "role-1",
        ownerKind: "role",
        ownerNativeGeneration: 3,
        parentAttemptGeneration: "attempt-1",
        parentNativeHostId: 41,
        parentTabId: "tab-1",
        parentTopologyRevision: 9,
        parentWindowGeneration: 1,
        parentWindowId: "window-1",
        roleOwnerGeneration: 5
      },
      popupId: POPUP_ID,
      sequence: 1,
      terminalReason: null
    });
    expect(journal.observations.at(-1)).toMatchObject({
      action: "nativeClosed",
      closeReason: "user",
      completionScope: "nativeDestroyed",
      lifecycleTerminal: true,
      operationTerminal: true,
      phase: "closed",
      status: "applied",
      terminalReason: "user"
    });
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.observations)).toBe(true);
    expect(Object.isFrozen(journal.observations[0]?.parent)).toBe(true);
    expect(host.removeChildView).toHaveBeenCalledWith(view.port);
    expect(view.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it("forwards an exact bounded POST envelope in the parent Session", async () => {
    const { core, coordinator, host, source, view } = harness();
    const sourceBytes = Buffer.from("return_to=%2Fdashboard&token=fixture");
    let submittedBytes: Buffer | undefined;
    let submittedOwnedBuffer: Buffer | undefined;
    view.loadURL.mockImplementationOnce(async (_url, options) => {
      const entry = options?.postData?.[0];
      if (entry?.type === "rawData") {
        submittedBytes = Buffer.from(entry.bytes);
        submittedOwnedBuffer = entry.bytes;
      }
    });

    coordinator.requestOpen(source, {
      url: "https://popup.example.test/post",
      disposition: "new-window",
      frameName: "_blank",
      referrer: {
        url: "https://parent.example.test/",
        policy: "strict-origin-when-cross-origin"
      },
      postBody: {
        contentType: "application/x-www-form-urlencoded",
        data: [{ type: "rawData", bytes: sourceBytes }]
      }
    });

    await eventually(() => host.observer !== null && submittedBytes !== undefined);
    expect(core.commands[0]).toMatchObject({
      request: { hasPostBody: true },
      type: "browserPopupOpenAdmit"
    });
    expect(view.webContents.session).toBe(source.session);
    expect(view.loadURL).toHaveBeenCalledWith(
      "https://popup.example.test/post",
      {
        extraHeaders: "Content-Type: application/x-www-form-urlencoded",
        httpReferrer: {
          url: "https://parent.example.test/",
          policy: "strict-origin-when-cross-origin"
        },
        postData: [expect.objectContaining({ type: "rawData" })]
      }
    );
    expect(submittedBytes?.toString("utf8")).toBe(sourceBytes.toString("utf8"));
    expect(sourceBytes.toString("utf8")).toContain("token=fixture");
    await eventually(() => submittedOwnedBuffer?.every((byte) => byte === 0) === true);
    await coordinator.dispose();
  });

  it("preserves a multipart boundary and rejects unsafe POST envelopes", async () => {
    const accepted = harness();
    let submittedHeader: string | undefined;
    accepted.view.loadURL.mockImplementationOnce(async (_url, options) => {
      submittedHeader = options?.extraHeaders;
    });
    accepted.coordinator.requestOpen(accepted.source, {
      url: "https://popup.example.test/multipart",
      disposition: "new-window",
      frameName: "_blank",
      postBody: {
        boundary: "----RionFixtureBoundary",
        contentType: "multipart/form-data",
        data: [{ type: "rawData", bytes: Buffer.from("fixture multipart") }]
      }
    });
    await eventually(() => submittedHeader !== undefined);
    expect(submittedHeader).toBe(
      "Content-Type: multipart/form-data; boundary=----RionFixtureBoundary"
    );
    await accepted.coordinator.dispose();

    const rejected = harness();
    rejected.coordinator.requestOpen(rejected.source, {
      url: "https://popup.example.test/unsafe",
      disposition: "new-window",
      frameName: "_blank",
      postBody: {
        boundary: "unsafe\r\nboundary",
        contentType: "multipart/form-data",
        data: []
      }
    });
    await Promise.resolve();
    expect(rejected.core.commands).toEqual([]);
    expect(rejected.hostCreate).not.toHaveBeenCalled();
    expect(rejected.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_POPUP_POST_BODY_INVALID"
    }));
    await rejected.coordinator.dispose();
  });

  it("retains only the latest 256 exact Core lifecycle receipts", async () => {
    const roleOwners = Array.from({ length: 257 }, (_, index) => ({
      generation: 3,
      ownerGeneration: 5,
      roleId: indexedIdentifier("3", index + 1),
      tabId: "tab-1",
      windowId: "window-1"
    }));
    const { coordinator, hostCreate, source } = harness(roleOwners);
    for (const role of roleOwners) {
      const owner = { ...source, ownerId: role.roleId };
      open(coordinator, owner);
      await coordinator.retireOwner({
        ownerKind: "role",
        ownerId: role.roleId,
        nativeGeneration: role.generation
      });
    }

    const journal = coordinator.readLifecycleJournal();
    expect(journal.observations).toHaveLength(256);
    expect(journal.observations[0]).toMatchObject({
      action: "cancelled",
      operationTerminal: true,
      sequence: 2
    });
    expect(journal.observations.at(-1)).toMatchObject({
      action: "cancelled",
      operationTerminal: true,
      sequence: 257
    });
    expect(hostCreate).not.toHaveBeenCalled();
  });

  it("retains the exact WebContents handle through destructive View teardown", async () => {
    const { coordinator, host, onError, source, view } = harness();
    view.dropPortWebContentsOnDestroy = true;
    open(coordinator, source);
    await eventually(() => host.observer !== null && view.loadURL.mock.calls.length === 1);

    host.observer!.closeRequested();

    await eventually(() => coordinator.activeCount === 0 && view.destroyed);
    expect(onError).not.toHaveBeenCalled();
    expect(view.listeners.get("destroyed")?.size ?? 0).toBe(0);
  });

  it("contains HTML fullscreen inside the popup content envelope", async () => {
    const { core, coordinator, host, onError, source, view } = harness();
    open(coordinator, source);
    await eventually(() => host.observer !== null && view.loadURL.mock.calls.length === 1);
    view.url = "https://popup.example.test/ready";
    view.emit("did-finish-load");
    await eventually(() => core.actions.some((action) => action.type === "pageReady"));
    const actionsBeforePresentation = core.actions.length;

    view.emit("enter-html-full-screen");
    await eventually(() => view.setBounds.mock.calls.length >= 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onError).not.toHaveBeenCalled();
    view.emit("leave-html-full-screen");
    await eventually(() => view.setBounds.mock.calls.length >= 3);

    expect(view.setBounds.mock.calls.slice(-2)).toEqual([
      [{ x: 0, y: 40, width: 800, height: 560 }],
      [{ x: 0, y: 40, width: 800, height: 560 }]
    ]);
    expect(host.host.readProjection()).toMatchObject({
      bounds: { x: 120, y: 100, width: 800, height: 600 },
      presentation: "normal"
    });
    expect(core.actions).toHaveLength(actionsBeforePresentation);
    expect(onError).not.toHaveBeenCalled();

    await coordinator.dispose();
  });

  it("fails closed when contained fullscreen mutates the native popup envelope", async () => {
    const { coordinator, host, onError, source, view } = harness();
    open(coordinator, source);
    await eventually(() => host.observer !== null && view.loadURL.mock.calls.length === 1);
    host.bounds = { x: 0, y: 0, width: 1440, height: 900 };

    view.emit("enter-html-full-screen");

    await eventually(() => onError.mock.calls.length === 1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "ELECTRON_CHROMIUM_POPUP_CONTAINED_FULLSCREEN_HOST_CHANGED"
    });
    await eventually(() => coordinator.activeCount === 0);
  });

  it("retires the created View and host when projection fails after View creation", async () => {
    const { core, coordinator, host, onError, source, view } = harness();
    host.throwContentBounds = true;
    open(coordinator, source);
    await eventually(() => coordinator.activeCount === 0 && view.destroyed);
    expect(core.actions.map((action) => action.type)).toContain("cancelled");
    expect(host.host.close).toHaveBeenCalledOnce();
    expect(view.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalled();
  });

  it("retires the owned View after an unexpected native-host destruction", async () => {
    const { core, coordinator, host, source, view } = harness();
    open(coordinator, source);
    await eventually(() => host.observer !== null);
    host.unexpectedClose();
    await eventually(() => coordinator.activeCount === 0 && view.destroyed);
    expect(core.actions.map((action) => action.type)).toEqual([
      "nativeReady",
      "nativeClosed"
    ]);
    expect(core.phase).toBe("indeterminate");
    expect(host.removeChildView).toHaveBeenCalledWith(view.port);
  });

  it("fences an owner retired while its Core admission is in flight", async () => {
    const { core, coordinator, hostCreate, source } = harness();
    const gate = deferred();
    core.admissionGate = gate.promise;
    open(coordinator, source);
    const retirement = coordinator.retireOwner({
      ownerKind: "role",
      ownerId: "role-1",
      nativeGeneration: 3
    });
    gate.resolve();
    await retirement;
    expect(hostCreate).not.toHaveBeenCalled();
    expect(core.actions.map((action) => action.type)).toEqual(["cancelled"]);
    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.readLifecycleJournal().observations).toEqual([
      expect.objectContaining({
        action: "cancelled",
        failureCode: "CHROMIUM_POPUP_OWNER_RETIRED",
        lifecycleTerminal: true,
        openOperationId: OPEN_OPERATION_ID,
        operationTerminal: true,
        phase: "cancelled",
        status: "cancelled",
        terminalReason: "CHROMIUM_POPUP_OWNER_RETIRED"
      })
    ]);
  });

  it("temporarily fences and retires in-flight popups during owner reparent", async () => {
    const { core, coordinator, hostCreate, source } = harness();
    const gate = deferred();
    core.admissionGate = gate.promise;
    open(coordinator, source);
    const retirement = coordinator.retireOwnerPopupsForMove({
      ownerKind: "role",
      ownerId: "role-1",
      nativeGeneration: 3
    });
    gate.resolve();
    await retirement;
    expect(hostCreate).not.toHaveBeenCalled();
    expect(core.actions.map((action) => action.type)).toEqual(["cancelled"]);
    expect(coordinator.activeCount).toBe(0);

    // A move retires only the current popup generation; it must not permanently
    // fence the still-live owner after its native parent has changed.
    const secondGate = deferred();
    core.admissionGate = secondGate.promise;
    open(coordinator, source);
    await eventually(() => core.commands.filter(
      (command) => command.type === "browserPopupOpenAdmit"
    ).length === 2);
    const finalRetirement = coordinator.retireOwner({
      ownerKind: "role",
      ownerId: "role-1",
      nativeGeneration: 3
    });
    secondGate.resolve();
    await finalRetirement;
    expect(core.admissionCount).toBe(2);
    expect(hostCreate).not.toHaveBeenCalled();
  });

  it("rejects reload preparation after exact owner retirement without leaking a lease", async () => {
    const { coordinator } = harness();
    const owner = {
      ownerKind: "role" as const,
      ownerId: "role-1",
      nativeGeneration: 3
    };

    await coordinator.retireOwner(owner);

    await expect(coordinator.prepareOwnerReload(owner, "reload-after-retire"))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_POPUP_RELOAD_FENCE_INVALID"
      });
    expect(coordinator.releaseOwnerReload(owner, "reload-after-retire")).toBe(false);
  });

  it("rejects reload preparation while an owner move is active without leaking a lease", async () => {
    const { core, coordinator, source } = harness();
    const admissionGate = deferred();
    core.admissionGate = admissionGate.promise;
    open(coordinator, source);
    await eventually(() => core.commands.some(
      (command) => command.type === "browserPopupOpenAdmit"
    ));
    const owner = {
      ownerKind: "role" as const,
      ownerId: "role-1",
      nativeGeneration: 3
    };
    const movement = coordinator.retireOwnerPopupsForMove(owner);

    await expect(coordinator.prepareOwnerReload(owner, "reload-during-move"))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_POPUP_RELOAD_FENCE_INVALID"
      });
    expect(coordinator.releaseOwnerReload(owner, "reload-during-move")).toBe(false);

    admissionGate.resolve();
    await movement;
  });

  it("propagates an in-flight admission failure through reload drain evidence", async () => {
    const { core, coordinator, onError, source } = harness();
    const failure = {
      code: "CHROMIUM_POPUP_ADMISSION_FAILED",
      message: "Core could not terminalize popup admission."
    };
    core.admissionGate = Promise.reject(failure);
    open(coordinator, source);
    const owner = {
      ownerKind: "role" as const,
      ownerId: "role-1",
      nativeGeneration: 3
    };

    await expect(coordinator.prepareOwnerReload(owner, "reload-admission-failed"))
      .rejects.toBe(failure);
    expect(coordinator.releaseOwnerReload(owner, "reload-admission-failed"))
      .toBe(false);
    await eventually(() => onError.mock.calls.length === 1);
  });

  it("includes an in-flight admission in the exact popup zoom fanout", async () => {
    const { core, coordinator, source, view } = harness();
    const gate = deferred();
    core.admissionGate = gate.promise;
    open(coordinator, source);
    const transactionPromise = coordinator.prepareWindowZoomTransaction({
      windowId: "window-1",
      windowGeneration: 1,
      topologyRevision: 9,
      previousZoomFactor: 1,
      nextZoomFactor: 1.05
    });

    gate.resolve();
    const transaction = await transactionPromise;
    expect(transaction.popupSurfaceCount).toBe(1);
    transaction.apply();
    expect(view.zoomFactor).toBe(1.05);
    transaction.rollback();
    expect(view.zoomFactor).toBe(1);
    await coordinator.dispose();
  });

  it("leases a window before draining popup sequences and rejects later admissions", async () => {
    const { core, coordinator, host, hostCreate, source, view } = harness();
    const materializeGate = deferred();
    hostCreate.mockImplementationOnce(async () => {
      await materializeGate.promise;
      return {
        host: host.host,
        receipt: {
          platform: "windows" as const,
          hostKind: "electronBrowserWindow" as const,
          nativeHostId: 71,
          logicalWindowId: `popup-${POPUP_ID}`,
          windowGeneration: 1,
          topologyRevision: 1
        }
      };
    });
    open(coordinator, source);
    await eventually(() => core.admissionCount === 1 && hostCreate.mock.calls.length === 1);

    const transactionPromise = coordinator.prepareWindowZoomTransaction({
      windowId: "window-1",
      windowGeneration: 1,
      topologyRevision: 9,
      previousZoomFactor: 1,
      nextZoomFactor: 1.05
    });
    open(coordinator, source);
    await Promise.resolve();
    expect(core.commands.filter(
      (command) => command.type === "browserPopupOpenAdmit"
    )).toHaveLength(1);

    materializeGate.resolve();
    const transaction = await transactionPromise;
    expect(transaction.popupSurfaceCount).toBe(1);
    transaction.apply();
    expect(view.zoomFactor).toBe(1.05);
    transaction.commit();

    // Commit releases only the zoom lease; the live owner remains eligible.
    const admissionGate = deferred();
    core.admissionGate = admissionGate.promise;
    open(coordinator, source);
    await eventually(() => core.commands.filter(
      (command) => command.type === "browserPopupOpenAdmit"
    ).length === 2);
    const retirement = coordinator.retireOwner({
      ownerKind: "role",
      ownerId: "role-1",
      nativeGeneration: 3
    });
    admissionGate.resolve();
    await retirement;
    expect(core.admissionCount).toBe(2);
    expect(hostCreate).toHaveBeenCalledOnce();
  });

  it("records exact Core terminal evidence when a native-ready parent retires", async () => {
    const { coordinator, source, view } = harness();
    open(coordinator, source);
    await eventually(() => view.loadURL.mock.calls.length === 1);

    await coordinator.retireOwner({
      ownerKind: "role",
      ownerId: "role-1",
      nativeGeneration: 3
    });

    expect(coordinator.activeCount).toBe(0);
    const observations = coordinator.readLifecycleJournal().observations;
    expect(observations.map((observation) => observation.action)).toEqual([
      "nativeReady",
      "closeRequested",
      "nativeClosed"
    ]);
    expect(observations.at(-1)).toMatchObject({
      action: "nativeClosed",
      closeNative: false,
      closeReason: "parentRetired",
      completionScope: "nativeDestroyed",
      failureCode: "CHROMIUM_POPUP_OWNER_RETIRED",
      lifecycleTerminal: true,
      openOperationId: OPEN_OPERATION_ID,
      operationId: OPEN_OPERATION_ID,
      operationTerminal: true,
      parent: {
        ownerId: "role-1",
        ownerNativeGeneration: 3,
        parentTabId: "tab-1",
        parentWindowGeneration: 1,
        parentWindowId: "window-1"
      },
      phase: "cancelled",
      popupId: POPUP_ID,
      status: "cancelled",
      terminalReason: "parentRetired"
    });
  });

  it("fences disposal against an in-flight Core admission", async () => {
    const { core, coordinator, hostCreate, source } = harness();
    const gate = deferred();
    core.admissionGate = gate.promise;
    open(coordinator, source);
    const disposal = coordinator.dispose();
    gate.resolve();
    await disposal;
    expect(hostCreate).not.toHaveBeenCalled();
    expect(core.actions.map((action) => action.type)).toEqual(["cancelled"]);
    expect(coordinator.activeCount).toBe(0);
  });
});
