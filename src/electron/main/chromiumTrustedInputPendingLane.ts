import type { ChromiumRoleTrustedInputCancelEnvelope } from "../ipc/chromiumRoleTrustedInputProtocol";
import type { ChromiumRoleOverlayFrameIdentity, ChromiumRoleOverlayLifecycleEvent } from
  "./chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputReceipt, ChromiumNativeTrustedInputRequest } from
  "./chromiumTrustedInputCoordinator";
import type { TrustedInputTraceStepRecord } from "../../shared/generated";
import { recordTrustedInputTerminal } from "./chromiumTrustedInputTerminalJournal";

export type ChromiumPhysicalInterleaveClassification =
  | "none"
  | "unrelated"
  | "same-identity"
  | "modifier-change"
  | "indeterminate";

export interface ChromiumPhysicalEvidenceDiagnostics {
  inputSequenceBefore: string;
  inputSequenceAfter: string;
  keyDownSequenceBefore: string;
  keyDownSequenceAfter: string;
  keyUpSequenceBefore: string;
  keyUpSequenceAfter: string;
  lastObservedDomEventType?: string;
  lastObservedDomEventCode?: string;
  lastClassification?: "automatic" | "physical" | "indeterminate";
}

export interface PendingChromiumTrustedInput {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly inputSequence: string;
  readonly completion: { resolve: (receipt: ChromiumNativeTrustedInputReceipt) => void };
  timer: unknown;
  nativeInvoked: boolean;
  cdpInvoked: boolean;
  applicationPath: "none" | "cdp" | "physical-modifier-adoption" |
    "modifier-ownership-release";
  nativeComplete: boolean;
  gameDeliveryRequired?: boolean;
  gameDeliveryConfirmed?: boolean;
  documentObservationWatermark?: number;
  nextDomIndex: number;
  readonly expectedEvents: readonly unknown[];
  modifierProjectionCodes?: readonly string[];
  cdpModifierMask?: number;
  lastObservedDomModifierMask?: number;
  physicalInterleave: ChromiumPhysicalInterleaveClassification;
  physicalEvidenceDiagnostics?: ChromiumPhysicalEvidenceDiagnostics;
  traceSteps?: TrustedInputTraceStepRecord[];
  droppedTraceStepCount?: number;
  failureStage?: string;
  cdpTerminalReason?: string;
  nativeProofChanges?: string[];
  terminal: boolean;
}

const MAX_TRACE_STEPS = 32;

export function recordTrustedInputTrace(
  pending: PendingChromiumTrustedInput,
  source: TrustedInputTraceStepRecord["source"],
  stage: string,
  outcomeCode?: string
): void {
  pending.traceSteps ??= [];
  const previous = pending.traceSteps.at(-1);
  if (
    previous?.source === source && previous.stage === stage &&
    previous.outcomeCode === outcomeCode
  ) {
    return;
  }
  if (pending.traceSteps.length >= MAX_TRACE_STEPS) {
    const sequence = pending.traceSteps.length + (pending.droppedTraceStepCount ?? 0) + 1;
    pending.droppedTraceStepCount = (pending.droppedTraceStepCount ?? 0) + 1;
    if (stage === "terminal") {
      pending.traceSteps[MAX_TRACE_STEPS - 1] = Object.freeze({
        sequence,
        source,
        stage,
        ...(outcomeCode ? { outcomeCode } : {})
      });
    }
    return;
  }
  pending.traceSteps.push(Object.freeze({
    sequence: pending.traceSteps.length + (pending.droppedTraceStepCount ?? 0) + 1,
    source,
    stage,
    ...(outcomeCode ? { outcomeCode } : {})
  }));
}

export function sameTrustedInputFrame(
  left: ChromiumRoleOverlayFrameIdentity, right: ChromiumRoleOverlayFrameIdentity
): boolean {
  return left.roleId === right.roleId && left.generation === right.generation &&
    left.frame === right.frame && left.frameToken === right.frameToken &&
    left.documentInstanceId === right.documentInstanceId;
}

interface PendingLanePorts {
  readonly nowMs: () => number;
  readonly cancelDeadline: (handle: unknown) => void;
  readonly sendCancel: (frame: ChromiumRoleOverlayFrameIdentity,
    envelope: ChromiumRoleTrustedInputCancelEnvelope) => void;
}

/** Shared pending ownership; platform guards and trusted DOM validation stay in adapters. */
export class ChromiumTrustedInputPendingLane<Pending extends PendingChromiumTrustedInput> {
  readonly #roles = new Map<string, Pending>();
  readonly #requests = new Map<string, Pending>();
  readonly #ports: PendingLanePorts;

  constructor(ports: PendingLanePorts) {
    this.#ports = ports;
  }

  busy(roleId: string, requestId: string): boolean {
    return this.#roles.has(roleId) || this.#requests.has(requestId);
  }
  forRole(roleId: string): Pending | undefined { return this.#roles.get(roleId); }
  forRequest(requestId: string): Pending | undefined { return this.#requests.get(requestId); }
  values(): readonly Pending[] { return [...this.#roles.values()]; }

  add(pending: Pending): boolean {
    if (pending.terminal || this.busy(pending.request.roleId, pending.request.requestId)) return false;
    recordTrustedInputTrace(pending, "electron", "lane-admitted");
    this.#roles.set(pending.request.roleId, pending);
    this.#requests.set(pending.request.requestId, pending);
    return true;
  }

  finish(
    pending: Pending, status: ChromiumNativeTrustedInputReceipt["status"],
    errorCode: string | null, errorMessage: string | null, confirmedInputNeutrality: boolean
  ): void {
    if (pending.terminal) return;
    recordTrustedInputTrace(
      pending,
      "electron",
      "terminal",
      errorCode ?? "APPLIED"
    );
    pending.terminal = true;
    if (this.#roles.get(pending.request.roleId) === pending) this.#roles.delete(pending.request.roleId);
    if (this.#requests.get(pending.request.requestId) === pending) this.#requests.delete(pending.request.requestId);
    try { this.#ports.cancelDeadline(pending.timer); } catch {
      // The terminal flag fences a deadline callback even if cancellation fails.
    }
    try {
      // The preload now retains the raw observation lane until main has an
      // authoritative terminal outcome, including successful completion.
      this.#ports.sendCancel(pending.frame, Object.freeze({
        kind: "cancel", roleId: pending.request.roleId,
        generation: pending.request.surfaceGeneration,
        frameToken: pending.frame.frameToken, inputSequence: pending.inputSequence,
        committed: status === "applied"
      }));
    } catch {
      // Navigation or retirement may already have destroyed the exact frame.
    }
    const keyCode = pending.request.keyEffect?.code ??
      (pending.request.action.type === "key" ? pending.request.action.code : null);
    recordTrustedInputTerminal({
      documentInstanceId: pending.frame.documentInstanceId,
      ...(pending.request.action.type === "key" ? { deliveryOwnerId: pending.request.action.ownerId } : {}),
      ...(pending.gameDeliveryRequired ? { gameDeliveryConfirmed: pending.gameDeliveryConfirmed === true } : {}),
      ...(pending.documentObservationWatermark === undefined ? {} : {
        documentObservationWatermark: pending.documentObservationWatermark
      }),
      capturedAt: new Date().toISOString(),
      requestId: pending.request.requestId,
      ...(pending.request.parentRequestId ? { parentRequestId: pending.request.parentRequestId } : {}),
      roleId: pending.request.roleId,
      inputEpoch: pending.request.inputEpoch,
      surfaceGeneration: pending.request.surfaceGeneration,
      intent: pending.request.intent,
      actionType: pending.request.action.type,
      ...(keyCode ? { keyCode } : {}),
      ...(pending.request.keyEffect ? {
        keyPhase: pending.request.keyEffect.phase
      } : {}),
      ...(pending.request.action.type === "key" ? {
        modifierOwnership: pending.request.action.modifierOwnership
      } : {}),
      applicationPath: pending.applicationPath,
      expectedDomEventCount: pending.expectedEvents.length,
      observedDomEventCount: pending.nextDomIndex,
      modifierProjectionCodes: [...(pending.modifierProjectionCodes ?? [])],
      ...(pending.cdpModifierMask === undefined ? {} : {
        cdpModifierMask: pending.cdpModifierMask
      }),
      ...(pending.lastObservedDomModifierMask === undefined ? {} : {
        lastObservedDomModifierMask: pending.lastObservedDomModifierMask
      }),
      cdpSubmissionCertainty: pending.cdpInvoked
        ? status === "applied" ? "confirmed" : "possibly-submitted"
        : "not-invoked",
      physicalInterleave: pending.physicalInterleave,
      ...(pending.physicalEvidenceDiagnostics ? {
        nativePhysicalInputSequenceBefore:
          pending.physicalEvidenceDiagnostics.inputSequenceBefore,
        nativePhysicalInputSequenceAfter:
          pending.physicalEvidenceDiagnostics.inputSequenceAfter,
        nativePhysicalKeyDownSequenceBefore:
          pending.physicalEvidenceDiagnostics.keyDownSequenceBefore,
        nativePhysicalKeyDownSequenceAfter:
          pending.physicalEvidenceDiagnostics.keyDownSequenceAfter,
        nativePhysicalKeyUpSequenceBefore:
          pending.physicalEvidenceDiagnostics.keyUpSequenceBefore,
        nativePhysicalKeyUpSequenceAfter:
          pending.physicalEvidenceDiagnostics.keyUpSequenceAfter,
        ...(pending.physicalEvidenceDiagnostics.lastObservedDomEventType ? {
          lastObservedDomEventType:
            pending.physicalEvidenceDiagnostics.lastObservedDomEventType
        } : {}),
        ...(pending.physicalEvidenceDiagnostics.lastObservedDomEventCode ? {
          lastObservedDomEventCode:
            pending.physicalEvidenceDiagnostics.lastObservedDomEventCode
        } : {}),
        ...(pending.physicalEvidenceDiagnostics.lastClassification ? {
          lastPhysicalEvidenceClassification:
            pending.physicalEvidenceDiagnostics.lastClassification
        } : {})
      } : {}),
      terminalCode: errorCode ?? "APPLIED",
      ...(errorCode ? {
        failureStage: pending.failureStage ?? (pending.cdpInvoked
          ? "dom-receipt-correlation"
          : pending.nativeInvoked ? "native-submission" : "preload-arm")
      } : {}),
      ...(pending.cdpTerminalReason ? {
        cdpTerminalReason: pending.cdpTerminalReason
      } : {}),
      nativeProofChanges: [...new Set(pending.nativeProofChanges ?? [])],
      traceSteps: (pending.traceSteps ?? []).map(step => ({ ...step })),
      traceTruncated: (pending.droppedTraceStepCount ?? 0) > 0,
      droppedTraceStepCount: pending.droppedTraceStepCount ?? 0,
      cleanupOutcome: pending.request.intent !== "cleanup"
        ? "not-attempted"
        : status === "applied" && confirmedInputNeutrality
          ? "neutral" : "indeterminate",
      recoveryOutcome: status === "applied" && confirmedInputNeutrality
        ? pending.request.intent === "cleanup" ? "cleanup-neutral" : "not-required"
        : status === "indeterminate"
          ? pending.request.intent === "cleanup"
            ? "restart-required" : "neutralization-required"
          : "not-required"
    });
    pending.completion.resolve(Object.freeze({
      requestId: pending.request.requestId,
      roleId: pending.request.roleId,
      inputEpoch: pending.request.inputEpoch, surfaceGeneration: pending.request.surfaceGeneration,
      status, completedAtMs: this.#ports.nowMs(), errorCode, errorMessage, confirmedInputNeutrality
    }));
  }

  maybeApply(pending: Pending): void {
    if (pending.terminal || !pending.nativeComplete ||
      pending.nextDomIndex !== pending.expectedEvents.length ||
      (pending.gameDeliveryRequired && !pending.gameDeliveryConfirmed)) return;
    this.finish(pending, "applied", null, null, pending.request.expectedInputNeutralityAfter);
  }

  mismatch(pending: Pending): void {
    this.finish(pending, pending.nativeInvoked ? "indeterminate" : "failed",
      "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_MISMATCH",
      "The isolated preload did not report the exact trusted DOM sequence.",
      !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore);
  }

  surfaceChanged(event: ChromiumRoleOverlayLifecycleEvent): void {
    const pending = this.forRole(event.roleId);
    if (!pending || pending.request.surfaceGeneration !== event.generation) return;
    this.finish(pending, pending.nativeInvoked ? "indeterminate" : "superseded",
      pending.nativeInvoked ? "SYSTEM_TRUSTED_INPUT_DOCUMENT_SUPERSEDED" : "BROWSER_ACTION_STALE",
      event.reason === "document-superseded"
        ? "The Chromium document changed before exact trusted-input completion."
        : "The Chromium surface retired before exact trusted-input completion.",
      !pending.nativeInvoked && pending.request.expectedInputNeutralityBefore);
  }
}
