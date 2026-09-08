import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "executes the attested PowerShell file without a duplicate host and retains exact failure exits",
  async () => {
    const { stdout } = await promisify(execFile)("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      resolve("tests/fixtures/windows-inline-powershell.ps1")
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as {
      platform: string; literal: string; rejected: string[]; injected: boolean;
      cases: { code: string; exitCode: number; totalProcesses: number;
        activeAtRootExit: number; activeAfterConsoleDrain: number;
        notificationError: number; truncated: boolean;
        marker: { literal: string; empty: string; code: string };
        observations: { ImagePath: string; InJobAtObservation: boolean }[] }[];
    };
    expect(result.platform).toBe("win32");
    expect(result.injected).toBe(false);
    expect(result.rejected).toEqual(["host", "options", "pairs", "duplicate", "parameter", "file"]);
    expect(result.cases.map(({ code, exitCode }) => [code, exitCode]), JSON.stringify(result.cases))
      .toEqual([["0", 0], ["7", 7], ["throw", 1]]);
    for (const entry of result.cases) {
      expect(entry.marker).toEqual({ literal: result.literal, empty: "", code: entry.code });
      expect(entry.activeAfterConsoleDrain, JSON.stringify(entry)).toBe(0);
      expect(entry.activeAtRootExit).toBeLessThanOrEqual(1);
      expect(entry.notificationError).toBe(0);
      expect(entry.truncated).toBe(false);
      expect(entry.observations).toHaveLength(entry.totalProcesses);
      expect(entry.observations.every(({ InJobAtObservation }) => InJobAtObservation)).toBe(true);
      expect(entry.observations.filter(({ ImagePath }) => ImagePath.endsWith("\\pwsh.exe")))
        .toHaveLength(1);
      if (entry.code !== "throw") expect(entry.totalProcesses).toBe(3);
    }
  }
);
