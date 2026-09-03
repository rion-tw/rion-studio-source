import { pathToFileURL } from "node:url";

import {
  WORKSPACE_WEB_CHROME_ACTION_CHANNEL,
  WORKSPACE_WEB_CHROME_SHELL_SESSION,
  WORKSPACE_WEB_CHROME_STATE_CHANNEL,
  canonicalWorkspaceWebUrl,
  parseWorkspaceWebChromeAction,
  type WorkspaceWebChromeAction
} from "../../shared/workspaceWebChrome";
import { RionBridgeError, normalizeRionBridgeError } from "../ipc/errors";
import type {
  ChromiumRoleSessionPort
} from "./chromiumRoleSessionRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "./chromiumRoleSurfacePorts";
import {
  ChromiumGlobalWebSurfaceRegistry,
  type ChromiumGlobalWebNativeAttachmentPort,
  type ChromiumGlobalWebSurfaceHandle,
  type ChromiumGlobalWebSurfaceRuntimeEvidence,
  type CreateChromiumGlobalWebSurfaceInput
} from "./chromiumGlobalWebSurfaceRegistry";
import { buildRemoteContentWebPreferences } from "./security";

export const CHROMIUM_WORKSPACE_WEB_CHROME_HEIGHT = 34;

type PresentationState = "open" | "draining" | "disposed";
type ChromeState = "opening" | "active" | "closing" | "quarantined";

export interface ChromiumWorkspaceWebChromeIpcEvent {
  readonly sender: object;
}

export interface ChromiumWorkspaceWebChromeIpcMainPort {
  on: (
    channel: string,
    listener: (event: ChromiumWorkspaceWebChromeIpcEvent, payload: unknown) => void
  ) => unknown;
  removeListener: (
    channel: string,
    listener: (event: ChromiumWorkspaceWebChromeIpcEvent, payload: unknown) => void
  ) => unknown;
}

export interface ChromiumWorkspaceWebChromeShellInput {
  readonly documentPath: string;
  readonly ipcMain: ChromiumWorkspaceWebChromeIpcMainPort;
  readonly preloadPath: string;
  readonly session: ChromiumRoleSessionPort;
  readonly sessionIdentity: typeof WORKSPACE_WEB_CHROME_SHELL_SESSION;
}

export interface ChromiumWorkspaceWebPresentationEvidence {
  readonly surfaceId: string;
  readonly generation: number;
  readonly contentProfilePath: string;
  readonly contentSession: "global-web-persistent";
  readonly contentSessionStoragePath: string;
  readonly contentUrl: string;
  readonly chromeShellSession: typeof WORKSPACE_WEB_CHROME_SHELL_SESSION;
  readonly chromeShellStoragePath: null;
  readonly chromeShellUrl: string;
  readonly chromeBounds: ChromiumRoleSurfaceBounds;
  readonly chromeVisible: boolean;
  readonly contentBounds: ChromiumRoleSurfaceBounds;
  readonly contentVisible: boolean;
  readonly slotBounds: ChromiumRoleSurfaceBounds;
  readonly visible: boolean;
  readonly containedFullscreen: boolean;
  readonly containedFullscreenRevision: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isolatedSessions: true;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

interface ChromeListeners {
  readonly destroyed: () => void;
  readonly didFinishLoad: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: (
    event: ChromiumRoleSurfaceEvent,
    url: string
  ) => void;
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface ChromeRecord {
  readonly surfaceId: string;
  readonly chromeSurfaceId: string;
  readonly slotId: string;
  readonly generation: number;
  readonly homeUrl: string;
  readonly view: ChromiumRoleWebContentsViewPort;
  readonly contents: ChromiumRoleSurfaceWebContentsPort;
  readonly destroyed: Deferred<void>;
  readonly loaded: Deferred<void>;
  readonly listeners: ChromeListeners;
  parent: ChromiumRoleSurfaceParentPort;
  slotBounds: ChromiumRoleSurfaceBounds;
  visible: boolean;
  containedFullscreen: boolean;
  containedFullscreenRevision: number;
  attached: boolean;
  loadSettled: boolean;
  destroyedObserved: boolean;
  state: ChromeState;
  actionLane: Promise<void>;
  closePromise: Promise<boolean> | null;
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

function presentationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw presentationError(code, message);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function canonicalWebUrl(value: unknown): string {
  const canonical = canonicalWorkspaceWebUrl(value);
  if (!canonical) {
    fail(
      "ELECTRON_WORKSPACE_WEB_CHROME_URL_INVALID",
      "Workspace Web navigation requires a canonical HTTP(S) URL."
    );
  }
  return canonical;
}

function validateBounds(bounds: ChromiumRoleSurfaceBounds): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < 1 || bounds.height < 2
  ) {
    fail(
      "ELECTRON_WORKSPACE_WEB_PRESENTATION_BOUNDS_INVALID",
      "The paired Workspace Web presentation requires finite positive slot bounds."
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

function splitBounds(slot: ChromiumRoleSurfaceBounds): Readonly<{
  chrome: ChromiumRoleSurfaceBounds;
  content: ChromiumRoleSurfaceBounds;
}> {
  validateBounds(slot);
  const chromeHeight = Math.min(
    CHROMIUM_WORKSPACE_WEB_CHROME_HEIGHT,
    slot.height - 1
  );
  return Object.freeze({
    chrome: Object.freeze({
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: chromeHeight
    }),
    content: Object.freeze({
      x: slot.x,
      y: slot.y + chromeHeight,
      width: slot.width,
      height: slot.height - chromeHeight
    })
  });
}

function parseAction(payload: unknown): WorkspaceWebChromeAction {
  const value = parseWorkspaceWebChromeAction(payload);
  if (!value) {
    fail(
      "ELECTRON_WORKSPACE_WEB_CHROME_ACTION_INVALID",
      "The local Workspace Web chrome sent a malformed action."
    );
  }
  return value;
}

/**
 * Presents every remote global-Web surface with a paired, Rion-owned local
 * chrome shell. The remote page keeps the persistent global-Web profile while
 * the chrome shell uses a distinct in-memory Session and exact-sender IPC.
 * On macOS both views attach through the retained AppKit host FIFO.
 */
export class ChromiumGlobalWebPresentationRegistry {
  readonly #content: ChromiumGlobalWebSurfaceRegistry;
  readonly #views: ChromiumWebContentsViewFactoryPort;
  readonly #nativeAttachments: ChromiumGlobalWebNativeAttachmentPort | null;
  readonly #shell: ChromiumWorkspaceWebChromeShellInput;
  readonly #documentUrl: string;
  readonly #records = new Map<string, ChromeRecord>();
  readonly #recordByContents = new WeakMap<object, ChromeRecord>();
  readonly #onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly #ipcListener: (
    event: ChromiumWorkspaceWebChromeIpcEvent,
    payload: unknown
  ) => void;
  #state: PresentationState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(input: Readonly<{
    content: ChromiumGlobalWebSurfaceRegistry;
    views: ChromiumWebContentsViewFactoryPort;
    nativeAttachments?: ChromiumGlobalWebNativeAttachmentPort | null;
    shell: ChromiumWorkspaceWebChromeShellInput;
    onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  }>) {
    this.#content = input.content;
    this.#views = input.views;
    this.#nativeAttachments = input.nativeAttachments ?? null;
    this.#shell = input.shell;
    this.#onError = input.onError;
    if (
      input.shell.sessionIdentity !== WORKSPACE_WEB_CHROME_SHELL_SESSION ||
      input.shell.session.storagePath !== null ||
      input.shell.preloadPath.trim().length === 0 ||
      input.shell.documentPath.trim().length === 0
    ) {
      fail(
        "ELECTRON_WORKSPACE_WEB_CHROME_SHELL_INVALID",
        "The Workspace Web chrome requires its dedicated local shell identity, preload, and document."
      );
    }
    this.#documentUrl = pathToFileURL(input.shell.documentPath).href;
    this.#ipcListener = (event, payload) => this.#receiveAction(event, payload);
    this.#shell.ipcMain.on(
      WORKSPACE_WEB_CHROME_ACTION_CHANNEL,
      this.#ipcListener
    );
  }

  get activeCount(): number {
    return this.#records.size;
  }

  async create(
    input: CreateChromiumGlobalWebSurfaceInput
  ): Promise<ChromiumGlobalWebSurfaceHandle> {
    this.#requireOpen();
    if (!validIdentifier(input.surfaceId) || !validIdentifier(input.slotId)) {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_ID_INVALID",
        "The paired Workspace Web presentation requires exact surface and slot identities."
      );
    }
    validateBounds(input.bounds);
    if (this.#records.has(input.surfaceId)) {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_CONFLICT",
        "The Workspace Web surface already owns paired Rion chrome."
      );
    }
    const view = this.#views.create({
      webPreferences: {
        ...buildRemoteContentWebPreferences({
          preloadPath: this.#shell.preloadPath
        }),
        session: this.#shell.session
      }
    });
    const contents = view.webContents;
    if (contents.session !== this.#shell.session || contents.isDestroyed()) {
      fail(
        "ELECTRON_WORKSPACE_WEB_CHROME_SESSION_MISMATCH",
        "The local Workspace Web chrome did not retain its dedicated Session."
      );
    }
    const record = this.#buildRecord(input, view, contents);
    this.#records.set(record.surfaceId, record);
    this.#recordByContents.set(contents, record);
    try {
      this.#secureChrome(record);
      this.#applyBounds(record, input.bounds);
      view.setVisible(input.visible);
      await this.#attach(record);
      void contents.loadURL(this.#documentUrl).catch(() => {
        // EventBound: did-fail-load is the authoritative shell-load terminal.
      });
      const bounds = splitBounds(input.bounds);
      const [contentHandle] = await Promise.all([
        this.#content.create({
          ...input,
          bounds: bounds.content,
          onContainedFullscreenChange: (fullscreen) => {
            try {
              this.#applyContainedFullscreen(record, fullscreen);
            } catch (error) {
              this.#onError(normalizeRionBridgeError(
                error,
                "ELECTRON_WORKSPACE_WEB_CONTAINED_FULLSCREEN_FAILED"
              ));
            }
          }
        }),
        record.loaded.promise
      ]);
      const contentEvidence = this.#content.runtimeEvidence(
        input.surfaceId,
        input.generation
      );
      if (contentEvidence.contentSession === this.#shell.session) {
        throw presentationError(
          "ELECTRON_WORKSPACE_WEB_SESSION_ALIAS",
          "Remote content and Rion-owned chrome unexpectedly share one Chromium Session."
        );
      }
      this.#readPairedProjection(
        record,
        input.bounds,
        input.visible,
        record.containedFullscreen
      );
      record.state = "active";
      this.#publishState(record, contentEvidence);
      return contentHandle;
    } catch (error) {
      await this.#closeFailedCreate(record);
      throw error;
    }
  }

  readProjection(
    surfaceId: string,
    generation: number
  ): Readonly<{
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
    zoomFactor?: number;
  }> {
    const record = this.#activeRecord(surfaceId, generation);
    const projection = this.#readPairedProjection(record);
    return Object.freeze({
      bounds: projection.bounds,
      visible: projection.visible,
      ...(projection.zoomFactor === undefined
        ? {}
        : { zoomFactor: projection.zoomFactor })
    });
  }

  runtimeEvidence(
    surfaceId: string,
    generation: number
  ): ChromiumWorkspaceWebPresentationEvidence {
    const record = this.#activeRecord(surfaceId, generation);
    const content = this.#content.runtimeEvidence(surfaceId, generation);
    if (content.contentSession === this.#shell.session) {
      fail(
        "ELECTRON_WORKSPACE_WEB_SESSION_ALIAS",
        "Remote content and Rion-owned chrome share one Chromium Session."
      );
    }
    const contentSessionStoragePath = content.contentSession.storagePath;
    const chromeShellStoragePath = this.#shell.session.storagePath;
    if (
      typeof contentSessionStoragePath !== "string" ||
      contentSessionStoragePath !== content.contentProfilePath ||
      chromeShellStoragePath !== null
    ) {
      fail(
        "ELECTRON_WORKSPACE_WEB_SESSION_READBACK_MISMATCH",
        "The paired Workspace Web sessions lost their exact persistent-content and in-memory-shell paths."
      );
    }
    const projection = this.#readPairedProjection(record);
    return Object.freeze({
      surfaceId,
      generation,
      contentProfilePath: content.contentProfilePath,
      contentSession: "global-web-persistent",
      contentSessionStoragePath,
      contentUrl: content.currentUrl,
      chromeShellSession: WORKSPACE_WEB_CHROME_SHELL_SESSION,
      chromeShellStoragePath,
      chromeShellUrl: record.contents.getURL(),
      chromeBounds: projection.chromeBounds,
      chromeVisible: projection.chromeVisible,
      contentBounds: projection.contentBounds,
      contentVisible: projection.contentVisible,
      slotBounds: projection.bounds,
      visible: projection.visible,
      containedFullscreen: record.containedFullscreen,
      containedFullscreenRevision: record.containedFullscreenRevision,
      canGoBack: content.canGoBack,
      canGoForward: content.canGoForward,
      isolatedSessions: true
    });
  }

  setBounds(
    surfaceId: string,
    generation: number,
    bounds: ChromiumRoleSurfaceBounds
  ): void {
    const record = this.#activeRecord(surfaceId, generation);
    validateBounds(bounds);
    const previous = record.slotBounds;
    try {
      this.#applyBounds(record, bounds);
      this.#content.setBounds(
        surfaceId,
        generation,
        record.containedFullscreen ? bounds : splitBounds(bounds).content
      );
      this.#readPairedProjection(
        record,
        bounds,
        record.visible,
        record.containedFullscreen
      );
      record.slotBounds = Object.freeze({ ...bounds });
    } catch (error) {
      try {
        this.#applyBounds(record, previous);
        this.#content.setBounds(
          surfaceId,
          generation,
          record.containedFullscreen ? previous : splitBounds(previous).content
        );
        this.#readPairedProjection(
          record,
          previous,
          record.visible,
          record.containedFullscreen
        );
      } catch {
        record.state = "quarantined";
        fail(
          "ELECTRON_WORKSPACE_WEB_PRESENTATION_COMPENSATION_FAILED",
          "The paired Workspace Web bounds could not be compensated exactly."
        );
      }
      throw error;
    }
  }

  setVisible(surfaceId: string, generation: number, visible: boolean): void {
    const record = this.#activeRecord(surfaceId, generation);
    const previous = record.visible;
    try {
      record.view.setVisible(record.containedFullscreen ? false : visible);
      this.#content.setVisible(surfaceId, generation, visible);
      this.#readPairedProjection(
        record,
        record.slotBounds,
        visible,
        record.containedFullscreen
      );
      record.visible = visible;
    } catch (error) {
      try {
        record.view.setVisible(record.containedFullscreen ? false : previous);
        this.#content.setVisible(surfaceId, generation, previous);
        this.#readPairedProjection(
          record,
          record.slotBounds,
          previous,
          record.containedFullscreen
        );
      } catch {
        record.state = "quarantined";
        fail(
          "ELECTRON_WORKSPACE_WEB_PRESENTATION_COMPENSATION_FAILED",
          "The paired Workspace Web visibility could not be compensated exactly."
        );
      }
      throw error;
    }
  }

  setZoomFactor(surfaceId: string, generation: number, zoomFactor: number): void {
    this.#content.setZoomFactor(surfaceId, generation, zoomFactor);
  }

  audioMuted(surfaceId: string, generation: number): boolean {
    return this.#content.audioMuted(surfaceId, generation);
  }

  isCurrentlyAudible(surfaceId: string, generation: number): boolean {
    return this.#content.isCurrentlyAudible(surfaceId, generation);
  }

  setAudioMuted(surfaceId: string, generation: number, muted: boolean): void {
    this.#content.setAudioMuted(surfaceId, generation, muted);
  }

  async reparentSurface(
    surfaceId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): Promise<void> {
    const record = this.#activeRecord(surfaceId, generation);
    if (record.parent === parent) return;
    const previous = record.parent;
    await this.#detach(record);
    record.parent = parent;
    try {
      await this.#attach(record);
      await this.#content.reparentSurface(surfaceId, generation, parent);
    } catch (error) {
      try {
        if (record.attached) await this.#detach(record);
        record.parent = previous;
        await this.#attach(record);
      } catch {
        record.state = "quarantined";
        fail(
          "ELECTRON_WORKSPACE_WEB_REPARENT_COMPENSATION_FAILED",
          "The Rion-owned Web chrome could not restore its retained native host."
        );
      }
      throw error;
    }
  }

  closeSurface(surfaceId: string, generation: number): Promise<boolean> {
    const record = this.#records.get(surfaceId);
    if (!record) return this.#content.closeSurface(surfaceId, generation);
    if (record.generation !== generation) {
      return Promise.reject(presentationError(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_GENERATION_STALE",
        "The paired Workspace Web generation is stale."
      ));
    }
    if (record.closePromise) return record.closePromise;
    record.state = "closing";
    record.closePromise = (async () => {
      await this.#detach(record);
      if (!record.destroyedObserved) {
        record.contents.close({ waitForBeforeUnload: false });
        await record.destroyed.promise;
      }
      await this.#content.closeSurface(surfaceId, generation);
      this.#removeListeners(record);
      this.#records.delete(surfaceId);
      return true;
    })().catch((error: unknown) => {
      record.closePromise = null;
      record.state = "quarantined";
      throw error;
    });
    return record.closePromise;
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
      await this.#content.dispose();
      this.#shell.ipcMain.removeListener(
        WORKSPACE_WEB_CHROME_ACTION_CHANNEL,
        this.#ipcListener
      );
      this.#state = "disposed";
    }).catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  #buildRecord(
    input: CreateChromiumGlobalWebSurfaceInput,
    view: ChromiumRoleWebContentsViewPort,
    contents: ChromiumRoleSurfaceWebContentsPort
  ): ChromeRecord {
    const destroyed = deferred<void>();
    const loaded = deferred<void>();
    const record = {
      surfaceId: input.surfaceId,
      chromeSurfaceId: `${input.surfaceId}:rion-web-chrome`,
      slotId: input.slotId,
      generation: input.generation,
      homeUrl: canonicalWebUrl(input.url),
      view,
      contents,
      destroyed,
      loaded,
      listeners: undefined as unknown as ChromeListeners,
      parent: input.parent,
      slotBounds: Object.freeze({ ...input.bounds }),
      visible: input.visible,
      containedFullscreen: false,
      containedFullscreenRevision: 0,
      attached: false,
      loadSettled: false,
      destroyedObserved: false,
      state: "opening" as ChromeState,
      actionLane: Promise.resolve(),
      closePromise: null
    };
    record.listeners = {
      destroyed: () => {
        record.destroyedObserved = true;
        if (!record.loadSettled) {
          record.loadSettled = true;
          record.loaded.reject(presentationError(
            "ELECTRON_WORKSPACE_WEB_CHROME_DESTROYED",
            "The Rion-owned Web chrome closed before its local document loaded."
          ));
        }
        record.destroyed.resolve();
      },
      didFinishLoad: () => {
        if (record.loadSettled || record.contents.getURL() !== this.#documentUrl) return;
        record.loadSettled = true;
        record.loaded.resolve();
      },
      didFailLoad: (_event, _code, _description, _url, isMainFrame) => {
        if (!isMainFrame || record.loadSettled) return;
        record.loadSettled = true;
        record.loaded.reject(presentationError(
          "ELECTRON_WORKSPACE_WEB_CHROME_LOAD_FAILED",
          "The Rion-owned local Web chrome document did not load."
        ));
      },
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: (event, destination) => {
        if (destination !== this.#documentUrl) event.preventDefault();
      },
      willRedirect: (event, destination) => {
        if (destination !== this.#documentUrl) event.preventDefault();
      }
    };
    return record;
  }

  #secureChrome(record: ChromeRecord): void {
    record.contents.setWindowOpenHandler(() => ({ action: "deny" }));
    record.contents.on("destroyed", record.listeners.destroyed);
    record.contents.on("did-finish-load", record.listeners.didFinishLoad);
    record.contents.on("did-fail-load", record.listeners.didFailLoad);
    record.contents.on("will-attach-webview", record.listeners.willAttachWebview);
    record.contents.on("will-navigate", record.listeners.willNavigate);
    record.contents.on("will-redirect", record.listeners.willRedirect);
  }

  #applyBounds(record: ChromeRecord, slot: ChromiumRoleSurfaceBounds): void {
    const bounds = splitBounds(slot).chrome;
    record.view.setBounds({ ...bounds });
    if (!sameBounds(record.view.getBounds(), bounds)) {
      fail(
        "ELECTRON_WORKSPACE_WEB_CHROME_BOUNDS_READBACK_FAILED",
        "The Rion-owned Web chrome did not retain its exact native bounds."
      );
    }
  }

  async #attach(record: ChromeRecord): Promise<void> {
    if (record.attached) return;
    if (record.parent.isDestroyed()) {
      fail(
        "ELECTRON_WORKSPACE_WEB_CHROME_HOST_STALE",
        "The retained native host closed before Web chrome attachment."
      );
    }
    if (this.#nativeAttachments) {
      await this.#nativeAttachments.attachNonInputSurface({
        surfaceId: record.chromeSurfaceId,
        generation: record.generation,
        parent: record.parent,
        isCancelled: () => record.state === "closing" ||
          record.destroyedObserved || record.parent.isDestroyed(),
        attach: () => {
          record.parent.contentView.addChildView(record.view);
          record.attached = true;
        },
        detach: () => this.#detachView(record)
      });
      return;
    }
    record.parent.contentView.addChildView(record.view);
    record.attached = true;
  }

  async #detach(record: ChromeRecord): Promise<void> {
    if (!record.attached) return;
    if (this.#nativeAttachments) {
      await this.#nativeAttachments.detachNonInputSurface(
        record.chromeSurfaceId,
        record.generation,
        record.parent
      );
      if (record.attached) {
        fail(
          "ELECTRON_WORKSPACE_WEB_CHROME_DETACH_READBACK_FAILED",
          "The retained native host did not retire its Rion-owned Web chrome."
        );
      }
      return;
    }
    this.#detachView(record);
  }

  #detachView(record: ChromeRecord): void {
    if (!record.attached) return;
    record.parent.contentView.removeChildView(record.view);
    record.attached = false;
  }

  async #closeFailedCreate(record: ChromeRecord): Promise<void> {
    record.state = "closing";
    try {
      await this.#detach(record);
      if (!record.destroyedObserved) {
        record.contents.close({ waitForBeforeUnload: false });
        await record.destroyed.promise;
      }
      await this.#content.closeSurface(record.surfaceId, record.generation);
      this.#removeListeners(record);
      this.#records.delete(record.surfaceId);
    } catch {
      record.state = "quarantined";
    }
  }

  #removeListeners(record: ChromeRecord): void {
    record.contents.removeListener("destroyed", record.listeners.destroyed);
    record.contents.removeListener("did-finish-load", record.listeners.didFinishLoad);
    record.contents.removeListener("did-fail-load", record.listeners.didFailLoad);
    record.contents.removeListener(
      "will-attach-webview",
      record.listeners.willAttachWebview
    );
    record.contents.removeListener("will-navigate", record.listeners.willNavigate);
    record.contents.removeListener("will-redirect", record.listeners.willRedirect);
  }

  #readPairedProjection(
    record: ChromeRecord,
    expectedSlot: ChromiumRoleSurfaceBounds = record.slotBounds,
    expectedVisible: boolean = record.visible,
    expectedContainedFullscreen: boolean = record.containedFullscreen
  ): Readonly<{
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
    chromeBounds: ChromiumRoleSurfaceBounds;
    chromeVisible: boolean;
    contentBounds: ChromiumRoleSurfaceBounds;
    contentVisible: boolean;
    zoomFactor?: number;
  }> {
    const chromeBounds = record.view.getBounds();
    const content = this.#content.readProjection(
      record.surfaceId,
      record.generation
    );
    const chromeVisible = record.view.getVisible();
    const expected = splitBounds(expectedSlot);
    const contentBoundsMatch = expectedContainedFullscreen
      ? sameBounds(content.bounds, expectedSlot)
      : sameBounds(content.bounds, expected.content);
    const visibilityMatches = expectedContainedFullscreen
      ? !chromeVisible && content.visible === expectedVisible
      : chromeVisible === expectedVisible && content.visible === expectedVisible;
    if (
      !sameBounds(chromeBounds, expected.chrome) || !contentBoundsMatch ||
      !visibilityMatches
    ) {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_READBACK_FAILED",
        "Rion chrome and remote content did not acknowledge one exact native slot projection."
      );
    }
    return Object.freeze({
      bounds: Object.freeze({ ...expectedSlot }),
      visible: expectedVisible,
      chromeBounds: Object.freeze({ ...chromeBounds }),
      chromeVisible,
      contentBounds: Object.freeze({ ...content.bounds }),
      contentVisible: content.visible,
      ...(content.zoomFactor === undefined
        ? {}
        : { zoomFactor: content.zoomFactor })
    });
  }

  /**
   * Chromium owns the DOM fullscreen event. This registry owns only the exact
   * paired native presentation and never mutates the Rust/Core slot topology.
   */
  #applyContainedFullscreen(record: ChromeRecord, fullscreen: boolean): void {
    if (
      this.#records.get(record.surfaceId) !== record ||
      record.state === "closing" || record.state === "quarantined" ||
      record.destroyedObserved || record.containedFullscreen === fullscreen
    ) return;
    const previous = record.containedFullscreen;
    try {
      record.view.setVisible(fullscreen ? false : record.visible);
      this.#content.setBounds(
        record.surfaceId,
        record.generation,
        fullscreen ? record.slotBounds : splitBounds(record.slotBounds).content
      );
      this.#content.setVisible(
        record.surfaceId,
        record.generation,
        record.visible
      );
      this.#readPairedProjection(
        record,
        record.slotBounds,
        record.visible,
        fullscreen
      );
      record.containedFullscreen = fullscreen;
      record.containedFullscreenRevision += 1;
    } catch (error) {
      try {
        record.view.setVisible(previous ? false : record.visible);
        this.#content.setBounds(
          record.surfaceId,
          record.generation,
          previous ? record.slotBounds : splitBounds(record.slotBounds).content
        );
        this.#content.setVisible(
          record.surfaceId,
          record.generation,
          record.visible
        );
        this.#readPairedProjection(
          record,
          record.slotBounds,
          record.visible,
          previous
        );
      } catch {
        record.state = "quarantined";
        fail(
          "ELECTRON_WORKSPACE_WEB_CONTAINED_FULLSCREEN_COMPENSATION_FAILED",
          "The bounded Workspace Web fullscreen projection could not be compensated exactly."
        );
      }
      throw error;
    }
  }

  #activeRecord(surfaceId: string, generation: number): ChromeRecord {
    if (!validIdentifier(surfaceId) || !Number.isSafeInteger(generation) || generation < 1) {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_ID_INVALID",
        "The paired Workspace Web identity is malformed."
      );
    }
    const record = this.#records.get(surfaceId);
    if (!record || record.generation !== generation || record.state !== "active") {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_STALE",
        "The paired Workspace Web presentation is no longer active."
      );
    }
    return record;
  }

  #receiveAction(event: ChromiumWorkspaceWebChromeIpcEvent, payload: unknown): void {
    try {
      const action = parseAction(payload);
      const record = this.#records.get(action.surfaceId);
      if (
        !record || record.generation !== action.generation ||
        record.contents !== event.sender || record.state !== "active"
      ) {
        fail(
          "ELECTRON_WORKSPACE_WEB_CHROME_SENDER_STALE",
          "The local Web chrome action lost its exact surface sender fence."
        );
      }
      record.actionLane = record.actionLane.then(
        () => this.#applyAction(record, action),
        () => this.#applyAction(record, action)
      ).catch((error: unknown) => {
        this.#onError(normalizeRionBridgeError(
          error,
          "ELECTRON_WORKSPACE_WEB_CHROME_ACTION_FAILED"
        ));
      });
    } catch (error) {
      this.#onError(normalizeRionBridgeError(
        error,
        "ELECTRON_WORKSPACE_WEB_CHROME_ACTION_INVALID"
      ));
    }
  }

  async #applyAction(
    record: ChromeRecord,
    action: WorkspaceWebChromeAction
  ): Promise<void> {
    if (record.state !== "active") return;
    let evidence: ChromiumGlobalWebSurfaceRuntimeEvidence;
    switch (action.type) {
      case "ready":
        evidence = this.#content.runtimeEvidence(record.surfaceId, record.generation);
        break;
      case "back":
        evidence = await this.#content.goBack(record.surfaceId, record.generation);
        break;
      case "forward":
        evidence = await this.#content.goForward(record.surfaceId, record.generation);
        break;
      case "reload":
        evidence = await this.#content.reload(record.surfaceId, record.generation);
        break;
      case "home":
        evidence = await this.#content.navigate(
          record.surfaceId,
          record.generation,
          record.homeUrl
        );
        break;
      case "navigate":
        evidence = await this.#content.navigate(
          record.surfaceId,
          record.generation,
          action.url!
        );
        break;
    }
    if (record.state === "active") this.#publishState(record, evidence);
  }

  #publishState(
    record: ChromeRecord,
    evidence: ChromiumGlobalWebSurfaceRuntimeEvidence
  ): void {
    record.contents.send(WORKSPACE_WEB_CHROME_STATE_CHANNEL, {
      surfaceId: record.surfaceId,
      generation: record.generation,
      url: evidence.currentUrl,
      canGoBack: evidence.canGoBack,
      canGoForward: evidence.canGoForward
    });
  }

  #requireOpen(): void {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_WORKSPACE_WEB_PRESENTATION_DRAINING",
        "The paired Workspace Web presentation registry is draining."
      );
    }
  }
}
