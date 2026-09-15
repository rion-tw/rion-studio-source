import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("preserves compatible legacy fields in the main-world consumer across 100 held-Alt cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-compatible-worlds-"));
  try {
    const reportPath = join(directory, "report.json");
    await promisify(execFile)(createRequire(import.meta.url)("electron") as string,
      ["scripts/probeChromiumCompatibleInput.cjs", reportPath, join(directory, "data")], { timeout: 30000 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe(process.platform);
    expect(report.receipts).toHaveLength(404);
    for (const receipt of report.receipts) expect(receipt.status).toBe("applied");
    expect(report.events).toHaveLength(208);
    for (const event of report.events) {
      const expected = event.code === "AltLeft" ? 18 : 51;
      expect(event.keyCode, `${event.type} ${event.code} in main world`).toBe(expected);
      expect(event.which).toBe(expected);
      expect(event.charCode).toBe(0);
      expect(event.isTrusted).toBe(false);
      expect(event.altState).toBe(event.altKey);
      if (event.code === "Digit3") {
        expect(event.altKey).toBe(true);
        expect(event.pressed).toContain(18);
      }
    }
    expect(report.events.at(-1).pressed).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
