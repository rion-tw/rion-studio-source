import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("records native Chromium input delivery without treating absent receipts as parity", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-chromium-input-"));
  try {
    const reportDirectory = process.env.RION_CHROMIUM_INPUT_REPORT_DIR ?? directory;
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(reportDirectory, `chromium-input-${process.platform}.json`);
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumInput.cjs", reportPath, join(directory, "data")
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe(process.platform);
    expect(report.electron).toBe(require("electron/package.json").version);
    expect(report.outcomes.map((outcome: { name: string }) => outcome.name)).toEqual([
      "foreground", "modifiers-and-repeat", "modifier-control", "modifier-alt", "modifier-meta",
      "middle-button-zoom-1", "middle-button-zoom-1.5", "held-before-reload",
      "held-release-after-reload", "reloaded", "hidden-view", "hidden-view-middle",
      "background-host", "background-host-middle", "hidden-host", "hidden-host-middle"
    ]);
    for (const outcome of report.outcomes) {
      expect(["received", "mismatch", "indeterminate"]).toContain(outcome.receipt.status);
      expect(outcome.receipt.events.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
      if (outcome.name.startsWith("background-host") || outcome.name.startsWith("hidden-host")) {
        expect(outcome.before.hostFocused).toBe(false);
        expect(outcome.after.hostFocused).toBe(false);
      }
    }
    const foreground = report.outcomes[0];
    expect(foreground.before.hostFocused).toBe(true);
    expect(foreground.receipt.status).toBe("received");
    expect(foreground.receipt.events.map((event: { key: string }) => event.key)).toEqual(["a", "a"]);
    console.info(JSON.stringify(report.outcomes.map((outcome: {
      name: string; receipt: { status: string }; before: unknown;
    }) => ({ name: outcome.name, status: outcome.receipt.status, before: outcome.before }))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
