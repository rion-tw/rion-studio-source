import { ChromiumTrustedInputDocumentEvidence } from "../src/electron/main/chromiumTrustedInputDocumentEvidence";
import { describe, expect, it } from "vitest";
import { ChromiumPhysicalInputEvidenceLane } from "../src/electron/main/chromiumPhysicalInputEvidence";
import { reconcileChromiumTrustedInputReceipts } from "../src/electron/main/chromiumTrustedInputReceiptReconciliation";
import type { ChromiumRoleTrustedInputDomReceipt } from "../src/electron/ipc/chromiumRoleTrustedInputProtocol";

const keyup = (code: string): ChromiumRoleTrustedInputDomReceipt => ({
  roleId: "role", generation: 2, frameToken: "document", inputSequence: "sequence",
  kind: "input", observationSequence: 1, isTrusted: true, code, type: "keyup",
  button: null, clientX: null, clientY: null, altKey: false, ctrlKey: false,
  metaKey: false, shiftKey: true, repeat: false
});
const before = { sequence: "83", keyDownSequence: "17", keyUpSequence: "16",
  targetReceivesPhysicalInput: true, keyboard: { sequence: "33", events: [] } };
const raced = (code: string, consumed = false) => ({ ...before, sequence: "84", keyUpSequence: "17",
  keyboard: { sequence: "34", events: [{ sequence: "34", code, eventType: "keyup" as const,
    repeat: false, consumed }] } });

describe.each(["darwin", "win32"])("%s exact physical key evidence", () => {
  it("does not charge physical Digit3 up against the automatic Digit1 release (incident 260)", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane(before);
    const result = reconcileChromiumTrustedInputReceipts(lane, raced("Digit3"), [keyup("Digit1")], 0, [keyup("Digit1")]);
    expect(result.status).toBe("advanced");
    expect(result.nextExpectedIndex).toBe(1);
    expect(lane.classify(raced("Digit3"), keyup("Digit3"))).toBe("physical");
  });
  it("retains a 40-edge Shift chord burst until ordered DOM observations consume it", () => {
    const zero = { sequence: "0", targetReceivesPhysicalInput: true,
      keyboard: { sequence: "0", events: [] } };
    const lane = new ChromiumPhysicalInputEvidenceLane(zero);
    const events = Array.from({ length: 40 }, (_, index) => ({
      sequence: String(index + 1), code: index % 2 ? "Digit3" : "ShiftLeft",
      eventType: index % 4 < 2 ? "keydown" as const : "keyup" as const,
      repeat: false, consumed: false
    }));
    const burst = { ...zero, sequence: "40", keyboard: { sequence: "40", events } };
    for (const event of events) expect(lane.classify(burst,
      { ...keyup(event.code), type: event.eventType })).toBe("physical");
    expect(lane.classify(burst, keyup("Digit1"))).toBe("automatic");
    const overflow = { ...burst, sequence: "169", keyboard: { sequence: "169",
      events: Array.from({ length: 128 }, (_, index) => ({ ...events[0]!, sequence: String(index + 42) })) } };
    expect(lane.classify(overflow, keyup("Digit1"))).toBe("indeterminate");
  });
  it("does not invent success in a same-key race with only one observed release", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane(before);
    expect(reconcileChromiumTrustedInputReceipts(lane, raced("Digit1"), [keyup("Digit1")], 0,
      [keyup("Digit1")]).status).toBe("deferred");
    const result = reconcileChromiumTrustedInputReceipts(lane, raced("Digit1"), [keyup("Digit1")], 0,
      [keyup("Digit1"), { ...keyup("Digit1"), observationSequence: 2 }]);
    expect(result.nextExpectedIndex).toBe(1);
  });
  it("excludes a natively consumed shortcut and rejects a journal gap", () => {
    expect(new ChromiumPhysicalInputEvidenceLane(before).classify(raced("Digit1", true), keyup("Digit1")))
      .toBe("automatic");
    const gap = raced("Digit3");
    gap.keyboard.sequence = "36"; gap.keyboard.events[0]!.sequence = "36";
    expect(new ChromiumPhysicalInputEvidenceLane(before).classify(gap, keyup("Digit1"))).toBe("indeterminate");
  });
});

it("preserves consumed pre-arm evidence and rejects a missing document observation", () => {
  const stream = new ChromiumTrustedInputDocumentEvidence();
  const lane = stream.begin("role", "document", before);
  expect(stream.observe("role", "document", 1)).toBe(true);
  expect(lane.classify(raced("Digit3"), keyup("Digit3"))).toBe("physical");
  expect(stream.begin("role", "document", raced("Digit3"))).toBe(lane);
  expect(stream.watermark("role", "document", 1)).toBe(true);
  expect(lane.classify(raced("Digit3"), keyup("Digit1"))).toBe("automatic");
  expect(stream.observe("role", "document", 3)).toBe(false);
  expect(stream.watermark("role", "document", 3)).toBe(false);
  expect(stream.begin("role", "new-document", before)).not.toBe(lane);
});

it("settles a physical release arriving under a completed different-key arm", () => {
  const stream = new ChromiumTrustedInputDocumentEvidence();
  const lane = stream.begin("role", "document", before);
  const released = { ...raced("ShiftLeft"), keyUpSequence: before.keyUpSequence };
  stream.arm("role", "old-arm", [keyup("Digit1")]);
  stream.late("role", { ...keyup("ShiftLeft"), inputSequence: "old-arm" }, released);
  expect(lane.pendingPhysicalCount(released, keyup("ShiftLeft"))).toBe(0n);
  expect(reconcileChromiumTrustedInputReceipts(lane, released, [keyup("ShiftLeft")], 0,
    [keyup("ShiftLeft")]).status).toBe("advanced");
});

it("does not reclassify a cancelled same-key automatic receipt as physical", () => {
  const stream = new ChromiumTrustedInputDocumentEvidence();
  stream.begin("role", "document", before);
  stream.arm("role", "old-arm", [keyup("Digit1")]);
  stream.late("role", { ...keyup("Digit1"), inputSequence: "old-arm" }, raced("Digit1"));
  expect(() => stream.begin("role", "document", raced("Digit1"))).toThrow("gap");
});

it("preserves the native watermark across document replacement on the same surface", () => {
  const stream = new ChromiumTrustedInputDocumentEvidence();
  const prior = { sequence: "128", targetReceivesPhysicalInput: true,
    keyboard: { sequence: "128", events: [] } };
  stream.begin("role", "old", prior);
  stream.retire("role", true);
  const next = { ...prior, sequence: "129", keyboard: { sequence: "129",
    events: Array.from({ length: 128 }, (_, index) => ({ sequence: String(index + 2),
      code: "Digit3", eventType: "keyup" as const, repeat: false, consumed: false })) } };
  const lane = stream.begin("role", "new", next, true);
  expect(stream.observe("role", "new", 1)).toBe(true);
  expect(lane.classify(next, keyup("Digit3"))).toBe("physical");
  expect(lane.pendingPhysicalCount(next, keyup("Digit3"))).toBe(0n);
  stream.retire("role", true);
  const replacement = { sequence: "1", targetReceivesPhysicalInput: true,
    keyboard: { sequence: "1", events: [{ ...next.keyboard.events[0]!, sequence: "1" }] } };
  expect(stream.begin("role", "replacement", replacement, true).classify(replacement,
    keyup("Digit3"))).toBe("physical");
});
