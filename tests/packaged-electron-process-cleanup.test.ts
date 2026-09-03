import { EventEmitter } from "node:events";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import {
  createPackagedElectronProcessOwner,
  packagedElectronSpawnOptions,
  packagedSmokeFailure,
  terminatePackagedElectronProcessTree,
  waitForPackagedElectronProcessClose
} from "../scripts/packagedElectronProcessCleanup.mjs";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  pid: number;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function createOwner(processId: number) {
  const child = new FakeChildProcess(processId);
  const owner = createPackagedElectronProcessOwner({
    child,
    executablePath: "/fixtures/Rion Studio.exe",
    platform: "win32",
    spawnedAtMilliseconds: 1_000
  });
  return { child, owner };
}

describe("packaged Electron process cleanup", () => {
  it("isolates only the macOS launch in a detached process group", () => {
    const macOptions = packagedElectronSpawnOptions("darwin");
    const windowsOptions = packagedElectronSpawnOptions("win32");

    expect(macOptions).toEqual({ detached: true });
    expect(windowsOptions).toEqual({ detached: false });
    expect(Object.isFrozen(macOptions)).toBe(true);
    expect(Object.isFrozen(windowsOptions)).toBe(true);
    expect(() => packagedElectronSpawnOptions("linux"))
      .toThrow("does not support linux");
  });

  it.each([
    undefined,
    Number.NaN,
    -1,
    0,
    1,
    process.pid
  ])("rejects unsafe owned process ID %s", (processId) => {
    expect(() => createPackagedElectronProcessOwner({
      child: Object.assign(new EventEmitter(), {
        exitCode: null,
        pid: processId,
        signalCode: null
      }),
      executablePath: "/fixtures/Rion Studio",
      platform: "darwin",
      spawnedAtMilliseconds: 1_000
    })).toThrow("safe owned process ID");
  });

  it.each([
    [{ platform: "linux" }, "requires macOS or Windows"],
    [{ spawnedAtMilliseconds: 0 }, "requires an exact spawn time"],
    [{ spawnedAtMilliseconds: Number.NaN }, "requires an exact spawn time"],
    [{ executablePath: "" }, "requires its executable path"]
  ])("rejects an invalid owner input %#", (override, message) => {
    expect(() => createPackagedElectronProcessOwner({
      child: new FakeChildProcess(40_001),
      executablePath: "/fixtures/Rion Studio",
      platform: "darwin",
      spawnedAtMilliseconds: 1_000,
      ...override
    })).toThrow(message);
  });

  it("resolves close only after the exact child exit and pipe-close events", async () => {
    const { child, owner } = createOwner(41_001);
    const closed = waitForPackagedElectronProcessClose(owner, 100);

    child.finish(0, null);

    await expect(closed).resolves.toEqual({ code: 0, signal: null });
  });

  it("rejects a pipe close that arrives before process exit", async () => {
    const { child, owner } = createOwner(41_002);
    const closed = waitForPackagedElectronProcessClose(owner, 100);

    child.emit("close", null, "SIGKILL");

    await expect(closed).rejects.toThrow("pipes closed before process exit");
  });

  it("uses the exact Windows root once and relies on tree termination", async () => {
    const { child, owner } = createOwner(51_001);
    let now = 0;
    const snapshots = [
      [
        { depth: 0, processId: 51_001 },
        { depth: 1, processId: 51_002 }
      ],
      [],
      []
    ];
    const operations = {
      isDarwinProcessGroupAlive: vi.fn(() => false),
      now: () => now,
      readWindowsOwnedTree: vi.fn(async () => snapshots.shift() ?? []),
      signalDarwinProcessGroup: vi.fn(),
      sleep: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
      terminateWindowsTree: vi.fn(async (processId) => {
        expect(processId).toBe(51_001);
        child.finish(null, "SIGKILL");
      })
    };

    await terminatePackagedElectronProcessTree(owner, operations);

    expect(operations.terminateWindowsTree).toHaveBeenCalledTimes(1);
    expect(operations.terminateWindowsTree).toHaveBeenCalledWith(51_001);
    expect(operations.readWindowsOwnedTree).toHaveBeenCalledTimes(3);
  });

  it("terminates orphaned Windows descendants deepest-first", async () => {
    const { child, owner } = createOwner(52_001);
    child.finish(null, "SIGKILL");
    let now = 0;
    const snapshots = [
      [
        { depth: 1, processId: 52_002 },
        { depth: 3, processId: 52_004 },
        { depth: 2, processId: 52_003 }
      ],
      [],
      []
    ];
    const terminated: number[] = [];
    const operations = {
      isDarwinProcessGroupAlive: vi.fn(() => false),
      now: () => now,
      readWindowsOwnedTree: vi.fn(async () => snapshots.shift() ?? []),
      signalDarwinProcessGroup: vi.fn(),
      sleep: vi.fn(async (milliseconds) => {
        now += milliseconds;
      }),
      terminateWindowsTree: vi.fn(async (processId) => {
        terminated.push(processId);
      })
    };

    await terminatePackagedElectronProcessTree(owner, operations);

    expect(terminated).toEqual([52_004, 52_003, 52_002]);
  });

  it("fails closed when taskkill returns but an owned Windows process remains", async () => {
    const { child, owner } = createOwner(53_001);
    child.finish(null, "SIGKILL");
    let now = 0;
    const survivor = [{ depth: 0, processId: 53_001 }];
    const operations = {
      isDarwinProcessGroupAlive: vi.fn(() => false),
      now: () => now,
      readWindowsOwnedTree: vi.fn(async () => survivor),
      signalDarwinProcessGroup: vi.fn(),
      sleep: vi.fn(async (milliseconds) => {
        now += Math.max(milliseconds, 20_000);
      }),
      terminateWindowsTree: vi.fn(async () => undefined)
    };

    let failure: unknown;
    try {
      await terminatePackagedElectronProcessTree(owner, operations);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((error) =>
      String(error).includes("Windows process-tree cleanup failed")
    )).toBe(true);
  });

  it("keeps the primary smoke error as the AggregateError cause", () => {
    const primary = new Error("visible interaction failed");
    const processCleanup = new Error("owned process survived");
    const fixtureCleanup = new Error("fixture close failed");

    expect(packagedSmokeFailure(primary, [])).toBe(primary);
    const combined = packagedSmokeFailure(primary, [
      processCleanup,
      fixtureCleanup
    ]);

    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.cause).toBe(primary);
    expect(combined.errors).toEqual([
      primary,
      processCleanup,
      fixtureCleanup
    ]);
  });
});
