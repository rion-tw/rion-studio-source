import type {
  ChromiumRoleTrustedInputReceipt, ChromiumRoleTrustedInputDomReceipt,
  ChromiumRoleTrustedInputExpectedEvent
} from "../ipc/chromiumRoleTrustedInputProtocol";

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
  const identityValid = typeof record.roleId === "string" &&
    Number.isSafeInteger(record.generation) && (record.generation as number) >= 1 &&
    typeof record.frameToken === "string" && record.frameToken.length > 0 &&
    typeof record.inputSequence === "string" &&
    INPUT_SEQUENCE_PATTERN.test(record.inputSequence);
  const baseKeys = ["frameToken", "generation", "inputSequence", "kind", "roleId"];
  if (!identityValid) {
    invalid("The trusted-input preload receipt has an invalid identity.");
  }
  if (record.kind === "armed" && exactKeys(record, [...baseKeys, "expectedEventCount"])) {
    if (!Number.isSafeInteger(record.expectedEventCount) ||
      (record.expectedEventCount as number) < 1 ||
      (record.expectedEventCount as number) > 3) {
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
    "isTrusted", "matches", "metaKey", "observedIndex", "repeat", "shiftKey", "type"
  ])) {
    const valid = Number.isSafeInteger(record.observedIndex) &&
      (record.observedIndex as number) >= 0 &&
      typeof record.isTrusted === "boolean" && typeof record.matches === "boolean" &&
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
  return receipt.matches === true && receipt.isTrusted === true &&
    receipt.type === expected.type && receipt.code === expected.code &&
    receipt.button === expected.button && receipt.clientX === expected.clientX &&
    receipt.clientY === expected.clientY && receipt.altKey === expected.altKey &&
    receipt.ctrlKey === expected.ctrlKey && receipt.metaKey === expected.metaKey &&
    receipt.shiftKey === expected.shiftKey && receipt.repeat === expected.repeat;
}
