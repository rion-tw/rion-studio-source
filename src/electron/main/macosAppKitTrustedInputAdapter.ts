import { createTrustedInputArmEnvelope } from "./chromiumTrustedInputArmEnvelope";
import { parseTrustedInputDomReceipt, matchesTrustedInputExpectedEvent as sameExpected } from
  "./chromiumTrustedInputDomReceipt";
import { ChromiumTrustedInputPendingLane, sameTrustedInputFrame as sameFrame } from
  "./chromiumTrustedInputPendingLane";
import { randomUUID } from "node:crypto";

import { activeChromiumModifierCodes, isChromiumModifierCode,
  resolveChromiumModifierCodes } from
  "./chromiumTrustedInputKeySequence";
import { mergeChromiumPhysicalModifiers } from
  "../ipc/chromiumTrustedInputPhysicalModifiers";
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
import type { AppKitCdpInputSurfaceProbeReceipt } from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import type {
  ChromiumCdpInputTerminalEvent,
  ChromiumCdpInputTransportPort
} from "./chromiumCdpInputTransport";

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
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft",
  "ShiftRight", "MetaLeft", "MetaRight"
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
  readonly eventType: "rawKeyDown" | "keyUp";
  readonly code: string;
  readonly virtualKeyCode: number;
  readonly repeat: boolean;
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
  probeCdpInputSurface: (
    expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number
  ) => AppKitCdpInputSurfaceProbeReceipt;
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
  | Readonly<{
    type: "key";
    eventType: "rawKeyDown" | "keyUp";
    code: string;
    repeat: boolean;
    modifierCodes: readonly string[];
  }>
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
  nativeProbe: AppKitCdpInputSurfaceProbeReceipt;
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
  physicalModifierCodes: readonly string[];
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

function validAddress(value: unknown, positive = false): boolean {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed <= 18_446_744_073_709_551_615n && (!positive || parsed > 0n);
  } catch {
    return false;
  }
}

function validateAppKitProbe(
  receipt: AppKitCdpInputSurfaceProbeReceipt,
  host: MacosAppKitTrustedInputHostBinding,
  roleId: string,
  generation: number
): AppKitCdpInputSurfaceProbeReceipt {
  const modifierCodes = new Set([
    "ControlLeft", "ControlRight", "AltLeft", "AltRight",
    "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"
  ]);
  if (receipt.roleId !== roleId || receipt.surfaceGeneration !== generation ||
    receipt.nativeGeneration !== host.identity.nativeGeneration ||
    receipt.targetAttached !== true || typeof receipt.targetWindowIsKey !== "boolean" ||
    !validAddress(receipt.keyWindowAddress) ||
    !validAddress(receipt.keyWindowFirstResponderAddress) ||
    !validAddress(receipt.targetWindowAddress, true) ||
    !validAddress(receipt.targetWindowFirstResponderAddress) ||
    !Array.isArray(receipt.physicalModifierCodes) ||
    new Set(receipt.physicalModifierCodes).size !== receipt.physicalModifierCodes.length ||
    receipt.physicalModifierCodes.some((code) => !modifierCodes.has(code)) ||
    ![receipt.targetX, receipt.targetY, receipt.targetWidth, receipt.targetHeight]
      .every(Number.isFinite) || receipt.targetWidth <= 0 || receipt.targetHeight <= 0) {
    fail(
      "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID",
      "The AppKit host returned malformed CDP input guard evidence."
    );
  }
  return Object.freeze({ ...receipt,
    physicalModifierCodes: Object.freeze([...receipt.physicalModifierCodes]) });
}

function sameAppKitFocusProof(
  left: AppKitCdpInputSurfaceProbeReceipt,
  right: AppKitCdpInputSurfaceProbeReceipt
): boolean {
  return left.targetWindowIsKey === right.targetWindowIsKey &&
    left.keyWindowAddress === right.keyWindowAddress &&
    left.keyWindowFirstResponderAddress === right.keyWindowFirstResponderAddress &&
    left.targetWindowAddress === right.targetWindowAddress &&
    left.targetWindowFirstResponderAddress === right.targetWindowFirstResponderAddress &&
    left.targetX === right.targetX && left.targetY === right.targetY &&
    left.targetWidth === right.targetWidth && left.targetHeight === right.targetHeight &&
    left.physicalModifierCodes.join("\n") === right.physicalModifierCodes.join("\n");
}

function modifiers(codes: readonly string[]): Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}> {
  const values = new Set(codes);
  return Object.freeze({
    altKey: values.has("AltLeft") || values.has("AltRight"),
    ctrlKey: values.has("ControlLeft") || values.has("ControlRight"),
    metaKey: values.has("MetaLeft") || values.has("MetaRight"),
    shiftKey: values.has("ShiftLeft") || values.has("ShiftRight")
  });
}

function keyEvent(
  type: "keydown" | "keyup",
  code: string,
  modifierCodes: readonly string[],
  repeat: boolean
): ChromiumRoleTrustedInputExpectedEvent {
  return Object.freeze({
    type,
    code,
    button: null,
    clientX: null,
    clientY: null,
    ...modifiers(modifierCodes),
    repeat
  });
}

function mouseEvent(
  type: "mousedown" | "mouseup" | "click" | "auxclick" | "contextmenu",
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
    ...modifiers([]),
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
  if (request.keyEffect) {
    const effect = request.keyEffect;
    if (!MACOS_APPKIT_TRUSTED_KEY_CODE_SET.has(effect.code)) {
      fail(
        "SYSTEM_TRUSTED_INPUT_CODE_UNSUPPORTED",
        "The DOM code has no stable AppKit virtual-key mapping."
      );
    }
    const modifierCodes = activeChromiumModifierCodes(effect, []);
    return Object.freeze({
      expectedEvents: Object.freeze([
        keyEvent(effect.phase === "rawKeyDown" ? "keydown" : "keyup",
          effect.code, modifierCodes, effect.autoRepeat)
      ]),
      nativeTransitions: Object.freeze([Object.freeze({
        type: "key" as const,
        eventType: effect.phase,
        code: effect.code,
        repeat: effect.autoRepeat,
        modifierCodes
      })])
    });
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
    const modifierCodes = resolveChromiumModifierCodes(action, "darwin");
    const down = action.phase !== "release";
    const up = action.phase !== "hold";
    return Object.freeze({
      expectedEvents: Object.freeze([
        ...(down ? [keyEvent("keydown", action.code, modifierCodes, false)] : []),
        ...(up ? [keyEvent("keyup", action.code, modifierCodes, false)] : [])
      ]),
      nativeTransitions: Object.freeze([
        ...(down ? [{ type: "key" as const, eventType: "rawKeyDown" as const,
          code: action.code, repeat: false, modifierCodes }] : []),
        ...(up ? [{ type: "key" as const, eventType: "keyUp" as const,
          code: action.code, repeat: false, modifierCodes }] : [])
      ])
    });
  }
  if (action.type === "reassertHeldKeys") {
    fail(
      "SYSTEM_TRUSTED_INPUT_CORE_TRANSITION_INVALID",
      "Held-key reassertion requires one exact Rust effect."
    );
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
  const activationEvents = button === 0 ? ["click" as const]
    : button === 1 ? ["auxclick" as const] : ["auxclick" as const];
  return Object.freeze({
    expectedEvents: Object.freeze([
      mouseEvent("mousedown", null, null, button),
      ...(button === 2 ? [mouseEvent("contextmenu", null, null, button)] : []),
      mouseEvent("mouseup", null, null, button),
      ...activationEvents.map((type) => mouseEvent(type, null, null, button))
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

/**
 * Retains AppKit host-identity admission while the shared CDP transport owns
 * submission. CDP acceptance is never terminal success; every transition is
 * correlated with an exact trusted DOM receipt from the sandboxed Role preload.
 */
export class MacosAppKitTrustedInputAdapter
implements ChromiumNativeTrustedInputPort {
  readonly #hosts: MacosAppKitTrustedInputHostPort;
  readonly #surfaces: MacosAppKitTrustedInputSurfacePort;
  readonly #clicks: MacosAppKitTrustedInputClickResolverPort;
  readonly #nowMs: () => number;
  readonly #timers: MacosAppKitTrustedInputTimerPort;
  readonly #cdp: ChromiumCdpInputTransportPort;
  readonly #createInputSequence: () => string;
  readonly #pending: ChromiumTrustedInputPendingLane<PendingDispatch>;
  readonly #unsubscribeLifecycle: () => void;
  readonly #unsubscribeCdpTerminal: () => void;
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
    cdp: ChromiumCdpInputTransportPort;
    nowMs: () => number;
    timers?: MacosAppKitTrustedInputTimerPort;
    createInputSequence?: () => string;
  }>) {
    this.#hosts = input.hosts;
    this.#surfaces = input.surfaces;
    this.#clicks = input.clicks;
    this.#cdp = input.cdp;
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
    this.#unsubscribeCdpTerminal = this.#cdp.subscribeTerminal(
      (event) => this.#onCdpTerminal(event)
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
    let nativeProbe: AppKitCdpInputSurfaceProbeReceipt;
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
      nativeProbe = validateAppKitProbe(
        host.native.probeCdpInputSurface(
          host.identity,
          request.roleId,
          request.surfaceGeneration
        ),
        host,
        request.roleId,
        request.surfaceGeneration
      );
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
      nativeProbe,
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
      physicalModifierCodes: Object.freeze([])
    };
    if (!this.#pending.add(pending)) {
      return Promise.resolve(this.#immediateFailure(request,
        "ELECTRON_MACOS_APPKIT_INPUT_LANE_BUSY", "The role already has one exact trusted-input request in flight."));
    }
    pending.timer = this.#timers.schedule(() => {
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE"
          : "ELECTRON_MACOS_APPKIT_INPUT_ARM_RECEIPT_DEADLINE",
        pending.nativeInvoked
          ? "The authoritative trusted DOM receipt did not arrive before the Core deadline."
          : "The private preload did not acknowledge arming before the Core deadline.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }, request.deadlineMs - now);
    try {
      this.#surfaces.sendTrustedInputControl(frame, createTrustedInputArmEnvelope(
        request, frame.frameToken, inputSequence, pending.expectedEvents
      ));
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
        (pending.request.action.type === "key" &&
          pending.request.action.phase === "hold" &&
          pending.request.action.modifierOwnership === "physical-pass-through" &&
          receipt.physicalModifierCodes.join("\n") !==
            (pending.request.physicalModifierCodes ?? []).join("\n")) ||
        pending.nativeSubmitted > 0 || pending.nativeComplete) {
        this.#terminalizeMismatch(pending);
        return false;
      }
      pending.physicalModifierCodes = Object.freeze([...receipt.physicalModifierCodes]);
      const projectedCode = pending.request.keyEffect?.code ??
        (pending.request.action.type === "key" ? pending.request.action.code : null);
      pending.expectedEvents = mergeChromiumPhysicalModifiers(
        pending.expectedEvents,
        pending.physicalModifierCodes,
        projectedCode
      );
      void this.#submitCdp(pending);
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
    if (receipt.kind !== "input" || !pending.nativeInvoked ||
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
    this.#unsubscribeCdpTerminal();
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

  async #submitCdp(pending: PendingDispatch): Promise<void> {
    try {
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
        throw new Error("The exact AppKit input host was superseded.");
      }
      const liveProbe = validateAppKitProbe(
        liveHost.native.probeCdpInputSurface(
          liveHost.identity,
          pending.request.roleId,
          pending.request.surfaceGeneration
        ),
        liveHost,
        pending.request.roleId,
        pending.request.surfaceGeneration
      );
      if (!sameAppKitFocusProof(liveProbe, pending.nativeProbe)) {
        throw new Error(
          "The AppKit focus or native physical modifier proof changed before CDP submission."
        );
      }
      pending.nativeProbe = liveProbe;
    } catch {
      this.#terminalize(
        pending,
        "superseded",
        "BROWSER_ACTION_STALE",
        "The trusted-input frame or native host was superseded before submission.",
        pending.request.expectedInputNeutralityBefore
      );
      return;
    }
    try {
      for (const transition of pending.nativeTransitions) {
        if (pending.terminal) return;
        if (transition.type === "key") {
          const physicalCodes = isChromiumModifierCode(transition.code)
            ? pending.physicalModifierCodes.filter(code => code !== transition.code)
            : pending.physicalModifierCodes;
          const activeCodes = Object.freeze([...new Set([
            ...transition.modifierCodes,
            ...physicalCodes,
            ...(transition.eventType === "rawKeyDown" ? [transition.code] : [])
          ])]);
          pending.nativeInvoked = true;
          const receipt = await this.#cdp.dispatchKey(pending.frame, {
            phase: transition.eventType,
            code: transition.code,
            activeCodesBefore: [...activeCodes],
            activeCodes: [...activeCodes],
            autoRepeat: transition.repeat,
            suppressShortcut: true
          });
          if (receipt.acceptedCommandCount !== 1 ||
            receipt.requiresTrustedDomReceipt !== true) {
            throw new Error("CDP did not accept the exact key command.");
          }
        } else {
          pending.nativeInvoked = true;
          pending.expectedEvents = Object.freeze(pending.expectedEvents.map(event =>
            Object.freeze({
              ...event,
              clientX: transition.clientX,
              clientY: transition.clientY
            })
          ));
          const receipt = await this.#cdp.dispatchMouse(pending.frame, {
            x: transition.clientX,
            y: transition.clientY,
            button: transition.button === 0 ? "left"
              : transition.button === 1 ? "middle" : "right",
            modifierCodes: pending.physicalModifierCodes
          });
          if (receipt.acceptedCommandCount !== 2 ||
            receipt.requiresTrustedDomReceipt !== true) {
            throw new Error("CDP did not accept the exact mouse command pair.");
          }
        }
        const afterFrame = this.#surfaces.currentTrustedInputFrame(
          pending.request.roleId,
          pending.request.surfaceGeneration
        );
        const afterHost = this.#hosts.resolve(
          pending.request.roleId,
          pending.request.surfaceGeneration
        );
        if (!sameFrame(afterFrame, pending.frame) || !afterHost ||
          !sameHost(afterHost, pending.host)) {
          throw new Error("AppKit host identity changed during CDP submission.");
        }
        const afterProbe = validateAppKitProbe(
          afterHost.native.probeCdpInputSurface(
            afterHost.identity,
            pending.request.roleId,
            pending.request.surfaceGeneration
          ),
          afterHost,
          pending.request.roleId,
          pending.request.surfaceGeneration
        );
        if (!sameAppKitFocusProof(afterProbe, pending.nativeProbe)) {
          throw new Error("AppKit focus or physical modifiers changed during CDP submission.");
        }
        pending.nativeProbe = afterProbe;
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
          ? "CDP invocation did not return a complete exact receipt sequence."
          : "CDP rejected input before any transition was invoked.",
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

  #onCdpTerminal(event: ChromiumCdpInputTerminalEvent): void {
    const pending = this.#pending.forRole(event.identity.roleId);
    if (!pending || pending.terminal ||
      pending.frame.generation !== event.identity.surfaceGeneration ||
      pending.frame.documentInstanceId !== event.identity.documentInstanceId ||
      pending.frame.frameToken !== event.identity.frameToken) return;
    this.#terminalize(
      pending,
      pending.nativeInvoked ? "indeterminate" : "superseded",
      "SYSTEM_TRUSTED_INPUT_CDP_SESSION_TERMINATED",
      `The exact CDP Input session terminalized: ${event.reason}.`,
      !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
    );
  }
}
