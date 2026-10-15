import { describe, expect, it, vi } from "vitest";
import { capturedWindowPlacement, expectPending, Fixture, target } from
  "./support/macosAppKitRuntimeHostFactoryFixtures";

const fence = { windowId: "window-1", windowGeneration: 1, topologyRevision: 4 };

async function stagedHost(presentation: "fullscreen" | "maximized") {
  const fixture = new Fixture();
  const host = await fixture.factory.createEmpty(target({ presentation }), {
    ...fence, attemptGeneration: "captured-placement"
  });
  host.applyAppKitPhaseProjection!({ ...fence,
    tabIds: [], hiddenTabIds: [], tabPhases: [] });
  await Promise.resolve();
  host.showInactive!();
  const native = fixture.windows[0]!;
  const queuedNormal = capturedWindowPlacement(fence.windowId, native);
  const completion = host.completeInitialPresentation!(fence);
  native.fullScreen = presentation === "fullscreen";
  native.maximized = presentation === "maximized";
  const readLayout = vi.spyOn(fixture.addon.controllers[0]!, "snapshotContentLayout");
  fixture.onAction.mockClear();
  fixture.onLayout.mockClear();
  return { fixture, host, native, queuedNormal, completion, readLayout };
}

describe("AppKit captured native placement acknowledgement", () => {
  it.each(["fullscreen", "maximized"] as const)(
    "ignores delayed normal and minimized callbacks despite current %s readback",
    async presentation => {
      const { fixture, host, native, queuedNormal, completion, readLayout } =
        await stagedHost(presentation);
      const submit = presentation === "fullscreen" ? "window-fullscreen-true" : "window-maximize";
      for (const action of [queuedNormal, {
        ...capturedWindowPlacement(fence.windowId, native),
        placementDiagnostics: { fullScreen: native.fullScreen,
          zoomed: native.maximized, minimized: true }
      }]) {
        fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action });
        await expectPending(completion);
        expect(readLayout).not.toHaveBeenCalled();
        expect(fixture.onAction).not.toHaveBeenCalled();
        expect(fixture.onLayout).not.toHaveBeenCalled();
      }
      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!,
        action: capturedWindowPlacement(fence.windowId, native) });
      await expect(completion).resolves.toBeUndefined();
      expect(readLayout).toHaveBeenCalled();
      expect(fixture.order.filter(value => value === submit)).toHaveLength(1);
      expect(fixture.onError).not.toHaveBeenCalled();
    }
  );

  it.each([
    { source: "other-window", state: { fullScreen: true, zoomed: false, minimized: false },
      code: "ELECTRON_MACOS_APPKIT_WINDOW_PLACEMENT_SOURCE_STALE" },
    { source: fence.windowId, state: undefined,
      code: "ELECTRON_MACOS_APPKIT_WINDOW_PLACEMENT_STATE_INVALID" },
    { source: fence.windowId, state: { fullScreen: true, zoomed: false },
      code: "ELECTRON_MACOS_APPKIT_WINDOW_PLACEMENT_STATE_INVALID" },
    { source: fence.windowId, state: { fullScreen: "true", zoomed: false, minimized: false },
      code: "ELECTRON_MACOS_APPKIT_WINDOW_PLACEMENT_STATE_INVALID" }
  ])("rejects invalid captured placement without a successful mode ACK: $code", async input => {
    const { fixture, host, completion, readLayout } = await stagedHost("fullscreen");
    fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
      type: "windowPlacementChanged", sourceWindowId: input.source,
      placementDiagnostics: input.state
    } });
    await expect(completion).rejects.toMatchObject({ code: input.code });
    expect(readLayout).not.toHaveBeenCalled();
    expect(fixture.onAction).not.toHaveBeenCalled();
    expect(fixture.order.filter(value => value === "window-fullscreen-true")).toHaveLength(1);
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({ code: input.code }));
  });
});
