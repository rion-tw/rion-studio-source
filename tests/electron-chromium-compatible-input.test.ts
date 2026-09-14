import { describe, expect, it, vi } from "vitest";
import { ChromiumCompatibleInput } from "../src/electron/main/chromiumCompatibleInput";
import type { ChromiumCompatibleInputCommand, ChromiumCompatibleInputReceipt } from "../src/electron/ipc/chromiumCompatibleInputProtocol";
import type { ChromiumRoleOverlayFrameIdentity } from "../src/electron/main/chromiumRoleSurfaceRegistry";
import type { ChromiumNativeTrustedInputRequest } from "../src/electron/main/chromiumTrustedInputCoordinator";

const frame: ChromiumRoleOverlayFrameIdentity = {
  roleId: "role", generation: 1, frame: {}, frameToken: "frame", documentInstanceId: "document"
};
const request: ChromiumNativeTrustedInputRequest = {
  requestId: "request", roleId: "role", inputEpoch: 4, intent: "normal", scheduledAtMs: 1000,
  deadlineMs: 2000, surfaceGeneration: 1, expectedInputNeutralityBefore: true,
  expectedInputNeutralityAfter: false,
  action: { type: "key", code: "KeyJ", key: "J", modifiers: [], exactModifierCodes: [],
    phase: "hold", ownerId: "owner", modifierOwnership: "synthetic", suppressOverlayShortcut: true },
  keyEffect: { code: "KeyJ", phase: "rawKeyDown", autoRepeat: false, activeCodesBefore: [],
    activeCodes: ["KeyJ"], suppressShortcut: true }
};

function receipt(command: ChromiumCompatibleInputCommand): ChromiumCompatibleInputReceipt {
  return { requestId: command.requestId, ownerId: command.ownerId, roleId: command.roleId,
    inputEpoch: command.inputEpoch, generation: command.generation, frameToken: command.frameToken,
    documentInstanceId: command.documentInstanceId, sequence: command.sequence, targetToken: "canvas",
    isTrusted: false, eventCount: 1, status: "applied", errorCode: null };
}

describe.each(["darwin", "win32"] as const)("%s compatible input receipts", platform => {
  function setup(deliver: (command: ChromiumCompatibleInputCommand) => Promise<unknown>) {
    let deadline: () => void = () => undefined;
    const send = vi.fn((_frame: ChromiumRoleOverlayFrameIdentity, command: ChromiumCompatibleInputCommand) => deliver(command));
    const verifyHost = vi.fn();
    const lane = new ChromiumCompatibleInput({ platform, port: { dispatchCompatibleInput: send }, nowMs: () => 1100,
      timers: { setTimeout: callback => { deadline = callback; return 1; }, cancel: vi.fn() } });
    return { lane, send, verifyHost, expire: () => deadline(),
      dispatch: () => lane.dispatch(request, frame, [], null, verifyHost) };
  }

  it("accepts exact untrusted target delivery independently of physical/CDP receipts", async () => {
    const test = setup(async command => receipt(command));
    expect(await test.dispatch()).toMatchObject({ status: "applied", confirmedInputNeutrality: false });
    expect(test.verifyHost).toHaveBeenCalledTimes(2);
    expect(test.send.mock.calls[0]?.[1]).toMatchObject({ action: "key", ownerId: "owner", sequence: 1 });
    expect(await test.dispatch()).toMatchObject({ status: "applied" });
    expect(test.send.mock.calls[1]?.[1].sequence).toBe(2);
  });

  it.each(["requestId", "inputEpoch", "frameToken", "generation", "sequence", "eventCount", "isTrusted"])(
    "rejects an incorrect %s without accepting partial delivery", async field => {
      const test = setup(async command => ({ ...receipt(command), [field]: "wrong" }));
      expect(await test.dispatch()).toMatchObject({ status: "indeterminate", confirmedInputNeutrality: false });
    });

  it("does not accept a different target in the same live document", async () => {
    let count = 0;
    const test = setup(async command => ({ ...receipt(command), targetToken: ++count === 1 ? "original" : "replacement" }));
    expect((await test.dispatch()).status).toBe("applied");
    expect((await test.dispatch()).status).toBe("indeterminate");
  });

  it("terminalizes retirement immediately and ignores a late success", async () => {
    let resolve!: (value: unknown) => void;
    let pending!: ChromiumCompatibleInputCommand;
    const test = setup(command => { pending = command; return new Promise(done => { resolve = done; }); });
    const operation = test.dispatch();
    test.lane.retire("role");
    expect(await operation).toMatchObject({ status: "indeterminate", errorCode: "SYSTEM_COMPATIBLE_INPUT_DOCUMENT_SUPERSEDED" });
    resolve(receipt(pending));
    await Promise.resolve();
    expect(test.send).toHaveBeenCalledOnce();
  });

  it("deadline is indeterminate and never retries", async () => {
    const test = setup(() => new Promise(() => undefined));
    const operation = test.dispatch();
    test.expire();
    expect(await operation).toMatchObject({ status: "indeterminate", errorCode: "SYSTEM_COMPATIBLE_INPUT_RECEIPT_DEADLINE" });
    expect(test.send).toHaveBeenCalledOnce();
  });

  it("rejects a retired native host before submitting", async () => {
    const test = setup(async command => receipt(command));
    test.verifyHost.mockImplementation(() => { throw new Error("retired"); });
    expect(await test.dispatch()).toMatchObject({ status: "failed", confirmedInputNeutrality: true });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("rejects an overlapping request without losing the original retirement fence", async () => {
    const test = setup(() => new Promise(() => undefined));
    const first = test.dispatch();
    expect(await test.dispatch()).toMatchObject({ status: "failed", errorCode: "SYSTEM_COMPATIBLE_INPUT_LANE_BUSY" });
    test.lane.retire("role");
    expect(await first).toMatchObject({ status: "indeterminate", errorCode: "SYSTEM_COMPATIBLE_INPUT_DOCUMENT_SUPERSEDED" });
    expect(test.send).toHaveBeenCalledOnce();
  });

  it("never reports a key without a Core effect as successful readiness", async () => {
    const test = setup(async command => receipt(command));
    expect(await test.lane.dispatch({ ...request, keyEffect: undefined }, frame, [], null, test.verifyHost))
      .toMatchObject({ status: "failed", errorCode: "SYSTEM_COMPATIBLE_INPUT_INVALID" });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("cannot claim neutral failure after reporting a partial dispatch", async () => {
    const test = setup(async command => ({ ...receipt(command), status: "failed", errorCode: "SYSTEM_COMPATIBLE_INPUT_DELIVERY_FAILED" }));
    expect(await test.dispatch()).toMatchObject({ status: "indeterminate", confirmedInputNeutrality: false });
  });
});
