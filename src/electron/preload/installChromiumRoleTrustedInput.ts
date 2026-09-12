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
import {
  mergeChromiumPhysicalModifiers,
  validChromiumPhysicalModifierCodes
} from "../ipc/chromiumTrustedInputPhysicalModifiers";

const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_TYPES = new Set([
  "keydown", "keyup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"
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
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[];
  observationSequence: number;
  shortcutSuppressionArmed: boolean;
}

export interface ChromiumRoleTrustedInputOverlayGuardPort {
  arm: (input: Readonly<{
    frameToken: string;
    inputSequence: string;
    code: string;
    phases: readonly ("keydown" | "keyup")[];
    repeat: boolean;
  }>) => Promise<Readonly<{
    armed: boolean;
    physicalModifierCodes: readonly string[];
  }>>;
  clear: (input: Readonly<{
    frameToken: string;
    inputSequence: string;
  }>) => Promise<boolean>;
  snapshot: (input: Readonly<{
    frameToken: string;
    inputSequence: string;
  }>) => Promise<Readonly<{
    admitted: boolean;
    physicalModifierCodes: readonly string[];
  }>>;
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
    type === "auxclick" || type === "contextmenu";
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
    record.expectedEvents.length > 10
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
    if (!exactKeys(suppression, ["code", "phases", "repeat"]) ||
      typeof suppression.code !== "string" ||
      suppression.code.length === 0 || suppression.code.length > 128 ||
      suppression.code !== suppression.code.trim() ||
      !Array.isArray(suppressionPhases) || suppressionPhases.length < 1 ||
      suppressionPhases.length > 2 ||
      suppressionPhases.some((phase, index) =>
        (phase !== "keydown" && phase !== "keyup") ||
        (index > 0 && suppressionPhases[index - 1] === phase)
      ) || typeof suppression.repeat !== "boolean") return null;
    const keyboardEvents = expectedEvents as ChromiumRoleTrustedInputExpectedEvent[];
    if (keyboardEvents.some((event) =>
      (event.type !== "keydown" && event.type !== "keyup") ||
      event.code !== suppression.code || event.repeat !== suppression.repeat
    ) || keyboardEvents.map((event) => event.type).join("\n") !==
      suppressionPhases.join("\n")) return null;
    shortcutSuppression = Object.freeze({
      code: suppression.code,
      phases: Object.freeze([...suppressionPhases]) as readonly ("keydown" | "keyup")[],
      repeat: suppression.repeat
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
  const executeClear = (
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
      Promise.resolve(webFrame.executeJavaScriptInIsolatedWorld(
        CHROMIUM_ROLE_OVERLAY_WORLD_ID,
        [{ code: `(() => {
      const frameToken = ${JSON.stringify(input.frameToken)};
      const inputSequence = ${JSON.stringify(input.inputSequence)};
      const controller = globalThis.__rionStudioMacroOverlay;
      const armed = globalThis.__rionStudioDocumentInstanceId === frameToken &&
        controller?.suppressShortcutSequence?.(
          inputSequence,
          ${JSON.stringify(input.code)},
          ${JSON.stringify(input.phases)},
          ${JSON.stringify(input.repeat)}
        ) === true;
      const observedPhysicalModifierCodes = controller?.physicalModifierCodes?.();
      const physicalModifierCodes = armed && Array.isArray(observedPhysicalModifierCodes)
        ? observedPhysicalModifierCodes : [];
      return Object.freeze({ armed, frameToken, inputSequence, physicalModifierCodes });
    })()`, url: "rion-studio://chromium-trusted-input-guard-arm.js" }],
        false
      )).then((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return Object.freeze({ armed: false, physicalModifierCodes: [] });
        }
        const record = value as Record<string, unknown>;
        const codes = record.physicalModifierCodes;
        const validCodes = validChromiumPhysicalModifierCodes(codes);
        return Object.freeze({
          armed: exactKeys(record, [
            "armed", "frameToken", "inputSequence", "physicalModifierCodes"
          ]) && record.frameToken === input.frameToken &&
            record.inputSequence === input.inputSequence && record.armed === true && validCodes,
          physicalModifierCodes: validCodes ? Object.freeze([...codes]) : []
        });
      }),
    clear: (input: Parameters<ChromiumRoleTrustedInputOverlayGuardPort["clear"]>[0]) =>
      executeClear(input, `(() => {
      const frameToken = ${JSON.stringify(input.frameToken)};
      const inputSequence = ${JSON.stringify(input.inputSequence)};
      const controller = globalThis.__rionStudioMacroOverlay;
      const cleared = globalThis.__rionStudioDocumentInstanceId === frameToken &&
        controller?.clearSuppressedShortcut?.(inputSequence) === true;
      return Object.freeze({ cleared, frameToken, inputSequence });
    })()`, "cleared", "rion-studio://chromium-trusted-input-guard-clear.js"),
    snapshot: (input: Parameters<
      ChromiumRoleTrustedInputOverlayGuardPort["snapshot"]
    >[0]) => Promise.resolve(webFrame.executeJavaScriptInIsolatedWorld(
      CHROMIUM_ROLE_OVERLAY_WORLD_ID,
      [{ code: `(() => {
      const frameToken = ${JSON.stringify(input.frameToken)};
      const inputSequence = ${JSON.stringify(input.inputSequence)};
      const controller = globalThis.__rionStudioMacroOverlay;
      const observed = controller?.physicalModifierCodes?.();
      const admitted = globalThis.__rionStudioDocumentInstanceId === frameToken &&
        Array.isArray(observed);
      return Object.freeze({
        admitted,
        frameToken,
        inputSequence,
        physicalModifierCodes: admitted ? observed : []
      });
    })()`, url: "rion-studio://chromium-trusted-input-modifier-snapshot.js" }],
      false
    )).then(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return Object.freeze({ admitted: false, physicalModifierCodes: [] });
      }
      const record = value as Record<string, unknown>;
      const validCodes = validChromiumPhysicalModifierCodes(
        record.physicalModifierCodes
      );
      const admitted = exactKeys(record, [
        "admitted", "frameToken", "inputSequence", "physicalModifierCodes"
      ]) && record.admitted === true && record.frameToken === input.frameToken &&
        record.inputSequence === input.inputSequence && validCodes;
      return Object.freeze({
        admitted,
        physicalModifierCodes: admitted
          ? Object.freeze([...(record.physicalModifierCodes as readonly string[])])
          : []
      });
    })
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
    event.type === "click" || event.type === "auxclick" || event.type === "contextmenu";
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
      observationSequence: 0,
      shortcutSuppressionArmed: false
    };
    pending = candidate;
    const acknowledge = (physicalModifierCodes: readonly string[]): void => {
      candidate.expectedEvents = mergeChromiumPhysicalModifiers(
        candidate.expectedEvents,
        physicalModifierCodes,
        control.shortcutSuppression?.code ?? null
      );
      send({
        ...candidate.identity,
        kind: "armed",
        expectedEventCount: candidate.expectedEvents.length,
        physicalModifierCodes
      });
    };
    if (!control.shortcutSuppression) {
      if (!overlayGuards) {
        acknowledge([]);
        return;
      }
      void overlayGuards.snapshot(candidate.identity).then(result => {
        if (pending !== candidate) return;
        if (!result.admitted) {
          pending = null;
          send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
          return;
        }
        acknowledge(result.physicalModifierCodes);
      }).catch(() => {
        if (pending !== candidate) return;
        pending = null;
        send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
      });
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
      phases: control.shortcutSuppression.phases,
      repeat: control.shortcutSuppression.repeat
    }).then((result) => {
      if (pending !== candidate) {
        if (result.armed) void overlayGuards.clear({
          frameToken: control.frameToken,
          inputSequence: control.inputSequence
        }).catch(() => false);
        return;
      }
      if (!result.armed) {
        pending = null;
        send({ ...candidate.identity, kind: "rejected", reason: "invalid-control" });
        return;
      }
      candidate.shortcutSuppressionArmed = true;
      acknowledge(result.physicalModifierCodes);
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
    const receipt: ChromiumRoleTrustedInputDomReceipt = Object.freeze({
      ...current.identity,
      ...observed,
      kind: "input",
      observationSequence: ++current.observationSequence,
      isTrusted: event.isTrusted
    });
    // Main correlates the raw ordered DOM stream with the native physical
    // evidence journal. The preload must not let an unrelated player event
    // consume or terminalize the expected CDP sequence.
    queueMicrotask(() => send(receipt));
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
