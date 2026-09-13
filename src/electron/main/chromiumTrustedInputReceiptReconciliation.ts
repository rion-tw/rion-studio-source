import type {
  ChromiumRoleTrustedInputDomReceipt,
  ChromiumRoleTrustedInputExpectedEvent
} from "../ipc/chromiumRoleTrustedInputProtocol";
import { matchesTrustedInputExpectedEvent } from "./chromiumTrustedInputDomReceipt";
import {
  ChromiumPhysicalInputEvidenceLane,
  type ChromiumPhysicalInputEvidenceClassification,
  type ChromiumPhysicalInputEvidenceSnapshot
} from "./chromiumPhysicalInputEvidence";

interface ChromiumTrustedInputReceiptDecision {
  readonly receipt: ChromiumRoleTrustedInputDomReceipt;
  readonly classification: Exclude<
    ChromiumPhysicalInputEvidenceClassification, "indeterminate"
  >;
  readonly expectedEvent?: ChromiumRoleTrustedInputExpectedEvent;
}

interface ChromiumTrustedInputReceiptReconciliation {
  readonly status: "advanced" | "deferred" | "mismatch" | "indeterminate";
  readonly nextExpectedIndex: number;
  readonly remaining: readonly ChromiumRoleTrustedInputDomReceipt[];
  readonly decisions: readonly ChromiumTrustedInputReceiptDecision[];
}

/**
 * Reconciles DOM receipt order with native physical provenance. A native edge
 * may be counted before its DOM event while an intervening CDP event reaches
 * the preload first, so an ambiguous matching receipt remains queued until a
 * later observation makes the assignment exact.
 */
export function reconcileChromiumTrustedInputReceipts(
  evidence: ChromiumPhysicalInputEvidenceLane,
  snapshot: ChromiumPhysicalInputEvidenceSnapshot,
  expectedEvents: readonly ChromiumRoleTrustedInputExpectedEvent[],
  nextExpectedIndex: number,
  observations: readonly ChromiumRoleTrustedInputDomReceipt[]
): ChromiumTrustedInputReceiptReconciliation {
  const queue = [...observations];
  const decisions: ChromiumTrustedInputReceiptDecision[] = [];
  let expectedIndex = nextExpectedIndex;

  const finish = (
    status: ChromiumTrustedInputReceiptReconciliation["status"]
  ): ChromiumTrustedInputReceiptReconciliation => ({
    status,
    nextExpectedIndex: expectedIndex,
    remaining: Object.freeze(queue),
    decisions: Object.freeze(decisions)
  });

  while (queue.length > 0 && expectedIndex < expectedEvents.length) {
    const expected = expectedEvents[expectedIndex]!;
    const physicalCandidate = queue.findIndex((receipt) => {
      if (matchesTrustedInputExpectedEvent(receipt, expected)) return false;
      const pending = evidence.pendingPhysicalCount(snapshot, receipt);
      return pending !== null && pending > 0n;
    });
    if (physicalCandidate >= 0) {
      const [receipt] = queue.splice(physicalCandidate, 1);
      const classification = evidence.classify(snapshot, receipt);
      if (classification === "indeterminate") return finish("indeterminate");
      if (classification !== "physical") return finish("mismatch");
      decisions.push({ receipt, classification, expectedEvent: expected });
      continue;
    }

    const matchIndex = queue.findIndex((receipt) =>
      matchesTrustedInputExpectedEvent(receipt, expected)
    );
    if (matchIndex < 0 || matchIndex > 0) return finish("mismatch");
    const receipt = queue[0]!;
    const pending = evidence.pendingPhysicalCount(snapshot, receipt);
    if (pending === null) return finish("indeterminate");
    if (pending > 0n) {
      const categoryCount = queue.filter((candidate) =>
        evidence.sharesCategory(snapshot, candidate, receipt)
      ).length;
      if (BigInt(categoryCount) <= pending) return finish("deferred");
      const classification = evidence.classify(snapshot, receipt);
      if (classification === "indeterminate") return finish("indeterminate");
      if (classification !== "physical") return finish("mismatch");
      queue.shift();
      decisions.push({ receipt, classification, expectedEvent: expected });
      continue;
    }
    const classification = evidence.classify(snapshot, receipt);
    if (classification === "indeterminate") return finish("indeterminate");
    if (classification !== "automatic") return finish("mismatch");
    queue.shift();
    decisions.push({ receipt, classification, expectedEvent: expected });
    expectedIndex += 1;
  }

  while (queue.length > 0) {
    const receipt = queue[0]!;
    const pending = evidence.pendingPhysicalCount(snapshot, receipt);
    if (pending === null) return finish("indeterminate");
    if (pending > 0n) {
      const classification = evidence.classify(snapshot, receipt);
      if (classification !== "physical") return finish("indeterminate");
      queue.shift();
      decisions.push({ receipt, classification });
      continue;
    }
    return finish("mismatch");
  }
  return finish(decisions.length > 0 ? "advanced" : "deferred");
}
