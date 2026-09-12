import { randomUUID } from "node:crypto";

import type {
  ChromiumPopupAdmissionRecord,
  ChromiumPopupCloseReason,
  ChromiumPopupLifecycleActionRecord,
  ChromiumPopupLifecycleEventRecord,
  ChromiumPopupLifecycleReceiptRecord,
  ChromiumPopupNativeHostReceiptRecord,
  ChromiumPopupOpenRequestRecord,
  ChromiumPopupParentFenceRecord,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumPopupOwnerLifecyclePort,
  ChromiumPopupOwnerSource,
  ChromiumPopupWindowPort,
  ChromiumWindowOpenDetails,
  ChromiumWindowOpenHandlerResponse
} from "./chromiumPopupPorts";
import {
  buildChromiumPopupOpenRequest,
  buildChromiumPopupWindowOptions,
  canonicalChromiumPopupRemoteUrl,
  supportedChromiumWindowOpen,
  trustedChromiumPopupTitle
} from "./chromiumPopupPolicy";
import {
  exactChromiumPopupOpenerFrameEqual,
  exactChromiumPopupParentResolutionEqual,
  resolveChromiumPopupParent
} from "./chromiumPopupParent";
import type { ChromiumPopupParentResolution } from "./chromiumPopupParent";
export { resolveChromiumPopupParent } from "./chromiumPopupParent";
export type { ChromiumPopupParentResolution } from "./chromiumPopupParent";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort
} from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimePopupZoomInput,
  ChromiumRuntimePopupZoomPort,
  ChromiumRuntimePopupZoomTransaction
} from "./chromiumRuntimeWindowZoomPorts";

type CoordinatorState = "open" | "draining" | "closed";
type PopupState = "admitting" | "nativeReady" | "ready" | "closing" | "terminal";

const MAX_POPUPS = 64;
const MAX_RETIRED_OWNER_FENCES = 256;
const POPUP_LIFECYCLE_JOURNAL_CAPACITY = 256;

export interface ChromiumPopupLifecycleJournalObservation {
  readonly action: ChromiumPopupLifecycleActionRecord["type"];
  readonly closeNative: boolean;
  readonly closeReason: ChromiumPopupCloseReason | null;
  readonly completionScope: ChromiumPopupLifecycleReceiptRecord["completionScope"];
  readonly eventId: string;
  readonly failureCode: string | null;
  readonly lifecycleRevision: number;
  readonly lifecycleTerminal: boolean;
  readonly openOperationId: string;
  readonly operationId: string;
  readonly operationTerminal: boolean;
  readonly parent: ChromiumPopupParentFenceRecord;
  readonly phase: ChromiumPopupLifecycleReceiptRecord["phase"];
  readonly popupId: string;
  readonly sequence: number;
  readonly status: ChromiumPopupLifecycleReceiptRecord["status"];
  readonly terminalReason: string | null;
}

export interface ChromiumPopupLifecycleJournalSnapshot {
  readonly capacity: 256;
  readonly journalVersion: 1;
  readonly observations: readonly ChromiumPopupLifecycleJournalObservation[];
}

export interface ChromiumPopupNativeWindowSnapshot {
  readonly admission: ChromiumPopupAdmissionRecord;
  readonly currentUrl: string;
  readonly nativeParentId: number;
  readonly openerPolicy: ChromiumPopupAdmissionRecord["openerPolicy"];
  readonly ownerKind: ChromiumPopupOwnerSource["ownerKind"];
  readonly receipt: ChromiumPopupNativeHostReceiptRecord;
  readonly sessionMatchesOwner: boolean;
  readonly title: string;
  readonly window: ChromiumPopupWindowPort;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export interface ChromiumPopupCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ChromiumPopupLifecycleCoordinatorInput {
  readonly core: ChromiumPopupCorePort;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly platform: "darwin" | "win32";
  readonly runtimeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
}

interface PopupListeners {
  readonly close: () => void;
  readonly closed: () => void;
  readonly contentBoundsUpdated: ChromiumRoleSurfaceEventMap["content-bounds-updated"];
  readonly destroyed: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly didFinishLoad: () => void;
  readonly didNavigate: ChromiumRoleSurfaceEventMap["did-navigate"];
  readonly pageTitleUpdated: ChromiumRoleSurfaceEventMap["page-title-updated"];
  readonly renderProcessGone: ChromiumRoleSurfaceEventMap["render-process-gone"];
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: ChromiumRoleSurfaceEventMap["will-navigate"];
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface PopupRecord {
  readonly request: ChromiumPopupOpenRequestRecord;
  readonly resolution: ChromiumPopupParentResolution;
  readonly source: ChromiumPopupOwnerSource;
  readonly ownerKey: string;
  readonly window: ChromiumPopupWindowPort;
  readonly contents: ChromiumRoleSurfaceWebContentsPort;
  readonly terminal: Deferred<void>;
  listeners: PopupListeners | null;
  admission: ChromiumPopupAdmissionRecord | null;
  nativeReceipt: ChromiumPopupNativeHostReceiptRecord | null;
  revision: number;
  state: PopupState;
  sequence: Promise<void>;
  closeReason: ChromiumPopupCloseReason | null;
  closedObserved: boolean;
  pendingFailure: ChromiumPopupCloseReason | null;
  pendingReadyUrl: string | null;
  currentUrl: string;
  title: string;
}

interface AdmissionFlight {
  readonly ownerKey: string;
  readonly windowId: string;
  promise: Promise<void>;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function popupError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function ownerKey(owner: Readonly<{
  ownerKind: "role" | "globalWeb";
  ownerId: string;
  nativeGeneration: number;
}>): string {
  return `${owner.ownerKind}:${owner.ownerId}:${owner.nativeGeneration}`;
}

function immutableParentFence(
  parent: ChromiumPopupParentFenceRecord
): ChromiumPopupParentFenceRecord {
  return Object.freeze({
    ...parent,
    ...(parent.parentAppkitIdentity
      ? { parentAppkitIdentity: Object.freeze({ ...parent.parentAppkitIdentity }) }
      : {})
  });
}

function terminalReason(
  action: ChromiumPopupLifecycleActionRecord,
  receipt: ChromiumPopupLifecycleReceiptRecord,
  closeReason: ChromiumPopupCloseReason | null
): string | null {
  if (!receipt.operationTerminal && !receipt.lifecycleTerminal) return null;
  if (receipt.lifecycleTerminal && closeReason !== null &&
      (action.type === "closeRequested" || action.type === "nativeClosed")) {
    return closeReason;
  }
  return receipt.failureCode ?? (action.type === "pageReady" ? "pageReady" : receipt.phase);
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function finiteZoom(value: unknown, fallback?: number): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" || !Number.isFinite(candidate) ||
    candidate < 0.25 || candidate > 5
  ) {
    throw popupError(
      "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_INVALID",
      "The controlled popup lost its exact runtime-window zoom fence."
    );
  }
  return candidate;
}

function effectiveZoom(base: number, windowFactor: number): number {
  return Math.min(5, Math.max(0.25, base * windowFactor));
}

function popupZoomContext(
  snapshot: ChromiumRuntimeExecutorSnapshot,
  admission: ChromiumPopupAdmissionRecord
): Readonly<{ base: number; windowFactor: number }> {
  const parent = admission.parent;
  const window = snapshot.windows.find((candidate) =>
    candidate.windowId === parent.parentWindowId &&
    candidate.windowGeneration === parent.parentWindowGeneration);
  const owner = parent.ownerKind === "role"
    ? snapshot.roles.find((candidate) =>
        candidate.roleId === parent.ownerId &&
        candidate.generation === parent.ownerNativeGeneration &&
        candidate.windowId === parent.parentWindowId)
    : snapshot.webSurfaces.find((candidate) =>
        candidate.surfaceId === parent.ownerId &&
        candidate.generation === parent.ownerNativeGeneration &&
        candidate.windowId === parent.parentWindowId);
  if (!window || !owner) {
    throw popupError(
      "ELECTRON_CHROMIUM_POPUP_ZOOM_OWNER_STALE",
      "The controlled popup no longer has its exact live window owner."
    );
  }
  return Object.freeze({
    base: finiteZoom(owner.zoomFactor, 1),
    windowFactor: finiteZoom(window.windowZoomFactor, 1)
  });
}

/** Event-bound owner for Electron-created Chromium popup windows. */
export class ChromiumPopupLifecycleCoordinator
implements ChromiumPopupOwnerLifecyclePort, ChromiumRuntimePopupZoomPort {
  readonly #input: ChromiumPopupLifecycleCoordinatorInput;
  readonly #records = new Set<PopupRecord>();
  readonly #admissionFlights = new Set<AdmissionFlight>();
  readonly #retiredOwnerFences = new Set<string>();
  readonly #movingOwnerFences = new Map<string, number>();
  readonly #ownerReloadAdmissionLeases = new Map<string, Set<string>>();
  readonly #windowZoomAdmissionLeases = new Set<string>();
  readonly #retiredOwnerOrder: string[] = [];
  readonly #lifecycleJournal: ChromiumPopupLifecycleJournalObservation[] = [];
  #nextLifecycleJournalSequence = 1;
  #state: CoordinatorState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(input: ChromiumPopupLifecycleCoordinatorInput) {
    this.#input = input;
  }

  get activeCount(): number {
    return this.#records.size;
  }

  readLifecycleJournal(): ChromiumPopupLifecycleJournalSnapshot {
    return Object.freeze({
      capacity: POPUP_LIFECYCLE_JOURNAL_CAPACITY,
      journalVersion: 1,
      observations: Object.freeze([...this.#lifecycleJournal])
    });
  }

  readNativeWindowSnapshot(): readonly ChromiumPopupNativeWindowSnapshot[] {
    return Object.freeze([...this.#records].flatMap((record) => {
      if (!record.admission || !record.nativeReceipt || record.state === "terminal") return [];
      return [Object.freeze({
        admission: record.admission,
        currentUrl: record.currentUrl,
        nativeParentId: record.window.getParentWindow()?.id ?? 0,
        openerPolicy: record.admission.openerPolicy,
        ownerKind: record.source.ownerKind,
        receipt: record.nativeReceipt,
        sessionMatchesOwner: record.contents.session === record.source.session,
        title: record.title,
        window: record.window
      })];
    }));
  }

  handleWindowOpen(
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ): ChromiumWindowOpenHandlerResponse {
    const key = ownerKey(source);
    if (
      this.#state !== "open" || this.#ownerAdmissionFenced(key) ||
      !supportedChromiumWindowOpen(details) ||
      this.#records.size >= MAX_POPUPS
    ) return { action: "deny" };
    const resolution = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    const options = buildChromiumPopupWindowOptions(source, details.url);
    if (
      !resolution || !options ||
      this.#windowZoomAdmissionLeases.has(resolution.parent.parentWindowId)
    ) return { action: "deny" };
    return Object.freeze({
      action: "allow" as const,
      outlivesOpener: false as const,
      overrideBrowserWindowOptions: options
    });
  }

  didCreateWindow(
    source: ChromiumPopupOwnerSource,
    popupWindow: ChromiumPopupWindowPort,
    details: ChromiumWindowOpenDetails
  ): void {
    const reject = (code: string, message: string): void => {
      if (!popupWindow.isDestroyed()) popupWindow.destroy();
      this.#input.onError(normalizeRionBridgeError(popupError(code, message)));
    };
    const key = ownerKey(source);
    const resolution = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    const parent = source.parent.nativeWindow;
    const contents = popupWindow.webContents;
    if (
      this.#state !== "open" || this.#ownerAdmissionFenced(key) ||
      !supportedChromiumWindowOpen(details) || !resolution || !parent ||
      this.#records.size >= MAX_POPUPS
    ) {
      reject(
        "ELECTRON_CHROMIUM_POPUP_CREATION_REJECTED",
        "Electron created a popup after its synchronous owner fence became stale."
      );
      return;
    }
    const openerPolicy = contents.opener === null || contents.opener === undefined
      ? "isolatedNoopener" as const
      : exactChromiumPopupOpenerFrameEqual(source.openerFrame, contents.opener)
        ? "connectedOpener" as const
        : null;
    if (
      !openerPolicy || !Number.isSafeInteger(popupWindow.id) || popupWindow.id < 1 ||
      popupWindow.isDestroyed() || popupWindow.isVisible() || popupWindow.isFocused() ||
      contents.isDestroyed() || contents.session !== source.session ||
      popupWindow.getParentWindow() !== parent
    ) {
      reject(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_IDENTITY_MISMATCH",
        "Electron created a visible, focused, wrong-Session, wrong-parent, or wrong-opener popup."
      );
      return;
    }
    const request = buildChromiumPopupOpenRequest(details, resolution, openerPolicy);
    const record: PopupRecord = {
      request,
      resolution,
      source,
      ownerKey: key,
      window: popupWindow,
      contents,
      terminal: deferred<void>(),
      listeners: null,
      admission: null,
      nativeReceipt: null,
      revision: 1,
      state: "admitting",
      sequence: Promise.resolve(),
      closeReason: null,
      closedObserved: false,
      pendingFailure: null,
      pendingReadyUrl: null,
      currentUrl: details.url,
      title: trustedChromiumPopupTitle(details.url)
    };
    void record.terminal.promise.catch(() => undefined);
    this.#records.add(record);
    this.#installWindowPolicy(record);
    const flight: AdmissionFlight = {
      ownerKey: key,
      windowId: resolution.parent.parentWindowId,
      promise: Promise.resolve()
    };
    this.#admissionFlights.add(flight);
    const admission = this.#admit(record).catch((error: unknown) =>
      this.#failRecord(record, error));
    record.sequence = admission;
    flight.promise = admission;
    void admission.then(
      () => this.#admissionFlights.delete(flight),
      () => this.#admissionFlights.delete(flight)
    );
  }

  async prepareWindowZoomTransaction(
    input: ChromiumRuntimePopupZoomInput
  ): Promise<ChromiumRuntimePopupZoomTransaction> {
    if (this.#state !== "open") {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ZOOM_DRAINING",
        "Controlled popup zoom is unavailable while the runtime is draining."
      );
    }
    finiteZoom(input.previousZoomFactor);
    finiteZoom(input.nextZoomFactor);
    const releaseAdmissionLease = this.#acquireWindowZoomAdmissionLease(input.windowId);
    try {
      await Promise.all([...this.#admissionFlights]
        .filter((flight) => flight.windowId === input.windowId)
        .map((flight) => flight.promise));
      const matching = [...this.#records].filter((record) =>
        record.admission?.parent.parentWindowId === input.windowId);
      await Promise.all(matching.map((record) => record.sequence));
      const snapshot = this.#input.runtimeSnapshot();
      const window = snapshot.windows.find((candidate) =>
        candidate.windowId === input.windowId);
      const currentWindowFactor = finiteZoom(window?.windowZoomFactor, 1);
      if (
        !window || window.windowGeneration !== input.windowGeneration ||
        window.topologyRevision !== input.topologyRevision ||
        (currentWindowFactor !== input.previousZoomFactor &&
          currentWindowFactor !== input.nextZoomFactor)
      ) {
        throw popupError(
          "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_STALE",
          "Controlled popup zoom lost its exact Core/native window fence."
        );
      }
      const candidates = matching.flatMap((record) => {
        if (
          !record.admission ||
          (record.state !== "nativeReady" && record.state !== "ready") ||
          record.contents.isDestroyed()
        ) return [];
        const context = popupZoomContext(snapshot, record.admission);
        if (context.windowFactor !== currentWindowFactor) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_STALE",
            "A controlled popup observed a different runtime-window multiplier."
          );
        }
        const previousNativeZoom = record.contents.getZoomFactor();
        const expectedCurrent = effectiveZoom(context.base, currentWindowFactor);
        if (previousNativeZoom !== expectedCurrent) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_STALE",
            "A controlled popup did not match its current Core-owned zoom projection."
          );
        }
        return [{
          contents: record.contents,
          previousNativeZoom,
          nextNativeZoom: effectiveZoom(context.base, input.nextZoomFactor)
        }];
      });
      const applied: typeof candidates = [];
      let appliedOnce = false;
      let terminal = false;
      return Object.freeze({
        popupSurfaceCount: candidates.length,
        apply: () => {
          if (appliedOnce) return;
          for (const candidate of candidates) {
            if (candidate.contents.isDestroyed()) {
              throw popupError(
                "ELECTRON_CHROMIUM_POPUP_ZOOM_HANDLE_STALE",
                "A controlled popup was destroyed during its zoom transaction."
              );
            }
            if (candidate.previousNativeZoom !== candidate.nextNativeZoom) {
              applied.push(candidate);
              candidate.contents.setZoomFactor(candidate.nextNativeZoom);
              if (candidate.contents.getZoomFactor() !== candidate.nextNativeZoom) {
                throw popupError(
                  "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_FAILED",
                  "The popup did not acknowledge its requested zoom factor."
                );
              }
            }
          }
          appliedOnce = true;
        },
        commit: () => {
          if (terminal) return;
          terminal = true;
          releaseAdmissionLease();
          if (!appliedOnce) {
            throw popupError(
              "ELECTRON_CHROMIUM_POPUP_ZOOM_TRANSACTION_INCOMPLETE",
              "Controlled popup zoom cannot commit before native apply."
            );
          }
        },
        rollback: () => {
          if (terminal) return;
          const failures: unknown[] = [];
          try {
            for (const candidate of [...applied].reverse()) {
              try {
                if (candidate.contents.isDestroyed()) throw new Error("destroyed");
                candidate.contents.setZoomFactor(candidate.previousNativeZoom);
                if (candidate.contents.getZoomFactor() !== candidate.previousNativeZoom) {
                  throw new Error("readback");
                }
              } catch (error) {
                failures.push(error);
              }
            }
          } finally {
            terminal = true;
            releaseAdmissionLease();
          }
          if (failures.length > 0) {
            throw popupError(
              "ELECTRON_CHROMIUM_POPUP_ZOOM_COMPENSATION_UNKNOWN",
              "Controlled popup zoom compensation could not be verified."
            );
          }
        }
      });
    } catch (error) {
      releaseAdmissionLease();
      throw error;
    }
  }

  async prepareOwnerReload(
    owner: Readonly<{
      ownerKind: "role";
      ownerId: string;
      nativeGeneration: number;
    }>,
    operationId: string
  ): Promise<void> {
    const key = ownerKey(owner);
    if (
      this.#state !== "open" || !this.#validReloadOperationId(operationId) ||
      this.#ownerTerminallyFenced(key)
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_RELOAD_FENCE_INVALID",
        "The controlled role reload popup fence is invalid."
      );
    }
    const operations = this.#ownerReloadAdmissionLeases.get(key) ?? new Set();
    operations.add(operationId);
    this.#ownerReloadAdmissionLeases.set(key, operations);
    try {
      await Promise.all([...this.#admissionFlights]
        .filter((flight) => flight.ownerKey === key)
        .map((flight) => flight.promise));
      const records = [...this.#records].filter((record) => record.ownerKey === key);
      await Promise.all(records.map((record) => record.sequence));
      if (
        this.#state !== "open" ||
        !this.#ownerReloadAdmissionLeases.get(key)?.has(operationId) ||
        this.#ownerTerminallyFenced(key)
      ) {
        throw popupError(
          "ELECTRON_CHROMIUM_POPUP_RELOAD_FENCE_SUPERSEDED",
          "The controlled role reload popup fence was superseded."
        );
      }
    } catch (error) {
      this.releaseOwnerReload(owner, operationId);
      throw error;
    }
  }

  releaseOwnerReload(
    owner: Readonly<{
      ownerKind: "role";
      ownerId: string;
      nativeGeneration: number;
    }>,
    operationId: string
  ): boolean {
    if (!this.#validReloadOperationId(operationId)) return false;
    const key = ownerKey(owner);
    const operations = this.#ownerReloadAdmissionLeases.get(key);
    if (!operations?.delete(operationId)) return false;
    if (operations.size === 0) this.#ownerReloadAdmissionLeases.delete(key);
    return true;
  }

  async retireOwner(owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>): Promise<void> {
    const key = ownerKey(owner);
    this.#retireOwnerFence(key);
    this.#ownerReloadAdmissionLeases.delete(key);
    await this.#retireOwnerRecords(key);
  }

  async retireOwnerPopupsForMove(owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>): Promise<void> {
    const key = ownerKey(owner);
    this.#movingOwnerFences.set(key, (this.#movingOwnerFences.get(key) ?? 0) + 1);
    this.#ownerReloadAdmissionLeases.delete(key);
    try {
      await this.#retireOwnerRecords(key);
    } finally {
      const remaining = (this.#movingOwnerFences.get(key) ?? 1) - 1;
      if (remaining === 0) this.#movingOwnerFences.delete(key);
      else this.#movingOwnerFences.set(key, remaining);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "draining";
    this.#disposePromise = (async () => {
      await Promise.all([...this.#admissionFlights].map((flight) => flight.promise));
      const records = [...this.#records];
      for (const record of records) {
        this.#enqueue(record, () => this.#requestClose(record, "applicationShutdown"));
      }
      await Promise.all(records.map((record) => record.terminal.promise));
      this.#ownerReloadAdmissionLeases.clear();
      this.#state = "closed";
    })().catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  async #retireOwnerRecords(key: string): Promise<void> {
    await Promise.all([...this.#admissionFlights]
      .filter((flight) => flight.ownerKey === key)
      .map((flight) => flight.promise));
    const records = [...this.#records].filter((record) => record.ownerKey === key);
    for (const record of records) {
      this.#enqueue(record, () => this.#requestClose(record, "parentRetired"));
    }
    await Promise.all(records.map((record) => record.terminal.promise));
  }

  async #admit(record: PopupRecord): Promise<void> {
    const admission = await this.#input.core.invoke({
      type: "browserPopupOpenAdmit",
      request: record.request
    });
    record.admission = admission;
    record.revision = admission.lifecycleRevision;
    if (
      admission.requestId !== record.request.requestId ||
      admission.lifecycleRevision !== 1 ||
      admission.targetUrl !== record.request.targetUrl ||
      admission.openerPolicy !== record.request.openerPolicy ||
      admission.hasPostBody !== record.request.hasPostBody
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ADMISSION_MISMATCH",
        "Core returned a mismatched Chromium popup admission."
      );
    }
    const current = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      record.source,
      this.#input.platform
    );
    if (
      this.#state !== "open" || this.#ownerAdmissionFenced(record.ownerKey) ||
      !current ||
      !exactChromiumPopupParentResolutionEqual(record.resolution, current) ||
      record.closedObserved || record.pendingFailure !== null ||
      record.window.isDestroyed() || record.contents.isDestroyed()
    ) {
      await this.#requestClose(record, record.closeReason ?? record.pendingFailure ??
        (this.#state === "open" ? "parentRetired" : "applicationShutdown"));
      return;
    }
    record.window.setBounds(admission.target.bounds);
    if (!sameBounds(record.window.getBounds(), admission.target.bounds)) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_BOUNDS_READBACK_FAILED",
        "The Electron popup did not acknowledge its Core-owned bounds."
      );
    }
    const context = popupZoomContext(this.#input.runtimeSnapshot(), admission);
    const popupZoom = effectiveZoom(context.base, context.windowFactor);
    record.contents.setZoomFactor(popupZoom);
    if (record.contents.getZoomFactor() !== popupZoom) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_FAILED",
        "The Electron popup did not acknowledge its Core-owned zoom."
      );
    }
    const nativeReceipt: ChromiumPopupNativeHostReceiptRecord = Object.freeze({
      platform: this.#input.platform === "darwin" ? "macos" : "windows",
      hostKind: "electronBrowserWindow",
      nativeHostId: record.window.id,
      logicalWindowId: admission.target.windowId,
      windowGeneration: 1,
      topologyRevision: 1
    });
    const native = await this.#commit(record, {
      type: "nativeReady",
      host: nativeReceipt
    });
    if (native.status !== "applied" || native.phase !== "nativeReady") {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_RECEIPT_REJECTED",
        "Core rejected the exact Electron BrowserWindow receipt."
      );
    }
    record.nativeReceipt = nativeReceipt;
    record.state = "nativeReady";
    if (
      record.closedObserved || record.pendingFailure !== null ||
      record.window.isDestroyed() || record.contents.isDestroyed()
    ) {
      await this.#requestClose(
        record,
        record.closeReason ?? record.pendingFailure ?? "user"
      );
      return;
    }
    record.window.setFocusable(true);
    record.window.show();
    if (!record.window.isVisible()) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_SHOW_FAILED",
        "The admitted Electron popup did not become visible."
      );
    }
    if (record.pendingReadyUrl) await this.#pageReady(record, record.pendingReadyUrl);
  }

  #installWindowPolicy(record: PopupRecord): void {
    const rejectNavigation = (event: ChromiumRoleSurfaceEvent, url: string) => {
      if (canonicalChromiumPopupRemoteUrl(url)) return;
      event.preventDefault();
      record.pendingFailure ??= "navigationRejected";
      record.closeReason ??= "navigationRejected";
      this.#enqueue(record, () => this.#requestClose(record, "navigationRejected"));
    };
    const listeners: PopupListeners = {
      close: () => {
        record.closeReason ??= this.#state === "open"
          ? this.#ownerTerminallyFenced(record.ownerKey)
            ? "parentRetired"
            : "user"
          : "applicationShutdown";
        this.#enqueue(record, () => this.#requestClose(record, record.closeReason!));
      },
      closed: () => {
        record.closedObserved = true;
        this.#enqueue(record, () => this.#observeNativeClosed(record));
      },
      contentBoundsUpdated: (event) => event.preventDefault(),
      destroyed: () => {
        if (!record.window.isDestroyed()) return;
        record.closedObserved = true;
        this.#enqueue(record, () => this.#observeNativeClosed(record));
      },
      didFailLoad: (
        _event,
        errorCode,
        _errorDescription,
        _validatedUrl,
        isMainFrame
      ) => {
        if (!isMainFrame || errorCode === -3) return;
        record.pendingFailure ??= "loadFailed";
        record.closeReason ??= "loadFailed";
        this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
      },
      didFinishLoad: () => {
        const finalUrl = canonicalChromiumPopupRemoteUrl(record.contents.getURL());
        if (!finalUrl) return;
        record.pendingReadyUrl = finalUrl;
        this.#enqueue(record, () => this.#pageReady(record, finalUrl));
      },
      didNavigate: (_event, url) => {
        const canonical = canonicalChromiumPopupRemoteUrl(url);
        if (!canonical || record.window.isDestroyed()) return;
        record.currentUrl = canonical;
        record.title = trustedChromiumPopupTitle(canonical);
        record.window.setTitle(record.title);
      },
      pageTitleUpdated: (event) => event.preventDefault(),
      renderProcessGone: () => {
        record.pendingFailure ??= "loadFailed";
        record.closeReason ??= "loadFailed";
        this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
      },
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: rejectNavigation,
      willRedirect: (event, url, _isInPlace, isMainFrame) => {
        if (isMainFrame) rejectNavigation(event, url);
      }
    };
    record.listeners = listeners;
    record.window.setTitle(record.title);
    record.contents.setWindowOpenHandler(() => ({ action: "deny" }));
    record.window.on("close", listeners.close);
    record.window.on("closed", listeners.closed);
    record.contents.on("content-bounds-updated", listeners.contentBoundsUpdated);
    record.contents.on("destroyed", listeners.destroyed);
    record.contents.on("did-fail-load", listeners.didFailLoad);
    record.contents.on("did-finish-load", listeners.didFinishLoad);
    record.contents.on("did-navigate", listeners.didNavigate);
    record.contents.on("page-title-updated", listeners.pageTitleUpdated);
    record.contents.on("render-process-gone", listeners.renderProcessGone);
    record.contents.on("will-attach-webview", listeners.willAttachWebview);
    record.contents.on("will-navigate", listeners.willNavigate);
    record.contents.on("will-redirect", listeners.willRedirect);
  }

  async #pageReady(record: PopupRecord, finalUrl: string): Promise<void> {
    if (record.state !== "nativeReady") return;
    const receipt = await this.#commit(record, {
      type: "pageReady",
      finalUrl
    });
    if (receipt.status !== "applied" || receipt.phase !== "ready") {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_PAGE_RECEIPT_REJECTED",
        "Core rejected the popup page-ready event."
      );
    }
    record.state = "ready";
  }

  async #requestClose(
    record: PopupRecord,
    reason: ChromiumPopupCloseReason
  ): Promise<void> {
    if (record.state === "terminal" || record.state === "closing") {
      if (record.state === "closing" && record.closedObserved) {
        await this.#nativeClosed(record);
      }
      return;
    }
    if (!record.admission) return;
    record.closeReason ??= reason;
    const receipt = await this.#commit(record, {
      type: "closeRequested",
      reason: record.closeReason
    });
    if (receipt.lifecycleTerminal && receipt.operationTerminal) {
      record.state = "terminal";
      if (!record.window.isDestroyed()) record.window.destroy();
      this.#settleTerminal(record, receipt);
      return;
    }
    if (
      receipt.status !== "applied" || receipt.phase !== "closing" ||
      !receipt.closeNative
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_CLOSE_RECEIPT_REJECTED",
        "Core rejected the popup close request."
      );
    }
    record.state = "closing";
    if (!record.window.isDestroyed()) record.window.destroy();
    if (record.closedObserved || record.window.isDestroyed()) {
      await this.#nativeClosed(record);
    }
  }

  async #observeNativeClosed(record: PopupRecord): Promise<void> {
    if (record.state === "terminal" || record.state === "admitting") return;
    if (record.state !== "closing") {
      await this.#requestClose(
        record,
        record.closeReason ?? record.pendingFailure ?? "user"
      );
      return;
    }
    await this.#nativeClosed(record);
  }

  async #nativeClosed(record: PopupRecord): Promise<void> {
    if (record.state === "terminal" || !record.admission) return;
    const receipt = await this.#commit(record, { type: "nativeClosed" });
    if (!receipt.lifecycleTerminal) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_CLOSE_NONTERMINAL",
        "Core did not terminalize the exact BrowserWindow close event."
      );
    }
    this.#settleTerminal(record, receipt);
  }

  async #cancelOpening(record: PopupRecord, failureCode: string): Promise<void> {
    if (!record.admission || record.state === "terminal") return;
    const receipt = await this.#commit(record, {
      type: "cancelled",
      failureCode
    });
    if (!receipt.operationTerminal || !receipt.lifecycleTerminal) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_CANCEL_RECEIPT_REJECTED",
        "Core did not terminalize a popup cancelled before native readiness."
      );
    }
    if (!record.window.isDestroyed()) record.window.destroy();
    this.#settleTerminal(record, receipt);
  }

  #commit(
    record: PopupRecord,
    action: ChromiumPopupLifecycleActionRecord
  ): Promise<ChromiumPopupLifecycleReceiptRecord> {
    const admission = record.admission;
    if (!admission) {
      return Promise.reject(popupError(
        "ELECTRON_CHROMIUM_POPUP_ADMISSION_MISSING",
        "The popup lifecycle event has no Core admission."
      ));
    }
    const event: ChromiumPopupLifecycleEventRecord = {
      eventId: randomUUID(),
      popupId: admission.popupId,
      expectedRevision: record.revision,
      parent: admission.parent,
      action
    };
    return this.#input.core.invoke({
      type: "browserPopupLifecycleCommit",
      event
    }).then((receipt) => {
      if (
        receipt.eventId !== event.eventId || receipt.popupId !== event.popupId ||
        !Number.isSafeInteger(receipt.lifecycleRevision) ||
        receipt.lifecycleRevision < record.revision
      ) {
        throw popupError(
          "ELECTRON_CHROMIUM_POPUP_LIFECYCLE_RECEIPT_MISMATCH",
          "Core returned a mismatched popup lifecycle receipt."
        );
      }
      record.revision = receipt.lifecycleRevision;
      this.#recordLifecycleObservation(admission, action, receipt, record.closeReason);
      return receipt;
    });
  }

  #recordLifecycleObservation(
    admission: ChromiumPopupAdmissionRecord,
    action: ChromiumPopupLifecycleActionRecord,
    receipt: ChromiumPopupLifecycleReceiptRecord,
    closeReason: ChromiumPopupCloseReason | null
  ): void {
    const observation = Object.freeze({
      action: action.type,
      closeNative: receipt.closeNative,
      closeReason,
      completionScope: receipt.completionScope,
      eventId: receipt.eventId,
      failureCode: receipt.failureCode ?? null,
      lifecycleRevision: receipt.lifecycleRevision,
      lifecycleTerminal: receipt.lifecycleTerminal,
      openOperationId: admission.openOperationId,
      operationId: receipt.operationId,
      operationTerminal: receipt.operationTerminal,
      parent: immutableParentFence(admission.parent),
      phase: receipt.phase,
      popupId: admission.popupId,
      sequence: this.#nextLifecycleJournalSequence++,
      status: receipt.status,
      terminalReason: terminalReason(action, receipt, closeReason)
    } satisfies ChromiumPopupLifecycleJournalObservation);
    this.#lifecycleJournal.push(observation);
    if (this.#lifecycleJournal.length > POPUP_LIFECYCLE_JOURNAL_CAPACITY) {
      this.#lifecycleJournal.shift();
    }
  }

  #enqueue(record: PopupRecord, task: () => Promise<void>): void {
    record.sequence = record.sequence.then(task).catch((error: unknown) =>
      this.#failRecord(record, error));
  }

  async #failRecord(record: PopupRecord, error: unknown): Promise<void> {
    if (record.state === "terminal") return;
    this.#input.onError(normalizeRionBridgeError(
      error,
      "ELECTRON_CHROMIUM_POPUP_LIFECYCLE_FAILED"
    ));
    try {
      if (record.admission) {
        if (record.state === "admitting") {
          await this.#cancelOpening(
            record,
            "CHROMIUM_POPUP_ELECTRON_PROJECTION_FAILED"
          );
          return;
        }
        const receipt = await this.#commit(record, {
          type: "failed",
          failureCode: "CHROMIUM_POPUP_ELECTRON_PROJECTION_FAILED",
          nativeStateUnknown: !record.window.isDestroyed()
        });
        if (!record.window.isDestroyed()) record.window.destroy();
        if (receipt.lifecycleTerminal) {
          this.#settleTerminal(record, receipt, error);
          return;
        }
      }
    } catch (terminalError) {
      error = terminalError;
    }
    if (!record.window.isDestroyed()) record.window.destroy();
    record.state = "terminal";
    this.#removeRecord(record);
    record.terminal.reject(error);
  }

  #settleTerminal(
    record: PopupRecord,
    receipt: ChromiumPopupLifecycleReceiptRecord,
    error?: unknown
  ): void {
    if (record.state !== "terminal") record.state = "terminal";
    this.#removeRecord(record);
    if (receipt.phase === "indeterminate" || error) {
      record.terminal.reject(error ?? popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_STATE_INDETERMINATE",
        "The popup native terminal state is indeterminate."
      ));
    } else {
      record.terminal.resolve();
    }
  }

  #removeRecord(record: PopupRecord): void {
    this.#removeListeners(record);
    this.#records.delete(record);
  }

  #removeListeners(record: PopupRecord): void {
    const listeners = record.listeners;
    if (!listeners) return;
    record.listeners = null;
    if (!record.window.isDestroyed()) {
      record.window.removeListener("close", listeners.close);
      record.window.removeListener("closed", listeners.closed);
    }
    if (!record.contents.isDestroyed()) {
      record.contents.removeListener("content-bounds-updated", listeners.contentBoundsUpdated);
      record.contents.removeListener("destroyed", listeners.destroyed);
      record.contents.removeListener("did-fail-load", listeners.didFailLoad);
      record.contents.removeListener("did-finish-load", listeners.didFinishLoad);
      record.contents.removeListener("did-navigate", listeners.didNavigate);
      record.contents.removeListener("page-title-updated", listeners.pageTitleUpdated);
      record.contents.removeListener("render-process-gone", listeners.renderProcessGone);
      record.contents.removeListener("will-attach-webview", listeners.willAttachWebview);
      record.contents.removeListener("will-navigate", listeners.willNavigate);
      record.contents.removeListener("will-redirect", listeners.willRedirect);
    }
  }

  #ownerAdmissionFenced(key: string): boolean {
    return this.#ownerTerminallyFenced(key) ||
      (this.#ownerReloadAdmissionLeases.get(key)?.size ?? 0) > 0;
  }

  #ownerTerminallyFenced(key: string): boolean {
    return this.#retiredOwnerFences.has(key) || this.#movingOwnerFences.has(key);
  }

  #validReloadOperationId(value: string): boolean {
    return value.length > 0 && value.length <= 256 && value === value.trim() &&
      ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
  }

  #acquireWindowZoomAdmissionLease(windowId: string): () => void {
    if (this.#windowZoomAdmissionLeases.has(windowId)) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ZOOM_TRANSACTION_ACTIVE",
        "A controlled popup zoom transaction already owns this runtime window."
      );
    }
    this.#windowZoomAdmissionLeases.add(windowId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#windowZoomAdmissionLeases.delete(windowId);
    };
  }

  #retireOwnerFence(key: string): void {
    if (this.#retiredOwnerFences.has(key)) return;
    this.#retiredOwnerFences.add(key);
    this.#retiredOwnerOrder.push(key);
    while (this.#retiredOwnerOrder.length > MAX_RETIRED_OWNER_FENCES) {
      const retired = this.#retiredOwnerOrder.shift();
      if (!retired) break;
      const active = [...this.#admissionFlights].some(
        (flight) => flight.ownerKey === retired
      ) || [...this.#records].some((record) => record.ownerKey === retired);
      if (active) {
        this.#retiredOwnerOrder.push(retired);
        if (this.#retiredOwnerOrder.every((candidate) =>
          [...this.#admissionFlights].some((flight) => flight.ownerKey === candidate) ||
          [...this.#records].some((record) => record.ownerKey === candidate)
        )) break;
      } else {
        this.#retiredOwnerFences.delete(retired);
      }
    }
  }
}
