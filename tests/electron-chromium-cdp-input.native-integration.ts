import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("records native parity for the production CDP Input transport", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-cdp-input-"));
  try {
    const configuredReportDirectory = process.env.RION_CHROMIUM_INPUT_REPORT_DIR;
    const reportDirectory = configuredReportDirectory
      ? resolve(configuredReportDirectory)
      : directory;
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(
      reportDirectory,
      `chromium-cdp-input-${process.platform}.json`
    );
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumCdpInput.cjs", reportPath, join(directory, "data")
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      platform: process.platform,
      electron: require("electron/package.json").version,
      transport: "in-process-webContents-debugger-input-only",
      productionPromoted: true,
      externalDebugTransport: false
    });
    expect(report.outcomes.map((outcome: { name: string }) => outcome.name)).toEqual([
      "baseline-background-chord", "baseline-middle", "baseline-right",
      "baseline-control-right-dom-code",
      "cdp-background-chord", "cdp-middle", "cdp-right",
      "cdp-f21", "cdp-f22", "cdp-f23", "cdp-f24", "cdp-hidden-key"
    ]);
    for (const outcome of report.outcomes) {
      expect(
        outcome.receipt.status,
        `${outcome.name}: ${JSON.stringify(outcome.receipt)}`
      ).toBe("received");
      expect(outcome.before.hostFocused).toBe(outcome.after.hostFocused);
      expect(outcome.before.contentsFocused).toBe(outcome.after.contentsFocused);
      for (const event of outcome.receipt.events) expect(event.trusted).toBe(true);
    }
    expect(report.comparisons).toMatchObject({
      chordExceptLegacyRightControl: true,
      rightControlIdentityCorrected: true,
      middle: true,
      right: true
    });
    const chord = report.outcomes.find(
      (outcome: { name: string }) => outcome.name === "cdp-background-chord"
    );
    expect(chord.receipt.events.map((event: { code: string }) => event.code)).toEqual([
      "ControlRight", "ShiftLeft", "KeyA", "KeyA", "KeyA", "ShiftLeft",
      "ControlRight"
    ]);
    expect(chord.receipt.events.map((event: { repeat: boolean }) => event.repeat))
      .toEqual([false, false, false, true, false, false, false]);
    for (const code of ["F21", "F22", "F23", "F24"]) {
      const outcome = report.outcomes.find(
        (candidate: { name: string }) => candidate.name === `cdp-${code.toLowerCase()}`
      );
      expect(outcome.receipt.events.map((event: { code: string }) => event.code))
        .toEqual([code, code]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
