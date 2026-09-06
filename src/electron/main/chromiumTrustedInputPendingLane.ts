import type { ChromiumRoleTrustedInputCancelEnvelope } from "../ipc/chromiumRoleTrustedInputProtocol";
import type { ChromiumRoleOverlayFrameIdentity, ChromiumRoleOverlayLifecycleEvent } from
  "./chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputReceipt, ChromiumNativeTrustedInputRequest } from
  "./chromiumTrustedInputCoordinator";

export interface PendingChromiumTrustedInput {
  readonly request: ChromiumNativeTrustedInputRequest;
  readonly frame: ChromiumRoleOverlayFrameIdentity;
  readonly inputSequence: string;
  readonly completion: { resolve: (receipt: ChromiumNativeTrustedInputReceipt) => void };
  timer: unknown;
  nativeInvoked: boolean;
  nativeComplete: boolean;
  nextDomIndex: number;
  readonly expectedEvents: readonly unknown[];
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

/** Shared pending ownership; native submission and native receipt validation stay in adapters. */
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
    if (status !== "applied") {
      try {
        this.#ports.sendCancel(pending.frame, Object.freeze({
          kind: "cancel", roleId: pending.request.roleId,
          generation: pending.request.surfaceGeneration,
          frameToken: pending.frame.frameToken, inputSequence: pending.inputSequence
        }));
      } catch {
        // Navigation or retirement may already have destroyed the exact frame.
      }
    }
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
