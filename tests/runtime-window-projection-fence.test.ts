import { describe, expect, it } from "vitest";
import { RuntimeWindowProjectionFence } from "../src/electron/main/runtimeWindowProjectionFence";

describe("exact-window projection progress observations", () => {
  it("records admission and completion after pending work has already left the fence", async () => {
    const fence = new RuntimeWindowProjectionFence();
    const progress = fence.observe("first");
    const unrelated = fence.observe("second");
    const terminal = Promise.resolve();
    fence.retain(["app", "window:first", "window:first"], terminal);
    fence.retain(["window:first"], terminal);
    expect(progress.readSequence()).toBe(1);
    expect(unrelated.readSequence()).toBe(0);
    await terminal;
    expect(await fence.settle("first")).toBe(false);
    expect(progress.readSequence()).toBe(2);
    expect(unrelated.readSequence()).toBe(0);
    progress.dispose(); unrelated.dispose();
    const next = fence.observe("first");
    expect(next.readSequence()).toBe(0);
    next.dispose();
  });

  it("detaches observers without cancelling retained work or reviving disposed observations", async () => {
    const fence = new RuntimeWindowProjectionFence();
    const progress = fence.observe("first");
    let release!: () => void;
    const terminal = new Promise<void>(resolve => { release = resolve; });
    fence.retain(["window:first"], terminal);
    progress.dispose(); progress.dispose();
    const settle = fence.settle("first");
    const replacement = fence.observe("first");
    expect(replacement.readSequence()).toBe(0);
    release();
    await expect(settle).resolves.toBe(true);
    expect(progress.readSequence()).toBe(1);
    expect(replacement.readSequence()).toBe(1);
    replacement.dispose();
  });

  it("keeps producer failure authoritative while recording its terminal progress", async () => {
    const fence = new RuntimeWindowProjectionFence();
    const progress = fence.observe("first");
    const failure = new Error("Native projection failed.");
    const terminal = Promise.reject(failure);
    fence.retain(["window:first"], terminal);
    await expect(fence.settle("first")).rejects.toBe(failure);
    expect(() => progress.readSequence()).toThrow(failure);
    progress.dispose();
  });

  it("remembers only the first failure for active exact-window observers", async () => {
    const fence = new RuntimeWindowProjectionFence();
    const progress = fence.observe("first");
    const unrelated = fence.observe("second");
    const first = new Error("First receipt failed.");
    const terminal = Promise.reject(first);
    fence.retain(["window:first"], terminal);
    await terminal.catch(() => undefined);
    fence.retain(["window:first"], Promise.reject(new Error("Later receipt failed.")));
    await Promise.resolve();
    expect(() => progress.readSequence()).toThrow(first);
    expect(unrelated.readSequence()).toBe(0);
    progress.dispose(); unrelated.dispose();
    const replacement = fence.observe("first");
    expect(replacement.readSequence()).toBe(0);
    replacement.dispose();
  });

  it("does not keep a failed receipt after an observation is detached", async () => {
    const fence = new RuntimeWindowProjectionFence();
    const progress = fence.observe("first");
    let reject!: (failure: Error) => void;
    const terminal = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    fence.retain(["window:first"], terminal);
    progress.dispose();
    const failed = fence.settle("first");
    reject(new Error("Detached receipt failed."));
    await expect(failed).rejects.toThrow("Detached receipt failed.");
    expect(progress.readSequence()).toBe(1);
    const replacement = fence.observe("first");
    expect(replacement.readSequence()).toBe(0);
    replacement.dispose();
  });
});
