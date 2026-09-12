import type { ChromiumNativeTrustedInputRequest, ChromiumNativeTrustedInputReceipt } from "../src/electron/main/chromiumTrustedInputCoordinator";
import { describe, expect, it, vi } from "vitest";
import type { ChromiumViewInputObservation } from "../src/electron/main/chromiumViewInputSubmission";
import { ChromiumViewTrustedInputHost } from "../src/electron/main/chromiumViewTrustedInputHost";

function fixture(_platform: "macos" | "windows") {
  const identity = { roleId: "role-one", surfaceGeneration: 1, nativeGeneration: 2,
    bindingRevision: "3", parentIdentity: "a".repeat(64), webContentsId: 4 };
  let observation: ChromiumViewInputObservation = { identity, focusIdentity: "b".repeat(64),
    physicalInputSequence: "0",
    parentForeground: true, parentVisible: true, parentMinimized: false,
    viewAttached: true, viewVisible: false, contentsDestroyed: false, contentsFocused: false,
    focusedWebContentsId: 5, bounds: { x: 0, y: 0, width: 300, height: 200 }, zoomFactor: 1.25 };
  const contents = { sendInputEvent: vi.fn() };
  const input = Object.freeze({ owner: "role-one" });
  const attachment = { identity, input, observe: () => observation };
  let current = true;
  const host = new ChromiumViewTrustedInputHost({ attachments: { resolve: () => current ? attachment : null },
    focus: vi.fn(async (request: ChromiumNativeTrustedInputRequest): Promise<ChromiumNativeTrustedInputReceipt> => ({ requestId: request.requestId, roleId: request.roleId,
      surfaceGeneration: request.surfaceGeneration, inputEpoch: request.inputEpoch, status: "applied",
      completedAtMs: 100, errorCode: null, errorMessage: null, confirmedInputNeutrality: true })) });
  return { host, contents, retire: () => { current = false; },
    change: (patch: Partial<ChromiumViewInputObservation>) => { observation = { ...observation, ...patch }; } };
}

describe.each(["macos", "windows"] as const)("%s View trusted-input host bridge", platform => {
  it("admits a visible sibling through the same exact foreground receipt lane", () => {
    const f = fixture(platform);
    f.change({ viewVisible: true });
    const { native, identity } = f.host.resolve("role-one", 1)!;
    expect(native.currentInputDeliveryMode(identity)).toBe("foreground");
    const receipt = native.probeExactInputSurface(identity, "foreground");
    expect(receipt).toMatchObject({ deliveryMode: "foreground",
      observation: { viewVisible: true, contentsFocused: false, focusedWebContentsId: 5 } });
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])("admits an unfocused parent with visible=%s through the exact host", viewVisible => {
    const f = fixture(platform);
    f.change({ parentForeground: false, viewVisible, focusedWebContentsId: 1 });
    const { native, identity } = f.host.resolve("role-one", 1)!;
    const deliveryMode = viewVisible ? "foreground" : "background";
    expect(native.currentInputDeliveryMode(identity)).toBe(deliveryMode);
    expect(native.probeExactInputSurface(identity, deliveryMode))
      .toMatchObject({ observation: { parentForeground: false, focusedWebContentsId: 1 } });
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("keeps stable binding identity and emits the actual engine owner's observation", () => {
    const f = fixture(platform);
    const binding = f.host.resolve("role-one", 1)!;
    expect(f.host.resolve("role-one", 1)).toBe(binding);
    const probe = binding.native.probeExactInputSurface(binding.identity, "background");
    expect(probe).toMatchObject({ ownerKind: "view",
      observation: probe.ownerKind === "view" ? probe.observation : undefined });
    expect(probe).not.toHaveProperty("submissionApi");
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
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
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("rejects changed View identities and hidden focus before engine submission", () => {
    const f = fixture(platform);
    const { native, identity } = f.host.resolve("role-one", 1)!;
    if (identity.ownerKind !== "view") throw new Error("Expected View identity.");
    expect(() => native.probeExactInputSurface(
      { ...identity, webContentsId: 6 }, "background"
    )).toThrow();
    f.change({ contentsFocused: true });
    expect(native.currentInputDeliveryMode(identity)).toBeNull();
    expect(f.contents.sendInputEvent).not.toHaveBeenCalled();
  });
});
