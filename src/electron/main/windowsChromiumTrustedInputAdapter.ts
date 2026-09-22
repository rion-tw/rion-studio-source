import { ChromiumCompatibleInput, type ChromiumCompatibleInputPort } from "./chromiumCompatibleInput";
import { observeChromiumGameDelivery } from "./chromiumGameDeliveryEvidence";
import { ChromiumTrustedInputDocumentEvidence } from "./chromiumTrustedInputDocumentEvidence";
import { createTrustedInputArmEnvelope } from "./chromiumTrustedInputArmEnvelope";
import { sameChromiumViewInputIdentity, validChromiumViewInputIdentity,
  validChromiumViewInputObservation, chromiumViewInputArmingKey } from "./chromiumViewTrustedInputValidation";
import { chromiumDomModifierMask, parseChromiumModifierProjectionObservation,
  parseTrustedInputDomReceipt } from
  "./chromiumTrustedInputDomReceipt";
import { chromiumCdpModifierMask } from "./chromiumCdpInputDescriptors";
import { reconcileChromiumTrustedInputReceipts } from
  "./chromiumTrustedInputReceiptReconciliation";
import { ChromiumTrustedInputPendingLane, recordTrustedInputTrace,
  sameTrustedInputFrame as sameFrame } from
  "./chromiumTrustedInputPendingLane";
import { randomUUID } from "node:crypto";

import { activeChromiumModifierCodes, isChromiumModifierCode,
  resolveChromiumModifierCodes } from
  "./chromiumTrustedInputKeySequence";
import { mergeChromiumPhysicalModifiers, validChromiumPhysicalModifierCodes } from
  "../ipc/chromiumTrustedInputPhysicalModifiers";
import {
  CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
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
import type {
  ChromiumCdpInputTerminalEvent,
  ChromiumCdpInputTransportPort
} from "./chromiumCdpInputTransport";
import { ChromiumPhysicalInputEvidenceLane } from
  "./chromiumPhysicalInputEvidence";
import {
  WINDOWS_CHROMIUM_TRUSTED_KEY_CODES,
  type WindowsChromiumInputDeliveryMode,
  type WindowsChromiumInputSurfaceIdentity,
  type WindowsChromiumInputSurfaceProbeReceipt,
  type WindowsChromiumTrustedInputClickResolverPort,
  type WindowsChromiumTrustedInputHostBinding,
  type WindowsChromiumTrustedInputHostPort,
  type WindowsChromiumTrustedInputSurfacePort
} from "./windowsChromiumTrustedInputContract";

const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUSTED_KEY_CODE_SET = new Set<string>(WINDOWS_CHROMIUM_TRUSTED_KEY_CODES);

export interface WindowsChromiumTrustedInputIpcEventPort {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface WindowsChromiumTrustedInputIpcMainPort {
  on: (
    channel: string,
    listener: (
      event: WindowsChromiumTrustedInputIpcEventPort,
      receipt: unknown
    ) => void
  ) => unknown;
  removeListener: (
    channel: string,
    listener: (
      event: WindowsChromiumTrustedInputIpcEventPort,
      receipt: unknown
    ) => void
  ) => unknown;
}

/** The caller owns the declared Core deadline; no liveness poll is permitted. */
export interface WindowsChromiumTrustedInputDeadlinePort {
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
    button: 0 | 1 | 2;
    releaseOnly: boolean;
  }>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

interface PendingDispatch {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly host: WindowsChromiumTrustedInputHostBinding;
  probe: WindowsChromiumInputSurfaceProbeReceipt;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
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
  readonly physicalEvidence: ChromiumPhysicalInputEvidenceLane;
  nativeProofChanges?: string[];
  cdpTerminalReason?: string;
  failureStage?: string;
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


function sameIdentity(
  left: WindowsChromiumInputSurfaceIdentity,
  right: WindowsChromiumInputSurfaceIdentity
): boolean {
  return left.ownerKind === "view" && right.ownerKind === "view" &&
    sameChromiumViewInputIdentity(left, right);
}

function sameHost(
  left: WindowsChromiumTrustedInputHostBinding,
  right: WindowsChromiumTrustedInputHostBinding
): boolean {
  return left.native === right.native && sameIdentity(left.identity, right.identity);
}

function windowsProofChanges(
  left: WindowsChromiumInputSurfaceProbeReceipt,
  right: WindowsChromiumInputSurfaceProbeReceipt
): string[] {
  const fields = [
    "focusIdentity",
    "parentForeground",
    "viewVisible",
    "contentsFocused",
    "focusedWebContentsId",
    "zoomFactor"
  ] as const;
  const changes: string[] = fields
    .filter(field => left.observation[field] !== right.observation[field]);
  for (const field of ["x", "y", "width", "height"] as const) {
    if (left.observation.bounds[field] !== right.observation.bounds[field]) {
      changes.push(`bounds.${field}`);
    }
  }
  return changes;
}

function keyModifiers(codes: readonly string[]): Readonly<{
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
    ...keyModifiers(modifierCodes),
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
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false
  });
}

function prepareDispatch(
  request: ChromiumNativeTrustedInputRequest,
  frame: ChromiumRoleOverlayFrameIdentity,
  clicks: WindowsChromiumTrustedInputClickResolverPort
): Readonly<{
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  nativeTransitions: readonly NativeTransition[];
}> {
  const action = request.action;
  if (action.type === "focus") {
    fail(
      "SYSTEM_TRUSTED_INPUT_FOCUS_UNAVAILABLE",
      "Windows Chromium Focus admission is owned by the exact native Role host."
    );
  }
  if (request.keyEffect) {
    const effect = request.keyEffect;
    if (!TRUSTED_KEY_CODE_SET.has(effect.code)) {
      fail(
        "SYSTEM_TRUSTED_INPUT_CODE_UNSUPPORTED",
        "The DOM code has no supported Chromium key mapping."
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
        "Windows Chromium trusted key input requires an exact DOM code."
      );
    }
    if (!TRUSTED_KEY_CODE_SET.has(action.code)) {
      fail(
        "SYSTEM_TRUSTED_INPUT_CODE_UNSUPPORTED",
        "The DOM code has no supported Chromium key mapping."
      );
    }
    const modifierCodes = resolveChromiumModifierCodes(action, "win32");
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
      "The Windows click resolver returned invalid Chromium CSS coordinates or zoom."
    );
  }
  const button = action.button === "left" ? 0 : action.button === "middle" ? 1 : 2;
  const activationEvents = button === 0 ? ["click" as const]
    : ["auxclick" as const];
  return Object.freeze({
    expectedEvents: Object.freeze([
      ...(request.pointerReleaseOnly
        ? []
        : [mouseEvent("mousedown", null, null, button)]),
      mouseEvent("mouseup", null, null, button),
      ...(request.pointerReleaseOnly
        ? []
        : activationEvents.map((type) => mouseEvent(type, null, null, button))),
      ...(!request.pointerReleaseOnly && button === 2
        ? [mouseEvent("contextmenu", null, null, button)]
        : [])
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
  return parseTrustedInputDomReceipt(value, (message) => fail("ELECTRON_WINDOWS_CHROMIUM_INPUT_RECEIPT_INVALID", message));
}

function canonicalU64(value: unknown, positive = false): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed > 18_446_744_073_709_551_615n || (positive && parsed === 0n)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validateIdentityFields(
  receipt: WindowsChromiumInputSurfaceIdentity,
  expected: WindowsChromiumInputSurfaceIdentity
): boolean {
  return sameIdentity(receipt, expected) && validChromiumViewInputIdentity(receipt);
}

function validateProbe(
  raw: unknown,
  expected: WindowsChromiumInputSurfaceIdentity,
  deliveryMode: WindowsChromiumInputDeliveryMode,
  inputRoute: "trusted" | "compatible" = "trusted"
): WindowsChromiumInputSurfaceProbeReceipt {
  if (!raw || typeof raw !== "object") {
    fail("SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID", "The Chromium View probe returned no exact receipt.");
  }
  const receipt = raw as WindowsChromiumInputSurfaceProbeReceipt;
  if (receipt.ownerKind !== "view" || expected.ownerKind !== "view" ||
      receipt.status !== "verified" || receipt.deliveryMode !== deliveryMode ||
      !validateIdentityFields(receipt, expected) || canonicalU64(receipt.probeRevision, true) === null ||
      !validChromiumViewInputObservation(receipt.observation, expected, deliveryMode, inputRoute)) {
    fail("SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID", "The exact Chromium View observation is invalid.");
  }
  return Object.freeze({ ...receipt, observation: Object.freeze({ ...receipt.observation,
    identity: Object.freeze({ ...receipt.observation.identity }),
    bounds: Object.freeze({ ...receipt.observation.bounds }) }) });
}

/**
 * Accepts Chromium submission only after an exact direct-View probe,
 * then correlates it with private main-frame `isTrusted` DOM observations.
 *
 * Bootstrap construction is capability-gated. Every effect is locked to the
 * exact foreground or same-parent hidden Role host established by a live
 * native ownership probe and must receive an isolated DOM `isTrusted` acknowledgement.
 * The hidden lane is admitted only when the Windows background-input
 * capability is explicitly enabled.
 */
export class WindowsChromiumTrustedInputAdapter
implements ChromiumNativeTrustedInputPort {
  readonly #hosts: WindowsChromiumTrustedInputHostPort;
  readonly #surfaces: WindowsChromiumTrustedInputSurfacePort;
  readonly #clicks: WindowsChromiumTrustedInputClickResolverPort;
  readonly #nowMs: () => number;
  readonly #deadlines: WindowsChromiumTrustedInputDeadlinePort;
  readonly #cdp: ChromiumCdpInputTransportPort;
  readonly #createInputSequence: () => string;
  readonly #backgroundSupported: boolean;
  readonly #physicalModifierCodes: () => readonly string[];
  readonly #pending: ChromiumTrustedInputPendingLane<PendingDispatch>;
  readonly #unsubscribeLifecycle: () => void;
  readonly #unsubscribeCdpTerminal: () => void;
  readonly #compatible: ChromiumCompatibleInput | null;
  readonly #documentEvidence = new ChromiumTrustedInputDocumentEvidence();
  readonly #ipcListener = (
    event: WindowsChromiumTrustedInputIpcEventPort,
    receipt: unknown
  ): void => {
    try {
      this.receive(event, receipt);
    } catch {
      // Forged/malformed IPC never mutates the exact in-flight lane.
    }
  };
  #ipcMain: WindowsChromiumTrustedInputIpcMainPort | null = null;
  #disposed = false;

  constructor(input: Readonly<{
    hosts: WindowsChromiumTrustedInputHostPort;
    surfaces: WindowsChromiumTrustedInputSurfacePort;
    clicks: WindowsChromiumTrustedInputClickResolverPort;
    cdp: ChromiumCdpInputTransportPort;
    nowMs: () => number;
    deadlines: WindowsChromiumTrustedInputDeadlinePort;
    backgroundSupported: boolean;
    physicalModifierCodes: () => readonly string[];
    compatibility?: ChromiumCompatibleInputPort;
    createInputSequence?: () => string;
  }>) {
    this.#hosts = input.hosts;
    this.#surfaces = input.surfaces;
    this.#clicks = input.clicks;
    this.#cdp = input.cdp;
    this.#nowMs = input.nowMs;
    this.#deadlines = input.deadlines;
    this.#backgroundSupported = input.backgroundSupported;
    this.#physicalModifierCodes = input.physicalModifierCodes;
    this.#compatible = input.compatibility ? new ChromiumCompatibleInput({
      port: input.compatibility, platform: "win32", nowMs: this.#nowMs,
      timers: { setTimeout: this.#deadlines.schedule, cancel: this.#deadlines.cancel }
    }) : null;
    this.#createInputSequence = input.createInputSequence ?? randomUUID;
    this.#pending = new ChromiumTrustedInputPendingLane({
      nowMs: this.#nowMs,
      cancelDeadline: (handle) => this.#deadlines.cancel(handle),
      sendCancel: (frame, envelope) => this.#surfaces.sendTrustedInputControl(frame, envelope)
    });
    this.#unsubscribeLifecycle = this.#surfaces.subscribeTrustedInputLifecycle(
      (event) => this.#onSurfaceLifecycle(event)
    );
    this.#unsubscribeCdpTerminal = this.#cdp.subscribeTerminal(
      (event) => this.#onCdpTerminal(event)
    );
  }

  register(ipcMain: WindowsChromiumTrustedInputIpcMainPort): void {
    if (this.#disposed || this.#ipcMain) {
      fail(
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_REGISTRATION_CONFLICT",
        "The Windows trusted-input receipt lane cannot be registered twice."
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
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_UNAVAILABLE",
        "The Windows trusted-input receipt lane is unavailable."
      ));
    }
    if (this.#pending.busy(request.roleId, request.requestId)) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_LANE_BUSY",
        "The role already has one exact trusted-input request in flight."
      ));
    }
    let frame: ChromiumRoleOverlayFrameIdentity;
    let host: WindowsChromiumTrustedInputHostBinding | null;
    let probe: WindowsChromiumInputSurfaceProbeReceipt;
    let deliveryMode: WindowsChromiumInputDeliveryMode;
    let prepared: ReturnType<typeof prepareDispatch>;
    let observedPhysicalModifierCodes: readonly string[];
    try {
      frame = this.#surfaces.currentTrustedInputFrame(
        request.roleId,
        request.surfaceGeneration
      );
      host = this.#hosts.resolve(request.roleId, request.surfaceGeneration);
      if (!host) {
        fail(
          "ELECTRON_WINDOWS_CHROMIUM_INPUT_HOST_UNAVAILABLE",
          "The role has no exact live Win32 child input host."
        );
      }
      if (request.action.type === "focus" && !this.#compatible) {
        return host.native.focusForeground(host.identity, request);
      }
      const inputRoute = this.#compatible ? "compatible" : "trusted";
      const resolvedMode = host.native.currentInputDeliveryMode(host.identity, inputRoute);
      if ((resolvedMode !== "foreground" && resolvedMode !== "background") || (resolvedMode === "background" &&
        !this.#backgroundSupported)) {
        fail(
          "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE",
          "The exact Windows Role host cannot accept its current input delivery mode."
        );
      }
      deliveryMode = resolvedMode;
      probe = validateProbe(
        host.native.probeExactInputSurface(host.identity, deliveryMode, inputRoute),
        host.identity,
        deliveryMode,
        inputRoute
      );
      observedPhysicalModifierCodes = this.#physicalModifierCodes();
      if (!validChromiumPhysicalModifierCodes(observedPhysicalModifierCodes)) {
        fail(
          "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID",
          "The Windows host returned malformed physical modifier evidence."
        );
      }
      if (this.#compatible) {
        const originalHost = host;
        return this.#compatible.dispatch(request, frame,
          observedPhysicalModifierCodes,
          request.action.type === "click" ? this.#clicks.resolve(request, frame) : null, () => {
            const currentHost = this.#hosts.resolve(request.roleId, request.surfaceGeneration);
            if (this.#disposed || !currentHost || !sameHost(currentHost, originalHost) ||
                !sameFrame(this.#surfaces.currentTrustedInputFrame(request.roleId, request.surfaceGeneration), frame))
              throw new Error("Compatible input host retired.");
            const mode = currentHost.native.currentInputDeliveryMode(currentHost.identity, inputRoute);
            if (mode !== "foreground" && mode !== "background") throw new Error("Compatible input host unavailable.");
            validateProbe(currentHost.native.probeExactInputSurface(currentHost.identity, mode, inputRoute), currentHost.identity, mode, inputRoute);
          });
      }
      prepared = prepareDispatch(request, frame, this.#clicks);
    } catch (error) {
      const bridge = error instanceof RionBridgeError ? error : inputError(
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_PREPARE_FAILED",
        "The Windows trusted-input request could not be prepared."
      );
      return Promise.resolve(this.#immediateFailure(request, bridge.code, bridge.message));
    }
    const inputSequence = this.#createInputSequence();
    if (!INPUT_SEQUENCE_PATTERN.test(inputSequence)) {
      return Promise.resolve(this.#immediateFailure(
        request,
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_SEQUENCE_INVALID",
        "The Windows trusted-input sequence generator returned an invalid identity."
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
      observedPhysicalModifierCodes.includes(request.keyEffect.code)
    );
    const pending: PendingDispatch = {
      request,
      frame,
      host,
      probe,
      deliveryMode,
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
      physicalEvidence: probe.observation.physicalKeyboardEvidence ? this.#documentEvidence.begin(request.roleId, frame.frameToken, {
        sequence: probe.observation.physicalInputSequence,
        keyboard: probe.observation.physicalKeyboardEvidence,
        targetReceivesPhysicalInput: deliveryMode === "foreground" &&
          probe.observation.parentForeground && probe.observation.contentsFocused
      }) : new ChromiumPhysicalInputEvidenceLane({ sequence: probe.observation.physicalInputSequence,
        targetReceivesPhysicalInput: deliveryMode === "foreground" && probe.observation.parentForeground &&
          probe.observation.contentsFocused })
    };
    recordTrustedInputTrace(pending, "core", "browser-action-admitted");
    if (!this.#pending.add(pending)) {
      return Promise.resolve(this.#immediateFailure(request,
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_LANE_BUSY", "The role already has one exact trusted-input request in flight."));
    }
    recordTrustedInputTrace(pending, "native", "surface-proof-admitted");
    recordTrustedInputTrace(pending, "electron", "preload-arm-sent");
    pending.timer = this.#deadlines.schedule(() => {
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
          : "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_RECEIPT_DEADLINE",
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
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_FAILED",
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
    recordTrustedInputTrace(pending, "preload", "modifier-projection-observed");
    this.#maybeApply(pending);
    return true;
  }

  receive(event: WindowsChromiumTrustedInputIpcEventPort, rawReceipt: unknown): boolean {
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
      const mode = host.native.currentInputDeliveryMode(host.identity);
      if (mode !== "foreground" && mode !== "background") return false;
      const probe = validateProbe(host.native.probeExactInputSurface(host.identity, mode), host.identity, mode);
      const snapshot = { sequence: probe.observation.physicalInputSequence,
        keyboard: probe.observation.physicalKeyboardEvidence,
        targetReceivesPhysicalInput: mode === "foreground" && probe.observation.parentForeground && probe.observation.contentsFocused };
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
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_REJECTED",
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
    try {
      const liveHost = this.#hosts.resolve(
        pending.request.roleId, pending.request.surfaceGeneration
      );
      if (!liveHost || !sameHost(liveHost, pending.host)) {
        throw new Error("The native physical-input owner was superseded.");
      }
      const mode = liveHost.native.currentInputDeliveryMode(liveHost.identity);
      if (mode !== "foreground" && mode !== "background") {
        throw new Error("The Windows input delivery mode became unavailable.");
      }
      const probe = validateProbe(liveHost.native.probeExactInputSurface(
        liveHost.identity, mode
      ), liveHost.identity, mode);
      pending.nativeProofChanges ??= [];
      if (mode !== pending.deliveryMode) {
        pending.nativeProofChanges.push("deliveryMode");
      }
      pending.nativeProofChanges.push(...windowsProofChanges(probe, pending.probe));
      const snapshot = {
        sequence: probe.observation.physicalInputSequence,
        keyboard: probe.observation.physicalKeyboardEvidence,
        targetReceivesPhysicalInput: mode === "foreground" &&
          probe.observation.parentForeground && probe.observation.contentsFocused
      };
      pending.probe = probe;
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
        "The Windows trusted-input adapter disposed before exact completion.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }
  }

  async #submitCdp(pending: PendingDispatch): Promise<void> {
    let liveFrame: ChromiumRoleOverlayFrameIdentity;
    let liveHost: WindowsChromiumTrustedInputHostBinding | null;
    let liveProbe: WindowsChromiumInputSurfaceProbeReceipt;
    try {
      liveFrame = this.#surfaces.currentTrustedInputFrame(
        pending.request.roleId,
        pending.request.surfaceGeneration
      );
      liveHost = this.#hosts.resolve(
        pending.request.roleId,
        pending.request.surfaceGeneration
      );
      if (!sameFrame(liveFrame, pending.frame) || !liveHost ||
        !sameHost(liveHost, pending.host)) {
        fail("BROWSER_ACTION_STALE", "The trusted-input frame or surface binding was superseded.");
      }
      if (!liveHost.native.isInputReady(
        liveHost.identity,
        pending.deliveryMode
      )) {
        this.#terminalize(
          pending,
          "failed",
          "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_STALE",
          "Windows trusted input changed delivery mode before native submission.",
          pending.request.expectedInputNeutralityBefore
        );
        return;
      }
      liveProbe = validateProbe(
        liveHost.native.probeExactInputSurface(
          liveHost.identity,
          pending.deliveryMode
        ),
        liveHost.identity,
        pending.deliveryMode
      );
      const sameArmedSurface = BigInt(liveProbe.probeRevision) >= BigInt(pending.probe.probeRevision) &&
        chromiumViewInputArmingKey(liveProbe.observation) === chromiumViewInputArmingKey(pending.probe.observation);
      if (!sameArmedSurface) {
        fail(
          "BROWSER_ACTION_STALE",
          "The native surface observation changed before input submission."
        );
      }
      recordTrustedInputTrace(pending, "native", "pre-submit-proof-accepted");
    } catch {
      pending.failureStage = "pre-submit-proof";
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "superseded",
        "BROWSER_ACTION_STALE",
        "The trusted-input frame or exact input owner was superseded.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
      return;
    }
    // Bind the submission to the freshly validated user focus. The synchronous
    // native edge and its receipt must still preserve this complete observation.
    pending.probe = liveProbe;
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
        if (!pending.host.native.isInputReady(
          pending.host.identity,
          pending.deliveryMode
        )) {
          this.#terminalize(
            pending,
            pending.nativeInvoked ? "indeterminate" : "failed",
            pending.nativeInvoked
              ? "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_LOST"
              : "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_STALE",
            pending.nativeInvoked
              ? "Windows role visibility or focus changed during native input submission."
              : "Windows trusted input requires an exact locked delivery mode.",
            !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
          );
          return;
        }
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
        const afterMode = pending.host.native.currentInputDeliveryMode(
          pending.host.identity
        );
        if (afterMode !== "foreground" && afterMode !== "background") {
          throw new Error("The Windows input delivery mode became unavailable.");
        }
        const afterProbe = validateProbe(
          pending.host.native.probeExactInputSurface(
            pending.host.identity,
            afterMode
          ),
          pending.host.identity,
          afterMode
        );
        pending.nativeProofChanges ??= [];
        if (afterMode !== pending.deliveryMode) {
          pending.nativeProofChanges.push("deliveryMode");
        }
        pending.nativeProofChanges.push(
          ...windowsProofChanges(afterProbe, pending.probe)
        );
        recordTrustedInputTrace(pending, "native", "post-submit-surface-stable");
        pending.probe = afterProbe;
        pending.nativeSubmitted += 1;
      }
      pending.nativeComplete = true;
      this.#maybeApply(pending);
    } catch {
      pending.failureStage = "cdp-submission";
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION"
          : "SYSTEM_TRUSTED_INPUT_NATIVE_SUBMISSION_FAILED",
        pending.nativeInvoked
          ? "Chromium invocation did not return a complete exact receipt sequence."
          : "Chromium rejected input before any native transition was invoked.",
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
