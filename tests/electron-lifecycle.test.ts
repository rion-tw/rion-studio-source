import { describe, expect, it, vi } from "vitest";

import {
  ElectronMainLifecycle,
  type ElectronAppLifecyclePort,
  type ElectronLifecycleWindowPort
} from "../src/electron/main/lifecycle";
import { ElectronFatalTerminationCoordinator } from
  "../src/electron/main/fatalStartupShutdown";
import { terminateAfterCleanExitFailure } from
  "../src/electron/main/cleanExitCoordinator";
import { RionBridgeError } from "../src/electron/ipc/errors";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createApp() {
  const listeners = new Map<string, (event?: { preventDefault: () => void }) => void>();
  const app: ElectronAppLifecyclePort = {
    whenReady: vi.fn(async () => undefined),
    on: vi.fn((event, listener) => listeners.set(event, listener)),
    removeListener: vi.fn((event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
    quit: vi.fn()
  };
  return { app, listeners };
}

function createWindow(
  isDestroyed: () => boolean = () => false,
  isMinimized: () => boolean = () => false
): ElectronLifecycleWindowPort {
  return {
    focus: vi.fn(),
    isDestroyed,
    isMinimized,
    restore: vi.fn(),
    show: vi.fn()
  };
}

describe("Electron main lifecycle", () => {
  it("creates one window and drains Core before allowing application quit", async () => {
    const { app, listeners } = createApp();
    let destroyed = false;
    const createMainWindow = vi.fn(async () => createWindow(() => destroyed));
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown },
      createMainWindow,
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });

    await lifecycle.start();
    await lifecycle.start();
    expect(createMainWindow).toHaveBeenCalledOnce();
    listeners.get("activate")?.();
    await Promise.resolve();
    expect(createMainWindow).toHaveBeenCalledOnce();

    destroyed = true;
    listeners.get("activate")?.();
    await vi.waitFor(() => expect(createMainWindow).toHaveBeenCalledTimes(2));

    const preventDefault = vi.fn();
    listeners.get("before-quit")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    await lifecycle.confirmQuit();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.isQuitCommitted()).toBe(true);
  });

  it("fences in-flight window creation and presents the exact window on activation", async () => {
    const { app, listeners } = createApp();
    let finishCreation: ((window: ElectronLifecycleWindowPort) => void) | undefined;
    let minimized = true;
    const window = createWindow(() => false, () => minimized);
    vi.mocked(window.restore).mockImplementation(() => {
      minimized = false;
    });
    const createMainWindow = vi.fn(() => new Promise<ElectronLifecycleWindowPort>((resolve) => {
      finishCreation = resolve;
    }));
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown: vi.fn(async () => undefined) },
      createMainWindow,
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });

    const start = lifecycle.start();
    await vi.waitFor(() => expect(createMainWindow).toHaveBeenCalledOnce());
    listeners.get("activate")?.();
    expect(createMainWindow).toHaveBeenCalledOnce();

    finishCreation?.(window);
    await start;
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce());
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();

    listeners.get("activate")?.();
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledTimes(2));
    expect(createMainWindow).toHaveBeenCalledOnce();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledTimes(2);
  });

  it("keeps the macOS app alive after its last window closes", async () => {
    const { app, listeners } = createApp();
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    listeners.get("window-all-closed")?.();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    lifecycle.dispose();
    expect(listeners).toHaveLength(0);
  });

  it("replays one event-bound prepare result and permits quit only after success", async () => {
    const { app } = createApp();
    let completeShutdown: (() => void) | undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      completeShutdown = resolve;
    }));
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    const prepare = lifecycle.prepareQuit();
    const replay = lifecycle.prepareQuit();
    const quit = lifecycle.confirmQuit();
    expect(replay).toBe(prepare);
    await Promise.resolve();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    completeShutdown?.();
    await expect(prepare).resolves.toBeUndefined();
    await expect(replay).resolves.toBeUndefined();
    await expect(quit).resolves.toBeUndefined();
    expect(app.quit).toHaveBeenCalledOnce();
    await expect(lifecycle.confirmQuit()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("persists one clean boundary before a normal quit but not a fatal drain", async () => {
    const { app } = createApp();
    const order: string[] = [];
    const prepareCleanExit = vi.fn(async () => {
      order.push("clean");
    });
    const shutdown = vi.fn(async () => {
      order.push("shutdown");
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit,
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    const first = lifecycle.prepareCleanQuit();
    const replay = lifecycle.prepareCleanQuit();
    expect(replay).toBe(first);
    await first;
    expect(order).toEqual(["clean", "shutdown"]);
    expect(prepareCleanExit).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();

    const fatalPrepareCleanExit = vi.fn(async () => undefined);
    const fatalLifecycle = new ElectronMainLifecycle({
      app: createApp().app,
      platform: "darwin",
      core: { shutdown: vi.fn(async () => undefined) },
      createMainWindow: async () => createWindow(),
      prepareCleanExit: fatalPrepareCleanExit,
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await fatalLifecycle.start();
    await fatalLifecycle.prepareQuit();
    expect(fatalPrepareCleanExit).not.toHaveBeenCalled();
    await expect(fatalLifecycle.prepareCleanQuit()).rejects.toThrow(
      "cannot begin after"
    );
  });

  it("fails closed without draining when the clean recovery boundary cannot persist", async () => {
    const { app } = createApp();
    const failure = new Error("recovery journal unavailable");
    const prepareCleanExit = vi.fn(async () => {
      throw failure;
    });
    const shutdown = vi.fn(async () => undefined);
    const onError = vi.fn();
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit,
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError
    });
    await lifecycle.start();

    const clean = lifecycle.prepareCleanQuit();
    await expect(clean).rejects.toBe(failure);
    await expect(lifecycle.prepareCleanQuit()).rejects.toBe(failure);
    await expect(lifecycle.confirmQuit()).rejects.toBe(failure);

    expect(prepareCleanExit).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("routes a normal clean-drain timeout to one fatal owner and nonzero exit", async () => {
    const { app } = createApp();
    const failure = new Error("role browser-data clear drain timed out");
    const shutdown = vi.fn(async () => undefined);
    const forceExit = vi.fn();
    const invalidateCleanExit = vi.fn(async () => undefined);
    const fatal = new ElectronFatalTerminationCoordinator({
      lifecycle: () => lifecycle,
      runtime: () => null,
      core: () => null,
      disposeShell: vi.fn(async () => undefined),
      quit: app.quit,
      forceExit,
      onError: vi.fn()
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit: vi.fn(async () => { throw failure; }),
      onCleanExitFailure: (cleanFailure) => terminateAfterCleanExitFailure(
        cleanFailure,
        { invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit },
        () => fatal.forceTerminate(),
        vi.fn()
      ),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    await expect(lifecycle.confirmQuit()).rejects.toBe(failure);
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledWith(70));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(invalidateCleanExit).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("invalidates clean state for a preterminal checked Core shutdown rejection", async () => {
    const { app } = createApp();
    const checkedFailure = new RionBridgeError({
      code: "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED",
      message: "A checked Core precheck could not prove terminal browser work."
    });
    const shutdown = vi.fn(async () => { throw checkedFailure; });
    const invalidateCleanExit = vi.fn(async () => undefined);
    const forceExit = vi.fn();
    const fatal = new ElectronFatalTerminationCoordinator({
      lifecycle: () => lifecycle,
      runtime: () => null,
      core: () => null,
      disposeShell: vi.fn(async () => undefined),
      quit: app.quit,
      forceExit,
      onError: vi.fn()
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit: vi.fn(async () => undefined),
      onCleanExitFailure: (cleanFailure) => terminateAfterCleanExitFailure(
        cleanFailure,
        { invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit },
        () => fatal.forceTerminate(),
        vi.fn()
      ),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    await expect(lifecycle.confirmQuit()).rejects.toBe(checkedFailure);
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledWith(70));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(invalidateCleanExit).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("retains the clean marker for a proven-late checked Core teardown failure", async () => {
    const { app } = createApp();
    const checkedFailure = new RionBridgeError({
      code: "CORE_LOG_DATABASE_FAILED",
      message: "The log worker disconnected during late Core teardown."
    });
    const invalidateCleanExit = vi.fn(async () => undefined);
    const forceExit = vi.fn();
    const fatal = new ElectronFatalTerminationCoordinator({
      lifecycle: () => lifecycle,
      runtime: () => null,
      core: () => null,
      disposeShell: vi.fn(async () => undefined),
      quit: app.quit,
      forceExit,
      onError: vi.fn()
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown: vi.fn(async () => { throw checkedFailure; }) },
      createMainWindow: async () => createWindow(),
      prepareCleanExit: vi.fn(async () => undefined),
      onCleanExitFailure: (cleanFailure) => terminateAfterCleanExitFailure(
        cleanFailure,
        { invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit },
        () => fatal.forceTerminate(),
        vi.fn()
      ),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    await expect(lifecycle.confirmQuit()).rejects.toBe(checkedFailure);
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledWith(70));
    expect(invalidateCleanExit).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("invalidates a proven-late checked failure when a fatal generation also wins", async () => {
    const { app } = createApp();
    const checkedShutdown = deferred();
    const checkedFailure = new RionBridgeError({
      code: "CORE_LOG_DATABASE_FAILED",
      message: "The log worker disconnected during late Core teardown."
    });
    const shutdown = vi.fn(() => checkedShutdown.promise);
    const invalidateCleanExit = vi.fn(async () => undefined);
    const forceTerminate = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit: vi.fn(async () => undefined),
      onCleanExitFailure: (cleanFailure) => terminateAfterCleanExitFailure(
        cleanFailure,
        { invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit },
        forceTerminate,
        vi.fn()
      ),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    const cleanQuit = lifecycle.confirmQuit();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    lifecycle.beginFatalQuit();
    checkedShutdown.reject(checkedFailure);

    await expect(cleanQuit).rejects.toBe(checkedFailure);
    await vi.waitFor(() => expect(invalidateCleanExit).toHaveBeenCalledOnce());
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("lets a synchronous fatal owner invalidate an in-flight clean quit", async () => {
    const { app } = createApp();
    const cleanBoundary = deferred();
    const prepareCleanExit = vi.fn(() => cleanBoundary.promise);
    const shutdown = vi.fn(async () => undefined);
    const invalidateCleanExit = vi.fn(async () => undefined);
    const forceTerminate = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      prepareCleanExit,
      onCleanExitFailure: (cleanFailure) => terminateAfterCleanExitFailure(
        cleanFailure,
        { invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit },
        forceTerminate,
        vi.fn()
      ),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn()
    });
    await lifecycle.start();

    const normalQuit = lifecycle.confirmQuit();
    await vi.waitFor(() => expect(prepareCleanExit).toHaveBeenCalledOnce());
    lifecycle.beginFatalQuit();
    const fatalQuit = lifecycle.prepareFatalQuit();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    cleanBoundary.resolve();

    await expect(normalQuit).rejects.toThrow("fatal Core event-stream failure");
    await vi.waitFor(() => expect(invalidateCleanExit).toHaveBeenCalledOnce());
    expect(forceTerminate).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    await expect(fatalQuit).resolves.toBeUndefined();
    await expect(lifecycle.prepareFatalQuit()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("replays a failed prepare result without permitting application quit", async () => {
    const { app } = createApp();
    const failure = new Error("shutdown failed");
    const onError = vi.fn();
    const shutdown = vi.fn(async () => {
      throw failure;
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError
    });
    await lifecycle.start();

    const prepare = lifecycle.prepareQuit();
    await expect(prepare).rejects.toBe(failure);
    await expect(lifecycle.prepareQuit()).rejects.toBe(failure);
    await expect(lifecycle.confirmQuit()).rejects.toBe(failure);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not let a throwing error observer replace the shutdown terminal", async () => {
    const { app } = createApp();
    const failure = new Error("shutdown failed");
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown: vi.fn(async () => { throw failure; }) },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError: vi.fn(() => { throw new Error("observer failed"); })
    });
    await lifecycle.start();

    await expect(lifecycle.confirmQuit()).rejects.toBe(failure);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("force-terminates even when unclean invalidation and error reporting fail", async () => {
    const invalidationFailure = new Error("unclean invalidation failed");
    const forceTerminate = vi.fn(async () => "forced-exit");

    await expect(terminateAfterCleanExitFailure(
      {
        cleanBoundaryPersisted: false,
        error: invalidationFailure,
        fatalGenerationInvalidated: false,
        phase: "cleanBoundary"
      },
      {
        invalidateRuntimeRestoreSessionCleanExitInternal: vi.fn(async () => {
          throw invalidationFailure;
        })
      },
      forceTerminate,
      vi.fn(() => { throw new Error("observer failed"); })
    )).resolves.toBeUndefined();
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  it("captures a synchronous Core shutdown failure as the replayed terminal result", async () => {
    const { app } = createApp();
    const failure = new Error("shutdown failed synchronously");
    const onError = vi.fn();
    const shutdown = vi.fn(() => {
      throw failure;
    });
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => true),
      onError
    });
    await lifecycle.start();

    const prepare = lifecycle.prepareQuit();
    const replay = lifecycle.prepareQuit();
    expect(replay).toBe(prepare);
    await expect(prepare).rejects.toBe(failure);
    await expect(lifecycle.confirmQuit()).rejects.toBe(failure);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("publishes every native quit attempt without draining until the renderer confirms", async () => {
    const { app, listeners } = createApp();
    const requestRendererQuitConfirmation = vi.fn(() => true);
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "darwin",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation,
      onError: vi.fn()
    });
    await lifecycle.start();

    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();
    listeners.get("before-quit")?.({ preventDefault: firstPreventDefault });
    listeners.get("before-quit")?.({ preventDefault: secondPreventDefault });
    await Promise.resolve();

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
    expect(requestRendererQuitConfirmation).toHaveBeenCalledTimes(2);
    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    await lifecycle.confirmQuit();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("joins an already-confirmed drain without publishing another renderer request", async () => {
    const { app, listeners } = createApp();
    let completeShutdown: (() => void) | undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      completeShutdown = resolve;
    }));
    const requestRendererQuitConfirmation = vi.fn(() => true);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation,
      onError: vi.fn()
    });
    await lifecycle.start();

    const confirmed = lifecycle.confirmQuit();
    const preventDefault = vi.fn();
    listeners.get("before-quit")?.({ preventDefault });
    const replay = lifecycle.requestQuit();
    await Promise.resolve();

    expect(replay).toBe(confirmed);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestRendererQuitConfirmation).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    completeShutdown?.();
    await expect(confirmed).resolves.toBeUndefined();
    await expect(replay).resolves.toBeUndefined();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("drains directly when no live renderer can own unsaved state", async () => {
    const { app, listeners } = createApp();
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ElectronMainLifecycle({
      app,
      platform: "win32",
      core: { shutdown },
      createMainWindow: async () => createWindow(),
      requestRendererQuitConfirmation: vi.fn(() => false),
      onError: vi.fn()
    });
    await lifecycle.start();

    const preventDefault = vi.fn();
    listeners.get("before-quit")?.({ preventDefault });
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.isQuitCommitted()).toBe(true);
  });
});
