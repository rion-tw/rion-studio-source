import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { verifyAppKitResizeDiagnosticCarrier } from "../scripts/verifyAppKitResizeDiagnosticCarrier.mjs";

const hookInstallation = ["windowWillResize:toSize:", "constrainFrameRect:toScreen:",
  "setFrame:display:", "nextEventMatchingMask:untilDate:inMode:dequeue:"].map((selector) => ({
  selector, wrappedClass: "FixtureClass", definingClass: "FixtureClass", status: "installed"
}));

function artifact() {
  const identity = { logicalWindowId: "window-1", launchGeneration: "launch-1", nativeGeneration: 1 };
  return { journalVersion: 1, nativeCapacity: 128, ownerCapacity: 32,
    droppedOwners: 0, captureErrors: 0, flushStage: "will-quit", snapshots: [{
      identity, callbackIdentity: { ...identity }, callbackType: "windowPlacementChanged",
      sourceWindowMatches: true, callbackIdentityMatches: true, currentNativeHandleMatches: true,
      currentWindowPointerMatches: true, parentNativeHostId: 8, originalNativeHandle: "3412000000000000",
      originalWindowPointer: "0x1234", journal: { journalVersion: 1, capacity: 128,
        sequence: 140, dropped: 12, records: Array.from({ length: 128 }, (_, index) => ({
          sequence: index + 13, windowID: "window-1", windowPointer: "0x1234", hookInstallation
        })) }
    }] };
}

describe("terminal AppKit resize diagnostic channel proof", () => {
  function metadata() {
    return { viewCapacity: 8, constraintCapacityPerView: 24, omittedConstraints: 0, omittedChildReferences: 0,
      views: [{ hidden: false, superviewPointer: "0x4567", omittedConstraints: 0, constraints: [{
        constraintClass: "NSAutoresizingMaskLayoutConstraint", identifier: "鍵".repeat(32),
        identifierByteCapacity: 96, identifierTruncated: true
      }] }] };
  }

  it("reports actual bounded constraint metadata and serialized journal sizes", () => {
    const value = artifact();
    value.snapshots[0].journal.records.at(-1).existingViewConstraints = metadata();
    const result = verifyAppKitResizeDiagnosticCarrier(value).viewMetadataWitnesses[0];
    expect(result.journalBytes).toBe(Buffer.byteLength(JSON.stringify(value.snapshots[0].journal), "utf8"));
    expect(result.bookends).toEqual([{ sequence: 140, reason: undefined,
      bytes: Buffer.byteLength(JSON.stringify(metadata()), "utf8"), views: 1, constraints: 1,
      omittedConstraints: 0, omittedChildReferences: 0 }]);
  });

  it.each(["too-many-constraints", "identifier-bytes", "unknown-hidden", "missing-class", "getter-error"])(
    "refuses %s view metadata", (kind) => {
      const value = artifact();
      const current = metadata();
      if (kind === "too-many-constraints") current.views[0].constraints = Array.from({ length: 25 }, () => current.views[0].constraints[0]);
      if (kind === "identifier-bytes") current.views[0].constraints[0].identifier += "鍵";
      if (kind === "unknown-hidden") delete current.views[0].hidden;
      if (kind === "missing-class") delete current.views[0].constraints[0].constraintClass;
      value.snapshots[0].journal.records.at(-1).existingViewConstraints = kind === "getter-error"
        ? { error: "existing-view-getter-failed" } : current;
      expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow("constraint metadata");
    });

  it("accepts a bounded retained native tail and reports its explicit truncation", () => {
    expect(verifyAppKitResizeDiagnosticCarrier(artifact())).toMatchObject({
      populatedOwners: 1, records: 128, nativeDropped: 12, droppedOwners: 0
    });
  });

  it("reports installed hooks without requiring AppKit to call any selector", () => {
    expect(verifyAppKitResizeDiagnosticCarrier(artifact()).methodWitnesses).toEqual([{
      windowId: "window-1", installation: hookInstallation,
      returned: Object.fromEntries(hookInstallation.map(({ selector }) => [selector, 0]))
    }]);
  });

  it("reports an unsupported optional delegate without claiming a native proposal", () => {
    const value = artifact();
    value.snapshots[0].journal.records.at(-1).hookInstallation = hookInstallation.map((entry, index) => index
      ? entry : { ...entry, wrappedClass: "", definingClass: "", status: "unsupported", reason: "method-absent" });
    expect(verifyAppKitResizeDiagnosticCarrier(value).methodWitnesses[0].installation[0].status).toBe("unsupported");
  });

  it.each(["missing", "error", "unknown", "missing-selector"]) ("refuses %s hook setup evidence", (kind) => {
    const value = artifact();
    const last = value.snapshots[0].journal.records.at(-1);
    last.hookInstallation = hookInstallation.map((entry) => ({ ...entry }));
    if (kind === "missing") delete last.hookInstallation;
    if (kind === "error") Object.assign(last.hookInstallation[0], { status: "error", reason: "installation-exception" });
    if (kind === "unknown") last.hookInstallation[0].status = "unknown";
    if (kind === "missing-selector") last.hookInstallation[0] = { ...last.hookInstallation[1] };
    expect(() => verifyAppKitResizeDiagnosticCarrier(value)).toThrow("hook installation");
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
