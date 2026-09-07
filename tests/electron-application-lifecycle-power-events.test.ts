import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { ElectronApplicationLifecycleController } from
  "../src/electron/main/applicationLifecycleController";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve };
}

function harness(platform: "darwin" | "win32", apply: (value: boolean) => Promise<unknown>) {
  const powerMonitor = new EventEmitter();
  const publish = vi.fn();
  const onError = vi.fn();
  const controller = new ElectronApplicationLifecycleController({
    platform, powerMonitor, applyRuntimeSuspended: apply, publish, onError
  });
  const signal = vi.spyOn(controller, "signal");
  controller.start();
  return {
    controller, onError, powerMonitor, publish,
    emit(event: "suspend" | "resume") {
      const count = signal.mock.calls.length;
      expect(powerMonitor.emit(event)).toBe(true);
      expect(signal.mock.calls.length).toBe(count + 1);
      return signal.mock.results[count]!.value as ReturnType<typeof controller.signal>;
    }
  };
}

describe.each(["darwin", "win32"] as const)("%s power event ordering", (platform) => {
  it("completes repeated and duplicate native notifications without accumulating listeners", async () => {
    const apply = vi.fn(async () => undefined);
    const test = harness(platform, apply);
    test.controller.start();
    for (const event of ["suspend", "suspend", "resume", "resume", "suspend", "resume"] as const) {
      const before = test.controller.snapshot();
      await expect(test.emit(event)).resolves.toMatchObject({
        state: event === "suspend" ? "suspended" : "active",
        lifecycleEpoch: before.lifecycleEpoch + 1,
        revision: before.revision + 2,
        platform: platform === "darwin" ? "macos" : "windows"
      });
    }
    expect(apply.mock.calls).toEqual([[true], [true], [false], [false], [true], [false]]);
    expect(test.onError).not.toHaveBeenCalled();
    await test.controller.dispose();
    expect(test.powerMonitor.listenerCount("suspend")).toBe(0);
    expect(test.powerMonitor.listenerCount("resume")).toBe(0);
  });

  it("holds wake behind pending cleanup and only publishes the current terminal epoch", async () => {
    const cleanup = deferred();
    const cleanupEntered = deferred();
    const wake = deferred();
    const wakeEntered = deferred();
    const apply = vi.fn((suspended: boolean) => {
      (suspended ? cleanupEntered : wakeEntered).resolve();
      return suspended ? cleanup.promise : wake.promise;
    });
    const test = harness(platform, apply);
    const suspendResult = test.emit("suspend");
    await cleanupEntered.promise;
    const resumeResult = test.emit("resume");
    expect(apply.mock.calls).toEqual([[true]]);
    const superseded = expect(suspendResult).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED"
    });
    cleanup.resolve();
    await superseded;
    await wakeEntered.promise;
    expect(test.controller.snapshot().state).toBe("resuming");
    wake.resolve();
    await expect(resumeResult).resolves.toMatchObject({ state: "active", lifecycleEpoch: 3 });
    expect(test.publish.mock.calls.map(([status]) => status.state))
      .toEqual(["suspending", "resuming", "active"]);
    expect(test.onError).not.toHaveBeenCalled();
    await test.controller.dispose();
  });

  it("does not return a newer nonterminal projection as the failed older signal's receipt", async () => {
    const cleanup = deferred();
    const entered = deferred();
    const test = harness(platform, async (suspended) => {
      if (suspended) { entered.resolve(); await cleanup.promise; }
    });
    const suspendResult = test.emit("suspend");
    await entered.promise;
    const resumeResult = test.emit("resume");
    const superseded = expect(suspendResult).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED"
    });
    cleanup.reject({ code: "CORE_SUSPEND_FAILED", message: "Cleanup rejected." });
    await superseded;
    await expect(resumeResult).resolves.toMatchObject({ state: "active", lifecycleEpoch: 3 });
    expect(test.onError).toHaveBeenCalledExactlyOnceWith({
      code: "CORE_SUSPEND_FAILED", message: "Cleanup rejected."
    });
    expect(test.publish.mock.calls.map(([status]) => status.state))
      .toEqual(["suspending", "resuming", "active"]);
    await test.controller.dispose();
  });

  it("keeps a rejected wake degraded until a later acknowledged wake", async () => {
    const apply = vi.fn(async () => undefined)
      .mockRejectedValueOnce({ code: "CORE_RESUME_FAILED", message: "Wake rejected." });
    const test = harness(platform, apply);
    await expect(test.emit("resume")).resolves.toMatchObject({
      state: "degraded", lifecycleEpoch: 2, reason: "CORE_RESUME_FAILED"
    });
    await expect(test.emit("resume")).resolves.toMatchObject({ state: "active", lifecycleEpoch: 3 });
    expect(test.onError).toHaveBeenCalledTimes(1);
    await test.controller.dispose();
  });

  it.each(["resolve", "reject"] as const)("fences in-flight %s on disposal without publishing after teardown", async (outcome) => {
    const cleanup = deferred();
    const entered = deferred();
    const test = harness(platform, async () => { entered.resolve(); await cleanup.promise; });
    const result = test.emit("suspend");
    await entered.promise;
    const disposal = test.controller.dispose();
    const disposed = expect(result).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_LIFECYCLE_DISPOSED"
    });
    if (outcome === "resolve") cleanup.resolve();
    else cleanup.reject({ code: "CORE_SUSPEND_FAILED", message: "Cleanup rejected." });
    await disposed;
    await disposal;
    expect(test.powerMonitor.emit("resume")).toBe(false);
    expect(test.publish).toHaveBeenCalledTimes(1);
    expect(test.onError).toHaveBeenCalledTimes(outcome === "resolve" ? 0 : 1);
  });
});
