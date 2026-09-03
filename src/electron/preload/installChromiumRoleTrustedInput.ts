import {
  CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL,
  CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
  type ChromiumRoleTrustedInputControlEnvelope,
  type ChromiumRoleTrustedInputDomReceipt,
  type ChromiumRoleTrustedInputExpectedEvent,
  type ChromiumRoleTrustedInputEventType,
  type ChromiumRoleTrustedInputIdentity,
  type ChromiumRoleTrustedInputReceipt
} from "../ipc/chromiumRoleTrustedInputProtocol";
import { CHROMIUM_ROLE_OVERLAY_WORLD_ID } from
  "../ipc/chromiumRoleOverlayProtocol";

const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_TYPES = new Set([
  "keydown", "keyup", "mousedown", "mouseup", "click", "auxclick"
]);
const MAX_CLIENT_COORDINATE = 1_000_000;

export interface ChromiumRoleTrustedInputIpcRendererPort {
  on: (
    channel: string,
    listener: (event: unknown, envelope: unknown) => void
  ) => unknown;
  send: (channel: string, receipt: ChromiumRoleTrustedInputReceipt) => void;
}

export interface ChromiumRoleTrustedInputEventPort {
  readonly type: string;
  readonly code?: string;
  readonly button?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat?: boolean;
  readonly isTrusted: boolean;
}

export interface ChromiumRoleTrustedInputEventTargetPort {
  addEventListener: (
    type: string,
    listener: (event: ChromiumRoleTrustedInputEventPort) => void,
    options: Readonly<{ capture: true }>
  ) => void;
}

interface PendingInput {
  readonly identity: ChromiumRoleTrustedInputIdentity;
  readonly expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  nextIndex: number;
  shortcutSuppressionArmed: boolean;
}

export interface ChromiumRoleTrustedInputOverlayGuardPort {
  arm: (input: Readonly<{
    frameToken: string;
    inputSequence: string;
    code: string;
    phases: readonly ("keydown" | "keyup")[];
  }>) => Promise<boolean>;
  clear: (input: Readonly<{
    frameToken: string;
    inputSequence: string;
  }>) => Promise<boolean>;
}

export interface ChromiumRoleTrustedInputOverlayGuardWebFramePort {
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean
  ) => Promise<unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !value.includes("/") &&
    !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validFrameToken(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim();
}

function validEventType(value: unknown): value is ChromiumRoleTrustedInputEventType {
  return typeof value === "string" && EVENT_TYPES.has(value);
}

function validClientCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= MAX_CLIENT_COORDINATE;
}

function parseExpectedEvent(value: unknown): ChromiumRoleTrustedInputExpectedEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    "altKey", "button", "clientX", "clientY", "code", "ctrlKey",
    "metaKey", "repeat", "shiftKey", "type"
  ])) return null;
  const type = record.type;
  const keyboard = type === "keydown" || type === "keyup";
  const mouse = type === "mousedown" || type === "mouseup" || type === "click" ||
    type === "auxclick";
  if (
    !validEventType(type) ||
    typeof record.altKey !== "boolean" ||
    typeof record.ctrlKey !== "boolean" ||
    typeof record.metaKey !== "boolean" ||
    typeof record.shiftKey !== "boolean" ||
    typeof record.repeat !== "boolean" ||
    (keyboard
      ? typeof record.code !== "string" || record.code.length === 0 ||
        record.code.length > 128 || record.code !== record.code.trim() ||
        record.button !== null || record.clientX !== null || record.clientY !== null
      : !mouse || record.code !== null || record.repeat !== false ||
        !Number.isSafeInteger(record.button) || (record.button as number) < 0 ||
        (record.button as number) > 2 ||
        !((record.clientX === null && record.clientY === null) ||
          (validClientCoordinate(record.clientX) &&
            validClientCoordinate(record.clientY))))
  ) return null;
  return Object.freeze({
    type,
    code: keyboard ? record.code as string : null,
    button: mouse ? record.button as number : null,
    clientX: mouse ? record.clientX as number : null,
    clientY: mouse ? record.clientY as number : null,
    altKey: record.altKey,
    ctrlKey: record.ctrlKey,
    metaKey: record.metaKey,
    shiftKey: record.shiftKey,
    repeat: record.repeat
  });
}

function parseIdentity(record: Record<string, unknown>): ChromiumRoleTrustedInputIdentity | null {
  if (
    !validIdentifier(record.roleId) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    !validFrameToken(record.frameToken) ||
    typeof record.inputSequence !== "string" ||
    !INPUT_SEQUENCE_PATTERN.test(record.inputSequence)
  ) return null;
  return Object.freeze({
    roleId: record.roleId,
    generation: record.generation as number,
    frameToken: record.frameToken,
    inputSequence: record.inputSequence
  });
}

function parseControl(value: unknown): ChromiumRoleTrustedInputControlEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const identity = parseIdentity(record);
  if (!identity) return null;
  if (record.kind === "cancel") {
    return exactKeys(record, [
      "frameToken", "generation", "inputSequence", "kind", "roleId"
    ]) ? Object.freeze({ ...identity, kind: "cancel" }) : null;
  }
  if (
    record.kind !== "arm" ||
    !exactKeys(record, [
      "expectedEvents", "frameToken", "generation", "inputSequence", "kind", "roleId",
      "shortcutSuppression"
    ]) ||
    !Array.isArray(record.expectedEvents) ||
    record.expectedEvents.length === 0 ||
    record.expectedEvents.length > 3
  ) return null;
  const expectedEvents = record.expectedEvents.map(parseExpectedEvent);
  if (expectedEvents.some((event) => event === null)) return null;
  let shortcutSuppression = null;
  if (record.shortcutSuppression !== null) {
    if (!record.shortcutSuppression ||
      typeof record.shortcutSuppression !== "object" ||
      Array.isArray(record.shortcutSuppression)) return null;
    const suppression = record.shortcutSuppression as Record<string, unknown>;
    const suppressionPhases = suppression.phases;
    if (!exactKeys(suppression, ["code", "phases"]) ||
      typeof suppression.code !== "string" ||
      suppression.code.length === 0 || suppression.code.length > 128 ||
      suppression.code !== suppression.code.trim() ||
      !Array.isArray(suppressionPhases) || suppressionPhases.length < 1 ||
      suppressionPhases.length > 2 ||
      suppressionPhases.some((phase, index) =>
        (phase !== "keydown" && phase !== "keyup") ||
        (index > 0 && suppressionPhases[index - 1] === phase)
      )) return null;
    const keyboardEvents = expectedEvents as ChromiumRoleTrustedInputExpectedEvent[];
    if (keyboardEvents.some((event) =>
      (event.type !== "keydown" && event.type !== "keyup") ||
      event.code !== suppression.code
    ) || keyboardEvents.map((event) => event.type).join("\n") !==
      suppressionPhases.join("\n")) return null;
    shortcutSuppression = Object.freeze({
      code: suppression.code,
      phases: Object.freeze([...suppressionPhases]) as readonly ("keydown" | "keyup")[]
    });
  }
  return Object.freeze({
    ...identity,
    kind: "arm",
    expectedEvents: Object.freeze(
      expectedEvents as ChromiumRoleTrustedInputExpectedEvent[]
    ),
    shortcutSuppression
  });
}

function exactGuardResult(
  value: unknown,
  input: Readonly<{ frameToken: string; inputSequence: string }>,
  field: "armed" | "cleared"
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, [field, "frameToken", "inputSequence"]) &&
    record.frameToken === input.frameToken &&
    record.inputSequence === input.inputSequence && record[field] === true;
}

export function createChromiumRoleTrustedInputOverlayGuard(
  webFrame: ChromiumRoleTrustedInputOverlayGuardWebFramePort
): ChromiumRoleTrustedInputOverlayGuardPort {
  const execute = (
    input: Readonly<{ frameToken: string; inputSequence: string }>,
    expression: string,
    field: "armed" | "cleared",
    url: string
  ): Promise<boolean> => Promise.resolve(webFrame.executeJavaScriptInIsolatedWorld(
    CHROMIUM_ROLE_OVERLAY_WORLD_ID,
    [{ code: expression, url }],
    false
  )).then((value) => exactGuardResult(value, input, field));
  return Object.freeze({
    arm: (input: Parameters<ChromiumRoleTrustedInputOverlayGuardPort["arm"]>[0]) =>
      execute(input, `(() => {
      const frameToken = ${JSON.stringify(input.frameToken)};
      const inputSequence = ${JSON.stringify(input.inputSequence)};
      const controller = globalThis.__rionStudioMacroOverlay;
      const armed = globalThis.__rionStudioDocumentInstanceId === frameToken &&
        controller?.suppressShortcutSequence?.(
          inputSequence,
          ${JSON.stringify(input.code)},
          ${JSON.stringify(input.phases)}
        ) === true;
      return Object.freeze({ armed, frameToken, inputSequence });
    })()`, "armed", "rion-studio://chromium-trusted-input-guard-arm.js"),
    clear: (input: Parameters<ChromiumRoleTrustedInputOverlayGuardPort["clear"]>[0]) =>
      execute(input, `(() => {
      const frameToken = ${JSON.stringify(input.frameToken)};
      const inputSequence = ${JSON.stringify(input.inputSequence)};
      const controller = globalThis.__rionStudioMacroOverlay;
      const cleared = globalThis.__rionStudioDocumentInstanceId === frameToken &&
        controller?.clearSuppressedShortcut?.(inputSequence) === true;
      return Object.freeze({ cleared, frameToken, inputSequence });
    })()`, "cleared", "rion-studio://chromium-trusted-input-guard-clear.js")
  });
}

function sameIdentity(
  left: ChromiumRoleTrustedInputIdentity,
  right: ChromiumRoleTrustedInputIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.generation === right.generation &&
    left.frameToken === right.frameToken &&
    left.inputSequence === right.inputSequence;
}

function observedEvent(
  event: ChromiumRoleTrustedInputEventPort
): ChromiumRoleTrustedInputExpectedEvent | null {
  const keyboard = event.type === "keydown" || event.type === "keyup";
  const mouse = event.type === "mousedown" || event.type === "mouseup" ||
    event.type === "click" || event.type === "auxclick";
  if (!keyboard && !mouse) return null;
  const candidate = {
    type: event.type,
    code: keyboard ? event.code ?? null : null,
    button: mouse ? event.button ?? null : null,
    clientX: mouse ? event.clientX ?? null : null,
    clientY: mouse ? event.clientY ?? null : null,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: keyboard ? event.repeat ?? false : false
  };
  return parseExpectedEvent(candidate);
}

function sameExpectedEvent(
  left: ChromiumRoleTrustedInputExpectedEvent,
  right: ChromiumRoleTrustedInputExpectedEvent
): boolean {
  const coordinatesMatch = right.clientX === null && right.clientY === null ||
    left.clientX === right.clientX && left.clientY === right.clientY;
  return left.type === right.type && left.code === right.code &&
    left.button === right.button && coordinatesMatch && left.altKey === right.altKey &&
    left.ctrlKey === right.ctrlKey && left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey && left.repeat === right.repeat;
}

/**
 * Installs a private, main-frame-only trusted DOM receipt lane. It exposes no
 * contextBridge value to page JavaScript; the random in-flight sequence is
 * delivered only over Electron's main-to-preload channel.
 */
export function installChromiumRoleTrustedInput(
  ipc: ChromiumRoleTrustedInputIpcRendererPort,
  frameToken: string,
  isMainFrame: boolean,
  target: ChromiumRoleTrustedInputEventTargetPort = globalTrustedInputEventTarget(),
  overlayGuards?: ChromiumRoleTrustedInputOverlayGuardPort
): boolean {
  if (!isMainFrame) return false;
  if (!validFrameToken(frameToken)) {
    throw new Error("The Chromium trusted-input preload requires an exact frame token.");
  }
  let pending: PendingInput | null = null;
  const send = (receipt: ChromiumRoleTrustedInputReceipt): void => {
    ipc.send(CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL, Object.freeze(receipt));
  };
  ipc.on(CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL, (_event, rawControl) => {
    const control = parseControl(rawControl);
    if (!control) return;
    if (control.frameToken !== frameToken) {
      send({ ...control, kind: "rejected", reason: "stale-frame" });
      return;
    }
    if (control.kind === "cancel") {
      if (pending && sameIdentity(pending.identity, control)) {
        const cancelled = pending;
        pending = null;
        if (cancelled.shortcutSuppressionArmed) {
          void overlayGuards?.clear({
            frameToken: control.frameToken,
            inputSequence: control.inputSequence
          }).catch(() => false);
        }
        send({ ...control, kind: "cancelled" });
      }
      return;
    }
    if (pending) {
      send({ ...control, kind: "rejected", reason: "busy" });
      return;
    }
    const candidate: PendingInput = {
      identity: Object.freeze({
        roleId: control.roleId,
        generation: control.generation,
        frameToken: control.frameToken,
        inputSequence: control.inputSequence
      }),
      expectedEvents: control.expectedEvents,
      nextIndex: 0,
      shortcutSuppressionArmed: false
    };
    pending = candidate;
    const acknowledge = (): void => send({
      ...candidate.identity,
      kind: "armed",
      expectedEventCount: candidate.expectedEvents.length
    });
    if (!control.shortcutSuppression) {
      acknowledge();
      return;
    }
    if (!overlayGuards) {
      pending = null;
      send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
      return;
    }
    void overlayGuards.arm({
      frameToken: control.frameToken,
      inputSequence: control.inputSequence,
      code: control.shortcutSuppression.code,
      phases: control.shortcutSuppression.phases
    }).then((armed) => {
      if (pending !== candidate) {
        if (armed) void overlayGuards.clear({
          frameToken: control.frameToken,
          inputSequence: control.inputSequence
        }).catch(() => false);
        return;
      }
      if (!armed) {
        pending = null;
        send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
        return;
      }
      candidate.shortcutSuppressionArmed = true;
      acknowledge();
    }).catch(() => {
      if (pending !== candidate) return;
      pending = null;
      send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
    });
  });

  const capture = (event: ChromiumRoleTrustedInputEventPort): void => {
    if (!pending) return;
    const observed = observedEvent(event);
    if (!observed) return;
    const current = pending;
    const observedIndex = current.nextIndex;
    const expected = current.expectedEvents[observedIndex]!;
    const matches = event.isTrusted === true && sameExpectedEvent(observed, expected);
    const receipt: ChromiumRoleTrustedInputDomReceipt = Object.freeze({
      ...current.identity,
      ...observed,
      kind: "input",
      observedIndex,
      isTrusted: event.isTrusted,
      matches
    });
    if (!matches) {
      pending = null;
      if (current.shortcutSuppressionArmed) {
        void overlayGuards?.clear({
          frameToken: current.identity.frameToken,
          inputSequence: current.identity.inputSequence
        }).catch(() => false);
      }
    } else {
      current.nextIndex += 1;
      if (current.nextIndex === current.expectedEvents.length) pending = null;
    }
    send(receipt);
  };
  for (const type of EVENT_TYPES) {
    target.addEventListener(type, capture, { capture: true });
  }
  return true;
}

function globalTrustedInputEventTarget(): ChromiumRoleTrustedInputEventTargetPort {
  const addEventListener = Reflect.get(globalThis, "addEventListener");
  if (typeof addEventListener !== "function") {
    throw new Error("The Chromium trusted-input preload requires a DOM event target.");
  }
  return {
    addEventListener: (type, listener, options) => {
      Reflect.apply(addEventListener, globalThis, [type, listener, options]);
    }
  };
}
