import { describe, expect, it } from "vitest";

import { ChromiumPhysicalInputEvidenceLane } from
  "../src/electron/main/chromiumPhysicalInputEvidence";

describe("Chromium native physical-input evidence", () => {
  it("consumes one native projection per physical DOM observation", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "7",
      targetReceivesPhysicalInput: true
    });
    expect(lane.classify({ sequence: "9", targetReceivesPhysicalInput: true }))
      .toBe("physical");
    expect(lane.classify({ sequence: "9", targetReceivesPhysicalInput: true }))
      .toBe("physical");
    expect(lane.classify({ sequence: "9", targetReceivesPhysicalInput: true }))
      .toBe("automatic");
  });

  it("ignores a foreground journal for a hidden/background Role", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "3",
      targetReceivesPhysicalInput: false
    });
    expect(lane.classify({ sequence: "20", targetReceivesPhysicalInput: false }))
      .toBe("automatic");
  });

  it("does not attribute a raced physical keyup to an automatic keydown", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "4",
      keyDownSequence: "2",
      keyUpSequence: "2",
      targetReceivesPhysicalInput: true
    });
    const raced = {
      sequence: "5",
      keyDownSequence: "2",
      keyUpSequence: "3",
      targetReceivesPhysicalInput: true
    };
    expect(lane.classify(raced, { code: "KeyY", type: "keydown" }))
      .toBe("automatic");
    expect(lane.classify(raced, { code: "KeyY", type: "keyup" }))
      .toBe("physical");
  });

  it("retains total-cursor classification for an interleaved modifier edge", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "8",
      keyDownSequence: "3",
      keyUpSequence: "3",
      targetReceivesPhysicalInput: true
    });
    expect(lane.classify({
      sequence: "9",
      keyDownSequence: "3",
      keyUpSequence: "3",
      targetReceivesPhysicalInput: true
    }, { code: "Digit4", type: "keyup" })).toBe("physical");
  });

  it("fails closed for malformed or regressed native sequences", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "5",
      targetReceivesPhysicalInput: true
    });
    expect(lane.classify({ sequence: "4", targetReceivesPhysicalInput: true }))
      .toBe("indeterminate");
    expect(lane.classify({ sequence: "01", targetReceivesPhysicalInput: true }))
      .toBe("indeterminate");
    expect(() => new ChromiumPhysicalInputEvidenceLane({
      sequence: "1",
      keyDownSequence: "2",
      keyUpSequence: "0",
      targetReceivesPhysicalInput: true
    })).toThrow("malformed");
  });
});
