import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "joins exact console exit for inline and child commands while retaining exact failure exits",
  async () => {
    const { stdout } = await promisify(execFile)("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      resolve("tests/fixtures/windows-inline-powershell.ps1")
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as {
      platform: string; literal: string; rejected: string[]; injected: boolean;
      cases: { inline: boolean; code: string; exitCode: number; totalProcesses: number;
        activeAtRootExit: number; activeAfterConsoleDrain: number;
        joinedExitedRootAccounting: boolean;
        pinnedConsoleHosts: boolean[]; pinnedAfterDispose: boolean[];
        notificationError: number; truncated: boolean;
        marker: { literal: string; empty: string; code: string };
        observations: { ImagePath: string; InJobAtObservation: boolean }[] }[];
    };
    expect(result.platform).toBe("win32");
    expect(result.injected).toBe(false);
    expect(result.rejected).toEqual(["host", "options", "pairs", "duplicate", "parameter", "file"]);
    expect(result.cases.map(({ inline, code, exitCode }) => [inline, code, exitCode]), JSON.stringify(result.cases))
      .toEqual([true, false].flatMap(inline => [[inline, "0", 0], [inline, "7", 7], [inline, "throw", 1]]));
    for (const entry of result.cases) {
      expect(entry.marker).toEqual({ literal: result.literal, empty: "", code: entry.code });
      expect(entry.activeAfterConsoleDrain, JSON.stringify(entry)).toBe(0);
      expect(entry.activeAtRootExit).toBeLessThanOrEqual(2);
      if (entry.activeAtRootExit === 2) expect(entry.joinedExitedRootAccounting).toBe(true);
      expect(entry.notificationError).toBe(0);
      expect(entry.pinnedConsoleHosts).toEqual([true]);
      expect(entry.pinnedAfterDispose).toEqual([false]);
      expect(entry.truncated).toBe(false);
      expect(entry.observations).toHaveLength(entry.totalProcesses);
      expect(entry.observations.every(({ InJobAtObservation }) => InJobAtObservation)).toBe(true);
      expect(entry.observations.filter(({ ImagePath }) => ImagePath.endsWith("\\pwsh.exe")))
        .toHaveLength(entry.inline ? 1 : 2);
      if (entry.code !== "throw") expect(entry.totalProcesses).toBe(entry.inline ? 3 : 4);
    }
  }
);
