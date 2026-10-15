import { describe, expect, it, vi } from "vitest";
import {
  expectPending, Fixture, target
} from "./support/macosAppKitRuntimeHostFactoryFixtures";

const fence = { windowId: "window-1", windowGeneration: 1, topologyRevision: 4 };
const original = { x: 32, y: 36, width: 960, height: 640 };

async function fullscreenHost() {
  const fixture = new Fixture();
  fixture.configureWindow = native => {
    native.normalBounds = { ...original, height: 680 };
    native.contentBounds = { ...original, height: 680 };
  };
  const host = await fixture.factory.createEmpty(target({
    bounds: { ...original }, presentation: "fullscreen"
  }), { attemptGeneration: "normal-readback", ...fence });
  host.applyAppKitPhaseProjection!({ ...fence, tabIds: [], hiddenTabIds: [], tabPhases: [] });
  await Promise.resolve();
  host.showInactive!();
  const initial = host.completeInitialPresentation!(fence);
  const native = fixture.windows[0]!;
  native.fullScreen = true;
  fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
    type: "windowPlacementChanged", sourceWindowId: fence.windowId
  } });
  await initial;
  fixture.onAction.mockClear();
  fixture.onLayout.mockClear();
  return { fixture, host, native, controller: fixture.addon.controllers[0]! };
}

describe("macOS normal presentation native readback", () => {
  it("returns the acknowledged current normal geometry and admits later native user resizing", async () => {
    const { fixture, host, native, controller } = await fullscreenHost();
    const operation = host.setRuntimeWindowPresentation!({ ...fence, presentation: "normal" });
    expect(host.readProjection().bounds).toEqual(original);
    native.fullScreen = false;
    native.normalBounds = { x: 32, y: 31, width: 960, height: 677 };
    native.contentBounds = { ...native.normalBounds };
    controller.layout = { heightInset: 40, yOffset: 0, valid: true };
    const readLayout = vi.spyOn(controller, "snapshotContentLayout");

    fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
      type: "windowPlacementChanged", sourceWindowId: fence.windowId
    } });

    await expect(operation).resolves.toMatchObject({
      presentation: "normal", bounds: { x: 32, y: 31, width: 960, height: 637 }
    });
    expect(readLayout).toHaveBeenCalled();
    expect(fixture.onAction).not.toHaveBeenCalled();
    host.applyAppKitPhaseProjection!({ ...fence, topologyRevision: 5,
      tabIds: [], hiddenTabIds: [], tabPhases: [] });
    await Promise.resolve();
    native.normalBounds = { x: 40, y: 60, width: 1000, height: 740 };
    native.contentBounds = { ...native.normalBounds };

    fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
      type: "windowPlacementChanged", sourceWindowId: fence.windowId
    } });

    expect(fixture.onAction).toHaveBeenCalledOnce();
    expect(fixture.onAction.mock.calls[0]![0].hosts[0]).toMatchObject({
      topologyRevision: 5, presentation: "normal",
      normalBounds: { x: 40, y: 60, width: 1000, height: 700 }
    });
    expect(fixture.onError).not.toHaveBeenCalled();
  });

  it("rejects invalid native layout at the normal acknowledgement instead of returning cached success", async () => {
    const { fixture, host, native, controller } = await fullscreenHost();
    const submit = vi.spyOn(native, "setFullScreen");
    const operation = host.setRuntimeWindowPresentation!({ ...fence, presentation: "normal" });
    native.fullScreen = false;
    controller.layout = { heightInset: 40, yOffset: 0, valid: false };

    fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
      type: "windowPlacementChanged", sourceWindowId: fence.windowId
    } });

    await expect(operation).rejects.toMatchObject({ code: "ELECTRON_MACOS_APPKIT_LAYOUT_INVALID" });
    expect(submit).toHaveBeenCalledExactlyOnceWith(false);
    expect(fixture.onAction).not.toHaveBeenCalled();
  });
});

describe("macOS staged initial native fit", () => {
  it.each(["fullscreen", "maximized"] as const)(
    "publishes fitted normal geometry only with the exact initial %s acknowledgement",
    async presentation => {
      const requested = { x: 32, y: 50, width: 960, height: 640 };
      const fitted = { x: 32, y: 31, width: 960, height: 637 };
      const fixture = new Fixture();
      fixture.configureWindow = native => {
        native.normalBounds = { ...fitted, height: 677 };
        native.contentBounds = { ...native.normalBounds };
      };
      const host = await fixture.factory.createEmpty(target({
        bounds: requested, presentation,
        workArea: { x: 0, y: 31, width: 1024, height: 677 }
      }), { attemptGeneration: "staged-native-fit", ...fence });
      const native = fixture.windows[0]!;
      const controller = fixture.addon.controllers[0]!;
      host.applyAppKitPhaseProjection!({ ...fence,
        tabIds: [], hiddenTabIds: [], tabPhases: [] });
      await Promise.resolve();
      host.showInactive!();
      native.focused = true;
      fixture.onAction.mockClear();
      let normalBoundsAtSubmission: ReturnType<typeof host.readProjection>["bounds"] | undefined;
      if (presentation === "fullscreen") {
        const submit = native.setFullScreen.bind(native);
        vi.spyOn(native, "setFullScreen").mockImplementation(value => {
          normalBoundsAtSubmission = host.readProjection().bounds;
          submit(value);
        });
      } else {
        const submit = native.maximize.bind(native);
        vi.spyOn(native, "maximize").mockImplementation(() => {
          normalBoundsAtSubmission = host.readProjection().bounds;
          submit();
        });
      }

      const completion = host.completeInitialPresentation!(fence);
      await expectPending(completion);
      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
        type: "windowPlacementChanged", sourceWindowId: fence.windowId
      } });
      await expectPending(completion);
      expect(fixture.onAction).not.toHaveBeenCalled();

      native.fullScreen = presentation === "fullscreen";
      native.maximized = presentation === "maximized";
      if (presentation === "fullscreen") {
        native.contentBounds = { x: 0, y: 0, width: 1024, height: 768 };
        controller.layout = { heightInset: 0, yOffset: 0, valid: true };
      }
      native.emit(presentation === "fullscreen" ? "enter-full-screen" : "maximize");
      await expectPending(completion);
      expect(fixture.onAction).not.toHaveBeenCalled();
      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
        type: "windowPlacementChanged", sourceWindowId: fence.windowId
      } });
      await expect(completion).resolves.toBeUndefined();

      expect.soft(normalBoundsAtSubmission).toEqual(fitted);
      expect.soft(host.readProjection().bounds).toEqual(fitted);
      expect.soft(fixture.onAction).toHaveBeenCalledOnce();
      expect(fixture.onAction.mock.calls[0]?.[0]).toMatchObject({
        identity: host.appKitIdentity!,
        action: { type: "windowPlacementChanged", sourceWindowId: fence.windowId },
        hosts: [{ identity: host.appKitIdentity!,
          windowGeneration: fence.windowGeneration, topologyRevision: fence.topologyRevision,
          normalBounds: fitted, presentation, visible: true, focused: true }]
      });
      expect(host.readPendingInitialPresentation!()).toBeNull();
      expect(requested).toEqual({ x: 32, y: 50, width: 960, height: 640 });
      expect(fixture.onError).not.toHaveBeenCalled();
    }
  );
});
