import { describe, expect, it, vi } from "vitest";
import type { BrowserAction, BrowserActionRequest, EmbeddedKeyEffectRecord } from "../src/shared/generated";
import { ChromiumTrustedInputCoordinator, type ChromiumNativeTrustedInputRequest } from "../src/electron/main/chromiumTrustedInputCoordinator";

function setup(platform: "darwin" | "win32") {
  let document = "document-1";
  let sequence = 0;
  let held = new Set<string>();
  const pending = new Map<string, Set<string>>();
  const rejected = new Set(["Digit0", "Digit1", "pointer"]);
  const dispatch = vi.fn(async (r: ChromiumNativeTrustedInputRequest) => {
    const failed = rejected.has(r.keyEffect?.code ?? (r.action.type === "click" ? "pointer" : ""));
    return { requestId: r.requestId, roleId: r.roleId, inputEpoch: r.inputEpoch,
      surfaceGeneration: r.surfaceGeneration, completedAtMs: 1100,
      status: failed ? "indeterminate" as const : "applied" as const,
      errorCode: failed ? "SYSTEM_COMPATIBLE_INPUT_RECEIPT_MISMATCH" : null,
      errorMessage: failed ? "Receipt mismatch" : null,
      confirmedInputNeutrality: !failed && r.expectedInputNeutralityAfter };
  });
  const proof = vi.fn();
  const coordinator = new ChromiumTrustedInputCoordinator({ platform, nowMs: () => 1100,
    surfaces: { resolveInputSurface: roleId => ({ roleId, surfaceGeneration: 1, documentInstanceId: document, state: "active" }) },
    native: { dispatch }, onRecoveryProof: proof,
    embeddedInput: {
      prepare: async input => {
        const transitionId = `transition-${++sequence}`;
        pending.set(transitionId, new Set(held));
        const before = [...held];
        const effects: EmbeddedKeyEffectRecord[] = [];
        if (input.phase === "hold" || held.has(input.code)) {
          if (input.phase === "hold") held.add(input.code); else held.delete(input.code);
          effects.push({ phase: input.phase === "hold" ? "rawKeyDown" : "keyUp", code: input.code,
            activeCodesBefore: before, activeCodes: [...held], autoRepeat: false, suppressShortcut: true });
        }
        return { transitionId, effects, hasHeldKeys: held.size > 0 };
      },
      complete: async (id, succeeded) => {
        if (!succeeded) held = pending.get(id)!;
        pending.delete(id);
      },
      reassert: async () => ({ effects: [], hasHeldKeys: held.size > 0 }),
      clear: async () => { held.clear(); }
    }
  });
  const run = (id: string, action: BrowserAction, intent: "normal" | "cleanup" = "normal", epoch = 1) =>
    coordinator.execute({ requestId: id, roleId: "role", origin: "macro", inputEpoch: epoch,
      intent, scheduledAtMs: 1000, deadlineMs: 2000, action } satisfies BrowserActionRequest);
  return { run, rejected, dispatch, proof, coordinator, replaceDocument: () => { document = "document-2"; } };
}
const key = (code: string, phase: "hold" | "release" = "hold"): BrowserAction => ({ type: "key", code,
  key: code, phase, modifiers: [], exactModifierCodes: [], modifierOwnership: "synthetic",
  ownerId: "owner", suppressOverlayShortcut: true });
const uncertain = { code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" };
const blocked = { code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" };

describe.each(["darwin", "win32"] as const)("%s exact input neutrality", platform => {
  it("keeps the failed down and compensation quarantined across an empty Core cleanup and new epochs", async () => {
    const h = setup(platform);
    await expect(h.run("down", key("Digit0"))).rejects.toMatchObject(uncertain);
    expect(h.dispatch.mock.calls.map(([r]) => r.keyEffect?.phase)).toEqual(["rawKeyDown", "keyUp"]);
    await expect(h.run("empty-release", key("Digit0", "release"), "cleanup", 2)).rejects.toMatchObject(uncertain);
    await expect(h.run("unrelated", key("KeyZ", "release"), "cleanup", 3)).rejects.toMatchObject(uncertain);
    await expect(h.run("normal", { type: "focus" }, "normal", 4)).rejects.toMatchObject(blocked);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.proof).not.toHaveBeenCalled();
    await expect(h.run("recovery-fails", { type: "neutralizeInput" }, "cleanup", 4)).rejects.toMatchObject(uncertain);
    h.rejected.clear();
    await expect(h.run("exact-recovery", { type: "neutralizeInput" }, "cleanup", 4))
      .resolves.toMatchObject({ status: "applied", confirmedInputNeutrality: true });
    expect(h.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ intent: "cleanup", keyEffect: { code: "Digit0", phase: "keyUp" } });
    await expect(h.run("resumed", { type: "focus" }, "normal", 4)).resolves.toMatchObject({ status: "applied" });
  });

  it("retains only still-unconfirmed keys after partial authorized neutralization", async () => {
    const h = setup(platform);
    h.rejected.delete("Digit1");
    await h.run("held", key("Digit1"));
    await expect(h.run("down", key("Digit0"))).rejects.toMatchObject(uncertain);
    h.rejected.delete("Digit0"); h.rejected.add("Digit1");
    await expect(h.run("partial", { type: "neutralizeInput" }, "cleanup")).rejects.toMatchObject(uncertain);
    await expect(h.run("blocked", { type: "focus" })).rejects.toMatchObject(blocked);
    h.rejected.clear();
    const cursor = h.dispatch.mock.calls.length;
    await h.run("finish", { type: "neutralizeInput" }, "cleanup");
    expect(h.dispatch.mock.calls.slice(cursor).map(([r]) => r.keyEffect?.code)).toEqual(["Digit1"]);
  });

  it("retains partial compensation evidence without declaring an older uncertain key neutral", async () => {
    const h = setup(platform);
    await expect(h.run("down", key("Digit0"))).rejects.toMatchObject(uncertain);
    const dispatch = h.dispatch.getMockImplementation()!;
    h.dispatch.mockImplementationOnce(async request => ({ ...await dispatch(request),
      status: "indeterminate", confirmedInputNeutrality: false,
      errorCode: "SYSTEM_COMPATIBLE_INPUT_RECEIPT_MISMATCH" }));
    await expect(h.run("unrelated-compensation", key("KeyZ"), "cleanup"))
      .rejects.toMatchObject({ ...uncertain, confirmedInputNeutrality: false, quarantine: true });
    expect(h.proof).not.toHaveBeenCalled();
    h.rejected.clear();
    const cursor = h.dispatch.mock.calls.length;
    await h.run("finish", { type: "neutralizeInput" }, "cleanup");
    expect(h.dispatch.mock.calls.slice(cursor).map(([request]) => request.keyEffect?.code)).toEqual(["Digit0"]);
  });

  it("does not clear uncertain pointer delivery through a successful key cleanup", async () => {
    const h = setup(platform);
    await h.run("held", key("KeyJ"));
    await expect(h.run("click", { type: "click", anchor: null, unit: "px", x: 10, y: 10, button: "left" })).rejects.toMatchObject(uncertain);
    await expect(h.run("release", key("KeyJ", "release"), "cleanup")).rejects.toMatchObject(uncertain);
    expect(h.proof).not.toHaveBeenCalled();
    await expect(h.run("blocked", { type: "focus" })).rejects.toMatchObject(blocked);
    h.rejected.clear();
    await h.run("pointer-recovery", { type: "neutralizeInput" }, "cleanup");
    expect(h.dispatch.mock.calls.at(-1)?.[0].pointerReleaseOnly).toBe(true);
  });

  it("never directs old uncertain releases into a replacement document", async () => {
    const h = setup(platform);
    await expect(h.run("down", key("Digit0"))).rejects.toMatchObject(uncertain);
    h.replaceDocument(); h.rejected.clear();
    await expect(h.run("release", key("Digit0", "release"), "cleanup")).rejects.toMatchObject(blocked);
    await expect(h.run("neutralize", { type: "neutralizeInput" }, "cleanup")).rejects.toMatchObject(blocked);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.proof).not.toHaveBeenCalled();
  });

  it("rejects an explicitly stale recovery document even when the live lane has not changed", async () => {
    const h = setup(platform);
    await expect(h.run("down", key("Digit0"))).rejects.toMatchObject(uncertain);
    await expect(h.coordinator.execute({ requestId: "stale-recovery", roleId: "role", origin: "macro",
      inputEpoch: 2, intent: "cleanup", scheduledAtMs: 1000, deadlineMs: 2000,
      surfaceGeneration: 1, documentInstanceId: "other-document", action: { type: "neutralizeInput" } }))
      .rejects.toMatchObject({ code: "BROWSER_ACTION_STALE" });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
});
