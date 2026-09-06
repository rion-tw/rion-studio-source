import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("records actual hidden and occluded renderer zoom acknowledgements without inferring parity", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-chromium-viewport-"));
  try {
    const reportPath = join(directory, "viewport.json");
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumViewport.cjs", reportPath, join(directory, "data")
    ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    // CI preserves the complete evidence even if a later assertion fails.
    process.stdout.write(`${JSON.stringify(report)}\n`);
    expect(report.platform).toBe(process.platform);
    expect(report.electron).toBe(require("electron/package.json").version);
    expect(report.isolatedSessions).toBe(true);
    expect(report.outcomes.map((item: { mode: string }) => item.mode)).toEqual(["hidden", "occluded"]);
    for (const outcome of report.outcomes) {
      expect(outcome.calibration).toMatchObject({ status: "applied", ...outcome.expected });
      expect(outcome.expected.width).toBeLessThan(600);
      expect(outcome.expected.height).toBeLessThan(400);
      expect(outcome.baseline).toMatchObject({ status: "applied", width: 600, height: 400 });
      for (const state of [outcome.before, outcome.after]) {
        expect(state.native).toMatchObject({ hostFocused: true, hostVisible: true,
          targetVisible: outcome.mode === "occluded", targetFocused: false, siblingVisible: true,
          siblingFocused: true, targetAttached: true, siblingAttached: true });
      }
      expect(outcome.after.browserZoom).toBe(outcome.factor);
      expect(["applied", "indeterminate"]).toContain(outcome.whileCovered.status);
      if (outcome.whileCovered.status === "applied") {
        expect(outcome.whileCovered).toMatchObject(outcome.expected);
      }
      expect(outcome.revealed).toMatchObject({ status: "applied", ...outcome.expected });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
