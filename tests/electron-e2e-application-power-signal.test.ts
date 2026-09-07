import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { emitObservedApplicationPowerSignal } from
  "../src/electron/e2e/applicationPowerSignal";
import { ElectronApplicationLifecycleController } from
  "../src/electron/main/applicationLifecycleController";

describe.each(["darwin", "win32"] as const)("%s E2E power event ingress", (platform) => {
  function harness() {
    const power = new EventEmitter();
    const apply = vi.fn(async () => undefined);
    const lifecycle = new ElectronApplicationLifecycleController({
      platform, powerMonitor: power, applyRuntimeSuspended: apply,
      publish: vi.fn(), onError: vi.fn()
    });
    return { apply, lifecycle, power };
  }

  it("uses the registered OS event listener and preserves the exact receipt", async () => {
    const { apply, lifecycle, power } = harness();
    lifecycle.start();
    const originalSignal = lifecycle.signal;
    const receipt = await emitObservedApplicationPowerSignal(
      lifecycle, (event) => power.emit(event), "suspend"
    );
    expect(receipt).toMatchObject({
      before: { state: "active", lifecycleEpoch: 1, revision: 1 },
      event: "suspend",
      terminal: { state: "suspended", lifecycleEpoch: 2, revision: 3 }
    });
    expect(apply.mock.calls).toEqual([[true]]);
    expect(lifecycle.signal).toBe(originalSignal);
    expect(Object.hasOwn(lifecycle, "signal")).toBe(false);
    await lifecycle.dispose();
  });

  it("fails if the real listener was not installed instead of injecting a direct fallback", async () => {
    const { apply, lifecycle, power } = harness();
    await expect(emitObservedApplicationPowerSignal(
      lifecycle, (event) => power.emit(event), "suspend"
    )).rejects.toThrow("observed 0");
    expect(apply).not.toHaveBeenCalled();
    expect(Object.hasOwn(lifecycle, "signal")).toBe(false);
  });

  it("restores the method when event dispatch throws", async () => {
    const { lifecycle } = harness();
    const signal = vi.spyOn(lifecycle, "signal");
    await expect(emitObservedApplicationPowerSignal(lifecycle, () => {
      throw new Error("Power emitter failed.");
    }, "resume")).rejects.toThrow("Power emitter failed.");
    expect(lifecycle.signal).toBe(signal);
    expect(signal).not.toHaveBeenCalled();
  });

  it("rejects duplicate ingress instead of choosing an arbitrary transition receipt", async () => {
    const { lifecycle, power } = harness();
    lifecycle.start();
    await expect(emitObservedApplicationPowerSignal(lifecycle, (event) => {
      power.emit(event);
      power.emit(event);
    }, "suspend")).rejects.toThrow("observed 2");
    await lifecycle.dispose();
    expect(Object.hasOwn(lifecycle, "signal")).toBe(false);
  });
});
