import type {
  BrowserActionRequest,
  TrustedInputSequenceFailureRecord,
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
    ...(record.compatibleModifierEvidence ? { compatibleModifierEvidence: structuredClone(record.compatibleModifierEvidence) } : {}),
    ...(record.sequenceFailure ? { sequenceFailure: structuredClone(record.sequenceFailure) } : {}),
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

/** A sequence terminal supersedes edge-level APPLIED evidence after Core rollback. */
export function recordTrustedInputSequenceFailure(
  request: BrowserActionRequest,
  surfaceGeneration: number,
  sequenceFailure: TrustedInputSequenceFailureRecord,
  neutral: boolean
): void {
  const edge = [...terminals].reverse().find(candidate =>
    candidate.requestId === request.requestId && candidate.roleId === request.roleId &&
    candidate.inputEpoch === request.inputEpoch && candidate.surfaceGeneration === surfaceGeneration
  );
  recordTrustedInputTerminal({
    requestId: request.requestId, roleId: request.roleId, inputEpoch: request.inputEpoch,
    surfaceGeneration,
    applicationPath: "none", expectedDomEventCount: 0, observedDomEventCount: 0,
    modifierProjectionCodes: [], cdpSubmissionCertainty: "not-invoked",
    physicalInterleave: "none", nativeProofChanges: [], traceSteps: [],
    traceTruncated: false, droppedTraceStepCount: 0,
    ...edge,
    intent: request.intent,
    actionType: request.action.type,
    capturedAt: new Date().toISOString(),
    sequenceFailure: structuredClone(sequenceFailure),
    terminalCode: "SYSTEM_TRUSTED_INPUT_SEQUENCE_FAILED",
    failureStage: "sequence-recovery",
    cleanupOutcome: neutral ? "neutral" : "indeterminate",
    recoveryOutcome: neutral ? "cleanup-neutral" : "restart-required"
  });
}
