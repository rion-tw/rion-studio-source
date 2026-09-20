import type { CompatibleReceiptValidationRecord } from "../../shared/generated";
import type { ChromiumCompatibleInputCommand as Command, ChromiumCompatibleInputReceipt as Receipt } from "../ipc/chromiumCompatibleInputProtocol";
import { compatibleInputEventCount, compatibleInputEvidenceFailure } from "./chromiumCompatibleInputEvidence";

function summary(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 160);
  if (value === null || ["number", "boolean", "undefined"].includes(typeof value)) return String(value);
  return Array.isArray(value) ? "<array>" : "<object>";
}

/** Claims are diagnostic only until every identity, delivery and evidence check passes. */
export function validateCompatibleInputReceipt(command: Command, raw: unknown,
  fence: { nowMs: number; documentCurrent: boolean; target: string | null }):
  { receipt: Receipt; validation?: never } | { receipt?: never; validation: CompatibleReceiptValidationRecord } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const receipt = value as unknown as Receipt;
  const expectedCount = compatibleInputEventCount(command);
  const reject = (reason: string, field: string, expected: unknown, received: unknown) => {
    const evidence = value?.modifierEvidence as Record<string, unknown> | undefined;
    const count = value?.eventCount;
    const mask = evidence?.eventModifierMask;
    return { validation: {
      reason, field, expected: summary(expected), received: summary(received), expectedEventCount: expectedCount,
      ...(typeof value?.status === "string" && ["applied", "failed", "indeterminate"].includes(value.status)
        ? { reportedStatus: value.status } : {}),
      ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 0xffffffff
        ? { reportedEventCount: count } : {}),
      ...(typeof mask === "number" && Number.isInteger(mask) && mask >= 0 && mask <= 15
        ? { reportedModifierMask: mask } : {})
    } };
  };
  if (!value) return reject("shape", "receipt", "object", raw);
  if (fence.nowMs >= command.deadlineMs) return reject("deadline", "receivedAtMs", command.deadlineMs, fence.nowMs);
  if (!fence.documentCurrent) return reject("document", "documentCurrent", true, false);
  for (const key of ["requestId", "ownerId", "roleId", "inputEpoch", "generation", "frameToken", "documentInstanceId", "sequence"] as const) {
    if (value[key] !== command[key]) return reject("identity", key, command[key], value[key]);
  }
  if (value.isTrusted !== false) return reject("trust", "isTrusted", false, value.isTrusted);
  if (!["applied", "failed", "indeterminate"].includes(receipt.status))
    return reject("status", "status", "applied|failed|indeterminate", value.status);
  if (!Number.isSafeInteger(receipt.eventCount) || receipt.eventCount < 0 || receipt.eventCount > expectedCount ||
      (receipt.status === "failed" && receipt.eventCount !== 0))
    return reject("event-count", "eventCount", receipt.status === "failed" ? 0 : expectedCount, value.eventCount);
  if ((receipt.status === "applied" && receipt.errorCode !== null) ||
      (receipt.status !== "applied" && (typeof receipt.errorCode !== "string" ||
        !/^SYSTEM_COMPATIBLE_INPUT_[A-Z_]+$/u.test(receipt.errorCode))))
    return reject("status", "errorCode", receipt.status === "applied" ? null : "SYSTEM_COMPATIBLE_INPUT_*", value.errorCode);
  const evidenceFailure = compatibleInputEvidenceFailure(command, receipt);
  if (evidenceFailure) return reject(evidenceFailure.reason, evidenceFailure.field, evidenceFailure.expected, evidenceFailure.received);
  if (receipt.status === "applied") {
    if (receipt.eventCount !== compatibleInputEventCount(command, receipt))
      return reject("event-count", "eventCount", compatibleInputEventCount(command, receipt), receipt.eventCount);
    if (typeof receipt.targetToken !== "string" || receipt.targetToken.length === 0 ||
        (fence.target !== null && receipt.targetToken !== fence.target))
      return reject("target", "targetToken", fence.target ?? "nonempty original target", receipt.targetToken);
  }
  return { receipt };
}
