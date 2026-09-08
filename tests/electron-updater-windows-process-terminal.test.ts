import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  terminateWindowsProcessTree,
  waitForWindowsProcess
} from "../scripts/runElectronUpdaterTransactionProbe.mjs";

describe.runIf(process.platform === "win32")("Windows updater process terminal observation", () => {
  it("accepts an exact fixture PID that exited before the installer wait", async () => {
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    await expect(waitForWindowsProcess(child.pid!, process.env)).resolves.toBeUndefined();
  });

  it("accepts an already absent target after cleanup", async () => {
    const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
    await once(child, "exit");
    await expect(terminateWindowsProcessTree(child.pid!, process.env)).resolves.toBeUndefined();
  });

  it("terminates a live fixture and verifies target absence", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      windowsHide: true, stdio: ["pipe", "ignore", "ignore"]
    });
    const exited = once(child, "exit");
    try {
      await terminateWindowsProcessTree(child.pid!, process.env);
      await exited;
      expect(child.exitCode).not.toBeNull();
      await expect(waitForWindowsProcess(child.pid!, process.env)).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("retains the native wait until a live fixture exits", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {
      windowsHide: true
    });
    const exited = once(child, "exit");
    try {
      await waitForWindowsProcess(child.pid!, process.env);
      await exited;
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});

describe("Windows updater PID validation before native dispatch", () => {
  it.each([0, 1, -1, NaN, 1.5])("rejects invalid PID %s before a native command", async pid => {
    await expect(waitForWindowsProcess(pid, {})).rejects.toThrow("invalid updater installer process");
    await expect(terminateWindowsProcessTree(pid, {})).rejects.toThrow("invalid updater target process");
  });
});
