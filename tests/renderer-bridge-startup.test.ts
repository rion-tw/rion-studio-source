import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBridgeListeners } from "../src/renderer/src/tauri/installTauriBridge";

afterEach(() => {
  vi.useRealTimers();
});

describe("Tauri bridge listener startup", () => {
  it("starts every listener registration in parallel and returns one cleanup", async () => {
    const starts: string[] = [];
    const cleanups = [vi.fn(), vi.fn(), vi.fn()];
    const resolvers: Array<(cleanup: () => void) => void> = [];
    const registration = registerBridgeListeners(cleanups.map((_cleanup, index) => () => {
      starts.push(String(index));
      return new Promise<() => void>((resolve) => resolvers.push(resolve));
    }));

    expect(starts).toEqual(["0", "1", "2"]);
    resolvers.forEach((resolve, index) => resolve(cleanups[index]));
    const cleanup = await registration;
    cleanup();

    cleanups.forEach((unlisten) => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("cleans up both completed and late listener registrations after timeout", async () => {
    vi.useFakeTimers();
    const earlyCleanup = vi.fn();
    const lateCleanup = vi.fn();
    let resolveLate: ((cleanup: () => void) => void) | undefined;
    const registration = registerBridgeListeners([
      () => Promise.resolve(earlyCleanup),
      () => new Promise<() => void>((resolve) => {
        resolveLate = resolve;
      })
    ], 1_000);
    const rejection = expect(registration).rejects.toThrow(
      "desktop event bridge did not become ready"
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(earlyCleanup).toHaveBeenCalledOnce();

    resolveLate?.(lateCleanup);
    await Promise.resolve();
    expect(lateCleanup).toHaveBeenCalledOnce();
  });
});
