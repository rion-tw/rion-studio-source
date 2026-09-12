import { beforeEach, describe, expect, it } from "vitest";

import {
  recentTrustedInputTerminals,
  recordTrustedInputTerminal,
  resetTrustedInputTerminalJournalForTest
} from "../src/electron/main/chromiumTrustedInputTerminalJournal";

function record(requestId: string, intent: "normal" | "cleanup" = "normal") {
  return {
    capturedAt: "2026-09-13T00:00:00.000Z",
    requestId,
    roleId: "role-1",
    inputEpoch: 4,
    surfaceGeneration: 7,
    intent,
    cdpSubmissionCertainty: "possibly-submitted" as const,
    physicalInterleave: "same-identity" as const,
    terminalCode: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
    cleanupOutcome: intent === "cleanup" ? "neutral" as const : "not-attempted" as const,
    recoveryOutcome: intent === "cleanup" ? "cleanup-neutral" as const : "restart-required" as const
  };
}

describe("Chromium trusted-input terminal journal", () => {
  beforeEach(() => resetTrustedInputTerminalJournalForTest());

  it("retains only bounded relation-level evidence", () => {
    for (let index = 0; index < 130; index += 1) {
      recordTrustedInputTerminal(record(`request-${index}`));
    }

    const recent = recentTrustedInputTerminals();
    expect(recent).toHaveLength(128);
    expect(recent[0]?.requestId).toBe("request-2");
    expect(recent.at(-1)).toEqual(record("request-129"));
    expect(JSON.stringify(recent)).not.toContain("text");
  });

  it("joins an exact cleanup outcome to its original terminal record", () => {
    recordTrustedInputTerminal(record("request-1"));
    recordTrustedInputTerminal(record("request-1", "cleanup"));

    expect(recentTrustedInputTerminals()).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        intent: "normal",
        cleanupOutcome: "neutral",
        recoveryOutcome: "cleanup-neutral"
      }),
      record("request-1", "cleanup")
    ]);
  });
});
