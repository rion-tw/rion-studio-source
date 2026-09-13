import type { ChromiumRoleTrustedInputCancelEnvelope } from "../ipc/chromiumRoleTrustedInputProtocol";
import type { ChromiumRoleOverlayFrameIdentity, ChromiumRoleOverlayLifecycleEvent } from
  "./chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputReceipt, ChromiumNativeTrustedInputRequest } from
  "./chromiumTrustedInputCoordinator";
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
  nextDomIndex: number;
  readonly expectedEvents: readonly unknown[];
  physicalInterleave: ChromiumPhysicalInterleaveClassification;
  physicalEvidenceDiagnostics?: ChromiumPhysicalEvidenceDiagnostics;
  terminal: boolean;
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
    this.#roles.set(pending.request.roleId, pending);
    this.#requests.set(pending.request.requestId, pending);
    return true;
  }

  finish(
    pending: Pending, status: ChromiumNativeTrustedInputReceipt["status"],
    errorCode: string | null, errorMessage: string | null, confirmedInputNeutrality: boolean
  ): void {
    if (pending.terminal) return;
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
      capturedAt: new Date().toISOString(),
      requestId: pending.request.requestId,
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
      cleanupOutcome: pending.request.intent !== "cleanup"
        ? "not-attempted"
        : status === "applied" && confirmedInputNeutrality
          ? "neutral" : "indeterminate",
      recoveryOutcome: status === "applied" && confirmedInputNeutrality
        ? "cleanup-neutral" : status === "indeterminate"
          ? "restart-required" : "not-required"
    });
    pending.completion.resolve(Object.freeze({
      requestId: pending.request.requestId, roleId: pending.request.roleId,
      inputEpoch: pending.request.inputEpoch, surfaceGeneration: pending.request.surfaceGeneration,
      status, completedAtMs: this.#ports.nowMs(), errorCode, errorMessage, confirmedInputNeutrality
    }));
  }

  maybeApply(pending: Pending): void {
    if (pending.terminal || !pending.nativeComplete ||
      pending.nextDomIndex !== pending.expectedEvents.length) return;
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
