import { describe, expect, it, vi } from "vitest";

import {
  ElectronFatalEventStreamRouter,
  ElectronFatalTerminationCoordinator,
  terminateElectronAfterFatalStartup
} from
  "../src/electron/main/fatalStartupShutdown";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function defaults() {
  return {
    lifecycle: null,
    runtime: null,
    core: null,
    disposeShell: vi.fn(async () => undefined),
    quit: vi.fn(),
    forceExit: vi.fn(),
    onError: vi.fn()
  };
}

describe("Electron fatal startup shutdown", () => {
  it("routes a startup stream failure through startup rejection after drain", async () => {
    const drain = deferred();
    const startupWork = deferred();
    const terminate = vi.fn(async () => undefined);
    const router = new ElectronFatalEventStreamRouter({
      terminate,
      onError: vi.fn()
    });
    const startup = router.waitForStartup(startupWork.promise);

    router.route({
      error: {
        code: "CORE_EVENT_STREAM_CLOSED",
        message: "The Core event stream closed unexpectedly."
      },
      drained: drain.promise
    });
    startupWork.resolve();
    await Promise.resolve();
    expect(terminate).not.toHaveBeenCalled();

    drain.resolve();
    await expect(startup).rejects.toMatchObject({
      code: "CORE_EVENT_STREAM_CLOSED"
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("routes one post-start stream failure to termination only after drain", async () => {
    const drain = deferred();
    const rendererDrain = deferred();
    const terminate = vi.fn(async () => undefined);
    const onFatalDetected = vi.fn(() => rendererDrain.promise);
    const onError = vi.fn();
    const router = new ElectronFatalEventStreamRouter({
      onFatalDetected,
      terminate,
      onError
    });
    await router.waitForStartup(Promise.resolve());
    router.completeStartup();
    const terminal = {
      error: {
        code: "CORE_EVENT_STREAM_CLOSED",
        message: "The Core event stream closed unexpectedly."
      },
      drained: drain.promise
    } as const;

    router.route(terminal);
    router.route(terminal);
    expect(onFatalDetected).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
    drain.resolve();
    await Promise.resolve();
    expect(terminate).not.toHaveBeenCalled();
    rendererDrain.resolve();
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not swallow a failed stream-helper drain before fatal routing", async () => {
    const drain = deferred();
    const terminate = vi.fn(async () => undefined);
    const onError = vi.fn();
    const router = new ElectronFatalEventStreamRouter({ terminate, onError });
    await router.waitForStartup(Promise.resolve());
    router.completeStartup();

    router.route({
      error: {
        code: "CORE_EVENT_STREAM_CLOSED",
        message: "The Core event stream closed unexpectedly."
      },
      drained: drain.promise
    });
    drain.reject(new Error("helper drain failed"));

    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EVENT_STREAM_FATAL_DRAIN_FAILED"
    }));
  });

  it("replays one post-start lifecycle drain and quits only after it terminalizes", async () => {
    let finishDrain: (() => void) | undefined;
    const lifecycle = {
      prepareQuit: vi.fn(() => new Promise<void>((resolve) => {
        finishDrain = resolve;
      }))
    };
    const runtime = { shutdown: vi.fn(async () => undefined) };
    const core = { shutdown: vi.fn(async () => undefined) };
    const disposeShell = vi.fn(async () => undefined);
    const quit = vi.fn();
    const coordinator = new ElectronFatalTerminationCoordinator({
      lifecycle: () => lifecycle,
      runtime: () => runtime,
      core: () => core,
      disposeShell,
      quit,
      forceExit: vi.fn(),
      onError: vi.fn()
    });

    const first = coordinator.terminate();
    const replay = coordinator.terminate();
    expect(replay).toBe(first);
    await vi.waitFor(() => expect(lifecycle.prepareQuit).toHaveBeenCalledOnce());
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(core.shutdown).not.toHaveBeenCalled();
    expect(disposeShell).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    finishDrain?.();
    await expect(first).resolves.toBe("clean-quit");
    expect(disposeShell).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(lifecycle.prepareQuit).toHaveBeenCalledOnce();
  });

  it("uses one fatal lifecycle owner instead of a competing normal quit owner", async () => {
    const input = defaults();
    const lifecycle = {
      beginFatalQuit: vi.fn(),
      prepareFatalQuit: vi.fn(async () => undefined),
      prepareQuit: vi.fn(async () => undefined)
    };

    await expect(terminateElectronAfterFatalStartup({
      ...input,
      lifecycle
    })).resolves.toBe("clean-quit");

    expect(lifecycle.beginFatalQuit).toHaveBeenCalledOnce();
    expect(lifecycle.prepareFatalQuit).toHaveBeenCalledOnce();
    expect(lifecycle.prepareQuit).not.toHaveBeenCalled();
    expect(input.quit).toHaveBeenCalledOnce();
  });

  it("upgrades an in-flight fatal owner to mandatory nonzero termination", async () => {
    const drain = deferred();
    const quit = vi.fn();
    const forceExit = vi.fn();
    const coordinator = new ElectronFatalTerminationCoordinator({
      lifecycle: () => ({
        prepareQuit: vi.fn(() => drain.promise)
      }),
      runtime: () => null,
      core: () => null,
      disposeShell: vi.fn(async () => undefined),
      quit,
      forceExit,
      onError: vi.fn()
    });

    const fatal = coordinator.terminate();
    const forced = coordinator.forceTerminate();
    drain.resolve();
    await expect(fatal).resolves.toBe("forced-exit");
    await expect(forced).resolves.toBe("forced-exit");
    expect(quit).not.toHaveBeenCalled();
    expect(forceExit).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledWith(70);
  });

  it("joins an existing lifecycle drain instead of closing runtime and Core twice", async () => {
    const input = defaults();
    const lifecycle = { prepareQuit: vi.fn(async () => undefined) };
    const runtime = { shutdown: vi.fn(async () => undefined) };
    const core = { shutdown: vi.fn(async () => undefined) };

    await expect(terminateElectronAfterFatalStartup({
      ...input,
      lifecycle,
      runtime,
      core
    })).resolves.toBe("clean-quit");

    expect(lifecycle.prepareQuit).toHaveBeenCalledOnce();
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(core.shutdown).not.toHaveBeenCalled();
    expect(input.disposeShell).toHaveBeenCalledOnce();
    expect(input.quit).toHaveBeenCalledOnce();
    expect(input.forceExit).not.toHaveBeenCalled();
  });

  it("uses the runtime owner, then Core, before a lifecycle exists", async () => {
    const runtimeInput = defaults();
    const runtime = { shutdown: vi.fn(async () => undefined) };
    const core = { shutdown: vi.fn(async () => undefined) };
    await terminateElectronAfterFatalStartup({
      ...runtimeInput,
      runtime,
      core
    });
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(core.shutdown).not.toHaveBeenCalled();

    const coreInput = defaults();
    await terminateElectronAfterFatalStartup({ ...coreInput, core });
    expect(core.shutdown).toHaveBeenCalledOnce();
    expect(coreInput.quit).toHaveBeenCalledOnce();
  });

  it("force-exits with a nonzero status after an indeterminate drain", async () => {
    const input = defaults();
    const failure = new Error("runtime drain failed");
    const runtime = { shutdown: vi.fn(async () => { throw failure; }) };

    await expect(terminateElectronAfterFatalStartup({
      ...input,
      runtime
    })).resolves.toBe("forced-exit");

    expect(input.disposeShell).toHaveBeenCalledOnce();
    expect(input.quit).not.toHaveBeenCalled();
    expect(input.forceExit).toHaveBeenCalledWith(70);
    expect(input.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_FATAL_STARTUP_DRAIN_FAILED"
    }));
  });

  it("force-exits when final shell disposal or clean quit throws", async () => {
    const disposeInput = defaults();
    disposeInput.disposeShell.mockRejectedValueOnce(new Error("dispose failed"));
    await terminateElectronAfterFatalStartup(disposeInput);
    expect(disposeInput.forceExit).toHaveBeenCalledWith(70);
    expect(disposeInput.quit).not.toHaveBeenCalled();

    const quitInput = defaults();
    quitInput.quit.mockImplementationOnce(() => {
      throw new Error("quit failed");
    });
    await terminateElectronAfterFatalStartup(quitInput);
    expect(quitInput.forceExit).toHaveBeenCalledWith(70);
    expect(quitInput.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_FATAL_STARTUP_QUIT_FAILED"
    }));
  });

  it("does not let observational error reporting prevent forced termination", async () => {
    const input = defaults();
    input.onError.mockImplementation(() => {
      throw new Error("reporter failed");
    });
    const runtime = {
      shutdown: vi.fn(async () => {
        throw new Error("drain failed");
      })
    };

    await expect(terminateElectronAfterFatalStartup({
      ...input,
      runtime
    })).resolves.toBe("forced-exit");
    expect(input.forceExit).toHaveBeenCalledWith(70);
  });
});
