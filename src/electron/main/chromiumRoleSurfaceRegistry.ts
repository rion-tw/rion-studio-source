import type { BrowserAction } from "../../shared/generated";
import type { RionBridgeError } from "../ipc/errors";
import {
  CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL,
  type ChromiumRoleFontsRefreshControl,
  type ChromiumRoleFontsRefreshSubmissionReceipt
} from "../ipc/chromiumRoleFontsProtocol";
import { CHROMIUM_ROLE_OVERLAY_WORLD_ID } from
  "../ipc/chromiumRoleOverlayProtocol";
import {
  CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL,
  type ChromiumRoleTrustedInputControlEnvelope
} from "../ipc/chromiumRoleTrustedInputProtocol";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSessionOwnerPort,
  ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "./chromiumRoleSurfacePorts";
import { buildRemoteContentWebPreferences } from "./security";
import type { ChromiumPopupOwnerLifecyclePort } from "./chromiumPopupPorts";
import type { ChromiumRoleSessionHandle } from "./chromiumRoleSessionRegistry";
import {
  interceptChromiumRoleQuickAccessShortcut,
  type ChromiumRoleQuickAccessShortcutPort
} from "./chromiumRoleQuickAccessShortcut";
import type { ChromiumRoleActiveMainFrameFailurePort } from
  "./chromiumRoleNavigationFailureReporter";
import {
  ChromiumRoleNavigationLifecycleHub,
  ChromiumRoleNavigationLifecycleOwner,
  type ChromiumRoleControlledReloadPreparation,
  type ChromiumRoleNavigationLifecycleEvent
} from "./chromiumRoleNavigationLifecycle";
import {
  canonicalChromiumRoleUrl,
  isAllowedChromiumRoleNavigation
} from "./chromiumRoleSurfaceUrl";
import {
  fail,
  overlayRefreshSource,
  resolveTrustedInputClickPoint,
  sameBounds,
  sameOverlayFrame,
  surfaceError,
  validateBounds,
  validateGeneration,
  validateOverlayRefreshId,
  validateTabId,
  validateZoomFactor
} from "./chromiumRoleSurfaceRegistrySupport";
import type {
  ChromiumRoleNetworkFailureSessionPort,
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent,
  ChromiumRoleOverlayLifecycleReason,
  ChromiumRoleOverlayRefreshSubmissionReceipt,
  ChromiumRoleSurfaceDeferred as Deferred,
  ChromiumRoleSurfaceHandle,
  ChromiumRoleSurfaceListeners as SurfaceListeners,
  ChromiumRoleSurfaceParentOwner as ParentOwner,
  ChromiumRoleSurfaceRecord as SurfaceRecord,
  ChromiumRoleSurfaceRegistryState as RegistryState,
  CreateChromiumRoleSurfaceInput
} from "./chromiumRoleSurfaceRegistryTypes";
export type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent,
  ChromiumRoleOverlayLifecycleReason,
  ChromiumRoleOverlayRefreshSubmissionReceipt,
  ChromiumRoleSurfaceHandle,
  CreateChromiumRoleSurfaceInput
} from "./chromiumRoleSurfaceRegistryTypes";

export type {
  ChromiumRoleControlledReloadPreparation,
  ChromiumRoleNavigationLifecycleEvent
} from "./chromiumRoleNavigationLifecycle";


function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class ChromiumRoleSurfaceRegistry {
  readonly #sessions: ChromiumRoleSessionOwnerPort;
  readonly #views: ChromiumWebContentsViewFactoryPort;
  readonly #nativeAttachments: ChromiumRoleSurfaceNativeAttachmentPort | null;
  readonly #popups: ChromiumPopupOwnerLifecyclePort | null;
  readonly #quickAccess: ChromiumRoleQuickAccessShortcutPort | null;
  readonly #navigationFailures: ChromiumRoleActiveMainFrameFailurePort | null;
  readonly #recordsByRole = new Map<string, SurfaceRecord>();
  readonly #roleByView = new WeakMap<object, string>();
  readonly #roleByWebContents = new WeakMap<object, string>();
  readonly #retiredOverlayWebContents = new WeakSet<object>();
  readonly #parentsById = new Map<number, ParentOwner>();
  readonly #overlayLifecycleListeners = new Set<
    (event: ChromiumRoleOverlayLifecycleEvent) => void
  >();
  readonly #navigationLifecycle = new ChromiumRoleNavigationLifecycleHub();
  #state: RegistryState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(
    sessions: ChromiumRoleSessionOwnerPort,
    views: ChromiumWebContentsViewFactoryPort,
    nativeAttachments: ChromiumRoleSurfaceNativeAttachmentPort | null = null,
    popups: ChromiumPopupOwnerLifecyclePort | null = null,
    quickAccess: ChromiumRoleQuickAccessShortcutPort | null = null,
    navigationFailures: ChromiumRoleActiveMainFrameFailurePort | null = null
  ) {
    this.#sessions = sessions;
    this.#views = views;
    this.#nativeAttachments = nativeAttachments;
    this.#popups = popups;
    this.#quickAccess = quickAccess;
    this.#navigationFailures = navigationFailures;
  }

  get activeCount(): number {
    return this.#recordsByRole.size;
  }

  resolveInputSurface(roleId: string): Readonly<{
    roleId: string;
    surfaceGeneration: number;
    documentInstanceId: string;
    state: "active" | "closing";
  }> | null {
    const record = this.#recordsByRole.get(roleId);
    if (!record || record.destroyed ||
      (record.state !== "active" && record.state !== "closing")) {
      return null;
    }
    const documentInstanceId = record.navigation.documentInstanceId;
    if (!documentInstanceId || documentInstanceId.length > 128 ||
      documentInstanceId.trim() !== documentInstanceId) {
      return null;
    }
    return Object.freeze({
      roleId: record.roleId,
      surfaceGeneration: record.generation,
      documentInstanceId,
      state: record.state
    });
  }

  resolveTrustedInputClick(
    request: Readonly<{ roleId: string; action: BrowserAction }>,
    expectedFrame: ChromiumRoleOverlayFrameIdentity
  ): Readonly<{ clientX: number; clientY: number; zoomFactor: number }> {
    if (request.action.type !== "click") {
      fail(
        "ELECTRON_ROLE_TRUSTED_INPUT_CLICK_INVALID",
        "Only a click action may enter the Chromium click resolver."
      );
    }
    const record = this.#activeRecord(
      request.roleId,
      expectedFrame.generation
    );
    const currentFrame = this.currentTrustedInputFrame(
      request.roleId,
      expectedFrame.generation
    );
    if (!sameOverlayFrame(currentFrame, expectedFrame)) {
      fail(
        "ELECTRON_ROLE_TRUSTED_INPUT_DOCUMENT_SUPERSEDED",
        "The click no longer targets the exact live Chromium document."
      );
    }
    const bounds = record.view.getBounds();
    validateBounds(bounds);
    const zoomFactor = record.contents.getZoomFactor();
    validateZoomFactor(zoomFactor);
    // BrowserAction and DOM receipts use surface-local Chromium CSS pixels.
    // AppKit consumes NSView points, so the exact live page zoom must travel
    // with the resolved point instead of being inferred by the native host.
    return resolveTrustedInputClickPoint(request.action, bounds, zoomFactor);
  }

  authorizeOverlayFrame(
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ): ChromiumRoleOverlayFrameIdentity {
    if (
      typeof sender !== "object" || sender === null ||
      typeof senderFrame !== "object" || senderFrame === null ||
      typeof claimedFrameToken !== "string" ||
      claimedFrameToken.length === 0 ||
      claimedFrameToken.length > 128 ||
      claimedFrameToken !== claimedFrameToken.trim()
    ) {
      fail(
        "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED",
        "The Chromium overlay request does not carry a valid main-frame identity."
      );
    }
    const roleId = this.#roleByWebContents.get(sender);
    const record = roleId ? this.#recordsByRole.get(roleId) : undefined;
    const mainFrame = record?.contents.mainFrame;
    if (
      !record ||
      record.contents !== sender ||
      record.destroyed ||
      (record.state !== "opening" && record.state !== "active") ||
      !mainFrame ||
      mainFrame !== senderFrame ||
      mainFrame.frameToken !== claimedFrameToken
    ) {
      fail(
        "ELECTRON_ROLE_OVERLAY_FRAME_UNAUTHORIZED",
        "The Chromium overlay request is not from the exact live role main frame."
      );
    }
    return Object.freeze({
      roleId: record.roleId,
      generation: record.generation,
      frame: mainFrame,
      frameToken: mainFrame.frameToken,
      documentInstanceId: record.navigation.documentInstanceId
    });
  }

  isSupersededOverlayFrame(
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ): boolean {
    if (typeof sender !== "object" || sender === null ||
      typeof senderFrame !== "object" || senderFrame === null ||
      typeof claimedFrameToken !== "string" || claimedFrameToken.length === 0 ||
      claimedFrameToken.length > 128 || claimedFrameToken !== claimedFrameToken.trim()) {
      return false;
    }
    const roleId = this.#roleByWebContents.get(sender);
    const record = roleId ? this.#recordsByRole.get(roleId) : undefined;
    if (this.#retiredOverlayWebContents.has(sender)) return true;
    if (roleId && (!record || record.contents !== sender || record.destroyed ||
      record.state === "closing")) {
      return true;
    }
    const mainFrame = record?.contents.mainFrame;
    return Boolean(
      record && record.contents === sender && !record.destroyed &&
      (record.state === "opening" || record.state === "active") && mainFrame &&
      (mainFrame !== senderFrame || mainFrame.frameToken !== claimedFrameToken)
    );
  }

  authorizeTrustedInputFrame(
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ): ChromiumRoleOverlayFrameIdentity {
    const identity = this.authorizeOverlayFrame(
      sender,
      senderFrame,
      claimedFrameToken
    );
    const record = this.#recordsByRole.get(identity.roleId);
    if (record?.state !== "active") {
      fail(
        "ELECTRON_ROLE_TRUSTED_INPUT_FRAME_UNAUTHORIZED",
        "Trusted input requires the exact active Chromium role main frame."
      );
    }
    return identity;
  }

  currentOverlayFrame(
    roleId: string,
    generation: number
  ): ChromiumRoleOverlayFrameIdentity {
    const record = this.#activeRecord(roleId, generation);
    const mainFrame = record.contents.mainFrame;
    if (
      !mainFrame ||
      mainFrame.frameToken.length === 0 ||
      mainFrame.frameToken.length > 128 ||
      mainFrame.frameToken !== mainFrame.frameToken.trim()
    ) {
      fail(
        "ELECTRON_ROLE_OVERLAY_FRAME_UNAVAILABLE",
        "The active Chromium role surface has no authoritative main frame."
      );
    }
    return Object.freeze({
      roleId: record.roleId,
      generation: record.generation,
      frame: mainFrame,
      frameToken: mainFrame.frameToken,
      documentInstanceId: record.navigation.documentInstanceId
    });
  }

  currentRolePreloadFrame(
    roleId: string,
    generation: number
  ): ChromiumRoleOverlayFrameIdentity {
    validateGeneration(generation);
    const record = this.#recordsByRole.get(roleId);
    if (!record) {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_FOUND",
        "The role does not own a native Chromium surface."
      );
    }
    if (record.generation !== generation) {
      fail(
        "ELECTRON_ROLE_SURFACE_STALE_GENERATION",
        "The role-surface generation no longer owns the native surface."
      );
    }
    if (
      record.destroyed ||
      (record.state !== "opening" && record.state !== "active")
    ) {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_ACTIVE",
        "The native Chromium role preload is no longer live."
      );
    }
    const mainFrame = record.contents.mainFrame;
    if (
      !mainFrame ||
      mainFrame.frameToken.length === 0 ||
      mainFrame.frameToken.length > 128 ||
      mainFrame.frameToken !== mainFrame.frameToken.trim()
    ) {
      fail(
        "ELECTRON_ROLE_OVERLAY_FRAME_UNAVAILABLE",
        "The live Chromium role preload has no authoritative main frame."
      );
    }
    return Object.freeze({
      roleId: record.roleId,
      generation: record.generation,
      frame: mainFrame,
      frameToken: mainFrame.frameToken,
      documentInstanceId: record.navigation.documentInstanceId
    });
  }

  currentTrustedInputFrame(
    roleId: string,
    generation: number
  ): ChromiumRoleOverlayFrameIdentity {
    return this.currentOverlayFrame(roleId, generation);
  }

  sendTrustedInputControl(
    expected: ChromiumRoleOverlayFrameIdentity,
    control: ChromiumRoleTrustedInputControlEnvelope
  ): void {
    const current = this.currentTrustedInputFrame(
      expected.roleId,
      expected.generation
    );
    if (
      !sameOverlayFrame(current, expected) ||
      control.roleId !== expected.roleId ||
      control.generation !== expected.generation ||
      control.frameToken !== expected.frameToken
    ) {
      fail(
        "ELECTRON_ROLE_TRUSTED_INPUT_DOCUMENT_SUPERSEDED",
        "The trusted-input control no longer targets the exact live main frame."
      );
    }
    this.#recordsByRole.get(expected.roleId)!.contents.send(
      CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL,
      control
    );
  }

  subscribeTrustedInputLifecycle(
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ): () => void {
    return this.subscribeOverlayLifecycle(listener);
  }

  listOverlayFrames(): readonly ChromiumRoleOverlayFrameIdentity[] {
    const frames = [...this.#recordsByRole.values()]
      .filter((record) => record.state === "active" && !record.destroyed)
      .map((record) => this.currentOverlayFrame(record.roleId, record.generation))
      .sort((left, right) => left.roleId.localeCompare(right.roleId));
    return Object.freeze(frames);
  }

  subscribeOverlayLifecycle(
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ): () => void {
    this.#overlayLifecycleListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#overlayLifecycleListeners.delete(listener);
    };
  }

  subscribeNavigationLifecycle(
    listener: (event: ChromiumRoleNavigationLifecycleEvent) => boolean | void
  ): () => void {
    return this.#navigationLifecycle.subscribe(listener);
  }

  preflightControlledReload(
    roleId: string,
    generation: number
  ): ChromiumRoleControlledReloadPreparation {
    return this.#activeRecord(roleId, generation).navigation.preflight();
  }

  acquireControlledReloadFence(
    preparation: ChromiumRoleControlledReloadPreparation,
    operationId: string
  ): ChromiumRoleControlledReloadPreparation {
    const record = this.#activeRecord(preparation.roleId,
      preparation.surfaceGeneration);
    return record.navigation.acquire(preparation, operationId);
  }

  submitControlledReload(
    preparation: ChromiumRoleControlledReloadPreparation,
    operationId: string
  ): void {
    const record = this.#activeRecord(
      preparation.roleId,
      preparation.surfaceGeneration
    );
    record.navigation.submit(preparation, operationId);
  }

  releaseControlledReloadFence(
    roleId: string,
    generation: number,
    operationId: string,
    expectedDocumentInstanceId?: string
  ): boolean {
    const record = this.#recordsByRole.get(roleId);
    if (
      !record || record.generation !== generation || record.destroyed
    ) {
      return false;
    }
    return record.navigation.release(operationId, expectedDocumentInstanceId);
  }

  submitRoleFontsRefresh(
    expected: ChromiumRoleOverlayFrameIdentity,
    control: ChromiumRoleFontsRefreshControl
  ): Promise<ChromiumRoleFontsRefreshSubmissionReceipt> {
    let current: ChromiumRoleOverlayFrameIdentity;
    try {
      current = this.currentOverlayFrame(expected.roleId, expected.generation);
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      !sameOverlayFrame(current, expected) ||
      control.roleId !== expected.roleId ||
      control.generation !== expected.generation ||
      control.frameToken !== expected.frameToken ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
        .test(control.refreshId)
    ) {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_FONT_DOCUMENT_SUPERSEDED",
        "The browser-font refresh no longer targets the exact live main frame."
      ));
    }
    try {
      this.#recordsByRole.get(expected.roleId)!.contents.send(
        CHROMIUM_ROLE_FONTS_REFRESH_CHANNEL,
        control
      );
    } catch {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_FONT_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected browser-font refresh submission."
      ));
    }
    return Promise.resolve(Object.freeze({
      frameToken: expected.frameToken,
      generation: expected.generation,
      refreshId: control.refreshId,
      roleId: expected.roleId,
      status: "submitted" as const
    }));
  }

  executeOverlayRefresh(
    expected: ChromiumRoleOverlayFrameIdentity,
    refreshId: string
  ): Promise<ChromiumRoleOverlayRefreshSubmissionReceipt> {
    validateOverlayRefreshId(refreshId);
    let current: ChromiumRoleOverlayFrameIdentity;
    try {
      current = this.currentOverlayFrame(expected.roleId, expected.generation);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!sameOverlayFrame(current, expected)) {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED",
        "The Chromium overlay refresh no longer targets the live main frame."
      ));
    }
    const contents = this.#recordsByRole.get(expected.roleId)!.contents;
    let execution: Promise<unknown>;
    try {
      execution = contents.executeJavaScriptInIsolatedWorld(
        CHROMIUM_ROLE_OVERLAY_WORLD_ID,
        [{
          code: overlayRefreshSource(refreshId, expected.frameToken),
          url: "rion-studio://chromium-role-overlay-refresh.js"
        }],
        false
      );
    } catch {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected the isolated-world overlay refresh submission."
      ));
    }
    return Promise.resolve(execution).then((value) => {
      const live = this.currentOverlayFrame(expected.roleId, expected.generation);
      const record = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
      const exactKeys = record ? Object.keys(record).sort() : [];
      if (
        !sameOverlayFrame(live, expected) ||
        exactKeys.length !== 3 ||
        exactKeys[0] !== "frameToken" ||
        exactKeys[1] !== "refreshId" ||
        exactKeys[2] !== "status" ||
        record?.frameToken !== expected.frameToken ||
        record?.refreshId !== refreshId ||
        record?.status !== "submitted"
      ) {
        fail(
          "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
          "Chromium did not return the exact overlay refresh submission receipt."
        );
      }
      return Object.freeze({
        roleId: expected.roleId,
        generation: expected.generation,
        frameToken: expected.frameToken,
        refreshId,
        status: "submitted" as const,
        worldId: CHROMIUM_ROLE_OVERLAY_WORLD_ID
      });
    }, () => {
      throw surfaceError(
        "ELECTRON_ROLE_OVERLAY_REFRESH_SUBMISSION_FAILED",
        "Chromium rejected the isolated-world overlay refresh submission."
      );
    });
  }

  create(input: CreateChromiumRoleSurfaceInput): Promise<ChromiumRoleSurfaceHandle> {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_ROLE_SURFACE_REGISTRY_DRAINING",
        "The Chromium role-surface registry is draining and rejects new work."
      );
    }
    validateGeneration(input.generation);
    validateTabId(input.tabId);
    validateBounds(input.bounds);
    validateZoomFactor(input.zoomFactor);
    const url = canonicalChromiumRoleUrl(input.url);
    if (
      !Number.isSafeInteger(input.parent.id) ||
      input.parent.id < 1 ||
      input.parent.isDestroyed()
    ) {
      fail(
        "ELECTRON_ROLE_SURFACE_PARENT_INVALID",
        "A live Electron parent window is required for the role surface."
      );
    }
    if (this.#recordsByRole.has(input.roleId)) {
      fail(
        "ELECTRON_ROLE_SURFACE_OWNERSHIP_CONFLICT",
        "The role already owns a native Chromium surface."
      );
    }
    const parentOwner = this.#parentsById.get(input.parent.id);
    if (parentOwner && parentOwner.parent !== input.parent) {
      fail(
        "ELECTRON_ROLE_SURFACE_PARENT_CONFLICT",
        "The parent window ID is already bound to another native window."
      );
    }

    const webPreferences = buildRemoteContentWebPreferences({
      preloadPath: input.preloadPath,
      devTools: false
    });
    const sessionHandle = this.#sessions.ensure(input.roleId, input.rolePaths);
    let view: ChromiumRoleWebContentsViewPort;
    try {
      view = this.#views.create({
        webPreferences: { ...webPreferences, session: sessionHandle.session }
      });
    } catch {
      return this.#rejectAfterSessionRelease(
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_CREATE_FAILED",
          "Electron could not create the native Chromium role surface."
        )
      );
    }

    const contents = view.webContents;
    const viewOwner = this.#roleByView.get(view);
    const contentsOwner = this.#roleByWebContents.get(contents);
    if (viewOwner || contentsOwner) {
      return this.#rejectAfterSessionRelease(
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_NATIVE_ALIAS",
          "Electron returned one native role surface for distinct roles."
        )
      );
    }
    if (contents.session !== sessionHandle.session) {
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_SESSION_MISMATCH",
          "The native role surface is not bound to its Rust-owned Chromium session."
        )
      );
    }

    const record = this.#buildRecord(input, sessionHandle, view, contents);
    if (record.destroyed) {
      return this.#rejectAfterSessionRelease(
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_CREATE_FAILED",
          "Electron returned an already-destroyed Chromium role surface."
        )
      );
    }
    try {
      this.#installSecurityPolicy(record);
      this.#installNetworkFailureObservation(record);
      view.setBounds({ ...input.bounds });
      if (!sameBounds(view.getBounds(), input.bounds)) {
        fail(
          "ELECTRON_ROLE_SURFACE_BOUNDS_READBACK_FAILED",
          "The Chromium role surface did not retain its initial bounds."
        );
      }
      view.setVisible(input.visible);
      contents.setAudioMuted(input.audioMuted);
      if (contents.isAudioMuted() !== input.audioMuted) {
        fail(
          "ELECTRON_ROLE_SURFACE_AUDIO_READBACK_FAILED",
          "The Chromium role surface did not retain its initial audio state."
        );
      }
      contents.setZoomFactor(input.zoomFactor);
      if (contents.getZoomFactor() !== input.zoomFactor) {
        fail(
          "ELECTRON_ROLE_SURFACE_ZOOM_READBACK_FAILED",
          "The Chromium role surface did not retain its initial zoom factor."
        );
      }
    } catch {
      this.#removeAllListeners(record);
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_CREATE_FAILED",
          "Electron could not secure the native Chromium role surface."
        )
      );
    }
    if (input.parent.isDestroyed()) {
      this.#removeAllListeners(record);
      return this.#rejectAfterUnattachedViewDestroy(
        contents,
        sessionHandle,
        surfaceError(
          "ELECTRON_ROLE_SURFACE_PARENT_INVALID",
          "A live Electron parent window is required for the role surface."
        )
      );
    }

    this.#recordsByRole.set(input.roleId, record);
    this.#roleByView.set(view, input.roleId);
    this.#roleByWebContents.set(contents, input.roleId);
    this.#retainParent(input.parent);
    if (this.#nativeAttachments) {
      void this.#nativeAttachments.attach({
        roleId: record.roleId,
        generation: record.generation,
        parent: record.parent,
        isCancelled: () => record.state !== "opening" || record.destroyed ||
          record.parent.isDestroyed(),
        attach: () => {
          this.#attachTo(record, input.parent);
        },
        detach: () => this.#detach(record),
        view,
        attachTo: (physicalParent) => this.#attachTo(record, physicalParent)
      }).then(
        () => {
          try {
            this.#syncNativePresentation(record);
            this.#loadAttachedRecord(record, url);
          } catch {
            this.#failInitialAttachment(record);
          }
        },
        () => this.#failInitialAttachment(record)
      );
    } else {
      try {
        this.#attachTo(record, input.parent);
        this.#loadAttachedRecord(record, url);
      } catch {
        this.#failInitialAttachment(record);
      }
    }
    return record.creation.promise;
  }

  setBounds(roleId: string, generation: number, bounds: ChromiumRoleSurfaceBounds): void {
    validateBounds(bounds);
    const record = this.#activeRecord(roleId, generation);
    const view = record.view;
    view.setBounds({ ...bounds });
    if (!sameBounds(view.getBounds(), bounds)) {
      fail(
        "ELECTRON_ROLE_SURFACE_BOUNDS_READBACK_FAILED",
        "The Chromium role surface did not acknowledge its requested bounds."
      );
    }
    this.#syncNativePresentation(record);
  }

  readProjection(
    roleId: string,
    generation: number
  ): Readonly<{
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
    zoomFactor: number;
  }> {
    const record = this.#activeRecord(roleId, generation);
    const view = record.view;
    return Object.freeze({
      bounds: Object.freeze({ ...view.getBounds() }),
      visible: view.getVisible(),
      zoomFactor: record.contents.getZoomFactor()
    });
  }

  async reparentRole(
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): Promise<void> {
    const record = this.#activeRecord(roleId, generation);
    if (
      !Number.isSafeInteger(parent.id) ||
      parent.id < 1 ||
      parent.isDestroyed()
    ) {
      fail(
        "ELECTRON_ROLE_SURFACE_PARENT_INVALID",
        "A live Electron parent window is required for role-surface reparenting."
      );
    }
    if (record.parent === parent) return;
    const parentOwner = this.#parentsById.get(parent.id);
    if (parentOwner && parentOwner.parent !== parent) {
      fail(
        "ELECTRON_ROLE_SURFACE_PARENT_CONFLICT",
        "The reparent target ID is already bound to another native window."
      );
    }
    const previous = record.parent;
    await this.#popups?.retireOwnerPopupsForMove({
      ownerKind: "role",
      ownerId: record.roleId,
      nativeGeneration: record.generation
    });
    const currentTargetOwner = this.#parentsById.get(parent.id);
    if (
      this.#activeRecord(roleId, generation) !== record ||
      record.parent !== previous || parent.isDestroyed() ||
      (currentTargetOwner !== undefined && currentTargetOwner.parent !== parent)
    ) {
      fail(
        "ELECTRON_ROLE_SURFACE_REPARENT_FENCE_STALE",
        "The role surface or target host changed while its popups retired."
      );
    }
    if (this.#nativeAttachments) {
      await this.#nativeAttachments.reparent({
        roleId,
        generation,
        sourceParent: previous,
        targetParent: parent,
        isCancelled: () => record.state !== "active" || record.destroyed,
        detachSource: () => this.#detach(record),
        attachTarget: () => this.#attachTo(record, parent),
        detachTarget: () => this.#detach(record),
        restoreSource: () => this.#attachTo(record, previous),
        view: record.view,
        attachTargetTo: (physicalParent) =>
          this.#attachTo(record, physicalParent),
        restoreSourceTo: (physicalParent) =>
          this.#attachTo(record, physicalParent)
      });
    } else {
      try {
        this.#detach(record);
      } catch {
        fail(
          "ELECTRON_ROLE_SURFACE_REPARENT_DETACH_FAILED",
          "The role surface could not detach from its exact prior native parent."
        );
      }
      try {
        this.#attachTo(record, parent);
      } catch {
        try {
          this.#attachTo(record, previous);
        } catch {
          record.attached = false;
          fail(
            "ELECTRON_ROLE_SURFACE_REPARENT_ROLLBACK_FAILED",
            "The role surface could not attach to its target or restore its prior native parent."
          );
        }
        fail(
          "ELECTRON_ROLE_SURFACE_REPARENT_FAILED",
          "The role surface could not attach to its exact target native parent."
        );
      }
    }
    this.#retainParent(parent);
    this.#releaseParent(previous);
    record.parent = parent;
    this.#syncNativePresentation(record);
  }

  audioMuted(roleId: string, generation: number): boolean {
    return this.#activeRecord(roleId, generation).contents.isAudioMuted();
  }

  isCurrentlyAudible(roleId: string, generation: number): boolean {
    validateGeneration(generation);
    const record = this.#recordsByRole.get(roleId);
    if (!record) {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_FOUND",
        "The role does not own a native Chromium surface."
      );
    }
    if (record.generation !== generation) {
      fail(
        "ELECTRON_ROLE_SURFACE_STALE_GENERATION",
        "The role-surface generation no longer owns the native surface."
      );
    }
    if (record.state === "closing" || record.destroyed ||
      record.contents.isDestroyed()) {
      return false;
    }
    if (record.state !== "active") {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_ACTIVE",
        "The native Chromium role surface is not active."
      );
    }
    return record.contents.isCurrentlyAudible();
  }

  setAudioMuted(roleId: string, generation: number, muted: boolean): void {
    const contents = this.#activeRecord(roleId, generation).contents;
    contents.setAudioMuted(muted);
    if (contents.isAudioMuted() !== muted) {
      fail(
        "ELECTRON_ROLE_SURFACE_AUDIO_READBACK_FAILED",
        "The Chromium role surface did not acknowledge the requested audio state."
      );
    }
  }

  setVisible(roleId: string, generation: number, visible: boolean): void {
    const record = this.#activeRecord(roleId, generation);
    record.view.setVisible(visible);
    if (record.view.getVisible() !== visible) {
      fail(
        "ELECTRON_ROLE_SURFACE_VISIBILITY_READBACK_FAILED",
        "The Chromium role surface did not acknowledge its requested visibility."
      );
    }
    this.#syncNativePresentation(record);
  }

  setZoomFactor(roleId: string, generation: number, zoomFactor: number): void {
    validateZoomFactor(zoomFactor);
    const contents = this.#activeRecord(roleId, generation).contents;
    contents.setZoomFactor(zoomFactor);
    if (contents.getZoomFactor() !== zoomFactor) {
      fail(
        "ELECTRON_ROLE_SURFACE_ZOOM_READBACK_FAILED",
        "The Chromium role surface did not acknowledge its requested zoom factor."
      );
    }
  }

  closeRole(roleId: string, generation: number): Promise<boolean> {
    const record = this.#recordsByRole.get(roleId);
    if (!record) return Promise.resolve(false);
    if (record.generation !== generation) {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_SURFACE_STALE_GENERATION",
        "The role-surface generation no longer owns the native surface."
      ));
    }
    return this.#beginTerminalClose(record);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "draining";
    const closes = [...this.#recordsByRole.values()].map((record) =>
      this.closeRole(record.roleId, record.generation)
    );
    const operation = Promise.allSettled(closes)
      .then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (failure) throw failure.reason;
        return this.#sessions.dispose();
      })
      .then(() => {
        this.#state = "disposed";
      })
      .catch((error: unknown) => {
        this.#disposePromise = null;
        throw error;
      });
    this.#disposePromise = operation;
    return operation;
  }

  #buildRecord(
    input: CreateChromiumRoleSurfaceInput,
    sessionHandle: ChromiumRoleSessionHandle,
    view: ChromiumRoleWebContentsViewPort,
    contents: ChromiumRoleSurfaceWebContentsPort
  ): SurfaceRecord {
    const record: SurfaceRecord = {
      roleId: input.roleId,
      tabId: input.tabId,
      generation: input.generation,
      sessionHandle,
      parent: input.parent,
      physicalParent: null,
      view,
      contents,
      creation: deferred(),
      webContentsDestroyed: deferred(),
      destruction: deferred(),
      listeners: undefined as unknown as SurfaceListeners,
      state: "opening",
      attached: false,
      destroyed: contents.isDestroyed(),
      loadSettled: false,
      activeMainFrameFailureReported: false,
      closePromise: null,
      releasePromise: null,
      terminalObservation: null,
      terminalFailure: null,
      overlayRetired: false,
      nativeAttachmentRetired: false,
      nativeAttachmentRetirement: null,
      networkFailureSession: null,
      navigation: new ChromiumRoleNavigationLifecycleOwner({
        generation: input.generation,
        hub: this.#navigationLifecycle,
        reload: () => contents.reload(),
        roleId: input.roleId,
        tabId: input.tabId
      })
    };
    record.listeners = {
      beforeInputEvent: (event, inputEvent) => {
        interceptChromiumRoleQuickAccessShortcut({
          event,
          inputEvent,
          port: this.#quickAccess,
          tabId: record.tabId
        });
      },
      didStartNavigation: (details) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        if (
          record.state !== "active" || record.destroyed ||
          this.#recordsByRole.get(record.roleId) !== record
        ) return;
        record.activeMainFrameFailureReported = false;
        this.#emitOverlayLifecycle(record, "document-superseded");
        record.navigation.documentStarted();
      },
      didFinishLoad: () => {
        if (record.state === "opening") {
          this.#finishInitialLoad(record);
          return;
        }
        if (
          record.state !== "active" || record.destroyed ||
          this.#recordsByRole.get(record.roleId) !== record
        ) return;
        let validatedUrl: string;
        try {
          validatedUrl = canonicalChromiumRoleUrl(record.contents.getURL());
        } catch {
          return;
        }
        const documentInstanceId = record.contents.mainFrame?.frameToken;
        if (
          !documentInstanceId || documentInstanceId.length > 128 ||
          documentInstanceId !== documentInstanceId.trim()
        ) return;
        record.navigation.pageFinished(validatedUrl);
      },
      didFailLoad: (
        _event,
        errorCode,
        _errorDescription,
        validatedUrl,
        isMainFrame
      ) => {
        if (!isMainFrame) return;
        if (record.state === "opening") {
          if (errorCode === -3) return;
          this.#failInitialLoad(record);
          return;
        }
        if (
          record.state !== "active" || record.destroyed ||
          this.#recordsByRole.get(record.roleId) !== record ||
          !Number.isSafeInteger(errorCode) || errorCode === 0
        ) {
          return;
        }
        this.#reportActiveMainFrameFailure(record, errorCode, validatedUrl);
      },
      destroyed: () => this.#onDestroyed(record),
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: (event, destination) => {
        if (!isAllowedChromiumRoleNavigation(destination)) event.preventDefault();
      },
      willRedirect: (event, destination) => {
        if (!isAllowedChromiumRoleNavigation(destination)) event.preventDefault();
      }
    };
    return record;
  }

  #installSecurityPolicy(record: SurfaceRecord): void {
    const contents = record.contents;
    contents.setWindowOpenHandler((details) => {
      if (
        this.#popups && this.#state === "open" && record.state === "active" &&
        !record.destroyed && this.#recordsByRole.get(record.roleId) === record &&
        !record.navigation.popupAdmissionFenced
      ) {
        this.#popups.requestOpen(Object.freeze({
          ownerKind: "role",
          ownerId: record.roleId,
          nativeGeneration: record.generation,
          parent: record.parent,
          session: record.sessionHandle.session
        }), details);
      }
      return { action: "deny" };
    });
    contents.on("before-input-event", record.listeners.beforeInputEvent);
    contents.on("did-start-navigation", record.listeners.didStartNavigation);
    contents.on("will-attach-webview", record.listeners.willAttachWebview);
    contents.on("will-navigate", record.listeners.willNavigate);
    contents.on("will-redirect", record.listeners.willRedirect);
    contents.on("did-finish-load", record.listeners.didFinishLoad);
    contents.on("did-fail-load", record.listeners.didFailLoad);
    contents.on("destroyed", record.listeners.destroyed);
  }

  #installNetworkFailureObservation(record: SurfaceRecord): void {
    const candidate = record.sessionHandle.session as unknown as Partial<
      ChromiumRoleNetworkFailureSessionPort
    >;
    if (
      !candidate.webRequest ||
      typeof candidate.webRequest.onErrorOccurred !== "function"
    ) {
      fail(
        "ELECTRON_ROLE_NETWORK_OBSERVER_UNAVAILABLE",
        "The Chromium Role Session cannot publish authoritative request failures."
      );
    }
    candidate.webRequest.onErrorOccurred((details) => {
      if (details.resourceType !== "mainFrame") return;
      const exactWebContents = details.webContents !== undefined
        ? details.webContents === record.contents
        : Number.isSafeInteger(details.webContentsId) &&
          Number.isSafeInteger(record.contents.id) &&
          details.webContentsId === record.contents.id;
      if (!exactWebContents) return;
      this.#reportActiveMainFrameFailure(record, 0, details.url);
    });
    record.networkFailureSession = candidate as ChromiumRoleNetworkFailureSessionPort;
  }

  #removeNetworkFailureObservation(record: SurfaceRecord): void {
    if (!record.networkFailureSession) return;
    record.networkFailureSession.webRequest.onErrorOccurred(null);
    record.networkFailureSession = null;
  }

  #reportActiveMainFrameFailure(
    record: SurfaceRecord,
    errorCode: number,
    validatedUrl: string
  ): void {
    if (
      record.state !== "active" || record.destroyed ||
      this.#recordsByRole.get(record.roleId) !== record ||
      !Number.isSafeInteger(errorCode) || errorCode === -3 ||
      record.activeMainFrameFailureReported
    ) {
      return;
    }
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalChromiumRoleUrl(validatedUrl);
    } catch {
      return;
    }
    record.activeMainFrameFailureReported = true;
    const claimed = record.navigation.pageFailed(errorCode, canonicalUrl);
    if (claimed) return;
    this.#navigationFailures?.report(Object.freeze({
      errorCode,
      roleId: record.roleId,
      surfaceGeneration: record.generation,
      tabId: record.tabId,
      validatedUrl: canonicalUrl
    }));
  }

  #finishInitialLoad(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    let loadedUrl: string;
    try {
      loadedUrl = canonicalChromiumRoleUrl(record.contents.getURL());
    } catch {
      return;
    }
    const documentInstanceId = record.contents.mainFrame?.frameToken;
    if (
      !documentInstanceId || documentInstanceId.length > 128 ||
      documentInstanceId !== documentInstanceId.trim()
    ) {
      this.#failInitialLoad(record);
      return;
    }
    try {
      // EventBound: did-finish-load is the first exact terminal event after
      // Chromium has completed the native child-view attachment that can
      // asynchronously hand key ownership back to the launcher.
      this.#nativeAttachments?.initialLoadCommitted?.(
        record.roleId,
        record.generation,
        record.parent
      );
    } catch {
      this.#failInitialLoad(record);
      return;
    }
    record.state = "active";
    record.loadSettled = true;
    record.creation.resolve(Object.freeze({
      roleId: record.roleId,
      generation: record.generation,
      parentId: record.parent.id,
      url: loadedUrl
    }));
  }

  #loadAttachedRecord(record: SurfaceRecord, url: string): void {
    if (record.state !== "opening" || record.destroyed || !record.attached) {
      this.#failInitialAttachment(record);
      return;
    }
    try {
      const load = record.contents.loadURL(url);
      // EventBound: did-finish-load/did-fail-load, never this Promise, settles load.
      void load.catch(() => undefined);
    } catch {
      this.#failInitialLoad(record);
    }
  }

  #failInitialAttachment(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    record.state = "load-failed";
    record.loadSettled = true;
    this.#removeLoadListeners(record);
    record.creation.reject(surfaceError(
      "ELECTRON_ROLE_SURFACE_NATIVE_ATTACH_FAILED",
      "The Chromium role surface did not establish exact native ownership."
    ));
    this.#observeTerminalClose(record);
  }

  #failInitialLoad(record: SurfaceRecord): void {
    if (record.state !== "opening" || record.loadSettled) return;
    record.state = "load-failed";
    record.loadSettled = true;
    this.#removeLoadListeners(record);
    record.creation.reject(surfaceError(
      "ELECTRON_ROLE_SURFACE_LOAD_FAILED",
      "The Chromium role surface did not finish its main-frame load."
    ));
  }

  #beginTerminalClose(record: SurfaceRecord): Promise<boolean> {
    if (record.closePromise) return record.closePromise;
    record.state = "closing";
    this.#retiredOverlayWebContents.add(record.contents);
    record.terminalFailure = null;
    this.#retireOverlay(record);
    const completion = deferred<boolean>();
    record.closePromise = completion.promise;
    const continueAfterNativeRetirement = (): Promise<boolean> => {
      record.nativeAttachmentRetired = true;
      this.#detach(record);
      if (!record.destroyed) {
        record.view.setVisible(false);
        record.contents.close({ waitForBeforeUnload: false });
      }
      // EventBound: Chromium's exact destroyed event is necessary but not
      // sufficient. AppKit retirement and physical detach above must also be
      // acknowledged before storage ownership can be released.
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
          ownerKind: "role",
          ownerId: record.roleId,
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
    this.#retireOverlay(record);
    if (!record.loadSettled) {
      record.loadSettled = true;
      this.#removeLoadListeners(record);
      record.creation.reject(surfaceError(
        "ELECTRON_ROLE_SURFACE_DESTROYED",
        "The native Chromium role surface was destroyed before load completion."
      ));
    }
    record.webContentsDestroyed.resolve();
    this.#observeTerminalClose(record);
  }

  #retireNativeAttachment(record: SurfaceRecord): Promise<void> {
    if (!this.#nativeAttachments) return Promise.resolve();
    if (record.nativeAttachmentRetirement) {
      return record.nativeAttachmentRetirement;
    }
    let requestedRetirement: Promise<void>;
    try {
      const physical = record.physicalParent &&
        record.physicalParent !== record.parent ? {
          roleId: record.roleId,
          generation: record.generation,
          parent: record.parent,
          physicalParent: record.physicalParent,
          view: record.view,
          detach: () => this.#detach(record)
        } : undefined;
      requestedRetirement = physical
        ? this.#nativeAttachments.retire(
          record.roleId,
          record.generation,
          record.parent,
          physical
        )
        : this.#nativeAttachments.retire(
          record.roleId,
          record.generation,
          record.parent
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const retirement = Promise.resolve(requestedRetirement).catch(
      (error: unknown) => {
        if (record.nativeAttachmentRetirement === retirement) {
          record.nativeAttachmentRetirement = null;
        }
        throw error;
      }
    );
    record.nativeAttachmentRetirement = retirement;
    return retirement;
  }

  #activeRecord(roleId: string, generation: number): SurfaceRecord {
    validateGeneration(generation);
    const record = this.#recordsByRole.get(roleId);
    if (!record) {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_FOUND",
        "The role does not own a native Chromium surface."
      );
    }
    if (record.generation !== generation) {
      fail(
        "ELECTRON_ROLE_SURFACE_STALE_GENERATION",
        "The role-surface generation no longer owns the native surface."
      );
    }
    if (record.state !== "active") {
      fail(
        "ELECTRON_ROLE_SURFACE_NOT_ACTIVE",
        "The native Chromium role surface is not active."
      );
    }
    return record;
  }

  #detach(record: SurfaceRecord): void {
    if (!record.attached) return;
    const physicalParent = record.physicalParent;
    if (!physicalParent) {
      fail(
        "ELECTRON_ROLE_SURFACE_NATIVE_DETACH_FAILED",
        "The role surface lost its exact physical parent identity."
      );
    }
    try {
      physicalParent.contentView.removeChildView(record.view);
    } catch {
      fail(
        "ELECTRON_ROLE_SURFACE_NATIVE_DETACH_FAILED",
        "The role surface could not detach from its exact native parent."
      );
    }
    record.attached = false;
    record.physicalParent = null;
  }

  #attachTo(record: SurfaceRecord, physicalParent: ChromiumRoleSurfaceParentPort): void {
    if (record.attached || record.physicalParent) {
      fail(
        "ELECTRON_ROLE_SURFACE_NATIVE_ATTACH_CONFLICT",
        "The role surface remained attached while physical ownership changed."
      );
    }
    if (physicalParent.isDestroyed()) {
      fail(
        "ELECTRON_ROLE_SURFACE_PARENT_INVALID",
        "A live physical Electron parent is required for the role surface."
      );
    }
    physicalParent.contentView.addChildView(record.view);
    record.physicalParent = physicalParent;
    record.attached = true;
  }

  #syncNativePresentation(record: SurfaceRecord): void {
    if (!this.#nativeAttachments?.syncPresentation || !record.physicalParent) return;
    this.#nativeAttachments.syncPresentation({
      roleId: record.roleId,
      generation: record.generation,
      parent: record.parent,
      physicalParent: record.physicalParent,
      view: record.view
    });
  }

  #emitOverlayLifecycle(
    record: SurfaceRecord,
    reason: ChromiumRoleOverlayLifecycleReason
  ): void {
    const event = Object.freeze({
      roleId: record.roleId,
      generation: record.generation,
      reason
    });
    for (const listener of this.#overlayLifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Native lifecycle cannot be blocked by an observer failure.
      }
    }
  }

  #retireOverlay(record: SurfaceRecord): void {
    if (record.overlayRetired) return;
    record.overlayRetired = true;
    this.#emitOverlayLifecycle(record, "surface-retired");
    record.navigation.retire();
  }

  #retainParent(parent: ChromiumRoleSurfaceParentPort): void {
    const owner = this.#parentsById.get(parent.id);
    if (owner) {
      owner.count += 1;
      return;
    }
    this.#parentsById.set(parent.id, { parent, count: 1 });
  }

  #releaseParent(parent: ChromiumRoleSurfaceParentPort): void {
    const owner = this.#parentsById.get(parent.id);
    if (!owner || owner.parent !== parent) return;
    owner.count -= 1;
    if (owner.count === 0) this.#parentsById.delete(parent.id);
  }

  #releaseDestroyedRecord(record: SurfaceRecord): Promise<boolean> {
    if (
      !record.destroyed ||
      !record.nativeAttachmentRetired ||
      record.attached
    ) {
      return Promise.reject(surfaceError(
        "ELECTRON_ROLE_SURFACE_RELEASE_BEFORE_NATIVE_RETIREMENT",
        "The Chromium role surface must be destroyed and exactly detached before session release."
      ));
    }
    if (record.releasePromise) return record.releasePromise;
    const operation = this.#sessions.releaseRole(
      record.roleId,
      record.sessionHandle.chromiumUserDataDir
    ).then(() => {
      if (this.#recordsByRole.get(record.roleId) === record) {
        this.#removeAllListeners(record);
        this.#recordsByRole.delete(record.roleId);
        this.#roleByView.delete(record.view);
        this.#roleByWebContents.delete(record.contents);
        this.#releaseParent(record.parent);
      }
      return true;
    }).catch((error: unknown) => {
      record.releasePromise = null;
      throw error;
    });
    record.releasePromise = operation;
    return operation;
  }

  #rejectAfterSessionRelease(
    sessionHandle: ChromiumRoleSessionHandle,
    error: RionBridgeError
  ): Promise<never> {
    return this.#sessions.releaseRole(
      sessionHandle.roleId,
      sessionHandle.chromiumUserDataDir
    ).then(
      () => Promise.reject(error),
      () => Promise.reject(error)
    );
  }

  #rejectAfterUnattachedViewDestroy(
    contents: ChromiumRoleSurfaceWebContentsPort,
    sessionHandle: ChromiumRoleSessionHandle,
    error: RionBridgeError
  ): Promise<never> {
    if (contents.isDestroyed()) {
      return this.#rejectAfterSessionRelease(sessionHandle, error);
    }
    const destruction = deferred<void>();
    const onDestroyed = (): void => {
      contents.removeListener("destroyed", onDestroyed);
      destruction.resolve();
    };
    contents.on("destroyed", onDestroyed);
    try {
      contents.close({ waitForBeforeUnload: false });
    } catch {
      contents.removeListener("destroyed", onDestroyed);
      return Promise.reject(error);
    }
    return destruction.promise.then(() =>
      this.#rejectAfterSessionRelease(sessionHandle, error)
    );
  }

  #removeLoadListeners(record: SurfaceRecord): void {
    const contents = record.contents;
    contents.removeListener("did-finish-load", record.listeners.didFinishLoad);
    contents.removeListener("did-fail-load", record.listeners.didFailLoad);
  }

  #removeAllListeners(record: SurfaceRecord): void {
    this.#removeNetworkFailureObservation(record);
    this.#removeLoadListeners(record);
    const contents = record.contents;
    contents.removeListener("before-input-event", record.listeners.beforeInputEvent);
    contents.removeListener("did-start-navigation", record.listeners.didStartNavigation);
    contents.removeListener("will-attach-webview", record.listeners.willAttachWebview);
    contents.removeListener("will-navigate", record.listeners.willNavigate);
    contents.removeListener("will-redirect", record.listeners.willRedirect);
    contents.removeListener("destroyed", record.listeners.destroyed);
  }
}
