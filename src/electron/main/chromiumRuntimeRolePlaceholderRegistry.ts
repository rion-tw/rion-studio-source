import { pathToFileURL } from "node:url";

import {
  RUNTIME_ROLE_PLACEHOLDER_CHANNEL,
  RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION,
  RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL,
  parseRuntimeRolePlaceholderAction,
  parseRuntimeRolePlaceholderClaimReceipt,
  parseRuntimeRolePlaceholderState,
  type RuntimeRolePlaceholderClaimReceipt,
  type RuntimeRolePlaceholderState
} from "../../shared/runtimeRolePlaceholder";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type {
  ChromiumGlobalWebNativeAttachmentPort
} from "./chromiumGlobalWebSurfaceRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort,
  ChromiumWebContentsViewFactoryPort
} from "./chromiumRoleSurfacePorts";
import { buildRemoteContentWebPreferences } from "./security";

type RegistryState = "open" | "draining" | "disposed";
type PlaceholderState = "opening" | "active" | "closing" | "quarantined";

export interface ChromiumRuntimeRolePlaceholderIpcEvent {
  readonly sender: object;
}

export interface ChromiumRuntimeRolePlaceholderIpcMainPort {
  handle: (
    channel: string,
    listener: (
      event: ChromiumRuntimeRolePlaceholderIpcEvent,
      payload: unknown
    ) => unknown
  ) => void;
  removeHandler: (channel: string) => void;
}

export interface ChromiumRuntimeRolePlaceholderShellInput {
  readonly documentPath: string;
  readonly ipcMain: ChromiumRuntimeRolePlaceholderIpcMainPort;
  readonly preloadPath: string;
  readonly session: ChromiumRoleSessionPort;
  readonly sessionIdentity: typeof RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION;
}

export interface ChromiumRuntimeRolePlaceholderDescriptor {
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly ownerGeneration: number;
  readonly ownerTabName: string | null;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly placeholderId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly slotId: string;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export interface ChromiumRuntimeRolePlaceholderEvidence
extends RuntimeRolePlaceholderState {
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly nativeHostId: number;
  readonly shellSession: typeof RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION;
  readonly shellStoragePath: null;
  readonly shellUrl: string;
  readonly visible: boolean;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

interface PlaceholderListeners {
  readonly destroyed: () => void;
  readonly didFailLoad: ChromiumRoleSurfaceEventMap["did-fail-load"];
  readonly didFinishLoad: () => void;
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: ChromiumRoleSurfaceEventMap["will-navigate"];
  readonly willRedirect: ChromiumRoleSurfaceEventMap["will-redirect"];
}

interface PlaceholderRecord {
  readonly contents: ChromiumRoleSurfaceWebContentsPort;
  readonly destroyed: Deferred<void>;
  readonly generation: number;
  readonly loaded: Deferred<void>;
  readonly listeners: PlaceholderListeners;
  readonly placeholderId: string;
  readonly view: ChromiumRoleWebContentsViewPort;
  attached: boolean;
  bounds: ChromiumRoleSurfaceBounds;
  claimPromise: Promise<RuntimeRolePlaceholderClaimReceipt> | null;
  descriptor: ChromiumRuntimeRolePlaceholderDescriptor;
  destroyedObserved: boolean;
  loadSettled: boolean;
  state: PlaceholderState;
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

function placeholderError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw placeholderError(code, message);
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function sameDescriptor(
  left: ChromiumRuntimeRolePlaceholderDescriptor,
  right: ChromiumRuntimeRolePlaceholderDescriptor
): boolean {
  return sameBounds(left.bounds, right.bounds) &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerTabName === right.ownerTabName && left.parent === right.parent &&
    left.placeholderId === right.placeholderId && left.roleId === right.roleId &&
    left.roleName === right.roleName && left.slotId === right.slotId &&
    left.tabId === right.tabId &&
    left.topologyRevision === right.topologyRevision &&
    left.visible === right.visible &&
    left.windowGeneration === right.windowGeneration &&
    left.windowId === right.windowId;
}

function validateDescriptor(
  descriptor: ChromiumRuntimeRolePlaceholderDescriptor
): RuntimeRolePlaceholderState {
  const state = parseRuntimeRolePlaceholderState({
    blocked: true,
    generation: 1,
    ownerGeneration: descriptor.ownerGeneration,
    ownerTabName: descriptor.ownerTabName,
    placeholderId: descriptor.placeholderId,
    roleId: descriptor.roleId,
    roleName: descriptor.roleName,
    slotId: descriptor.slotId,
    tabId: descriptor.tabId,
    topologyRevision: descriptor.topologyRevision,
    windowGeneration: descriptor.windowGeneration,
    windowId: descriptor.windowId
  });
  if (
    !state || !descriptor.bounds ||
    ![descriptor.bounds.x, descriptor.bounds.y, descriptor.bounds.width,
      descriptor.bounds.height].every(Number.isSafeInteger) ||
    descriptor.bounds.width < 1 || descriptor.bounds.height < 1 ||
    !Number.isSafeInteger(descriptor.parent.id) || descriptor.parent.id < 1 ||
    descriptor.parent.isDestroyed()
  ) {
    fail(
      "ELECTRON_ROLE_PLACEHOLDER_DESCRIPTOR_INVALID",
      "Core supplied a malformed or stale blocked Role-slot placeholder."
    );
  }
  return state;
}

function sameIdentity(
  state: RuntimeRolePlaceholderState,
  action: Exclude<ReturnType<typeof parseRuntimeRolePlaceholderAction>, null>
): boolean {
  if (action.type !== "claim") return false;
  return state.generation === action.generation &&
    state.ownerGeneration === action.ownerGeneration &&
    state.placeholderId === action.placeholderId &&
    state.roleId === action.roleId && state.slotId === action.slotId &&
    state.tabId === action.tabId &&
    state.topologyRevision === action.topologyRevision &&
    state.windowGeneration === action.windowGeneration &&
    state.windowId === action.windowId;
}

/**
 * Owns sandboxed local blocked-slot surfaces. On macOS the view is attached
 * through the retained AppKit physical content host; no HTML replaces native
 * Game Window or tab chrome. Claim authority stays in Rust/Core.
 */
export class ChromiumRuntimeRolePlaceholderRegistry {
  readonly #claim: (
    state: RuntimeRolePlaceholderState
  ) => Promise<RuntimeRolePlaceholderClaimReceipt>;
  readonly #documentUrl: string;
  readonly #nativeAttachments: ChromiumGlobalWebNativeAttachmentPort | null;
  readonly #records = new Map<string, PlaceholderRecord>();
  readonly #recordByContents = new WeakMap<object, PlaceholderRecord>();
  readonly #shell: ChromiumRuntimeRolePlaceholderShellInput;
  readonly #views: ChromiumWebContentsViewFactoryPort;
  readonly #generations = new Map<string, number>();
  #disposePromise: Promise<void> | null = null;
  #state: RegistryState = "open";

  constructor(input: Readonly<{
    claim: (
      state: RuntimeRolePlaceholderState
    ) => Promise<RuntimeRolePlaceholderClaimReceipt>;
    nativeAttachments?: ChromiumGlobalWebNativeAttachmentPort | null;
    shell: ChromiumRuntimeRolePlaceholderShellInput;
    views: ChromiumWebContentsViewFactoryPort;
  }>) {
    if (
      input.shell.sessionIdentity !== RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION ||
      input.shell.session.storagePath !== null ||
      input.shell.documentPath.trim().length === 0 ||
      input.shell.preloadPath.trim().length === 0
    ) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_SHELL_INVALID",
        "The blocked Role slot requires an in-memory sandboxed local shell."
      );
    }
    this.#claim = input.claim;
    this.#documentUrl = pathToFileURL(input.shell.documentPath).href;
    this.#nativeAttachments = input.nativeAttachments ?? null;
    this.#shell = input.shell;
    this.#views = input.views;
    this.#shell.ipcMain.handle(
      RUNTIME_ROLE_PLACEHOLDER_CHANNEL,
      (event, payload) => this.#receiveAction(event, payload)
    );
  }

  get activeCount(): number {
    return this.#records.size;
  }

  async reconcile(
    descriptors: readonly ChromiumRuntimeRolePlaceholderDescriptor[]
  ): Promise<void> {
    if (this.#state !== "open") {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_DRAINING",
        "The blocked Role-slot registry is draining."
      );
    }
    const desired = new Map<string, ChromiumRuntimeRolePlaceholderDescriptor>();
    for (const descriptor of descriptors) {
      validateDescriptor(descriptor);
      if (desired.has(descriptor.placeholderId)) {
        fail(
          "ELECTRON_ROLE_PLACEHOLDER_DUPLICATE",
          "Core projected a duplicate blocked Role-slot identity."
        );
      }
      desired.set(descriptor.placeholderId, descriptor);
    }
    for (const descriptor of desired.values()) {
      const current = this.#records.get(descriptor.placeholderId);
      if (current) await this.#update(current, descriptor);
      else await this.#create(descriptor);
    }
    for (const record of [...this.#records.values()]) {
      if (!desired.has(record.placeholderId)) await this.#close(record);
    }
  }

  readEvidence(placeholderId: string): ChromiumRuntimeRolePlaceholderEvidence {
    const record = this.#records.get(placeholderId);
    if (!record || record.state !== "active") {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_STALE",
        "The blocked Role-slot placeholder is no longer active."
      );
    }
    const state = this.#stateFor(record);
    const bounds = record.view.getBounds();
    const visible = record.view.getVisible();
    if (
      !sameBounds(bounds, record.bounds) ||
      record.contents.session !== this.#shell.session ||
      this.#shell.session.storagePath !== null ||
      record.contents.getURL() !== this.#documentUrl
    ) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_READBACK_FAILED",
        "The local placeholder lost its exact native projection or Session."
      );
    }
    return Object.freeze({
      ...state,
      bounds: Object.freeze({ ...bounds }),
      nativeHostId: record.descriptor.parent.id,
      shellSession: RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION,
      shellStoragePath: null,
      shellUrl: record.contents.getURL(),
      visible
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "draining";
    this.#disposePromise = Promise.allSettled(
      [...this.#records.values()].map((record) => this.#close(record))
    ).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      this.#shell.ipcMain.removeHandler(RUNTIME_ROLE_PLACEHOLDER_CHANNEL);
      this.#state = "disposed";
    }).catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  async #create(
    descriptor: ChromiumRuntimeRolePlaceholderDescriptor
  ): Promise<void> {
    const generation = (this.#generations.get(descriptor.placeholderId) ?? 0) + 1;
    this.#generations.set(descriptor.placeholderId, generation);
    const view = this.#views.create({
      webPreferences: {
        ...buildRemoteContentWebPreferences({ preloadPath: this.#shell.preloadPath }),
        session: this.#shell.session
      }
    });
    const contents = view.webContents;
    if (contents.session !== this.#shell.session || contents.isDestroyed()) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_SESSION_MISMATCH",
        "The local placeholder did not retain its in-memory shell Session."
      );
    }
    const destroyed = deferred<void>();
    const loaded = deferred<void>();
    const record = {
      contents,
      destroyed,
      generation,
      loaded,
      listeners: undefined as unknown as PlaceholderListeners,
      placeholderId: descriptor.placeholderId,
      view,
      attached: false,
      bounds: Object.freeze({ ...descriptor.bounds }),
      claimPromise: null,
      descriptor,
      destroyedObserved: false,
      loadSettled: false,
      state: "opening" as PlaceholderState
    };
    record.listeners = this.#listeners(record);
    this.#records.set(record.placeholderId, record);
    this.#recordByContents.set(contents, record);
    try {
      this.#secure(record);
      view.setBounds({ ...descriptor.bounds });
      view.setVisible(descriptor.visible);
      this.#readProjection(record, descriptor.bounds, descriptor.visible);
      await this.#attach(record);
      void contents.loadURL(this.#documentUrl).catch(() => {
        // EventBound: did-fail-load is the authoritative local-load terminal.
      });
      await loaded.promise;
      record.state = "active";
      this.#publishState(record);
    } catch (error) {
      await this.#close(record).catch(() => undefined);
      throw error;
    }
  }

  async #update(
    record: PlaceholderRecord,
    descriptor: ChromiumRuntimeRolePlaceholderDescriptor
  ): Promise<void> {
    if (
      record.descriptor.tabId !== descriptor.tabId ||
      record.descriptor.slotId !== descriptor.slotId ||
      record.descriptor.roleId !== descriptor.roleId
    ) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_IDENTITY_DIVERGED",
        "A blocked placeholder identity was reused for another Role slot."
      );
    }
    // Reapplying an identical child-view projection can itself cause AppKit to
    // report layout. Keep this EventBound follower idempotent so an unchanged
    // native layout cannot feed back into another Core projection.
    if (sameDescriptor(record.descriptor, descriptor)) return;
    const previous = record.descriptor;
    try {
      if (previous.parent !== descriptor.parent) {
        await this.#detach(record);
        record.descriptor = descriptor;
        await this.#attach(record);
      } else {
        record.descriptor = descriptor;
      }
      if (!sameBounds(previous.bounds, descriptor.bounds)) {
        record.view.setBounds({ ...descriptor.bounds });
      }
      if (previous.visible !== descriptor.visible) {
        record.view.setVisible(descriptor.visible);
      }
      this.#readProjection(record, descriptor.bounds, descriptor.visible);
      record.bounds = Object.freeze({ ...descriptor.bounds });
      record.claimPromise = null;
      this.#publishState(record);
    } catch (error) {
      record.state = "quarantined";
      try {
        if (record.attached && record.descriptor.parent !== previous.parent) {
          await this.#detach(record);
        }
        record.descriptor = previous;
        if (!record.attached) await this.#attach(record);
        record.view.setBounds({ ...previous.bounds });
        record.view.setVisible(previous.visible);
        this.#readProjection(record, previous.bounds, previous.visible);
        record.bounds = Object.freeze({ ...previous.bounds });
      } catch {
        throw placeholderError(
          "ELECTRON_ROLE_PLACEHOLDER_COMPENSATION_FAILED",
          "The failed placeholder update could not restore its exact native projection."
        );
      }
      throw error;
    }
  }

  async #close(record: PlaceholderRecord): Promise<void> {
    if (!this.#records.has(record.placeholderId)) return;
    record.state = "closing";
    await this.#detach(record);
    if (!record.destroyedObserved) {
      record.contents.close({ waitForBeforeUnload: false });
      await record.destroyed.promise;
    }
    this.#removeListeners(record);
    this.#records.delete(record.placeholderId);
  }

  #listeners(record: PlaceholderRecord): PlaceholderListeners {
    return {
      destroyed: () => {
        record.destroyedObserved = true;
        if (!record.loadSettled) {
          record.loadSettled = true;
          record.loaded.reject(placeholderError(
            "ELECTRON_ROLE_PLACEHOLDER_DESTROYED",
            "The local placeholder closed before its exact document loaded."
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
        record.loaded.reject(placeholderError(
          "ELECTRON_ROLE_PLACEHOLDER_LOAD_FAILED",
          "The sandboxed local placeholder document did not load."
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
  }

  #secure(record: PlaceholderRecord): void {
    record.contents.setWindowOpenHandler(() => ({ action: "deny" }));
    record.contents.on("destroyed", record.listeners.destroyed);
    record.contents.on("did-finish-load", record.listeners.didFinishLoad);
    record.contents.on("did-fail-load", record.listeners.didFailLoad);
    record.contents.on("will-attach-webview", record.listeners.willAttachWebview);
    record.contents.on("will-navigate", record.listeners.willNavigate);
    record.contents.on("will-redirect", record.listeners.willRedirect);
  }

  #removeListeners(record: PlaceholderRecord): void {
    record.contents.removeListener("destroyed", record.listeners.destroyed);
    record.contents.removeListener("did-finish-load", record.listeners.didFinishLoad);
    record.contents.removeListener("did-fail-load", record.listeners.didFailLoad);
    record.contents.removeListener("will-attach-webview", record.listeners.willAttachWebview);
    record.contents.removeListener("will-navigate", record.listeners.willNavigate);
    record.contents.removeListener("will-redirect", record.listeners.willRedirect);
  }

  async #attach(record: PlaceholderRecord): Promise<void> {
    if (record.attached) return;
    const parent = record.descriptor.parent;
    if (parent.isDestroyed()) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_HOST_STALE",
        "The retained native content host closed before placeholder attachment."
      );
    }
    if (this.#nativeAttachments) {
      await this.#nativeAttachments.attachNonInputSurface({
        surfaceId: record.placeholderId,
        generation: record.generation,
        parent,
        isCancelled: () => record.state === "closing" ||
          record.destroyedObserved || parent.isDestroyed(),
        attach: () => {
          parent.contentView.addChildView(record.view);
          record.attached = true;
        },
        detach: () => this.#detachView(record)
      });
      return;
    }
    parent.contentView.addChildView(record.view);
    record.attached = true;
  }

  async #detach(record: PlaceholderRecord): Promise<void> {
    if (!record.attached) return;
    const parent = record.descriptor.parent;
    if (this.#nativeAttachments) {
      await this.#nativeAttachments.detachNonInputSurface(
        record.placeholderId,
        record.generation,
        parent
      );
      if (record.attached) {
        fail(
          "ELECTRON_ROLE_PLACEHOLDER_DETACH_READBACK_FAILED",
          "The retained native host did not detach its placeholder."
        );
      }
      return;
    }
    this.#detachView(record);
  }

  #detachView(record: PlaceholderRecord): void {
    if (!record.attached) return;
    record.descriptor.parent.contentView.removeChildView(record.view);
    record.attached = false;
  }

  #readProjection(
    record: PlaceholderRecord,
    bounds: ChromiumRoleSurfaceBounds,
    visible: boolean
  ): void {
    if (
      !sameBounds(record.view.getBounds(), bounds) ||
      record.view.getVisible() !== visible
    ) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_PROJECTION_READBACK_FAILED",
        "The local placeholder did not acknowledge exact native bounds and visibility."
      );
    }
  }

  #stateFor(record: PlaceholderRecord): RuntimeRolePlaceholderState {
    const descriptor = record.descriptor;
    const state = parseRuntimeRolePlaceholderState({
      blocked: true,
      generation: record.generation,
      ownerGeneration: descriptor.ownerGeneration,
      ownerTabName: descriptor.ownerTabName,
      placeholderId: descriptor.placeholderId,
      roleId: descriptor.roleId,
      roleName: descriptor.roleName,
      slotId: descriptor.slotId,
      tabId: descriptor.tabId,
      topologyRevision: descriptor.topologyRevision,
      windowGeneration: descriptor.windowGeneration,
      windowId: descriptor.windowId
    });
    if (!state) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_STATE_INVALID",
        "The blocked Role-slot state lost its exact identity fence."
      );
    }
    return state;
  }

  #publishState(record: PlaceholderRecord): void {
    if (record.state !== "active") return;
    record.contents.send(RUNTIME_ROLE_PLACEHOLDER_STATE_CHANNEL, this.#stateFor(record));
  }

  async #receiveAction(
    event: ChromiumRuntimeRolePlaceholderIpcEvent,
    payload: unknown
  ): Promise<RuntimeRolePlaceholderState | RuntimeRolePlaceholderClaimReceipt> {
    const action = parseRuntimeRolePlaceholderAction(payload);
    const record = this.#recordByContents.get(event.sender);
    if (!action || !record || record.contents !== event.sender ||
        record.state !== "active" || this.#records.get(record.placeholderId) !== record) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_ACTION_UNAUTHORIZED",
        "The local placeholder action lost its exact sender or native owner."
      );
    }
    const state = this.#stateFor(record);
    if (action.type === "ready") return state;
    if (!sameIdentity(state, action)) {
      fail(
        "ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE",
        "The blocked Role owner or native topology changed before the visible claim."
      );
    }
    if (!record.claimPromise) {
      record.claimPromise = this.#claim(state).then((candidate) => {
        const receipt = parseRuntimeRolePlaceholderClaimReceipt(candidate);
        if (!receipt || !sameIdentity(state, { ...receipt, type: "claim" })) {
          fail(
            "ELECTRON_ROLE_PLACEHOLDER_RECEIPT_INVALID",
            "Core did not terminalize the exact visible Role-slot claim."
          );
        }
        return receipt;
      }).catch((error: unknown) => {
        record.claimPromise = null;
        throw error;
      });
    }
    return record.claimPromise;
  }
}
