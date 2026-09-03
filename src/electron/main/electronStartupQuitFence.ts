import { RionBridgeError } from "../ipc/errors";

export interface ElectronStartupQuitEventPort {
  preventDefault: () => void;
}

export interface ElectronStartupQuitAppPort {
  on: (
    event: "before-quit",
    listener: (event: ElectronStartupQuitEventPort) => void
  ) => void;
  removeListener: (
    event: "before-quit",
    listener: (event: ElectronStartupQuitEventPort) => void
  ) => void;
}

export interface ElectronStartupQuitFence {
  readonly signal: AbortSignal;
  release: () => void;
}

/**
 * Atomically hands `before-quit` authority to the normal lifecycle. The
 * installer must synchronously register its listener before it returns; async
 * setup belongs in the Promise returned by that already-installed lifecycle.
 */
export function handoffElectronStartupQuitFence(
  fence: ElectronStartupQuitFence,
  installLifecycleListener: () => void
): void {
  if (fence.signal.aborted) {
    throw new RionBridgeError({
      code: "ELECTRON_STARTUP_QUIT_REQUESTED",
      message: "Application quit was requested before startup lifecycle handoff."
    });
  }
  installLifecycleListener();
  fence.release();
}

/**
 * Owns the gap before ElectronMainLifecycle can take over `before-quit`.
 * A quit request aborts startup work but remains intercepted until that work
 * has drained or the normal lifecycle listener is synchronously installed.
 */
export function installElectronStartupQuitFence(
  app: ElectronStartupQuitAppPort
): ElectronStartupQuitFence {
  const abort = new AbortController();
  let installed = true;
  const onBeforeQuit = (event: ElectronStartupQuitEventPort): void => {
    event.preventDefault();
    abort.abort("application-before-quit");
  };
  app.on("before-quit", onBeforeQuit);
  return Object.freeze({
    signal: abort.signal,
    release: () => {
      if (!installed) return;
      installed = false;
      app.removeListener("before-quit", onBeforeQuit);
    }
  });
}
