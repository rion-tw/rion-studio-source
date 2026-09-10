import type { ElectronOperationalLogger } from "./electronOperationalLogger";

type Listener = (...args: never[]) => void;

export interface ElectronOperationalLogAppPort {
  on: (event: string, listener: Listener) => unknown;
  removeListener: (event: string, listener: Listener) => unknown;
}

export interface ElectronOperationalLogProcessPort {
  on: (event: string, listener: Listener) => unknown;
  removeListener: (event: string, listener: Listener) => unknown;
}

interface ObservedWebContents {
  readonly id: number;
  on: (event: string, listener: Listener) => unknown;
}

/** Installs only event-bound observers; it creates no timers or retry loops. */
export function installElectronOperationalLogHooks(
  app: ElectronOperationalLogAppPort,
  processPort: ElectronOperationalLogProcessPort,
  logger: ElectronOperationalLogger
): () => void {
  const onUncaughtException = (error: unknown): void => {
    logger.error("main", "uncaught_exception", "An uncaught main-process error occurred.",
      error, "ELECTRON_MAIN_UNCAUGHT_EXCEPTION");
  };
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error("main", "unhandled_rejection", "An unhandled main-process rejection occurred.",
      reason, "ELECTRON_MAIN_UNHANDLED_REJECTION");
  };
  const onRenderProcessGone = (
    _event: unknown,
    contents: ObservedWebContents,
    details: { reason?: string; exitCode?: number }
  ): void => {
    logger.warn("renderer", "render_process_gone", "A renderer process exited.", {
      webContentsId: contents.id,
      state: details.reason ?? "unknown",
      ...(details.exitCode === undefined ? {} : { errorCode: String(details.exitCode) })
    });
  };
  const onChildProcessGone = (
    _event: unknown,
    details: { type?: string; reason?: string; exitCode?: number }
  ): void => {
    logger.warn("main", "child_process_gone", "An Electron child process exited.", {
      phase: details.type ?? "unknown",
      state: details.reason ?? "unknown",
      ...(details.exitCode === undefined ? {} : { errorCode: String(details.exitCode) })
    });
  };
  const onWebContentsCreated = (_event: unknown, contents: ObservedWebContents): void => {
    contents.on("did-start-navigation", (
      _navigationEvent: unknown,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) return;
      logger.info("browser", "main_frame_navigation_started", "Main-frame navigation started.", {
        webContentsId: contents.id
      });
    });
    contents.on("did-fail-load", (
      _loadEvent: unknown,
      errorCode: number,
      _errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean
    ) => {
      if (!isMainFrame) return;
      logger.warn("browser", "main_frame_navigation_failed", "Main-frame navigation failed.", {
        webContentsId: contents.id,
        errorCode: String(errorCode)
      });
    });
    contents.on("preload-error", (
      _preloadEvent: unknown,
      _preloadPath: string,
      error: unknown
    ) => {
      logger.error("preload", "preload_error", "A preload script failed.", error,
        "ELECTRON_PRELOAD_FAILED", {
          webContentsId: contents.id
        });
    });
  };

  processPort.on("uncaughtExceptionMonitor", onUncaughtException as Listener);
  processPort.on("unhandledRejection", onUnhandledRejection as Listener);
  app.on("render-process-gone", onRenderProcessGone as Listener);
  app.on("child-process-gone", onChildProcessGone as Listener);
  app.on("web-contents-created", onWebContentsCreated as Listener);

  return () => {
    processPort.removeListener("uncaughtExceptionMonitor", onUncaughtException as Listener);
    processPort.removeListener("unhandledRejection", onUnhandledRejection as Listener);
    app.removeListener("render-process-gone", onRenderProcessGone as Listener);
    app.removeListener("child-process-gone", onChildProcessGone as Listener);
    app.removeListener("web-contents-created", onWebContentsCreated as Listener);
  };
}
