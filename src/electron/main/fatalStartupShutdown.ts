import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type { CoreEffectEventStreamFailureTerminal } from
  "./coreEffectCoordinator";

interface ShutdownPort {
  shutdown: () => Promise<void>;
}

interface LifecycleDrainPort {
  beginFatalQuit?: () => void;
  prepareFatalQuit?: () => Promise<void>;
  prepareQuit: () => Promise<void>;
}

/**
 * Last-resort process-termination bound. The fatal drain awaits the same
 * cached shutdown promise it exists to rescue, so a Core/runtime drain that
 * never settles would otherwise keep the process alive with `before-quit`
 * permanently prevented. Expiry is an explicit unclean termination: it never
 * reports a clean quit and never skips the nonzero exit code.
 */
export const FATAL_TERMINATION_DEADLINE_MS = 20_000;

export interface ElectronFatalTerminationCoordinatorInput {
  lifecycle: () => LifecycleDrainPort | null;
  runtime: () => ShutdownPort | null;
  core: () => ShutdownPort | null;
  disposeShell: () => Promise<void>;
  quit: () => void;
  forceExit: (code: number) => void;
  terminationDeadlineMs?: number;
  /**
   * Actor-stop edge fired synchronously when the shared fatal owner begins.
   * Owners of EventBound native waits use it to abandon work that can no
   * longer be confirmed, so the drain cannot hold the process open.
   */
  onTerminationBegan?: () => void;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export interface ElectronFatalEventStreamRouterInput {
  onFatalDetected?: () => void | Promise<void>;
  terminate: () => Promise<unknown>;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

async function joinFatalDrains(
  effectDrain: Promise<void>,
  rendererDrain: Promise<void>
): Promise<void> {
  const results = await Promise.allSettled([effectDrain, rendererDrain]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) throw failure.reason;
}

export interface ElectronFatalStartupShutdownInput {
  lifecycle: LifecycleDrainPort | null;
  runtime: ShutdownPort | null;
  core: ShutdownPort | null;
  disposeShell: () => Promise<void>;
  quit: () => void;
  forceExit: (code: number) => void;
  forceExitRequired?: () => boolean;
  terminationDeadlineMs?: number;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

interface FatalStartupWaiter {
  reject: (error: RionBridgeError) => void;
  settled: boolean;
}

function reportFailure(
  input: ElectronFatalStartupShutdownInput,
  error: unknown,
  fallbackCode: string
): void {
  try {
    input.onError(normalizeRionBridgeError(error, fallbackCode));
  } catch {
    // Error reporting is observational and cannot prevent fatal termination.
  }
}

const TERMINATION_DEADLINE_EXPIRED = Symbol("fatal-termination-deadline");

interface TerminationDeadline {
  expired: boolean;
  bound: <Value>(work: Promise<Value>) => Promise<Value | typeof TERMINATION_DEADLINE_EXPIRED>;
  dispose: () => void;
}

/**
 * Bounds the fatal drain without cancelling it. The drain keeps running, but
 * it can no longer hold the process open: on expiry the caller exits nonzero.
 * Elapsed time is never success and never reaches `quit()`.
 */
function createTerminationDeadline(durationMs: number): TerminationDeadline {
  let settle!: () => void;
  const expiry = new Promise<typeof TERMINATION_DEADLINE_EXPIRED>((resolve) => {
    settle = () => resolve(TERMINATION_DEADLINE_EXPIRED);
  });
  // event-topology-exception: electron-fatal-termination-deadline
  const timer = setTimeout(() => {
    deadline.expired = true;
    settle();
  }, durationMs);
  timer.unref?.();
  const deadline: TerminationDeadline = {
    expired: false,
    // event-topology-exception: electron-fatal-termination-deadline
    bound: (work) => Promise.race([work, expiry]),
    dispose: () => clearTimeout(timer)
  };
  return deadline;
}

/**
 * Joins an admitted lifecycle drain when startup failed late enough to have
 * one. This prevents `app.quit()` from entering a second Core shutdown through
 * `before-quit`. A failed or indeterminate drain cannot be called clean exit.
 *
 * The drain is bounded by an independent last-resort deadline because it
 * awaits the same cached shutdown promise this path exists to rescue.
 */
export async function terminateElectronAfterFatalStartup(
  input: ElectronFatalStartupShutdownInput
): Promise<"clean-quit" | "forced-exit"> {
  let terminalFailure = false;
  const deadline = createTerminationDeadline(
    input.terminationDeadlineMs ?? FATAL_TERMINATION_DEADLINE_MS
  );
  const forcedByDeadline = (): "forced-exit" => {
    reportFailure(
      input,
      new RionBridgeError({
        code: "ELECTRON_FATAL_TERMINATION_DEADLINE",
        message: "The fatal drain did not terminalize before the last-resort process deadline."
      }),
      "ELECTRON_FATAL_TERMINATION_DEADLINE"
    );
    input.forceExit(70);
    return "forced-exit";
  };
  try {
    try {
      if (input.lifecycle) {
        input.lifecycle.beginFatalQuit?.();
        await deadline.bound(
          input.lifecycle.prepareFatalQuit?.() ?? input.lifecycle.prepareQuit()
        );
      }
      else if (input.runtime) await deadline.bound(input.runtime.shutdown());
      else if (input.core) await deadline.bound(input.core.shutdown());
    } catch (error) {
      terminalFailure = true;
      reportFailure(input, error, "ELECTRON_FATAL_STARTUP_DRAIN_FAILED");
    }
    if (deadline.expired) return forcedByDeadline();

    try {
      await deadline.bound(input.disposeShell());
    } catch (error) {
      terminalFailure = true;
      reportFailure(input, error, "ELECTRON_FATAL_STARTUP_DISPOSE_FAILED");
    }
    if (deadline.expired) return forcedByDeadline();

    if (!terminalFailure && !input.forceExitRequired?.()) {
      try {
        input.quit();
        return "clean-quit";
      } catch (error) {
        reportFailure(input, error, "ELECTRON_FATAL_STARTUP_QUIT_FAILED");
      }
    }
    input.forceExit(70);
    return "forced-exit";
  } finally {
    deadline.dispose();
  }
}

/**
 * Resolves the current highest-level drain owner exactly once. It is shared by
 * startup rejection and fatal post-start event-stream loss so neither path can
 * enter Core/runtime shutdown or application quit twice.
 */
export class ElectronFatalTerminationCoordinator {
  readonly #input: ElectronFatalTerminationCoordinatorInput;
  #termination: Promise<"clean-quit" | "forced-exit"> | null = null;
  #forcedTermination: Promise<"clean-quit" | "forced-exit"> | null = null;
  #forceExitRequired = false;

  constructor(input: ElectronFatalTerminationCoordinatorInput) {
    this.#input = input;
  }

  terminate(): Promise<"clean-quit" | "forced-exit"> {
    return this.#beginTermination();
  }

  /** Upgrades the one shared fatal owner to a mandatory nonzero process exit. */
  forceTerminate(): Promise<"clean-quit" | "forced-exit"> {
    this.#forceExitRequired = true;
    if (this.#forcedTermination) return this.#forcedTermination;
    this.#forcedTermination = this.#beginTermination().then((outcome) => {
      if (outcome !== "clean-quit") return outcome;
      this.#input.forceExit(70);
      return "forced-exit";
    });
    return this.#forcedTermination;
  }

  #beginTermination(): Promise<"clean-quit" | "forced-exit"> {
    if (this.#termination) return this.#termination;
    try {
      this.#input.onTerminationBegan?.();
    } catch (error) {
      try {
        this.#input.onError(normalizeRionBridgeError(
          error,
          "ELECTRON_FATAL_TERMINATION_ACTOR_STOP_FAILED"
        ));
      } catch {
        // Reporting is observational and cannot prevent fatal termination.
      }
    }
    this.#termination = terminateElectronAfterFatalStartup({
      lifecycle: this.#input.lifecycle(),
      runtime: this.#input.runtime(),
      core: this.#input.core(),
      disposeShell: this.#input.disposeShell,
      quit: this.#input.quit,
      forceExit: this.#input.forceExit,
      forceExitRequired: () => this.#forceExitRequired,
      terminationDeadlineMs: this.#input.terminationDeadlineMs,
      onError: this.#input.onError
    });
    return this.#termination;
  }
}

/**
 * Keeps startup failure ownership with the startup promise until its quit
 * fence can be released. Once startup has handed authority to the normal
 * lifecycle, the same terminal instead enters the ordered fatal drain
 * directly. The failure is classified at detection time, not when helper
 * cleanup eventually finishes.
 */
export class ElectronFatalEventStreamRouter {
  readonly #input: ElectronFatalEventStreamRouterInput;
  readonly #startupWaiters = new Set<FatalStartupWaiter>();
  #startupOpen = true;
  #startupFailure: RionBridgeError | null = null;
  #startupFailureDetected = false;
  #terminalRouted = false;

  constructor(input: ElectronFatalEventStreamRouterInput) {
    this.#input = input;
  }

  route(terminal: CoreEffectEventStreamFailureTerminal): void {
    if (this.#terminalRouted) return;
    this.#terminalRouted = true;
    let rendererDrain = Promise.resolve();
    try {
      rendererDrain = Promise.resolve(this.#input.onFatalDetected?.());
    } catch (error) {
      this.#report(error, "ELECTRON_CORE_EVENT_STREAM_FATAL_FENCE_FAILED");
    }
    const duringStartup = this.#startupOpen;
    if (duringStartup) this.#startupFailureDetected = true;
    const failure = new RionBridgeError(terminal.error);
    void joinFatalDrains(terminal.drained, rendererDrain).then(
      () => this.#terminalize(duringStartup, failure),
      (error: unknown) => {
        this.#report(error, "ELECTRON_CORE_EVENT_STREAM_FATAL_DRAIN_FAILED");
        this.#terminalize(duringStartup, failure);
      }
    );
  }

  waitForStartup<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const waiter: FatalStartupWaiter = {
        reject: (error: RionBridgeError) => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#startupWaiters.delete(waiter);
          reject(error);
        },
        settled: false
      };
      if (this.#startupFailure) {
        waiter.reject(this.#startupFailure);
        return;
      }
      this.#startupWaiters.add(waiter);
      void work.then(
        (result) => {
          if (waiter.settled || this.#startupFailureDetected) return;
          waiter.settled = true;
          this.#startupWaiters.delete(waiter);
          resolve(result);
        },
        (error: unknown) => {
          if (waiter.settled || this.#startupFailureDetected) return;
          waiter.settled = true;
          this.#startupWaiters.delete(waiter);
          reject(error);
        }
      );
    });
  }

  completeStartup(): void {
    if (!this.#startupFailureDetected) this.#startupOpen = false;
  }

  #terminalize(duringStartup: boolean, failure: RionBridgeError): void {
    if (duringStartup) {
      this.#startupFailure = failure;
      for (const waiter of [...this.#startupWaiters]) waiter.reject(failure);
      return;
    }
    try {
      void this.#input.terminate().catch((error: unknown) => {
        this.#report(error, "ELECTRON_CORE_EVENT_STREAM_FATAL_TERMINATION_FAILED");
      });
    } catch (error) {
      this.#report(error, "ELECTRON_CORE_EVENT_STREAM_FATAL_TERMINATION_FAILED");
    }
  }

  #report(error: unknown, fallbackCode: string): void {
    try {
      this.#input.onError(normalizeRionBridgeError(error, fallbackCode));
    } catch {
      // Fatal routing remains authoritative even if error presentation fails.
    }
  }
}
