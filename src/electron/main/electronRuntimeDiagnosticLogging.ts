import type { AppKitRuntimeActionEvent } from "./macosAppKitRuntimePorts";
import { subscribeTrustedInputTerminals } from
  "./chromiumTrustedInputTerminalJournal";
import { ElectronOperationalLogger } from "./electronOperationalLogger";

interface RuntimeDiagnosticLogger {
  nativeWindowPlacement: (context: Readonly<Record<string, unknown>>) => void;
  trustedInputTerminal: (context: Readonly<Record<string, unknown>>) => void;
  trustedInputIncident?: (context: Readonly<Record<string, unknown>>) => void;
}

function installTrustedInputDiagnosticLogging(
  logger: RuntimeDiagnosticLogger
): void {
  subscribeTrustedInputTerminals((record) => {
    const context = {
      capturedAt: record.capturedAt,
      requestId: record.requestId,
      roleId: record.roleId,
      inputEpoch: record.inputEpoch,
      intent: record.intent,
      surfaceGeneration: record.surfaceGeneration,
      actionType: record.actionType,
      ...(record.keyCode ? { code: record.keyCode } : {}),
      ...(record.keyPhase ? { phase: record.keyPhase } : {}),
      ...(record.modifierOwnership ? {
        modifierOwnership: record.modifierOwnership
      } : {}),
      applicationPath: record.applicationPath,
      expectedDomEventCount: record.expectedDomEventCount,
      observedDomEventCount: record.observedDomEventCount,
      modifierProjectionCodes: record.modifierProjectionCodes,
      cdpModifierMask: record.cdpModifierMask ?? null,
      lastObservedDomModifierMask: record.lastObservedDomModifierMask ?? null,
      cdpSubmissionCertainty: record.cdpSubmissionCertainty,
      physicalInterleave: record.physicalInterleave,
      ...(record.nativePhysicalInputSequenceBefore ? {
        nativePhysicalInputSequenceBefore: record.nativePhysicalInputSequenceBefore,
        nativePhysicalInputSequenceAfter: record.nativePhysicalInputSequenceAfter,
        nativePhysicalKeyDownSequenceBefore:
          record.nativePhysicalKeyDownSequenceBefore,
        nativePhysicalKeyDownSequenceAfter:
          record.nativePhysicalKeyDownSequenceAfter,
        nativePhysicalKeyUpSequenceBefore:
          record.nativePhysicalKeyUpSequenceBefore,
        nativePhysicalKeyUpSequenceAfter:
          record.nativePhysicalKeyUpSequenceAfter,
        lastObservedDomEventType: record.lastObservedDomEventType ?? null,
        lastObservedDomEventCode: record.lastObservedDomEventCode ?? null,
        lastPhysicalEvidenceClassification:
          record.lastPhysicalEvidenceClassification ?? null
      } : {}),
      terminalCode: record.terminalCode,
      failureStage: record.failureStage ?? null,
      cdpTerminalReason: record.cdpTerminalReason ?? null,
      nativeProofChanges: record.nativeProofChanges,
      traceSteps: record.traceSteps,
      traceTruncated: record.traceTruncated,
      droppedTraceStepCount: record.droppedTraceStepCount,
      cleanupOutcome: record.cleanupOutcome,
      recoveryOutcome: record.recoveryOutcome
    };
    if (record.terminalCode === "APPLIED" || !logger.trustedInputIncident) {
      logger.trustedInputTerminal(context);
    } else {
      logger.trustedInputIncident(context);
    }
  });
}

export const runtimeLogs = new ElectronOperationalLogger();
installTrustedInputDiagnosticLogging(runtimeLogs);

export function logMacosAppKitWindowPlacement(
  logger: RuntimeDiagnosticLogger,
  event: AppKitRuntimeActionEvent
): void {
  if (event.action.type !== "windowPlacementChanged") return;
  const value = event.action.placementDiagnostics;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const evidence = value as Readonly<Record<string, unknown>>;
  logger.nativeWindowPlacement({
    windowId: event.identity.logicalWindowId,
    nativeGeneration: event.identity.nativeGeneration,
    zoomed: evidence.zoomed === true,
    fullScreen: evidence.fullScreen === true,
    minimized: evidence.minimized === true,
    frame: {
      x: Number(evidence.frameX),
      y: Number(evidence.frameY),
      width: Number(evidence.frameWidth),
      height: Number(evidence.frameHeight)
    },
    triggerEventType: Number(evidence.triggerEventType),
    triggerKeyCode: Number(evidence.triggerKeyCode) === 65_535
      ? null : Number(evidence.triggerKeyCode),
    triggerModifierFlags: Number(evidence.triggerModifierFlags),
    firstResponderCategory: String(evidence.firstResponderCategory),
    physicalInputSequence: String(evidence.physicalInputSequence)
  });
}
