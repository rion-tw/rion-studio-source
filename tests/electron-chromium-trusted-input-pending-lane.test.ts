import { describe, expect, it, vi } from "vitest";
import { ChromiumTrustedInputPendingLane, sameTrustedInputFrame,
  type PendingChromiumTrustedInput } from "../src/electron/main/chromiumTrustedInputPendingLane";

function pending(requestId: string, generation = 1): PendingChromiumTrustedInput {
  return {
    request: { requestId, roleId: "role", inputEpoch: 1, intent: "normal",
      scheduledAtMs: 1, deadlineMs: 100, surfaceGeneration: generation,
      expectedInputNeutralityBefore: true, expectedInputNeutralityAfter: true,
      action: { type: "focus" } },
    frame: { roleId: "role", generation, frame: {}, frameToken: "frame-token",
      documentInstanceId: "document" },
    inputSequence: requestId, completion: { resolve: vi.fn() }, timer: {},
    nativeInvoked: false, nativeComplete: false, nextDomIndex: 0,
    expectedEvents: [{}], terminal: false
  };
}

describe.each(["macos", "windows"] as const)("%s shared trusted-input pending owner", () => {
  it("retains a new request across reentrant cancellation and duplicate old completion", () => {
    const first = pending("first");
    const next = pending("next", 2);
    const lane = new ChromiumTrustedInputPendingLane({ nowMs: () => 5,
      cancelDeadline: () => { expect(lane.add(next)).toBe(true); throw new Error("cancel failed"); },
      sendCancel: vi.fn() });
    expect(lane.add(first)).toBe(true);
    expect(lane.add(pending("duplicate"))).toBe(false);
    lane.finish(first, "superseded", null, null, true);
    lane.finish(first, "applied", null, null, true);
    expect(first.completion.resolve).toHaveBeenCalledOnce();
    expect(lane.forRole("role")).toBe(next);
    expect(lane.forRequest("first")).toBeUndefined();
    expect(lane.forRequest("next")).toBe(next);
  });

  it.each([false, true])("fences retirement by generation and preserves native uncertainty: %s", (invoked) => {
    const active = pending("active");
    active.nativeInvoked = invoked;
    const sendCancel = vi.fn(() => { throw new Error("frame retired"); });
    const lane = new ChromiumTrustedInputPendingLane({ nowMs: () => 10,
      cancelDeadline: vi.fn(), sendCancel });
    lane.add(active);
    lane.surfaceChanged({ roleId: "role", generation: 2, reason: "surface-retired" });
    expect(active.completion.resolve).not.toHaveBeenCalled();
    lane.surfaceChanged({ roleId: "role", generation: 1, reason: "document-superseded" });
    expect(active.completion.resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: invoked ? "indeterminate" : "superseded", confirmedInputNeutrality: !invoked
    }));
    expect(sendCancel).toHaveBeenCalledWith(active.frame, expect.objectContaining({
      generation: 1, inputSequence: "active", frameToken: "frame-token"
    }));
    expect(lane.values()).toEqual([]);
  });

  it("requires both native completion and the entire authenticated DOM sequence", () => {
    const active = pending("active");
    const sendCancel = vi.fn();
    const lane = new ChromiumTrustedInputPendingLane({ nowMs: () => 10,
      cancelDeadline: vi.fn(), sendCancel });
    lane.add(active);
    active.nativeComplete = true;
    lane.maybeApply(active);
    expect(active.completion.resolve).not.toHaveBeenCalled();
    active.nextDomIndex = 1;
    lane.maybeApply(active);
    expect(active.completion.resolve).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }));
    expect(sendCancel).not.toHaveBeenCalled();
    expect(lane.busy("role", "active")).toBe(false);
  });

  it("requires the exact frame handle and document token", () => {
    const frame = pending("active").frame;
    expect(sameTrustedInputFrame(frame, { ...frame })).toBe(true);
    expect(sameTrustedInputFrame(frame, { ...frame, frame: {} })).toBe(false);
    expect(sameTrustedInputFrame(frame, { ...frame, documentInstanceId: "new" })).toBe(false);
  });
});
