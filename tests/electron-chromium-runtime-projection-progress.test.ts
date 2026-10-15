import { describe, expect, it, vi } from "vitest";
import { observeChromiumRuntimeWindowProgress, waitForChromiumRuntimeProjection } from "../src/electron/main/chromiumRuntimeProjectionProgress";
import { RuntimeWindowProjectionFence } from "../src/electron/main/runtimeWindowProjectionFence";

describe("runtime projection progress composition", () => {
  it("observes only the exact window across native events and Core projections", async () => {
    const events = new RuntimeWindowProjectionFence();
    const projections = new RuntimeWindowProjectionFence();
    const progress = observeChromiumRuntimeWindowProgress({
      observeWindowProjection: id => projections.observe(id)
    }, { observeWindowEvents: id => events.observe(id) }, "target");
    const terminal = Promise.resolve();
    projections.retain(["window:other"], terminal);
    expect(progress.readSequence()).toBe(0);
    events.retain(["window:target"], terminal);
    projections.retain(["window:target"], terminal);
    expect(progress.readSequence()).toBe(2);
    await terminal;
    expect(progress.readSequence()).toBe(4);
    progress.dispose();
    events.retain(["window:target"], Promise.resolve());
    expect(progress.readSequence()).toBe(4);
  });

  it("releases the first observation when the native event actor rejects admission", () => {
    const dispose = vi.fn();
    const failure = new Error("Native actor stopped.");
    expect(() => observeChromiumRuntimeWindowProgress({
      observeWindowProjection: () => ({ readSequence: () => 0, dispose })
    }, { observeWindowEvents: () => { throw failure; } }, "target")).toThrow(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("awaits the original projection receipt before settling its successors", async () => {
    let release!: () => void;
    const pending = new Promise<number>(resolve => { release = () => resolve(4); });
    const settle = vi.fn(async () => 5);
    const runtime = { waitForProjectionAfter: vi.fn(() => pending), settleCurrentProjection: settle };
    const waiting = waitForChromiumRuntimeProjection(runtime, 3);
    expect(runtime.waitForProjectionAfter).toHaveBeenCalledWith(3);
    expect(settle).not.toHaveBeenCalled();
    release();
    await expect(waiting).resolves.toBe(5);
    await expect(waitForChromiumRuntimeProjection(null, 3)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE"
    });
  });
});
