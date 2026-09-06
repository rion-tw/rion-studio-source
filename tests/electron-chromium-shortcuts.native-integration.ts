import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it.skipIf(process.platform !== "win32")("compares native F11 key terminality with Chromium APIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-shortcut-probe-"));
  try {
    const reportDirectory = process.env.RION_CHROMIUM_INPUT_REPORT_DIR ?? directory;
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(reportDirectory, "chromium-shortcuts-win32.json");
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumShortcuts.cjs", reportPath, join(directory, "data")
    ], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe("win32");
    expect(report.electron).toBe(require("electron/package.json").version);
    expect(report.outcomes).toHaveLength(36);
    for (const outcome of report.outcomes) {
      expect(outcome.hostFocused).toBe(true);
      expect(outcome.events.some((event: { kind: string }) => event.kind === "native-error")).toBe(false);
      expect(outcome.pageEvents.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
      if (outcome.mode === "native-hook") {
        expect(outcome.commandsBeforeRelease).toBe(0);
        expect(outcome.events.filter((event: { kind: string }) => event.kind === "command")).toHaveLength(1);
        expect(outcome.pageEvents).toEqual([]);
      }
    }
    expect(report.lifecycleOutcomes).toHaveLength(36);
    for (const outcome of report.lifecycleOutcomes) {
      expect(["focus-transfer", "hidden-owner", "retired-owner"]).toContain(outcome.scenario);
      expect(outcome.ownerVisibleAtRelease).toBe(outcome.scenario !== "hidden-owner");
      expect(outcome.events.some((event: { kind: string }) => event.kind === "native-error")).toBe(false);
      for (const events of [outcome.pageEvents, outcome.destinationPageEvents]) {
        expect(events.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
      }
      if (outcome.mode === "native-hook") {
        expect(outcome.events.filter((event: { kind: string }) => event.kind === "command")).toEqual([]);
      }
    }
    for (const outcome of [...report.outcomes, ...report.lifecycleOutcomes]) {
      if (outcome.mode !== "native-hook") continue;
      for (const event of outcome.events) {
        if (event.kind === "command") expect(event.ownerRevision).toBe(outcome.ownerRevision);
      }
    }
    // API differences are reported, never converted into replacement parity.
    console.info(JSON.stringify(report.outcomes));
    console.info(JSON.stringify(report.lifecycleOutcomes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 100_000);
