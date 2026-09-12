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

  it("fails closed for malformed or regressed native sequences", () => {
    const lane = new ChromiumPhysicalInputEvidenceLane({
      sequence: "5",
      targetReceivesPhysicalInput: true
    });
    expect(lane.classify({ sequence: "4", targetReceivesPhysicalInput: true }))
      .toBe("indeterminate");
    expect(lane.classify({ sequence: "01", targetReceivesPhysicalInput: true }))
      .toBe("indeterminate");
  });
});
