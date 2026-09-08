import { describe, expect, it, vi } from "vitest";
import { observeElectronPhaseShutdown } from "../scripts/desktopE2eElectronShutdown.mjs";

describe("Electron phase shutdown observation", () => {
  it.each([0, 1])("waits for native exit after final flush with journey exit %i", async exitCode => {
    let release!: () => void;
    const exited = new Promise<void>(resolve => { release = resolve; });
    const marker = { pid: 42 };
    const readFinalFlush = vi.fn().mockResolvedValue(marker);
    const waitForProcessExit = vi.fn().mockImplementation(() => exited);
    let completed = false;
    const observation = observeElectronPhaseShutdown({
      driver: "electron", forcedTermination: false, exitCode,
      readFinalFlush, waitForProcessExit
    }).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(waitForProcessExit).toHaveBeenCalledWith(marker));
    expect(completed).toBe(false);
    release();
    expect(await observation).toEqual({ finalFlush: marker, processExited: true });
  });

  it("keeps failed-journey cleanup failure separate from its verdict", async () => {
    const marker = { pid: 42 };
    expect(await observeElectronPhaseShutdown({
      driver: "electron", forcedTermination: false, exitCode: 1,
      readFinalFlush: async () => marker,
      waitForProcessExit: async () => { throw new Error("exact process remains alive"); }
    })).toEqual({ finalFlush: marker, processExited: false,
      shutdownError: "exact process remains alive" });
  });

  it("rejects an otherwise passing journey with missing final flush", async () => {
    await expect(observeElectronPhaseShutdown({
      driver: "electron", forcedTermination: false, exitCode: 0,
      readFinalFlush: async () => { throw new Error("missing final flush"); },
      waitForProcessExit: vi.fn()
    })).rejects.toThrow("missing final flush");
  });

  it("rejects a retired driver before consuming its shutdown markers", async () => {
    const readFinalFlush = vi.fn();
    const waitForProcessExit = vi.fn();
    await expect(observeElectronPhaseShutdown({
      driver: "tauri", forcedTermination: false, exitCode: 0,
      readFinalFlush, waitForProcessExit
    })).rejects.toThrow("sole Electron driver");
    expect(readFinalFlush).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalled();
  });

  it("does not reinterpret an expected forced shutdown", async () => {
    const readFinalFlush = vi.fn();
    const waitForProcessExit = vi.fn();
    expect(await observeElectronPhaseShutdown({
      driver: "electron", forcedTermination: true, exitCode: 1,
      readFinalFlush, waitForProcessExit
    })).toEqual({});
    expect(readFinalFlush).not.toHaveBeenCalled();
    expect(waitForProcessExit).not.toHaveBeenCalled();
  });
});
