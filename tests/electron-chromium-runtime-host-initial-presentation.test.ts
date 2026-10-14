import { describe, expect, it, vi } from "vitest";
import type { WindowsRuntimeHostProjection } from "../src/shared/windowsRuntimeHost";
import { ChromiumPlatformRuntimeHostFactory } from "../src/electron/main/chromiumRuntimeHostFactory";
import { applyWindowFence, displays, expectPending, FakeBrowserWindows,
  FakeRuntimeInactivePresentation, finishCreation, runtimeDocumentPath, tab, target } from
  "./support/windowsRuntimeHostFactoryFixtures";

class InactivePresentationFactory extends ChromiumPlatformRuntimeHostFactory {
  readonly inactive: FakeRuntimeInactivePresentation;
  constructor(windows: FakeBrowserWindows) {
    const inactive = new FakeRuntimeInactivePresentation(windows);
    super({ platform: "win32", browserWindows: windows.port, displays, runtimeDocumentPath,
      runtimeInactivePresentation: inactive });
    this.inactive = inactive;
  }
}

describe("Core-fenced staged Windows native presentation", () => {
  it.each(["create", "createEmpty"] as const)(
    "stages maximized %s without revealing or focusing the provisional host",
    async method => {
      const browserWindows = new FakeBrowserWindows();
      const factory = new InactivePresentationFactory(browserWindows);
      const launchTarget = target({ presentation: "maximized" });
      const creation = method === "create"
        ? factory.create(launchTarget, tab(launchTarget))
        : factory.createEmpty(launchTarget, {
          attemptGeneration: "launch-generation-1", windowGeneration: 4, topologyRevision: 9
        });
      const window = browserWindows.windows[0]!;
      const host = await finishCreation(creation, window);
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      expect(host.readProjection()).toMatchObject({ presentation: "normal", visible: false });
      expect(window.maximizeCalls).toBe(0);
      expect(window.showCalls).toBe(0);
      expect(window.showInactiveCalls).toBe(0);
      expect(window.focusCalls).toBe(0);

      if (method === "create") {
        await applyWindowFence(host);
      } else {
        await host.applyWindowsChromeProjection!({
          activeTabId: null, contentBounds: { x: 0, y: 40, width: 960, height: 640 },
          moveTargets: [], tabs: [], topologyRevision: 9, windowGeneration: 4,
          workspaceDividers: [], windowId: "window-1"
        });
      }
      await expect(host.completeInitialPresentation!({
        windowId: "window-1", windowGeneration: 4, topologyRevision: 9
      })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE" });
      expect(host.isVisible()).toBe(false);
      expect(window.maximizeCalls).toBe(0);

      host.showInactive!();
      let releaseLayout!: () => void;
      const layout = new Promise<void>(resolveLayout => { releaseLayout = resolveLayout; });
      const layoutObserver = vi.fn(() => layout);
      host.bindRuntimeWindowLayout!(layoutObserver);
      const completion = host.completeInitialPresentation!({
        windowId: "window-1", windowGeneration: 4, topologyRevision: 9
      });
      expect(window.maximizeCalls).toBe(0);
      expect(window.inactiveMaximizeCalls).toBe(1);
      expect(factory.inactive.maximizeWindowsRuntimeParentInactive).toHaveBeenCalledExactlyOnceWith(
        window.getNativeWindowHandle(), window.nativeId.toString(16).padStart(64, "0")
      );
      await expectPending(completion);
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      window.emit("unmaximize");
      await expectPending(completion);
      expect(layoutObserver).not.toHaveBeenCalled();
      window.emit("maximize");
      await expectPending(completion);
      expect(layoutObserver).toHaveBeenCalledOnce();
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      releaseLayout();
      await completion;
      expect(host.readPendingInitialPresentation!()).toBeNull();
      expect(host.readProjection()).toMatchObject({ presentation: "maximized", visible: true,
        focused: false, bounds: window.getNormalBounds() });
      const chrome = window.webContents.sent.at(-1)![1] as WindowsRuntimeHostProjection;
      expect(chrome.tabs.map(({ tabId }) => tabId)).toEqual(method === "create" ? ["tab-1"] : []);
      await host.completeInitialPresentation!({
        windowId: "window-1", windowGeneration: 4, topologyRevision: 9
      });
      expect(window.maximizeCalls).toBe(0);
      expect(window.inactiveMaximizeCalls).toBe(1);
      expect(window.showCalls).toBe(0);
      expect(window.showInactiveCalls).toBe(1);
      expect(window.focusCalls).toBe(0);
    }
  );

  it.each([
    ["logical owner", { windowId: "window-2", windowGeneration: 4, topologyRevision: 9 }],
    ["generation", { windowId: "window-1", windowGeneration: 3, topologyRevision: 9 }],
    ["revision", { windowId: "window-1", windowGeneration: 4, topologyRevision: 8 }]
  ] as const)("rejects initial maximize with a stale %s fence without native mutation", async (_name, request) => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(browserWindows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    await expect(host.completeInitialPresentation!(request)).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE"
    });
    expect(host.readPendingInitialPresentation!()).toBe("maximized");
    expect(window.maximizeCalls).toBe(0);
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    expect(window.showCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
    window.minimized = true;
    await expect(host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE" });
    expect(window.maximizeCalls).toBe(0);
  });

  it("allows exact normal presentation to supersede staged maximize before visible admission", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(browserWindows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    await expect(host.setRuntimeWindowPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9, presentation: "normal"
    })).resolves.toMatchObject({ presentation: "normal", visible: false });
    expect(host.readPendingInitialPresentation!()).toBeNull();
    host.showInactive!();
    await host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    });
    expect(window.maximizeCalls).toBe(0);
    expect(window.showCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
  });

  it("rejects pending initial maximize when its exact native host closes", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(browserWindows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    const completion = host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    });
    await expectPending(completion);
    const rejected = expect(completion).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_CLOSED"
    });
    await host.close();
    await rejected;
    expect(window.destroyCalls).toBe(1);
    expect(window.focusCalls).toBe(0);
  });

  it.each(["initial", "explicit"] as const)(
    "retains staged maximize when a newer Core revision supersedes %s acknowledgement",
    async method => {
      const browserWindows = new FakeBrowserWindows();
      const factory = new InactivePresentationFactory(browserWindows);
      const launchTarget = target({ presentation: "maximized" });
      const creation = factory.create(launchTarget, tab(launchTarget));
      const window = browserWindows.windows[0]!;
      const host = await finishCreation(creation, window);
      await applyWindowFence(host);
      host.showInactive!();
      const fence = { windowId: "window-1", windowGeneration: 4, topologyRevision: 9 };
      const completion = method === "initial"
        ? host.completeInitialPresentation!(fence)
        : host.setRuntimeWindowPresentation!({ ...fence, presentation: "maximized" });
      await expectPending(completion);
      await applyWindowFence(host, 4, 10);
      const rejected = expect(completion).rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_SUPERSEDED"
      });
      window.emit("maximize");
      await rejected;
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      expect(host.readFullscreenToolbar!().topologyRevision).toBe(10);
      expect(window.maximizeCalls).toBe(method === "explicit" ? 1 : 0);
      expect(window.inactiveMaximizeCalls).toBe(method === "initial" ? 1 : 0);
      expect(window.focusCalls).toBe(0);
    }
  );

  it("retains staged maximize after a native submission failure", async () => {
    const browserWindows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(browserWindows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = browserWindows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    factory.inactive.maximizeWindowsRuntimeParentInactive.mockImplementation(() => {
      throw new Error("native maximize refused");
    });
    await expect(host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    })).rejects.toThrow("native maximize refused");
    expect(host.readPendingInitialPresentation!()).toBe("maximized");
    expect(host.readProjection()).toMatchObject({ presentation: "normal", focused: false });
    expect(window.maximizeCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
  });

  it("uses ordinary native maximize for an already foreground initial host", async () => {
    const windows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(windows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    window.focused = true;
    const completion = host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    });
    expect(window.maximizeCalls).toBe(1);
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    await expectPending(completion);
    window.emit("maximize");
    await completion;
    expect(host.readProjection()).toMatchObject({ presentation: "maximized", focused: true });
    expect(host.readPendingInitialPresentation!()).toBeNull();
    expect(window.focusCalls).toBe(0);
  });

  it("keeps ordinary explicit maximize on its native user-command path", async () => {
    const windows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(windows);
    const creation = factory.create(target(), tab(target()));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    const completion = host.setRuntimeWindowPresentation!({ presentation: "maximized",
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9 });
    expect(window.maximizeCalls).toBe(1);
    expect(window.focused).toBe(true);
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    window.emit("maximize");
    await completion;
    expect(window.focusCalls).toBe(0);
  });

  it("revalidates a newer Core revision before a delayed native maximize mutation", async () => {
    const windows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(windows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    window.fullscreen = true;
    const completion = host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    });
    await expectPending(completion);
    expect(window.fullscreenValues).toEqual([false]);
    await applyWindowFence(host, 4, 10);
    const rejected = expect(completion).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_FENCE_STALE"
    });
    window.emit("leave-full-screen");
    await rejected;
    expect(factory.inactive.readWindowsRuntimeForeground).not.toHaveBeenCalled();
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).not.toHaveBeenCalled();
    expect(window.maximizeCalls).toBe(0);
    expect(host.readPendingInitialPresentation!()).toBe("maximized");
  });

  it("rejects missing inactive presentation without submitting a focus-stealing fallback", async () => {
    const windows = new FakeBrowserWindows();
    const factory = new ChromiumPlatformRuntimeHostFactory({ platform: "win32",
      browserWindows: windows.port, displays, runtimeDocumentPath });
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    await expect(host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_INACTIVE_PRESENTATION_UNAVAILABLE" });
    expect(window.maximizeCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
    expect(window.focused).toBe(false);
    expect(host.readPendingInitialPresentation!()).toBe("maximized");
  });

  it("rejects a close while the native maximize acknowledgement awaits relayout", async () => {
    const windows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(windows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    let releaseLayout!: () => void;
    const layout = new Promise<void>(resolve => { releaseLayout = resolve; });
    host.bindRuntimeWindowLayout!(() => layout);
    const completion = host.completeInitialPresentation!({
      windowId: "window-1", windowGeneration: 4, topologyRevision: 9
    });
    window.emit("maximize");
    await expectPending(completion);
    const rejected = expect(completion).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_CLOSED"
    });
    await host.close();
    releaseLayout();
    await rejected;
    expect(window.maximizeCalls).toBe(0);
    expect(window.focusCalls).toBe(0);
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).toHaveBeenCalledOnce();
  });

  it.each(["initial", "explicit"] as const)(
    "rejects a replaced HWND while %s maximize acknowledgement awaits relayout",
    async method => {
      const windows = new FakeBrowserWindows();
      const factory = new InactivePresentationFactory(windows);
      const launchTarget = target({ presentation: "maximized" });
      const creation = factory.create(launchTarget, tab(launchTarget));
      const window = windows.windows[0]!;
      const host = await finishCreation(creation, window);
      await applyWindowFence(host);
      host.showInactive!();
      let releaseLayout!: () => void;
      const layout = new Promise<void>(resolve => { releaseLayout = resolve; });
      host.bindRuntimeWindowLayout!(() => layout);
      const fence = { windowId: "window-1", windowGeneration: 4, topologyRevision: 9 };
      const completion = method === "initial" ? host.completeInitialPresentation!(fence)
        : host.setRuntimeWindowPresentation!({ ...fence, presentation: "maximized" });
      window.emit("maximize");
      await expectPending(completion);
      const replacement = window.getNativeWindowHandle();
      replacement.writeBigUInt64LE(99n);
      vi.spyOn(window, "getNativeWindowHandle").mockReturnValue(replacement);
      const rejected = expect(completion).rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE"
      });
      releaseLayout();
      await rejected;
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      expect(window.maximizeCalls).toBe(method === "explicit" ? 1 : 0);
      expect(window.inactiveMaximizeCalls).toBe(method === "initial" ? 1 : 0);
      expect(window.focusCalls).toBe(0);
    }
  );

  it.each(["initial", "explicit"] as const)("rejects %s maximum state lost during its acknowledged layout without replay", async method => {
    const windows = new FakeBrowserWindows();
    const factory = new InactivePresentationFactory(windows);
    const launchTarget = target({ presentation: "maximized" });
    const creation = factory.create(launchTarget, tab(launchTarget));
    const window = windows.windows[0]!;
    const host = await finishCreation(creation, window);
    await applyWindowFence(host);
    host.showInactive!();
    let releaseLayout!: () => void;
    const layout = new Promise<void>(resolve => { releaseLayout = resolve; });
    host.bindRuntimeWindowLayout!(() => layout);
    const fence = { windowId: "window-1", windowGeneration: 4, topologyRevision: 9 };
    const completion = method === "initial" ? host.completeInitialPresentation!(fence)
      : host.setRuntimeWindowPresentation!({ ...fence, presentation: "maximized" });
    window.emit("maximize");
    await expectPending(completion);
    window.maximized = false;
    window.emit("unmaximize");
    const rejected = expect(completion).rejects.toMatchObject({
      code: "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_READBACK_STALE"
    });
    releaseLayout();
    await rejected;
    expect(host.readPendingInitialPresentation!()).toBe("maximized");
    expect(factory.inactive.maximizeWindowsRuntimeParentInactive).toHaveBeenCalledTimes(method === "initial" ? 1 : 0);
    expect(window.inactiveMaximizeCalls).toBe(method === "initial" ? 1 : 0);
    expect(window.maximizeCalls).toBe(method === "explicit" ? 1 : 0);
    expect(window.maximized).toBe(false);
    expect(window.focusCalls).toBe(0);
  });

  it.each(["foreground", "focusIdentity"] as const)(
    "rejects changed native %s receipt without replay or raw maximize",
    async mismatch => {
      const windows = new FakeBrowserWindows();
      const factory = new InactivePresentationFactory(windows);
      const launchTarget = target({ presentation: "maximized" });
      const creation = factory.create(launchTarget, tab(launchTarget));
      const window = windows.windows[0]!;
      const host = await finishCreation(creation, window);
      await applyWindowFence(host);
      host.showInactive!();
      const maximize = factory.inactive.maximizeWindowsRuntimeParentInactive.getMockImplementation()!;
      factory.inactive.maximizeWindowsRuntimeParentInactive.mockImplementation((handle, identity) => {
        const receipt = maximize(handle, identity);
        return { ...receipt, ...(mismatch === "foreground"
          ? { parentWasForeground: true } : { focusIdentity: "0".repeat(64) }) };
      });
      await expect(host.completeInitialPresentation!({
        windowId: "window-1", windowGeneration: 4, topologyRevision: 9
      })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_INITIAL_PRESENTATION_READBACK_STALE" });
      expect(host.readPendingInitialPresentation!()).toBe("maximized");
      expect(factory.inactive.maximizeWindowsRuntimeParentInactive).toHaveBeenCalledOnce();
      expect(window.maximizeCalls).toBe(0);
      expect(window.focusCalls).toBe(0);
    }
  );

});
