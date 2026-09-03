import { describe, expect, it, vi } from "vitest";

import { runElectronReadyPhase } from
  "../src/electron/main/electronReadyGate";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Electron production ready gate", () => {
  it("does not enter the screen/session/window phase before app readiness", async () => {
    const ready = deferred();
    const operation = vi.fn(() => "ready-phase-complete");
    const result = runElectronReadyPhase(
      { whenReady: () => ready.promise },
      operation
    );

    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    ready.resolve();
    await expect(result).resolves.toBe("ready-phase-complete");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("never enters the native phase when Electron readiness fails", async () => {
    const ready = deferred();
    const operation = vi.fn();
    const result = runElectronReadyPhase(
      { whenReady: () => ready.promise },
      operation
    );
    ready.reject(new Error("ready failed"));

    await expect(result).rejects.toThrow("ready failed");
    expect(operation).not.toHaveBeenCalled();
  });
});
