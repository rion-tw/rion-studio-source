import { parseTrustedInputDomReceipt, matchesTrustedInputExpectedEvent as sameExpected } from
  "./chromiumTrustedInputDomReceipt";
import { ChromiumTrustedInputPendingLane, sameTrustedInputFrame as sameFrame } from
  "./chromiumTrustedInputPendingLane";
import { randomUUID } from "node:crypto";

import type { BrowserAction } from "../../shared/generated";
import {
  CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
  type ChromiumRoleTrustedInputArmEnvelope,
  type ChromiumRoleTrustedInputCancelEnvelope,
  type ChromiumRoleTrustedInputExpectedEvent,
  type ChromiumRoleTrustedInputReceipt
} from "../ipc/chromiumRoleTrustedInputProtocol";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumNativeTrustedInputPort,
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "./chromiumTrustedInputCoordinator";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "./chromiumRoleSurfaceRegistry";
import type { AppKitRuntimeHostIdentity } from "./macosAppKitRuntimeHostFactory";

const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const MACOS_APPKIT_TRUSTED_KEY_CODES = Object.freeze([
  "Backquote",
  "Backspace",
  "Tab",
  "Escape",
  "Insert",
  "Home",
  "PageUp",
  "Delete",
  "End",
  "PageDown",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Equal",
  "Minus",
  "Space",
  "Backslash",
  "Slash",
  "Period",
  "Comma",
  "Semicolon",
  "Quote",
  "BracketLeft",
  "BracketRight",
  "Enter",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20"
] as const);

const MACOS_APPKIT_TRUSTED_KEY_CODE_SET = new Set<string>(
  MACOS_APPKIT_TRUSTED_KEY_CODES
);

interface AppKitNativeSubmissionBase {
  readonly status: "submitted";
  readonly requestId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly inputEpoch: string;
  readonly nativeGeneration: number;
  readonly dispatchSequence: string;
  readonly submittedAtMs: string;
  readonly withinDeadline: boolean;
  readonly dispatchedEventCount: number;
  readonly modifierFlags: number;
  readonly targetAttached: boolean;
  readonly focusNeutral: boolean;
  readonly keyWindowPreserved: boolean;
  readonly keyWindowFirstResponderPreserved: boolean;
  readonly targetFirstResponderPreserved: boolean;
  readonly targetX: number;
  readonly targetY: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

export interface AppKitNativeKeySubmissionReceipt
  extends AppKitNativeSubmissionBase {
  readonly eventType: "keyDown" | "keyUp";
  readonly code: string;
  readonly virtualKeyCode: number;
}

export interface AppKitNativeMouseSubmissionReceipt
  extends AppKitNativeSubmissionBase {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly zoomFactor: number;
  readonly appKitPointX: number;
  readonly appKitPointY: number;
  readonly windowPointX: number;
  readonly windowPointY: number;
  readonly targetFlipped: boolean;
}

export interface RawNativeAppKitTrustedInputHost {
  submitNativeBackgroundKey: (
    expected: AppKitRuntimeHostIdentity,
    request: Readonly<{
      requestId: string;
      roleId: string;
      surfaceGeneration: number;
      inputEpoch: string;
      deadlineMs: string;
      eventType: "keyDown" | "keyUp";
      code: string;
      modifierFlags: number;
      repeat: boolean;
    }>
  ) => AppKitNativeKeySubmissionReceipt;
  submitNativeBackgroundMouse: (
    expected: AppKitRuntimeHostIdentity,
    request: Readonly<{
      requestId: string;
      roleId: string;
      surfaceGeneration: number;
      inputEpoch: string;
      deadlineMs: string;
      clientX: number;
      clientY: number;
      zoomFactor: number;
      button: number;
      modifierFlags: number;
    }>
  ) => AppKitNativeMouseSubmissionReceipt;
}

export function isRawNativeAppKitTrustedInputHost(
  value: unknown
): value is RawNativeAppKitTrustedInputHost {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.submitNativeBackgroundKey === "function" &&
    typeof candidate.submitNativeBackgroundMouse === "function";
}

export interface MacosAppKitTrustedInputHostBinding {
  readonly identity: AppKitRuntimeHostIdentity;
  readonly native: RawNativeAppKitTrustedInputHost;
}

export interface MacosAppKitTrustedInputHostPort {
  resolve: (
    roleId: string,
    generation: number
  ) => MacosAppKitTrustedInputHostBinding | null;
}

export interface MacosAppKitTrustedInputSurfacePort {
  authorizeTrustedInputFrame: (
    sender: unknown,
    senderFrame: unknown,
    claimedFrameToken: unknown
  ) => ChromiumRoleOverlayFrameIdentity;
  currentTrustedInputFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
  sendTrustedInputControl: (
    expected: ChromiumRoleOverlayFrameIdentity,
    control: ChromiumRoleTrustedInputArmEnvelope | ChromiumRoleTrustedInputCancelEnvelope
  ) => void;
  subscribeTrustedInputLifecycle: (
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ) => () => void;
}

export interface MacosAppKitTrustedInputClickResolverPort {
  resolve: (
    request: ChromiumNativeTrustedInputRequest,
    frame: ChromiumRoleOverlayFrameIdentity
  ) => Readonly<{ clientX: number; clientY: number; zoomFactor: number }>;
}

export interface MacosAppKitTrustedInputIpcEventPort {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface MacosAppKitTrustedInputIpcMainPort {
  on: (
    channel: string,
    listener: (event: MacosAppKitTrustedInputIpcEventPort, receipt: unknown) => void
  ) => unknown;
  removeListener: (
    channel: string,
    listener: (event: MacosAppKitTrustedInputIpcEventPort, receipt: unknown) => void
  ) => unknown;
}

export interface MacosAppKitTrustedInputTimerPort {
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

type NativeTransition =
  | Readonly<{ type: "key"; eventType: "keyDown" | "keyUp"; code: string }>
  | Readonly<{
    type: "mouse";
    clientX: number;
    clientY: number;
    zoomFactor: number;
    button: number;
  }>;

interface PendingDispatch {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly host: MacosAppKitTrustedInputHostBinding;
  readonly inputSequence: string;
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  readonly nativeTransitions: readonly NativeTransition[];
  readonly completion: Deferred<ChromiumNativeTrustedInputReceipt>;
  timer: unknown;
  nativeInvoked: boolean;
  nativeSubmitted: number;
  nextDomIndex: number;
  nativeComplete: boolean;
  terminal: boolean;
  lastNativeDispatchSequence: bigint;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function inputError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw inputError(code, message);
}


function sameHost(
  left: MacosAppKitTrustedInputHostBinding,
  right: MacosAppKitTrustedInputHostBinding
): boolean {
  return left.native === right.native &&
    left.identity.logicalWindowId === right.identity.logicalWindowId &&
    left.identity.launchGeneration === right.identity.launchGeneration &&
    left.identity.nativeGeneration === right.identity.nativeGeneration;
}

function modifierFlags(action: Extract<BrowserAction, { type: "key" }>): number {
  let flags = 0;
  for (const modifier of action.modifiers) {
    if (modifier === "shift") flags |= 1 << 17;
    if (modifier === "ctrl") flags |= 1 << 18;
    if (modifier === "alt") flags |= 1 << 19;
    if (modifier === "meta" || modifier === "primary") flags |= 1 << 20;
  }
  return flags;
}

function nativeKeyModifierFlags(code: string, flags: number): number {
  return /^F(?:[1-9]|[12][0-9]|3[0-5])$/u.test(code) ||
    code.startsWith("Arrow") ||
    ["Insert", "Delete", "Home", "End", "PageUp", "PageDown"].includes(code)
    ? flags | (1 << 23)
    : flags;
}

function modifiers(action: BrowserAction): Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}> {
  const values = action.type === "key" ? new Set(action.modifiers) : new Set<string>();
  return Object.freeze({
    altKey: values.has("alt"),
    ctrlKey: values.has("ctrl"),
    metaKey: values.has("meta") || values.has("primary"),
    shiftKey: values.has("shift")
  });
}

function keyEvent(
  type: "keydown" | "keyup",
  code: string,
  action: BrowserAction
): ChromiumRoleTrustedInputExpectedEvent {
  return Object.freeze({
    type,
    code,
    button: null,
    clientX: null,
    clientY: null,
    ...modifiers(action),
    repeat: false
  });
}

function mouseEvent(
  type: "mousedown" | "mouseup" | "click" | "auxclick",
  clientX: number | null,
  clientY: number | null,
  button: number
): ChromiumRoleTrustedInputExpectedEvent {
  return Object.freeze({
    type,
    code: null,
    button,
    clientX,
    clientY,
    ...modifiers({ type: "focus" }),
    repeat: false
  });
}

function prepareDispatch(
  request: ChromiumNativeTrustedInputRequest,
  frame: ChromiumRoleOverlayFrameIdentity,
  clicks: MacosAppKitTrustedInputClickResolverPort
): Readonly<{
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  nativeTransitions: readonly NativeTransition[];
}> {
  const action = request.action;
  if (action.type === "focus") {
    fail(
      "SYSTEM_TRUSTED_INPUT_FOCUS_UNAVAILABLE",
      "AppKit trusted input does not synthesize focus evidence."
    );
  }
  if (action.type === "key") {
    if (!action.code) {
      fail(
        "SYSTEM_TRUSTED_INPUT_CODE_REQUIRED",
        "AppKit trusted key input requires an exact DOM code."
      );
    }
    if (!MACOS_APPKIT_TRUSTED_KEY_CODE_SET.has(action.code)) {
      fail(
        "SYSTEM_TRUSTED_INPUT_CODE_UNSUPPORTED",
        "The DOM code has no stable AppKit virtual-key mapping."
      );
    }
    const down = action.phase !== "release";
    const up = action.phase !== "hold";
    return Object.freeze({
      expectedEvents: Object.freeze([
        ...(down ? [keyEvent("keydown", action.code, action)] : []),
        ...(up ? [keyEvent("keyup", action.code, action)] : [])
      ]),
      nativeTransitions: Object.freeze([
        ...(down ? [{ type: "key" as const, eventType: "keyDown" as const,
          code: action.code }] : []),
        ...(up ? [{ type: "key" as const, eventType: "keyUp" as const,
          code: action.code }] : [])
      ])
    });
  }
  const point = clicks.resolve(request, frame);
  if (
    !Number.isSafeInteger(point.clientX) || point.clientX < 0 ||
    !Number.isSafeInteger(point.clientY) || point.clientY < 0 ||
    !Number.isFinite(point.zoomFactor) ||
    point.zoomFactor < 0.25 || point.zoomFactor > 5
  ) {
    fail(
      "SYSTEM_TRUSTED_INPUT_COORDINATE_INVALID",
      "The AppKit click resolver returned invalid Chromium CSS coordinates or zoom."
    );
  }
  const button = action.button === "left" ? 0 : action.button === "middle" ? 1 : 2;
  const activationEvent = button === 0 ? "click" : "auxclick";
  return Object.freeze({
    expectedEvents: Object.freeze([
      mouseEvent("mousedown", null, null, button),
      mouseEvent("mouseup", null, null, button),
      mouseEvent(activationEvent, null, null, button)
    ]),
    nativeTransitions: Object.freeze([Object.freeze({
      type: "mouse" as const,
      clientX: point.clientX,
      clientY: point.clientY,
      zoomFactor: point.zoomFactor,
      button
    })])
  });
}

function parseReceipt(value: unknown): ChromiumRoleTrustedInputReceipt {
  return parseTrustedInputDomReceipt(value, (message) => fail("ELECTRON_MACOS_APPKIT_INPUT_RECEIPT_INVALID", message));
}

function canonicalU64(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function validBounds(receipt: AppKitNativeSubmissionBase): boolean {
  return [receipt.targetX, receipt.targetY, receipt.targetWidth, receipt.targetHeight]
    .every(Number.isFinite) && receipt.targetWidth > 0 && receipt.targetHeight > 0;
}

function validateNativeBase(
  pending: PendingDispatch,
  receipt: AppKitNativeSubmissionBase,
  nativeRequestId: string,
  expectedEventCount: number,
  expectedModifierFlags: number
): bigint {
  const dispatchSequence = canonicalU64(receipt.dispatchSequence);
  const submittedAt = canonicalU64(receipt.submittedAtMs);
  if (
    receipt.status !== "submitted" || receipt.requestId !== nativeRequestId ||
    receipt.roleId !== pending.request.roleId ||
    receipt.surfaceGeneration !== pending.request.surfaceGeneration ||
    receipt.inputEpoch !== String(pending.request.inputEpoch) ||
    receipt.nativeGeneration !== pending.host.identity.nativeGeneration ||
    !dispatchSequence || dispatchSequence <= pending.lastNativeDispatchSequence ||
    !submittedAt || submittedAt >= BigInt(pending.request.deadlineMs) ||
    receipt.withinDeadline !== true ||
    receipt.dispatchedEventCount !== expectedEventCount ||
    receipt.modifierFlags !== expectedModifierFlags ||
    receipt.targetAttached !== true || receipt.focusNeutral !== true ||
    receipt.keyWindowPreserved !== true ||
    receipt.keyWindowFirstResponderPreserved !== true ||
    receipt.targetFirstResponderPreserved !== true || !validBounds(receipt)
  ) {
    fail(
      "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
      "The AppKit host returned a malformed or mismatched native submission receipt."
    );
  }
  return dispatchSequence;
}

/**
 * Correlates AppKit-native submission with exact trusted DOM receipts from the
 * sandboxed role preload. Native return values are never terminal success.
 */
export class MacosAppKitTrustedInputAdapter
implements ChromiumNativeTrustedInputPort {
  readonly #hosts: MacosAppKitTrustedInputHostPort;
  readonly #surfaces: MacosAppKitTrustedInputSurfacePort;
  readonly #clicks: MacosAppKitTrustedInputClickResolverPort;
  readonly #nowMs: () => number;
  readonly #timers: MacosAppKitTrustedInputTimerPort;
  readonly #createInputSequence: () => string;
  readonly #pending: ChromiumTrustedInputPendingLane<PendingDispatch>;
  readonly #unsubscribeLifecycle: () => void;
  readonly #ipcListener = (
    event: MacosAppKitTrustedInputIpcEventPort,
    receipt: unknown
  ): void => {
    try {
      this.receive(event, receipt);
    } catch {
      // Malformed or forged IPC never mutates an in-flight lane. The deadline
      // or exact native lifecycle remains its authoritative terminal path.
    }
  };
  #ipcMain: MacosAppKitTrustedInputIpcMainPort | null = null;
  #disposed = false;

  constructor(input: Readonly<{
    hosts: MacosAppKitTrustedInputHostPort;
    surfaces: MacosAppKitTrustedInputSurfacePort;
    clicks: MacosAppKitTrustedInputClickResolverPort;
    nowMs: () => number;
    timers?: MacosAppKitTrustedInputTimerPort;
    createInputSequence?: () => string;
  }>) {
    this.#hosts = input.hosts;
    this.#surfaces = input.surfaces;
    this.#clicks = input.clicks;
    this.#nowMs = input.nowMs;
    this.#timers = input.timers ?? {
      // event-topology-exception: macos-appkit-trusted-input-dom-receipt-deadline
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
    this.#createInputSequence = input.createInputSequence ?? randomUUID;
    this.#pending = new ChromiumTrustedInputPendingLane({
      nowMs: this.#nowMs,
      cancelDeadline: (handle) => this.#timers.cancel(handle),
      sendCancel: (frame, envelope) => this.#surfaces.sendTrustedInputControl(frame, envelope)
    });
    this.#unsubscribeLifecycle = this.#surfaces.subscribeTrustedInputLifecycle(
      (event) => this.#onSurfaceLifecycle(event)
    );
  }

  register(ipcMain: MacosAppKitTrustedInputIpcMainPort): void {
    if (this.#disposed || this.#ipcMain) {
      fail(
        "ELECTRON_MACOS_APPKIT_INPUT_REGISTRATION_CONFLICT",
        "The AppKit trusted-input receipt lane cannot be registered twice."
      );
    }
    ipcMain.on(CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL, this.#ipcListener);
    this.#ipcMain = ipcMain;
  }

  dispatch(
    request: ChromiumNativeTrustedInputRequest
  ): Promise<ChromiumNativeTrustedInputReceipt> {
    if (this.#disposed || !this.#ipcMain) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "ELECTRON_MACOS_APPKIT_INPUT_UNAVAILABLE",
        "The AppKit trusted-input receipt lane is unavailable."
      ));
    }
    if (this.#pending.busy(request.roleId, request.requestId)) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "ELECTRON_MACOS_APPKIT_INPUT_LANE_BUSY",
        "The role already has one exact trusted-input request in flight."
      ));
    }
    let frame: ChromiumRoleOverlayFrameIdentity;
    let host: MacosAppKitTrustedInputHostBinding | null;
    let prepared: ReturnType<typeof prepareDispatch>;
    try {
      frame = this.#surfaces.currentTrustedInputFrame(
        request.roleId,
        request.surfaceGeneration
      );
      host = this.#hosts.resolve(request.roleId, request.surfaceGeneration);
      if (!host) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_HOST_UNAVAILABLE",
          "The role has no exact live AppKit trusted-input host."
        );
      }
      if (request.action.type === "focus") {
        const observedAtMs = this.#nowMs();
        const liveFrame = this.#surfaces.currentTrustedInputFrame(
          request.roleId,
          request.surfaceGeneration
        );
        const liveHost = this.#hosts.resolve(
          request.roleId,
          request.surfaceGeneration
        );
        if (
          !Number.isSafeInteger(observedAtMs) || observedAtMs < 1 ||
          observedAtMs >= request.deadlineMs
        ) {
          fail(
            "BROWSER_ACTION_DEADLINE",
            "The trusted-input readiness deadline expired before observation."
          );
        }
        if (!sameFrame(liveFrame, frame) || !liveHost || !sameHost(liveHost, host)) {
          fail(
            "BROWSER_ACTION_STALE",
            "The Chromium document or AppKit input host changed during readiness observation."
          );
        }
        return Promise.resolve(this.#immediateApplied(request, observedAtMs));
      }
      prepared = prepareDispatch(request, frame, this.#clicks);
    } catch (error) {
      const bridge = error instanceof RionBridgeError ? error : inputError(
        "ELECTRON_MACOS_APPKIT_INPUT_PREPARE_FAILED",
        "The AppKit trusted-input request could not be prepared."
      );
      return Promise.resolve(this.#immediateFailure(request, bridge.code, bridge.message));
    }
    const inputSequence = this.#createInputSequence();
    if (!INPUT_SEQUENCE_PATTERN.test(inputSequence)) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "ELECTRON_MACOS_APPKIT_INPUT_SEQUENCE_INVALID",
        "The AppKit trusted-input sequence generator returned an invalid identity."
      ));
    }
    const now = this.#nowMs();
    if (!Number.isSafeInteger(now) || now < 1 || now >= request.deadlineMs) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "BROWSER_ACTION_DEADLINE",
        "The trusted-input deadline expired before preload arming."
      ));
    }
    const completion = deferred<ChromiumNativeTrustedInputReceipt>();
    const pending: PendingDispatch = {
      request,
      frame,
      host,
      inputSequence,
      expectedEvents: prepared.expectedEvents,
      nativeTransitions: prepared.nativeTransitions,
      completion,
      timer: undefined,
      nativeInvoked: false,
      nativeSubmitted: 0,
      nextDomIndex: 0,
      nativeComplete: false,
      terminal: false,
      lastNativeDispatchSequence: 0n
    };
    if (!this.#pending.add(pending)) {
      return Promise.resolve(this.#immediateFailure(request,
        "ELECTRON_MACOS_APPKIT_INPUT_LANE_BUSY", "The role already has one exact trusted-input request in flight."));
    }
    pending.timer = this.#timers.schedule(() => {
      this.#terminalize(
        pending,
        "indeterminate",
        "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE",
        "The authoritative trusted DOM receipt did not arrive before the Core deadline.",
        false
      );
    }, request.deadlineMs - now);
    try {
      this.#surfaces.sendTrustedInputControl(frame, Object.freeze({
        kind: "arm",
        roleId: request.roleId,
        generation: request.surfaceGeneration,
        frameToken: frame.frameToken,
        inputSequence,
        expectedEvents: pending.expectedEvents,
        shortcutSuppression: request.action.type === "key" &&
          request.action.suppressOverlayShortcut
          ? Object.freeze({
              code: request.action.code!,
              phases: Object.freeze(pending.expectedEvents.map((event) =>
                event.type as "keydown" | "keyup"))
            })
          : null
      }));
    } catch {
      this.#terminalize(
        pending,
        "failed",
        "ELECTRON_MACOS_APPKIT_INPUT_ARM_FAILED",
        "The exact role preload rejected trusted-input arming.",
        request.expectedInputNeutralityBefore
      );
    }
    return completion.promise;
  }

  receive(event: MacosAppKitTrustedInputIpcEventPort, rawReceipt: unknown): boolean {
    if (this.#disposed) return false;
    const receipt = parseReceipt(rawReceipt);
    const identity = this.#surfaces.authorizeTrustedInputFrame(
      event.sender,
      event.senderFrame,
      receipt.frameToken
    );
    const pending = this.#pending.forRole(identity.roleId);
    if (!pending || pending.terminal || !sameFrame(identity, pending.frame) ||
      receipt.roleId !== pending.request.roleId ||
      receipt.generation !== pending.request.surfaceGeneration ||
      receipt.inputSequence !== pending.inputSequence) {
      return false;
    }
    if (receipt.kind === "armed") {
      if (receipt.expectedEventCount !== pending.expectedEvents.length ||
        pending.nativeSubmitted > 0 || pending.nativeComplete) {
        this.#terminalizeMismatch(pending);
        return false;
      }
      this.#submitNative(pending);
      return true;
    }
    if (receipt.kind === "rejected") {
      this.#terminalize(
        pending,
        "failed",
        "ELECTRON_MACOS_APPKIT_INPUT_ARM_REJECTED",
        "The exact role preload rejected trusted-input arming.",
        pending.request.expectedInputNeutralityBefore
      );
      return true;
    }
    if (receipt.kind !== "input" || pending.nativeSubmitted === 0 ||
      receipt.observedIndex !== pending.nextDomIndex ||
      !sameExpected(receipt, pending.expectedEvents[pending.nextDomIndex]!)) {
      this.#terminalizeMismatch(pending);
      return false;
    }
    pending.nextDomIndex += 1;
    this.#maybeApply(pending);
    return true;
  }

  cancel(requestId: string): boolean {
    const pending = this.#pending.forRequest(requestId);
    if (!pending || pending.terminal) return false;
    this.#terminalize(
      pending,
      pending.nativeInvoked ? "indeterminate" : "superseded",
      pending.nativeInvoked
        ? "SYSTEM_TRUSTED_INPUT_CANCELLED_AFTER_SUBMISSION"
        : "BROWSER_ACTION_STALE",
      pending.nativeInvoked
        ? "The trusted-input request was cancelled after native invocation."
        : "The trusted-input request was cancelled before native submission.",
      !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
    );
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeLifecycle();
    if (this.#ipcMain) {
      this.#ipcMain.removeListener(
        CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
        this.#ipcListener
      );
      this.#ipcMain = null;
    }
    for (const pending of this.#pending.values()) {
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "superseded",
        "SYSTEM_TRUSTED_INPUT_ADAPTER_DISPOSED",
        "The AppKit trusted-input adapter disposed before exact completion.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }
  }

  #submitNative(pending: PendingDispatch): void {
    const liveFrame = this.#surfaces.currentTrustedInputFrame(
      pending.request.roleId,
      pending.request.surfaceGeneration
    );
    const liveHost = this.#hosts.resolve(
      pending.request.roleId,
      pending.request.surfaceGeneration
    );
    if (!sameFrame(liveFrame, pending.frame) || !liveHost ||
      !sameHost(liveHost, pending.host)) {
      this.#terminalize(
        pending,
        "superseded",
        "BROWSER_ACTION_STALE",
        "The trusted-input frame or native host was superseded before submission.",
        pending.request.expectedInputNeutralityBefore
      );
      return;
    }
    const action = pending.request.action;
    const flags = action.type === "key" ? modifierFlags(action) : 0;
    try {
      for (const [index, transition] of pending.nativeTransitions.entries()) {
        if (pending.terminal) return;
        const nativeRequestId = `${pending.inputSequence}-${index + 1}`;
        if (transition.type === "key") {
          pending.nativeInvoked = true;
          const receipt = pending.host.native.submitNativeBackgroundKey(
            pending.host.identity,
            {
              requestId: nativeRequestId,
              roleId: pending.request.roleId,
              surfaceGeneration: pending.request.surfaceGeneration,
              inputEpoch: String(pending.request.inputEpoch),
              deadlineMs: String(pending.request.deadlineMs),
              eventType: transition.eventType,
              code: transition.code,
              modifierFlags: flags,
              repeat: false
            }
          );
          pending.lastNativeDispatchSequence = validateNativeBase(
            pending,
            receipt,
            nativeRequestId,
            1,
            nativeKeyModifierFlags(transition.code, flags)
          );
          if (receipt.eventType !== transition.eventType ||
            receipt.code !== transition.code ||
            !Number.isSafeInteger(receipt.virtualKeyCode)) {
            fail(
              "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
              "The AppKit key receipt does not match the exact transition."
            );
          }
        } else {
          pending.nativeInvoked = true;
          const receipt = pending.host.native.submitNativeBackgroundMouse(
            pending.host.identity,
            {
              requestId: nativeRequestId,
              roleId: pending.request.roleId,
              surfaceGeneration: pending.request.surfaceGeneration,
              inputEpoch: String(pending.request.inputEpoch),
              deadlineMs: String(pending.request.deadlineMs),
              clientX: transition.clientX,
              clientY: transition.clientY,
              zoomFactor: transition.zoomFactor,
              button: transition.button,
              modifierFlags: 0
            }
          );
          pending.lastNativeDispatchSequence = validateNativeBase(
            pending,
            receipt,
            nativeRequestId,
            2,
            0
          );
          const expectedAppKitPointX = receipt.targetX +
            transition.clientX * transition.zoomFactor;
          const expectedAppKitPointY = receipt.targetFlipped
            ? receipt.targetY + transition.clientY * transition.zoomFactor
            : receipt.targetY + receipt.targetHeight -
              transition.clientY * transition.zoomFactor;
          if (receipt.button !== transition.button ||
            receipt.clientX !== transition.clientX ||
            receipt.clientY !== transition.clientY ||
            receipt.zoomFactor !== transition.zoomFactor ||
            typeof receipt.targetFlipped !== "boolean" ||
            receipt.appKitPointX !== expectedAppKitPointX ||
            receipt.appKitPointY !== expectedAppKitPointY ||
            !Number.isFinite(receipt.windowPointX) ||
            !Number.isFinite(receipt.windowPointY) ||
            transition.clientX * transition.zoomFactor >= receipt.targetWidth ||
            transition.clientY * transition.zoomFactor >= receipt.targetHeight) {
            fail(
              "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
              "The AppKit mouse receipt does not match the exact CSS-to-native point."
            );
          }
          pending.expectedEvents = Object.freeze(pending.expectedEvents.map((event) =>
            mouseEvent(
              event.type as "mousedown" | "mouseup" | "click" | "auxclick",
              receipt.clientX,
              receipt.clientY,
              transition.button
            )
          ));
        }
        pending.nativeSubmitted += 1;
      }
      pending.nativeComplete = true;
      this.#maybeApply(pending);
    } catch {
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION"
          : "SYSTEM_TRUSTED_INPUT_NATIVE_SUBMISSION_FAILED",
        pending.nativeInvoked
          ? "AppKit native invocation did not return a complete exact receipt sequence."
          : "AppKit rejected input before any native transition was invoked.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }
  }

  #maybeApply(pending: PendingDispatch): void {
    this.#pending.maybeApply(pending);
  }

  #terminalizeMismatch(pending: PendingDispatch): void {
    this.#pending.mismatch(pending);
  }

  #terminalize(
    pending: PendingDispatch,
    status: ChromiumNativeTrustedInputReceipt["status"],
    errorCode: string | null,
    errorMessage: string | null,
    confirmedInputNeutrality: boolean
  ): void {
    this.#pending.finish(pending, status, errorCode, errorMessage, confirmedInputNeutrality);
  }

  #immediateFailure(
    request: ChromiumNativeTrustedInputRequest,
    errorCode: string,
    errorMessage: string
  ): ChromiumNativeTrustedInputReceipt {
    return Object.freeze({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: request.surfaceGeneration,
      status: "failed",
      completedAtMs: this.#nowMs(),
      errorCode,
      errorMessage,
      confirmedInputNeutrality: request.expectedInputNeutralityBefore
    });
  }

  #immediateApplied(
    request: ChromiumNativeTrustedInputRequest,
    completedAtMs: number
  ): ChromiumNativeTrustedInputReceipt {
    return Object.freeze({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: request.surfaceGeneration,
      status: "applied",
      completedAtMs,
      errorCode: null,
      errorMessage: null,
      confirmedInputNeutrality: request.expectedInputNeutralityAfter
    });
  }

  #onSurfaceLifecycle(event: ChromiumRoleOverlayLifecycleEvent): void {
    this.#pending.surfaceChanged(event);
  }
}
