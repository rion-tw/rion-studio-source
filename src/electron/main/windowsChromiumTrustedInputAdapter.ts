import { createTrustedInputArmEnvelope } from "./chromiumTrustedInputArmEnvelope";
import { sameChromiumViewInputIdentity, validChromiumViewInputIdentity,
  validChromiumViewInputObservation, chromiumViewInputObservationKey } from "./chromiumViewTrustedInputValidation";
import { parseTrustedInputDomReceipt, matchesTrustedInputExpectedEvent as sameExpected } from
  "./chromiumTrustedInputDomReceipt";
import { ChromiumTrustedInputPendingLane, sameTrustedInputFrame as sameFrame } from
  "./chromiumTrustedInputPendingLane";
import { randomUUID } from "node:crypto";

import type { BrowserAction } from "../../shared/generated";
import {
  CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
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
import {
  WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION,
  WINDOWS_CHROMIUM_TRUSTED_KEY_CODES,
  type WindowsChromiumInputDeliveryMode,
  type WindowsChromiumInputSurfaceIdentity,
  type WindowsChromiumInputSurfaceProbeReceipt,
  type WindowsChromiumTrustedInputClickResolverPort,
  type WindowsChromiumTrustedInputHostBinding,
  type WindowsChromiumTrustedInputHostPort,
  type WindowsChromiumTrustedInputSurfacePort,
  type WindowsNativeTrustedInputSubmissionBase,
  type WindowsNativeTrustedKeySubmissionReceipt,
  type WindowsNativeTrustedMouseSubmissionReceipt
} from "./windowsChromiumTrustedInputContract";

const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_HANDLE_PATTERN = /^[0-9a-f]{32,128}$/u;
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
  | Readonly<{ type: "key"; eventType: "keyDown" | "keyUp"; code: string }>
  | Readonly<{
    type: "mouse";
    clientX: number;
    clientY: number;
    zoomFactor: number;
    button: 0 | 1 | 2;
  }>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

interface PendingDispatch {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly host: WindowsChromiumTrustedInputHostBinding;
  readonly probe: WindowsChromiumInputSurfaceProbeReceipt;
  readonly deliveryMode: WindowsChromiumInputDeliveryMode;
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
  if (left.ownerKind === "view" || right.ownerKind === "view") {
    return left.ownerKind === "view" && right.ownerKind === "view" &&
      sameChromiumViewInputIdentity(left, right);
  }
  return left.roleId === right.roleId &&
    left.surfaceGeneration === right.surfaceGeneration &&
    left.nativeGeneration === right.nativeGeneration &&
    left.bindingRevision === right.bindingRevision &&
    left.surfaceHandleToken === right.surfaceHandleToken &&
    left.parentHandleToken === right.parentHandleToken;
}

function sameHost(
  left: WindowsChromiumTrustedInputHostBinding,
  right: WindowsChromiumTrustedInputHostBinding
): boolean {
  return left.native === right.native && sameIdentity(left.identity, right.identity);
}

function keyModifiers(action: BrowserAction): Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}> {
  const values = action.type === "key" ? new Set(action.modifiers) : new Set<string>();
  return Object.freeze({
    altKey: values.has("alt"),
    ctrlKey: values.has("ctrl") || values.has("primary"),
    metaKey: values.has("meta"),
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
    ...keyModifiers(action),
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
      "The Windows click resolver returned invalid Chromium CSS coordinates or zoom."
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

function validHandleToken(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_HANDLE_PATTERN.test(value);
}

function validateIdentityFields(
  receipt: WindowsChromiumInputSurfaceIdentity,
  expected: WindowsChromiumInputSurfaceIdentity
): boolean {
  if (receipt.ownerKind === "view" || expected.ownerKind === "view") {
    return receipt.ownerKind === "view" && expected.ownerKind === "view" &&
      sameChromiumViewInputIdentity(receipt, expected) && validChromiumViewInputIdentity(receipt);
  }
  return sameIdentity(receipt, expected) &&
    typeof receipt.roleId === "string" && receipt.roleId.length > 0 &&
    receipt.roleId.length <= 256 && receipt.roleId === receipt.roleId.trim() &&
    !receipt.roleId.includes("/") && !receipt.roleId.includes("\\") &&
    Number.isSafeInteger(receipt.surfaceGeneration) &&
    receipt.surfaceGeneration >= 1 &&
    Number.isSafeInteger(receipt.nativeGeneration) && receipt.nativeGeneration >= 1 &&
    canonicalU64(receipt.bindingRevision, true) !== null &&
    validHandleToken(receipt.surfaceHandleToken) &&
    validHandleToken(receipt.parentHandleToken) &&
    receipt.surfaceHandleToken !== receipt.parentHandleToken;
}

function validateProbe(
  raw: unknown,
  expected: WindowsChromiumInputSurfaceIdentity,
  deliveryMode: WindowsChromiumInputDeliveryMode
): WindowsChromiumInputSurfaceProbeReceipt {
  if (!raw || typeof raw !== "object") {
    fail(
      "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID",
      "The Win32 surface probe returned no exact receipt."
    );
  }
  const receipt = raw as WindowsChromiumInputSurfaceProbeReceipt;
  if (receipt.ownerKind === "view") {
    if (expected.ownerKind !== "view" || receipt.status !== "verified" ||
        receipt.deliveryMode !== deliveryMode || !validateIdentityFields(receipt, expected) ||
        canonicalU64(receipt.probeRevision, true) === null ||
        !validChromiumViewInputObservation(receipt.observation, expected, deliveryMode)) {
      fail("SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID", "The exact Chromium View observation is invalid.");
    }
    return Object.freeze({ ...receipt, observation: Object.freeze({ ...receipt.observation,
      identity: Object.freeze({ ...receipt.observation.identity }),
      bounds: Object.freeze({ ...receipt.observation.bounds }) }) });
  }

  if (
    receipt.status !== "verified" ||
    receipt.abiVersion !== WINDOWS_CHROMIUM_TRUSTED_INPUT_ABI_VERSION ||
    receipt.deliveryMode !== deliveryMode ||
    !validateIdentityFields(receipt, expected) ||
    canonicalU64(receipt.probeRevision, true) === null ||
    !Number.isSafeInteger(receipt.processId) || receipt.processId < 1 ||
    !Number.isSafeInteger(receipt.uiThreadId) || receipt.uiThreadId < 1 ||
    receipt.currentProcessOwned !== true || receipt.exactParent !== true ||
    receipt.childWindowStyle !== true || receipt.popupWindowStyleAbsent !== true ||
    receipt.noActivateStyle !== true || receipt.parentWasForeground !== true ||
    receipt.parentVisible !== true ||
    receipt.surfaceVisible !== (deliveryMode === "foreground") ||
    (deliveryMode === "background" &&
      (receipt.targetWasForeground || receipt.targetHadThreadFocus)) ||
    typeof receipt.targetWasForeground !== "boolean" ||
    typeof receipt.targetHadThreadFocus !== "boolean" ||
    receipt.singleWebContentsSurface !== true ||
    !Number.isSafeInteger(receipt.clientWidth) || receipt.clientWidth < 1 ||
    !Number.isSafeInteger(receipt.clientHeight) || receipt.clientHeight < 1 ||
    !Number.isSafeInteger(receipt.dpi) || receipt.dpi < 48 || receipt.dpi > 768
  ) {
    fail(
      "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID",
      "The Win32 surface probe did not prove one exact no-activate child host."
    );
  }
  return Object.freeze({ ...receipt });
}

function validateNativeBase(
  pending: PendingDispatch,
  receipt: WindowsNativeTrustedInputSubmissionBase,
  nativeRequestId: string,
  expectedEventCount: number
): bigint {
  const dispatchSequence = canonicalU64(receipt.dispatchSequence, true);
  const submittedAt = canonicalU64(receipt.submittedAtMs, true);
  const scheduledAt = BigInt(pending.request.scheduledAtMs);
  const deadline = BigInt(pending.request.deadlineMs);
  if (receipt.ownerKind === "view" || pending.host.identity.ownerKind === "view" || pending.probe.ownerKind === "view") {
    if (receipt.ownerKind !== "view" || pending.host.identity.ownerKind !== "view" || pending.probe.ownerKind !== "view" ||
        receipt.status !== "submitted" || receipt.submissionApi !== "webContents.sendInputEvent" ||
        receipt.requestId !== nativeRequestId || !validateIdentityFields(receipt, pending.host.identity) ||
        receipt.roleId !== pending.request.roleId || receipt.surfaceGeneration !== pending.request.surfaceGeneration ||
        receipt.inputEpoch !== String(pending.request.inputEpoch) || receipt.deliveryMode !== pending.deliveryMode ||
        receipt.probeRevision !== pending.probe.probeRevision ||
        !dispatchSequence || dispatchSequence <= pending.lastNativeDispatchSequence ||
        !submittedAt || submittedAt < scheduledAt || submittedAt >= deadline ||
        receipt.viewAttached !== true || receipt.foregroundPreserved !== true || expectedEventCount < 1 ||
        !validChromiumViewInputObservation(receipt.observation, pending.host.identity, pending.deliveryMode) ||
        chromiumViewInputObservationKey(receipt.observation) !== chromiumViewInputObservationKey(pending.probe.observation)) {
      fail("SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID", "The Chromium View submission does not match its exact admission.");
    }
    return dispatchSequence;
  }

  if (
    receipt.status !== "submitted" || receipt.submissionApi !== "webContents.sendInputEvent" || receipt.requestId !== nativeRequestId ||
    !validateIdentityFields(receipt, pending.host.identity) ||
    receipt.roleId !== pending.request.roleId ||
    receipt.surfaceGeneration !== pending.request.surfaceGeneration ||
    receipt.inputEpoch !== String(pending.request.inputEpoch) ||
    receipt.deliveryMode !== pending.deliveryMode ||
    receipt.probeRevision !== pending.probe.probeRevision ||
    !dispatchSequence || dispatchSequence <= pending.lastNativeDispatchSequence ||
    !submittedAt || submittedAt < scheduledAt || submittedAt >= deadline ||
    receipt.withinDeadline !== true ||
    receipt.currentProcessOwned !== true || receipt.exactParent !== true ||
    receipt.childWindowStyle !== true || receipt.popupWindowStyleAbsent !== true ||
    receipt.noActivateStyle !== true || receipt.targetAttached !== true ||
    receipt.noActivationApiCalled !== true ||
    receipt.foregroundWindowPreserved !== true ||
    receipt.activeWindowPreserved !== true || receipt.focusWindowPreserved !== true ||
    receipt.parentWasForeground !== true ||
    receipt.parentVisible !== true ||
    receipt.surfaceVisible !== (pending.deliveryMode === "foreground") ||
    (pending.deliveryMode === "background" &&
      (receipt.targetWasForeground || receipt.targetHadThreadFocus)) ||
    typeof receipt.targetWasForeground !== "boolean" ||
    typeof receipt.targetHadThreadFocus !== "boolean" ||
    receipt.clientWidth !== pending.probe.clientWidth ||
    receipt.clientHeight !== pending.probe.clientHeight ||
    receipt.dpi !== pending.probe.dpi ||
    expectedEventCount < 1
  ) {
    fail(
      "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
      "The Chromium owner returned a malformed or mismatched submission receipt."
    );
  }
  return dispatchSequence;
}

/**
 * Accepts Chromium submission only after an exact child-host or direct-View probe,
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
  readonly #createInputSequence: () => string;
  readonly #backgroundSupported: boolean;
  readonly #pending: ChromiumTrustedInputPendingLane<PendingDispatch>;
  readonly #unsubscribeLifecycle: () => void;
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
    nowMs: () => number;
    deadlines: WindowsChromiumTrustedInputDeadlinePort;
    backgroundSupported: boolean;
    createInputSequence?: () => string;
  }>) {
    this.#hosts = input.hosts;
    this.#surfaces = input.surfaces;
    this.#clicks = input.clicks;
    this.#nowMs = input.nowMs;
    this.#deadlines = input.deadlines;
    this.#backgroundSupported = input.backgroundSupported;
    this.#createInputSequence = input.createInputSequence ?? randomUUID;
    this.#pending = new ChromiumTrustedInputPendingLane({
      nowMs: this.#nowMs,
      cancelDeadline: (handle) => this.#deadlines.cancel(handle),
      sendCancel: (frame, envelope) => this.#surfaces.sendTrustedInputControl(frame, envelope)
    });
    this.#unsubscribeLifecycle = this.#surfaces.subscribeTrustedInputLifecycle(
      (event) => this.#onSurfaceLifecycle(event)
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
      if (request.action.type === "focus") {
        return host.native.focusForeground(host.identity, request);
      }
      const resolvedMode = host.native.currentInputDeliveryMode(host.identity);
      if ((resolvedMode !== "foreground" && resolvedMode !== "background") || (resolvedMode === "background" &&
        !this.#backgroundSupported)) {
        fail(
          "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE",
          "The exact Windows Role host cannot accept its current input delivery mode."
        );
      }
      deliveryMode = resolvedMode;
      probe = validateProbe(
        host.native.probeExactInputSurface(host.identity, deliveryMode),
        host.identity,
        deliveryMode
      );
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
      nativeInvoked: false,
      nativeSubmitted: 0,
      nextDomIndex: 0,
      nativeComplete: false,
      terminal: false,
      lastNativeDispatchSequence: 0n
    };
    if (!this.#pending.add(pending)) {
      return Promise.resolve(this.#immediateFailure(request,
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_LANE_BUSY", "The role already has one exact trusted-input request in flight."));
    }
    pending.timer = this.#deadlines.schedule(() => {
      this.#terminalize(
        pending,
        pending.nativeInvoked ? "indeterminate" : "failed",
        pending.nativeInvoked
          ? "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE"
          : "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_RECEIPT_DEADLINE",
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
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_FAILED",
        "The exact role preload rejected trusted-input arming.",
        request.expectedInputNeutralityBefore
      );
    }
    return completion.promise;
  }

  receive(event: WindowsChromiumTrustedInputIpcEventPort, rawReceipt: unknown): boolean {
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
        "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_REJECTED",
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
        "The Windows trusted-input adapter disposed before exact completion.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }
  }

  #submitNative(pending: PendingDispatch): void {
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
      if (liveProbe.probeRevision !== pending.probe.probeRevision ||
          (liveProbe.ownerKind === "view" && pending.probe.ownerKind === "view" &&
            chromiumViewInputObservationKey(liveProbe.observation) !== chromiumViewInputObservationKey(pending.probe.observation))) {
        fail(
          "BROWSER_ACTION_STALE",
          "The native surface observation changed before input submission."
        );
      }
    } catch {
      this.#terminalize(
        pending,
        "superseded",
        "BROWSER_ACTION_STALE",
        "The trusted-input frame or exact input owner was superseded.",
        pending.request.expectedInputNeutralityBefore
      );
      return;
    }
    const action = pending.request.action;
    const modifiers = keyModifiers(action);
    try {
      for (const [index, transition] of pending.nativeTransitions.entries()) {
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
              deliveryMode: pending.deliveryMode,
              eventType: transition.eventType,
              code: transition.code,
              ctrl: modifiers.ctrlKey,
              alt: modifiers.altKey,
              shift: modifiers.shiftKey,
              meta: modifiers.metaKey,
              repeat: false
            }
          );
          pending.lastNativeDispatchSequence = validateNativeBase(
            pending,
            receipt,
            nativeRequestId,
            1
          );
          this.#validateKeyReceipt(pending, transition, receipt, modifiers);
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
              deliveryMode: pending.deliveryMode,
              clientX: transition.clientX,
              clientY: transition.clientY,
              zoomFactor: transition.zoomFactor,
              button: transition.button
            }
          );
          pending.lastNativeDispatchSequence = validateNativeBase(
            pending,
            receipt,
            nativeRequestId,
            2
          );
          this.#validateMouseReceipt(pending, transition, receipt);
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
          ? "Chromium invocation did not return a complete exact receipt sequence."
          : "Chromium rejected input before any native transition was invoked.",
        !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore
      );
    }
  }

  #validateKeyReceipt(
    pending: PendingDispatch,
    transition: Extract<NativeTransition, { type: "key" }>,
    receipt: WindowsNativeTrustedKeySubmissionReceipt,
    modifiers: ReturnType<typeof keyModifiers>
  ): void {
    if (
      receipt.eventType !== transition.eventType || receipt.code !== transition.code ||
      receipt.ctrl !== modifiers.ctrlKey || receipt.alt !== modifiers.altKey ||
      receipt.shift !== modifiers.shiftKey || receipt.meta !== modifiers.metaKey ||
      receipt.dispatchedEventCount !== 1 ||
      receipt.probeRevision !== pending.probe.probeRevision
    ) {
      fail(
        "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
        "The Chromium key receipt does not match the exact native transition."
      );
    }
  }

  #validateMouseReceipt(
    pending: PendingDispatch,
    transition: Extract<NativeTransition, { type: "mouse" }>,
    receipt: WindowsNativeTrustedMouseSubmissionReceipt
  ): void {
    const nativePointValid = Number.isSafeInteger(receipt.inputX) &&
      receipt.inputX >= 0 && receipt.inputX === Math.round(transition.clientX * transition.zoomFactor) &&
      Number.isSafeInteger(receipt.inputY) &&
      receipt.inputY >= 0 && receipt.inputY === Math.round(transition.clientY * transition.zoomFactor);
    const domPointValid = Number.isFinite(receipt.expectedDomClientX) &&
      receipt.expectedDomClientX >= 0 && receipt.expectedDomClientX <= 1_000_000 &&
      Number.isFinite(receipt.expectedDomClientY) &&
      receipt.expectedDomClientY >= 0 && receipt.expectedDomClientY <= 1_000_000 &&
      receipt.expectedDomClientX === Math.floor(receipt.inputX / transition.zoomFactor) &&
      receipt.expectedDomClientY === Math.floor(receipt.inputY / transition.zoomFactor);
    if (
      receipt.button !== transition.button || receipt.clientX !== transition.clientX ||
      receipt.clientY !== transition.clientY ||
      receipt.zoomFactor !== transition.zoomFactor ||
      receipt.dispatchedEventCount !== 2 || !nativePointValid || !domPointValid ||
      receipt.probeRevision !== pending.probe.probeRevision
    ) {
      fail(
        "SYSTEM_TRUSTED_INPUT_NATIVE_RECEIPT_INVALID",
        "The Chromium mouse receipt does not match the exact CSS-to-native point."
      );
    }
    pending.expectedEvents = Object.freeze(pending.expectedEvents.map((event) =>
      mouseEvent(
        event.type as "mousedown" | "mouseup" | "click" | "auxclick",
        receipt.expectedDomClientX,
        receipt.expectedDomClientY,
        transition.button
      )
    ));
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
    this.#pending.surfaceChanged(event);
  }
}
