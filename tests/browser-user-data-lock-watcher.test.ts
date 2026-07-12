import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseSingletonLockPid, BrowserUserDataLockTimeoutError, BrowserUserDataLockWatcher } from "../src/main/browser/BrowserUserDataLockWatcher";

describe("BrowserUserDataLockWatcher", () => {
  it("reports locked when the SingletonLock PID is still alive", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-lock-test-"));
    await symlink(`host-${process.pid}`, join(userDataDir, "SingletonLock"));

    const watcher = new BrowserUserDataLockWatcher({ platform: "linux" });

    await expect(watcher.getLockState(userDataDir)).resolves.toMatchObject({
      locked: true,
      pid: process.pid,
      reason: "singleton_lock_pid_alive"
    });
  });

  it("reports released when the SingletonLock PID is gone", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-lock-test-"));
    await symlink("host-999999", join(userDataDir, "SingletonLock"));

    const watcher = new BrowserUserDataLockWatcher({
      platform: "linux",
      isProcessAlive: () => false
    });

    await expect(watcher.getLockState(userDataDir)).resolves.toMatchObject({
      locked: false,
      pid: 999999,
      reason: "singleton_lock_pid_gone"
    });
  });

  it("reports released when lock indicators are missing", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-lock-test-"));
    const watcher = new BrowserUserDataLockWatcher({ platform: "linux" });

    await expect(watcher.getLockState(userDataDir)).resolves.toMatchObject({
      locked: false,
      reason: "lock_missing"
    });
  });

  it("times out while the lock PID stays alive", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-lock-test-"));
    await symlink(`host-${process.pid}`, join(userDataDir, "SingletonLock"));
    let now = 0;
    const watcher = new BrowserUserDataLockWatcher({
      platform: "linux",
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      }
    });

    await expect(watcher.waitForRelease(userDataDir, { timeoutMs: 20, pollIntervalMs: 10 })).rejects.toBeInstanceOf(
      BrowserUserDataLockTimeoutError
    );
  });

  it("parses Chromium SingletonLock symlink targets", () => {
    expect(parseSingletonLockPid("ArondeMacBook-Pro-2.local-90424")).toBe(90424);
    expect(parseSingletonLockPid("invalid")).toBeUndefined();
  });
});
