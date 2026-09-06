import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

// macOS retains its AppKit input owner. This test requires the real Win32 parent probe.
it.runIf(process.platform === "win32")("submits hidden and visible sibling View input through its exact native parent owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-chromium-view-owner-"));
  try {
    const reportDirectory = process.env.RION_CHROMIUM_INPUT_REPORT_DIR ?? directory;
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(reportDirectory, "chromium-view-owner-win32.json");
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumInput.cjs", reportPath, join(directory, "data"),
      resolve("build", "native", `win32-${process.arch}`, "rion-core.node")
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe("win32");
    expect(report.status).not.toBe("failed");
    const samples = report.outcomes.filter((sample: { name: string }) =>
      /^direct-(hidden|visible)-sibling-/u.test(sample.name));
    expect(samples).toHaveLength(4);
    let sequence = 0n;
    for (const sample of samples) {
      const visible = sample.name.startsWith("direct-visible");
      expect(sample.receipt.status).toBe("received");
      expect(sample.directHost).toMatchObject({ nativeParentOwner: true,
        targetAttached: true, siblingAttached: true, targetVisible: visible,
        siblingFocusedBefore: true, siblingFocusedAfter: true,
        viewportAcknowledgement: { status: "applied", width: 240, height: 160 } });
      expect(sample.before.contentsFocused).toBe(false);
      expect(sample.after.contentsFocused).toBe(false);
      expect(sample.before.hostFocused).toBe(true);
      expect(sample.after.hostFocused).toBe(true);
      for (const event of sample.receipt.events) expect(event.trusted).toBe(true);
      expect(sample.receipt.events).toHaveLength(2);
      const submissions = Array.isArray(sample.submission) ? sample.submission : [sample.submission];
      expect(submissions).toHaveLength(sample.name.endsWith("middle") ? 1 : 2);
      for (const receipt of submissions) {
        expect(receipt).toMatchObject({ roleId: "direct-view-role", status: "submitted",
          submissionApi: "webContents.sendInputEvent", deliveryMode: visible ? "foreground" : "background",
          viewAttached: true, foregroundPreserved: true });
        expect(receipt.parentIdentity).toMatch(/^[0-9a-f]{64}$/u);
        expect(receipt.focusIdentity).toMatch(/^[0-9a-f]{64}$/u);
        expect(BigInt(receipt.dispatchSequence)).toBeGreaterThan(sequence);
        sequence = BigInt(receipt.dispatchSequence);
        expect(receipt).not.toHaveProperty("surfaceHandleToken");
      }
      if (sample.name.endsWith("middle")) {
        expect(sample.receipt.events).toHaveLength(2);
        for (const event of sample.receipt.events) {
          expect(event).toMatchObject({ button: 1, x: 80, y: 96, trusted: true });
        }
      } else {
        for (const event of sample.receipt.events) {
          expect(event).toMatchObject({ code: "KeyB", control: true, shift: true });
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
