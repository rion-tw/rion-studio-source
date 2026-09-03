import { randomUUID } from "node:crypto";

import type {
  AppKitRuntimeHostIdentityRecord,
  ChromiumPopupAdmissionRecord,
  ChromiumPopupCloseReason,
  ChromiumPopupLifecycleActionRecord,
  ChromiumPopupLifecycleEventRecord,
  ChromiumPopupLifecycleReceiptRecord,
  ChromiumPopupNativeHostReceiptRecord,
  ChromiumPopupOpenRequestRecord,
  ChromiumPopupParentFenceRecord,
  CoreCommand,
  CoreCommandResult,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumPopupHostLifecycleObserver,
  ChromiumPopupOwnerLifecyclePort,
  ChromiumPopupOwnerSource,
  ChromiumWindowOpenDetails
} from "./chromiumPopupPorts";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "./chromiumRoleSurfacePorts";
import type {
  ChromiumRuntimeExecutorSnapshot,
  ChromiumRuntimeHostPort
} from "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeHostProjection } from
  "./chromiumRuntimeHostPorts";
import { buildUnprivilegedRemoteContentWebPreferences } from "./security";
import type {
  ChromiumRuntimePopupZoomInput,
  ChromiumRuntimePopupZoomPort,
  ChromiumRuntimePopupZoomTransaction
} from "./chromiumRuntimeWindowZoomPorts";

type CoordinatorState = "open" | "draining" | "closed";
type PopupState = "opening" | "nativeReady" | "ready" | "closing" | "terminal";

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

export interface ChromiumPopupHostFactoryPort {
  createPopup: (admission: ChromiumPopupAdmissionRecord) => Promise<Readonly<{
    host: ChromiumRuntimeHostPort;
    receipt: ChromiumPopupNativeHostReceiptRecord;
  }>>;
}

export interface ChromiumPopupParentResolution {
  readonly parent: ChromiumPopupParentFenceRecord;
  readonly parentTarget: EmbeddedLaunchTargetRecord;
}

export interface ChromiumPopupLifecycleCoordinatorInput {
  readonly core: ChromiumPopupCorePort;
  readonly hosts: ChromiumPopupHostFactoryPort;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly platform: "darwin" | "win32";
  readonly runtimeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly views: ChromiumWebContentsViewFactoryPort;
}

interface PopupListeners {
  readonly destroyed: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly didFinishLoad: () => void;
  readonly enteredHtmlFullscreen: () => void;
  readonly leftHtmlFullscreen: () => void;
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: (event: ChromiumRoleSurfaceEvent, url: string) => void;
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface PopupRecord {
  readonly admission: ChromiumPopupAdmissionRecord;
  readonly ownerKey: string;
  readonly source: ChromiumPopupOwnerSource;
  readonly terminal: Deferred<void>;
  host: ChromiumRuntimeHostPort | null;
  view: ChromiumRoleWebContentsViewPort | null;
  contents: ChromiumRoleSurfaceWebContentsPort | null;
  listeners: PopupListeners | null;
  revision: number;
  state: PopupState;
  sequence: Promise<void>;
  viewAttached: boolean;
  viewDestroyed: Deferred<void> | null;
  containedFullscreen: boolean;
  containedFullscreenHostProjection: ChromiumRuntimeHostProjection | null;
  closeReason: ChromiumPopupCloseReason | null;
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

function exactParentResolutionEqual(
  left: ChromiumPopupParentResolution,
  right: ChromiumPopupParentResolution
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalRemoteUrl(value: unknown): string | null {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 8_192 ||
    value !== value.trim() || value.includes("\\") || /\s/u.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 || parsed.username.length > 0 ||
      parsed.password.length > 0 || parsed.href !== value
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function sameHostEnvelope(
  left: ChromiumRuntimeHostProjection,
  right: ChromiumRuntimeHostProjection
): boolean {
  return left.displayId === right.displayId &&
    left.presentation === right.presentation && sameBounds(left.bounds, right.bounds);
}

function supportedWindowOpen(details: ChromiumWindowOpenDetails): boolean {
  // Chromium reports a normal left-click on target=_blank as foreground-tab;
  // new-window is the Shift+left-click form. Both enter the same controlled
  // native popup admission, while background/default/other remain denied.
  return (details.disposition === "foreground-tab" ||
      details.disposition === "new-window") &&
    details.url !== "about:blank" &&
    typeof details.url === "string" && details.url.length <= 8_192 &&
    (details.frameName === undefined || details.frameName === "" ||
      details.frameName === "_blank") &&
    (details.features?.length ?? 0) <= 1_024;
}

function appKitIdentityMatches(
  identity: AppKitRuntimeHostIdentityRecord,
  windowId: string
): boolean {
  return identity.logicalWindowId === windowId &&
    identity.launchGeneration.length > 0 &&
    Number.isSafeInteger(identity.nativeGeneration) &&
    identity.nativeGeneration > 0;
}

function effectiveWindowZoom(base: number, windowFactor: number): number {
  return Math.min(5, Math.max(0.25, base * windowFactor));
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

/** Resolves only Electron-owned native handles; Core revalidates logical fences. */
export function resolveChromiumPopupParent(
  snapshot: ChromiumRuntimeExecutorSnapshot,
  source: ChromiumPopupOwnerSource,
  platform: "darwin" | "win32"
): ChromiumPopupParentResolution | null {
  if (
    source.parent.isDestroyed() || !Number.isSafeInteger(source.parent.id) ||
    source.parent.id < 1 || !Number.isSafeInteger(source.nativeGeneration) ||
    source.nativeGeneration < 1
  ) {
    return null;
  }
  const owner = source.ownerKind === "role"
    ? snapshot.roles.find((candidate) =>
        candidate.roleId === source.ownerId &&
        candidate.generation === source.nativeGeneration)
    : snapshot.webSurfaces.find((candidate) =>
        candidate.surfaceId === source.ownerId &&
        candidate.slotId === source.slotId &&
        candidate.generation === source.nativeGeneration);
  if (!owner) return null;
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === owner.tabId);
  const window = snapshot.windows.find((candidate) =>
    candidate.windowId === owner.windowId &&
    candidate.parentNativeHostId === source.parent.id &&
    candidate.tabIds.includes(owner.tabId));
  if (
    !tab || !window || tab.windowId !== window.windowId ||
    !tab.attemptGeneration || !window.target ||
    !Number.isSafeInteger(window.parentNativeHostId) ||
    (window.parentNativeHostId ?? 0) < 1
  ) return null;
  if (
    platform === "darwin" &&
    (!window.appKitIdentity || !appKitIdentityMatches(
      window.appKitIdentity,
      window.windowId
    ))
  ) {
    return null;
  }
  if (platform === "win32" && window.appKitIdentity) return null;
  const role = source.ownerKind === "role"
    ? snapshot.roles.find((candidate) =>
        candidate.roleId === source.ownerId &&
        candidate.generation === source.nativeGeneration)
    : undefined;
  return Object.freeze({
    parent: Object.freeze({
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      ...(source.ownerKind === "globalWeb" ? { slotId: source.slotId! } : {}),
      ownerNativeGeneration: source.nativeGeneration,
      ...(role ? { roleOwnerGeneration: role.ownerGeneration } : {}),
      parentWindowId: window.windowId,
      parentWindowGeneration: window.windowGeneration,
      parentTopologyRevision: window.topologyRevision,
      parentTabId: owner.tabId,
      parentAttemptGeneration: tab.attemptGeneration,
      parentNativeHostId: window.parentNativeHostId!,
      ...(window.appKitIdentity
        ? { parentAppkitIdentity: Object.freeze({ ...window.appKitIdentity }) }
        : {})
    }),
    parentTarget: Object.freeze({
      ...window.target,
      bounds: Object.freeze({ ...window.target.bounds }),
      workArea: Object.freeze({ ...window.target.workArea })
    })
  });
}

function openRequest(
  details: ChromiumWindowOpenDetails,
  resolution: ChromiumPopupParentResolution
): ChromiumPopupOpenRequestRecord {
  const referrerUrl = details.referrer?.url || undefined;
  const referrerPolicy = details.referrer?.policy || undefined;
  return Object.freeze({
    requestId: randomUUID(),
    parent: resolution.parent,
    parentTarget: resolution.parentTarget,
    targetUrl: details.url,
    disposition: "newWindow",
    openerPolicy: "isolatedNoopener",
    ...(details.frameName ? { frameName: details.frameName } : {}),
    ...(referrerUrl ? { referrerUrl } : {}),
    ...(referrerPolicy ? { referrerPolicy } : {}),
    rawFeatures: details.features ?? "",
    hasPostBody: details.postBody !== undefined
  });
}

/** Event-bound owner for controlled Chromium popup native projections. */
export class ChromiumPopupLifecycleCoordinator
implements ChromiumPopupOwnerLifecyclePort, ChromiumRuntimePopupZoomPort {
  readonly #input: ChromiumPopupLifecycleCoordinatorInput;
  readonly #records = new Map<string, PopupRecord>();
  readonly #popupIdsByOwner = new Map<string, Set<string>>();
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

  /** Detached evidence sourced only from exact Core lifecycle receipts. */
  readLifecycleJournal(): ChromiumPopupLifecycleJournalSnapshot {
    return Object.freeze({
      capacity: POPUP_LIFECYCLE_JOURNAL_CAPACITY,
      journalVersion: 1,
      observations: Object.freeze([...this.#lifecycleJournal])
    });
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
    const releaseAdmissionLease = this.#acquireWindowZoomAdmissionLease(
      input.windowId
    );
    try {
      // The lease is installed before the first await. Earlier admissions are
      // allowed to finish and become candidates; later requests are rejected
      // synchronously without starting another Core lifecycle command.
      await Promise.all([...this.#admissionFlights]
        .filter((flight) => flight.windowId === input.windowId)
        .map((flight) => flight.promise));
      const matching = [...this.#records.values()].filter((record) =>
        record.admission.parent.parentWindowId === input.windowId);
      await Promise.all(matching.map((record) => record.sequence));
      if (this.#state !== "open") {
        throw popupError(
          "ELECTRON_CHROMIUM_POPUP_ZOOM_DRAINING",
          "Controlled popup zoom cannot continue after the runtime begins draining."
        );
      }

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
          (record.state !== "nativeReady" && record.state !== "ready") ||
          !record.view || !record.contents || record.contents.isDestroyed()
        ) return [];
        const context = popupZoomContext(snapshot, record.admission);
        if (context.windowFactor !== currentWindowFactor) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_STALE",
            "A controlled popup observed a different runtime-window multiplier."
          );
        }
        const previousNativeZoom = record.contents.getZoomFactor();
        const expectedCurrent = effectiveWindowZoom(context.base, currentWindowFactor);
        if (previousNativeZoom !== expectedCurrent) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_STALE",
            "A controlled popup did not match its current Core-owned zoom projection."
          );
        }
        return [{
          contents: record.contents,
          previousNativeZoom,
          nextNativeZoom: effectiveWindowZoom(context.base, input.nextZoomFactor)
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
                  "A controlled popup did not acknowledge its requested zoom factor."
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
            applied.length = 0;
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

  requestOpen(
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ): void {
    const key = ownerKey(source);
    if (
      this.#state !== "open" || this.#ownerAdmissionFenced(key) ||
      !supportedWindowOpen(details) ||
      this.#records.size + this.#admissionFlights.size >= MAX_POPUPS
    ) return;
    const resolution = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    if (
      !resolution ||
      this.#windowZoomAdmissionLeases.has(resolution.parent.parentWindowId)
    ) return;
    const flight: AdmissionFlight = {
      ownerKey: key,
      windowId: resolution.parent.parentWindowId,
      promise: Promise.resolve()
    };
    this.#admissionFlights.add(flight);
    const terminal = this.#admitAndOpen(source, details, resolution);
    flight.promise = terminal;
    void terminal.catch((error: unknown) => {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_CHROMIUM_POPUP_OPEN_FAILED"
      ));
    }).finally(() => {
      this.#admissionFlights.delete(flight);
    });
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
      // EventBound: install the owner lease before waiting for pre-existing
      // admissions. Their exact Core/native terminality determines completion.
      await Promise.all([...this.#admissionFlights]
        .filter((flight) => flight.ownerKey === key)
        .map((flight) => flight.promise));
      const records = [...(this.#popupIdsByOwner.get(key) ?? [])]
        .map((popupId) => this.#records.get(popupId))
        .filter((record): record is PopupRecord => record !== undefined);
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
    await Promise.all(
      [...this.#admissionFlights]
        .filter((flight) => flight.ownerKey === key)
        .map((flight) => flight.promise)
    );
    const ids = [...(this.#popupIdsByOwner.get(key) ?? [])];
    const terminals = ids.map((popupId) => {
      const record = this.#records.get(popupId);
      if (!record) return Promise.resolve();
      this.#enqueue(record, () => this.#requestClose(record, "parentRetired"));
      return record.terminal.promise;
    });
    await Promise.all(terminals);
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
      await Promise.all(
        [...this.#admissionFlights]
          .filter((flight) => flight.ownerKey === key)
          .map((flight) => flight.promise)
      );
      const records = [...(this.#popupIdsByOwner.get(key) ?? [])]
        .map((popupId) => this.#records.get(popupId))
        .filter((record): record is PopupRecord => record !== undefined);
      for (const record of records) {
        this.#enqueue(record, () => this.#requestClose(record, "parentRetired"));
      }
      await Promise.all(records.map((record) => record.terminal.promise));
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
      const records = [...this.#records.values()];
      for (const record of records) {
        this.#enqueue(record, () => this.#requestClose(
          record,
          "applicationShutdown"
        ));
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

  async #admitAndOpen(
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails,
    resolution: ChromiumPopupParentResolution
  ): Promise<void> {
    const key = ownerKey(source);
    if (this.#state !== "open" || this.#ownerAdmissionFenced(key)) return;
    const request = openRequest(details, resolution);
    const admission = await this.#input.core.invoke({
      type: "browserPopupOpenAdmit",
      request
    });
    if (
      admission.requestId !== request.requestId ||
      admission.lifecycleRevision !== 1 ||
      admission.creationUrl !== "about:blank" ||
      admission.targetUrl !== request.targetUrl ||
      admission.openerPolicy !== "isolatedNoopener"
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ADMISSION_MISMATCH",
        "Core returned a mismatched Chromium popup admission."
      );
    }
    if (this.#state !== "open" || this.#ownerAdmissionFenced(key)) {
      await this.#cancelAdmission(
        admission,
        this.#state === "open"
          ? this.#ownerReloadAdmissionLeases.has(key)
            ? "CHROMIUM_POPUP_RELOAD_FENCED"
            : "CHROMIUM_POPUP_OWNER_RETIRED"
          : "CHROMIUM_POPUP_APPLICATION_DRAINING"
      );
      return;
    }
    const current = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    if (!current || !exactParentResolutionEqual(resolution, current)) {
      await this.#cancelAdmission(
        admission,
        "CHROMIUM_POPUP_PARENT_SUPERSEDED"
      );
      return;
    }
    const record: PopupRecord = {
      admission,
      ownerKey: ownerKey(source),
      source,
      terminal: deferred<void>(),
      host: null,
      view: null,
      contents: null,
      listeners: null,
      revision: 1,
      state: "opening",
      sequence: Promise.resolve(),
      viewAttached: false,
      viewDestroyed: null,
      containedFullscreen: false,
      containedFullscreenHostProjection: null,
      closeReason: null
    };
    void record.terminal.promise.catch(() => undefined);
    this.#records.set(admission.popupId, record);
    const ownerPopups = this.#popupIdsByOwner.get(record.ownerKey) ?? new Set();
    ownerPopups.add(admission.popupId);
    this.#popupIdsByOwner.set(record.ownerKey, ownerPopups);
    record.sequence = this.#materialize(record).catch((error: unknown) =>
      this.#failRecord(record, error));
  }

  async #materialize(record: PopupRecord): Promise<void> {
    const created = await this.#input.hosts.createPopup(record.admission);
    record.host = created.host;
    if (
      created.receipt.logicalWindowId !== record.admission.target.windowId ||
      created.host.logicalWindowId !== record.admission.target.windowId ||
      created.host.id !== created.receipt.nativeHostId ||
      created.host.isDestroyed() || created.host.isVisible() ||
      !created.host.bindPopupLifecycle
    ) {
      if (!created.host.isDestroyed()) await created.host.close();
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_HOST_INVALID",
        "The popup factory returned a visible, stale, or unobservable native host."
      );
    }
    record.containedFullscreenHostProjection = created.host.readProjection();
    if (this.#mustRetire(record)) {
      await this.#cancelOpeningRecord(record);
      return;
    }
    const view = this.#input.views.create({
      webPreferences: {
        ...buildUnprivilegedRemoteContentWebPreferences(),
        session: record.source.session
      }
    });
    record.view = view;
    const contents = view.webContents;
    record.contents = contents;
    this.#installViewPolicy(record);
    if (
      contents.session !== record.source.session ||
      contents.isDestroyed()
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_SESSION_MISMATCH",
        "The popup did not retain its exact parent role/global-Web Session."
      );
    }
    const zoom = popupZoomContext(
      this.#input.runtimeSnapshot(),
      record.admission
    );
    const popupZoomFactor = effectiveWindowZoom(zoom.base, zoom.windowFactor);
    contents.setZoomFactor(popupZoomFactor);
    if (contents.getZoomFactor() !== popupZoomFactor) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_FAILED",
        "The controlled popup did not retain its Core-owned initial zoom factor."
      );
    }
    view.setVisible(false);
    view.setBounds(created.host.getContentBounds());
    created.host.contentView.addChildView(view);
    record.viewAttached = true;
    if (this.#mustRetire(record)) {
      await this.#cancelOpeningRecord(record);
      return;
    }
    const native = await this.#commit(record, {
      type: "nativeReady",
      host: created.receipt
    });
    if (native.status !== "applied" || native.phase !== "nativeReady") {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_RECEIPT_REJECTED",
        "Core rejected the exact popup native-host receipt."
      );
    }
    record.state = "nativeReady";
    const observer: ChromiumPopupHostLifecycleObserver = Object.freeze({
      closeRequested: () => this.#enqueue(
        record,
        () => this.#requestClose(record, "user")
      ),
      closed: () => this.#enqueue(record, () => this.#nativeClosed(record)),
      layoutChanged: (bounds: ChromiumRoleSurfaceBounds) =>
        this.#applyLayout(record, bounds)
    });
    created.host.bindPopupLifecycle(observer);
    if (this.#mustRetire(record)) {
      await this.#requestClose(
        record,
        this.#state === "open" ? "parentRetired" : "applicationShutdown"
      );
      return;
    }
    if (created.host.isDestroyed()) {
      await this.#nativeClosed(record);
      return;
    }
    view.setVisible(true);
    created.host.show();
    try {
      const load = contents.loadURL(
        record.admission.targetUrl,
        record.admission.referrerUrl
          ? {
              httpReferrer: {
                url: record.admission.referrerUrl,
                policy: record.admission.referrerPolicy ?? "default"
              }
            }
          : undefined
      );
      // EventBound: did-finish-load/did-fail-load is authoritative.
      void load.catch(() => undefined);
    } catch (error) {
      await this.#requestClose(record, "loadFailed");
      throw error;
    }
  }

  #installViewPolicy(record: PopupRecord): void {
    const contents = record.contents!;
    const rejectNavigation = (event: ChromiumRoleSurfaceEvent, url: string) => {
      if (canonicalRemoteUrl(url)) return;
      event.preventDefault();
      this.#enqueue(record, () => this.#requestClose(
        record,
        "navigationRejected"
      ));
    };
    const listeners: PopupListeners = {
      destroyed: () => {
        record.viewDestroyed?.resolve();
        if (record.state !== "closing" && record.state !== "terminal") {
          this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
        }
      },
      didFailLoad: (
        _event,
        _errorCode,
        _errorDescription,
        _validatedUrl,
        isMainFrame
      ) => {
        if (isMainFrame) {
          this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
        }
      },
      didFinishLoad: () => {
        const finalUrl = canonicalRemoteUrl(contents.getURL());
        if (!finalUrl) {
          if (contents.getURL() !== "about:blank") {
            this.#enqueue(record, () => this.#requestClose(
              record,
              "navigationRejected"
            ));
          }
          return;
        }
        this.#enqueue(record, async () => {
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
        });
      },
      enteredHtmlFullscreen: () => this.#enqueue(
        record,
        () => this.#applyContainedFullscreen(record, true)
      ),
      leftHtmlFullscreen: () => this.#enqueue(
        record,
        () => this.#applyContainedFullscreen(record, false)
      ),
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: rejectNavigation,
      willRedirect: (event, url) => rejectNavigation(event, url)
    };
    record.listeners = listeners;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("destroyed", listeners.destroyed);
    contents.on("did-fail-load", listeners.didFailLoad);
    contents.on("did-finish-load", listeners.didFinishLoad);
    contents.on("enter-html-full-screen", listeners.enteredHtmlFullscreen);
    contents.on("leave-html-full-screen", listeners.leftHtmlFullscreen);
    contents.on("will-attach-webview", listeners.willAttachWebview);
    contents.on("will-navigate", listeners.willNavigate);
    contents.on("will-redirect", listeners.willRedirect);
  }

  #applyLayout(record: PopupRecord, bounds: ChromiumRoleSurfaceBounds): void {
    if (
      record.state === "terminal" || !record.view ||
      !record.contents || record.contents.isDestroyed()
    ) return;
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
      bounds.width < 1 || bounds.height < 1
    ) {
      this.#enqueue(record, () => this.#requestClose(record, "navigationRejected"));
      return;
    }
    record.view.setBounds(bounds);
    if (!record.containedFullscreen && record.host) {
      record.containedFullscreenHostProjection = record.host.readProjection();
    }
  }

  async #applyContainedFullscreen(
    record: PopupRecord,
    fullscreen: boolean
  ): Promise<void> {
    if (
      record.state === "closing" || record.state === "terminal" ||
      record.containedFullscreen === fullscreen || !record.host || !record.view ||
      !record.contents || record.host.isDestroyed() || record.contents.isDestroyed()
    ) return;
    const projection = record.host.readProjection();
    const expected = record.containedFullscreenHostProjection ?? projection;
    const contentBounds = record.host.getContentBounds();
    record.view.setBounds(contentBounds);
    if (
      !sameHostEnvelope(projection, expected) ||
      !sameBounds(record.view.getBounds(), contentBounds)
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_CONTAINED_FULLSCREEN_HOST_CHANGED",
        "The controlled popup changed native host geometry during bounded HTML fullscreen."
      );
    }
    record.containedFullscreen = fullscreen;
    if (!fullscreen) record.containedFullscreenHostProjection = projection;
  }

  async #requestClose(
    record: PopupRecord,
    reason: ChromiumPopupCloseReason
  ): Promise<void> {
    if (record.state === "closing" || record.state === "terminal") return;
    const receipt = await this.#commit(record, {
      type: "closeRequested",
      reason
    });
    if (receipt.lifecycleTerminal && receipt.operationTerminal) {
      record.state = "closing";
      await this.#retireOwnedView(record);
      if (record.host && !record.host.isDestroyed()) await record.host.close();
      await this.#settleTerminal(record, receipt);
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
    await this.#destroyNative(record);
  }

  async #destroyNative(record: PopupRecord): Promise<void> {
    await this.#retireOwnedView(record);
    if (record.host && !record.host.isDestroyed()) {
      await record.host.close();
    } else {
      await this.#nativeClosed(record);
    }
  }

  async #retireOwnedView(record: PopupRecord): Promise<void> {
    const view = record.view;
    const contents = record.contents;
    if (!view || !contents) return;
    let teardownError: unknown;
    if (record.viewAttached) {
      try {
        record.host?.contentView.removeChildView(view);
      } catch (error) {
        teardownError = error;
      }
      record.viewAttached = false;
    }
    try {
      view.setVisible(false);
    } catch (error) {
      teardownError ??= error;
    }
    if (!contents.isDestroyed()) {
      record.viewDestroyed ??= deferred<void>();
      try {
        contents.close({ waitForBeforeUnload: false });
        if (!contents.isDestroyed()) await record.viewDestroyed.promise;
      } catch (error) {
        teardownError ??= error;
      }
    }
    this.#removeViewListeners(record, contents);
    record.view = null;
    record.contents = null;
    if (teardownError) throw teardownError;
  }

  async #nativeClosed(record: PopupRecord): Promise<void> {
    if (record.state === "terminal") return;
    const receipt = await this.#commit(record, { type: "nativeClosed" });
    if (!receipt.lifecycleTerminal) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_CLOSE_NONTERMINAL",
        "Core did not terminalize an exact popup native-close event."
      );
    }
    await this.#settleTerminal(record, receipt);
  }

  async #cancelOpeningRecord(record: PopupRecord): Promise<void> {
    const receipt = await this.#commit(record, {
      type: "cancelled",
      failureCode: this.#state === "open"
        ? "CHROMIUM_POPUP_OWNER_RETIRED"
        : "CHROMIUM_POPUP_APPLICATION_DRAINING"
    });
    if (!receipt.operationTerminal || !receipt.lifecycleTerminal) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_CANCEL_RECEIPT_REJECTED",
        "Core did not terminalize a popup cancelled before native readiness."
      );
    }
    record.state = "closing";
    let teardownError: unknown;
    try {
      await this.#retireOwnedView(record);
      if (record.host && !record.host.isDestroyed()) await record.host.close();
    } catch (error) {
      teardownError = error;
    }
    await this.#settleTerminal(record, receipt, teardownError);
  }

  async #cancelAdmission(
    admission: ChromiumPopupAdmissionRecord,
    failureCode: string
  ): Promise<void> {
    const event: ChromiumPopupLifecycleEventRecord = {
      eventId: randomUUID(),
      popupId: admission.popupId,
      expectedRevision: admission.lifecycleRevision,
      parent: admission.parent,
      action: { type: "cancelled", failureCode }
    };
    const receipt = await this.#input.core.invoke({
      type: "browserPopupLifecycleCommit",
      event
    });
    if (
      receipt.eventId !== event.eventId || receipt.popupId !== admission.popupId ||
      !receipt.operationTerminal || !receipt.lifecycleTerminal ||
      receipt.phase !== "cancelled" || receipt.status !== "cancelled"
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_CANCEL_RECEIPT_REJECTED",
        "Core did not terminalize the superseded popup admission."
      );
    }
    this.#recordLifecycleObservation(admission, event.action, receipt, null);
  }

  #mustRetire(record: PopupRecord): boolean {
    return this.#state !== "open" || this.#ownerAdmissionFenced(record.ownerKey);
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
      ) || (this.#popupIdsByOwner.get(retired)?.size ?? 0) > 0;
      if (active) {
        this.#retiredOwnerOrder.push(retired);
        if (this.#retiredOwnerOrder.every((candidate) =>
          [...this.#admissionFlights].some(
            (flight) => flight.ownerKey === candidate
          ) || (this.#popupIdsByOwner.get(candidate)?.size ?? 0) > 0
        )) break;
      } else {
        this.#retiredOwnerFences.delete(retired);
      }
    }
  }

  async #commit(
    record: PopupRecord,
    action: ChromiumPopupLifecycleActionRecord
  ): Promise<ChromiumPopupLifecycleReceiptRecord> {
    const event: ChromiumPopupLifecycleEventRecord = {
      eventId: randomUUID(),
      popupId: record.admission.popupId,
      expectedRevision: record.revision,
      parent: record.admission.parent,
      action
    };
    const receipt = await this.#input.core.invoke({
      type: "browserPopupLifecycleCommit",
      event
    });
    if (
      receipt.eventId !== event.eventId ||
      receipt.popupId !== event.popupId ||
      !Number.isSafeInteger(receipt.lifecycleRevision) ||
      receipt.lifecycleRevision < record.revision
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_LIFECYCLE_RECEIPT_MISMATCH",
        "Core returned a mismatched popup lifecycle receipt."
      );
    }
    if (action.type === "closeRequested" && receipt.status !== "superseded") {
      record.closeReason = action.reason;
    }
    record.revision = receipt.lifecycleRevision;
    this.#recordLifecycleObservation(
      record.admission,
      action,
      receipt,
      record.closeReason
    );
    return receipt;
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
      if (record.state === "opening") {
        const receipt = await this.#commit(record, {
          type: "cancelled",
          failureCode: "CHROMIUM_POPUP_NATIVE_CREATION_FAILED"
        });
        record.state = "closing";
        await this.#retireOwnedView(record);
        if (record.host && !record.host.isDestroyed()) await record.host.close();
        await this.#settleTerminal(record, receipt, error);
        return;
      }
      const receipt = await this.#commit(record, {
        type: "failed",
        failureCode: "CHROMIUM_POPUP_ELECTRON_PROJECTION_FAILED",
        nativeStateUnknown: record.host?.isDestroyed() ?? true
      });
      if (receipt.closeNative) {
        if (receipt.lifecycleTerminal) {
          await this.#retireOwnedView(record);
          if (record.host && !record.host.isDestroyed()) await record.host.close();
        } else {
          await this.#destroyNative(record);
        }
      }
      if (receipt.lifecycleTerminal) {
        record.state = "closing";
        await this.#settleTerminal(record, receipt, error);
      }
    } catch (terminalError) {
      record.state = "terminal";
      try {
        await this.#retireOwnedView(record);
      } catch {
        // The terminal rejection below preserves the authoritative failure.
      }
      record.terminal.reject(terminalError);
      this.#removeRecord(record);
    }
  }

  async #settleTerminal(
    record: PopupRecord,
    receipt: ChromiumPopupLifecycleReceiptRecord,
    error?: unknown
  ): Promise<void> {
    if (record.state === "terminal") return;
    record.state = "terminal";
    let teardownError: unknown;
    try {
      await this.#retireOwnedView(record);
    } catch (caught) {
      teardownError = caught;
    }
    this.#removeRecord(record);
    if (receipt.phase === "indeterminate" || error || teardownError) {
      record.terminal.reject(error ?? teardownError ?? popupError(
        "ELECTRON_CHROMIUM_POPUP_NATIVE_STATE_INDETERMINATE",
        "The popup native terminal state is indeterminate."
      ));
    } else {
      record.terminal.resolve();
    }
  }

  #removeRecord(record: PopupRecord): void {
    this.#records.delete(record.admission.popupId);
    const ownerPopups = this.#popupIdsByOwner.get(record.ownerKey);
    ownerPopups?.delete(record.admission.popupId);
    if (ownerPopups?.size === 0) this.#popupIdsByOwner.delete(record.ownerKey);
  }

  #removeViewListeners(
    record: PopupRecord,
    contents: ChromiumRoleSurfaceWebContentsPort
  ): void {
    if (!record.listeners) return;
    contents.removeListener("destroyed", record.listeners.destroyed);
    contents.removeListener("did-fail-load", record.listeners.didFailLoad);
    contents.removeListener("did-finish-load", record.listeners.didFinishLoad);
    contents.removeListener(
      "enter-html-full-screen",
      record.listeners.enteredHtmlFullscreen
    );
    contents.removeListener(
      "leave-html-full-screen",
      record.listeners.leftHtmlFullscreen
    );
    contents.removeListener("will-attach-webview", record.listeners.willAttachWebview);
    contents.removeListener("will-navigate", record.listeners.willNavigate);
    contents.removeListener("will-redirect", record.listeners.willRedirect);
    record.listeners = null;
  }
}
