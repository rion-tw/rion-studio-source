import { describe, expect, it } from "vitest";
import { validateCompatibleInputReceipt as validate } from "../src/electron/main/chromiumCompatibleInputValidation";
import type { ChromiumCompatibleInputCommand as Command } from "../src/electron/ipc/chromiumCompatibleInputProtocol";
import { compatibleModifierEvidenceForTest } from "./helpers/compatibleInputReceipt";
const command: Command = { requestId: "request", ownerId: "owner", roleId: "role", inputEpoch: 1, generation: 1,
  frameToken: "frame", documentInstanceId: "document", sequence: 1, deadlineMs: 2000, intent: "normal", action: "key",
  key: { type: "rawKeyDown", code: "Digit0", key: "0", modifiers: 0, location: 0, windowsVirtualKeyCode: 48, autoRepeat: false },
  modifierState: { coreCodesBefore: [], coreCodesAfter: [], nativePhysicalCodes: [] } };
const fence = { nowMs: 1100, documentCurrent: true, target: "original" };
const receipt = () => ({ ...command, ...compatibleModifierEvidenceForTest(command), targetToken: "original",
  status: "applied", eventCount: 1, errorCode: null, isTrusted: false });

describe("bounded compatible receipt failure classification", () => {
  it.each(["requestId", "ownerId", "roleId", "inputEpoch", "generation", "frameToken", "documentInstanceId", "sequence"])(
    "identifies exact %s mismatches", field => {
      expect(validate(command, { ...receipt(), [field]: "wrong" }, fence).validation)
        .toMatchObject({ reason: "identity", field, received: "wrong", reportedEventCount: 1 });
    });
  it.each([
    ["target", { targetToken: "other" }], ["target", { targetToken: null }],
    ["trust", { isTrusted: true }], ["status", { status: "success" }],
    ["status", { errorCode: "ERROR" }], ["event-count", { eventCount: -1 }],
    ["event-count", { eventCount: 2 }], ["event-count", { status: "failed", eventCount: 1 }],
    ["modifier-snapshot", { modifierEvidence: undefined }],
    ["modifier-snapshot", { modifierEvidence: { ...receipt().modifierEvidence, coreCodesAfter: ["AltLeft"] } }],
    ["modifier-history", { modifierEvidence: { ...receipt().modifierEvidence, transitions: [null] } }],
    ["modifier-history", { modifierEvidence: { ...receipt().modifierEvidence, transitions: Array(65).fill(null) } }],
    ["modifier-snapshot", { modifierEvidence: { ...receipt().modifierEvidence, eventModifierMask: 12 } }]
  ])("classifies %s without accepting a claimed applied event", (reason, change) => {
    const result = validate(command, { ...receipt(), ...change as object }, fence);
    expect(result.receipt).toBeUndefined();
    expect(result.validation?.reason).toBe(reason);
  });
  it("distinguishes deadline and document fences", () => {
    expect(validate(command, receipt(), { ...fence, nowMs: 2000 }).validation?.reason).toBe("deadline");
    expect(validate(command, receipt(), { ...fence, documentCurrent: false }).validation?.reason).toBe("document");
  });
  it("reports the root event count field and invalid ownership dispositions", () => {
    expect(validate(command, { ...receipt(), eventCount: 0 }, fence).validation)
      .toMatchObject({ reason: "event-count", field: "eventCount", expected: "1", received: "0" });
    expect(validate(command, { ...receipt(), modifierEvidence: {
      ...receipt().modifierEvidence, disposition: "releaseOwnership" } }, fence).validation)
      .toMatchObject({ reason: "modifier-disposition", field: "modifierEvidence.disposition" });
  });
  it.each([
    ["sequence", 0], ["source", "unknown"], ["phase", "keypress"], ["disposition", "unknown"],
    ["code", "KeyJ"], ["coreCodes", ["AltLeft", "AltLeft"]], ["physicalCodes", ["KeyJ"]], ["eventModifierMask", 16]
  ])("identifies malformed history %s", (field, value) => {
    const transition = { sequence: 1, source: "physical", code: "AltLeft", phase: "rawKeyDown",
      disposition: "dispatch", coreCodes: [], physicalCodes: ["AltLeft"], eventModifierMask: 1, [field as string]: value };
    expect(validate(command, { ...receipt(), modifierEvidence: {
      ...receipt().modifierEvidence, transitions: [transition] } }, fence).validation)
      .toMatchObject({ reason: "modifier-history", field: `modifierEvidence.transitions[0].${field}` });
  });
  it.each([null, [], "text", 42])("rejects malformed top-level receipts: %s", raw => {
    expect(validate(command, raw, fence).validation?.reason).toBe("shape");
  });
  it("bounds scalar summaries and never serializes arbitrary rejected objects", () => {
    const result = validate(command, { ...receipt(), requestId: "x".repeat(4000) }, fence);
    expect(result.validation?.received).toHaveLength(160);
    const object = validate(command, { ...receipt(), requestId: { secret: "page content" } }, fence);
    expect(object.validation?.received).toBe("<object>");
    expect(JSON.stringify(object)).not.toContain("page content");
  });
  it("preserves a valid explicit target failure rather than masking it as a mismatch", () => {
    const result = validate(command, { ...receipt(), modifierEvidence: undefined, eventCount: 0,
      status: "failed", errorCode: "SYSTEM_COMPATIBLE_INPUT_TARGET_UNAVAILABLE" }, fence);
    expect(result.receipt?.errorCode).toBe("SYSTEM_COMPATIBLE_INPUT_TARGET_UNAVAILABLE");
  });
});
