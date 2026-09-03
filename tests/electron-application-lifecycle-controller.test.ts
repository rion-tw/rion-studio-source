import { describe, expect, it, vi } from "vitest";

import {
  ElectronApplicationLifecycleController,
  type ElectronPowerMonitorPort
} from "../src/electron/main/applicationLifecycleController";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function harness(applyRuntimeSuspended: (suspended: boolean) => Promise<unknown>) {
  const listeners = new Map<"resume" | "suspend", Set<() => void>>();
  const powerMonitor: ElectronPowerMonitorPort = {
    on: (event, listener) => {
      const registered = listeners.get(event) ?? new Set();
      registered.add(listener);
      listeners.set(event, registered);
    },
    removeListener: (event, listener) => listeners.get(event)?.delete(listener)
  };
  const publish = vi.fn();
  const onError = vi.fn();
  const controller = new ElectronApplicationLifecycleController({
    powerMonitor,
    platform: "darwin",
    applyRuntimeSuspended,
    publish,
    onError,
    now: () => "2026-08-30T00:00:00.000Z"
  });
  controller.start();
  return {
    controller,
    emit: (event: "resume" | "suspend") => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listeners,
    onError,
    publish
  };
}

describe("Electron application lifecycle controller", () => {
  it("starts with one stable active lifecycle projection", () => {
    const test = harness(async () => undefined);
    expect(test.controller.snapshot()).toEqual({
      revision: 1,
      capturedAt: "2026-08-30T00:00:00.000Z",
      lifecycleEpoch: 1,
      state: "active",
      reason: "startup",
      platform: "macos"
    });
  });

  it("returns the exact terminal projection from the same serialized signal lane", async () => {
    const applyRuntimeSuspended = vi.fn(async () => undefined);
    const test = harness(applyRuntimeSuspended);

    await expect(test.controller.signal("suspend")).resolves.toMatchObject({
      lifecycleEpoch: 2,
      reason: "power-suspended",
      revision: 3,
      state: "suspended"
    });
    await expect(test.controller.signal("resume")).resolves.toMatchObject({
      lifecycleEpoch: 3,
      reason: "power-resumed",
      revision: 5,
      state: "active"
    });
    expect(applyRuntimeSuspended.mock.calls).toEqual([[true], [false]]);
  });

  it("rejects a superseded exact signal while the newer lane entry terminalizes", async () => {
    const suspend = deferred();
    const resume = deferred();
    const test = harness((value) => value ? suspend.promise : resume.promise);

    const first = test.controller.signal("suspend");
    const second = test.controller.signal("resume");
    await flushMicrotasks();
    suspend.resolve();
    await expect(first).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_LIFECYCLE_SUPERSEDED"
    });
    await flushMicrotasks();
    resume.resolve();
    await expect(second).resolves.toMatchObject({
      lifecycleEpoch: 3,
      state: "active"
    });
  });

  it("serializes OS suspend and resume through the Rust runtime authority", async () => {
    const suspend = deferred();
    const resume = deferred();
    const applyRuntimeSuspended = vi.fn((value: boolean) =>
      value ? suspend.promise : resume.promise
    );
    const test = harness(applyRuntimeSuspended);

    test.emit("suspend");
    test.emit("resume");
    expect(test.publish.mock.calls.map(([status]) => status.state)).toEqual([
      "suspending",
      "resuming"
    ]);
    await flushMicrotasks();
    expect(applyRuntimeSuspended).toHaveBeenCalledTimes(1);

    suspend.resolve();
    await suspend.promise;
    await flushMicrotasks();
    expect(applyRuntimeSuspended).toHaveBeenNthCalledWith(2, false);
    expect(test.publish.mock.calls.map(([status]) => status.state))
      .not.toContain("suspended");

    resume.resolve();
    await test.controller.dispose();
    expect(test.controller.snapshot()).toMatchObject({
      lifecycleEpoch: 3,
      state: "resuming"
    });
  });

  it("terminalizes the current transition as degraded when Core rejects it", async () => {
    const test = harness(async () => {
      throw { code: "CORE_SUSPEND_FAILED", message: "Suspend failed." };
    });
    test.emit("suspend");
    await flushMicrotasks();

    expect(test.onError).toHaveBeenCalledWith({
      code: "CORE_SUSPEND_FAILED",
      message: "Suspend failed."
    });
    expect(test.controller.snapshot()).toMatchObject({
      state: "degraded",
      reason: "CORE_SUSPEND_FAILED"
    });
  });

  it("removes its event sources and drains in-flight work on dispose", async () => {
    const operation = deferred();
    const test = harness(() => operation.promise);
    test.emit("suspend");
    const disposal = test.controller.dispose();
    expect([...test.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    operation.resolve();
    await disposal;
  });
});
