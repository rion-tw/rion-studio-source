export type CoreEffectContinuationCancelReason =
  | "actorStop"
  | "coreCancelled"
  | "deadlineElapsed"
  | "eventStreamFailure"
  | "focusSuperseded"
  | "lifecycleSuperseded";

export interface CoreEffectExecutionContext {
  readonly signal: AbortSignal;
}

const CORE_EFFECT_EVENT_CONTINUATION = Symbol(
  "rion.core-effect-event-continuation"
);

/**
 * Admission has completed, but the Core effect still awaits its authoritative
 * native event. The coordinator releases the mutation lane while retaining
 * this continuation as the sole source of the eventual Core acknowledgement.
 */
export interface CoreEffectEventContinuation<T = unknown> {
  readonly kind: "eventContinuation";
  readonly completion: Promise<T>;
  readonly cancel: (reason: CoreEffectContinuationCancelReason) => void;
  readonly [CORE_EFFECT_EVENT_CONTINUATION]: true;
}

export function coreEffectEventContinuation<T>(
  completion: Promise<T>,
  cancel: (reason: CoreEffectContinuationCancelReason) => void
): CoreEffectEventContinuation<T> {
  return Object.freeze({
    kind: "eventContinuation" as const,
    completion,
    cancel,
    [CORE_EFFECT_EVENT_CONTINUATION]: true as const
  });
}

export function isCoreEffectEventContinuation(
  value: unknown
): value is CoreEffectEventContinuation {
  return typeof value === "object" && value !== null &&
    CORE_EFFECT_EVENT_CONTINUATION in value &&
    (value as CoreEffectEventContinuation)[CORE_EFFECT_EVENT_CONTINUATION] === true;
}
