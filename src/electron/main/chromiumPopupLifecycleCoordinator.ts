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
import {
  clearChromiumPopupPostBody,
  normalizeChromiumWindowOpenPostBody
} from "./chromiumPopupPorts";
import type {
  ChromiumPopupHostLifecycleObserver,
  ChromiumPopupOwnerLifecyclePort,
  ChromiumPopupOwnerSource,
  ChromiumPopupPostBody,
  ChromiumPopupWindowCreateOptions,
  ChromiumPopupWindowFactoryPort,
  ChromiumPopupWindowPort,
  ChromiumWindowOpenHandlerResponse,
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
import {
  exactChromiumPopupOpenerFrameEqual,
  exactChromiumPopupParentResolutionEqual,
  resolveChromiumPopupParent
} from "./chromiumPopupParent";
import type { ChromiumPopupParentResolution } from "./chromiumPopupParent";
export { resolveChromiumPopupParent } from "./chromiumPopupParent";
export type { ChromiumPopupParentResolution } from "./chromiumPopupParent";
import type { ChromiumRuntimeHostProjection } from
  "./chromiumRuntimeHostPorts";
import { buildUnprivilegedRemoteContentWebPreferences } from "./security";
import {
  buildChromiumPopupOpenRequest,
  canonicalChromiumPopupRemoteUrl,
  chromiumPopupRequestsNoopener,
  chromiumPopupLoadOptions,
  createChromiumPopupBrowserWindowHost,
  supportedChromiumWindowOpen,
  trustedChromiumPopupTitle
} from "./chromiumPopupBrowserWindow";
import type {
  ChromiumRuntimePopupZoomInput,
  ChromiumRuntimePopupZoomPort,
  ChromiumRuntimePopupZoomTransaction
} from "./chromiumRuntimeWindowZoomPorts";
import {
  chromiumPopupZoomContext,
  effectiveChromiumPopupZoom,
  finiteChromiumPopupZoom
} from "./chromiumPopupZoomPolicy";

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

export interface ChromiumPopupNativeWindowSnapshot {
  readonly admission: ChromiumPopupAdmissionRecord;
  readonly currentUrl: string;
  readonly host: ChromiumRuntimeHostPort;
  readonly ownerKind: ChromiumPopupOwnerSource["ownerKind"];
  readonly receipt: ChromiumPopupNativeHostReceiptRecord;
  readonly title: string;
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

export interface ChromiumPopupLifecycleCoordinatorInput {
  readonly core: ChromiumPopupCorePort;
  /** Legacy lower-layer harness only; production popup creation is BrowserWindow-only. */
  readonly hosts?: ChromiumPopupHostFactoryPort;
  readonly onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly platform: "darwin" | "win32";
  readonly runtimeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  /** Legacy lower-layer harness only; production does not attach an extra View. */
  readonly views?: ChromiumWebContentsViewFactoryPort;
  /** Required by production; legacy unit harnesses may exercise requestOpen only. */
  readonly popupWindows?: ChromiumPopupWindowFactoryPort;
}

interface PopupListeners {
  readonly contentBoundsUpdated: ChromiumRoleSurfaceEventMap["content-bounds-updated"];
  readonly destroyed: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly didFinishLoad: () => void;
  readonly didNavigate: ChromiumRoleSurfaceEventMap["did-navigate"];
  readonly enteredHtmlFullscreen: () => void;
  readonly leftHtmlFullscreen: () => void;
  readonly pageTitleUpdated: ChromiumRoleSurfaceEventMap["page-title-updated"];
  readonly renderProcessGone: ChromiumRoleSurfaceEventMap["render-process-gone"];
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: (event: ChromiumRoleSurfaceEvent, url: string) => void;
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface PopupRecord {
  readonly admission: ChromiumPopupAdmissionRecord;
  readonly ownerKey: string;
  readonly source: ChromiumPopupOwnerSource;
  readonly terminal: Deferred<void>;
  postBody: ChromiumPopupPostBody | undefined;
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
  directWindow: ChromiumPopupWindowPort | null;
  nativeReceipt: ChromiumPopupNativeHostReceiptRecord | null;
}

interface ProvisionalPopup {
  readonly details: ChromiumWindowOpenDetails;
  readonly ownerKey: string;
  readonly postBody: ChromiumPopupPostBody | undefined;
  readonly resolution: ChromiumPopupParentResolution;
  readonly source: ChromiumPopupOwnerSource;
  readonly window: ChromiumPopupWindowPort;
  readonly closeRequested: (event: ChromiumRoleSurfaceEvent) => void;
  readonly closed: () => void;
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willFrameNavigate: ChromiumRoleSurfaceEventMap["will-frame-navigate"];
  admissionStarted: boolean;
  adopted: boolean;
  disposed: boolean;
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

function sameHostEnvelope(
  left: ChromiumRuntimeHostProjection,
  right: ChromiumRuntimeHostProjection
): boolean {
  return left.displayId === right.displayId &&
    left.presentation === right.presentation && sameBounds(left.bounds, right.bounds);
}

export class ChromiumPopupLifecycleCoordinator
implements ChromiumPopupOwnerLifecyclePort, ChromiumRuntimePopupZoomPort {
  readonly #input: ChromiumPopupLifecycleCoordinatorInput;
  readonly #records = new Map<string, PopupRecord>();
  readonly #popupIdsByOwner = new Map<string, Set<string>>();
  readonly #provisionals = new Set<ProvisionalPopup>();
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
    return this.#records.size + this.#provisionals.size;
  }

  /** Detached evidence sourced only from exact Core lifecycle receipts. */
  readLifecycleJournal(): ChromiumPopupLifecycleJournalSnapshot {
    return Object.freeze({
      capacity: POPUP_LIFECYCLE_JOURNAL_CAPACITY,
      journalVersion: 1,
      observations: Object.freeze([...this.#lifecycleJournal])
    });
  }

  /** Exact live native popup evidence used by the desktop E2E observer. */
  readNativeWindowSnapshot(): readonly ChromiumPopupNativeWindowSnapshot[] {
    return Object.freeze([...this.#records.values()].flatMap((record) => {
      if (
        !record.host || !record.nativeReceipt || record.host.isDestroyed() ||
        record.state === "terminal"
      ) return [];
      return [Object.freeze({
        admission: record.admission,
        currentUrl: record.contents?.getURL() ?? "about:blank",
        host: record.host,
        ownerKind: record.source.ownerKind,
        receipt: record.nativeReceipt,
        title: record.directWindow?.getTitle() ?? record.admission.title
      })];
    }));
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
    finiteChromiumPopupZoom(input.previousZoomFactor);
    finiteChromiumPopupZoom(input.nextZoomFactor);
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
      const currentWindowFactor = finiteChromiumPopupZoom(
        window?.windowZoomFactor,
        1
      );
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
        const context = chromiumPopupZoomContext(snapshot, record.admission);
        if (context.windowFactor !== currentWindowFactor) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_STALE",
            "A controlled popup observed a different runtime-window multiplier."
          );
        }
        const previousNativeZoom = record.contents.getZoomFactor();
        const expectedCurrent = effectiveChromiumPopupZoom(
          context.base,
          currentWindowFactor
        );
        if (previousNativeZoom !== expectedCurrent) {
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_STALE",
            "A controlled popup did not match its current Core-owned zoom projection."
          );
        }
        return [{
          contents: record.contents,
          previousNativeZoom,
          nextNativeZoom: effectiveChromiumPopupZoom(
            context.base,
            input.nextZoomFactor
          )
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

  handleWindowOpen(
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ): ChromiumWindowOpenHandlerResponse {
    const key = ownerKey(source);
    const factory = this.#input.popupWindows;
    if (
      !factory || this.#state !== "open" || this.#ownerAdmissionFenced(key) ||
      !supportedChromiumWindowOpen(details) ||
      canonicalChromiumPopupRemoteUrl(details.url) === null ||
      !source.openerFrame ||
      this.#records.size + this.#admissionFlights.size + this.#provisionals.size >=
        MAX_POPUPS
    ) return { action: "deny" };
    const postBody = normalizeChromiumWindowOpenPostBody(details);
    if (postBody === null) {
      this.#input.onError(normalizeRionBridgeError(popupError(
        "ELECTRON_CHROMIUM_POPUP_POST_BODY_INVALID",
        "The popup POST envelope is malformed or exceeds Rion's bounded transfer policy."
      )));
      return { action: "deny" };
    }
    const resolution = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    if (
      !resolution ||
      this.#windowZoomAdmissionLeases.has(resolution.parent.parentWindowId)
    ) {
      clearChromiumPopupPostBody(postBody);
      return { action: "deny" };
    }
    const frozenDetails: ChromiumWindowOpenDetails = Object.freeze({
      url: details.url,
      disposition: details.disposition,
      frameName: details.frameName,
      features: details.features,
      ...(details.referrer
        ? { referrer: Object.freeze({ ...details.referrer }) }
        : {})
    });
    const windowOptions: ChromiumPopupWindowCreateOptions = Object.freeze({
      autoHideMenuBar: true,
      focusable: false,
      frame: true,
      fullscreenable: false,
      height: 480,
      show: false,
      title: trustedChromiumPopupTitle(details.url),
      webPreferences: Object.freeze({
        ...buildUnprivilegedRemoteContentWebPreferences(),
        paintWhenInitiallyHidden: false,
        session: source.session
      }),
      width: 640
    });
    let consumed = false;
    return Object.freeze({
      action: "allow" as const,
      outlivesOpener: false as const,
      overrideBrowserWindowOptions: windowOptions,
      createWindow: (options: unknown) => {
        if (consumed) {
          clearChromiumPopupPostBody(postBody);
          throw popupError(
            "ELECTRON_CHROMIUM_POPUP_CREATE_REPLAYED",
            "Electron replayed a one-shot controlled popup constructor."
          );
        }
        consumed = true;
        let popupWindow: ChromiumPopupWindowPort;
        try {
          const suppliedContents = options && typeof options === "object"
            ? (options as { webContents?: unknown }).webContents
            : undefined;
          if (!suppliedContents || typeof suppliedContents !== "object") {
            throw popupError(
              "ELECTRON_CHROMIUM_POPUP_WEBCONTENTS_MISSING",
              "Electron did not provide the connected popup WebContents."
            );
          }
          popupWindow = factory.create({
            ...windowOptions,
            webContents: suppliedContents as ChromiumRoleSurfaceWebContentsPort
          });
          if (popupWindow.webContents !== suppliedContents) {
            if (!popupWindow.isDestroyed()) popupWindow.destroy();
            throw popupError(
              "ELECTRON_CHROMIUM_POPUP_WEBCONTENTS_MISMATCH",
              "The popup BrowserWindow did not adopt Electron's connected WebContents."
            );
          }
          return this.#registerProvisionalPopup(
            popupWindow,
            source,
            frozenDetails,
            resolution,
            postBody
          );
        } catch (error) {
          clearChromiumPopupPostBody(postBody);
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_CHROMIUM_POPUP_WINDOW_CREATE_FAILED"
          ));
          throw error;
        }
      }
    });
  }

  requestOpen(
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ): void {
    const key = ownerKey(source);
    if (
      !this.#input.hosts || !this.#input.views ||
      this.#state !== "open" || this.#ownerAdmissionFenced(key) ||
      !supportedChromiumWindowOpen(details) ||
      this.#records.size + this.#admissionFlights.size >= MAX_POPUPS
    ) return;
    const postBody = normalizeChromiumWindowOpenPostBody(details);
    if (postBody === null) {
      this.#input.onError(normalizeRionBridgeError(popupError(
        "ELECTRON_CHROMIUM_POPUP_POST_BODY_INVALID",
        "The popup POST envelope is malformed or exceeds Rion's bounded transfer policy."
      )));
      return;
    }
    const resolution = resolveChromiumPopupParent(
      this.#input.runtimeSnapshot(),
      source,
      this.#input.platform
    );
    if (
      !resolution ||
      this.#windowZoomAdmissionLeases.has(resolution.parent.parentWindowId)
    ) {
      clearChromiumPopupPostBody(postBody);
      return;
    }
    const flight: AdmissionFlight = {
      ownerKey: key,
      windowId: resolution.parent.parentWindowId,
      promise: Promise.resolve()
    };
    this.#admissionFlights.add(flight);
    const request = buildChromiumPopupOpenRequest(
      details,
      resolution,
      postBody !== undefined
    );
    const terminal = this.#admitAndOpen(source, request, resolution, postBody);
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

  #registerProvisionalPopup(
    popupWindow: ChromiumPopupWindowPort,
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails,
    resolution: ChromiumPopupParentResolution,
    postBody: ChromiumPopupPostBody | undefined
  ): ChromiumRoleSurfaceWebContentsPort {
    const contents = popupWindow.webContents;
    if (
      !Number.isSafeInteger(popupWindow.id) || popupWindow.id < 1 ||
      popupWindow.isDestroyed() || popupWindow.isVisible() ||
      popupWindow.isFocused() || contents.isDestroyed() ||
      contents.session !== source.session || typeof contents.stop !== "function"
    ) {
      if (!popupWindow.isDestroyed()) popupWindow.destroy();
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_PROVISIONAL_INVALID",
        "Electron returned a visible, focused, destroyed, or wrong-Session popup."
      );
    }
    // Callbacks close over the record before its one-time construction below.
    // eslint-disable-next-line prefer-const
    let provisional!: ProvisionalPopup;
    const willAttachWebview = (event: ChromiumRoleSurfaceEvent) =>
      event.preventDefault();
    const closeRequested = (event: ChromiumRoleSurfaceEvent) => {
      event.preventDefault();
      this.#disposeProvisional(provisional, true);
    };
    const closed = () => this.#disposeProvisional(provisional, false);
    const beginAdmission = () => {
      if (provisional.disposed || provisional.admissionStarted) return;
      const openerPolicy = contents.opener === null || contents.opener === undefined
        ? "isolatedNoopener" as const
        : exactChromiumPopupOpenerFrameEqual(source.openerFrame, contents.opener)
          ? chromiumPopupRequestsNoopener(details.features)
            ? "isolatedNoopener" as const
            : "connectedOpener" as const
          : null;
      if (!openerPolicy) {
        this.#input.onError(normalizeRionBridgeError(popupError(
          "ELECTRON_CHROMIUM_POPUP_OPENER_MISMATCH",
          "The provisional popup did not retain its exact parent opener frame."
        )));
        this.#disposeProvisional(provisional, true);
        return;
      }
      provisional.admissionStarted = true;
      this.#beginDirectAdmission(provisional, openerPolicy);
    };
    const willFrameNavigate: ChromiumRoleSurfaceEventMap["will-frame-navigate"] =
      (event) => {
        if (!event.isMainFrame || provisional.disposed) return;
        event.preventDefault();
        if (canonicalChromiumPopupRemoteUrl(event.url) !== details.url) {
          this.#input.onError(normalizeRionBridgeError(popupError(
            "ELECTRON_CHROMIUM_POPUP_INITIAL_NAVIGATION_MISMATCH",
            "The provisional popup attempted an unexpected initial navigation."
          )));
          this.#disposeProvisional(provisional, true);
          return;
        }
        beginAdmission();
      };
    provisional = {
      admissionStarted: false,
      adopted: false,
      closeRequested,
      closed,
      details,
      disposed: false,
      ownerKey: ownerKey(source),
      postBody,
      resolution,
      source,
      willAttachWebview,
      willFrameNavigate,
      window: popupWindow
    };
    this.#provisionals.add(provisional);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", willAttachWebview);
    contents.on("will-frame-navigate", willFrameNavigate);
    popupWindow.on("close", closeRequested);
    popupWindow.on("closed", closed);
    // Electron can begin the guest's first request before createWindow returns.
    // Stop it synchronously, then admit from the captured URL/POST/referrer even
    // when Chromium emitted will-frame-navigate before the listener was attached.
    contents.stop();
    queueMicrotask(beginAdmission);
    return contents;
  }

  #beginDirectAdmission(
    provisional: ProvisionalPopup,
    openerPolicy: ChromiumPopupOpenRequestRecord["openerPolicy"]
  ): void {
    const request = buildChromiumPopupOpenRequest(
      provisional.details,
      provisional.resolution,
      provisional.postBody !== undefined,
      openerPolicy
    );
    const flight: AdmissionFlight = {
      ownerKey: provisional.ownerKey,
      windowId: provisional.resolution.parent.parentWindowId,
      promise: Promise.resolve()
    };
    this.#admissionFlights.add(flight);
    const terminal = this.#admitAndOpenDirect(provisional, request);
    flight.promise = terminal.then(() => undefined);
    void terminal.catch((error: unknown) => {
      this.#input.onError(normalizeRionBridgeError(
        error,
        "ELECTRON_CHROMIUM_POPUP_OPEN_FAILED"
      ));
    }).finally(() => {
      this.#admissionFlights.delete(flight);
      if (provisional.adopted) this.#releaseProvisional(provisional);
      else this.#disposeProvisional(provisional, true);
    });
  }

  #releaseProvisional(provisional: ProvisionalPopup): void {
    if (provisional.disposed) return;
    provisional.disposed = true;
    this.#provisionals.delete(provisional);
    const contents = provisional.window.webContents;
    if (!contents.isDestroyed()) {
      contents.removeListener("will-attach-webview", provisional.willAttachWebview);
      contents.removeListener("will-frame-navigate", provisional.willFrameNavigate);
    }
    if (!provisional.window.isDestroyed()) {
      provisional.window.removeListener("close", provisional.closeRequested);
      provisional.window.removeListener("closed", provisional.closed);
    }
  }

  #disposeProvisional(
    provisional: ProvisionalPopup,
    destroyWindow: boolean
  ): void {
    if (provisional.disposed) return;
    this.#releaseProvisional(provisional);
    clearChromiumPopupPostBody(provisional.postBody);
    if (destroyWindow && !provisional.window.isDestroyed()) {
      provisional.window.destroy();
    }
  }

  #disposeOwnerProvisionals(key: string): void {
    for (const provisional of [...this.#provisionals]) {
      if (provisional.ownerKey === key) this.#disposeProvisional(provisional, true);
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
    this.#disposeOwnerProvisionals(key);
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
    this.#disposeOwnerProvisionals(key);
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
      for (const provisional of [...this.#provisionals]) {
        this.#disposeProvisional(provisional, true);
      }
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

  async #admitAndOpenDirect(
    provisional: ProvisionalPopup,
    request: ChromiumPopupOpenRequestRecord
  ): Promise<void> {
    const key = provisional.ownerKey;
    if (
      provisional.disposed || provisional.window.isDestroyed() ||
      this.#state !== "open" || this.#ownerAdmissionFenced(key)
    ) return;
    const admission = await this.#input.core.invoke({
      type: "browserPopupOpenAdmit",
      request
    });
    if (
      admission.requestId !== request.requestId ||
      admission.lifecycleRevision !== 1 ||
      admission.creationUrl !== "about:blank" ||
      admission.targetUrl !== request.targetUrl ||
      admission.openerPolicy !== request.openerPolicy ||
      admission.hasPostBody !== request.hasPostBody
    ) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ADMISSION_MISMATCH",
        "Core returned a mismatched Chromium popup admission."
      );
    }
    if (
      provisional.disposed || provisional.window.isDestroyed() ||
      this.#state !== "open" || this.#ownerAdmissionFenced(key)
    ) {
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
      provisional.source,
      this.#input.platform
    );
    if (
      !current ||
      !exactChromiumPopupParentResolutionEqual(provisional.resolution, current)
    ) {
      await this.#cancelAdmission(admission, "CHROMIUM_POPUP_PARENT_SUPERSEDED");
      return;
    }
    const record = this.#createDirectRecord(admission, provisional);
    provisional.adopted = true;
    this.#releaseProvisional(provisional);
    void record.terminal.promise.catch(() => undefined);
    this.#records.set(admission.popupId, record);
    const ownerPopups = this.#popupIdsByOwner.get(record.ownerKey) ?? new Set();
    ownerPopups.add(admission.popupId);
    this.#popupIdsByOwner.set(record.ownerKey, ownerPopups);
    record.sequence = this.#materialize(record).catch((error: unknown) =>
      this.#failRecord(record, error));
  }

  #createDirectRecord(
    admission: ChromiumPopupAdmissionRecord,
    provisional: ProvisionalPopup
  ): PopupRecord {
    const popupWindow = provisional.window;
    const contents = popupWindow.webContents;
    const { host, view } = createChromiumPopupBrowserWindowHost(
      admission,
      popupWindow
    );
    return {
      admission,
      ownerKey: provisional.ownerKey,
      source: provisional.source,
      terminal: deferred<void>(),
      postBody: provisional.postBody,
      host,
      view,
      contents,
      listeners: null,
      revision: 1,
      state: "opening",
      sequence: Promise.resolve(),
      viewAttached: false,
      viewDestroyed: null,
      containedFullscreen: false,
      containedFullscreenHostProjection: null,
      closeReason: null,
      directWindow: popupWindow,
      nativeReceipt: null
    };
  }

  async #admitAndOpen(
    source: ChromiumPopupOwnerSource,
    request: ChromiumPopupOpenRequestRecord,
    resolution: ChromiumPopupParentResolution,
    postBody: ChromiumPopupPostBody | undefined
  ): Promise<void> {
    const key = ownerKey(source);
    let ownsPostBody = true;
    try {
      if (this.#state !== "open" || this.#ownerAdmissionFenced(key)) return;
      const admission = await this.#input.core.invoke({
        type: "browserPopupOpenAdmit",
        request
      });
      if (
        admission.requestId !== request.requestId ||
        admission.lifecycleRevision !== 1 ||
        admission.creationUrl !== "about:blank" ||
        admission.targetUrl !== request.targetUrl ||
        admission.openerPolicy !== "isolatedNoopener" ||
        admission.hasPostBody !== request.hasPostBody
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
      if (!current || !exactChromiumPopupParentResolutionEqual(resolution, current)) {
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
        postBody,
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
        closeReason: null,
        directWindow: null,
        nativeReceipt: null
      };
      ownsPostBody = false;
      void record.terminal.promise.catch(() => undefined);
      this.#records.set(admission.popupId, record);
      const ownerPopups = this.#popupIdsByOwner.get(record.ownerKey) ?? new Set();
      ownerPopups.add(admission.popupId);
      this.#popupIdsByOwner.set(record.ownerKey, ownerPopups);
      record.sequence = this.#materialize(record).catch((error: unknown) =>
        this.#failRecord(record, error));
    } finally {
      if (ownsPostBody) clearChromiumPopupPostBody(postBody);
    }
  }

  async #materialize(record: PopupRecord): Promise<void> {
    const created = record.directWindow
      ? (() => {
          record.directWindow!.setBounds(record.admission.target.bounds);
          record.directWindow!.setTitle(
            trustedChromiumPopupTitle(record.admission.targetUrl)
          );
          return {
            host: record.host!,
            receipt: {
              platform: this.#input.platform === "darwin" ? "macos" as const :
                "windows" as const,
              hostKind: "electronBrowserWindow" as const,
              nativeHostId: record.directWindow!.id,
              logicalWindowId: record.admission.target.windowId,
              windowGeneration: 1,
              topologyRevision: 1
            } satisfies ChromiumPopupNativeHostReceiptRecord
          };
        })()
      : await this.#input.hosts!.createPopup(record.admission);
    record.host = created.host;
    record.nativeReceipt = created.receipt;
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
    const view = record.directWindow
      ? record.view!
      : this.#input.views!.create({
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
    const zoom = chromiumPopupZoomContext(
      this.#input.runtimeSnapshot(),
      record.admission
    );
    const popupZoomFactor = effectiveChromiumPopupZoom(
      zoom.base,
      zoom.windowFactor
    );
    contents.setZoomFactor(popupZoomFactor);
    if (contents.getZoomFactor() !== popupZoomFactor) {
      throw popupError(
        "ELECTRON_CHROMIUM_POPUP_ZOOM_READBACK_FAILED",
        "The controlled popup did not retain its Core-owned initial zoom factor."
      );
    }
    view.setVisible(false);
    view.setBounds(created.host.getContentBounds());
    if (!record.directWindow) {
      created.host.contentView.addChildView(view);
      record.viewAttached = true;
    }
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
      closed: () => this.#enqueue(record, () =>
        record.directWindow && record.state !== "closing" &&
          record.state !== "terminal"
          ? this.#requestClose(record, "user")
          : this.#nativeClosed(record)),
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
        chromiumPopupLoadOptions(record.admission, record.postBody)
      );
      // EventBound: did-finish-load/did-fail-load is authoritative.
      void load.catch(() => undefined).finally(() => this.#clearPostBody(record));
    } catch (error) {
      this.#clearPostBody(record);
      await this.#requestClose(record, "loadFailed");
      throw error;
    }
  }

  #installViewPolicy(record: PopupRecord): void {
    const contents = record.contents!;
    const rejectNavigation = (event: ChromiumRoleSurfaceEvent, url: string) => {
      if (canonicalChromiumPopupRemoteUrl(url)) return;
      event.preventDefault();
      this.#enqueue(record, () => this.#requestClose(
        record,
        "navigationRejected"
      ));
    };
    const listeners: PopupListeners = {
      contentBoundsUpdated: (event) => event.preventDefault(),
      destroyed: () => {
        record.viewDestroyed?.resolve();
        if (record.directWindow) return;
        if (record.state !== "closing" && record.state !== "terminal") {
          this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
        }
      },
      didFailLoad: (
        _event,
        errorCode,
        _errorDescription,
        _validatedUrl,
        isMainFrame
      ) => {
        if (errorCode === -3) return;
        if (isMainFrame) {
          this.#enqueue(record, () => this.#requestClose(record, "loadFailed"));
        }
      },
      didFinishLoad: () => {
        const finalUrl = canonicalChromiumPopupRemoteUrl(contents.getURL());
        if (!finalUrl) {
          if (contents.getURL() !== "about:blank") {
            this.#enqueue(record, () => this.#requestClose(
              record,
              "navigationRejected"
            ));
          }
          return;
        }
        record.directWindow?.setTitle(trustedChromiumPopupTitle(finalUrl));
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
      didNavigate: (_event, url) => {
        if (canonicalChromiumPopupRemoteUrl(url)) {
          record.directWindow?.setTitle(trustedChromiumPopupTitle(url));
        }
      },
      enteredHtmlFullscreen: () => this.#enqueue(
        record,
        () => this.#applyContainedFullscreen(record, true)
      ),
      leftHtmlFullscreen: () => this.#enqueue(
        record,
        () => this.#applyContainedFullscreen(record, false)
      ),
      pageTitleUpdated: (event) => event.preventDefault(),
      renderProcessGone: () => this.#enqueue(
        record,
        () => this.#requestClose(record, "loadFailed")
      ),
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: rejectNavigation,
      willRedirect: (event, url) => rejectNavigation(event, url)
    };
    record.listeners = listeners;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("content-bounds-updated", listeners.contentBoundsUpdated);
    contents.on("destroyed", listeners.destroyed);
    contents.on("did-fail-load", listeners.didFailLoad);
    contents.on("did-finish-load", listeners.didFinishLoad);
    contents.on("did-navigate", listeners.didNavigate);
    contents.on("enter-html-full-screen", listeners.enteredHtmlFullscreen);
    contents.on("leave-html-full-screen", listeners.leftHtmlFullscreen);
    contents.on("page-title-updated", listeners.pageTitleUpdated);
    contents.on("render-process-gone", listeners.renderProcessGone);
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
    if (record.directWindow) {
      if (!contents.isDestroyed()) this.#removeViewListeners(record, contents);
      record.view = null;
      record.contents = null;
      return;
    }
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
    this.#clearPostBody(record);
    this.#records.delete(record.admission.popupId);
    const ownerPopups = this.#popupIdsByOwner.get(record.ownerKey);
    ownerPopups?.delete(record.admission.popupId);
    if (ownerPopups?.size === 0) this.#popupIdsByOwner.delete(record.ownerKey);
  }

  #clearPostBody(record: PopupRecord): void {
    clearChromiumPopupPostBody(record.postBody);
    record.postBody = undefined;
  }

  #removeViewListeners(
    record: PopupRecord,
    contents: ChromiumRoleSurfaceWebContentsPort
  ): void {
    if (!record.listeners) return;
    contents.removeListener(
      "content-bounds-updated",
      record.listeners.contentBoundsUpdated
    );
    contents.removeListener("destroyed", record.listeners.destroyed);
    contents.removeListener("did-fail-load", record.listeners.didFailLoad);
    contents.removeListener("did-finish-load", record.listeners.didFinishLoad);
    contents.removeListener("did-navigate", record.listeners.didNavigate);
    contents.removeListener(
      "enter-html-full-screen",
      record.listeners.enteredHtmlFullscreen
    );
    contents.removeListener(
      "leave-html-full-screen",
      record.listeners.leftHtmlFullscreen
    );
    contents.removeListener("page-title-updated", record.listeners.pageTitleUpdated);
    contents.removeListener("render-process-gone", record.listeners.renderProcessGone);
    contents.removeListener("will-attach-webview", record.listeners.willAttachWebview);
    contents.removeListener("will-navigate", record.listeners.willNavigate);
    contents.removeListener("will-redirect", record.listeners.willRedirect);
    record.listeners = null;
  }
}
