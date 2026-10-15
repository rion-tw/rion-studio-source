import { afterEach, describe, expect, it, vi } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import type { ChromiumRuntimeHostPort } from "../src/electron/main/chromiumRuntimeHostPorts";
import { ChromiumRuntimeOwnershipTransitionCoordinator } from
  "../src/electron/main/chromiumRuntimeOwnershipTransitionCoordinator";
import { effect } from "./support/electronChromiumRuntimeEffectFixtures";
import { harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { expectPending, Fixture, target } from
  "./support/macosAppKitRuntimeHostFactoryFixtures";

afterEach(() => vi.restoreAllMocks());

describe.each(["fullscreen", "maximized"] as const)(
  "macOS exact initial %s ownership following",
  presentation => {
    it("submits once after native focus admission and awaits the placement ACK", async () => {
      const fixture = new Fixture();
      const subject = harness(undefined, "macos");
      const begin = vi.spyOn(ChromiumRuntimeOwnershipTransitionCoordinator.prototype, "begin");
      let host!: ChromiumRuntimeHostPort;
      subject.createEmptyHost.mockImplementation(async (
        ...args: Parameters<Fixture["factory"]["createEmpty"]>
      ) => {
        host = await fixture.factory.createEmpty(...args);
        return host;
      });
      const launchTarget = target({ presentation });
      const fence = { windowId: launchTarget.windowId, windowGeneration: 8, topologyRevision: 8 };

      const execution = await subject.executor.execute(effect("embedded-runtime", {
        type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1, roles: [],
        windows: [{ ...fence, tabIds: [], tabPhases: [], hiddenTabIds: [] }],
        target: launchTarget, revealWindowIds: [fence.windowId], focusWindowIds: [fence.windowId]
      }, "initial-macos-presentation"));

      expect(isCoreEffectEventContinuation(execution)).toBe(true);
      if (!isCoreEffectEventContinuation(execution)) throw new Error("Expected ownership continuation.");
      expect(begin).toHaveBeenCalledOnce();
      const transition = begin.mock.results[0]!.value;
      expect(isCoreEffectEventContinuation(transition)).toBe(true);
      const native = fixture.windows[0]!;
      const submit = presentation === "fullscreen"
        ? vi.spyOn(native, "setFullScreen") : vi.spyOn(native, "maximize");
      expect(native.visible).toBe(true);
      expect(native.focused).toBe(false);
      expect(host.readPendingInitialPresentation!()).toBe(presentation);
      expect(fixture.order).toContain("window-show-inactive");
      expect(fixture.order).toContain("controller-window-focus");
      expect(submit).not.toHaveBeenCalled();
      await expectPending(transition.completion);
      await expectPending(execution.completion);

      native.focused = true;
      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
        type: "windowFocusChanged", sourceWindowId: fence.windowId,
        focused: true, minimized: false, visible: true
      } });

      await expect(transition.completion).resolves.toMatchObject({
        status: "applied", windows: [{ windowGeneration: 8, topologyRevision: 8,
          logicalWindowId: fence.windowId,
          nativeHostId: host.id, visible: true, focused: true, foreground: true,
          appKitIdentity: host.appKitIdentity }]
      });
      expect(submit).toHaveBeenCalledOnce();
      if (presentation === "fullscreen") expect(submit).toHaveBeenCalledWith(true);
      expect(host.readProjection().presentation).toBe("normal");
      expect(fixture.onLayout).not.toHaveBeenCalled();
      await expectPending(execution.completion);

      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
        type: "windowPlacementChanged", sourceWindowId: fence.windowId
      } });
      await expectPending(execution.completion);
      native.fullScreen = presentation === "fullscreen";
      native.maximized = presentation === "maximized";
      native.emit(presentation === "fullscreen" ? "enter-full-screen" : "maximize");
      native.emit("resize");
      expect(fixture.onLayout).not.toHaveBeenCalled();
      await expectPending(execution.completion);

      fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!, action: {
        type: "windowPlacementChanged", sourceWindowId: fence.windowId
      } });

      await expect(execution.completion).resolves.toMatchObject({ status: "applied" });
      expect(submit).toHaveBeenCalledOnce();
      expect(host.readPendingInitialPresentation!()).toBeNull();
      expect(subject.executor.snapshot().windows).toEqual([expect.objectContaining({
        ...fence, presentation, visible: true, focused: true, tabIds: [], activeTabId: ""
      })]);
      expect(fixture.onLayout).toHaveBeenCalledOnce();
      expect(fixture.onLayout.mock.calls[0]![0].hosts[0]).toMatchObject({
        windowGeneration: 8, topologyRevision: 8, presentation, visible: true, focused: true
      });
      expect(fixture.onAction).not.toHaveBeenCalled();
      expect(fixture.onError).not.toHaveBeenCalled();
    });
  }
);
