import type { TrustedInputTerminalEvidenceRecord } from "../../shared/generated";

const MAX_RECENT_TERMINALS = 128;
const terminals: TrustedInputTerminalEvidenceRecord[] = [];

export function recordTrustedInputTerminal(
  record: TrustedInputTerminalEvidenceRecord
): void {
  const frozen = Object.freeze({ ...record });
  if (record.intent === "cleanup") {
    const reversedIndex = [...terminals].reverse().findIndex(candidate =>
      candidate.intent === "normal" && candidate.requestId === record.requestId &&
      candidate.roleId === record.roleId && candidate.inputEpoch === record.inputEpoch &&
      candidate.surfaceGeneration === record.surfaceGeneration
    );
    if (reversedIndex >= 0) {
      const index = terminals.length - 1 - reversedIndex;
      terminals[index] = Object.freeze({
        ...terminals[index]!,
        cleanupOutcome: record.cleanupOutcome,
        recoveryOutcome: record.recoveryOutcome
      });
    }
  }
  terminals.push(frozen);
  if (terminals.length > MAX_RECENT_TERMINALS) {
    terminals.splice(0, terminals.length - MAX_RECENT_TERMINALS);
  }
}

export function recentTrustedInputTerminals(): TrustedInputTerminalEvidenceRecord[] {
  return terminals.map(record => ({ ...record }));
}

/** Test-only reset; production ownership remains process-memory bounded. */
export function resetTrustedInputTerminalJournalForTest(): void {
  terminals.splice(0);
}
