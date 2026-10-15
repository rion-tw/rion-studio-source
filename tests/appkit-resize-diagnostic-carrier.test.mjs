import { describe, expect, it } from "vitest";
import { verifyAppKitResizeDiagnosticCarrier } from "../scripts/verifyAppKitResizeDiagnosticCarrier.mjs";

function artifact() {
  const identity = { logicalWindowId: "window-1", launchGeneration: "launch-1", nativeGeneration: 1 };
  return { journalVersion: 1, nativeCapacity: 128, ownerCapacity: 32,
    droppedOwners: 0, captureErrors: 0, flushStage: "will-quit", snapshots: [{
      identity, callbackIdentity: { ...identity }, callbackType: "windowPlacementChanged",
      sourceWindowMatches: true, callbackIdentityMatches: true, currentNativeHandleMatches: true,
      currentWindowPointerMatches: true, parentNativeHostId: 8, originalNativeHandle: "3412000000000000",
      originalWindowPointer: "0x1234", journal: { journalVersion: 1, capacity: 128,
        sequence: 140, dropped: 12, records: Array.from({ length: 128 }, (_, index) => ({
          sequence: index + 13, windowID: "window-1", windowPointer: "0x1234"
        })) }
    }] };
}

describe("terminal AppKit resize diagnostic channel proof", () => {
  it("accepts a bounded retained native tail and reports its explicit truncation", () => {
    expect(verifyAppKitResizeDiagnosticCarrier(artifact())).toEqual({
      populatedOwners: 1, records: 128, nativeDropped: 12, droppedOwners: 0
    });
  });

  it.each(["missing", "empty", "capture-failed", "oversized"]) ("refuses %s channel output", (kind) => {
    const value = artifact();
    if (kind === "missing") delete value.snapshots;
    if (kind === "empty") value.snapshots = [];
    if (kind === "capture-failed") value.captureErrors = 1;
    if (kind === "oversized") value.snapshots[0].journal.records.push({ sequence: 141 });
    expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow();
  });

  it.each(["sourceWindowMatches", "callbackIdentityMatches", "currentNativeHandleMatches",
    "currentWindowPointerMatches"]) ("refuses a lost %s fence", (field) => {
    const value = artifact();
    value.snapshots[0][field] = false;
    expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow("exact attached owner");
  });

  it.each(["callback-owner", "record-owner", "record-pointer", "duplicate-sequence", "missing-tail"]) (
    "refuses %s evidence", (kind) => {
      const value = artifact();
      const snapshot = value.snapshots[0];
      if (kind === "callback-owner") snapshot.callbackIdentity.nativeGeneration = 2;
      if (kind === "record-owner") snapshot.journal.records[0].windowID = "other";
      if (kind === "record-pointer") snapshot.journal.records[0].windowPointer = "0x5678";
      if (kind === "duplicate-sequence") snapshot.journal.records[1].sequence = 13;
      if (kind === "missing-tail") snapshot.journal.sequence++;
      expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow();
    });

  it("does not hide a malformed entry behind a second valid populated owner", () => {
    const value = artifact();
    value.snapshots.push({ journal: null });
    expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow("malformed snapshot");
  });
});
