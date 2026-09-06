import type {
  WindowsChromiumInputBaseWindowPort,
  WindowsChromiumInputRuntimeParentBinding,
  WindowsChromiumInputRuntimeParentResolverPort,
  WindowsChromiumInputPresentationEvent
} from "./windowsChromiumInputHostPorts";
export type {
  WindowsChromiumInputBaseWindowPort,
  WindowsChromiumInputRuntimeParentBinding,
  WindowsChromiumInputRuntimeParentResolverPort,
  WindowsChromiumInputPresentationEvent
} from "./windowsChromiumInputHostPorts";
import { submitOwnedChromiumKey, submitOwnedChromiumClick } from "./chromiumOwnedInputSubmission";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceNativeAttachmentInput,
  ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceNativePresentationInput,
  ChromiumRoleSurfaceNativeReparentInput,
  ChromiumRoleSurfaceNativeRetirementInput,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleWebContentsViewPort
} from "./chromiumRoleSurfacePorts";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "./chromiumTrustedInputCoordinator";
import {
  WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION,
  type RawNativeWindowsChromiumTrustedInputHost,
  type WindowsChromiumInputDeliveryMode,
  type WindowsChromiumInputSurfaceIdentity,
  type LegacyWindowsChromiumInputSurfaceIdentity,
  type WindowsChromiumInputSurfaceProbeReceipt,
  type WindowsChromiumTrustedInputHostBinding,
  type WindowsChromiumTrustedInputHostPort,
  type WindowsNativeTrustedKeyRequest,
  type WindowsNativeTrustedKeySubmissionReceipt,
  type WindowsNativeTrustedMouseRequest,
  type WindowsNativeTrustedMouseSubmissionReceipt
} from "./windowsChromiumTrustedInputContract";

const HANDLE_TOKEN_PATTERN = /^[0-9a-f]{32,128}$/u;
const HOST_EVENTS = Object.freeze([
  "move", "resize", "show", "hide", "minimize", "restore", "focus", "blur"
] as const);

export interface RawWindowsChromiumInputHwndProbeReceipt {
  readonly abiVersion: number;
  readonly surfaceHandleToken: string;
  readonly parentHandleToken: string;
  readonly processId: number;
  readonly uiThreadId: number;
  readonly parentUiThreadId: number;
  readonly currentProcessOwned: boolean;
  readonly exactParent: boolean;
  readonly childWindowStyle: boolean;
  readonly popupWindowStyleAbsent: boolean;
  readonly noActivateStyle: boolean;
  readonly foregroundWindowPreserved: boolean;
  readonly activeWindowPreserved: boolean;
  readonly focusWindowPreserved: boolean;
  readonly focusIdentity: string;
  readonly parentWasForeground: boolean;
  readonly parentVisible: boolean;
  readonly surfaceVisible: boolean;
  readonly targetWasForeground: boolean;
  readonly targetHadThreadFocus: boolean;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly dpi: number;
}

export interface RawWindowsChromiumTrustedInputAddon {
  windowsChromiumInputProbeAbiVersion: () => number;
  attachWindowsChromiumInputHwnd: (
    surfaceHandle: Buffer,
    parentHandle: Buffer
  ) => RawWindowsChromiumInputHwndProbeReceipt;
  projectWindowsChromiumInputHwnd: (
    surfaceHandle: Buffer,
    parentHandle: Buffer,
    visible: boolean
  ) => RawWindowsChromiumInputHwndProbeReceipt;
  probeWindowsChromiumInputHwnd: (
    surfaceHandle: Buffer,
    parentHandle: Buffer
  ) => RawWindowsChromiumInputHwndProbeReceipt;

}

export interface WindowsChromiumInputFocusDeadlinePort {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface WindowsChromiumInputBaseWindowFactoryPort {
  create: (options: Readonly<{
    parent: WindowsChromiumInputBaseWindowPort;
    show: false;
    focusable: false;
    frame: false;
    transparent: true;
    hasShadow: false;
    movable: false;
    resizable: false;
    minimizable: false;
    maximizable: false;
    fullscreenable: false;
    skipTaskbar: true;
    backgroundColor: "#00000000";
  }>) => WindowsChromiumInputBaseWindowPort;
}

interface SurfaceRecord {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly nativeGeneration: number;
  readonly bindingRevision: string;
  readonly logicalParent: ChromiumRoleSurfaceParentPort;
  readonly parentBinding: WindowsChromiumInputRuntimeParentBinding;
  readonly child: WindowsChromiumInputBaseWindowPort;
  readonly view: ChromiumRoleWebContentsViewPort;
  readonly surfaceHandle: Buffer;
  readonly parentHandle: Buffer;
  readonly identity: LegacyWindowsChromiumInputSurfaceIdentity;
  readonly native: RawNativeWindowsChromiumTrustedInputHost;
  readonly parentEventListener: () => void;
  readonly childClosedListener: () => void;
  probe: RawWindowsChromiumInputHwndProbeReceipt;
  probeRevision: string;
  closing: boolean;
  projectionStale: boolean;
  quarantined: boolean;
}

interface StagedChild {
  readonly child: WindowsChromiumInputBaseWindowPort;
  readonly parentBinding: WindowsChromiumInputRuntimeParentBinding;
  readonly surfaceHandle: Buffer;
  readonly parentHandle: Buffer;
  readonly probe: RawWindowsChromiumInputHwndProbeReceipt;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

interface PendingForegroundFocus {
  readonly completion: Deferred<ChromiumNativeTrustedInputReceipt>;
  readonly record: SurfaceRecord;
  readonly request: ChromiumNativeTrustedInputRequest;
  timer: unknown;
  terminal: boolean;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function attachmentError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw attachmentError(code, message);
}

function canonicalPositiveU64(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function validateGeneration(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "ELECTRON_WINDOWS_INPUT_GENERATION_INVALID",
      `A positive ${field} generation is required for the Win32 input host.`
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

function validBounds(bounds: ChromiumRoleSurfaceBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) &&
    bounds.width > 0 && bounds.height > 0;
}

function sameIdentity(
  left: WindowsChromiumInputSurfaceIdentity,
  right: WindowsChromiumInputSurfaceIdentity
): boolean {
  if (left.ownerKind === "view" || right.ownerKind === "view") return false;
  return left.roleId === right.roleId &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.nativeGeneration === right.nativeGeneration &&
    left.bindingRevision === right.bindingRevision &&
    left.surfaceHandleToken === right.surfaceHandleToken &&
    left.parentHandleToken === right.parentHandleToken;
}

/**
 * Owns one dedicated no-activate Electron child HWND per exact role surface.
 * Ownership transitions settle from Electron/Win32 events and synchronous
 * receipts. Foreground focus uses the request's Core-owned failure deadline;
 * no HWND enumeration or timer-driven success is used to infer ownership.
 */
export class WindowsChromiumInputSurfaceAttachmentCoordinator
implements ChromiumRoleSurfaceNativeAttachmentPort,
  WindowsChromiumTrustedInputHostPort {
  readonly #addon: RawWindowsChromiumTrustedInputAddon;
  readonly #baseWindows: WindowsChromiumInputBaseWindowFactoryPort;
  readonly #deadlines: WindowsChromiumInputFocusDeadlinePort;
  readonly #nowMs: () => number;
  readonly #parents: WindowsChromiumInputRuntimeParentResolverPort;
  readonly #onError: (error: RionBridgeError) => void;
  readonly #recordsByRole = new Map<string, SurfaceRecord>();
  readonly #pendingFocusByRole = new Map<string, PendingForegroundFocus>();
  readonly #presentationListeners = new Set<(
    event: WindowsChromiumInputPresentationEvent
  ) => void>();
  readonly #roleByChild = new WeakMap<object, string>();
  #nextNativeGeneration = 0;
  #nextRevision = 0n;
  #disposed = false;

  constructor(input: Readonly<{
    addon: RawWindowsChromiumTrustedInputAddon;
    baseWindows: WindowsChromiumInputBaseWindowFactoryPort;
    deadlines: WindowsChromiumInputFocusDeadlinePort;
    nowMs: () => number;
    parents: WindowsChromiumInputRuntimeParentResolverPort;
    onError: (error: RionBridgeError) => void;
  }>) {
    if (input.addon.windowsChromiumInputProbeAbiVersion() !==
      WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION) {
      fail(
        "ELECTRON_WINDOWS_INPUT_ABI_MISMATCH",
        "The Win32 trusted-input probe ABI does not match Electron."
      );
    }
    this.#addon = input.addon;
    this.#baseWindows = input.baseWindows;
    this.#deadlines = input.deadlines;
    this.#nowMs = input.nowMs;
    this.#parents = input.parents;
    this.#onError = input.onError;
  }

  attach(input: ChromiumRoleSurfaceNativeAttachmentInput): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(attachmentError(
        "ELECTRON_WINDOWS_INPUT_COORDINATOR_CLOSED",
        "The Win32 input-surface owner is closed."
      ));
    }
    if (this.#recordsByRole.has(input.roleId) || !input.view || !input.attachTo) {
      return Promise.reject(attachmentError(
        "ELECTRON_WINDOWS_INPUT_OWNERSHIP_CONFLICT",
        "The role already owns a child HWND or lacks an exact physical attach lane."
      ));
    }
    let staged: StagedChild | null = null;
    let attached = false;
    try {
      staged = this.#stageChild(input.parent);
      if (input.isCancelled()) {
        fail(
          "ELECTRON_WINDOWS_INPUT_ATTACH_CANCELLED",
          "The role surface was cancelled before child-HWND attachment."
        );
      }
      input.attachTo(staged.child);
      attached = true;
      this.#requireSingleView(staged.child, input.view);
      const record = this.#buildRecord(input, staged);
      this.#synchronizePresentation(record);
      if (input.isCancelled()) {
        fail(
          "ELECTRON_WINDOWS_INPUT_ATTACH_CANCELLED",
          "The role surface was cancelled during child-HWND attachment."
        );
      }
      this.#recordsByRole.set(input.roleId, record);
      this.#roleByChild.set(record.child, input.roleId);
      this.#subscribe(record);
      return Promise.resolve();
    } catch (error) {
      if (staged) {
        this.#rollbackStaged(staged.child, attached ? input.detach : null);
      }
      return Promise.reject(error);
    }
  }

  async reparent(input: ChromiumRoleSurfaceNativeReparentInput): Promise<void> {
    const source = this.#requireRecord(input.roleId, input.generation);
    this.#cancelFocus(
      source,
      "BROWSER_ACTION_STALE",
      "The foreground input host was superseded by native reparenting."
    );
    if (!input.view || input.view !== source.view ||
      !input.attachTargetTo || !input.restoreSourceTo) {
      fail(
        "ELECTRON_WINDOWS_INPUT_REPARENT_LANE_MISSING",
        "The Win32 child-host move lacks exact physical attach callbacks."
      );
    }
    const staged = this.#stageChild(input.targetParent);
    let detachedSource = false;
    let attachedTarget = false;
    try {
      if (input.isCancelled()) {
        fail(
          "ELECTRON_WINDOWS_INPUT_REPARENT_CANCELLED",
          "The child-HWND move was cancelled before source detach."
        );
      }
      input.detachSource();
      detachedSource = true;
      this.#requireNoViews(source.child);
      input.attachTargetTo(staged.child);
      attachedTarget = true;
      this.#requireSingleView(staged.child, source.view);
      const target = this.#buildRecord({
        roleId: input.roleId,
        generation: input.generation,
        parent: input.targetParent,
        isCancelled: input.isCancelled,
        attach: input.attachTarget,
        detach: input.detachTarget,
        view: input.view,
        attachTo: input.attachTargetTo
      }, staged);
      this.#synchronizePresentation(target);
      if (input.isCancelled()) {
        fail(
          "ELECTRON_WINDOWS_INPUT_REPARENT_CANCELLED",
          "The child-HWND move was cancelled before target commit."
        );
      }
      this.#unsubscribe(source);
      this.#closeEmptyChild(source.child);
      this.#recordsByRole.set(input.roleId, target);
      this.#roleByChild.set(target.child, input.roleId);
      this.#subscribe(target);
    } catch (error) {
      try {
        if (attachedTarget) {
          input.detachTarget();
          attachedTarget = false;
        }
        this.#rollbackStaged(staged.child, null);
        if (detachedSource) {
          input.restoreSourceTo(source.child);
          this.#requireSingleView(source.child, source.view);
          this.#synchronizePresentation(source);
        }
      } catch {
        this.#quarantine(source, attachmentError(
          "ELECTRON_WINDOWS_INPUT_REPARENT_ROLLBACK_FAILED",
          "The child-HWND move could not restore its exact source owner."
        ));
        throw attachmentError(
          "ELECTRON_WINDOWS_INPUT_REPARENT_ROLLBACK_FAILED",
          "The child-HWND move failed and source ownership is indeterminate."
        );
      }
      throw error;
    }
  }

  retire(
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort,
    physical?: ChromiumRoleSurfaceNativeRetirementInput
  ): Promise<void> {
    const record = this.#recordsByRole.get(roleId);
    if (!record) return Promise.resolve();
    if (record.surfaceGeneration !== generation || record.logicalParent !== parent ||
      !physical || physical.physicalParent !== record.child ||
      physical.view !== record.view) {
      return Promise.reject(attachmentError(
        "ELECTRON_WINDOWS_INPUT_RETIRE_STALE",
        "The Win32 retirement does not match the exact child-HWND owner."
      ));
    }
    try {
      record.closing = true;
      this.#cancelFocus(
        record,
        "BROWSER_ACTION_STALE",
        "The foreground input host retired before focus acknowledgement."
      );
      this.#unsubscribe(record);
      physical.detach();
      this.#requireNoViews(record.child);
      this.#closeEmptyChild(record.child);
      this.#deleteExact(record);
      return Promise.resolve();
    } catch (error) {
      this.#quarantine(record, attachmentError(
        "ELECTRON_WINDOWS_INPUT_RETIRE_FAILED",
        "The exact Win32 child input host did not acknowledge retirement."
      ));
      return Promise.reject(error);
    }
  }

  syncPresentation(input: ChromiumRoleSurfaceNativePresentationInput): void {
    // A Win32 fullscreen transition can emit an intermediate resize before its
    // terminal entered/left-fullscreen event. That event may leave the child
    // projection temporarily unreadable, but it does not revoke the exact HWND
    // identity. Only this explicit layout lane may re-attest such a record.
    const record = this.#requireRecord(input.roleId, input.generation, true);
    if (record.logicalParent !== input.parent || record.child !== input.physicalParent ||
      record.view !== input.view) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PRESENTATION_STALE",
        "The role projection no longer owns the exact Win32 child host."
      );
    }
    this.#synchronizePresentation(record);
  }

  resolve(
    roleId: string,
    generation: number
  ): WindowsChromiumTrustedInputHostBinding | null {
    const record = this.#recordsByRole.get(roleId);
    if (!record || record.surfaceGeneration !== generation || record.closing ||
      record.projectionStale || record.quarantined || this.#disposed) return null;
    try {
      this.#requireLiveRecord(record);
      return Object.freeze({ identity: record.identity, native: record.native });
    } catch {
      return null;
    }
  }

  subscribePresentation(
    listener: (event: WindowsChromiumInputPresentationEvent) => void
  ): () => void {
    if (this.#disposed) {
      fail(
        "ELECTRON_WINDOWS_INPUT_COORDINATOR_CLOSED",
        "The Win32 input-surface owner is closed."
      );
    }
    this.#presentationListeners.add(listener);
    return () => this.#presentationListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of [...this.#recordsByRole.values()]) {
      record.closing = true;
      this.#cancelFocus(
        record,
        "SYSTEM_TRUSTED_INPUT_ADAPTER_DISPOSED",
        "The Windows input host disposed before focus acknowledgement."
      );
      this.#unsubscribe(record);
      try {
        if (!record.child.isDestroyed()) {
          if (record.child.contentView.children.includes(record.view)) {
            record.child.contentView.removeChildView(record.view);
          }
          this.#closeEmptyChild(record.child);
        }
      } catch {
        this.#onError(attachmentError(
          "ELECTRON_WINDOWS_INPUT_DISPOSE_FAILED",
          `The child input host for ${record.roleId} did not close during disposal.`
        ));
      }
      this.#deleteExact(record);
    }
    this.#presentationListeners.clear();
  }

  #stageChild(parent: ChromiumRoleSurfaceParentPort): StagedChild {
    const parentBinding = this.#requireParentBinding(parent);
    let child: WindowsChromiumInputBaseWindowPort;
    try {
      child = this.#baseWindows.create({
        parent: parentBinding.window,
        show: false,
        focusable: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        movable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        backgroundColor: "#00000000"
      });
    } catch {
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_CREATE_FAILED",
        "Electron could not create the dedicated no-activate input child host."
      );
    }
    if (!Number.isSafeInteger(child.id) || child.id < 1 || child.isDestroyed() ||
      child.contentView.children.length !== 0 || this.#roleByChild.has(child)) {
      this.#rollbackStaged(child, null);
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_INVALID",
        "Electron returned an invalid or aliased input child host."
      );
    }
    const bounds = parentBinding.window.getContentBounds();
    if (!validBounds(bounds)) {
      this.#rollbackStaged(child, null);
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_BOUNDS_INVALID",
        "The runtime parent has no positive exact content bounds."
      );
    }
    child.setBounds({ ...bounds });
    child.hide();
    if (!sameBounds(child.getBounds(), bounds) || child.isVisible()) {
      this.#rollbackStaged(child, null);
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_PROJECTION_FAILED",
        "Electron did not retain the hidden child host's exact bounds."
      );
    }
    const surfaceHandle = Buffer.from(child.getNativeWindowHandle());
    const parentHandle = Buffer.from(parentBinding.window.getNativeWindowHandle());
    const probe = this.#attachRaw(surfaceHandle, parentHandle);
    this.#requireProbeMatchesParent(parentBinding.window, probe);
    return { child, parentBinding, surfaceHandle, parentHandle, probe };
  }

  #buildRecord(
    input: ChromiumRoleSurfaceNativeAttachmentInput,
    staged: StagedChild
  ): SurfaceRecord {
    const view = input.view!;
    const nativeGeneration = this.#nextGeneration();
    const bindingRevision = this.#revision();
    const identity = Object.freeze({
      roleId: input.roleId,
      surfaceGeneration: input.generation,
      nativeGeneration,
      bindingRevision,
      surfaceHandleToken: staged.probe.surfaceHandleToken,
      parentHandleToken: staged.probe.parentHandleToken
    });
    const record = {} as SurfaceRecord;
    Object.assign(record, {
      roleId: input.roleId,
      surfaceGeneration: input.generation,
      nativeGeneration,
      bindingRevision,
      logicalParent: input.parent,
      parentBinding: staged.parentBinding,
      child: staged.child,
      view,
      surfaceHandle: staged.surfaceHandle,
      parentHandle: staged.parentHandle,
      identity,
      probe: staged.probe,
      probeRevision: this.#revision(),
      closing: false,
      projectionStale: false,
      quarantined: false,
      parentEventListener: () => this.#onParentProjection(record),
      childClosedListener: () => this.#onChildClosed(record),
      native: this.#nativePort(record)
    } satisfies SurfaceRecord);
    return record;
  }

  #nativePort(record: SurfaceRecord): RawNativeWindowsChromiumTrustedInputHost {
    return Object.freeze({
      focusForeground: (
        expected: WindowsChromiumInputSurfaceIdentity,
        request: ChromiumNativeTrustedInputRequest
      ) => this.#focusForeground(record, expected, request),
      currentInputDeliveryMode: (
        expected: WindowsChromiumInputSurfaceIdentity
      ) => {
        this.#requireExpected(record, expected);
        return this.#currentInputDeliveryMode(record);
      },
      isInputReady: (
        expected: WindowsChromiumInputSurfaceIdentity,
        deliveryMode: WindowsChromiumInputDeliveryMode
      ) => {
        this.#requireExpected(record, expected);
        return this.#currentInputDeliveryMode(record) === deliveryMode;
      },
      probeExactInputSurface: (
        expected: WindowsChromiumInputSurfaceIdentity,
        deliveryMode: WindowsChromiumInputDeliveryMode
      ) => this.#probeRecord(record, expected, deliveryMode),
      submitNativeBackgroundKey: (
        expected: WindowsChromiumInputSurfaceIdentity,
        request: WindowsNativeTrustedKeyRequest
      ) =>
        this.#submitKey(record, expected, request),
      submitNativeBackgroundMouse: (
        expected: WindowsChromiumInputSurfaceIdentity,
        request: WindowsNativeTrustedMouseRequest
      ) =>
        this.#submitMouse(record, expected, request)
    });
  }

  #focusForeground(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity,
    request: ChromiumNativeTrustedInputRequest
  ): Promise<ChromiumNativeTrustedInputReceipt> {
    try {
      this.#requireExpected(record, expected);
      this.#requireLiveRecord(record);
      if (request.action.type !== "focus" || request.roleId !== record.roleId ||
        request.surfaceGeneration !== record.surfaceGeneration ||
        !Number.isSafeInteger(request.scheduledAtMs) || request.scheduledAtMs < 1 ||
        !Number.isSafeInteger(request.deadlineMs) ||
        request.deadlineMs <= request.scheduledAtMs) {
        fail(
          "ELECTRON_WINDOWS_INPUT_FOCUS_REQUEST_INVALID",
          "The foreground-focus request does not match the exact role surface."
        );
      }
      const now = this.#nowMs();
      if (!Number.isSafeInteger(now) || now < 1 || now >= request.deadlineMs) {
        fail(
          "BROWSER_ACTION_DEADLINE",
          "The input-context deadline expired before native admission."
        );
      }
      if (!record.view.getVisible()) {
        // BrowserAction::Focus is Core's input-context admission fence. A hidden
        // Role in the already-foreground runtime window must not be selected or
        // focused merely to satisfy that fence. The exact background probe is
        // authoritative here; the following key action still requires native
        // submission plus the private isTrusted DOM receipt.
        this.#probeRecord(record, expected, "background");
        return Promise.resolve(this.#focusReceipt(
          request,
          "applied",
          null,
          null
        ));
      }
      if (this.#pendingFocusByRole.has(record.roleId)) {
        fail(
          "ELECTRON_WINDOWS_INPUT_FOCUS_CONFLICT",
          "The role already has one foreground-focus request in flight."
        );
      }
      const pending: PendingForegroundFocus = {
        completion: deferred(),
        record,
        request,
        timer: undefined,
        terminal: false
      };
      this.#pendingFocusByRole.set(record.roleId, pending);
      pending.timer = this.#deadlines.schedule(() => this.#terminalizeFocus(
        pending,
        "failed",
        "SYSTEM_TRUSTED_INPUT_FOREGROUND_DEADLINE",
        "The exact Windows runtime host did not acknowledge foreground focus."
      ), request.deadlineMs - now);
      record.parentBinding.window.show();
      record.parentBinding.window.focus();
      this.#completeFocusIfReady(record);
      return pending.completion.promise;
    } catch (error) {
      const bridge = error instanceof RionBridgeError ? error : attachmentError(
        "ELECTRON_WINDOWS_INPUT_FOCUS_FAILED",
        "The Windows runtime host rejected foreground focus."
      );
      const pending = this.#pendingFocusByRole.get(request.roleId);
      if (pending?.request === request) {
        this.#terminalizeFocus(
          pending,
          "failed",
          bridge.code,
          bridge.message
        );
        return pending.completion.promise;
      }
      return Promise.resolve(this.#focusReceipt(
        request,
        "failed",
        bridge.code,
        bridge.message
      ));
    }
  }

  #currentInputDeliveryMode(
    record: SurfaceRecord
  ): WindowsChromiumInputDeliveryMode | null {
    if (record.closing || record.projectionStale || record.quarantined ||
      this.#disposed ||
      this.#recordsByRole.get(record.roleId) !== record) return null;
    try {
      this.#requireLiveRecord(record);
      const native = this.#probeRaw(record.surfaceHandle, record.parentHandle);
      this.#requireProbeMatchesParent(record.parentBinding.window, native);
      this.#captureProbeChange(record, native);
      if (!native.parentWasForeground || !native.parentVisible ||
        !record.parentBinding.window.isVisible() ||
        !record.parentBinding.window.isFocused()) return null;
      const viewVisible = record.view.getVisible();
      if (native.surfaceVisible && viewVisible) return "foreground";
      if (!native.surfaceVisible && !viewVisible &&
        !native.targetWasForeground && !native.targetHadThreadFocus) {
        return "background";
      }
      return null;
    } catch {
      return null;
    }
  }

  #completeFocusIfReady(record: SurfaceRecord): void {
    const pending = this.#pendingFocusByRole.get(record.roleId);
    if (!pending || pending.record !== record || pending.terminal ||
      this.#currentInputDeliveryMode(record) !== "foreground") return;
    this.#terminalizeFocus(pending, "applied", null, null);
  }

  #terminalizeFocus(
    pending: PendingForegroundFocus,
    status: "applied" | "failed" | "superseded",
    errorCode: string | null,
    errorMessage: string | null
  ): void {
    if (pending.terminal) return;
    pending.terminal = true;
    this.#deadlines.cancel(pending.timer);
    if (this.#pendingFocusByRole.get(pending.record.roleId) === pending) {
      this.#pendingFocusByRole.delete(pending.record.roleId);
    }
    pending.completion.resolve(this.#focusReceipt(
      pending.request,
      status,
      errorCode,
      errorMessage
    ));
  }

  #focusReceipt(
    request: ChromiumNativeTrustedInputRequest,
    status: "applied" | "failed" | "superseded",
    errorCode: string | null,
    errorMessage: string | null
  ): ChromiumNativeTrustedInputReceipt {
    return Object.freeze({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: request.surfaceGeneration,
      status,
      completedAtMs: this.#nowMs(),
      errorCode,
      errorMessage,
      confirmedInputNeutrality: request.expectedInputNeutralityBefore
    });
  }

  #cancelFocus(record: SurfaceRecord, code: string, message: string): void {
    const pending = this.#pendingFocusByRole.get(record.roleId);
    if (!pending || pending.record !== record) return;
    this.#terminalizeFocus(pending, "superseded", code, message);
  }

  #probeRecord(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity,
    deliveryMode: WindowsChromiumInputDeliveryMode
  ): WindowsChromiumInputSurfaceProbeReceipt {
    this.#requireExpected(record, expected);
    this.#requireLiveRecord(record);
    const raw = this.#probeRaw(record.surfaceHandle, record.parentHandle);
    this.#requireProbeMatchesParent(record.parentBinding.window, raw);
    this.#captureProbeChange(record, raw);
    if (!raw.parentWasForeground || !raw.parentVisible ||
      this.#currentInputDeliveryMode(record) !== deliveryMode) {
      fail(
        "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_STALE",
        "The exact Windows role surface no longer matches its locked input delivery mode."
      );
    }
    return Object.freeze({
      ...record.identity,
      status: "verified",
      abiVersion: WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION,
      deliveryMode,
      probeRevision: record.probeRevision,
      processId: raw.processId,
      uiThreadId: raw.uiThreadId,
      currentProcessOwned: true,
      exactParent: true,
      childWindowStyle: true,
      popupWindowStyleAbsent: true,
      noActivateStyle: true,
      parentWasForeground: true,
      parentVisible: true,
      surfaceVisible: raw.surfaceVisible,
      targetWasForeground: raw.targetWasForeground,
      targetHadThreadFocus: raw.targetHadThreadFocus,
      singleWebContentsSurface: true,
      clientWidth: raw.clientWidth,
      clientHeight: raw.clientHeight,
      dpi: raw.dpi
    });
  }

  #submitKey(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity,
    request: WindowsNativeTrustedKeyRequest
  ): WindowsNativeTrustedKeySubmissionReceipt {
    this.#requireExpectedRequest(record, expected, request);
    return submitOwnedChromiumKey(this.#submissionOwner(record, expected), request);
  }

  #submitMouse(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity,
    request: WindowsNativeTrustedMouseRequest
  ): WindowsNativeTrustedMouseSubmissionReceipt {
    this.#requireExpectedRequest(record, expected, request);
    return submitOwnedChromiumClick(this.#submissionOwner(record, expected), request);
  }

  #submissionOwner(record: SurfaceRecord, expected: WindowsChromiumInputSurfaceIdentity) {
    return {
      identity: record.identity, probeRevision: record.probeRevision, nowMs: this.#nowMs,
      viewport: () => record.view.getBounds(),
      probe: () => {
        this.#requireExpected(record, expected);
        this.#requireLiveRecord(record);
        return this.#probeRaw(record.surfaceHandle, record.parentHandle);
      },
      contents: { sendInputEvent: (event: Parameters<NonNullable<typeof record.view.webContents.sendInputEvent>>[0]) => {
        const contents = record.view.webContents;
        if (!contents.sendInputEvent) fail("SYSTEM_TRUSTED_INPUT_UNAVAILABLE", "The Chromium input API is unavailable.");
        contents.sendInputEvent(event);
      } }
    };
  }

  #requireExpectedRequest(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity,
    request: WindowsNativeTrustedKeyRequest | WindowsNativeTrustedMouseRequest
  ): void {
    this.#requireExpected(record, expected);
    this.#requireLiveRecord(record);
    if (request.roleId !== record.roleId ||
      request.surfaceGeneration !== record.surfaceGeneration) {
      fail(
        "ELECTRON_WINDOWS_INPUT_REQUEST_STALE",
        "The native input request does not match the exact child-HWND owner."
      );
    }
    if (this.#currentInputDeliveryMode(record) !== request.deliveryMode) {
      fail(
        "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_STALE",
        "The exact Windows role surface changed input delivery mode before native submission."
      );
    }
  }

  #requireExpected(
    record: SurfaceRecord,
    expected: WindowsChromiumInputSurfaceIdentity
  ): void {
    if (!sameIdentity(record.identity, expected)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_BINDING_STALE",
        "The expected Win32 input binding has been superseded."
      );
    }
  }

  #requireLiveRecord(record: SurfaceRecord): void {
    if (record.closing || record.projectionStale || record.quarantined ||
      record.child.isDestroyed() ||
      this.#recordsByRole.get(record.roleId) !== record) {
      fail(
        "ELECTRON_WINDOWS_INPUT_HOST_UNAVAILABLE",
        "The exact Win32 child input host is no longer live."
      );
    }
    this.#requireSingleView(record.child, record.view);
    const currentParent = this.#requireParentBinding(record.logicalParent);
    if (!this.#sameParentBinding(currentParent, record.parentBinding)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_STALE",
        "The runtime parent generation changed beneath the input child host."
      );
    }
  }

  #synchronizePresentation(record: SurfaceRecord): void {
    if (record.closing || record.quarantined) {
      fail(
        "ELECTRON_WINDOWS_INPUT_HOST_UNAVAILABLE",
        "A quarantined Win32 child host cannot accept presentation changes."
      );
    }
    const currentParent = this.#requireParentBinding(record.logicalParent);
    if (!this.#sameParentBinding(currentParent, record.parentBinding)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_STALE",
        "The runtime parent generation changed during child projection."
      );
    }
    this.#requireSingleView(record.child, record.view);
    const bounds = currentParent.window.getContentBounds();
    if (!validBounds(bounds)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_BOUNDS_INVALID",
        "The runtime parent has no positive exact content bounds."
      );
    }
    record.projectionStale = true;
    const previousVisible = record.probe.surfaceVisible;
    const shouldShow = currentParent.window.isVisible() && record.view.getVisible();
    // Keep Electron's compositor lifecycle informed, then let the native
    // WS_CHILD owner apply and attest the final HWND presentation. Bounds must
    // not flow back through Electron after SetParent.
    if (shouldShow !== record.child.isVisible()) {
      if (shouldShow) record.child.showInactive();
      else record.child.hide();
    }
    const probe = this.#projectRaw(
      record.surfaceHandle,
      record.parentHandle,
      shouldShow
    );
    this.#requireProbeMatchesParent(currentParent.window, probe);
    if (probe.surfaceVisible !== shouldShow) {
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_PROJECTION_FAILED",
        "Win32 did not retain the exact Chromium child visibility."
      );
    }
    if (this.#rawProjectionChanged(record.probe, probe)) {
      record.probeRevision = this.#revision();
    }
    record.probe = probe;
    record.projectionStale = false;
    if (previousVisible !== shouldShow) {
      const event = Object.freeze({
        roleId: record.roleId,
        surfaceGeneration: record.surfaceGeneration,
        visible: shouldShow,
        previousVisible
      });
      for (const listener of this.#presentationListeners) listener(event);
    }
  }

  #captureProbeChange(
    record: SurfaceRecord,
    probe: RawWindowsChromiumInputHwndProbeReceipt
  ): void {
    if (this.#rawProjectionChanged(record.probe, probe)) {
      record.probeRevision = this.#revision();
      record.probe = probe;
    }
  }

  #rawProjectionChanged(
    prior: RawWindowsChromiumInputHwndProbeReceipt,
    next: RawWindowsChromiumInputHwndProbeReceipt
  ): boolean {
    return prior.surfaceHandleToken !== next.surfaceHandleToken ||
      prior.parentHandleToken !== next.parentHandleToken ||
      prior.processId !== next.processId || prior.uiThreadId !== next.uiThreadId ||
      prior.parentUiThreadId !== next.parentUiThreadId ||
      prior.parentVisible !== next.parentVisible ||
      prior.surfaceVisible !== next.surfaceVisible ||
      prior.clientWidth !== next.clientWidth || prior.clientHeight !== next.clientHeight ||
      prior.dpi !== next.dpi;
  }

  #probeRaw(
    surfaceHandle: Buffer,
    parentHandle: Buffer
  ): RawWindowsChromiumInputHwndProbeReceipt {
    return this.#validateRawProbe(this.#addon.probeWindowsChromiumInputHwnd(
      Buffer.from(surfaceHandle),
      Buffer.from(parentHandle)
    ));
  }

  #attachRaw(
    surfaceHandle: Buffer,
    parentHandle: Buffer
  ): RawWindowsChromiumInputHwndProbeReceipt {
    return this.#validateRawProbe(this.#addon.attachWindowsChromiumInputHwnd(
      Buffer.from(surfaceHandle),
      Buffer.from(parentHandle)
    ));
  }

  #projectRaw(
    surfaceHandle: Buffer,
    parentHandle: Buffer,
    visible: boolean
  ): RawWindowsChromiumInputHwndProbeReceipt {
    try {
      return this.#validateRawProbe(this.#addon.projectWindowsChromiumInputHwnd(
        Buffer.from(surfaceHandle),
        Buffer.from(parentHandle),
        visible
      ));
    } catch {
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_PROJECTION_FAILED",
        "Win32 did not apply the exact Chromium child presentation projection."
      );
    }
  }

  #validateRawProbe(
    raw: RawWindowsChromiumInputHwndProbeReceipt
  ): RawWindowsChromiumInputHwndProbeReceipt {
    if (!raw || raw.abiVersion !== WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION ||
      !HANDLE_TOKEN_PATTERN.test(raw.surfaceHandleToken) ||
      !HANDLE_TOKEN_PATTERN.test(raw.parentHandleToken) ||
      !HANDLE_TOKEN_PATTERN.test(raw.focusIdentity) ||
      raw.surfaceHandleToken === raw.parentHandleToken ||
      !Number.isSafeInteger(raw.processId) || raw.processId < 1 ||
      !Number.isSafeInteger(raw.uiThreadId) || raw.uiThreadId < 1 ||
      raw.parentUiThreadId !== raw.uiThreadId ||
      raw.currentProcessOwned !== true || raw.exactParent !== true ||
      raw.childWindowStyle !== true || raw.popupWindowStyleAbsent !== true ||
      raw.noActivateStyle !== true || raw.foregroundWindowPreserved !== true ||
      raw.activeWindowPreserved !== true || raw.focusWindowPreserved !== true ||
      typeof raw.parentWasForeground !== "boolean" ||
      typeof raw.parentVisible !== "boolean" ||
      typeof raw.surfaceVisible !== "boolean" ||
      typeof raw.targetWasForeground !== "boolean" ||
      typeof raw.targetHadThreadFocus !== "boolean" ||
      !Number.isSafeInteger(raw.clientWidth) || raw.clientWidth < 1 ||
      !Number.isSafeInteger(raw.clientHeight) || raw.clientHeight < 1 ||
      !Number.isSafeInteger(raw.dpi) || raw.dpi < 48 || raw.dpi > 768) {
      fail(
        "ELECTRON_WINDOWS_INPUT_NATIVE_PROBE_INVALID",
        "Win32 did not prove the exact no-activate child HWND and focus state."
      );
    }
    return Object.freeze({ ...raw });
  }

  #requireProbeMatchesParent(
    parent: WindowsChromiumInputBaseWindowPort,
    probe: RawWindowsChromiumInputHwndProbeReceipt
  ): void {
    const bounds = parent.getContentBounds();
    const deviceScale = probe.dpi / 96;
    const physicalWidth = Math.round(bounds.width * deviceScale);
    const physicalHeight = Math.round(bounds.height * deviceScale);
    if (!validBounds(bounds) || !Number.isSafeInteger(physicalWidth) ||
      !Number.isSafeInteger(physicalHeight) || physicalWidth < 1 ||
      physicalHeight < 1 || probe.clientWidth !== physicalWidth ||
      probe.clientHeight !== physicalHeight) {
      fail(
        "ELECTRON_WINDOWS_INPUT_NATIVE_BOUNDS_MISMATCH",
        "The Win32 child pixels do not match the DPI-scaled runtime-parent client bounds."
      );
    }
  }

  #requireParentBinding(
    parent: ChromiumRoleSurfaceParentPort
  ): WindowsChromiumInputRuntimeParentBinding {
    const binding = this.#parents.resolve(parent);
    if (!binding || binding.logicalParent !== parent || binding.window.isDestroyed()) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_UNAVAILABLE",
        "The logical runtime window has no exact live native parent binding."
      );
    }
    validateGeneration(binding.identity.nativeGeneration, "runtime parent");
    if (!canonicalPositiveU64(binding.identity.ownerRevision)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_PARENT_IDENTITY_INVALID",
        "The runtime parent does not carry a canonical owner revision."
      );
    }
    return binding;
  }

  #sameParentBinding(
    left: WindowsChromiumInputRuntimeParentBinding,
    right: WindowsChromiumInputRuntimeParentBinding
  ): boolean {
    return left.window === right.window &&
      left.identity.nativeGeneration === right.identity.nativeGeneration &&
      left.identity.ownerRevision === right.identity.ownerRevision;
  }

  #requireRecord(
    roleId: string,
    generation: number,
    allowProjectionStale = false
  ): SurfaceRecord {
    validateGeneration(generation, "role surface");
    const record = this.#recordsByRole.get(roleId);
    if (!record || record.surfaceGeneration !== generation ||
      record.closing || record.quarantined ||
      (!allowProjectionStale && record.projectionStale)) {
      fail(
        "ELECTRON_WINDOWS_INPUT_HOST_UNAVAILABLE",
        "The role no longer owns the exact Win32 child input host."
      );
    }
    return record;
  }

  #requireSingleView(
    child: WindowsChromiumInputBaseWindowPort,
    view: ChromiumRoleWebContentsViewPort
  ): void {
    const children = child.contentView.children;
    if (children.length !== 1 || children[0] !== view) {
      fail(
        "ELECTRON_WINDOWS_INPUT_SURFACE_ALIAS",
        "The dedicated input child must own exactly one expected WebContentsView."
      );
    }
  }

  #requireNoViews(child: WindowsChromiumInputBaseWindowPort): void {
    if (child.contentView.children.length !== 0) {
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_NOT_EMPTY",
        "The input child retained a WebContentsView after exact detach."
      );
    }
  }

  #subscribe(record: SurfaceRecord): void {
    for (const event of HOST_EVENTS) {
      record.parentBinding.window.on(event, record.parentEventListener);
    }
    record.parentBinding.window.on("closed", record.parentEventListener);
    record.child.on("closed", record.childClosedListener);
  }

  #unsubscribe(record: SurfaceRecord): void {
    for (const event of HOST_EVENTS) {
      record.parentBinding.window.removeListener(event, record.parentEventListener);
    }
    record.parentBinding.window.removeListener("closed", record.parentEventListener);
    record.child.removeListener("closed", record.childClosedListener);
  }

  #onParentProjection(record: SurfaceRecord): void {
    if (record.closing || record.projectionStale || record.quarantined ||
      this.#disposed) return;
    try {
      if (record.parentBinding.window.isDestroyed()) {
        fail(
          "ELECTRON_WINDOWS_INPUT_PARENT_CLOSED",
          "The runtime parent closed before its child input host retired."
        );
      }
      this.#synchronizePresentation(record);
      this.#completeFocusIfReady(record);
    } catch (error) {
      const bridge = error instanceof RionBridgeError ? error : attachmentError(
        "ELECTRON_WINDOWS_INPUT_PARENT_EVENT_FAILED",
        "The child host could not apply an exact parent projection event."
      );
      if (bridge.code === "ELECTRON_WINDOWS_INPUT_CHILD_PROJECTION_FAILED" ||
        bridge.code === "ELECTRON_WINDOWS_INPUT_NATIVE_BOUNDS_MISMATCH" ||
        bridge.code === "ELECTRON_WINDOWS_INPUT_PARENT_BOUNDS_INVALID") {
        this.#markProjectionStale(record, bridge);
        return;
      }
      this.#quarantine(record, bridge);
    }
  }

  #markProjectionStale(record: SurfaceRecord, error: RionBridgeError): void {
    record.projectionStale = true;
    this.#cancelFocus(
      record,
      "BROWSER_ACTION_STALE",
      "The foreground input host lost its exact presentation projection."
    );
    this.#onError(error);
  }

  #onChildClosed(record: SurfaceRecord): void {
    if (record.closing || this.#disposed) return;
    this.#quarantine(record, attachmentError(
      "ELECTRON_WINDOWS_INPUT_CHILD_CLOSED",
      "The dedicated Win32 input child closed outside exact retirement."
    ));
  }

  #quarantine(record: SurfaceRecord, error: RionBridgeError): void {
    if (record.quarantined) return;
    record.quarantined = true;
    this.#cancelFocus(
      record,
      "BROWSER_ACTION_STALE",
      "The foreground input host was quarantined before focus acknowledgement."
    );
    this.#unsubscribe(record);
    try {
      if (!record.child.isDestroyed()) record.child.hide();
    } catch {
      // Quarantine remains fail-closed even when visibility is unknown.
    }
    this.#onError(error);
  }

  #rollbackStaged(
    child: WindowsChromiumInputBaseWindowPort,
    detach: (() => void) | null
  ): void {
    let failed = false;
    if (detach) {
      try {
        detach();
      } catch {
        failed = true;
      }
    }
    try {
      if (!child.isDestroyed()) {
        child.hide();
        child.destroy();
      }
      if (!child.isDestroyed()) failed = true;
    } catch {
      failed = true;
    }
    if (failed) {
      fail(
        "ELECTRON_WINDOWS_INPUT_ATTACH_ROLLBACK_FAILED",
        "The failed child-HWND attachment could not establish exact rollback."
      );
    }
  }

  #closeEmptyChild(child: WindowsChromiumInputBaseWindowPort): void {
    this.#requireNoViews(child);
    if (child.isDestroyed()) return;
    child.hide();
    child.destroy();
    if (!child.isDestroyed()) {
      fail(
        "ELECTRON_WINDOWS_INPUT_CHILD_CLOSE_UNKNOWN",
        "Electron did not acknowledge the empty input child close."
      );
    }
  }

  #deleteExact(record: SurfaceRecord): void {
    if (this.#recordsByRole.get(record.roleId) === record) {
      this.#recordsByRole.delete(record.roleId);
    }
  }

  #nextGeneration(): number {
    if (this.#nextNativeGeneration >= Number.MAX_SAFE_INTEGER) {
      fail(
        "ELECTRON_WINDOWS_INPUT_GENERATION_EXHAUSTED",
        "The child-HWND native generation was exhausted."
      );
    }
    this.#nextNativeGeneration += 1;
    return this.#nextNativeGeneration;
  }

  #revision(): string {
    if (this.#nextRevision >= 18_446_744_073_709_551_615n) {
      fail(
        "ELECTRON_WINDOWS_INPUT_REVISION_EXHAUSTED",
        "The child-HWND binding revision was exhausted."
      );
    }
    this.#nextRevision += 1n;
    return this.#nextRevision.toString();
  }
}
