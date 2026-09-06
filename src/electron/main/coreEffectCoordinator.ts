import type {
  CoreErrorPayload,
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEffectResult,
  CoreEvent
} from "../../shared/generated";
import type { CoreEventStreamFailure } from "../core/coreAddonClient";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type { ElectronCoreEventSource } from "./coreRendererEventBridge";
import {
  isCoreEffectEventContinuation,
  type CoreEffectContinuationCancelReason,
  type CoreEffectEventContinuation,
  type CoreEffectExecutionContext
} from "./coreEffectContinuation";

export interface ElectronCoreEffectPort extends ElectronCoreEventSource {
  dispatchCoreEffectResults: (
    results: CoreEffectResult[]
  ) => Promise<CoreEffectDispatchReport>;
  subscribeCoreEventStreamFailures?: (
    listener: (failure: CoreEventStreamFailure) => void
  ) => () => void;
}

export interface CoreEffectCoordinatorInput {
  core: ElectronCoreEffectPort;
  processReceiptLedger: CoreEffectProcessReceiptLedger;
  execute: (
    effect: CoreEffectRequest,
    context: CoreEffectExecutionContext
  ) => Promise<unknown>;
  afterDispatch?: (
    effect: CoreEffectRequest,
    result: CoreEffectResult,
    report: CoreEffectDispatchReport
  ) => void | Promise<void>;
  onEventStreamFailure?: (
    terminal: CoreEffectEventStreamFailureTerminal
  ) => void;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export interface CoreEffectEventStreamFailureTerminal {
  readonly error: CoreErrorPayload;
  readonly drained: Promise<void>;
}

interface CoreEffectProcessReceipt {
  readonly fingerprint: string;
  readonly result: Promise<CoreEffectResult>;
}

export interface CoreEffectProcessReceiptLedger {
  findDestructive: (effectId: string) => CoreEffectProcessReceipt | undefined;
  reserveDestructive: (
    effectId: string,
    receipt: CoreEffectProcessReceipt
  ) => boolean;
}

type CoordinatorState = "idle" | "open" | "draining" | "disposed";
const MAX_RETAINED_EFFECT_RECEIPTS = 4_096;
const MAX_RETAINED_DESTRUCTIVE_EFFECT_RECEIPTS = 4_096;

interface EffectExecutionRecord {
  readonly abortOnDrain: boolean;
  readonly abort: AbortController;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly result: Promise<CoreEffectResult>;
  readonly resolve: (result: CoreEffectResult) => void;
  readonly cancellationFailureSignal: Promise<never>;
  readonly rejectCancellationFailure: (error: unknown) => void;
  readonly projectionSettled: Promise<void>;
  readonly resolveProjectionSettled: () => void;
  cancellationFailed: boolean;
  cancellationFailure: unknown;
  cancellationReason: CoreEffectContinuationCancelReason | null;
  continuation: CoreEffectEventContinuation | null;
  settled: boolean;
}

interface ProjectionAdmissionSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function projectionAdmissionSignal(): ProjectionAdmissionSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function createCoreEffectProcessReceiptLedger(): CoreEffectProcessReceiptLedger {
  const destructiveReceipts = new Map<string, CoreEffectProcessReceipt>();
  let destructiveCapacityExhausted = false;
  return {
    findDestructive: (effectId) => destructiveReceipts.get(effectId),
    reserveDestructive: (effectId, receipt) => {
      if (
        destructiveCapacityExhausted ||
        destructiveReceipts.size >= MAX_RETAINED_DESTRUCTIVE_EFFECT_RECEIPTS
      ) {
        destructiveCapacityExhausted = true;
        return false;
      }
      if (destructiveReceipts.has(effectId)) return false;
      destructiveReceipts.set(effectId, receipt);
      return true;
    }
  };
}

async function joinEventStreamDrains(
  effectDrain: Promise<void>,
  coreCleanupDrain: Promise<void>
): Promise<void> {
  const results = await Promise.allSettled([effectDrain, coreCleanupDrain]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}

function validateEffect(effect: CoreEffectRequest): void {
  if (
    effect.effectId.length === 0 ||
    effect.operationId.length === 0 ||
    effect.target.handleId.length === 0
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_INVALID",
      message: "Core emitted an effect without a stable effect, operation, or target identity."
    });
  }
  if (effect.completionPolicy === "eventBound" && effect.deadlineMs !== undefined) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_POLICY_INVALID",
      message: "An event-bound Core effect must not carry a deadline."
    });
  }
  if (
    effect.completionPolicy === "deadlineBound" &&
    (!Number.isSafeInteger(effect.deadlineMs) || (effect.deadlineMs ?? 0) < 1)
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_POLICY_INVALID",
      message: "A deadline-bound Core effect must carry a positive Core-owned deadline."
    });
  }
}

function laneKey(effect: CoreEffectRequest): string {
  if (
    effect.action.type === "embeddedPrepareTabRoleReload" ||
    effect.action.type === "embeddedCommitTabRoleReload"
  ) {
    return `role-reload:${effect.action.reloadOperationId}`;
  }
  if (effect.action.type === "embeddedSupersedeTabRoleReload") {
    return `role-reload-control:${effect.action.reloadOperationId}`;
  }
  // App-target effects mutate one shared native topology registry. Core may use
  // a tab or role ID as the receipt handle, but that handle is not an independent
  // native actor: two launches can still converge on the same window. Preserve
  // Core event order across the application actor and retain per-WebContents
  // concurrency only for genuinely independent native handles.
  if (effect.target.kind === "app") return "app";
  return `${effect.target.kind}:${effect.target.handleId}`;
}

function effectFingerprint(effect: CoreEffectRequest): string {
  const encoded = JSON.stringify(effect);
  if (encoded === undefined) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_INVALID",
      message: "Core emitted an effect that cannot be identity-fenced."
    });
  }
  return encoded;
}

function isDestructiveEffect(effect: CoreEffectRequest): boolean {
  return effect.action.type === "roleBrowserDataClearSession";
}

function destructiveReceiptCapacityError(): RionBridgeError {
  return new RionBridgeError({
    code: "ELECTRON_DESTRUCTIVE_EFFECT_REPLAY_CAPACITY",
    message: "The destructive effect replay ledger is full; restart Rion Studio before retrying."
  });
}

function effectRecord(
  fingerprint: string,
  operationId: string,
  abortOnDrain: boolean
): EffectExecutionRecord {
  let resolve!: (result: CoreEffectResult) => void;
  let rejectCancellationFailure!: (error: unknown) => void;
  let resolveProjectionSettled!: () => void;
  const result = new Promise<CoreEffectResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const cancellationFailureSignal = new Promise<never>((_resolve, reject) => {
    rejectCancellationFailure = reject;
  });
  void cancellationFailureSignal.catch(() => undefined);
  const projectionSettled = new Promise<void>((resolvePromise) => {
    resolveProjectionSettled = resolvePromise;
  });
  return {
    abortOnDrain,
    abort: new AbortController(),
    fingerprint,
    operationId,
    result,
    resolve,
    cancellationFailureSignal,
    rejectCancellationFailure,
    projectionSettled,
    resolveProjectionSettled,
    cancellationFailed: false,
    cancellationFailure: undefined,
    cancellationReason: null,
    continuation: null,
    settled: false
  };
}

function mutatesRuntimeProjection(effect: CoreEffectRequest): boolean {
  switch (effect.action.type) {
    case "embeddedCreateTab":
    case "embeddedSetTabAudioMuted":
    case "embeddedDestroyRole":
    case "embeddedClaimRoleSlot":
    case "embeddedDestroyTab":
    case "embeddedFollowRoleOwnership":
    case "embeddedApplyAppKitProjection":
    case "embeddedProvisionWindowForTabMove":
    case "embeddedRetireProvisionedWindow":
    case "embeddedSetRuntimeWindowVisibility":
    case "embeddedSetRuntimeWindowPresentation":
    case "embeddedSetRuntimeWindowZoom":
      return true;
    default:
      return false;
  }
}

function effectFailure(effect: CoreEffectRequest, error: unknown): CoreEffectResult {
  return {
    effectId: effect.effectId,
    operationId: effect.operationId,
    ok: false,
    valueJson: null,
    error: normalizeRionBridgeError(error, "ELECTRON_CORE_EFFECT_FAILED")
  };
}

function effectSuccess(effect: CoreEffectRequest, value: unknown): CoreEffectResult {
  let valueJson: string | null = null;
  if (value !== undefined) {
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error("The effect result is not JSON serializable.");
      valueJson = encoded;
    } catch (error) {
      return effectFailure(effect, new RionBridgeError({
        code: "ELECTRON_CORE_EFFECT_RESULT_INVALID",
        message: error instanceof Error
          ? error.message
          : "The effect result is not JSON serializable."
      }));
    }
  }
  return {
    effectId: effect.effectId,
    operationId: effect.operationId,
    ok: true,
    valueJson,
    error: null
  };
}

function cancellationError(
  reason: CoreEffectContinuationCancelReason
): RionBridgeError {
  const details = {
    actorStop: {
      code: "ELECTRON_CORE_EFFECT_ACTOR_STOPPED",
      message: "The native effect actor stopped before its authoritative event."
    },
    coreCancelled: {
      code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED",
      message: "Core cancelled the effect before its authoritative native event."
    },
    deadlineElapsed: {
      code: "ELECTRON_CORE_EFFECT_DEADLINE_ELAPSED",
      message: "The Core-owned effect deadline elapsed before native completion."
    },
    eventStreamFailure: {
      code: "ELECTRON_CORE_EFFECT_EVENT_STREAM_FAILED",
      message: "The authoritative native event stream failed before effect completion."
    },
    focusSuperseded: {
      code: "ELECTRON_CORE_EFFECT_FOCUS_SUPERSEDED",
      message: "A newer native focus intent superseded the pending effect."
    },
    lifecycleSuperseded: {
      code: "ELECTRON_CORE_EFFECT_LIFECYCLE_SUPERSEDED",
      message: "A newer application lifecycle superseded the pending effect."
    }
  } satisfies Record<CoreEffectContinuationCancelReason, {
    code: string;
    message: string;
  }>;
  return new RionBridgeError(details[reason]);
}

function validateDispatchReport(
  report: CoreEffectDispatchReport,
  effectId: string
): void {
  const classifications = [
    ...report.accepted,
    ...report.duplicate,
    ...report.late,
    ...report.unknown,
    ...report.operationMismatch
  ].filter((candidate) => candidate === effectId);
  if (classifications.length !== 1) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_ACK_INVALID",
      message: "Core did not classify the Electron effect acknowledgement exactly once."
    });
  }
  if (report.unknown.includes(effectId) || report.operationMismatch.includes(effectId)) {
    throw new RionBridgeError({
      code: "ELECTRON_CORE_EFFECT_ACK_REJECTED",
      message: "Core rejected the Electron effect acknowledgement identity."
    });
  }
}

export class CoreEffectCoordinator {
  readonly #input: CoreEffectCoordinatorInput;
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #terminalTasks = new Set<Promise<void>>();
  readonly #projectionTasks = new Set<Promise<void>>();
  readonly #recordsByEffectId = new Map<string, EffectExecutionRecord>();
  readonly #effectRecordOrder: string[] = [];
  #projectionSequence = 0;
  #coreRevision = -1;
  #nextProjectionAdmission = projectionAdmissionSignal();
  #state: CoordinatorState = "idle";
  #unsubscribe: (() => void) | null = null;
  #unsubscribeEventStreamFailures: (() => void) | null = null;
  #disposePromise: Promise<void> | null = null;
  #drainFailure: { error: unknown } | null = null;
  #eventStreamFailureRouted = false;

  constructor(input: CoreEffectCoordinatorInput) {
    this.#input = input;
  }

  start(): void {
    if (this.#state === "disposed" || this.#state === "draining") {
      throw new Error("The Core effect coordinator is no longer accepting work.");
    }
    if (this.#state === "open") return;
    this.#state = "open";
    try {
      this.#unsubscribe = this.#input.core.subscribeCoreEvents(this.#onCoreEvent);
      this.#unsubscribeEventStreamFailures =
        this.#input.core.subscribeCoreEventStreamFailures?.(
          this.#onCoreEventStreamFailure
        ) ?? null;
    } catch (error) {
      const unsubscribe = this.#unsubscribe;
      this.#unsubscribe = null;
      this.#unsubscribeEventStreamFailures = null;
      this.#state = "idle";
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (cleanupError) {
          this.#reportError(
            cleanupError,
            "ELECTRON_CORE_EFFECT_STARTUP_UNSUBSCRIBE_FAILED"
          );
        }
      }
      throw error;
    }
  }

  /**
   * Event-bound projection fence for readers that require one coherent
   * Core/native snapshot. Work admitted before the fence must finish its
   * native terminal receipt and Core acknowledgement before the reader runs.
   */
  async settleCurrentProjectionEffects(): Promise<number> {
    while (true) {
      const pending = [...this.#projectionTasks];
      if (pending.length === 0) return this.#projectionSequence;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Captures the application mutation lane at the call boundary. Native
   * callbacks produced by one effect must not overtake that effect's Core
   * acknowledgement when they project the resulting AppKit layout.
   */
  async settleCurrentApplicationEffects(): Promise<void> {
    const pending = this.#lanes.get("app");
    if (pending) await pending;
  }

  async waitForProjectionAfter(sequence: number): Promise<number> {
    while (this.#projectionSequence <= sequence) {
      if (this.#state !== "open") {
        throw new RionBridgeError({
          code: "ELECTRON_CORE_EFFECT_ACTOR_STOPPED",
          message: "The native projection actor stopped before a newer effect arrived."
        });
      }
      const admission = this.#nextProjectionAdmission.promise;
      if (this.#projectionSequence > sequence) break;
      await admission;
    }
    return this.settleCurrentProjectionEffects();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    return this.#beginDrain("actorStop", false);
  }

  readonly #onCoreEvent = (event: CoreEvent): void => {
    if (this.#state !== "open") return;
    // Core can commit final topology after acknowledging the last native
    // effect, without admitting another effect (for example an empty window
    // retirement). Snapshot readers must observe that authoritative progress.
    if (event.type === "stateChanged" && event.revision > this.#coreRevision) {
      this.#coreRevision = event.revision;
      this.#advanceProjectionSequence();
      return;
    }
    if (event.type === "coreEffects") {
      for (const effect of event.effects) this.#enqueue(effect);
      return;
    }
    if (event.type === "coreEffectCancellations") {
      for (const cancellation of event.cancellations) {
        this.#cancelRecord(
          cancellation.effectId,
          cancellation.operationId,
          cancellation.reason === "actorStopped"
            ? "actorStop"
            : cancellation.reason === "deadlineElapsed"
              ? "deadlineElapsed"
              : "coreCancelled"
        );
      }
      return;
    }
    if (event.type === "shutdown") {
      for (const [effectId, record] of this.#recordsByEffectId) {
        if (!record.settled) this.#cancelRecord(effectId, null, "actorStop");
      }
    }
  };

  readonly #onCoreEventStreamFailure = (
    failure: CoreEventStreamFailure
  ): void => {
    if (this.#eventStreamFailureRouted || this.#state === "idle") return;
    this.#eventStreamFailureRouted = true;
    const wasOpen = this.#state === "open";
    const effectDrain = wasOpen
      ? this.#beginDrain("eventStreamFailure", true, failure.error)
      : this.#disposePromise ?? Promise.resolve();
    const subscriptionDrain = wasOpen
      ? Promise.resolve()
      : this.#detachEventStreamFailureSubscription();
    const drained = joinEventStreamDrains(
      joinEventStreamDrains(effectDrain, failure.drained),
      subscriptionDrain
    );
    void drained.catch(() => undefined);
    try {
      this.#input.onEventStreamFailure?.(Object.freeze({
        error: Object.freeze({ ...failure.error }),
        drained
      }));
    } catch (error) {
      this.#reportError(
        error,
        "ELECTRON_CORE_EVENT_STREAM_FAILURE_HANDLER_FAILED"
      );
    }
  };

  /** Final checked Core shutdown closes the retained health subscription. */
  finishEventStreamObservation(): void {
    void this.#detachEventStreamFailureSubscription().catch((error: unknown) => {
      this.#reportError(
        error,
        "ELECTRON_CORE_EVENT_STREAM_UNSUBSCRIBE_FAILED"
      );
    });
  }

  #enqueue(effect: CoreEffectRequest): void {
    let fingerprint: string;
    try {
      fingerprint = effectFingerprint(effect);
    } catch (error) {
      this.#trackTerminalTask((async () => {
        await this.#acknowledge(effect, effectFailure(effect, error));
      })());
      return;
    }
    const destructive = isDestructiveEffect(effect);
    const existing = this.#input.processReceiptLedger.findDestructive(effect.effectId)
      ?? this.#recordsByEffectId.get(effect.effectId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.#trackTerminalTask((async () => {
          await this.#acknowledge(effect, effectFailure(effect, new RionBridgeError({
            code: "ELECTRON_CORE_EFFECT_ID_REUSED",
            message: "Core reused an effect identity for a different native intent."
          })));
        })());
      } else {
        this.#trackTerminalTask((async () => {
          await this.#acknowledge(effect, await existing.result);
        })());
      }
      return;
    }
    const record = effectRecord(
      fingerprint,
      effect.operationId,
      destructive
    );
    if (destructive && !this.#input.processReceiptLedger.reserveDestructive(
      effect.effectId,
      { fingerprint, result: record.result }
    )) {
      this.#trackTerminalTask((async () => {
        await this.#acknowledge(
          effect,
          effectFailure(effect, destructiveReceiptCapacityError())
        );
      })());
      return;
    }
    this.#recordsByEffectId.set(effect.effectId, record);
    this.#effectRecordOrder.push(effect.effectId);
    if (mutatesRuntimeProjection(effect)) {
      this.#advanceProjectionSequence();
      this.#projectionTasks.add(record.projectionSettled);
      void record.projectionSettled.then(() => {
        this.#projectionTasks.delete(record.projectionSettled);
      });
    }
    this.#enqueueTask(effect, () => this.#executeFirst(effect, record));
  }

  #advanceProjectionSequence(): void {
    this.#projectionSequence += 1;
    const admitted = this.#nextProjectionAdmission;
    this.#nextProjectionAdmission = projectionAdmissionSignal();
    admitted.resolve();
  }

  #enqueueTask(effect: CoreEffectRequest, task: () => Promise<void>): void {
    const key = laneKey(effect);
    const previous = this.#lanes.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(task);
    this.#lanes.set(key, current);
    const release = () => {
      if (this.#lanes.get(key) === current) this.#lanes.delete(key);
    };
    void current.then(release, release);
  }

  async #executeFirst(
    effect: CoreEffectRequest,
    record: EffectExecutionRecord
  ): Promise<void> {
    if (record.cancellationReason) {
      await this.#settleRecord(
        effect,
        record,
        effectFailure(effect, cancellationError(record.cancellationReason))
      );
      return;
    }
    let execution: unknown;
    try {
      validateEffect(effect);
      execution = await this.#input.execute(effect, {
        signal: record.abort.signal
      });
    } catch (error) {
      await this.#settleRecord(
        effect,
        record,
        effectFailure(
          effect,
          record.cancellationReason
            ? cancellationError(record.cancellationReason)
            : error
        )
      );
      return;
    }
    if (isCoreEffectEventContinuation(execution)) {
      record.continuation = execution;
      try {
        if (this.#state !== "open" && !record.cancellationReason) {
          this.#cancelRecord(effect.effectId, effect.operationId, "actorStop");
        } else if (record.cancellationReason) {
          this.#cancelContinuation(record, execution, record.cancellationReason);
        }
      } catch (error) {
        await this.#settleRecord(
          effect,
          record,
          effectFailure(
            effect,
            record.cancellationReason
              ? cancellationError(record.cancellationReason)
              : error
          )
        );
        return;
      }
      this.#trackTerminalTask(this.#settleContinuation(effect, record, execution));
      return;
    }
    const result = record.cancellationReason
      ? effectFailure(effect, cancellationError(record.cancellationReason))
      : effectSuccess(effect, execution);
    await this.#settleRecord(effect, record, result);
  }

  async #settleContinuation(
    effect: CoreEffectRequest,
    record: EffectExecutionRecord,
    continuation: CoreEffectEventContinuation
  ): Promise<void> {
    let result: CoreEffectResult;
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        void continuation.completion.then(resolve, reject);
        void record.cancellationFailureSignal.catch(reject);
      });
      // Once an EventBound executor has returned a continuation, it is the
      // only layer that knows whether native submission already began. Its
      // terminal value therefore remains authoritative even when Core or the
      // actor requested cancellation in the meantime. Loss of the event
      // stream is different: cleanup still has to finish, but no native value
      // can restore the missing authority, so the stable stream failure wins.
      result = record.cancellationReason === "eventStreamFailure"
        ? effectFailure(effect, cancellationError("eventStreamFailure"))
        : effectSuccess(effect, value);
    } catch (error) {
      const terminal = normalizeRionBridgeError(
        error,
        "ELECTRON_CORE_EFFECT_FAILED"
      );
      // Older continuations may reject with an unclassified Error after their
      // cancel callback runs. Preserve the coordinator's stable cancellation
      // code for that legacy shape, but never overwrite a continuation-owned
      // Failed/Indeterminate/Superseded classification.
      result = effectFailure(effect,
        record.cancellationReason === "eventStreamFailure"
          ? cancellationError("eventStreamFailure")
          : record.cancellationReason && terminal.code === "ELECTRON_CORE_EFFECT_FAILED"
            ? cancellationError(record.cancellationReason)
            : terminal
      );
    }
    await this.#settleRecord(effect, record, result);
  }

  async #settleRecord(
    effect: CoreEffectRequest,
    record: EffectExecutionRecord,
    result: CoreEffectResult
  ): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    record.continuation = null;
    record.resolve(result);
    this.#pruneEffectRecords();
    await this.#acknowledge(effect, result);
    record.resolveProjectionSettled();
  }

  #cancelRecord(
    effectId: string,
    operationId: string | null,
    reason: CoreEffectContinuationCancelReason
  ): void {
    const record = this.#recordsByEffectId.get(effectId);
    if (!record || record.settled) return;
    if (operationId && record.operationId !== operationId) {
      this.#reportError(new RionBridgeError({
        code: "ELECTRON_CORE_EFFECT_CANCELLATION_MISMATCH",
        message: "Core cancelled an effect with a mismatched operation identity."
      }), "ELECTRON_CORE_EFFECT_CANCELLATION_MISMATCH");
      return;
    }
    if (record.cancellationReason) return;
    record.cancellationReason = reason;
    if (!record.abort.signal.aborted) record.abort.abort(reason);
    if (record.continuation) {
      this.#cancelContinuation(record, record.continuation, reason);
    }
  }

  #cancelContinuation(
    record: EffectExecutionRecord,
    continuation: CoreEffectEventContinuation,
    reason: CoreEffectContinuationCancelReason
  ): void {
    try {
      continuation.cancel(reason);
    } catch (error) {
      record.cancellationFailed = true;
      record.cancellationFailure = error;
      record.rejectCancellationFailure(error);
      if (this.#state === "draining") this.#rememberDrainFailure(error);
      this.#reportError(error, "ELECTRON_CORE_EFFECT_CANCELLATION_FAILED");
    }
  }

  #beginDrain(
    reason: "actorStop" | "eventStreamFailure",
    cancelEveryRecord: boolean,
    terminalError?: unknown
  ): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    let resolveDispose!: () => void;
    let rejectDispose!: (error: unknown) => void;
    this.#disposePromise = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    // Some lower-layer harnesses intentionally omit the fatal owner. Retain a
    // rejecting terminal for real consumers without creating an unhandled
    // rejection when no one is present to observe it.
    void this.#disposePromise.catch(() => undefined);
    this.#state = "draining";
    this.#nextProjectionAdmission.resolve();
    let cancellationFailure: unknown;
    let cancellationFailed = false;
    const attempt = (work: () => void): void => {
      try {
        work();
      } catch (error) {
        if (!cancellationFailed) cancellationFailure = error;
        cancellationFailed = true;
      }
    };
    if (this.#unsubscribe) attempt(this.#unsubscribe);
    this.#unsubscribe = null;
    if (reason === "eventStreamFailure" && this.#unsubscribeEventStreamFailures) {
      attempt(this.#unsubscribeEventStreamFailures);
      this.#unsubscribeEventStreamFailures = null;
    }
    for (const [effectId, record] of this.#recordsByEffectId) {
      if (record.cancellationFailed) {
        if (!cancellationFailed) cancellationFailure = record.cancellationFailure;
        cancellationFailed = true;
      }
      if (!record.settled && (
        cancelEveryRecord || record.continuation || record.abortOnDrain
      )) {
        attempt(() => this.#cancelRecord(effectId, null, reason));
      }
    }
    if (cancellationFailed) {
      this.#rememberDrainFailure(cancellationFailure);
    }
    void this.#drainTasks().then(() => {
      this.#state = "disposed";
      this.#lanes.clear();
      this.#terminalTasks.clear();
      this.#projectionTasks.clear();
      this.#recordsByEffectId.clear();
      this.#effectRecordOrder.length = 0;
      if (terminalError !== undefined) {
        this.#reportError(terminalError, "ELECTRON_CORE_EVENT_STREAM_FAILED");
      }
      if (this.#drainFailure !== null) rejectDispose(this.#drainFailure.error);
      else resolveDispose();
    }, rejectDispose);
    return this.#disposePromise;
  }

  #trackTerminalTask(task: Promise<void>): void {
    this.#terminalTasks.add(task);
    void task.then(
      () => this.#terminalTasks.delete(task),
      () => this.#terminalTasks.delete(task)
    );
  }

  async #drainTasks(): Promise<void> {
    await Promise.allSettled([...this.#lanes.values()]);
    while (this.#terminalTasks.size > 0) {
      await Promise.allSettled([...this.#terminalTasks]);
    }
  }

  #rememberDrainFailure(error: unknown): void {
    this.#drainFailure ??= { error };
  }

  #detachEventStreamFailureSubscription(): Promise<void> {
    const unsubscribe = this.#unsubscribeEventStreamFailures;
    this.#unsubscribeEventStreamFailures = null;
    if (!unsubscribe) return Promise.resolve();
    try {
      unsubscribe();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async #acknowledge(
    effect: CoreEffectRequest,
    result: CoreEffectResult
  ): Promise<void> {
    let report: CoreEffectDispatchReport;
    try {
      report = await this.#input.core.dispatchCoreEffectResults([result]);
      validateDispatchReport(report, effect.effectId);
    } catch (error) {
      this.#reportError(
        error,
        "ELECTRON_CORE_EFFECT_ACK_FAILED"
      );
      return;
    }
    try {
      await this.#input.afterDispatch?.(effect, result, report);
    } catch (error) {
      this.#reportError(
        error,
        "ELECTRON_CORE_EFFECT_POST_DISPATCH_FAILED"
      );
    }
  }

  #reportError(error: unknown, fallbackCode: string): void {
    try {
      this.#input.onError(normalizeRionBridgeError(error, fallbackCode));
    } catch {
      // Error presentation is observational and cannot change terminality.
    }
  }

  #pruneEffectRecords(): void {
    while (this.#recordsByEffectId.size > MAX_RETAINED_EFFECT_RECEIPTS) {
      const oldestEffectId = this.#effectRecordOrder[0];
      if (!oldestEffectId) return;
      const record = this.#recordsByEffectId.get(oldestEffectId);
      if (record && !record.settled) return;
      this.#effectRecordOrder.shift();
      if (record) this.#recordsByEffectId.delete(oldestEffectId);
    }
  }
}
