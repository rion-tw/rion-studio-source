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
  /**
   * Last-resort terminal for the OS session-end path. `query-session-end` has
   * already been prevented by the time the drain starts, so a drain that never
   * settles would block the user's shutdown, restart, or sign-out indefinitely
   * with no interactive escape.
   */
  forceTerminate?: () => void;
  sessionEndDeadlineMs?: number;
  onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

/**
 * Windows grants an application a limited grace period after
 * `WM_QUERYENDSESSION` before the OS terminates it anyway. An EventBound Core
 * drain has no deadline of its own, so this path needs an explicit external
 * liveness bound. Expiry is never success: it forces an unclean termination so
 * the session end can proceed.
 */
export const WINDOWS_SESSION_END_DEADLINE_MS = 15_000;

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
  #deadlineTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.#clearDeadline();
    if (this.#started) {
      this.#input.window.removeListener("query-session-end", this.#onQuerySessionEnd);
    }
    this.#started = false;
  }

  #clearDeadline(): void {
    if (this.#deadlineTimer === null) return;
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = null;
  }

  terminalResult(): Promise<void> | null {
    return this.#terminal;
  }

  #armDeadline(): void {
    const forceTerminate = this.#input.forceTerminate;
    if (!forceTerminate || this.#deadlineTimer !== null) return;
    // event-topology-exception: windows-session-end-terminal-deadline
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = null;
      try {
        this.#input.onError(normalizeRionBridgeError(
          new Error("The Core drain did not terminalize before the Windows session ended."),
          "ELECTRON_WINDOWS_SESSION_END_DEADLINE"
        ));
      } catch {
        // Reporting cannot prevent the mandatory termination.
      }
      forceTerminate();
    }, this.#input.sessionEndDeadlineMs ?? WINDOWS_SESSION_END_DEADLINE_MS);
    this.#deadlineTimer.unref?.();
  }

  readonly #onQuerySessionEnd: SessionEndListener = (event) => {
    if (this.#disposed) return;
    event.preventDefault();
    if (this.#terminal) return;
    this.#armDeadline();
    this.#terminal = Promise.resolve()
      .then(() => this.#input.confirmQuit())
      .then(
        (value) => { this.#clearDeadline(); return value; },
        (error: unknown) => {
          // A rejected drain is routed to the shared fatal owner by the
          // lifecycle, which terminates the process; only a drain that never
          // settles needs this coordinator's own deadline.
          this.#clearDeadline();
          try {
            this.#input.onError(normalizeRionBridgeError(
              error,
              "ELECTRON_WINDOWS_SESSION_END_FAILED"
            ));
          } catch {
            // Reporting is observational; preserve the authoritative drain result.
          }
          throw error;
        }
      );
    void this.#terminal.catch(() => undefined);
  };
}

/**
 * Builds the coordinator on Windows only, so the shell entry point does not
 * carry the platform branch or the wiring for a Windows-only concern.
 */
export function createWindowsSessionEndCoordinator(
  input: Readonly<{
    platform: string;
    window: ElectronWindowsSessionEndWindowPort;
    confirmQuit: () => Promise<void>;
    forceTerminate: () => void;
    onError: ElectronWindowsSessionEndCoordinatorInput["onError"];
  }>
): ElectronWindowsSessionEndCoordinator | null {
  if (input.platform !== "win32") return null;
  const coordinator = new ElectronWindowsSessionEndCoordinator({
    platform: "win32",
    window: input.window,
    confirmQuit: input.confirmQuit,
    forceTerminate: input.forceTerminate,
    onError: input.onError
  });
  coordinator.start();
  return coordinator;
}
