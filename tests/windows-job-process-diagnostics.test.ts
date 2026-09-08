import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "observes only the exact Windows Job descendants without granting completion authority",
  async () => {
    const { stdout } = await promisify(execFile)("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      resolve("tests/fixtures/windows-job-process-diagnostics.ps1")
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as {
      platform: string;
      rootProcessId: number;
      rootImagePath: string;
      totalProcesses: number;
      notificationError: number;
      truncated: boolean;
      observations: {
        ProcessId: number;
        ImagePath: string | null;
        InJobAtObservation: boolean;
        ImageQueryError: number;
      }[];
    };
    expect(result.platform).toBe("win32");
    expect(result.notificationError).toBe(0);
    expect(result.truncated).toBe(false);
    // Console hosts are OS-created descendants too; compare with the exact
    // native Job count instead of guessing from the two requested executables.
    expect(result.totalProcesses).toBeGreaterThanOrEqual(2);
    expect(result.observations).toHaveLength(result.totalProcesses);
    expect(result.observations.find((entry) => entry.ProcessId === result.rootProcessId))
      .toMatchObject({
        ImagePath: result.rootImagePath,
        ImageQueryError: 0,
        InJobAtObservation: true
      });
    expect(result.observations.every((entry) => entry.ProcessId !== process.pid)).toBe(true);
  }
);
