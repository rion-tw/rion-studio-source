import type { ChromiumNativeTrustedInputRequest, ChromiumNativeTrustedInputReceipt } from "../src/electron/main/chromiumTrustedInputCoordinator";
import { describe, expect, it, vi } from "vitest";
import { ChromiumViewInputSubmission, type ChromiumViewInputObservation } from "../src/electron/main/chromiumViewInputSubmission";
import { ChromiumViewTrustedInputHost } from "../src/electron/main/chromiumViewTrustedInputHost";

function fixture(platform: "macos" | "windows") {
  const identity = { roleId: "role-one", surfaceGeneration: 1, nativeGeneration: 2,
    bindingRevision: "3", parentIdentity: "a".repeat(64), webContentsId: 4 };
  let observation: ChromiumViewInputObservation = { identity, focusIdentity: "b".repeat(64),
    parentForeground: true, parentVisible: true, parentMinimized: false,
    viewAttached: true, viewVisible: false, contentsDestroyed: false, contentsFocused: false,
    focusedWebContentsId: 5, bounds: { x: 0, y: 0, width: 300, height: 200 }, zoomFactor: 1.25 };
  const contents = { id: 4, isDestroyed: () => false, sendInputEvent: vi.fn() };
  const input = new ChromiumViewInputSubmission({ identity, contents, observe: () => observation, nowMs: () => 100 });
  const attachment = { identity, input, observe: () => observation };
  let current = true;
  const host = new ChromiumViewTrustedInputHost({ attachments: { resolve: () => current ? attachment : null },
    focus: vi.fn(async (request: ChromiumNativeTrustedInputRequest): Promise<ChromiumNativeTrustedInputReceipt> => ({ requestId: request.requestId, roleId: request.roleId,
      surfaceGeneration: request.surfaceGeneration, inputEpoch: request.inputEpoch, status: "applied",
      completedAtMs: 100, errorCode: null, errorMessage: null, confirmedInputNeutrality: true })) });
  const key = { roleId: "role-one", surfaceGeneration: 1, requestId: "key", inputEpoch: "7", deadlineMs: "200",
    deliveryMode: "background" as const, code: "KeyA", eventType: "keyDown" as const,
    ctrl: platform === "windows", meta: platform === "macos", shift: false, alt: false, repeat: false as const };
  return { host, contents, key, retire: () => { current = false; },
    change: (patch: Partial<ChromiumViewInputObservation>) => { observation = { ...observation, ...patch }; } };
}

describe.each(["macos", "windows"] as const)("%s View trusted-input host bridge", platform => {
  it("admits a visible sibling through the same exact foreground receipt lane", () => {
    const f = fixture(platform);
    f.change({ viewVisible: true });
    const { native, identity } = f.host.resolve("role-one", 1)!;
    expect(native.currentInputDeliveryMode(identity)).toBe("foreground");
    const receipt = native.submitNativeBackgroundKey(identity, { ...f.key, deliveryMode: "foreground" });
    expect(receipt).toMatchObject({ deliveryMode: "foreground",
      observation: { viewVisible: true, contentsFocused: false, focusedWebContentsId: 5 } });
    expect(f.contents.sendInputEvent).toHaveBeenCalledOnce();
  });

  it("keeps stable binding identity and emits the actual engine owner's observation", () => {
    const f = fixture(platform);
    const binding = f.host.resolve("role-one", 1)!;
    expect(f.host.resolve("role-one", 1)).toBe(binding);
    const probe = binding.native.probeExactInputSurface(binding.identity, "background");
    const receipt = binding.native.submitNativeBackgroundKey(binding.identity, f.key);
    expect(receipt).toMatchObject({ ownerKind: "view", probeRevision: probe.probeRevision,
      observation: probe.ownerKind === "view" ? probe.observation : undefined,
      submissionApi: "webContents.sendInputEvent", dispatchedEventCount: 1 });
    expect(receipt).not.toHaveProperty("surfaceHandleToken");
    expect(f.contents.sendInputEvent).toHaveBeenCalledTimes(1);
  });

  it("advances the probe fence only when exact observed facts change", () => {
    const f = fixture(platform);
    const { native, identity } = f.host.resolve("role-one", 1)!;
    const first = native.probeExactInputSurface(identity, "background");
    expect(native.probeExactInputSurface(identity, "background").probeRevision).toBe(first.probeRevision);
    f.change({ bounds: { x: 20, y: 0, width: 300, height: 200 } });
    const second = native.probeExactInputSurface(identity, "background");
    expect(BigInt(second.probeRevision)).toBeGreaterThan(BigInt(first.probeRevision));
    if (first.ownerKind !== "view") throw new Error("Expected View proof.");
    expect(first.observation.bounds.x).toBe(0);
  });

  it("revokes a previously resolved host when the attachment retires", () => {
    const f = fixture(platform);
    const { native, identity } = f.host.resolve("role-one", 1)!;
    f.retire();
    expect(f.host.resolve("role-one", 1)).toBeNull();
    expect(native.isInputReady(identity, "background")).toBe(false);
    expect(() => native.submitNativeBackgroundKey(identity, f.key)).toThrow();
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("rejects changed View identities and hidden focus before engine submission", () => {
    const f = fixture(platform);
    const { native, identity } = f.host.resolve("role-one", 1)!;
    if (identity.ownerKind !== "view") throw new Error("Expected View identity.");
    expect(() => native.submitNativeBackgroundKey({ ...identity, webContentsId: 6 }, f.key)).toThrow();
    f.change({ contentsFocused: true });
    expect(native.currentInputDeliveryMode(identity)).toBeNull();
    expect(() => native.submitNativeBackgroundKey(identity, f.key)).toThrow();
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });
});
