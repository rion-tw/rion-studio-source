import { deferred } from "../src/electron/main/macosAppKitRuntimeHostSupport";
import { describe, expect, it, vi } from "vitest";
import { coreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { observeRuntimeEffectCompletion } from "../src/electron/e2e/runtimeEffectCompletionObservation";

describe("E2E effect completion observation", () => {
  it("does not read a closing host when destruction only returns admission", async () => {
    const release = deferred<boolean>();
    let active = false;
    const completed = vi.fn(() => {
      if (!active) throw new Error("ELECTRON_MACOS_APPKIT_STALE_GENERATION");
    });
    const cancel = vi.fn();
    const result = coreEffectEventContinuation(release.promise, cancel);
    expect(() => observeRuntimeEffectCompletion(result, completed, vi.fn(), vi.fn())).not.toThrow();
    expect(completed).not.toHaveBeenCalled();
    active = true;
    release.resolve(true);
    await result.completion;
    expect(completed).toHaveBeenCalledExactlyOnceWith(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records the original terminal failure without changing cancellation or the result", async () => {
    const release = deferred<boolean>();
    const failure = new Error("exact detach failed");
    const completed = vi.fn(), rejected = vi.fn(), cancel = vi.fn();
    const result = coreEffectEventContinuation(release.promise, cancel);
    observeRuntimeEffectCompletion(result, completed, rejected, vi.fn());
    result.cancel("coreCancelled");
    release.reject(failure);
    await expect(result.completion).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("coreCancelled");
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(completed).not.toHaveBeenCalled();
  });

  it("reports observation failure separately and never changes a successful effect", () => {
    const failure = new Error("artifact unavailable");
    const observationFailed = vi.fn();
    expect(() => observeRuntimeEffectCompletion(true, () => { throw failure; }, vi.fn(), observationFailed)).not.toThrow();
    expect(observationFailed).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
