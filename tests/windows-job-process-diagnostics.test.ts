import { access } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWindowsJobDiagnosticFixture } from "./support/windowsJobDiagnosticFixture";

describe.skipIf(process.platform !== "win32")("Windows Job process diagnostics", () => {
  let fixture: Awaited<ReturnType<typeof startWindowsJobDiagnosticFixture>> | undefined;

  beforeAll(async () => {
    fixture = await startWindowsJobDiagnosticFixture();
    // Cold PowerShell/Roslyn compilation is fixture setup, separate from the
    // unchanged native-behavior budget. Only the exact stdout barrier admits it.
    await fixture.ready;
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  it(
    "observes only the exact Windows Job descendants without granting completion authority",
    async () => {
      if (!fixture) throw new Error("The compiled Windows Job fixture is unavailable.");
      const stdout = await fixture.run();
      const result = JSON.parse(stdout) as {
        platform: string;
        rootProcessId: number;
        rootImagePath: string;
        rootSubsystem: number;
        totalProcesses: number;
        notificationError: number;
        truncated: boolean;
        activeBeforeRelease: { ProcessId: number; InJobAtObservation: boolean }[];
        activeSnapshotError: number;
        activeSnapshotTruncated: boolean;
        nonConsoleSurvivorRejected: boolean;
        liveRootAccountingRejected: boolean;
        missingEmptyNotificationRejected: boolean;
        finalActiveProcesses: number;
        exitedRootAccountingEligible: boolean;
        otherLiveMemberRejected: boolean;
        observations: {
          ProcessId: number;
          ImagePath: string | null;
          InJobAtObservation: boolean;
          ImageQueryError: number;
        }[];
      };
      expect(result.platform).toBe("win32");
      expect(result.rootSubsystem).toBe(2);
      expect(result.notificationError).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.activeSnapshotError).toBe(0);
      expect(result.activeSnapshotTruncated).toBe(false);
      expect(result.nonConsoleSurvivorRejected).toBe(true);
      expect(result.liveRootAccountingRejected).toBe(true);
      expect(result.missingEmptyNotificationRejected).toBe(true);
      expect(result.exitedRootAccountingEligible).toBe(true);
      expect(result.otherLiveMemberRejected).toBe(true);
      expect(result.finalActiveProcesses).toBe(0);
      expect(result.activeBeforeRelease).toEqual([
        expect.objectContaining({ ProcessId: result.rootProcessId, InJobAtObservation: true })
      ]);
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
    },
    30_000
  );
});

describe.skipIf(process.platform !== "win32")("Windows Job fixture setup cancellation", () => {
  let fixture: Awaited<ReturnType<typeof startWindowsJobDiagnosticFixture>> | undefined;

  beforeAll(async () => {
    fixture = await startWindowsJobDiagnosticFixture();
    await fixture.ready;
  }, 60_000);

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("reaps the compiled setup without admitting native behavior and removes its exact temporary root", async () => {
    if (!fixture) throw new Error("The compiled Windows Job fixture is unavailable.");
    await fixture.dispose();
    expect(fixture.readStages()).toContain("gui-root-compiled");
    expect(fixture.readStages()).not.toContain("native-behavior-started");
    await expect(access(fixture.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.run()).rejects.toThrow("exact unused setup barrier");
  });
});
