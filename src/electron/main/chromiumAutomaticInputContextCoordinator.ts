import type {
  BrowserActionRequest,
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEffectResult,
  MacroInputEpochRecord,
  MacroInputRecoveryCompletionReceiptRecord,
  MacroInputRecoveryFailureReceiptRecord,
  MacroInputRecoveryTicketRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "./chromiumRoleSurfaceRegistry";

type InputContextTarget = "document" | "embedded-frame" | "game";
type CoordinatorState = "open" | "disposed";

export interface ChromiumAutomaticInputContextCorePort {
  inspectRecovery: (input: RecoveryIdentity) => Promise<MacroInputRecoveryTicketRecord>;
  drainInput: (input: Readonly<{
    roleId: string;
    inputEpoch: number;
  }>) => Promise<MacroInputEpochRecord>;
  completeRecovery: (
    input: RecoveryIdentity
  ) => Promise<MacroInputRecoveryCompletionReceiptRecord>;
  failRecovery: (input: RecoveryIdentity & Readonly<{
    message: string;
  }>) => Promise<MacroInputRecoveryFailureReceiptRecord>;
}

export interface ChromiumAutomaticInputContextSurfacePort {
  subscribeOverlayLifecycle: (
    listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
  ) => () => void;
}

interface RecoveryIdentity {
  readonly recoveryId: string;
  readonly roleId: string;
  readonly expectedInputEpoch: number;
}

interface InputContextRecord {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly revision: number;
  readonly target: InputContextTarget;
}

export interface ChromiumAutomaticInputContextIdentity {
  readonly documentInstanceId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
}

interface InputContextWaiter extends ChromiumAutomaticInputContextIdentity {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface ChallengedInputContextDocument
  extends ChromiumAutomaticInputContextIdentity {
  readonly revision: number;
}

interface ActiveRecoveryRecord extends InputContextRecord, RecoveryIdentity {}
type RecoveryCause = "context-blocked" | "native-indeterminate";

interface ActiveRecoveryRecordWithCause extends ActiveRecoveryRecord {
  readonly cause: RecoveryCause;
}

export interface ChromiumAutomaticInputNeutralityProof {
  readonly kind: "cleanup-neutral";
  readonly requestId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly surfaceGeneration: number;
}

export interface ChromiumAutomaticInputContextReceipt extends InputContextRecord {
  readonly status: "accepted" | "superseded";
}

function contextError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index]);
}

function parseContext(
  identity: ChromiumRoleOverlayFrameIdentity,
  raw: unknown
): InputContextRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw contextError(
      "ELECTRON_AUTOMATIC_INPUT_CONTEXT_INVALID",
      "The Chromium automatic-input context observation is invalid."
    );
  }
  const record = raw as Record<string, unknown>;
  if (!exactKeys(record, ["documentInstanceId", "revision", "target", "type"]) ||
    record.type !== "game-input-context" ||
    record.documentInstanceId !== identity.frameToken ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    !(["document", "embedded-frame", "game"] as const).includes(
      record.target as InputContextTarget
    )) {
    throw contextError(
      "ELECTRON_AUTOMATIC_INPUT_CONTEXT_INVALID",
      "The Chromium automatic-input context observation does not match its live document."
    );
  }
  return Object.freeze({
    roleId: identity.roleId,
    surfaceGeneration: identity.generation,
    documentInstanceId: identity.documentInstanceId,
    revision: record.revision as number,
    target: record.target as InputContextTarget
  });
}

function isRecoveryFailure(result: CoreEffectResult): boolean {
  return !result.ok && (
    result.error?.code === "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED" ||
    result.error?.code === "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
  );
}

function exactRecoveryReceipt(
  receipt: RecoveryIdentity,
  expected: RecoveryIdentity
): boolean {
  return receipt.recoveryId === expected.recoveryId &&
    receipt.roleId === expected.roleId &&
    receipt.expectedInputEpoch === expected.expectedInputEpoch;
}

/**
 * Retains exact main-frame input-context observations and joins Core's
 * recovery ticket lifecycle after an accepted BrowserAction acknowledgement.
 * No renderer observation can complete recovery without Core's exact ticket.
 */
export class ChromiumAutomaticInputContextCoordinator {
  readonly #core: ChromiumAutomaticInputContextCorePort;
  readonly #contexts = new Map<string, InputContextRecord>();
  readonly #recoveries = new Map<string, ActiveRecoveryRecordWithCause>();
  readonly #neutralityProofs = new Map<string, ChromiumAutomaticInputNeutralityProof>();
  readonly #navigationPending = new Set<string>();
  readonly #waiters = new Map<string, Set<InputContextWaiter>>();
  readonly #challengedDocuments = new Map<string, ChallengedInputContextDocument>();
  readonly #contextListeners = new Set<(
    context: ChromiumAutomaticInputContextIdentity
  ) => void>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly #unsubscribe: () => void;
  readonly #resumeNativeAfterDocumentReplacement: (
    roleId: string,
    surfaceGeneration: number
  ) => Promise<boolean>;
  #state: CoordinatorState = "open";

  constructor(input: Readonly<{
    core: ChromiumAutomaticInputContextCorePort;
    surfaces: ChromiumAutomaticInputContextSurfacePort;
    resumeNativeAfterDocumentReplacement: (
      roleId: string,
      surfaceGeneration: number
    ) => Promise<boolean>;
    onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  }>) {
    this.#core = input.core;
    this.#onError = input.onError;
    this.#resumeNativeAfterDocumentReplacement =
      input.resumeNativeAfterDocumentReplacement;
    this.#unsubscribe = input.surfaces.subscribeOverlayLifecycle(
      this.#onSurfaceLifecycle
    );
  }

  preflight(roleId: string, surfaceGeneration: number): void {
    const context = this.#contexts.get(roleId);
    if (context?.surfaceGeneration === surfaceGeneration &&
      context.target === "embedded-frame") {
      throw contextError(
        "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED",
        "Automatic input is paused while an embedded frame owns the page input context."
      );
    }
  }

  subscribeContextObservations(
    listener: (context: ChromiumAutomaticInputContextIdentity) => void
  ): () => void {
    this.#contextListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#contextListeners.delete(listener);
    };
  }

  waitForExactGameContext(
    identity: ChromiumAutomaticInputContextIdentity
  ): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(contextError(
        "ELECTRON_AUTOMATIC_INPUT_CONTEXT_DISPOSED",
        "The Chromium automatic-input context coordinator is disposed."
      ));
    }
    const current = this.#contexts.get(identity.roleId);
    if (
      current && this.#matchesGameContext(current, identity) &&
      this.#matchesChallenge(identity)
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiters = this.#waiters.get(identity.roleId) ??
        new Set<InputContextWaiter>();
      waiters.add(Object.freeze({ ...identity, resolve, reject }));
      this.#waiters.set(identity.roleId, waiters);
    });
  }

  establishReloadDocumentChallenge(
    identity: ChromiumRoleOverlayFrameIdentity,
    inputContext: Readonly<{
      documentInstanceId: string;
      revision: number;
      target: "document" | "embedded-frame" | "game";
    }>
  ): Promise<ChromiumAutomaticInputContextReceipt> {
    if (this.#state !== "open") {
      return Promise.reject(contextError(
        "ELECTRON_AUTOMATIC_INPUT_CONTEXT_DISPOSED",
        "The Chromium automatic-input context coordinator is disposed."
      ));
    }
    return this.#enqueue(identity.roleId, async () => {
      const observed = parseContext(identity, {
        ...inputContext,
        type: "game-input-context"
      });
      this.#challengedDocuments.set(identity.roleId, Object.freeze({
        documentInstanceId: identity.documentInstanceId,
        revision: observed.revision,
        roleId: identity.roleId,
        surfaceGeneration: identity.generation
      }));
      this.#contexts.set(identity.roleId, observed);
      this.#resolveGameContextWaiters(observed);
      return Object.freeze({ ...observed, status: "accepted" as const });
    });
  }

  observe(
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ): Promise<ChromiumAutomaticInputContextReceipt> {
    if (this.#state !== "open") {
      return Promise.reject(contextError(
        "ELECTRON_AUTOMATIC_INPUT_CONTEXT_DISPOSED",
        "The Chromium automatic-input context coordinator is disposed."
      ));
    }
    let observed: InputContextRecord;
    try {
      observed = parseContext(identity, payload);
    } catch (error) {
      return Promise.reject(error);
    }
    this.#notifyContext(observed);
    return this.#enqueue(identity.roleId, async () => {
      const previous = this.#contexts.get(identity.roleId);
      const recovery = this.#recoveries.get(identity.roleId);
      const exactReplacement = recovery?.cause === "native-indeterminate" &&
        this.#navigationPending.has(identity.roleId) &&
        recovery.surfaceGeneration === observed.surfaceGeneration &&
        recovery.documentInstanceId !== observed.documentInstanceId;
      if (previous && (
        previous.surfaceGeneration > observed.surfaceGeneration ||
        (!exactReplacement && previous.surfaceGeneration === observed.surfaceGeneration &&
          previous.documentInstanceId !== observed.documentInstanceId) ||
        (previous.surfaceGeneration === observed.surfaceGeneration &&
          previous.documentInstanceId === observed.documentInstanceId &&
          previous.revision >= observed.revision)
      )) {
        return Object.freeze({ ...observed, status: "superseded" as const });
      }
      this.#contexts.set(identity.roleId, observed);
      this.#resolveGameContextWaiters(observed);
      if (exactReplacement && recovery) {
        const resumed = await this.#resumeNativeAfterDocumentReplacement(
          recovery.roleId,
          recovery.surfaceGeneration
        );
        if (!resumed) {
          await this.#fail(recovery, contextError(
            "ELECTRON_AUTOMATIC_INPUT_RECOVERY_NATIVE_RESUME_REJECTED",
            "The native input lane did not accept the exact replacement document."
          ));
          throw contextError(
            "ELECTRON_AUTOMATIC_INPUT_RECOVERY_NATIVE_RESUME_REJECTED",
            "The native input lane did not accept the exact replacement document."
          );
        }
        this.#navigationPending.delete(identity.roleId);
        await this.#complete(recovery);
      } else if (observed.target === "game" && recovery?.cause === "context-blocked" &&
        recovery.surfaceGeneration === observed.surfaceGeneration &&
        recovery.documentInstanceId === observed.documentInstanceId) {
        await this.#complete(recovery);
      }
      return Object.freeze({ ...observed, status: "accepted" as const });
    });
  }

  observeNeutralityProof(proof: ChromiumAutomaticInputNeutralityProof): Promise<void> {
    if (this.#state !== "open") return Promise.resolve();
    return this.#enqueue(proof.roleId, async () => {
      const recovery = this.#recoveries.get(proof.roleId);
      if (!recovery) {
        this.#neutralityProofs.set(proof.roleId, Object.freeze({ ...proof }));
        return;
      }
      if (recovery.cause !== "native-indeterminate" ||
        recovery.surfaceGeneration !== proof.surfaceGeneration ||
        recovery.expectedInputEpoch !== proof.inputEpoch) {
        return;
      }
      this.#neutralityProofs.delete(proof.roleId);
      await this.#complete(recovery);
    });
  }

  afterEffectDispatch(
    effect: CoreEffectRequest,
    result: CoreEffectResult,
    report: CoreEffectDispatchReport
  ): Promise<void> {
    if (this.#state !== "open" ||
      effect.action.type !== "browserAction" ||
      effect.action.request.intent !== "normal" ||
      !(report.accepted.includes(effect.effectId) || report.late.includes(effect.effectId)) ||
      !isRecoveryFailure(result)) {
      return Promise.resolve();
    }
    const request = effect.action.request;
    const cause = result.error?.code === "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
      ? "native-indeterminate" as const
      : "context-blocked" as const;
    return this.#enqueue(request.roleId, () => this.#establish(request, cause));
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#unsubscribe();
    this.#contexts.clear();
    this.#recoveries.clear();
    this.#neutralityProofs.clear();
    this.#navigationPending.clear();
    this.#challengedDocuments.clear();
    this.#contextListeners.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(contextError(
          "ELECTRON_AUTOMATIC_INPUT_CONTEXT_DISPOSED",
          "The Chromium automatic-input context coordinator is disposed."
        ));
      }
    }
    this.#waiters.clear();
  }

  #enqueue<Value>(roleId: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#tails.get(roleId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(roleId, tail);
    void tail.finally(() => {
      if (this.#tails.get(roleId) === tail) this.#tails.delete(roleId);
    });
    return result;
  }

  async #establish(
    request: BrowserActionRequest,
    cause: RecoveryCause
  ): Promise<void> {
    const context = this.#contexts.get(request.roleId);
    const identity = Object.freeze({
      recoveryId: request.requestId,
      roleId: request.roleId,
      expectedInputEpoch: request.inputEpoch + 1
    });
    try {
      const ticket = await this.#core.inspectRecovery(identity);
      if (ticket.recoveryId !== identity.recoveryId ||
        ticket.roleId !== identity.roleId ||
        ticket.inputEpoch !== identity.expectedInputEpoch ||
        !context) {
        throw contextError(
          "ELECTRON_AUTOMATIC_INPUT_RECOVERY_IDENTITY_MISMATCH",
          "Core recovery does not match the current Chromium input document."
        );
      }
      const drained = await this.#core.drainInput({
        roleId: identity.roleId,
        inputEpoch: identity.expectedInputEpoch
      });
      if (drained.roleId !== identity.roleId ||
        drained.inputEpoch !== identity.expectedInputEpoch || !drained.current) {
        throw contextError(
          "ELECTRON_AUTOMATIC_INPUT_RECOVERY_DRAIN_REJECTED",
          "Core did not drain the exact macro input recovery epoch."
        );
      }
      const established = Object.freeze({
        ...context,
        ...identity,
        cause
      });
      this.#recoveries.set(request.roleId, established);
      const proof = this.#neutralityProofs.get(request.roleId);
      if (cause === "native-indeterminate" && proof &&
        proof.surfaceGeneration === established.surfaceGeneration &&
        proof.inputEpoch === established.expectedInputEpoch) {
        this.#neutralityProofs.delete(request.roleId);
        await this.#complete(established);
      }
    } catch (error) {
      const normalized = normalizeRionBridgeError(
        error,
        "ELECTRON_AUTOMATIC_INPUT_RECOVERY_FAILED"
      );
      if (normalized.code === "MACRO_INPUT_RECOVERY_STALE") return;
      await this.#fail(identity, normalized);
      throw error;
    }
  }

  async #complete(recovery: ActiveRecoveryRecordWithCause): Promise<void> {
    try {
      const receipt = await this.#core.completeRecovery(recovery);
      const identity = {
        recoveryId: receipt.recoveryId,
        roleId: receipt.roleId,
        expectedInputEpoch: receipt.inputEpoch
      };
      const validTerminality = receipt.terminal
        ? receipt.deferredCount === 0
        : receipt.deferredCount > 0;
      if (!exactRecoveryReceipt(identity, recovery) || !validTerminality) {
        throw contextError(
          "ELECTRON_AUTOMATIC_INPUT_RECOVERY_COMPLETION_REJECTED",
          "Core did not classify the exact macro input recovery ticket completion."
        );
      }
      // A deferred receipt is an exact per-role completion in a multi-role
      // recovery group. Core retains the group and its restart intents until
      // the final role completes; Electron retires only this document-bound
      // observation so a repeated game event cannot resubmit completion.
      this.#recoveries.delete(recovery.roleId);
    } catch (error) {
      await this.#fail(recovery, error);
      throw error;
    }
  }

  async #fail(identity: RecoveryIdentity, cause: unknown): Promise<void> {
    const normalized = normalizeRionBridgeError(
      cause,
      "ELECTRON_AUTOMATIC_INPUT_RECOVERY_FAILED"
    );
    try {
      const receipt = await this.#core.failRecovery({
        ...identity,
        message: normalized.message
      });
      if (receipt.recoveryId !== identity.recoveryId ||
        receipt.roleId !== identity.roleId ||
        receipt.inputEpoch !== identity.expectedInputEpoch ||
        !receipt.failed || !receipt.restartRequired) {
        throw contextError(
          "ELECTRON_AUTOMATIC_INPUT_RECOVERY_FAILURE_REJECTED",
          "Core did not retain restart-required state for the exact recovery ticket."
        );
      }
      this.#recoveries.delete(identity.roleId);
    } catch (failureError) {
      this.#onError(normalizeRionBridgeError(
        failureError,
        "ELECTRON_AUTOMATIC_INPUT_RECOVERY_FAILURE_UNKNOWN"
      ));
    }
  }

  #matchesGameContext(
    context: InputContextRecord,
    identity: ChromiumAutomaticInputContextIdentity
  ): boolean {
    return context.roleId === identity.roleId &&
      context.surfaceGeneration === identity.surfaceGeneration &&
      context.documentInstanceId === identity.documentInstanceId &&
      context.target === "game";
  }

  #notifyContext(context: InputContextRecord): void {
    const identity = Object.freeze({
      documentInstanceId: context.documentInstanceId,
      roleId: context.roleId,
      surfaceGeneration: context.surfaceGeneration
    });
    for (const listener of this.#contextListeners) {
      try {
        listener(identity);
      } catch {
        // Input-context truth cannot be blocked by an observer failure.
      }
    }
  }

  #resolveGameContextWaiters(context: InputContextRecord): void {
    if (context.target !== "game" || !this.#matchesChallenge(context)) return;
    const waiters = this.#waiters.get(context.roleId);
    if (!waiters) return;
    for (const waiter of waiters) {
      if (!this.#matchesGameContext(context, waiter)) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
    if (waiters.size === 0) this.#waiters.delete(context.roleId);
  }

  #matchesChallenge(identity: ChromiumAutomaticInputContextIdentity): boolean {
    const challenge = this.#challengedDocuments.get(identity.roleId);
    return challenge?.surfaceGeneration === identity.surfaceGeneration &&
      challenge.documentInstanceId === identity.documentInstanceId;
  }

  readonly #onSurfaceLifecycle = (event: ChromiumRoleOverlayLifecycleEvent): void => {
    const waiters = this.#waiters.get(event.roleId);
    if (waiters) {
      for (const waiter of waiters) {
        if (waiter.surfaceGeneration !== event.generation) continue;
        waiters.delete(waiter);
        waiter.reject(contextError(
          event.reason === "surface-retired"
            ? "ELECTRON_AUTOMATIC_INPUT_SURFACE_RETIRED"
            : "ELECTRON_AUTOMATIC_INPUT_DOCUMENT_SUPERSEDED",
          "The exact Chromium input document retired before it became ready."
        ));
      }
      if (waiters.size === 0) this.#waiters.delete(event.roleId);
    }
    const context = this.#contexts.get(event.roleId);
    if (context?.surfaceGeneration === event.generation) {
      this.#contexts.delete(event.roleId);
    }
    const challenge = this.#challengedDocuments.get(event.roleId);
    if (challenge?.surfaceGeneration === event.generation) {
      this.#challengedDocuments.delete(event.roleId);
    }
    const recovery = this.#recoveries.get(event.roleId);
    if (!recovery || recovery.surfaceGeneration !== event.generation) return;
    if (recovery.cause === "native-indeterminate" &&
      event.reason === "document-superseded") {
      this.#navigationPending.add(event.roleId);
      return;
    }
    void this.#enqueue(event.roleId, () => this.#fail(
      recovery,
      contextError(
        "ELECTRON_AUTOMATIC_INPUT_RECOVERY_DOCUMENT_SUPERSEDED",
        "The Chromium input document changed before recovery completed."
      )
    )).catch((error) => this.#onError(normalizeRionBridgeError(
      error,
      "ELECTRON_AUTOMATIC_INPUT_RECOVERY_FAILURE_UNKNOWN"
    )));
  };
}
