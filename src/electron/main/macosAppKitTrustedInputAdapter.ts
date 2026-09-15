import { ChromiumCompatibleInput, type ChromiumCompatibleInputPort } from "./chromiumCompatibleInput";
import { observeChromiumGameDelivery } from "./chromiumGameDeliveryEvidence";
import { ChromiumTrustedInputDocumentEvidence } from "./chromiumTrustedInputDocumentEvidence";
import { normalizeRionBridgeError } from "../ipc/errors";
import { createTrustedInputArmEnvelope } from "./chromiumTrustedInputArmEnvelope";
import { chromiumDomModifierMask, parseChromiumModifierProjectionObservation,
  parseTrustedInputDomReceipt } from
  "./chromiumTrustedInputDomReceipt";
import { chromiumCdpModifierMask } from "./chromiumCdpInputDescriptors";
import { reconcileChromiumTrustedInputReceipts } from
  "./chromiumTrustedInputReceiptReconciliation";
import {
  ChromiumTrustedInputPendingLane,
  recordTrustedInputTrace,
  sameTrustedInputFrame as sameFrame,
  type ChromiumPhysicalEvidenceDiagnostics
} from
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
  type ChromiumRoleTrustedInputDomReceipt,
  type ChromiumRoleTrustedInputExpectedEvent,
  type ChromiumRoleTrustedInputModifierDisposition,
  type ChromiumRoleTrustedInputReceipt
} from "../ipc/chromiumRoleTrustedInputProtocol";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumNativeTrustedInputPort,
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest,
  ChromiumTrustedInputGuardObservationIdentity
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
import { ChromiumPhysicalInputEvidenceLane } from
  "./chromiumPhysicalInputEvidence";

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
    releaseOnly: boolean;
  }>;

interface PendingDispatch {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly host: MacosAppKitTrustedInputHostBinding;
  nativeProbe: AppKitCdpInputSurfaceProbeReceipt;
  readonly inputSequence: string;
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  nativeTransitions: readonly NativeTransition[];
  readonly completion: Deferred<ChromiumNativeTrustedInputReceipt>;
  timer: unknown;
  nativeInvoked: boolean;
  cdpInvoked: boolean;
  applicationPath: "none" | "cdp" | "physical-modifier-adoption" |
    "modifier-ownership-release";
  nativeSubmitted: number;
  nextDomIndex: number;
  nextObservationSequence: number;
  observations: ChromiumRoleTrustedInputDomReceipt[];
  nativeComplete: boolean;
  queuedModifierObservations?: unknown[];
  gameDeliveryRequired?: boolean;
  gameDeliveryConfirmed?: boolean;
  documentObservationWatermark?: number;
  terminal: boolean;
  physicalModifierCodes: readonly string[];
  modifierProjectionCodes: readonly string[];
  cdpModifierMask?: number;
  lastObservedDomModifierMask?: number;
  modifierDisposition: ChromiumRoleTrustedInputModifierDisposition;
  physicalInterleave: import("./chromiumTrustedInputPendingLane")
    .ChromiumPhysicalInterleaveClassification;
  readonly physicalEvidenceDiagnostics: ChromiumPhysicalEvidenceDiagnostics;
  readonly physicalEvidence: ChromiumPhysicalInputEvidenceLane;
  nativeProofChanges?: string[];
  cdpTerminalReason?: string;
  failureStage?: string;
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
    !validAddress(receipt.physicalInputSequence) ||
    !validAddress(receipt.physicalKeyDownSequence) ||
    !validAddress(receipt.physicalKeyUpSequence) ||
    BigInt(receipt.physicalKeyDownSequence) +
      BigInt(receipt.physicalKeyUpSequence) >
      BigInt(receipt.physicalInputSequence) ||
    typeof receipt.targetReceivesPhysicalInput !== "boolean" ||
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
    left.targetReceivesPhysicalInput === right.targetReceivesPhysicalInput &&
    left.targetX === right.targetX && left.targetY === right.targetY &&
    left.targetWidth === right.targetWidth && left.targetHeight === right.targetHeight;
}

function sameAppKitStableSurface(
  left: AppKitCdpInputSurfaceProbeReceipt,
  right: AppKitCdpInputSurfaceProbeReceipt
): boolean {
  return left.roleId === right.roleId &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.nativeGeneration === right.nativeGeneration &&
    left.targetWindowAddress === right.targetWindowAddress &&
    left.targetAttached && right.targetAttached;
}

function appKitProofChanges(
  left: AppKitCdpInputSurfaceProbeReceipt,
  right: AppKitCdpInputSurfaceProbeReceipt
): string[] {
  const fields = [
    "targetWindowIsKey",
    "keyWindowAddress",
    "keyWindowFirstResponderAddress",
    "targetWindowFirstResponderAddress",
    "targetReceivesPhysicalInput",
    "targetX",
    "targetY",
    "targetWidth",
    "targetHeight"
  ] as const;
  return fields.filter(field => left[field] !== right[field]);
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
  if (action.type === "neutralizeInput") {
    fail(
      "SYSTEM_TRUSTED_INPUT_CORE_TRANSITION_INVALID",
      "Input neutralization requires one exact coordinator-owned release effect."
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
      ...(request.pointerReleaseOnly
        ? []
        : [mouseEvent("mousedown", null, null, button)]),
      ...(!request.pointerReleaseOnly && button === 2
        ? [mouseEvent("contextmenu", null, null, button)]
        : []),
      mouseEvent("mouseup", null, null, button),
      ...(request.pointerReleaseOnly
        ? []
        : activationEvents.map((type) => mouseEvent(type, null, null, button)))
    ]),
    nativeTransitions: Object.freeze([Object.freeze({
      type: "mouse" as const,
      clientX: point.clientX,
      clientY: point.clientY,
      zoomFactor: point.zoomFactor,
      button,
      releaseOnly: request.pointerReleaseOnly === true
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
  readonly #compatible: ChromiumCompatibleInput | null;
  readonly #documentEvidence = new ChromiumTrustedInputDocumentEvidence();
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
    compatibility?: ChromiumCompatibleInputPort;
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
    this.#compatible = input.compatibility ? new ChromiumCompatibleInput({
      port: input.compatibility, platform: "darwin", nowMs: this.#nowMs,
      timers: { setTimeout: this.#timers.schedule, cancel: this.#timers.cancel }
    }) : null;
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
      if (this.#compatible) {
        const originalHost = host;
        return this.#compatible.dispatch(request, frame,
          nativeProbe.physicalModifierCodes,
          request.action.type === "click" ? this.#clicks.resolve(request, frame) : null, () => {
            const currentHost = this.#hosts.resolve(request.roleId, request.surfaceGeneration);
            if (this.#disposed || !currentHost || !sameHost(currentHost, originalHost) ||
                !sameFrame(this.#surfaces.currentTrustedInputFrame(request.roleId, request.surfaceGeneration), frame))
              throw new Error("Compatible input host retired.");
            const currentProbe = validateAppKitProbe(currentHost.native.probeCdpInputSurface(
              currentHost.identity, request.roleId, request.surfaceGeneration), currentHost, request.roleId, request.surfaceGeneration);
            if (!sameAppKitStableSurface(currentProbe, nativeProbe)) throw new Error("Compatible input host changed.");
          });
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
    const modifierApplicationPossible = Boolean(
      request.keyEffect &&
      request.action.type === "key" &&
      request.action.modifierOwnership === "synthetic" &&
      isChromiumModifierCode(request.keyEffect.code) &&
      nativeProbe.physicalModifierCodes.includes(request.keyEffect.code)
    );
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
      nativeInvoked: modifierApplicationPossible,
      cdpInvoked: false,
      applicationPath: modifierApplicationPossible
        ? request.keyEffect!.phase === "rawKeyDown"
          ? "physical-modifier-adoption"
          : "modifier-ownership-release"
        : "none",
      nativeSubmitted: 0,
      nextDomIndex: 0,
      nextObservationSequence: 1,
      observations: [],
      nativeComplete: false,
      terminal: false,
      physicalModifierCodes: Object.freeze([]),
      modifierProjectionCodes: Object.freeze([]),
      modifierDisposition: "dispatch",
      physicalInterleave: "none",
      physicalEvidenceDiagnostics: {
        inputSequenceBefore: nativeProbe.physicalInputSequence,
        inputSequenceAfter: nativeProbe.physicalInputSequence,
        keyDownSequenceBefore: nativeProbe.physicalKeyDownSequence,
        keyDownSequenceAfter: nativeProbe.physicalKeyDownSequence,
        keyUpSequenceBefore: nativeProbe.physicalKeyUpSequence,
        keyUpSequenceAfter: nativeProbe.physicalKeyUpSequence
      },
      physicalEvidence: nativeProbe.physicalKeyboardEvidence ? this.#documentEvidence.begin(request.roleId, frame.frameToken, {
        sequence: nativeProbe.physicalInputSequence,
        keyboard: nativeProbe.physicalKeyboardEvidence,
        keyDownSequence: nativeProbe.physicalKeyDownSequence,
        keyUpSequence: nativeProbe.physicalKeyUpSequence,
        targetReceivesPhysicalInput: nativeProbe.targetReceivesPhysicalInput
      }) : new ChromiumPhysicalInputEvidenceLane({ sequence: nativeProbe.physicalInputSequence,
        keyDownSequence: nativeProbe.physicalKeyDownSequence, keyUpSequence: nativeProbe.physicalKeyUpSequence,
        targetReceivesPhysicalInput: nativeProbe.targetReceivesPhysicalInput })
    };
    recordTrustedInputTrace(pending, "core", "browser-action-admitted");
    if (!this.#pending.add(pending)) {
      return Promise.resolve(this.#immediateFailure(request,
        "ELECTRON_MACOS_APPKIT_INPUT_LANE_BUSY", "The role already has one exact trusted-input request in flight."));
    }
    recordTrustedInputTrace(pending, "native", "surface-proof-admitted");
    recordTrustedInputTrace(pending, "electron", "preload-arm-sent");
    pending.timer = this.#timers.schedule(() => {
      const uncertainModifierApplication = pending.nativeInvoked &&
        !pending.cdpInvoked && pending.nativeSubmitted === 0;
      pending.failureStage = uncertainModifierApplication
        ? "modifier-application-receipt"
        : pending.nativeInvoked ? "dom-receipt-deadline" : "preload-arm-deadline";
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        uncertainModifierApplication
          ? "SYSTEM_TRUSTED_INPUT_MODIFIER_APPLICATION_RECEIPT_DEADLINE"
          : pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE"
          : "ELECTRON_MACOS_APPKIT_INPUT_ARM_RECEIPT_DEADLINE",
        uncertainModifierApplication
          ? "The physical modifier ownership application receipt is uncertain."
          : pending.nativeInvoked
          ? "The authoritative trusted DOM receipt did not arrive before the Core deadline."
          : "The private preload did not acknowledge arming before the Core deadline.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }, request.deadlineMs - now);
    try {
      this.#documentEvidence.arm(request.roleId, inputSequence, pending.expectedEvents);
      this.#surfaces.sendTrustedInputControl(frame, createTrustedInputArmEnvelope(
        request, frame.frameToken, inputSequence, pending.expectedEvents
      ));
    } catch {
      pending.failureStage = "preload-arm";
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

  observeMacroKey(
    identity: ChromiumTrustedInputGuardObservationIdentity,
    payload: unknown
  ): boolean {
    const delivery = observeChromiumGameDelivery(this.#pending, identity, payload);
    if (delivery !== null) return delivery;
    const observation = parseChromiumModifierProjectionObservation(payload);
    if (!observation) return false;
    const pending = this.#pending.forRole(identity.roleId);
    if (!pending || pending.terminal ||
      identity.generation !== pending.frame.generation ||
      identity.documentInstanceId !== pending.frame.documentInstanceId ||
      observation.dispatchId !== pending.inputSequence ||
      !pending.cdpInvoked) {
      return false;
    }
    const alreadyObserved = pending.expectedEvents
      .slice(0, pending.nextDomIndex)
      .some(event => event.type === "keydown" &&
        event.code === observation.code &&
        pending.modifierProjectionCodes.includes(observation.code));
    if (alreadyObserved) return true;
    const expected = pending.expectedEvents[pending.nextDomIndex];
    if (expected?.code !== observation.code && pending.expectedEvents
      .slice(pending.nextDomIndex + 1).some(event => event.type === "keydown" &&
        event.code === observation.code && pending.modifierProjectionCodes.includes(observation.code))) {
      pending.queuedModifierObservations ??= [];
      if (pending.queuedModifierObservations.length >= 8) { this.#terminalizeMismatch(pending); return false; }
      pending.queuedModifierObservations.push(payload);
      return true;
    }
    if (!expected || expected.type !== "keydown" ||
      expected.code !== observation.code ||
      !pending.modifierProjectionCodes.includes(observation.code) ||
      expected.altKey !== observation.altKey ||
      expected.ctrlKey !== observation.ctrlKey ||
      expected.metaKey !== observation.metaKey ||
      expected.shiftKey !== observation.shiftKey) {
      this.#terminalizeMismatch(pending);
      return false;
    }
    pending.nextDomIndex += 1;
    pending.lastObservedDomModifierMask = chromiumDomModifierMask(observation);
    pending.physicalEvidenceDiagnostics.lastObservedDomEventType = "keydown";
    pending.physicalEvidenceDiagnostics.lastObservedDomEventCode = observation.code;
    pending.physicalEvidenceDiagnostics.lastClassification = "automatic";
    recordTrustedInputTrace(pending, "preload", "modifier-projection-observed");
    this.#maybeApply(pending);
    return true;
  }

  receive(event: MacosAppKitTrustedInputIpcEventPort, rawReceipt: unknown): boolean {
    if (this.#disposed) return false;
    const receipt = parseReceipt(rawReceipt);
    const identity = this.#surfaces.authorizeTrustedInputFrame(
      event.sender,
      event.senderFrame,
      receipt.frameToken
    );
    const currentArm = this.#pending.forRole(identity.roleId);
    if (receipt.kind === "document-input" || (receipt.kind === "input" &&
      receipt.documentObservationSequence !== undefined &&
      (!currentArm || receipt.inputSequence !== currentArm.inputSequence))) {
      const host = this.#hosts.resolve(identity.roleId, identity.generation);
      if (!host) return false;
      const probe = validateAppKitProbe(host.native.probeCdpInputSurface(host.identity,
        identity.roleId, identity.generation), host, identity.roleId, identity.generation);
      const snapshot = { sequence: probe.physicalInputSequence, keyboard: probe.physicalKeyboardEvidence,
        keyDownSequence: probe.physicalKeyDownSequence, keyUpSequence: probe.physicalKeyUpSequence,
        targetReceivesPhysicalInput: probe.targetReceivesPhysicalInput };
      if (!snapshot.keyboard) return false;
      const evidence = this.#documentEvidence.begin(identity.roleId, identity.frameToken, snapshot, true);
      if (!this.#documentEvidence.observe(identity.roleId, identity.frameToken, receipt.documentObservationSequence!)) return false;
      if (receipt.kind === "document-input" && receipt.isTrusted) evidence.classify(snapshot, receipt);
      else if (receipt.kind === "input") this.#documentEvidence.late(identity.roleId, receipt, snapshot);
      return true;
    }
    const pending = this.#pending.forRole(identity.roleId);
    if (!pending || pending.terminal || !sameFrame(identity, pending.frame) ||
      receipt.roleId !== pending.request.roleId ||
      receipt.generation !== pending.request.surfaceGeneration ||
      receipt.inputSequence !== pending.inputSequence) {
      return false;
    }
    if (receipt.kind === "armed") {
      pending.documentObservationWatermark = receipt.documentObservationWatermark;
      pending.gameDeliveryRequired = receipt.deliveryReceiptVersion === 1 &&
        receipt.modifierDisposition === "dispatch" && Boolean(pending.request.keyEffect);
      if (receipt.documentObservationWatermark !== undefined &&
        !this.#documentEvidence.watermark(identity.roleId, identity.frameToken, receipt.documentObservationWatermark)) {
        this.#terminalizeMismatch(pending);
        return false;
      }
      recordTrustedInputTrace(pending, "preload", "arm-acknowledged");
      const modifierEffect = pending.request.keyEffect;
      const projectionCandidates = modifierEffect
        ? (pending.request.physicalModifierCodes ?? []).filter(code =>
            isChromiumModifierCode(code) && !modifierEffect.activeCodes.includes(code)
          )
        : [];
      const expectedProjectionCodes = projectionCandidates.filter(code =>
        receipt.physicalModifierCodes.includes(code)
      );
      const modifierProjectionValid =
        receipt.modifierProjectionCodes.join("\n") ===
          expectedProjectionCodes.join("\n") &&
        (receipt.modifierDisposition !== "adoptPhysical" ||
          receipt.modifierProjectionCodes.length === 0);
      const modifierDispositionValid = receipt.modifierDisposition === "dispatch"
        ? receipt.expectedEventCount === pending.expectedEvents.length
        : Boolean(
            modifierEffect &&
            pending.request.action.type === "key" &&
            pending.request.action.modifierOwnership === "synthetic" &&
            isChromiumModifierCode(modifierEffect.code) &&
            receipt.expectedEventCount === 0 &&
            receipt.physicalModifierCodes.includes(modifierEffect.code) &&
            (receipt.modifierDisposition === "adoptPhysical"
              ? modifierEffect.phase === "rawKeyDown"
              : modifierEffect.phase === "keyUp")
          );
      if (!modifierDispositionValid || !modifierProjectionValid ||
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
      pending.modifierProjectionCodes = Object.freeze([
        ...receipt.modifierProjectionCodes
      ]);
      pending.modifierDisposition = receipt.modifierDisposition;
      const projectionModifiers = Object.freeze([...new Set([
        ...(modifierEffect ? activeChromiumModifierCodes(modifierEffect, []) : []),
        ...pending.physicalModifierCodes
      ])]);
      const projectionEvents = pending.modifierProjectionCodes.map(code =>
        keyEvent("keydown", code, projectionModifiers, false)
      );
      const projectionTransitions = pending.modifierProjectionCodes.map(code =>
        Object.freeze({
          type: "key" as const,
          eventType: "rawKeyDown" as const,
          code,
          repeat: false,
          modifierCodes: projectionModifiers
        })
      );
      if (receipt.modifierDisposition === "dispatch") {
        pending.nativeInvoked = false;
        pending.applicationPath = "none";
        const projectedCode = pending.request.keyEffect?.code ??
          (pending.request.action.type === "key" ? pending.request.action.code : null);
        const expectedEvents = mergeChromiumPhysicalModifiers(
          pending.expectedEvents,
          pending.physicalModifierCodes,
          projectedCode
        );
        pending.expectedEvents = Object.freeze([
          ...expectedEvents,
          ...projectionEvents
        ]);
        pending.nativeTransitions = Object.freeze([
          ...pending.nativeTransitions,
          ...projectionTransitions
        ]);
      } else {
        pending.expectedEvents = Object.freeze(projectionEvents);
        pending.nativeTransitions = Object.freeze(projectionTransitions);
      }
      this.#documentEvidence.arm(identity.roleId, pending.inputSequence, pending.expectedEvents);
      void this.#submitCdp(pending);
      return true;
    }
    if (receipt.kind === "rejected") {
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        "ELECTRON_MACOS_APPKIT_INPUT_ARM_REJECTED",
        "The exact role preload rejected trusted-input arming.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
      return true;
    }
    if (receipt.kind !== "input" ||
      receipt.observationSequence !== pending.nextObservationSequence) {
      this.#terminalizeMismatch(pending);
      return false;
    }
    if (receipt.documentObservationSequence !== undefined &&
      !this.#documentEvidence.observe(identity.roleId, identity.frameToken, receipt.documentObservationSequence)) {
      this.#terminalizeMismatch(pending);
      return false;
    }
    recordTrustedInputTrace(pending, "preload", "dom-event-observed");
    pending.nextObservationSequence += 1;
    // Compatibility forwarding is an explicitly separate, untrusted delivery lane.
    if (receipt.documentObservationSequence !== undefined && !receipt.isTrusted) return true;
    pending.observations.push(receipt);
    pending.lastObservedDomModifierMask = chromiumDomModifierMask(receipt);
    pending.physicalEvidenceDiagnostics.lastObservedDomEventType = receipt.type;
    pending.physicalEvidenceDiagnostics.lastObservedDomEventCode =
      receipt.code ?? undefined;
    try {
      const liveHost = this.#hosts.resolve(
        pending.request.roleId, pending.request.surfaceGeneration
      );
      if (!liveHost || !sameHost(liveHost, pending.host)) {
        throw new Error("The native physical-input owner was superseded.");
      }
      const probe = validateAppKitProbe(liveHost.native.probeCdpInputSurface(
        liveHost.identity, pending.request.roleId, pending.request.surfaceGeneration
      ), liveHost, pending.request.roleId, pending.request.surfaceGeneration);
      if (!sameAppKitStableSurface(probe, pending.nativeProbe)) {
        throw new Error("The AppKit input surface identity changed during receipt correlation.");
      }
      pending.nativeProofChanges ??= [];
      pending.nativeProofChanges.push(...appKitProofChanges(probe, pending.nativeProbe));
      const snapshot = {
        sequence: probe.physicalInputSequence,
        keyboard: probe.physicalKeyboardEvidence,
        keyDownSequence: probe.physicalKeyDownSequence,
        keyUpSequence: probe.physicalKeyUpSequence,
        targetReceivesPhysicalInput: probe.targetReceivesPhysicalInput
      };
      pending.physicalEvidenceDiagnostics.inputSequenceAfter =
        probe.physicalInputSequence;
      pending.physicalEvidenceDiagnostics.keyDownSequenceAfter =
        probe.physicalKeyDownSequence;
      pending.physicalEvidenceDiagnostics.keyUpSequenceAfter =
        probe.physicalKeyUpSequence;
      pending.nativeProbe = probe;
      const reconciliation = reconcileChromiumTrustedInputReceipts(
        pending.physicalEvidence,
        snapshot,
        pending.expectedEvents,
        pending.nextDomIndex,
        pending.observations
      );
      recordTrustedInputTrace(pending, "native", "receipt-pairing", JSON.stringify({
        status: reconciliation.status, code: receipt.code, phase: receipt.type,
        keyboard: snapshot.keyboard ? { sequence: snapshot.keyboard.sequence,
          events: snapshot.keyboard.events.filter(edge => edge.code === receipt.code) } : undefined,
        next: reconciliation.nextExpectedIndex
      }));
      pending.observations = [...reconciliation.remaining];
      pending.nextDomIndex = reconciliation.nextExpectedIndex;
      for (const decision of reconciliation.decisions) {
        pending.physicalEvidenceDiagnostics.lastObservedDomEventType =
          decision.receipt.type;
        pending.physicalEvidenceDiagnostics.lastObservedDomEventCode =
          decision.receipt.code ?? undefined;
        pending.physicalEvidenceDiagnostics.lastClassification =
          decision.classification;
        if (decision.classification !== "physical") continue;
        const observed = decision.receipt;
        const expected = decision.expectedEvent;
        pending.physicalInterleave = observed.code &&
          isChromiumModifierCode(observed.code)
          ? "modifier-change"
          : expected && observed.type === expected.type &&
            observed.code === expected.code && observed.button === expected.button
            ? "same-identity" : "unrelated";
      }
      if (reconciliation.status === "indeterminate") {
        pending.physicalEvidenceDiagnostics.lastClassification = "indeterminate";
        pending.physicalInterleave = "indeterminate";
        this.#terminalizeMismatch(pending);
        return false;
      }
      if (reconciliation.status === "mismatch" ||
          (!pending.nativeInvoked && reconciliation.decisions.some(
            (decision) => decision.classification === "automatic"
          ))) {
        this.#terminalizeMismatch(pending);
        return false;
      }
      const projections = pending.queuedModifierObservations?.splice(0) ?? [];
      for (const projection of projections) this.observeMacroKey(identity, projection);
      this.#maybeApply(pending);
      return true;
    } catch {
      pending.failureStage = "dom-receipt-correlation";
      pending.physicalEvidenceDiagnostics.lastClassification = "indeterminate";
      pending.physicalInterleave = "indeterminate";
      this.#terminalizeMismatch(pending);
      return false;
    }
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
    this.#compatible?.dispose();
    if (this.#disposed) return;
    this.#disposed = true;
    this.#documentEvidence.clear();
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
      if (pending.request.intent !== "cleanup" &&
        !sameAppKitFocusProof(liveProbe, pending.nativeProbe)) {
        throw new Error(
          "The AppKit focus or native input-owner proof changed before CDP submission."
        );
      }
      pending.nativeProbe = liveProbe;
      recordTrustedInputTrace(pending, "native", "pre-submit-proof-accepted");
    } catch (cause) {
      pending.failureStage = "pre-submit-proof";
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "superseded",
        "BROWSER_ACTION_STALE",
        normalizeRionBridgeError(cause, "BROWSER_ACTION_STALE").message,
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
      return;
    }
    if (pending.modifierDisposition !== "dispatch" &&
      pending.modifierProjectionCodes.length === 0) {
      pending.nativeInvoked = true;
      pending.applicationPath = pending.modifierDisposition === "adoptPhysical"
        ? "physical-modifier-adoption"
        : "modifier-ownership-release";
      pending.nativeSubmitted = 1;
      pending.nativeComplete = true;
      this.#maybeApply(pending);
      return;
    }
    if (pending.modifierDisposition !== "dispatch") {
      recordTrustedInputTrace(
        pending,
        "preload",
        pending.modifierDisposition === "adoptPhysical"
          ? "physical-modifier-adopted"
          : "modifier-ownership-released"
      );
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
          pending.cdpInvoked = true;
          pending.applicationPath = "cdp";
          pending.cdpModifierMask = chromiumCdpModifierMask(activeCodes);
          recordTrustedInputTrace(pending, "cdp", "key-submit-started");
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
          recordTrustedInputTrace(pending, "cdp", "key-command-accepted");
          if (pending.modifierProjectionCodes.includes(transition.code)) {
            recordTrustedInputTrace(
              pending,
              "cdp",
              "physical-modifier-projected",
              transition.code
            );
          }
        } else {
          pending.nativeInvoked = true;
          pending.cdpInvoked = true;
          pending.applicationPath = "cdp";
          recordTrustedInputTrace(pending, "cdp", "pointer-submit-started");
          pending.expectedEvents = Object.freeze(pending.expectedEvents.map(event =>
            Object.freeze({
              ...event,
              clientX: transition.clientX,
              clientY: transition.clientY
            })
          ));
          const modifierCodes = pending.physicalModifierCodes;
          pending.cdpModifierMask = chromiumCdpModifierMask(modifierCodes);
          const receipt = await this.#cdp.dispatchMouse(pending.frame, {
            x: transition.clientX,
            y: transition.clientY,
            button: transition.button === 0 ? "left"
              : transition.button === 1 ? "middle" : "right",
            modifierCodes,
            releaseOnly: transition.releaseOnly
          });
          if (receipt.acceptedCommandCount !== (transition.releaseOnly ? 1 : 2) ||
            receipt.requiresTrustedDomReceipt !== true) {
            throw new Error("CDP did not accept the exact mouse command pair.");
          }
          recordTrustedInputTrace(pending, "cdp", "pointer-command-accepted");
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
        if (!sameAppKitStableSurface(afterProbe, pending.nativeProbe)) {
          throw new Error("AppKit native input ownership changed during CDP submission.");
        }
        if (pending.request.intent === "cleanup" &&
          !sameAppKitFocusProof(afterProbe, pending.nativeProbe)) {
          throw new Error("AppKit focus continuity changed during cleanup submission.");
        }
        pending.nativeProofChanges ??= [];
        pending.nativeProofChanges.push(
          ...appKitProofChanges(afterProbe, pending.nativeProbe)
        );
        recordTrustedInputTrace(pending, "native", "post-submit-surface-stable");
        pending.nativeProbe = afterProbe;
        pending.nativeSubmitted += 1;
      }
      pending.nativeComplete = true;
      this.#maybeApply(pending);
    } catch (cause) {
      pending.failureStage = "cdp-submission";
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION"
          : "SYSTEM_TRUSTED_INPUT_NATIVE_SUBMISSION_FAILED",
        normalizeRionBridgeError(cause, "SYSTEM_TRUSTED_INPUT_NATIVE_SUBMISSION_FAILED").message,
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
    this.#compatible?.retire(event.roleId);
    this.#documentEvidence.retire(event.roleId, event.reason === "document-superseded");
    this.#pending.surfaceChanged(event);
  }

  #onCdpTerminal(event: ChromiumCdpInputTerminalEvent): void {
    const pending = this.#pending.forRole(event.identity.roleId);
    if (!pending || pending.terminal ||
      pending.frame.generation !== event.identity.surfaceGeneration ||
      pending.frame.documentInstanceId !== event.identity.documentInstanceId ||
      pending.frame.frameToken !== event.identity.frameToken) return;
    pending.cdpTerminalReason = event.reason;
    pending.failureStage = "cdp-transport-terminal";
    recordTrustedInputTrace(
      pending,
      "cdp",
      "transport-terminal",
      event.reason
    );
    this.#terminalize(
      pending,
      pending.nativeInvoked ? "indeterminate" : "superseded",
      "SYSTEM_TRUSTED_INPUT_CDP_SESSION_TERMINATED",
      `The exact CDP Input session terminalized: ${event.reason}.`,
      !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
    );
  }
}
