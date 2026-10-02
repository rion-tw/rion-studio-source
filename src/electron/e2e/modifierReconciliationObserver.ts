import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrustedInputTerminalEvidenceRecord } from "../../shared/generated";
import { subscribeTrustedInputTerminals } from "../main/chromiumTrustedInputTerminalJournal";

/** Preserve exact reconciliation evidence independently of compact operational logs. */
export function installModifierReconciliationObserver(artifactDirectory: string): () => void {
  const records: TrustedInputTerminalEvidenceRecord[] = [];
  return subscribeTrustedInputTerminals(record => {
    if (!record.compatibleModifierEvidence?.transitions.some(
      transition => transition.source === "physical-reconcile"
    )) return;
    records.push(structuredClone(record));
    if (records.length > 32) records.shift();
    writeFileSync(join(artifactDirectory, "electron-modifier-reconciliation.json"),
      `${JSON.stringify(records, null, 2)}\n`);
  });
}
