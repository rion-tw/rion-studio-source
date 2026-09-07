import type { ElectronApplicationLifecycleController, ElectronApplicationPowerEvent } from
  "../main/applicationLifecycleController";

/** E2E-only: exercise the installed power listener and observe its exact Core-backed promise. */
export async function emitObservedApplicationPowerSignal(
  lifecycle: ElectronApplicationLifecycleController,
  emit: (event: ElectronApplicationPowerEvent) => unknown,
  event: ElectronApplicationPowerEvent
) {
  const before = lifecycle.snapshot();
  const originalSignal = lifecycle.signal;
  const hadOwnSignal = Object.hasOwn(lifecycle, "signal");
  const observed: ReturnType<typeof lifecycle.signal>[] = [];
  lifecycle.signal = function (observedEvent) {
    const result = originalSignal.call(this, observedEvent);
    if (this === lifecycle && observedEvent === event) observed.push(result);
    return result;
  };
  try {
    // EventEmitter dispatches synchronously. Never fall back to invoking signal directly.
    emit(event);
  } finally {
    if (hadOwnSignal) lifecycle.signal = originalSignal;
    else Reflect.deleteProperty(lifecycle, "signal");
  }
  if (observed.length !== 1) {
    throw new Error(`Expected one installed power listener receipt; observed ${observed.length}.`);
  }
  const terminal = await observed[0]!;
  return Object.freeze({
    before: Object.freeze({ ...before }),
    event,
    terminal: Object.freeze({ ...terminal })
  });
}
