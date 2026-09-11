import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("records an isolated baseline/CDP parity candidate without promoting production", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-cdp-input-"));
  try {
    const reportPath = join(directory, `chromium-cdp-input-${process.platform}.json`);
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumCdpInput.cjs", reportPath, join(directory, "data")
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      platform: process.platform,
      electron: require("electron/package.json").version,
      transport: "in-process-webContents-debugger-input-only",
      productionPromoted: false,
      externalDebugTransport: false
    });
    expect(report.outcomes.map((outcome: { name: string }) => outcome.name)).toEqual([
      "baseline-background-chord", "baseline-middle", "baseline-right",
      "baseline-control-right-dom-code",
      "cdp-background-chord", "cdp-middle", "cdp-right",
      "cdp-f21", "cdp-f22", "cdp-f23", "cdp-f24", "cdp-hidden-key"
    ]);
    for (const outcome of report.outcomes) {
      expect(["received", "mismatch", "indeterminate"]).toContain(outcome.receipt.status);
      expect(outcome.before.hostFocused).toBe(outcome.after.hostFocused);
      expect(outcome.before.contentsFocused).toBe(outcome.after.contentsFocused);
      for (const event of outcome.receipt.events) expect(event.trusted).toBe(true);
    }
    expect(report.comparisons).toMatchObject({ middle: true, right: true });
    expect(typeof report.comparisons.chord).toBe("boolean");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
