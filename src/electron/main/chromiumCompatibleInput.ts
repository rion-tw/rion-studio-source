import type { ChromiumCompatibleInputCommand, ChromiumCompatibleInputReceipt } from "../ipc/chromiumCompatibleInputProtocol";
import { chromiumCdpKeyDescriptor, chromiumCdpModifierMask } from "./chromiumCdpInputDescriptors";
import type { ChromiumRoleOverlayFrameIdentity } from "./chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputRequest as Request, ChromiumNativeTrustedInputReceipt as Receipt } from "./chromiumTrustedInputCoordinator";
import { recordTrustedInputTerminal } from "./chromiumTrustedInputTerminalJournal";
import { isChromiumModifierCode } from "./chromiumTrustedInputKeySequence";
import { compatibleInputEventCount, validCompatibleInputEvidence } from "./chromiumCompatibleInputEvidence";

export interface ChromiumCompatibleInputPort {
  dispatchCompatibleInput: (frame: ChromiumRoleOverlayFrameIdentity, command: ChromiumCompatibleInputCommand) => Promise<unknown>;
}

/** One fixed compatible route; it never invokes or falls back to CDP. */
export class ChromiumCompatibleInput {
  readonly #documents = new Map<string, { token: string; sequence: number; target: string | null }>();
  readonly #pending = new Map<string, () => void>();
  constructor(private readonly input: {
    port: ChromiumCompatibleInputPort;
    platform: "darwin" | "win32";
    nowMs: () => number;
    timers: { setTimeout: (callback: () => void, delayMs: number) => unknown; cancel: (handle: unknown) => void };
  }) {}

  retire(roleId: string): void {
    this.#pending.get(roleId)?.();
    this.#documents.delete(roleId);
  }
  dispose(): void { for (const roleId of this.#documents.keys()) this.retire(roleId); }

  dispatch(request: Request, frame: ChromiumRoleOverlayFrameIdentity,
    modifiers: readonly string[], point: { clientX: number; clientY: number } | null,
    verifyHost: () => void): Promise<Receipt> {
    let document = this.#documents.get(request.roleId);
    if (!document || document.token !== frame.frameToken) {
      document = { token: frame.frameToken, sequence: 0, target: null };
      this.#documents.set(request.roleId, document);
    }
    const effect = request.keyEffect;
    const command: ChromiumCompatibleInputCommand = {
      requestId: request.requestId, ownerId: request.action.type === "key" ? request.action.ownerId : "core-input-projection",
      roleId: request.roleId, generation: request.surfaceGeneration, inputEpoch: request.inputEpoch,
      frameToken: frame.frameToken, documentInstanceId: frame.documentInstanceId,
      sequence: ++document.sequence, deadlineMs: request.deadlineMs, intent: request.intent,
      action: effect ? "key" : request.action.type === "click" ? "click" : "focus",
      ...(effect ? { key: { ...chromiumCdpKeyDescriptor({ ...effect,
        activeCodes: [...new Set([...effect.activeCodes, ...modifiers])] }, this.input.platform),
        shiftedKey: chromiumCdpKeyDescriptor({ ...effect,
          activeCodes: [...effect.activeCodes, "ShiftLeft"] }, this.input.platform).key },
        modifierState: { coreCodesBefore: effect.activeCodesBefore.filter(isChromiumModifierCode),
          coreCodesAfter: effect.activeCodes.filter(isChromiumModifierCode), nativePhysicalCodes: [...modifiers] } } : {}),
      ...(request.action.type === "click" && point ? { pointer: {
        ...point, button: request.action.button === "left" ? 0 : request.action.button === "middle" ? 1 : 2,
        modifiers: chromiumCdpModifierMask(modifiers), releaseOnly: request.pointerReleaseOnly === true
      } as const } : {})
    };
    const expectedCount = compatibleInputEventCount(command);
    const retained = document;
    return new Promise(resolve => {
      let terminal = false;
      let submitted = false;
      let timer: unknown = null;
      const finish = (status: Receipt["status"], errorCode: string | null, count = 0,
        received?: ChromiumCompatibleInputReceipt) => {
        if (terminal) return;
        terminal = true;
        this.input.timers.cancel(timer);
        if (this.#pending.get(request.roleId) === cancelPending) this.#pending.delete(request.roleId);
        const neutral = status === "applied" ? request.expectedInputNeutralityAfter
          : status === "indeterminate" ? false : request.expectedInputNeutralityBefore;
        recordTrustedInputTerminal({
          capturedAt: new Date().toISOString(), requestId: request.requestId, roleId: request.roleId,
          inputEpoch: request.inputEpoch, surfaceGeneration: request.surfaceGeneration, intent: request.intent,
          actionType: request.action.type, applicationPath: "canvas-compatibility", documentInstanceId: frame.documentInstanceId,
          deliveryOwnerId: command.ownerId, gameDeliveryConfirmed: status === "applied" && count > 0,
          expectedDomEventCount: compatibleInputEventCount(command, received),
          observedDomEventCount: count, modifierProjectionCodes: [], cdpSubmissionCertainty: "not-invoked",
          physicalInterleave: received?.modifierEvidence &&
            received.modifierEvidence.physicalCodesBefore.join() !== received.modifierEvidence.physicalCodesAfter.join()
            ? "modifier-change" : "indeterminate", terminalCode: errorCode ?? "APPLIED", nativeProofChanges: [],
          ...(received?.modifierEvidence ? { compatibleModifierEvidence: received.modifierEvidence,
            ...(received.modifierEvidence.eventModifierMask !== null
              ? { lastObservedDomModifierMask: received.modifierEvidence.eventModifierMask } : {}) } : {}),
          ...(effect ? { keyCode: effect.code, keyPhase: effect.phase } : {}),
          ...(errorCode ? { failureStage: "compatible-game-delivery" } : {}),
          traceSteps: [{ sequence: 1, source: "core", stage: "browser-action-admitted" },
            { sequence: 2, source: "electron", stage: "canvas-compatibility", outcomeCode: "SYNTHETIC_NOT_TRUSTED" },
            { sequence: 3, source: "electron", stage: "terminal", outcomeCode: errorCode ?? "APPLIED" }],
          traceTruncated: false, droppedTraceStepCount: 0,
          cleanupOutcome: request.intent !== "cleanup" ? "not-attempted" : neutral ? "neutral" : "indeterminate",
          recoveryOutcome: status === "indeterminate" ? "neutralization-required" : "not-required"
        });
        resolve({ requestId: request.requestId, roleId: request.roleId, inputEpoch: request.inputEpoch,
          surfaceGeneration: request.surfaceGeneration, status, completedAtMs: this.input.nowMs(),
          errorCode, errorMessage: errorCode ? "The original game target did not confirm compatible input delivery." : null,
          confirmedInputNeutrality: neutral });
      };
      const cancelPending = () => finish(submitted ? "indeterminate" : "superseded",
        "SYSTEM_COMPATIBLE_INPUT_DOCUMENT_SUPERSEDED");
      if (this.#pending.has(request.roleId)) { finish("failed", "SYSTEM_COMPATIBLE_INPUT_LANE_BUSY"); return; }
      this.#pending.set(request.roleId, cancelPending);
      if ((request.action.type === "key" && !effect) || (request.action.type === "click" && !point)) {
        finish("failed", "SYSTEM_COMPATIBLE_INPUT_INVALID"); return;
      }
      if (this.input.nowMs() >= request.deadlineMs) { finish("failed", "BROWSER_ACTION_DEADLINE"); return; }
      // event-topology-exception: canvas-compatible-input-receipt-deadline
      timer = this.input.timers.setTimeout(() => finish(submitted ? "indeterminate" : "failed",
        "SYSTEM_COMPATIBLE_INPUT_RECEIPT_DEADLINE"), request.deadlineMs - this.input.nowMs());
      try {
        verifyHost();
        submitted = true;
        void this.input.port.dispatchCompatibleInput(frame, command).then(raw => {
          if (terminal) return;
          try {
            verifyHost();
            const receipt = raw as ChromiumCompatibleInputReceipt | null;
            if (!receipt || this.input.nowMs() >= request.deadlineMs ||
                this.#documents.get(request.roleId) !== retained ||
                !["requestId", "ownerId", "roleId", "inputEpoch", "generation", "frameToken", "documentInstanceId", "sequence"]
                  .every(key => receipt[key as keyof ChromiumCompatibleInputReceipt] === command[key as keyof ChromiumCompatibleInputCommand]) ||
                receipt.isTrusted !== false || !Number.isSafeInteger(receipt.eventCount) || receipt.eventCount < 0 ||
                receipt.eventCount > expectedCount || (receipt.status === "failed" && receipt.eventCount !== 0) ||
                !["applied", "failed", "indeterminate"].includes(receipt.status) ||
                !validCompatibleInputEvidence(command, receipt) ||
                (receipt.status === "applied" && (receipt.errorCode !== null || receipt.eventCount !== compatibleInputEventCount(command, receipt) ||
                  typeof receipt.targetToken !== "string" || receipt.targetToken.length === 0 ||
                  (retained.target !== null && receipt.targetToken !== retained.target))) ||
                (receipt.status !== "applied" && (typeof receipt.errorCode !== "string" ||
                  !/^SYSTEM_COMPATIBLE_INPUT_[A-Z_]+$/u.test(receipt.errorCode)))) {
              finish("indeterminate", "SYSTEM_COMPATIBLE_INPUT_RECEIPT_MISMATCH"); return;
            }
            if (receipt.status === "applied") retained.target = receipt.targetToken;
            finish(receipt.status, receipt.errorCode, receipt.eventCount, receipt);
          } catch { finish("indeterminate", "SYSTEM_COMPATIBLE_INPUT_HOST_SUPERSEDED"); }
        }, () => finish("indeterminate", "SYSTEM_COMPATIBLE_INPUT_DELIVERY_FAILED"));
      } catch { finish(submitted ? "indeterminate" : "failed", "SYSTEM_COMPATIBLE_INPUT_HOST_SUPERSEDED"); }
    });
  }
}
