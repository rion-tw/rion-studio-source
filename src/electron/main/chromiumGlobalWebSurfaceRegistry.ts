import type { GlobalWebProfilePathsRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumGlobalWebSurfaceLease
} from "./chromiumGlobalWebSessionRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "./chromiumRoleSurfacePorts";
import { buildUnprivilegedRemoteContentWebPreferences } from "./security";
import type { ChromiumPopupOwnerLifecyclePort } from "./chromiumPopupPorts";

type RegistryState = "open" | "draining" | "disposed";
type SurfaceState =
  | "opening"
  | "active"
  | "load-failed"
  | "closing"
  | "quarantined";

const MAX_GLOBAL_WEB_SURFACES = 512;

export interface ChromiumGlobalWebSurfaceSessionOwnerPort {
  acquireSurface: (
    surfaceId: string,
    surfaceGeneration: number,
    profile: GlobalWebProfilePathsRecord
  ) => ChromiumGlobalWebSurfaceLease;
  releaseSurface: (lease: ChromiumGlobalWebSurfaceLease) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export interface ChromiumGlobalWebNativeAttachmentInput {
  readonly surfaceId: string;
  readonly generation: number;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly isCancelled: () => boolean;
  readonly attach: () => void;
  readonly detach: () => void;
}

/**
 * macOS implements this on the same per-AppKit-host FIFO as trusted role
 * capture. It deliberately does not grant a workspace Web surface background
 * trusted-input ownership. Windows does not need an attachment adapter.
 */
export interface ChromiumGlobalWebNativeAttachmentPort {
  attachNonInputSurface: (
    input: ChromiumGlobalWebNativeAttachmentInput
  ) => Promise<void>;
  detachNonInputSurface: (
    surfaceId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ) => Promise<void>;
}

export interface CreateChromiumGlobalWebSurfaceInput {
  readonly attemptGeneration: string;
  readonly surfaceId: string;
  readonly slotId: string;
  readonly generation: number;
  readonly profile: GlobalWebProfilePathsRecord;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly tabId: string;
  readonly windowGeneration: number;
  readonly windowId: string;
  readonly url: string;
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly visible: boolean;
  readonly zoomFactor: number;
  readonly audioMuted: boolean;
  /** Exact Chromium HTML-fullscreen event projected by the paired host owner. */
  readonly onContainedFullscreenChange?: (fullscreen: boolean) => void;
}

export interface ChromiumGlobalWebActiveMainFrameFailure {
  readonly attemptGeneration: string;
  readonly errorCode: number;
  readonly surfaceGeneration: number;
  readonly surfaceId: string;
  readonly tabId: string;
  readonly validatedUrl: string;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ChromiumGlobalWebActiveMainFrameFailurePort {
  report: (failure: ChromiumGlobalWebActiveMainFrameFailure) => void;
}

export interface ChromiumGlobalWebSurfaceHandle {
  readonly surfaceId: string;
  readonly slotId: string;
  readonly generation: number;
  readonly parentId: number;
  readonly url: string;
}

export interface ChromiumGlobalWebSurfaceRuntimeEvidence {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly contentProfilePath: string;
  readonly currentUrl: string;
  /** Internal identity fence used to prove the local chrome shell is isolated. */
  readonly contentSession: ChromiumGlobalWebSurfaceLease["session"];
}

interface ChromiumNavigationHistoryPort {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
}

type NavigableGlobalWebContents = ChromiumRoleSurfaceWebContentsPort & Readonly<{
  navigationHistory: ChromiumNavigationHistoryPort;
  reload: () => void;
}>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

interface SurfaceListeners {
  readonly didStartNavigation: ChromiumRoleSurfaceEventMap["did-start-navigation"];
  readonly didFinishLoad: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly enteredHtmlFullscreen: () => void;
  readonly leftHtmlFullscreen: () => void;
  readonly destroyed: () => void;
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: (
    event: ChromiumRoleSurfaceEvent,
    url: string
  ) => void;
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface SurfaceRecord {
  readonly attemptGeneration: string;
  readonly surfaceId: string;
  readonly slotId: string;
  readonly generation: number;
  readonly tabId: string;
  readonly windowGeneration: number;
  readonly windowId: string;
  readonly sessionLease: ChromiumGlobalWebSurfaceLease;
  readonly view: ChromiumRoleWebContentsViewPort;
  readonly contents: ChromiumRoleSurfaceWebContentsPort;
  readonly creation: Deferred<ChromiumGlobalWebSurfaceHandle>;
  readonly webContentsDestroyed: Deferred<void>;
  readonly destruction: Deferred<void>;
  parent: ChromiumRoleSurfaceParentPort;
  listeners: SurfaceListeners;
  state: SurfaceState;
  attached: boolean;
  destroyed: boolean;
  loadSettled: boolean;
  nativeAttachmentSettlement: Promise<void> | null;
  nativeRetirement: Promise<void> | null;
  closePromise: Promise<boolean> | null;
  releasePromise: Promise<boolean> | null;
  terminalObservation: Promise<void> | null;
  terminalFailure: unknown | null;
  nativeAttachmentRetired: boolean;
  activeFailureReported: boolean;
}

interface GlobalWebNetworkErrorDetails {
  readonly error: string;
  readonly resourceType: string;
  readonly url: string;
  readonly webContents?: object;
  readonly webContentsId?: number;
}

interface GlobalWebNetworkFailureSessionPort {
  readonly webRequest: Readonly<{
    onErrorOccurred: (
      listener: ((details: GlobalWebNetworkErrorDetails) => void) | null
    ) => void;
  }>;
}

interface ParentOwner {
  readonly parent: ChromiumRoleSurfaceParentPort;
  count: number;
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

function surfaceError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw surfaceError(code, message);
}

function validateIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    value !== value.trim() || value.includes("/") || value.includes("\\") ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_ID_INVALID",
      `Core supplied an invalid global Web ${field} identity.`
    );
  }
}

function validateGeneration(generation: unknown): asserts generation is number {
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_GENERATION_INVALID",
      "A positive native generation is required for the global Web surface."
    );
  }
}

function validateBounds(bounds: ChromiumRoleSurfaceBounds): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < 0 || bounds.height < 0
  ) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_BOUNDS_INVALID",
      "Global Web surface bounds must contain finite integer coordinates and sizes."
    );
  }
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function validateZoomFactor(zoomFactor: number): void {
  if (!Number.isFinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_ZOOM_INVALID",
      "The global Web surface zoom factor must be between 0.25 and 5."
    );
  }
}

function canonicalWebUrl(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return character === "\\" || /\s/u.test(character) ||
        point <= 0x1f || point === 0x7f;
    })
  ) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_URL_INVALID",
      "A canonical HTTP(S) URL is required for the global Web surface."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_URL_INVALID",
      "A canonical HTTP(S) URL is required for the global Web surface."
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 || parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    fail(
      "ELECTRON_GLOBAL_WEB_SURFACE_URL_INVALID",
      "A canonical HTTP(S) URL is required for the global Web surface."
    );
  }
  return parsed.href;
}

function isAllowedNavigation(value: string): boolean {
  try {
    canonicalWebUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owns unprivileged Chromium surfaces for workspace Web slots. Managed roles
 * never enter this registry and global Web pages receive no preload bridge,
 * overlay channel, macro target, or background trusted-input capture.
 */
export class ChromiumGlobalWebSurfaceRegistry {
  readonly #sessions: ChromiumGlobalWebSurfaceSessionOwnerPort;
  readonly #views: ChromiumWebContentsViewFactoryPort;
  readonly #nativeAttachments: ChromiumGlobalWebNativeAttachmentPort | null;
  readonly #popups: ChromiumPopupOwnerLifecyclePort | null;
  readonly #activeMainFrameFailures: ChromiumGlobalWebActiveMainFrameFailurePort | null;
  readonly #records = new Map<string, SurfaceRecord>();
  readonly #surfaceByView = new WeakMap<object, string>();
  readonly #surfaceByWebContents = new WeakMap<object, string>();
  readonly #surfaceByWebContentsId = new Map<number, string>();
  readonly #parentsById = new Map<number, ParentOwner>();
  #networkFailureSession: GlobalWebNetworkFailureSessionPort | null = null;
  #state: RegistryState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(
    sessions: ChromiumGlobalWebSurfaceSessionOwnerPort,
    views: ChromiumWebContentsViewFactoryPort,
    nativeAttachments: ChromiumGlobalWebNativeAttachmentPort | null = null,
    popups: ChromiumPopupOwnerLifecyclePort | null = null,
    activeMainFrameFailures: ChromiumGlobalWebActiveMainFrameFailurePort | null = null
  ) {
    this.#sessions = sessions;
    this.#views = views;
    this.#nativeAttachments = nativeAttachments;
    this.#popups = popups;
    this.#activeMainFrameFailures = activeMainFrameFailures;
  }

  get activeCount(): number {
    return this.#records.size;
  }

  create(
    input: CreateChromiumGlobalWebSurfaceInput
  ): Promise<ChromiumGlobalWebSurfaceHandle> {
    this.#requireOpen();
    validateIdentifier(input.attemptGeneration, "attempt generation");
    validateIdentifier(input.surfaceId, "surface");
    validateIdentifier(input.slotId, "slot");
    validateIdentifier(input.tabId, "tab");
    validateIdentifier(input.windowId, "window");
    validateGeneration(input.generation);
    validateGeneration(input.windowGeneration);
    validateBounds(input.bounds);
    validateZoomFactor(input.zoomFactor);
    const url = canonicalWebUrl(input.url);
    this.#validateParent(input.parent);
    if (this.#records.size >= MAX_GLOBAL_WEB_SURFACES) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_CAPACITY",
        "The bounded global Web surface registry is full."
      );
    }
    if (this.#records.has(input.surfaceId)) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_OWNERSHIP_CONFLICT",
        "The synthetic Web identity already owns a native Chromium surface."
      );
    }
    const parentOwner = this.#parentsById.get(input.parent.id);
    if (parentOwner && parentOwner.parent !== input.parent) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_PARENT_CONFLICT",
        "The parent ID is already bound to another native runtime window."
      );
    }

    const sessionLease = this.#sessions.acquireSurface(
      input.surfaceId,
      input.generation,
      input.profile
    );
    let view: ChromiumRoleWebContentsViewPort;
    try {
      this.#installNetworkFailureObservation(sessionLease.session);
      view = this.#views.create({
        webPreferences: {
          ...buildUnprivilegedRemoteContentWebPreferences(),
          session: sessionLease.session
        }
      });
    } catch {
      return this.#rejectAfterSessionRelease(
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_CREATE_FAILED",
          "Electron could not create the global Web Chromium surface."
        )
      );
    }
    const contents = view.webContents;
    if (
      this.#surfaceByView.has(view) ||
      this.#surfaceByWebContents.has(contents) ||
      (Number.isSafeInteger(contents.id) && contents.id! > 0 &&
        this.#surfaceByWebContentsId.has(contents.id!))
    ) {
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_NATIVE_ALIAS",
          "Electron returned one native Web surface for distinct identities."
        )
      );
    }
    if (contents.session !== sessionLease.session) {
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_SESSION_MISMATCH",
          "The global Web surface is not bound to the exact shared session."
        )
      );
    }

    const record = this.#buildRecord(input, sessionLease, view, contents);
    if (record.destroyed) {
      return this.#rejectAfterSessionRelease(
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_CREATE_FAILED",
          "Electron returned an already-destroyed global Web surface."
        )
      );
    }
    try {
      this.#installSecurityPolicy(record);
      view.setBounds({ ...input.bounds });
      if (!sameBounds(view.getBounds(), input.bounds)) {
        fail(
          "ELECTRON_GLOBAL_WEB_BOUNDS_READBACK_FAILED",
          "The global Web surface did not retain its initial bounds."
        );
      }
      view.setVisible(input.visible);
      contents.setAudioMuted(input.audioMuted);
      if (contents.isAudioMuted() !== input.audioMuted) {
        fail(
          "ELECTRON_GLOBAL_WEB_SURFACE_AUDIO_READBACK_FAILED",
          "The global Web surface did not retain its initial audio state."
        );
      }
      contents.setZoomFactor(input.zoomFactor);
      if (contents.getZoomFactor() !== input.zoomFactor) {
        fail(
          "ELECTRON_GLOBAL_WEB_ZOOM_READBACK_FAILED",
          "The global Web surface did not retain its initial zoom factor."
        );
      }
    } catch {
      this.#removeAllListeners(record);
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_CREATE_FAILED",
          "Electron could not secure the global Web Chromium surface."
        )
      );
    }
    if (input.parent.isDestroyed()) {
      this.#removeAllListeners(record);
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionLease,
        surfaceError(
          "ELECTRON_GLOBAL_WEB_SURFACE_PARENT_INVALID",
          "A live native parent is required for the global Web surface."
        )
      );
    }

    this.#records.set(record.surfaceId, record);
    this.#surfaceByView.set(view, record.surfaceId);
    this.#surfaceByWebContents.set(contents, record.surfaceId);
    if (Number.isSafeInteger(contents.id) && contents.id! > 0) {
      this.#surfaceByWebContentsId.set(contents.id!, record.surfaceId);
    }
    this.#retainParent(record.parent);
    if (this.#nativeAttachments) {
      const settlement = this.#nativeAttachments.attachNonInputSurface({
        surfaceId: record.surfaceId,
        generation: record.generation,
        parent: record.parent,
        isCancelled: () => record.state !== "opening" || record.destroyed ||
          record.parent.isDestroyed(),
        attach: () => {
          record.parent.contentView.addChildView(record.view);
          record.attached = true;
        },
        detach: () => this.#detach(record)
      });
      record.nativeAttachmentSettlement = settlement;
      void settlement.then(
        () => this.#loadAttachedRecord(record, url),
        () => this.#failInitialAttachment(record)
      );
    } else {
      try {
        record.parent.contentView.addChildView(record.view);
        record.attached = true;
        this.#loadAttachedRecord(record, url);
      } catch {
        this.#failInitialAttachment(record);
      }
    }
    return record.creation.promise;
  }

  setBounds(
    surfaceId: string,
    generation: number,
    bounds: ChromiumRoleSurfaceBounds
  ): void {
    validateBounds(bounds);
    const view = this.#activeRecord(surfaceId, generation).view;
    view.setBounds({ ...bounds });
    if (!sameBounds(view.getBounds(), bounds)) {
      fail(
        "ELECTRON_GLOBAL_WEB_BOUNDS_READBACK_FAILED",
        "The global Web surface did not acknowledge its requested bounds."
      );
    }
  }

  readProjection(
    surfaceId: string,
    generation: number
  ): Readonly<{
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
    zoomFactor: number;
  }> {
    const record = this.#activeRecord(surfaceId, generation);
    const view = record.view;
    return Object.freeze({
      bounds: Object.freeze({ ...view.getBounds() }),
      visible: view.getVisible(),
      zoomFactor: record.contents.getZoomFactor()
    });
  }

  setVisible(surfaceId: string, generation: number, visible: boolean): void {
    this.#activeRecord(surfaceId, generation).view.setVisible(visible);
  }

  setZoomFactor(surfaceId: string, generation: number, zoomFactor: number): void {
    validateZoomFactor(zoomFactor);
    const contents = this.#activeRecord(surfaceId, generation).contents;
    contents.setZoomFactor(zoomFactor);
    if (contents.getZoomFactor() !== zoomFactor) {
      fail(
        "ELECTRON_GLOBAL_WEB_ZOOM_READBACK_FAILED",
        "The global Web surface did not acknowledge its requested zoom factor."
      );
    }
  }

  runtimeEvidence(
    surfaceId: string,
    generation: number
  ): ChromiumGlobalWebSurfaceRuntimeEvidence {
    const record = this.#activeRecord(surfaceId, generation);
    const contents = this.#navigableContents(record);
    return Object.freeze({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      contentProfilePath: record.sessionLease.chromiumUserDataDir,
      currentUrl: canonicalWebUrl(contents.getURL()),
      contentSession: record.sessionLease.session
    });
  }

  navigate(
    surfaceId: string,
    generation: number,
    url: string
  ): Promise<ChromiumGlobalWebSurfaceRuntimeEvidence> {
    const record = this.#activeRecord(surfaceId, generation);
    const destination = canonicalWebUrl(url);
    return this.#observeNavigation(
      record,
      () => record.contents.loadURL(destination),
      destination
    );
  }

  goBack(
    surfaceId: string,
    generation: number
  ): Promise<ChromiumGlobalWebSurfaceRuntimeEvidence> {
    const record = this.#activeRecord(surfaceId, generation);
    const contents = this.#navigableContents(record);
    if (!contents.navigationHistory.canGoBack()) {
      return Promise.resolve(this.runtimeEvidence(surfaceId, generation));
    }
    return this.#observeNavigation(record, () => contents.navigationHistory.goBack());
  }

  goForward(
    surfaceId: string,
    generation: number
  ): Promise<ChromiumGlobalWebSurfaceRuntimeEvidence> {
    const record = this.#activeRecord(surfaceId, generation);
    const contents = this.#navigableContents(record);
    if (!contents.navigationHistory.canGoForward()) {
      return Promise.resolve(this.runtimeEvidence(surfaceId, generation));
    }
    return this.#observeNavigation(
      record,
      () => contents.navigationHistory.goForward()
    );
  }

  reload(
    surfaceId: string,
    generation: number
  ): Promise<ChromiumGlobalWebSurfaceRuntimeEvidence> {
    const record = this.#activeRecord(surfaceId, generation);
    const contents = this.#navigableContents(record);
    return this.#observeNavigation(record, () => contents.reload());
  }

  async reparentSurface(
    surfaceId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): Promise<void> {
    const record = this.#activeRecord(surfaceId, generation);
    this.#validateParent(parent);
    if (record.parent === parent) return;
    const targetOwner = this.#parentsById.get(parent.id);
    if (targetOwner && targetOwner.parent !== parent) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_PARENT_CONFLICT",
        "The reparent target ID is already bound to another native window."
      );
    }
    const previous = record.parent;
    await this.#popups?.retireOwnerPopupsForMove({
      ownerKind: "globalWeb",
      ownerId: record.surfaceId,
      nativeGeneration: record.generation
    });
    const currentTargetOwner = this.#parentsById.get(parent.id);
    if (
      this.#activeRecord(surfaceId, generation) !== record ||
      record.parent !== previous || parent.isDestroyed() ||
      (currentTargetOwner !== undefined && currentTargetOwner.parent !== parent)
    ) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_FENCE_STALE",
        "The global Web surface or target host changed while its popups retired."
      );
    }
    if (this.#nativeAttachments) {
      await (record.nativeAttachmentSettlement ?? Promise.resolve());
      await this.#nativeAttachments.detachNonInputSurface(
        record.surfaceId,
        record.generation,
        previous
      );
      record.parent = parent;
      record.nativeRetirement = null;
      const targetAttachment = this.#nativeAttachments.attachNonInputSurface({
        surfaceId: record.surfaceId,
        generation: record.generation,
        parent,
        isCancelled: () => record.state !== "active" || record.destroyed ||
          parent.isDestroyed(),
        attach: () => {
          parent.contentView.addChildView(record.view);
          record.attached = true;
        },
        detach: () => this.#detach(record)
      });
      record.nativeAttachmentSettlement = targetAttachment;
      try {
        await targetAttachment;
      } catch {
        record.parent = previous;
        const rollback = this.#nativeAttachments.attachNonInputSurface({
          surfaceId: record.surfaceId,
          generation: record.generation,
          parent: previous,
          isCancelled: () => record.destroyed || previous.isDestroyed(),
          attach: () => {
            previous.contentView.addChildView(record.view);
            record.attached = true;
          },
          detach: () => this.#detach(record)
        });
        record.nativeAttachmentSettlement = rollback;
        try {
          await rollback;
        } catch {
          record.state = "load-failed";
          fail(
            "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_ROLLBACK_FAILED",
            "The global Web surface could not attach to its target or restore its prior AppKit host."
          );
        }
        fail(
          "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_FAILED",
          "The global Web surface could not attach to its exact target AppKit host."
        );
      }
    } else {
      try {
        previous.contentView.removeChildView(record.view);
        record.attached = false;
      } catch {
        fail(
          "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_DETACH_FAILED",
          "The global Web surface could not detach from its prior native parent."
        );
      }
      record.parent = parent;
      try {
        parent.contentView.addChildView(record.view);
        record.attached = true;
      } catch {
        record.parent = previous;
        try {
          previous.contentView.addChildView(record.view);
          record.attached = true;
        } catch {
          record.state = "load-failed";
          fail(
            "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_ROLLBACK_FAILED",
            "The global Web surface could not attach to its target or restore its prior native parent."
          );
        }
        fail(
          "ELECTRON_GLOBAL_WEB_SURFACE_REPARENT_FAILED",
          "The global Web surface could not attach to its exact target native parent."
        );
      }
    }
    this.#retainParent(parent);
    this.#releaseParent(previous);
  }

  audioMuted(surfaceId: string, generation: number): boolean {
    return this.#activeRecord(surfaceId, generation).contents.isAudioMuted();
  }

  isCurrentlyAudible(surfaceId: string, generation: number): boolean {
    validateIdentifier(surfaceId, "surface");
    validateGeneration(generation);
    const record = this.#records.get(surfaceId);
    if (!record) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_NOT_FOUND",
        "The synthetic Web identity has no native Chromium surface."
      );
    }
    if (record.generation !== generation) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_STALE_GENERATION",
        "The global Web surface generation is stale."
      );
    }
    if (record.state === "closing" || record.destroyed ||
      record.contents.isDestroyed()) {
      return false;
    }
    if (record.state !== "active") {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_NOT_ACTIVE",
        "The global Web Chromium surface is not active."
      );
    }
    return record.contents.isCurrentlyAudible();
  }

  setAudioMuted(surfaceId: string, generation: number, muted: boolean): void {
    const contents = this.#activeRecord(surfaceId, generation).contents;
    contents.setAudioMuted(muted);
    if (contents.isAudioMuted() !== muted) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_AUDIO_READBACK_FAILED",
        "The global Web surface did not acknowledge its requested audio state."
      );
    }
  }

  closeSurface(surfaceId: string, generation: number): Promise<boolean> {
    validateIdentifier(surfaceId, "surface");
    validateGeneration(generation);
    const record = this.#records.get(surfaceId);
    if (!record) return Promise.resolve(false);
    if (record.generation !== generation) {
      return Promise.reject(surfaceError(
        "ELECTRON_GLOBAL_WEB_SURFACE_STALE_GENERATION",
        "The global Web surface generation is stale."
      ));
    }
    return this.#beginTerminalClose(record);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "draining";
    this.#disposePromise = Promise.allSettled(
      [...this.#records.values()].map((record) =>
        this.closeSurface(record.surfaceId, record.generation)
      )
    ).then(async (results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      await this.#sessions.dispose();
      this.#removeNetworkFailureObservation();
      this.#state = "disposed";
    }).catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  #buildRecord(
    input: CreateChromiumGlobalWebSurfaceInput,
    sessionLease: ChromiumGlobalWebSurfaceLease,
    view: ChromiumRoleWebContentsViewPort,
    contents: ChromiumRoleSurfaceWebContentsPort
  ): SurfaceRecord {
    const record: SurfaceRecord = {
      attemptGeneration: input.attemptGeneration,
      surfaceId: input.surfaceId,
      slotId: input.slotId,
      generation: input.generation,
      tabId: input.tabId,
      windowGeneration: input.windowGeneration,
      windowId: input.windowId,
      sessionLease,
      view,
      contents,
      creation: deferred(),
      webContentsDestroyed: deferred(),
      destruction: deferred(),
      parent: input.parent,
      listeners: undefined as unknown as SurfaceListeners,
      state: "opening",
      attached: false,
      destroyed: contents.isDestroyed(),
      loadSettled: false,
      nativeAttachmentSettlement: null,
      nativeRetirement: null,
      closePromise: null,
      releasePromise: null,
      terminalObservation: null,
      terminalFailure: null,
      nativeAttachmentRetired: false,
      activeFailureReported: false
    };
    record.listeners = {
      didStartNavigation: (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
          record.activeFailureReported = false;
        }
      },
      didFinishLoad: () => this.#finishInitialLoad(record),
      didFailLoad: (
        _event,
        _errorCode,
        _errorDescription,
        _validatedUrl,
        isMainFrame
      ) => {
        if (!isMainFrame) return;
        if (record.state === "opening") {
          this.#failInitialLoad(record);
        } else if (record.state === "active") {
          this.#reportActiveMainFrameFailure(record, _errorCode, _validatedUrl);
        }
      },
      enteredHtmlFullscreen: () => input.onContainedFullscreenChange?.(true),
      leftHtmlFullscreen: () => input.onContainedFullscreenChange?.(false),
      destroyed: () => this.#onDestroyed(record),
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: (event, destination) => {
        if (!isAllowedNavigation(destination)) event.preventDefault();
      },
      willRedirect: (event, destination) => {
        if (!isAllowedNavigation(destination)) event.preventDefault();
      }
    };
    return record;
  }

  #installSecurityPolicy(record: SurfaceRecord): void {
    const contents = record.contents;
    contents.setWindowOpenHandler((details) => {
      if (
        this.#popups && this.#state === "open" && record.state === "active" &&
        !record.destroyed && this.#records.get(record.surfaceId) === record
      ) {
        this.#popups.requestOpen(Object.freeze({
          ownerKind: "globalWeb",
          ownerId: record.surfaceId,
          slotId: record.slotId,
          nativeGeneration: record.generation,
          parent: record.parent,
          session: record.sessionLease.session
        }), details);
      }
      return { action: "deny" };
    });
    contents.on("will-attach-webview", record.listeners.willAttachWebview);
    contents.on("will-navigate", record.listeners.willNavigate);
    contents.on("will-redirect", record.listeners.willRedirect);
    contents.on("did-start-navigation", record.listeners.didStartNavigation);
    contents.on("did-finish-load", record.listeners.didFinishLoad);
    contents.on("did-fail-load", record.listeners.didFailLoad);
    contents.on("enter-html-full-screen", record.listeners.enteredHtmlFullscreen);
    contents.on("leave-html-full-screen", record.listeners.leftHtmlFullscreen);
    contents.on("destroyed", record.listeners.destroyed);
  }

  #finishInitialLoad(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    let loadedUrl: string;
    try {
      loadedUrl = canonicalWebUrl(record.contents.getURL());
    } catch {
      return;
    }
    record.state = "active";
    record.loadSettled = true;
    record.creation.resolve(Object.freeze({
      surfaceId: record.surfaceId,
      slotId: record.slotId,
      generation: record.generation,
      parentId: record.parent.id,
      url: loadedUrl
    }));
  }

  #failInitialLoad(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    record.state = "load-failed";
    record.loadSettled = true;
    record.creation.reject(surfaceError(
      "ELECTRON_GLOBAL_WEB_SURFACE_LOAD_FAILED",
      "The global Web surface did not finish its main-frame load."
    ));
  }

  #failInitialAttachment(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    record.state = "load-failed";
    record.loadSettled = true;
    this.#removeLoadListeners(record);
    record.creation.reject(surfaceError(
      "ELECTRON_GLOBAL_WEB_SURFACE_NATIVE_ATTACH_FAILED",
      "The global Web surface did not establish exact native ownership."
    ));
    this.#observeTerminalClose(record);
  }

  #loadAttachedRecord(record: SurfaceRecord, url: string): void {
    if (record.state !== "opening" || record.destroyed || !record.attached) {
      this.#failInitialAttachment(record);
      return;
    }
    try {
      const load = record.contents.loadURL(url);
      // EventBound: did-finish-load/did-fail-load terminalizes navigation.
      void load.catch(() => undefined);
    } catch {
      this.#failInitialLoad(record);
    }
  }

  #beginTerminalClose(record: SurfaceRecord): Promise<boolean> {
    if (record.closePromise) return record.closePromise;
    record.state = "closing";
    record.terminalFailure = null;
    const completion = deferred<boolean>();
    record.closePromise = completion.promise;
    const continueAfterNativeRetirement = (): Promise<boolean> => {
      record.nativeAttachmentRetired = true;
      if (this.#nativeAttachments) {
        if (record.attached) {
          fail(
            "ELECTRON_GLOBAL_WEB_SURFACE_NATIVE_RETIREMENT_INCOMPLETE",
            "AppKit acknowledged retirement without detaching the exact global Web surface."
          );
        }
      } else {
        this.#detach(record);
      }
      if (!record.destroyed) {
        record.view.setVisible(false);
        record.contents.close({ waitForBeforeUnload: false });
      }
      // EventBound: Chromium destruction becomes terminal only after AppKit's
      // FIFO has acknowledged non-input retirement and physical detach.
      return record.webContentsDestroyed.promise.then(() => {
        record.destruction.resolve();
        return this.#releaseDestroyedRecord(record);
      });
    };
    const continueAfterPopupRetirement = () => this.#nativeAttachments
      ? this.#retireNativeAttachment(record).then(continueAfterNativeRetirement)
      : continueAfterNativeRetirement();
    const terminal = this.#popups
      ? this.#popups.retireOwner({
          ownerKind: "globalWeb",
          ownerId: record.surfaceId,
          nativeGeneration: record.generation
        }).then(continueAfterPopupRetirement)
      : continueAfterPopupRetirement();
    void terminal.then(completion.resolve, (error: unknown) => {
      if (record.closePromise === completion.promise) {
        record.state = "quarantined";
        record.terminalFailure = error;
        record.closePromise = null;
      }
      completion.reject(error);
    });
    return completion.promise;
  }

  #observeTerminalClose(record: SurfaceRecord): void {
    const terminal = this.#beginTerminalClose(record);
    record.terminalObservation = terminal.then(
      () => undefined,
      (error: unknown) => {
        record.terminalFailure = error;
      }
    );
  }

  #onDestroyed(record: SurfaceRecord): void {
    if (record.destroyed) return;
    record.destroyed = true;
    record.state = "closing";
    if (!record.loadSettled) {
      record.loadSettled = true;
      this.#removeLoadListeners(record);
      record.creation.reject(surfaceError(
        "ELECTRON_GLOBAL_WEB_SURFACE_DESTROYED",
        "The global Web surface was destroyed before load completion."
      ));
    }
    record.webContentsDestroyed.resolve();
    this.#observeTerminalClose(record);
  }

  #retireNativeAttachment(record: SurfaceRecord): Promise<void> {
    if (!this.#nativeAttachments) return Promise.resolve();
    if (record.nativeRetirement) return record.nativeRetirement;
    const requestedRetirement = (record.nativeAttachmentSettlement ??
      Promise.resolve()).then(() =>
        this.#nativeAttachments!.detachNonInputSurface(
          record.surfaceId,
          record.generation,
          record.parent
        )
      );
    const retirement = requestedRetirement.catch((error: unknown) => {
      if (record.nativeRetirement === retirement) {
        record.nativeRetirement = null;
      }
      throw error;
    });
    record.nativeRetirement = retirement;
    return retirement;
  }

  #releaseDestroyedRecord(record: SurfaceRecord): Promise<boolean> {
    if (record.releasePromise) return record.releasePromise;
    if (
      !record.destroyed ||
      !record.nativeAttachmentRetired ||
      record.attached
    ) {
      return Promise.reject(surfaceError(
        "ELECTRON_GLOBAL_WEB_SURFACE_RELEASE_BEFORE_NATIVE_RETIREMENT",
        "The global Web surface must be destroyed and exactly detached before shared-session release."
      ));
    }
    record.releasePromise = this.#sessions.releaseSurface(record.sessionLease)
      .then(() => {
        this.#removeAllListeners(record);
        if (this.#records.get(record.surfaceId) === record) {
          this.#records.delete(record.surfaceId);
        }
        if (record.contents.id !== undefined &&
          this.#surfaceByWebContentsId.get(record.contents.id) === record.surfaceId) {
          this.#surfaceByWebContentsId.delete(record.contents.id);
        }
        this.#releaseParent(record.parent);
        return true;
      })
      .catch((error: unknown) => {
        record.releasePromise = null;
        throw error;
      });
    return record.releasePromise;
  }

  #rejectAfterSessionRelease(
    lease: ChromiumGlobalWebSurfaceLease,
    primary: RionBridgeError
  ): Promise<never> {
    return this.#sessions.releaseSurface(lease).then(
      () => Promise.reject(primary),
      () => Promise.reject(surfaceError(
        "ELECTRON_GLOBAL_WEB_SURFACE_SESSION_RELEASE_FAILED",
        "The failed global Web surface retained unknown shared-session ownership."
      ))
    );
  }

  #rejectAfterUnattachedViewDestroy(
    contents: ChromiumRoleSurfaceWebContentsPort,
    lease: ChromiumGlobalWebSurfaceLease,
    primary: RionBridgeError
  ): Promise<never> {
    if (contents.isDestroyed()) {
      return this.#rejectAfterSessionRelease(lease, primary);
    }
    const destroyed = deferred<void>();
    const onDestroyed = () => {
      contents.removeListener("destroyed", onDestroyed);
      destroyed.resolve();
    };
    contents.on("destroyed", onDestroyed);
    try {
      contents.close({ waitForBeforeUnload: false });
    } catch {
      // EventBound: ownership remains until Electron emits destroyed.
    }
    return destroyed.promise.then(() =>
      this.#rejectAfterSessionRelease(lease, primary)
    );
  }

  #activeRecord(surfaceId: string, generation: number): SurfaceRecord {
    validateIdentifier(surfaceId, "surface");
    validateGeneration(generation);
    const record = this.#records.get(surfaceId);
    if (!record) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_NOT_FOUND",
        "The synthetic Web identity has no native Chromium surface."
      );
    }
    if (record.generation !== generation) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_STALE_GENERATION",
        "The global Web surface generation is stale."
      );
    }
    if (record.state !== "active" || record.destroyed) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_NOT_ACTIVE",
        "The global Web Chromium surface is not active."
      );
    }
    return record;
  }

  #navigableContents(record: SurfaceRecord): NavigableGlobalWebContents {
    const contents = record.contents as NavigableGlobalWebContents;
    if (
      !contents.navigationHistory ||
      typeof contents.navigationHistory.canGoBack !== "function" ||
      typeof contents.navigationHistory.canGoForward !== "function" ||
      typeof contents.navigationHistory.goBack !== "function" ||
      typeof contents.navigationHistory.goForward !== "function" ||
      typeof contents.reload !== "function"
    ) {
      fail(
        "ELECTRON_GLOBAL_WEB_NAVIGATION_UNAVAILABLE",
        "The Chromium Web surface does not expose its exact navigation-history owner."
      );
    }
    return contents;
  }

  #observeNavigation(
    record: SurfaceRecord,
    begin: () => void | Promise<void>,
    requestedUrl?: string
  ): Promise<ChromiumGlobalWebSurfaceRuntimeEvidence> {
    const completion = deferred<ChromiumGlobalWebSurfaceRuntimeEvidence>();
    let settled = false;
    record.activeFailureReported = false;
    const remove = () => {
      record.contents.removeListener("did-finish-load", didFinishLoad);
      record.contents.removeListener("did-fail-load", didFailLoad);
      record.contents.removeListener("destroyed", destroyed);
    };
    const reject = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      remove();
      completion.reject(surfaceError(code, message));
    };
    const failActiveMainFrame = (errorCode: number, validatedUrl: string) => {
      if (settled) return;
      this.#reportActiveMainFrameFailure(record, errorCode, validatedUrl);
      reject(
        "ELECTRON_GLOBAL_WEB_NAVIGATION_FAILED",
        "Chromium rejected the remote Web navigation."
      );
    };
    const didFinishLoad = () => {
      if (settled) return;
      try {
        const evidence = this.runtimeEvidence(record.surfaceId, record.generation);
        settled = true;
        remove();
        completion.resolve(evidence);
      } catch {
        reject(
          "ELECTRON_GLOBAL_WEB_NAVIGATION_READBACK_FAILED",
          "Chromium did not acknowledge the exact remote Web navigation."
        );
      }
    };
    const didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"] = (
      _event,
      errorCode,
      _errorDescription,
      validatedUrl,
      isMainFrame
    ) => {
      if (isMainFrame) failActiveMainFrame(errorCode, validatedUrl);
    };
    const destroyed = () => reject(
      "ELECTRON_GLOBAL_WEB_NAVIGATION_DESTROYED",
      "The remote Web surface closed before navigation completed."
    );
    record.contents.on("did-finish-load", didFinishLoad);
    record.contents.on("did-fail-load", didFailLoad);
    record.contents.on("destroyed", destroyed);
    try {
      const terminal = begin();
      if (terminal) {
        void terminal.catch((error: unknown) => {
          // EventBound: Electron documents loadURL rejection as the exact
          // did-fail-load terminal for the requested main-frame navigation.
          const errorCode = typeof error === "object" && error !== null &&
            Number.isSafeInteger((error as { errorCode?: unknown }).errorCode)
            ? (error as { errorCode: number }).errorCode
            : 0;
          failActiveMainFrame(errorCode, requestedUrl ?? record.contents.getURL());
        });
      }
    } catch {
      failActiveMainFrame(0, requestedUrl ?? record.contents.getURL());
    }
    return completion.promise;
  }

  #reportActiveMainFrameFailure(
    record: SurfaceRecord,
    errorCode: number,
    validatedUrl: string
  ): void {
    if (
      record.state !== "active" || record.destroyed ||
      this.#records.get(record.surfaceId) !== record ||
      record.activeFailureReported
    ) {
      return;
    }
    record.activeFailureReported = true;
    this.#activeMainFrameFailures?.report(Object.freeze({
      attemptGeneration: record.attemptGeneration,
      errorCode,
      surfaceGeneration: record.generation,
      surfaceId: record.surfaceId,
      tabId: record.tabId,
      validatedUrl,
      windowGeneration: record.windowGeneration,
      windowId: record.windowId
    }));
  }

  #installNetworkFailureObservation(session: object): void {
    const candidate = session as Partial<GlobalWebNetworkFailureSessionPort>;
    if (!candidate.webRequest ||
      typeof candidate.webRequest.onErrorOccurred !== "function") {
      fail(
        "ELECTRON_GLOBAL_WEB_NETWORK_OBSERVER_UNAVAILABLE",
        "The global Web Session cannot publish authoritative request failures."
      );
    }
    if (this.#networkFailureSession === candidate) return;
    if (this.#networkFailureSession) {
      fail(
        "ELECTRON_GLOBAL_WEB_NETWORK_OBSERVER_CONFLICT",
        "The global Web registry received more than one shared Session owner."
      );
    }
    candidate.webRequest.onErrorOccurred((details) => {
      if (details.resourceType !== "mainFrame") return;
      const surfaceId = details.webContents
        ? this.#surfaceByWebContents.get(details.webContents)
        : Number.isSafeInteger(details.webContentsId)
          ? this.#surfaceByWebContentsId.get(details.webContentsId!)
          : undefined;
      const record = surfaceId ? this.#records.get(surfaceId) : undefined;
      if (record) this.#reportActiveMainFrameFailure(record, 0, details.url);
    });
    this.#networkFailureSession = candidate as GlobalWebNetworkFailureSessionPort;
  }

  #removeNetworkFailureObservation(): void {
    if (!this.#networkFailureSession) return;
    this.#networkFailureSession.webRequest.onErrorOccurred(null);
    this.#networkFailureSession = null;
  }

  #validateParent(parent: ChromiumRoleSurfaceParentPort): void {
    if (
      !Number.isSafeInteger(parent.id) || parent.id < 1 || parent.isDestroyed()
    ) {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_PARENT_INVALID",
        "A live native parent is required for the global Web surface."
      );
    }
  }

  #requireOpen(): void {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_REGISTRY_DRAINING",
        "The global Web surface registry is draining and rejects new work."
      );
    }
  }

  #retainParent(parent: ChromiumRoleSurfaceParentPort): void {
    const existing = this.#parentsById.get(parent.id);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.#parentsById.set(parent.id, { parent, count: 1 });
  }

  #releaseParent(parent: ChromiumRoleSurfaceParentPort): void {
    const existing = this.#parentsById.get(parent.id);
    if (!existing || existing.parent !== parent) return;
    existing.count -= 1;
    if (existing.count === 0) this.#parentsById.delete(parent.id);
  }

  #detach(record: SurfaceRecord): void {
    if (!record.attached) return;
    try {
      record.parent.contentView.removeChildView(record.view);
    } catch {
      fail(
        "ELECTRON_GLOBAL_WEB_SURFACE_NATIVE_DETACH_FAILED",
        "The global Web surface could not detach from its exact native parent."
      );
    }
    record.attached = false;
  }

  #removeLoadListeners(record: SurfaceRecord): void {
    record.contents.removeListener(
      "did-finish-load",
      record.listeners.didFinishLoad
    );
    record.contents.removeListener(
      "did-fail-load",
      record.listeners.didFailLoad
    );
  }

  #removeAllListeners(record: SurfaceRecord): void {
    this.#removeLoadListeners(record);
    record.contents.removeListener(
      "will-attach-webview",
      record.listeners.willAttachWebview
    );
    record.contents.removeListener(
      "will-navigate",
      record.listeners.willNavigate
    );
    record.contents.removeListener(
      "will-redirect",
      record.listeners.willRedirect
    );
    record.contents.removeListener(
      "did-start-navigation",
      record.listeners.didStartNavigation
    );
    record.contents.removeListener(
      "enter-html-full-screen",
      record.listeners.enteredHtmlFullscreen
    );
    record.contents.removeListener(
      "leave-html-full-screen",
      record.listeners.leftHtmlFullscreen
    );
    record.contents.removeListener("destroyed", record.listeners.destroyed);
  }
}
