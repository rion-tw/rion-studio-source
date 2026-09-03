import { normalizeRionBridgeError } from "../ipc/errors";

type AppEvent = "activate" | "before-quit" | "window-all-closed";
type AppListener = (event?: { preventDefault: () => void }) => void;

export interface ElectronAppLifecyclePort {
  whenReady: () => Promise<void>;
  on: (event: AppEvent, listener: AppListener) => void;
  removeListener: (event: AppEvent, listener: AppListener) => void;
  quit: () => void;
}

export interface ElectronLifecycleWindowPort {
  focus: () => void;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
}

export interface ElectronCoreLifecyclePort {
  shutdown: () => Promise<void>;
}

export type ElectronCleanExitFailurePhase =
  | "cleanBoundary"
  | "checkedCoreShutdown"
  | "postShutdownFatalFence";

export interface ElectronCleanExitFailure {
  readonly cleanBoundaryPersisted: boolean;
  readonly error: unknown;
  readonly fatalGenerationInvalidated: boolean;
  readonly phase: ElectronCleanExitFailurePhase;
}

export interface ElectronMainLifecycleInput {
  app: ElectronAppLifecyclePort;
  platform: "darwin" | "win32";
  core: ElectronCoreLifecyclePort;
  createMainWindow: () => Promise<ElectronLifecycleWindowPort>;
  prepareCleanExit?: () => Promise<void>;
  onCleanExitFailure?: (
    failure: ElectronCleanExitFailure
  ) => void | Promise<void>;
  requestRendererQuitConfirmation: () => boolean;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

export class ElectronMainLifecycle {
  readonly #input: ElectronMainLifecycleInput;
  #window: ElectronLifecycleWindowPort | null = null;
  #windowCreationPromise: Promise<ElectronLifecycleWindowPort> | null = null;
  #startPromise: Promise<void> | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #fatalQuitPromise: Promise<void> | null = null;
  #cleanQuitPromise: Promise<void> | null = null;
  #quitPromise: Promise<void> | null = null;
  #fatalGeneration = 0;
  #cleanFailureRouted = false;
  #cleanBoundaryPersisted = false;
  #cleanFailurePhase: ElectronCleanExitFailurePhase = "cleanBoundary";
  #stopped = false;

  constructor(input: ElectronMainLifecycleInput) {
    this.#input = input;
  }

  readonly #onActivate: AppListener = () => {
    if (this.#stopped) return;
    void this.#ensureWindow()
      .then((window) => this.#presentWindow(window))
      .catch(this.#reportError);
  };

  readonly #onWindowAllClosed: AppListener = () => {
    if (this.#input.platform !== "darwin") {
      void this.requestQuit().catch(() => undefined);
    }
  };

  readonly #onBeforeQuit: AppListener = (event) => {
    if (this.#stopped) return;
    event?.preventDefault();
    void this.requestQuit().catch(() => undefined);
  };

  readonly #reportError = (error: unknown): void => {
    try {
      this.#input.onError(normalizeRionBridgeError(error, "ELECTRON_LIFECYCLE_FAILED"));
    } catch {
      // Error presentation is observational and cannot replace lifecycle terminality.
    }
  };

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#input.app.on("activate", this.#onActivate);
    this.#input.app.on("window-all-closed", this.#onWindowAllClosed);
    this.#input.app.on("before-quit", this.#onBeforeQuit);
    this.#startPromise = this.#input.app.whenReady()
      .then(() => this.#ensureWindow())
      .then(() => undefined);
    return this.#startPromise;
  }

  prepareQuit(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = Promise.resolve()
      .then(() => this.#input.core.shutdown())
      .then(() => {
        this.#stopped = true;
      })
      .catch((error) => {
        this.#reportError(error);
        throw error;
      });
    return this.#shutdownPromise;
  }

  /** Claims fatal quit ownership before any asynchronous helper drain begins. */
  beginFatalQuit(): void {
    if (this.#fatalGeneration === 0) this.#fatalGeneration = 1;
  }

  /** Replays the shared shutdown boundary under the fatal quit owner. */
  prepareFatalQuit(): Promise<void> {
    this.beginFatalQuit();
    if (this.#fatalQuitPromise) return this.#fatalQuitPromise;
    const clean = this.#cleanQuitPromise;
    this.#fatalQuitPromise = (clean
      ? clean.then(() => undefined, () => undefined)
      : Promise.resolve()
    ).then(() => this.prepareQuit());
    return this.#fatalQuitPromise;
  }

  /**
   * Persists the exact clean-exit boundary before entering the irreversible
   * Core/runtime drain. Fatal startup calls prepareQuit() directly and cannot
   * pass through this method or overwrite an unclean recovery journal.
   */
  prepareCleanQuit(): Promise<void> {
    if (this.#cleanQuitPromise) return this.#cleanQuitPromise;
    if (this.#input.prepareCleanExit && this.#shutdownPromise) {
      const error = new Error(
        "The clean-exit boundary cannot begin after the runtime drain."
      );
      this.#reportError(error);
      return Promise.reject(error);
    }
    const cleanGeneration = this.#fatalGeneration;
    try {
      this.#requireCleanQuitGeneration(cleanGeneration);
    } catch (error) {
      this.#reportError(error);
      this.#cleanQuitPromise = Promise.reject(error);
      void this.#cleanQuitPromise.catch(() => undefined);
      return this.#cleanQuitPromise;
    }
    if (!this.#input.prepareCleanExit) {
      this.#cleanFailurePhase = "checkedCoreShutdown";
      this.#cleanQuitPromise = this.prepareQuit().then(() => {
        this.#cleanFailurePhase = "postShutdownFatalFence";
        try {
          this.#requireCleanQuitGeneration(cleanGeneration);
        } catch (error) {
          this.#reportError(error);
          throw error;
        }
      });
      this.#observeCleanQuitFailure(this.#cleanQuitPromise);
      return this.#cleanQuitPromise;
    }
    const cleanBoundary = Promise.resolve()
      .then(() => this.#input.prepareCleanExit!())
      .then(() => {
        this.#cleanBoundaryPersisted = true;
        this.#requireCleanQuitGeneration(cleanGeneration);
      })
      .catch((error) => {
        this.#reportError(error);
        throw error;
      });
    this.#cleanQuitPromise = cleanBoundary
      .then(() => {
        this.#cleanFailurePhase = "checkedCoreShutdown";
        return this.prepareQuit();
      })
      .then(() => {
        this.#cleanFailurePhase = "postShutdownFatalFence";
        try {
          this.#requireCleanQuitGeneration(cleanGeneration);
        } catch (error) {
          this.#reportError(error);
          throw error;
        }
      });
    this.#observeCleanQuitFailure(this.#cleanQuitPromise);
    return this.#cleanQuitPromise;
  }

  /**
   * Starts the renderer-owned unsaved-change handshake. If no live renderer
   * can own that decision, there cannot be renderer-local dirty state, so the
   * same request falls through to the event-bound Core drain.
   */
  requestQuit(): Promise<void> {
    if (this.#quitPromise) return this.#quitPromise;
    if (this.#stopped) return Promise.resolve();
    try {
      if (this.#input.requestRendererQuitConfirmation()) {
        return Promise.resolve();
      }
    } catch (error) {
      this.#reportError(error);
      return Promise.reject(error);
    }
    return this.confirmQuit();
  }

  /** Commits a renderer-confirmed quit and replays its exact terminal result. */
  confirmQuit(): Promise<void> {
    if (this.#quitPromise) return this.#quitPromise;
    this.#quitPromise = this.prepareCleanQuit().then(() => {
      this.#input.app.quit();
    });
    return this.#quitPromise;
  }

  /** Native main-window close handlers use this to admit final destruction. */
  isQuitCommitted(): boolean {
    return this.#stopped;
  }

  dispose(): void {
    this.#input.app.removeListener("activate", this.#onActivate);
    this.#input.app.removeListener("window-all-closed", this.#onWindowAllClosed);
    this.#input.app.removeListener("before-quit", this.#onBeforeQuit);
  }

  #ensureWindow(): Promise<ElectronLifecycleWindowPort> {
    if (this.#window && !this.#window.isDestroyed()) {
      return Promise.resolve(this.#window);
    }
    if (this.#windowCreationPromise) return this.#windowCreationPromise;

    const creation = Promise.resolve()
      .then(() => this.#input.createMainWindow())
      .then((window) => {
        if (this.#windowCreationPromise === creation) this.#window = window;
        return window;
      })
      .finally(() => {
        if (this.#windowCreationPromise === creation) {
          this.#windowCreationPromise = null;
        }
      });
    this.#windowCreationPromise = creation;
    return creation;
  }

  #presentWindow(window: ElectronLifecycleWindowPort): void {
    if (this.#stopped || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  #requireCleanQuitGeneration(generation: number): void {
    if (generation === 0 && this.#fatalGeneration === generation) return;
    throw new Error(
      "A fatal Core event-stream failure invalidated the pending clean quit."
    );
  }

  #observeCleanQuitFailure(work: Promise<void>): void {
    void work.catch((error: unknown) => {
      if (this.#cleanFailureRouted) return;
      this.#cleanFailureRouted = true;
      try {
        const routing = this.#input.onCleanExitFailure?.(Object.freeze({
          cleanBoundaryPersisted: this.#cleanBoundaryPersisted,
          error,
          fatalGenerationInvalidated: this.#fatalGeneration > 0,
          phase: this.#cleanFailurePhase
        }));
        void Promise.resolve(routing).catch(this.#reportError);
      } catch (routingError) {
        this.#reportError(routingError);
      }
    });
  }
}
