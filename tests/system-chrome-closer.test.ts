import { describe, expect, it, vi } from "vitest";

import {
  requestGracefulChromeQuit,
  WINDOWS_CLOSE_SCRIPT
} from "../src/main/system-browser/SystemChromeCloser";

describe("SystemChromeCloser", () => {
  it("asks Google Chrome to quit normally on macOS", async () => {
    const execFile = vi.fn(async (..._args: unknown[]) => ({ stdout: "", stderr: "" }));

    await requestGracefulChromeQuit({ platform: "darwin", execFile: execFile as never });

    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-e", 'if application "Google Chrome" is running then tell application "Google Chrome" to quit'],
      { timeout: 5_000 }
    );
  });

  it("sends WM_CLOSE to visible Chrome windows on Windows without force termination", async () => {
    const execFile = vi.fn(async (..._args: unknown[]) => ({ stdout: "", stderr: "" }));

    await requestGracefulChromeQuit({ platform: "win32", execFile: execFile as never });

    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]),
      { timeout: 5_000 }
    );
    expect(execFile.mock.calls[0]?.[1]).toContain(WINDOWS_CLOSE_SCRIPT);
    expect(WINDOWS_CLOSE_SCRIPT).toContain("PostMessage");
    expect(WINDOWS_CLOSE_SCRIPT).toContain("0x0010");
    expect(WINDOWS_CLOSE_SCRIPT).not.toContain("/F");
    expect(WINDOWS_CLOSE_SCRIPT).not.toContain("TerminateProcess");
  });

  it("reports unsupported platforms without invoking a process command", async () => {
    const execFile = vi.fn(async (..._args: unknown[]) => ({ stdout: "", stderr: "" }));

    await expect(requestGracefulChromeQuit({ platform: "linux", execFile: execFile as never })).rejects.toMatchObject({
      code: "PLATFORM_UNSUPPORTED"
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("normalizes platform command failures", async () => {
    const execFile = vi.fn(async (..._args: unknown[]) => {
      throw new Error("command failed");
    });

    await expect(requestGracefulChromeQuit({ platform: "darwin", execFile: execFile as never })).rejects.toMatchObject({
      code: "CHROME_CLOSE_FAILED"
    });
  });
});
