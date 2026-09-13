import type {
  TrustedInputDiagnosticsRecord,
  TrustedInputTerminalEvidenceRecord
} from "../../shared/generated";

const MAX_RECENT_TERMINALS = 128;
const MAX_RECENT_INCIDENTS = 32;
const terminals: TrustedInputTerminalEvidenceRecord[] = [];
const incidents: TrustedInputTerminalEvidenceRecord[] = [];
const listeners = new Set<(record: TrustedInputTerminalEvidenceRecord) => void>();
let droppedTerminalCount = 0;
let droppedIncidentCount = 0;

function cloneTerminal(
  record: TrustedInputTerminalEvidenceRecord
): TrustedInputTerminalEvidenceRecord {
  return {
    ...record,
    nativeProofChanges: [...record.nativeProofChanges],
    traceSteps: record.traceSteps.map(step => ({ ...step }))
  };
}

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
    const removed = terminals.length - MAX_RECENT_TERMINALS;
    terminals.splice(0, removed);
    droppedTerminalCount += removed;
  }
  if (record.terminalCode !== "APPLIED") {
    incidents.push(frozen);
    if (incidents.length > MAX_RECENT_INCIDENTS) {
      const removed = incidents.length - MAX_RECENT_INCIDENTS;
      incidents.splice(0, removed);
      droppedIncidentCount += removed;
    }
  }
  for (const listener of listeners) {
    try { listener(frozen); } catch {
      // Diagnostics observers never affect the authoritative terminal lane.
    }
  }
}

export function subscribeTrustedInputTerminals(
  listener: (record: TrustedInputTerminalEvidenceRecord) => void
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function recentTrustedInputTerminals(): TrustedInputTerminalEvidenceRecord[] {
  return terminals.map(cloneTerminal);
}

export function trustedInputDiagnostics(): TrustedInputDiagnosticsRecord {
  return {
    snapshotComplete: true,
    collectionErrorCodes: [],
    terminalCapacity: MAX_RECENT_TERMINALS,
    retainedTerminalCount: terminals.length,
    droppedTerminalCount,
    incidentCapacity: MAX_RECENT_INCIDENTS,
    retainedIncidentCount: incidents.length,
    droppedIncidentCount,
    ...(terminals[0] ? { oldestCapturedAt: terminals[0].capturedAt } : {}),
    ...(terminals.at(-1) ? { newestCapturedAt: terminals.at(-1)!.capturedAt } : {}),
    recentIncidents: incidents.map(cloneTerminal)
  };
}

/** Test-only reset; production ownership remains process-memory bounded. */
export function resetTrustedInputTerminalJournalForTest(): void {
  terminals.splice(0);
  incidents.splice(0);
  droppedTerminalCount = 0;
  droppedIncidentCount = 0;
}
