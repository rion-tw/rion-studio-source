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

export interface ElectronFatalTerminationCoordinatorInput {
  lifecycle: () => LifecycleDrainPort | null;
  runtime: () => ShutdownPort | null;
  core: () => ShutdownPort | null;
  disposeShell: () => Promise<void>;
  quit: () => void;
  forceExit: (code: number) => void;
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

/**
 * Joins an admitted lifecycle drain when startup failed late enough to have
 * one. This prevents `app.quit()` from entering a second Core shutdown through
 * `before-quit`. A failed or indeterminate drain cannot be called clean exit.
 */
export async function terminateElectronAfterFatalStartup(
  input: ElectronFatalStartupShutdownInput
): Promise<"clean-quit" | "forced-exit"> {
  let terminalFailure = false;
  try {
    if (input.lifecycle) {
      input.lifecycle.beginFatalQuit?.();
      await (input.lifecycle.prepareFatalQuit?.() ?? input.lifecycle.prepareQuit());
    }
    else if (input.runtime) await input.runtime.shutdown();
    else await input.core?.shutdown();
  } catch (error) {
    terminalFailure = true;
    reportFailure(input, error, "ELECTRON_FATAL_STARTUP_DRAIN_FAILED");
  }

  try {
    await input.disposeShell();
  } catch (error) {
    terminalFailure = true;
    reportFailure(input, error, "ELECTRON_FATAL_STARTUP_DISPOSE_FAILED");
  }

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
    this.#termination = terminateElectronAfterFatalStartup({
      lifecycle: this.#input.lifecycle(),
      runtime: this.#input.runtime(),
      core: this.#input.core(),
      disposeShell: this.#input.disposeShell,
      quit: this.#input.quit,
      forceExit: this.#input.forceExit,
      forceExitRequired: () => this.#forceExitRequired,
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
