import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLOSE_TIMEOUT_MS = 5_000;
const WINDOWS_CLOSE_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Diagnostics;",
  "using System.Runtime.InteropServices;",
  "public static class RionStudioChromeCloser {",
  "  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
  "  [DllImport(\"user32.dll\")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);",
  "  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
  "  [DllImport(\"user32.dll\")] private static extern bool IsWindowVisible(IntPtr hWnd);",
  "  [DllImport(\"user32.dll\")] private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);",
  "  public static void CloseChromeWindows() {",
  "    EnumWindows((hWnd, lParam) => {",
  "      if (!IsWindowVisible(hWnd)) return true;",
  "      GetWindowThreadProcessId(hWnd, out var processId);",
  "      if (processId == 0) return true;",
  "      try {",
  "        using var process = Process.GetProcessById((int)processId);",
  "        if (string.Equals(process.ProcessName, \"chrome\", StringComparison.OrdinalIgnoreCase)) PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);",
  "      } catch (ArgumentException) { }",
  "      return true;",
  "    }, IntPtr.Zero);",
  "  }",
  "}",
  "'@",
  "[RionStudioChromeCloser]::CloseChromeWindows()"
].join("\n");

export class SystemChromeCloserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SystemChromeCloserError";
  }
}

export interface SystemChromeCloserOptions {
  execFile?: typeof execFileAsync;
  platform?: NodeJS.Platform;
}

export async function requestGracefulChromeQuit(options: SystemChromeCloserOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const run = options.execFile ?? execFileAsync;

  try {
    if (platform === "darwin") {
      await run("/usr/bin/osascript", [
        "-e",
        'if application "Google Chrome" is running then tell application "Google Chrome" to quit'
      ], { timeout: CLOSE_TIMEOUT_MS });
      return;
    }

    if (platform === "win32") {
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_CLOSE_SCRIPT
      ], { timeout: CLOSE_TIMEOUT_MS });
      return;
    }

    throw new SystemChromeCloserError(
      "PLATFORM_UNSUPPORTED",
      "Graceful Chrome close is supported on macOS and Windows only."
    );
  } catch (error) {
    if (error instanceof SystemChromeCloserError) {
      throw error;
    }

    throw new SystemChromeCloserError(
      "CHROME_CLOSE_FAILED",
      "Unable to ask Google Chrome to close. Close Chrome manually and try again."
    );
  }
}

export { WINDOWS_CLOSE_SCRIPT };
