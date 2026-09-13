import { describe, expect, it, vi } from "vitest";
import { recoverChromiumKeySequence } from "../src/electron/main/chromiumTrustedInputSequenceRecovery";
import { RionBridgeError } from "../src/electron/ipc/errors";

describe("sequence recovery evidence", () => {
  it("preserves original, compensation and rollback failures independently", async () => {
    const cause = { code: "CDP_DETACHED", message: "original submission lost" };
    const compensationError = { code: "DOCUMENT_REPLACED", message: "old keyup target absent" };
    const rollbackError = { code: "CORE_STREAM_FAILED", message: "rollback acknowledgement absent" };
    const rollback = vi.fn(async () => { throw new RionBridgeError(rollbackError); });
    expect(await recoverChromiumKeySequence({
      cause, transitionId: "transition-1", confirmedEffects: [], failedEffect: null, edges: [],
      compensate: async () => { throw new RionBridgeError(compensationError); }, rollback
    })).toEqual({
      cause, transitionId: "transition-1", confirmedEffectCount: 0, confirmedEffects: [], failedEffect: null,
      compensationSucceeded: false, rollbackSucceeded: false, compensationError, rollbackError
    });
    expect(rollback).toHaveBeenCalledWith("transition-1");
  });
});
