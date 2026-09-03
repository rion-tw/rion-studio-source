import { normalizeRionBridgeError } from "../ipc/errors";

export interface ElectronWindowsSessionEndEventPort {
  preventDefault: () => void;
}

type SessionEndListener = (event: ElectronWindowsSessionEndEventPort) => void;

export interface ElectronWindowsSessionEndWindowPort {
  on: (event: "query-session-end", listener: SessionEndListener) => unknown;
  removeListener: (event: "query-session-end", listener: SessionEndListener) => unknown;
}

export interface ElectronWindowsSessionEndCoordinatorInput {
  platform: "darwin" | "win32";
  window: ElectronWindowsSessionEndWindowPort;
  confirmQuit: () => Promise<void>;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

/**
 * Windows does not emit Electron's ordinary application quit events during an
 * OS shutdown, restart, or sign-out. The native window query is therefore the
 * authoritative event that fences one final Core drain before process exit.
 */
export class ElectronWindowsSessionEndCoordinator {
  readonly #input: ElectronWindowsSessionEndCoordinatorInput;
  #started = false;
  #disposed = false;
  #terminal: Promise<void> | null = null;

  constructor(input: ElectronWindowsSessionEndCoordinatorInput) {
    this.#input = input;
  }

  start(): void {
    if (this.#disposed) {
      throw new Error("The Windows session-end coordinator has been disposed.");
    }
    if (this.#started || this.#input.platform !== "win32") return;
    this.#started = true;
    this.#input.window.on("query-session-end", this.#onQuerySessionEnd);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#started) {
      this.#input.window.removeListener("query-session-end", this.#onQuerySessionEnd);
    }
    this.#started = false;
  }

  terminalResult(): Promise<void> | null {
    return this.#terminal;
  }

  readonly #onQuerySessionEnd: SessionEndListener = (event) => {
    if (this.#disposed) return;
    event.preventDefault();
    if (this.#terminal) return;
    this.#terminal = Promise.resolve()
      .then(() => this.#input.confirmQuit())
      .catch((error: unknown) => {
        try {
          this.#input.onError(normalizeRionBridgeError(
            error,
            "ELECTRON_WINDOWS_SESSION_END_FAILED"
          ));
        } catch {
          // Reporting is observational; preserve the authoritative drain result.
        }
        throw error;
      });
    void this.#terminal.catch(() => undefined);
  };
}
