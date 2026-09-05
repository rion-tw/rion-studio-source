import { randomUUID } from "node:crypto";

import type {
  AppKitRuntimeEventActionRecord,
  AppKitRuntimeEventReceiptRecord,
  AppKitRuntimeEventRecord,
  AppKitRuntimeHostObservationRecord,
  BrowserWorkspaceDividerPointerPhase,
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord,
  CoreEffectRequest,
  CoreEvent
} from "../../shared/generated";
import { RionBridgeError, normalizeRionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type {
  AppKitRuntimeActionEvent,
  AppKitRuntimeHostIdentity,
  AppKitRuntimeLayoutEvent
} from "./macosAppKitRuntimeHostFactory";

type BridgeState = "open" | "draining" | "disposed";

interface AppKitCoreCommandPort extends ElectronCoreCommandPort {
  subscribeCoreEvents: (listener: (event: CoreEvent) => void) => () => void;
}

export interface MacosAppKitRuntimeEventBridgeInput {
  readonly core: AppKitCoreCommandPort;
  readonly preparePassiveEventDispatch?: (
    capturedHosts: readonly AppKitRuntimeHostObservationRecord[]
  ) => Promise<readonly AppKitRuntimeHostObservationRecord[]>;
  readonly onOpenTabMenu?: (
    event: Readonly<{
      hosts: readonly AppKitRuntimeHostObservationRecord[];
      identity: AppKitRuntimeHostIdentity;
      tabId: string;
    }>
  ) => Promise<void> | void;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export interface MacosAppKitRendererActionPort {
  beginSavedWindowRestore: (windowId: string) => void;
  finishSavedWindowRestore: (windowId: string) => Promise<void>;
  settleCurrentEvents: () => Promise<number>;
  activateTab: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  closeWindow: (
    hosts: readonly AppKitRuntimeHostObservationRecord[]
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  moveTab: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    input: Readonly<{
      sessionId: string;
      tabId: string;
      sourceWindowId: string;
      targetWindowId: string;
      beforeTabId?: string;
      orderedTabIds: readonly string[];
    }>
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  reorderTab: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    beforeTabId?: string
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  setTabHidden: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    hidden: boolean
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  setWindowVisibility: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    visible: boolean
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
  stopTab: (
    hosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    orderedTabIds: readonly string[]
  ) => Promise<AppKitRuntimeEventReceiptRecord>;
}

interface DragSession {
  readonly sessionId: string;
  readonly tabId: string;
  readonly sourceWindowId: string;
  readonly sourceIdentity: AppKitRuntimeHostIdentity;
}

interface WorkspaceDividerGesture {
  readonly gestureId: string;
  readonly tabId: string;
  readonly attemptGeneration: string;
  readonly dividerIndex: number;
  readonly identity: AppKitRuntimeHostIdentity;
  readonly windowId: string;
  readonly windowGeneration: number;
  currentTopologyRevision: number;
  lastPointerSequence: number;
}

interface NativeWorkspaceDividerPointer {
  readonly phase: BrowserWorkspaceDividerPointerPhase;
  readonly pointerSequence: number;
  readonly attemptGeneration: string;
  readonly dividerIndex: number;
  readonly axis: "horizontal" | "vertical";
  readonly requestedPosition?: number;
}

interface PendingVisibilityDispatch {
  readonly event: AppKitRuntimeEventRecord;
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

interface LayoutObservation {
  readonly hosts: readonly AppKitRuntimeHostObservationRecord[];
}

function bridgeError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_ID_INVALID",
      `The native AppKit ${field} identity is malformed.`
    );
  }
  return value;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined || value === null
    ? undefined
    : requireIdentifier(value, field);
}

function requireOrderedTabIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_ORDER_INVALID",
      "The native AppKit action omitted its bounded complete tab order."
    );
  }
  const ordered = value.map((tabId) => requireIdentifier(tabId, "ordered tab"));
  if (new Set(ordered).size !== ordered.length) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_ORDER_INVALID",
      "The native AppKit tab order contains duplicate identities."
    );
  }
  return ordered;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function requireNativeWorkspaceDividerPointer(
  value: unknown
): NativeWorkspaceDividerPointer {
  if (!isRecord(value)) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_POINTER_INVALID",
      "The native AppKit divider omitted its exact pointer evidence."
    );
  }
  const phase = value.phase;
  const move = phase === "move";
  if (
    !exactKeys(value, move
      ? ["phase", "pointerSequence", "attemptGeneration", "dividerIndex",
          "axis", "requestedPosition"]
      : ["phase", "pointerSequence", "attemptGeneration", "dividerIndex",
          "axis"]) ||
    !["start", "move", "end", "cancel"].includes(String(phase)) ||
    !Number.isSafeInteger(value.pointerSequence) ||
    (value.pointerSequence as number) < 1 ||
    !Number.isSafeInteger(value.dividerIndex) ||
    (value.dividerIndex as number) < 0 ||
    (value.axis !== "horizontal" && value.axis !== "vertical") ||
    (move && (
      typeof value.requestedPosition !== "number" ||
      !Number.isFinite(value.requestedPosition) ||
      value.requestedPosition < 0 || value.requestedPosition > 1
    ))
  ) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_POINTER_INVALID",
      "The native AppKit divider pointer phase, sequence, axis, or position is malformed."
    );
  }
  return Object.freeze({
    phase: phase as BrowserWorkspaceDividerPointerPhase,
    pointerSequence: value.pointerSequence as number,
    attemptGeneration: requireIdentifier(
      value.attemptGeneration,
      "workspace-divider attempt generation"
    ),
    dividerIndex: value.dividerIndex as number,
    axis: value.axis,
    ...(move ? { requestedPosition: value.requestedPosition as number } : {})
  });
}

function identitiesMatch(
  left: AppKitRuntimeHostIdentity,
  right: AppKitRuntimeHostIdentity
): boolean {
  return left.logicalWindowId === right.logicalWindowId &&
    left.launchGeneration === right.launchGeneration &&
    left.nativeGeneration === right.nativeGeneration;
}

function boundsMatch(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function displayTargetsMatch(
  left: AppKitRuntimeHostObservationRecord["targetDisplay"],
  right: AppKitRuntimeHostObservationRecord["targetDisplay"]
): boolean {
  const leftFingerprint = left.fingerprint;
  const rightFingerprint = right.fingerprint;
  if (left.id !== right.id || Boolean(leftFingerprint) !== Boolean(rightFingerprint)) {
    return false;
  }
  if (!leftFingerprint || !rightFingerprint) return true;
  return leftFingerprint.label === rightFingerprint.label &&
    boundsMatch(leftFingerprint.bounds, rightFingerprint.bounds) &&
    leftFingerprint.resolution.width === rightFingerprint.resolution.width &&
    leftFingerprint.resolution.height === rightFingerprint.resolution.height &&
    leftFingerprint.scaleFactor === rightFingerprint.scaleFactor &&
    leftFingerprint.isPrimary === rightFingerprint.isPrimary &&
    leftFingerprint.isInternal === rightFingerprint.isInternal;
}

function layoutObservationsMatch(
  left: readonly AppKitRuntimeHostObservationRecord[],
  right: readonly AppKitRuntimeHostObservationRecord[]
): boolean {
  return left.length === right.length && left.every((host, index) => {
    const other = right[index];
    return other !== undefined &&
      identitiesMatch(host.identity, other.identity) &&
      host.windowGeneration === other.windowGeneration &&
      host.topologyRevision === other.topologyRevision &&
      boundsMatch(host.contentBounds, other.contentBounds) &&
      boundsMatch(host.normalBounds, other.normalBounds) &&
      boundsMatch(host.savedWorkArea, other.savedWorkArea) &&
      displayTargetsMatch(host.targetDisplay, other.targetDisplay) &&
      host.presentation === other.presentation &&
      host.focused === other.focused &&
      host.minimized === other.minimized &&
      host.visible === other.visible;
  });
}

function validateHosts(
  identity: AppKitRuntimeHostIdentity,
  hosts: readonly AppKitRuntimeHostObservationRecord[]
): AppKitRuntimeHostObservationRecord[] {
  if (
    hosts.length < 1 ||
    hosts.length > 2 ||
    !identitiesMatch(hosts[0]!.identity, identity)
  ) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_HOST_STALE",
      "The native AppKit event lost its exact primary host observation."
    );
  }
  return hosts.map((host) => Object.freeze({
    ...host,
    identity: Object.freeze({ ...host.identity }),
    contentBounds: Object.freeze({ ...host.contentBounds }),
    normalBounds: Object.freeze({ ...host.normalBounds }),
    savedWorkArea: Object.freeze({ ...host.savedWorkArea }),
    targetDisplay: Object.freeze({ ...host.targetDisplay })
  }));
}

function validateReceipt(
  event: AppKitRuntimeEventRecord,
  receipt: AppKitRuntimeEventReceiptRecord
): void {
  if (
    receipt.eventId !== event.eventId ||
    receipt.adapterSequence !== event.adapterSequence ||
    !Number.isSafeInteger(receipt.windowGeneration) ||
    receipt.windowGeneration < 1 ||
    !Number.isSafeInteger(receipt.topologyRevision) ||
    receipt.topologyRevision < 1
  ) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_RECEIPT_INVALID",
      "Core returned a mismatched AppKit event terminal receipt."
    );
  }
  if (receipt.status === "applied" && !receipt.nativeApplied) {
    throw bridgeError(
      "ELECTRON_MACOS_APPKIT_EVENT_RECEIPT_INVALID",
      "Core marked an AppKit event applied without exact native evidence."
    );
  }
  if (
    receipt.status === "degraded" ||
    receipt.status === "failed" ||
    receipt.status === "indeterminate"
  ) {
    throw bridgeError(
      receipt.failureCode ?? "ELECTRON_MACOS_APPKIT_EVENT_NOT_APPLIED",
      "Core could not apply the exact native AppKit event."
    );
  }
}

function isExactVisibilityDispatch(
  event: AppKitRuntimeEventRecord,
  effect: CoreEffectRequest
): boolean {
  if (event.action.type !== "setWindowVisibility") return false;
  const primary = event.hosts[0];
  const action = effect.action;
  if (!primary || action.type !== "embeddedSetRuntimeWindowVisibility") {
    return false;
  }
  const appkitIdentity = action.appkitIdentity;
  return effect.parentOperationId === event.eventId &&
    effect.completionPolicy === "eventBound" &&
    effect.deadlineMs === undefined &&
    effect.target.kind === "app" &&
    effect.target.handleId === primary.identity.logicalWindowId &&
    action.windowId === primary.identity.logicalWindowId &&
    action.windowGeneration === primary.windowGeneration &&
    action.topologyRevision === primary.topologyRevision &&
    Number.isSafeInteger(action.lifecycleEpoch) &&
    action.lifecycleEpoch > 0 &&
    action.visible === event.action.visible &&
    appkitIdentity !== undefined &&
    identitiesMatch(appkitIdentity, primary.identity);
}

function validateWorkspaceDividerReceipt(
  event: BrowserWorkspaceDividerPointerRecord,
  receipt: BrowserWorkspaceDividerPointerReceiptRecord
): void {
  const expectedStatus = event.phase === "cancel" ? "cancelled" : "applied";
  if (
    receipt.eventId !== event.eventId ||
    receipt.gestureId !== event.gestureId ||
    receipt.pointerSequence !== event.pointerSequence ||
    receipt.phase !== event.phase ||
    receipt.status !== expectedStatus ||
    receipt.windowGeneration !== event.windowGeneration ||
    !Number.isSafeInteger(receipt.topologyRevision) ||
    receipt.topologyRevision < event.topologyRevision ||
    (event.phase !== "move" && receipt.changed) ||
    (event.phase === "end" && !receipt.durable) ||
    (event.phase !== "end" && receipt.durable)
  ) {
    throw bridgeError(
      receipt.failureCode ?? "ELECTRON_MACOS_APPKIT_DIVIDER_RECEIPT_INVALID",
      "Core returned a mismatched workspace-divider terminal receipt."
    );
  }
}

/**
 * Privileged Electron-main lane for authoritative AppKit callbacks.
 *
 * Native callbacks capture exact host evidence synchronously. This lane then
 * preserves callback order through Core and accepts completion only from the
 * typed event-bound receipt. It is never exposed through preload or renderer.
 */
export class MacosAppKitRuntimeEventBridge
implements MacosAppKitRendererActionPort {
  readonly #input: MacosAppKitRuntimeEventBridgeInput;
  readonly #dragSessions = new Map<string, DragSession>();
  readonly #workspaceDividerGestures = new Map<
    string,
    WorkspaceDividerGesture
  >();
  readonly #layoutSequences = new Map<string, number>();
  readonly #layoutObservations = new Map<string, LayoutObservation>();
  readonly #deferredLayoutWindowIds = new Set<string>();
  readonly #deferredLayouts = new Map<string, LayoutObservation>();
  readonly #placementSequences = new Map<string, number>();
  readonly #pendingVisibilityDispatches = new Map<
    string,
    PendingVisibilityDispatch
  >();
  readonly #terminalResults = new Set<Promise<unknown>>();
  readonly #unsubscribeCoreEvents: () => void;
  #adapterSequence = 0;
  #disposePromise: Promise<void> | null = null;
  #lane: Promise<void> = Promise.resolve();
  #state: BridgeState = "open";

  constructor(input: MacosAppKitRuntimeEventBridgeInput) {
    this.#input = input;
    this.#unsubscribeCoreEvents = input.core.subscribeCoreEvents(
      (event) => this.#receiveCoreEvent(event)
    );
  }

  receiveAction(event: AppKitRuntimeActionEvent): void {
    if (this.#state !== "open") return;
    try {
      this.#receiveAction(event);
    } catch (error) {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_EVENT_INVALID"
      ));
    }
  }

  receiveLayout(event: AppKitRuntimeLayoutEvent): void {
    if (this.#state !== "open") return;
    try {
      const hosts = validateHosts(event.identity, event.hosts);
      const key = this.#hostSequenceKey(event.identity);
      if (this.#deferredLayoutWindowIds.has(event.identity.logicalWindowId)) {
        this.#deferredLayouts.set(key, Object.freeze({ hosts }));
        return;
      }
      void this.#submitLayoutObservation(key, event.identity, hosts).catch(
        (error: unknown) => {
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_MACOS_APPKIT_EVENT_FAILED"
          ));
        }
      );
    } catch (error) {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_LAYOUT_EVENT_INVALID"
      ));
    }
  }

  beginSavedWindowRestore(windowId: string): void {
    if (this.#state !== "open") {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_BRIDGE_DRAINING",
        "The AppKit event bridge cannot begin a saved-window restore while draining."
      );
    }
    this.#deferredLayoutWindowIds.add(requireIdentifier(windowId, "window"));
  }

  async finishSavedWindowRestore(windowId: string): Promise<void> {
    const exactWindowId = requireIdentifier(windowId, "window");
    if (
      this.#state !== "open" ||
      !this.#deferredLayoutWindowIds.has(exactWindowId)
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_RESTORE_LAYOUT_STALE",
        "The AppKit saved-window layout fence is no longer current."
      );
    }
    // EventBound coalescing: hidden restore callbacks are presentation-only
    // observations. Drain their latest exact value after the restore reaches a
    // terminal topology so they cannot overtake ownership or reorder effects.
    while (true) {
      const deferred = [...this.#deferredLayouts.entries()].filter(
        ([, observation]) =>
          observation.hosts[0]?.identity.logicalWindowId === exactWindowId
      );
      if (deferred.length === 0) break;
      for (const [key, observation] of deferred) {
        this.#deferredLayouts.delete(key);
        const identity = observation.hosts[0]!.identity;
        await this.#submitLayoutObservation(key, identity, observation.hosts);
      }
    }
    this.#deferredLayoutWindowIds.delete(exactWindowId);
  }

  receiveCloseRequested(
    identity: AppKitRuntimeHostIdentity,
    rawHosts: readonly AppKitRuntimeHostObservationRecord[]
  ): void {
    if (this.#state !== "open") return;
    try {
      this.#enqueue(validateHosts(identity, rawHosts), { type: "closeWindow" });
    } catch (error) {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_CLOSE_EVENT_INVALID"
      ));
    }
  }

  activateTab(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    const hosts = this.#rendererHosts(rawHosts);
    return this.#submit(hosts, {
      type: "activate",
      tabId: requireIdentifier(tabId, "tab")
    });
  }

  closeWindow(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[]
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    return this.#submit(this.#rendererHosts(rawHosts), { type: "closeWindow" });
  }

  moveTab(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    input: Readonly<{
      sessionId: string;
      tabId: string;
      sourceWindowId: string;
      targetWindowId: string;
      beforeTabId?: string;
      orderedTabIds: readonly string[];
    }>
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    const hosts = this.#rendererHosts(rawHosts);
    const sourceWindowId = requireIdentifier(input.sourceWindowId, "source window");
    const targetWindowId = requireIdentifier(input.targetWindowId, "target window");
    const observedWindowIds = new Set(hosts.map(
      (host) => host.identity.logicalWindowId
    ));
    if (
      !observedWindowIds.has(sourceWindowId) ||
      !observedWindowIds.has(targetWindowId) ||
      hosts.length !== (sourceWindowId === targetWindowId ? 1 : 2)
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DRAG_HOST_FENCE_MISSING",
        "The renderer action lost an exact source or target AppKit host observation."
      );
    }
    return this.#submit(hosts, {
      type: "move",
      sessionId: requireIdentifier(input.sessionId, "drag session"),
      tabId: requireIdentifier(input.tabId, "tab"),
      sourceWindowId,
      targetWindowId,
      ...(input.beforeTabId === undefined
        ? {}
        : { beforeTabId: requireIdentifier(input.beforeTabId, "before tab") }),
      orderedTabIds: requireOrderedTabIds(input.orderedTabIds),
      phase: "drop"
    });
  }

  reorderTab(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    beforeTabId?: string
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    const hosts = this.#rendererHosts(rawHosts);
    return this.#submit(hosts, {
      type: "reorder",
      tabId: requireIdentifier(tabId, "tab"),
      ...(beforeTabId === undefined
        ? {}
        : { beforeTabId: requireIdentifier(beforeTabId, "before tab") })
    });
  }

  setTabHidden(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    hidden: boolean
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    return this.#submit(this.#rendererHosts(rawHosts), {
      type: "setTabHidden",
      tabId: requireIdentifier(tabId, "tab"),
      hidden
    });
  }

  setWindowVisibility(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    visible: boolean
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    return this.#submit(this.#rendererHosts(rawHosts), {
      type: "setWindowVisibility",
      visible
    });
  }

  stopTab(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[],
    tabId: string,
    orderedTabIds: readonly string[]
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    const hosts = this.#rendererHosts(rawHosts);
    return this.#submit(hosts, {
      type: "stop",
      tabId: requireIdentifier(tabId, "tab"),
      orderedTabIds: requireOrderedTabIds(orderedTabIds)
    });
  }

  /** Waits only for AppKit callbacks admitted before this event-bound fence. */
  async settleCurrentEvents(): Promise<number> {
    await this.#lane;
    return this.#adapterSequence;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#state = "draining";
    this.#disposePromise = this.#lane.then(async () => {
      await Promise.allSettled([...this.#terminalResults]);
      this.#dragSessions.clear();
      this.#workspaceDividerGestures.clear();
      this.#layoutObservations.clear();
      this.#deferredLayoutWindowIds.clear();
      this.#deferredLayouts.clear();
      this.#pendingVisibilityDispatches.clear();
      this.#unsubscribeCoreEvents();
      this.#state = "disposed";
    });
    return this.#disposePromise;
  }

  #receiveAction(event: AppKitRuntimeActionEvent): void {
    const hosts = validateHosts(event.identity, event.hosts);
    const actionType = requireIdentifier(event.action.type, "action type");
    const sourceWindowId = requireIdentifier(
      event.action.sourceWindowId,
      "source window"
    );
    if (sourceWindowId !== event.identity.logicalWindowId && actionType !== "tabDragHover" && actionType !== "tabDragDrop") {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_SOURCE_STALE",
        "The AppKit action source does not match the emitting host generation."
      );
    }
    switch (actionType) {
      case "activate":
        this.#enqueue(hosts, {
          type: "activate",
          tabId: requireIdentifier(event.action.tabId, "tab")
        });
        return;
      case "stop":
        this.#enqueue(hosts, {
          type: "stop",
          tabId: requireIdentifier(event.action.tabId, "tab"),
          orderedTabIds: requireOrderedTabIds(event.action.orderedTabIds)
        });
        return;
      case "reorder":
        this.#enqueue(hosts, {
          type: "reorder",
          tabId: requireIdentifier(event.action.tabId, "tab"),
          ...(optionalIdentifier(event.action.beforeTabId, "before tab") === undefined
            ? {}
            : { beforeTabId: optionalIdentifier(event.action.beforeTabId, "before tab") })
        });
        return;
      case "openTabMenu": {
        if (!this.#input.onOpenTabMenu) {
          throw bridgeError(
            "ELECTRON_MACOS_APPKIT_TAB_MENU_UNAVAILABLE",
            "The retained AppKit tab menu has no privileged native handler."
          );
        }
        const request = Promise.resolve(this.#input.onOpenTabMenu(Object.freeze({
          hosts,
          identity: event.identity,
          tabId: requireIdentifier(event.action.tabId, "tab")
        })));
        void request.catch((error: unknown) => {
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_MACOS_APPKIT_TAB_MENU_FAILED"
          ));
        });
        return;
      }
      case "tabDragStart":
        this.#startDragSession(event, sourceWindowId);
        return;
      case "tabDragHover":
      case "tabDragDrop":
        this.#moveDragSession(event, hosts, actionType === "tabDragDrop" ? "drop" : "hover");
        return;
      case "tabDragMove":
        this.#requireDragSession(event, sourceWindowId);
        return;
      case "tabDragEnd": {
        const session = this.#requireDragSession(event, sourceWindowId);
        this.#dragSessions.delete(session.sessionId);
        return;
      }
      case "workspaceDividerPointer":
        this.#receiveWorkspaceDividerPointer(event, hosts, sourceWindowId);
        return;
      case "windowPlacementChanged":
      case "windowFocusChanged":
        this.#enqueue(hosts, {
          type: "windowState",
          placementSequence: this.#nextHostSequence(
            this.#placementSequences,
            event.identity,
            "placement"
          )
        });
        return;
      default:
        throw bridgeError(
          "ELECTRON_MACOS_APPKIT_ACTION_UNSUPPORTED",
          `The AppKit action ${actionType} is outside the migrated privileged event lane.`
        );
    }
  }

  #startDragSession(
    event: AppKitRuntimeActionEvent,
    sourceWindowId: string
  ): void {
    const sessionId = requireIdentifier(event.action.sessionId, "drag session");
    if (this.#dragSessions.has(sessionId)) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DRAG_SESSION_CONFLICT",
        "The AppKit drag session identity is already active."
      );
    }
    this.#dragSessions.set(sessionId, Object.freeze({
      sessionId,
      tabId: requireIdentifier(event.action.tabId, "drag tab"),
      sourceWindowId,
      sourceIdentity: event.identity
    }));
  }

  #receiveWorkspaceDividerPointer(
    event: AppKitRuntimeActionEvent,
    hosts: AppKitRuntimeHostObservationRecord[],
    sourceWindowId: string
  ): void {
    const pointer = requireNativeWorkspaceDividerPointer(
      event.action.statusIdentity
    );
    const gestureId = requireIdentifier(
      event.action.sessionId,
      "workspace-divider gesture"
    );
    const tabId = requireIdentifier(event.action.tabId, "workspace-divider tab");
    const primary = hosts[0]!;
    if (
      sourceWindowId !== event.identity.logicalWindowId ||
      primary.identity.logicalWindowId !== sourceWindowId ||
      !identitiesMatch(primary.identity, event.identity)
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DIVIDER_HOST_STALE",
        "The native workspace divider lost its exact retained AppKit host."
      );
    }
    let gesture = this.#workspaceDividerGestures.get(gestureId);
    if (pointer.phase === "start") {
      if (
        gesture || pointer.pointerSequence !== 1 ||
        [...this.#workspaceDividerGestures.values()].some((candidate) =>
          candidate.windowId === sourceWindowId && candidate.tabId === tabId &&
          candidate.dividerIndex === pointer.dividerIndex
        )
      ) {
        throw bridgeError(
          "ELECTRON_MACOS_APPKIT_DIVIDER_GESTURE_CONFLICT",
          "The native workspace divider gesture conflicts with a live pointer owner."
        );
      }
      gesture = {
        gestureId,
        tabId,
        attemptGeneration: pointer.attemptGeneration,
        dividerIndex: pointer.dividerIndex,
        identity: event.identity,
        windowId: sourceWindowId,
        windowGeneration: primary.windowGeneration,
        currentTopologyRevision: primary.topologyRevision,
        lastPointerSequence: pointer.pointerSequence
      };
      this.#workspaceDividerGestures.set(gestureId, gesture);
    } else if (
      !gesture || gesture.tabId !== tabId ||
      gesture.attemptGeneration !== pointer.attemptGeneration ||
      gesture.dividerIndex !== pointer.dividerIndex ||
      gesture.windowId !== sourceWindowId ||
      gesture.windowGeneration !== primary.windowGeneration ||
      !identitiesMatch(gesture.identity, event.identity) ||
      pointer.pointerSequence !== gesture.lastPointerSequence + 1
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DIVIDER_GESTURE_STALE",
        "The native workspace divider pointer lost its monotonic gesture fence."
      );
    } else {
      gesture.lastPointerSequence = pointer.pointerSequence;
    }
    this.#enqueueWorkspaceDivider(gesture, primary, pointer);
  }

  #enqueueWorkspaceDivider(
    gesture: WorkspaceDividerGesture,
    nativeHost: AppKitRuntimeHostObservationRecord,
    pointer: NativeWorkspaceDividerPointer
  ): void {
    const sequence = this.#nextAdapterSequence();
    const result = this.#lane
      .catch(() => undefined)
      .then(async () => {
        if (this.#state === "disposed") {
          throw bridgeError(
            "ELECTRON_MACOS_APPKIT_EVENT_BRIDGE_DISPOSED",
            "The AppKit divider lane was disposed before completion."
          );
        }
        const current = this.#workspaceDividerGestures.get(gesture.gestureId);
        if (current !== gesture) {
          throw bridgeError(
            "ELECTRON_MACOS_APPKIT_DIVIDER_GESTURE_STALE",
            "The AppKit divider gesture terminalized before its queued pointer event."
          );
        }
        const appkitHost = Object.freeze({
          ...nativeHost,
          identity: Object.freeze({ ...nativeHost.identity }),
          topologyRevision: gesture.currentTopologyRevision,
          windowGeneration: gesture.windowGeneration,
          contentBounds: Object.freeze({ ...nativeHost.contentBounds }),
          normalBounds: Object.freeze({ ...nativeHost.normalBounds }),
          savedWorkArea: Object.freeze({ ...nativeHost.savedWorkArea }),
          targetDisplay: Object.freeze({ ...nativeHost.targetDisplay })
        });
        const coreEvent = Object.freeze({
          eventId: randomUUID(),
          gestureId: gesture.gestureId,
          pointerSequence: pointer.pointerSequence,
          phase: pointer.phase,
          platform: "macos",
          hostIdentity: Object.freeze({
            kind: "appkit",
            identity: Object.freeze({ ...gesture.identity })
          }),
          appkitHost,
          appkitAdapterSequence: sequence,
          windowId: gesture.windowId,
          tabId: gesture.tabId,
          attemptGeneration: gesture.attemptGeneration,
          windowGeneration: gesture.windowGeneration,
          topologyRevision: gesture.currentTopologyRevision,
          dividerIndex: gesture.dividerIndex,
          ...(pointer.requestedPosition === undefined
            ? {}
            : { requestedPosition: pointer.requestedPosition })
        } satisfies BrowserWorkspaceDividerPointerRecord);
        const receipt = await this.#input.core.invoke({
          type: "browserWorkspaceDividerPointer",
          event: coreEvent
        });
        validateWorkspaceDividerReceipt(coreEvent, receipt);
        gesture.currentTopologyRevision = receipt.topologyRevision;
        if (pointer.phase === "end" || pointer.phase === "cancel") {
          this.#workspaceDividerGestures.delete(gesture.gestureId);
        }
      });
    this.#lane = result.then(() => undefined, () => undefined);
    void result.catch((error: unknown) => {
      this.#workspaceDividerGestures.delete(gesture.gestureId);
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_DIVIDER_EVENT_FAILED"
      ));
    });
  }

  #requireDragSession(
    event: AppKitRuntimeActionEvent,
    sourceWindowId: string
  ): DragSession {
    const sessionId = requireIdentifier(event.action.sessionId, "drag session");
    const session = this.#dragSessions.get(sessionId);
    if (
      !session ||
      session.sourceWindowId !== sourceWindowId ||
      !identitiesMatch(session.sourceIdentity, event.hosts.find(
        (host) => host.identity.logicalWindowId === sourceWindowId
      )?.identity ?? event.identity)
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DRAG_SESSION_STALE",
        "The AppKit drag session lost its exact source host generation."
      );
    }
    return session;
  }

  #moveDragSession(
    event: AppKitRuntimeActionEvent,
    hosts: AppKitRuntimeHostObservationRecord[],
    phase: "hover" | "drop"
  ): void {
    const sourceWindowId = requireIdentifier(
      event.action.sourceWindowId,
      "drag source window"
    );
    const session = this.#requireDragSession(event, sourceWindowId);
    const tabId = requireIdentifier(event.action.tabId, "drag tab");
    if (tabId !== session.tabId) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_DRAG_TAB_STALE",
        "The AppKit drag tab no longer matches its native session."
      );
    }
    const targetWindowId = requireIdentifier(
      event.action.targetWindowId ?? event.action.windowId,
      "drag target window"
    );
    this.#enqueue(hosts, {
      type: "move",
      sessionId: session.sessionId,
      tabId,
      sourceWindowId,
      targetWindowId,
      ...(optionalIdentifier(event.action.beforeTabId, "before tab") === undefined
        ? {}
        : { beforeTabId: optionalIdentifier(event.action.beforeTabId, "before tab") }),
      orderedTabIds: requireOrderedTabIds(event.action.orderedTabIds),
      phase
    });
    if (phase === "drop") this.#dragSessions.delete(session.sessionId);
  }

  #enqueue(
    hosts: AppKitRuntimeHostObservationRecord[],
    action: AppKitRuntimeEventActionRecord
  ): void {
    void this.#submit(hosts, action).catch((error: unknown) => {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_EVENT_FAILED"
      ));
    });
  }

  #submit(
    hosts: AppKitRuntimeHostObservationRecord[],
    action: AppKitRuntimeEventActionRecord
  ): Promise<AppKitRuntimeEventReceiptRecord> {
    if (this.#state !== "open") {
      return Promise.reject(bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_BRIDGE_DRAINING",
        "The privileged AppKit event lane is no longer accepting actions."
      ));
    }
    const sequence = this.#nextAdapterSequence();
    const start = this.#lane
      .catch(() => undefined)
      .then(async () => {
        if (this.#state === "disposed") {
          throw bridgeError(
            "ELECTRON_MACOS_APPKIT_EVENT_BRIDGE_DISPOSED",
            "The privileged AppKit event lane was disposed before completion."
          );
        }
        const currentHosts = action.type === "layout" || action.type === "windowState"
          ? await this.#preparePassiveHostsForDispatch(hosts)
          : hosts;
        const event = Object.freeze({
          eventId: randomUUID(),
          adapterSequence: sequence,
          hosts: currentHosts,
          action
        } satisfies AppKitRuntimeEventRecord);
        const dispatch = action.type === "setWindowVisibility"
          ? this.#armVisibilityDispatch(event)
          : undefined;
        let invocation: Promise<AppKitRuntimeEventReceiptRecord>;
        try {
          invocation = this.#input.core.invoke({
            type: "browserAppKitRuntimeEvent",
            event
          });
        } catch (error) {
          if (dispatch) this.#clearVisibilityDispatch(event.eventId, dispatch);
          throw error;
        }
        const terminal = invocation.then((receipt) => {
          validateReceipt(event, receipt);
          return receipt;
        });
        if (dispatch) {
          void terminal.then(
            () => this.#clearVisibilityDispatch(event.eventId, dispatch),
            () => this.#clearVisibilityDispatch(event.eventId, dispatch)
          );
        }
        const release = dispatch
          ? new Promise<void>((resolve, reject) => {
              void dispatch.promise.then(resolve, reject);
              void terminal.then(() => resolve(), () => resolve());
            })
          : terminal.then(() => undefined);
        return {
          release,
          terminal
        };
      });
    const result = start.then(({ terminal }) => terminal);
    this.#lane = start
      .then(({ release }) => release)
      .then(() => undefined, () => undefined);
    this.#terminalResults.add(result);
    void result.then(
      () => this.#terminalResults.delete(result),
      () => this.#terminalResults.delete(result)
    );
    return result;
  }

  async #preparePassiveHostsForDispatch(
    capturedHosts: readonly AppKitRuntimeHostObservationRecord[]
  ): Promise<AppKitRuntimeHostObservationRecord[]> {
    const refreshed = await this.#input.preparePassiveEventDispatch?.(
      capturedHosts
    ) ?? capturedHosts;
    if (
      refreshed.length !== capturedHosts.length ||
      refreshed.some((host, index) => !identitiesMatch(
        host.identity,
        capturedHosts[index]!.identity
      ))
    ) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_HOST_STALE",
        "The native AppKit event host changed before its ordered Core dispatch."
      );
    }
    return validateHosts(refreshed[0]!.identity, refreshed);
  }

  #submitLayoutObservation(
    key: string,
    identity: AppKitRuntimeHostIdentity,
    hosts: readonly AppKitRuntimeHostObservationRecord[]
  ): Promise<void> {
    const previous = this.#layoutObservations.get(key);
    if (previous && layoutObservationsMatch(previous.hosts, hosts)) {
      return Promise.resolve();
    }
    const observation = Object.freeze({ hosts });
    this.#layoutObservations.set(key, observation);
    // EventBound coalescing: an exact repeat contains no new authoritative
    // host truth. Remember it before dispatch so native layout callbacks
    // cannot fill the ordered Core lane while the first receipt is pending.
    return this.#submit([...hosts], {
      type: "layout",
      layoutSequence: this.#nextHostSequence(
        this.#layoutSequences,
        identity,
        "layout"
      )
    }).then(() => undefined, (error: unknown) => {
      if (this.#layoutObservations.get(key) === observation) {
        this.#layoutObservations.delete(key);
      }
      throw error;
    });
  }

  #armVisibilityDispatch(
    event: AppKitRuntimeEventRecord
  ): PendingVisibilityDispatch {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = {
      event,
      promise: new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      }),
      reject: (error: unknown) => reject(error),
      resolve: () => resolve()
    } satisfies PendingVisibilityDispatch;
    this.#pendingVisibilityDispatches.set(event.eventId, pending);
    return pending;
  }

  #clearVisibilityDispatch(
    eventId: string,
    pending: PendingVisibilityDispatch
  ): void {
    if (this.#pendingVisibilityDispatches.get(eventId) === pending) {
      this.#pendingVisibilityDispatches.delete(eventId);
    }
  }

  #receiveCoreEvent(event: CoreEvent): void {
    if (event.type === "shutdown") {
      const error = bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_STREAM_CLOSED",
        "Core stopped before the AppKit visibility effect was dispatched."
      );
      for (const pending of this.#pendingVisibilityDispatches.values()) {
        pending.reject(error);
      }
      this.#pendingVisibilityDispatches.clear();
      return;
    }
    if (event.type !== "coreEffects") return;
    for (const effect of event.effects) {
      const eventId = effect.parentOperationId;
      if (!eventId) continue;
      const pending = this.#pendingVisibilityDispatches.get(eventId);
      if (!pending) continue;
      this.#pendingVisibilityDispatches.delete(eventId);
      if (isExactVisibilityDispatch(pending.event, effect)) {
        pending.resolve();
        continue;
      }
      const error = bridgeError(
        "ELECTRON_MACOS_APPKIT_VISIBILITY_DISPATCH_INVALID",
        "Core emitted mismatched AppKit visibility effect-dispatch evidence."
      );
      pending.reject(error);
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_VISIBILITY_DISPATCH_INVALID"
      ));
    }
  }

  #rendererHosts(
    rawHosts: readonly AppKitRuntimeHostObservationRecord[]
  ): AppKitRuntimeHostObservationRecord[] {
    const primary = rawHosts[0];
    if (!primary) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_HOST_STALE",
        "The renderer action has no exact primary AppKit host observation."
      );
    }
    return validateHosts(primary.identity, rawHosts);
  }

  #nextAdapterSequence(): number {
    const next = this.#adapterSequence + 1;
    if (!Number.isSafeInteger(next)) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_SEQUENCE_EXHAUSTED",
        "The AppKit adapter event sequence is exhausted."
      );
    }
    this.#adapterSequence = next;
    return next;
  }

  #nextHostSequence(
    sequences: Map<string, number>,
    identity: AppKitRuntimeHostIdentity,
    field: string
  ): number {
    const key = this.#hostSequenceKey(identity);
    const next = (sequences.get(key) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) {
      throw bridgeError(
        "ELECTRON_MACOS_APPKIT_EVENT_SEQUENCE_EXHAUSTED",
        `The AppKit ${field} sequence is exhausted.`
      );
    }
    sequences.set(key, next);
    return next;
  }

  #hostSequenceKey(identity: AppKitRuntimeHostIdentity): string {
    return `${identity.logicalWindowId}\u0000${identity.launchGeneration}\u0000${identity.nativeGeneration}`;
  }
}
