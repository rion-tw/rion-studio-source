import type {
  ChromiumRoleTrustedInputReceipt, ChromiumRoleTrustedInputDomReceipt,
  ChromiumRoleTrustedInputExpectedEvent
} from "../ipc/chromiumRoleTrustedInputProtocol";
import { validChromiumPhysicalModifierCodes } from
  "../ipc/chromiumTrustedInputPhysicalModifiers";

const MAX_RECEIPT_BYTES = 16 * 1024;
const INPUT_SEQUENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function serializedSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

export function parseTrustedInputDomReceipt(
  value: unknown, invalid: (message: string) => never
): ChromiumRoleTrustedInputReceipt {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    serializedSize(value) > MAX_RECEIPT_BYTES
  ) {
    invalid("The trusted-input preload receipt is malformed or too large.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "document-input" && exactKeys(record, [
    "kind", "frameToken", "documentObservationSequence", "isTrusted", "altKey", "button",
    "clientX", "clientY", "code", "ctrlKey", "metaKey", "repeat", "shiftKey", "type"
  ]) && typeof record.frameToken === "string" && record.frameToken.length > 0 &&
    Number.isSafeInteger(record.documentObservationSequence) &&
    (record.documentObservationSequence as number) > 0 && typeof record.isTrusted === "boolean" &&
    typeof record.type === "string" &&
    ["keydown", "keyup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"].includes(record.type) &&
    (record.code === null || (typeof record.code === "string" && record.code.length <= 64)) &&
    typeof record.altKey === "boolean" && typeof record.ctrlKey === "boolean" &&
    typeof record.metaKey === "boolean" && typeof record.shiftKey === "boolean" &&
    typeof record.repeat === "boolean") {
    return record as unknown as ChromiumRoleTrustedInputReceipt;
  }
  const identityValid = typeof record.roleId === "string" &&
    Number.isSafeInteger(record.generation) && (record.generation as number) >= 1 &&
    typeof record.frameToken === "string" && record.frameToken.length > 0 &&
    typeof record.inputSequence === "string" &&
    INPUT_SEQUENCE_PATTERN.test(record.inputSequence);
  const baseKeys = ["frameToken", "generation", "inputSequence", "kind", "roleId"];
  if (!identityValid) {
    invalid("The trusted-input preload receipt has an invalid identity.");
  }
  if (record.kind === "armed" && exactKeys(record, [
    ...baseKeys, "expectedEventCount", "modifierDisposition", "modifierProjectionCodes",
    "physicalModifierCodes",
    ...(record.documentObservationWatermark !== undefined ? ["documentObservationWatermark"] : []),
    ...(record.deliveryReceiptVersion !== undefined ? ["deliveryReceiptVersion"] : [])
  ])) {
    if ((record.deliveryReceiptVersion !== undefined && record.deliveryReceiptVersion !== 1) ||
      (record.documentObservationWatermark !== undefined &&
        (!Number.isSafeInteger(record.documentObservationWatermark) || (record.documentObservationWatermark as number) < 0)) ||
      !Number.isSafeInteger(record.expectedEventCount) ||
      (record.expectedEventCount as number) < 0 ||
      (record.expectedEventCount as number) > 10 ||
      !["dispatch", "adoptPhysical", "releaseOwnership"]
        .includes(String(record.modifierDisposition)) ||
      (record.modifierDisposition === "dispatch" && record.expectedEventCount === 0) ||
      (record.modifierDisposition !== "dispatch" && record.expectedEventCount !== 0) ||
      !validChromiumPhysicalModifierCodes(record.physicalModifierCodes) ||
      !validChromiumPhysicalModifierCodes(record.modifierProjectionCodes) ||
      !(record.modifierProjectionCodes as readonly string[]).every(code =>
        (record.physicalModifierCodes as readonly string[]).includes(code))) {
      invalid("The arm receipt is invalid.");
    }
    return record as unknown as ChromiumRoleTrustedInputReceipt;
  }
  if (record.kind === "cancelled" && exactKeys(record, baseKeys)) {
    return record as unknown as ChromiumRoleTrustedInputReceipt;
  }
  if (record.kind === "rejected" && exactKeys(record, [...baseKeys, "reason"]) &&
    ["busy", "invalid-control", "stale-frame"].includes(String(record.reason))) {
    return record as unknown as ChromiumRoleTrustedInputReceipt;
  }
  if (record.kind === "input" && exactKeys(record, [
    ...baseKeys, "altKey", "button", "clientX", "clientY", "code", "ctrlKey",
    "isTrusted", "metaKey", "observationSequence", "repeat", "shiftKey", "type",
    ...(record.documentObservationSequence !== undefined ? ["documentObservationSequence"] : [])
  ])) {
    const valid = Number.isSafeInteger(record.observationSequence) &&
      (record.observationSequence as number) >= 1 &&
      typeof record.isTrusted === "boolean" &&
      typeof record.altKey === "boolean" && typeof record.ctrlKey === "boolean" &&
      typeof record.metaKey === "boolean" && typeof record.shiftKey === "boolean" &&
      typeof record.repeat === "boolean" && typeof record.type === "string";
    if (valid) return record as unknown as ChromiumRoleTrustedInputReceipt;
  }
  invalid("The trusted-input preload receipt contains unsupported fields.");
}
export function matchesTrustedInputExpectedEvent(
  receipt: ChromiumRoleTrustedInputDomReceipt,
  expected: ChromiumRoleTrustedInputExpectedEvent
): boolean {
  return receipt.isTrusted === true &&
    receipt.type === expected.type && receipt.code === expected.code &&
    receipt.button === expected.button && receipt.clientX === expected.clientX &&
    receipt.clientY === expected.clientY && receipt.altKey === expected.altKey &&
    receipt.ctrlKey === expected.ctrlKey && receipt.metaKey === expected.metaKey &&
    receipt.shiftKey === expected.shiftKey && receipt.repeat === expected.repeat;
}

export function chromiumDomModifierMask(input: Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}>): number {
  return (input.altKey ? 1 : 0) |
    (input.ctrlKey ? 2 : 0) |
    (input.metaKey ? 4 : 0) |
    (input.shiftKey ? 8 : 0);
}

export interface ChromiumModifierProjectionObservation {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly dispatchId: string;
  readonly metaKey: boolean;
  readonly modifierProjection: true;
  readonly phase: "keydown";
  readonly shiftKey: boolean;
}

export function parseChromiumModifierProjectionObservation(
  value: unknown
): ChromiumModifierProjectionObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    "altKey", "code", "ctrlKey", "dispatchId", "metaKey",
    "modifierProjection", "phase", "shiftKey"
  ]) || record.modifierProjection !== true || record.phase !== "keydown" ||
    typeof record.code !== "string" || record.code.length === 0 ||
    record.code.length > 128 || record.code !== record.code.trim() ||
    typeof record.dispatchId !== "string" ||
    !INPUT_SEQUENCE_PATTERN.test(record.dispatchId) ||
    typeof record.altKey !== "boolean" || typeof record.ctrlKey !== "boolean" ||
    typeof record.metaKey !== "boolean" || typeof record.shiftKey !== "boolean") {
    return null;
  }
  return Object.freeze(record) as unknown as ChromiumModifierProjectionObservation;
}
