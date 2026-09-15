import { isCoreEffectEventContinuation } from "../main/coreEffectContinuation";

/** Observe without replacing the continuation, cancel hook, or Core outcome. */
export function observeRuntimeEffectCompletion(
  result: unknown,
  completed: (value: unknown) => void,
  rejected: (error: unknown) => void,
  observationFailed: (error: unknown) => void
): void {
  const observe = (callback: (value: unknown) => void, value: unknown): void => {
    try { callback(value); }
    catch (error) {
      try { observationFailed(error); }
      catch { /* The observer cannot change an authoritative effect outcome. */ }
    }
  };
  if (isCoreEffectEventContinuation(result)) {
    void result.completion.then(
      value => observe(completed, value), error => observe(rejected, error)
    );
  } else observe(completed, result);
}
