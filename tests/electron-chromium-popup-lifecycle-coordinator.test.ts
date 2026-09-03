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
import type { ChromiumPopupOwnerSource } from
  "../src/electron/main/chromiumPopupPorts";
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
      openerPolicy: "isolatedNoopener",
      referrerUrl: request.referrerUrl,
      referrerPolicy: request.referrerPolicy
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
  readonly loadURL = vi.fn(async () => undefined);
  readonly setBounds = vi.fn((bounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>) => {
    this.bounds = { ...bounds };
  });
  readonly setVisible = vi.fn();
  readonly windowOpen = vi.fn();
  readonly webContents: ChromiumRoleSurfaceWebContentsPort;
  readonly port: ChromiumRoleWebContentsViewPort;
  dropPortWebContentsOnDestroy = false;
  destroyed = false;
  bounds = { x: 0, y: 0, width: 800, height: 560 };
  url = "about:blank";
  zoomFactor = 1;

  constructor(readonly session: object) {
    this.webContents = {
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
}]): {
  core: FakeCore;
  coordinator: ChromiumPopupLifecycleCoordinator;
  host: FakeHost;
  hostCreate: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
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
  const source = {
    ownerKind: "role",
    ownerId: "role-1",
    nativeGeneration: 3,
    parent,
    session
  } as unknown as ChromiumPopupOwnerSource;
  const host = new FakeHost();
  const view = new FakeView(session);
  const hostCreate = vi.fn(async () => ({
    host: host.host,
    receipt: {
      platform: "windows" as const,
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
      roles: roleOwners,
      webSurfaces: []
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
    }
  });
}

describe("ChromiumPopupLifecycleCoordinator", () => {
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
