import { describe, expect, it, vi } from "vitest";

import { ChromiumRuntimePlaceholderFollower } from
  "../src/electron/main/chromiumRuntimePlaceholderFollower";
import type { ChromiumRuntimeEffectExecutorInput } from
  "../src/electron/main/chromiumRuntimeEffectPorts";

function deferred() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

describe("Chromium placeholder presentation follower", () => {
  it("reports only a failure from the current Core projection", async () => {
    const earlier = deferred();
    const current = deferred();
    const onError = vi.fn();
    const reconcile = vi.fn()
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(current.promise);
    const ports = { onError, rolePlaceholders: { reconcile } } as unknown as
      ChromiumRuntimeEffectExecutorInput;
    const follower = new ChromiumRuntimePlaceholderFollower(
      ports, new Map(), new Map(), () => true
    );

    follower.schedule();
    follower.schedule();
    expect(reconcile).toHaveBeenCalledTimes(2);
    earlier.reject(new Error("retired host"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();

    current.reject(new Error("current host"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith({
      code: "ELECTRON_ROLE_PLACEHOLDER_PROJECTION_FAILED",
      message: "current host"
    }));
  });
});
