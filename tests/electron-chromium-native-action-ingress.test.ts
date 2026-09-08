import { describe, expect, it, vi } from "vitest";
import { ChromiumNativeActionIngress } from "../src/electron/main/chromiumNativeActionIngress";
import { RionBridgeError } from "../src/electron/ipc/errors";

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe.each(["darwin", "win32"] as const)("native control drain on %s", (_platform) => {
  it("starts immediately, fences new work and waits for every admitted terminal", async () => {
    const ingress = new ChromiumNativeActionIngress();
    const first = deferred<number>();
    const last = deferred<number>();
    const execute = vi.fn(() => first.promise);
    const firstWork = ingress.run(execute);
    const lastWork = ingress.run(() => last.promise);
    expect(execute).toHaveBeenCalledOnce();
    const drain = ingress.closeAndDrain();
    expect(ingress.closeAndDrain()).toBe(drain);
    const forbidden = vi.fn(async () => 3);
    expect(() => ingress.run(forbidden)).toThrow(expect.objectContaining({
      code: "ELECTRON_CHROMIUM_NATIVE_ACTION_DRAINING"
    }));
    expect(forbidden).not.toHaveBeenCalled();
    const settled = vi.fn();
    void drain.then(settled);
    first.resolve(1);
    await expect(firstWork).resolves.toBe(1);
    expect(settled).not.toHaveBeenCalled();
    last.resolve(2);
    await expect(lastWork).resolves.toBe(2);
    await expect(drain).resolves.toBeUndefined();
  });

  it("retains the original Core error after all other admitted work terminalizes", async () => {
    const ingress = new ChromiumNativeActionIngress();
    const failed = deferred<void>();
    const survivor = deferred<void>();
    const error = new RionBridgeError({ code: "CORE_EXACT_FAILURE", message: "original" });
    const work = ingress.run(() => failed.promise);
    const other = ingress.run(() => survivor.promise);
    const drain = ingress.closeAndDrain();
    const rejected = vi.fn();
    void drain.catch(rejected);
    failed.reject(error);
    await expect(work).rejects.toBe(error);
    expect(rejected).not.toHaveBeenCalled();
    survivor.resolve();
    await other;
    await expect(drain).rejects.toBe(error);
  });

  it("includes an admitted callback that closes ingress reentrantly", async () => {
    const ingress = new ChromiumNativeActionIngress();
    const terminal = deferred<void>();
    let drain!: Promise<void>;
    const work = ingress.run(() => {
      drain = ingress.closeAndDrain();
      return terminal.promise;
    });
    const settled = vi.fn();
    void drain.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    terminal.resolve();
    await work;
    await drain;
  });
});
