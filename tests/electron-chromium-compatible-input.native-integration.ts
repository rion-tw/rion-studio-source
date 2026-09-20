import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { validateCompatibleInputReceipt } from "../src/electron/main/chromiumCompatibleInputValidation";

it("preserves compatible legacy fields in the main-world consumer across 100 held-Alt cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-compatible-worlds-"));
  try {
    const reportPath = join(directory, "report.json");
    await promisify(execFile)(createRequire(import.meta.url)("electron") as string,
      ["scripts/probeChromiumCompatibleInput.cjs", reportPath, join(directory, "data")], { timeout: 30000 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe(process.platform);
    expect(report.receipts).toHaveLength(404);
    for (const [index, receipt] of report.receipts.entries()) {
      expect(receipt.status).toBe("applied");
      expect(validateCompatibleInputReceipt(report.commands[index], receipt, {
        nowMs: report.commands[index].deadlineMs - 1, documentCurrent: true, target: report.receipts[0].targetToken
      }).validation).toBeUndefined();
    }
    // The consumer received this event even when an authenticated return value is malformed.
    const rejected = validateCompatibleInputReceipt(report.commands[1], { ...report.receipts[1], sequence: -1 }, {
      nowMs: report.commands[1].deadlineMs - 1, documentCurrent: true, target: report.receipts[0].targetToken
    });
    expect(rejected.validation).toMatchObject({ reason: "identity", field: "sequence", reportedEventCount: 1 });
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
    const corrected = report.reconciliation;
    expect(corrected.receipts).toHaveLength(200);
    for (const receipt of corrected.receipts) {
      expect(receipt).toMatchObject({ status: "applied", modifierEvidence: { eventModifierMask: 0 } });
      expect(receipt.modifierEvidence.transitions.filter((entry: { source: string }) =>
        entry.source === "physical-reconcile")).toHaveLength(2);
    }
    expect(corrected.events.map((event: { type: string; code: string }) => `${event.type}:${event.code}`))
      .toEqual(["keydown:MetaLeft", "keydown:ShiftLeft", "keyup:ShiftLeft", "keyup:MetaLeft",
        "keydown:KeyO", ...Array.from({ length: 100 }, () => ["keydown:Digit0", "keyup:Digit0"]).flat(), "keyup:KeyO"]);
    for (const event of corrected.events) {
      const keyCode = ({ MetaLeft: 91, ShiftLeft: 16, KeyO: 79, Digit0: 48 } as Record<string, number>)[event.code];
      expect(event.keyCode).toBe(keyCode);
      expect(event.which).toBe(keyCode);
      if (event.code === "Digit0") expect(event).toMatchObject({
        metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, isTrusted: false
      });
    }
    expect(corrected.events.at(-1).pressed).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
