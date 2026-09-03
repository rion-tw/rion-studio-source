import { describe, expect, it, vi } from "vitest";

import { MacosAppKitRuntimePresentationController } from
  "../src/electron/main/macosAppKitRuntimePresentationController";

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
}

function fixture() {
  const native = {
    destroyed: false,
    fullScreen: false,
    maximized: false,
    isDestroyed: () => native.destroyed,
    isFullScreen: () => native.fullScreen,
    isMaximized: () => native.maximized,
    setFullScreen: vi.fn()
  };
  const fence = {
    current: true,
    topologyRevision: 4,
    windowGeneration: 3,
    windowId: "window-1"
  };
  const prepareFullscreen = vi.fn();
  const controller = new MacosAppKitRuntimePresentationController({
    native,
    prepareFullscreen,
    readFence: () => ({ ...fence }),
    readProjection: () => ({
      bounds: { x: 20, y: 30, width: 900, height: 640 },
      displayId: 7,
      focused: true,
      presentation: native.fullScreen
        ? "fullscreen"
        : native.maximized ? "maximized" : "normal",
      visible: true
    })
  });
  return { controller, fence, native, prepareFullscreen };
}

describe("macOS AppKit runtime presentation controller", () => {
  it("waits for the exact native placement event and the following Core projection", async () => {
    const { controller, fence, native, prepareFullscreen } = fixture();

    const operation = controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(prepareFullscreen).toHaveBeenCalledWith(true);
    expect(native.setFullScreen).toHaveBeenCalledWith(true);
    await expectPending(operation);

    native.fullScreen = true;
    expect(controller.observeWindowPlacement()).toBe(true);
    await expect(operation).resolves.toEqual(expect.objectContaining({
      displayId: 7,
      focused: true,
      presentation: "fullscreen",
      visible: true
    }));
    expect(controller.suppressWindowStateEvent()).toBe(true);
    fence.topologyRevision = 5;
    controller.coreProjectionApplied({
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(controller.suppressWindowStateEvent()).toBe(false);
  });

  it("does not claim native user presentation events without a Core request", () => {
    const { controller, native } = fixture();
    native.fullScreen = true;
    expect(controller.observeWindowPlacement()).toBe(false);
  });

  it("keeps a mismatched native placement pending and suppressed", async () => {
    const { controller, native } = fixture();

    const operation = controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(controller.suppressWindowStateEvent()).toBe(true);
    expect(controller.observeWindowPlacement()).toBe(true);
    await expectPending(operation);
    expect(controller.suppressWindowStateEvent()).toBe(true);

    native.fullScreen = true;
    expect(controller.observeWindowPlacement()).toBe(true);
    await expect(operation).resolves.toEqual(expect.objectContaining({
      presentation: "fullscreen"
    }));
  });

  it("admits a higher-revision compensation while awaiting Core projection", async () => {
    const { controller, native } = fixture();

    const enter = controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    native.fullScreen = true;
    expect(controller.observeWindowPlacement()).toBe(true);
    await expect(enter).resolves.toEqual(expect.objectContaining({
      presentation: "fullscreen"
    }));

    const compensate = controller.setPresentation({
      presentation: "normal",
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(native.setFullScreen).toHaveBeenNthCalledWith(2, false);
    expect(controller.suppressWindowStateEvent()).toBe(true);
    expect(controller.observeWindowPlacement()).toBe(true);
    await expectPending(compensate);

    native.fullScreen = false;
    expect(controller.observeWindowPlacement()).toBe(true);
    await expect(compensate).resolves.toEqual(expect.objectContaining({
      presentation: "normal"
    }));
    expect(controller.suppressWindowStateEvent()).toBe(true);
    controller.coreProjectionApplied({
      topologyRevision: 6,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(controller.suppressWindowStateEvent()).toBe(false);
  });

  it("does not retain a wait for an exact native match and advances a matching compensation fence", async () => {
    const exact = fixture();
    exact.native.fullScreen = true;
    await expect(exact.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    })).resolves.toEqual(expect.objectContaining({
      presentation: "fullscreen"
    }));
    expect(exact.native.setFullScreen).not.toHaveBeenCalled();
    expect(exact.controller.suppressWindowStateEvent()).toBe(false);

    const compensation = fixture();
    const enter = compensation.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    compensation.native.fullScreen = true;
    compensation.controller.observeWindowPlacement();
    await enter;

    await expect(compensation.controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    })).resolves.toEqual(expect.objectContaining({
      presentation: "fullscreen"
    }));
    expect(compensation.native.setFullScreen).toHaveBeenCalledTimes(1);
    compensation.controller.coreProjectionApplied({
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(compensation.controller.suppressWindowStateEvent()).toBe(true);
    compensation.controller.coreProjectionApplied({
      topologyRevision: 6,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(compensation.controller.suppressWindowStateEvent()).toBe(false);
  });

  it("clears projection suppression only for a newer exact fence with matching native readback", async () => {
    const { controller, native } = fixture();
    const operation = controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    native.fullScreen = true;
    controller.observeWindowPlacement();
    await operation;

    for (const projection of [
      { topologyRevision: 4, windowGeneration: 3, windowId: "window-1" },
      { topologyRevision: 5, windowGeneration: 3, windowId: "window-2" },
      { topologyRevision: 5, windowGeneration: 4, windowId: "window-1" },
      { topologyRevision: Number.POSITIVE_INFINITY, windowGeneration: 3, windowId: "window-1" }
    ]) {
      controller.coreProjectionApplied(projection);
      expect(controller.suppressWindowStateEvent()).toBe(true);
    }

    native.fullScreen = false;
    controller.coreProjectionApplied({
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(controller.suppressWindowStateEvent()).toBe(true);

    native.fullScreen = true;
    controller.coreProjectionApplied({
      topologyRevision: 5,
      windowGeneration: 3,
      windowId: "window-1"
    });
    expect(controller.suppressWindowStateEvent()).toBe(false);
  });

  it("rejects unsupported, stale, busy, and closed operations exactly", async () => {
    const { controller, fence } = fixture();
    await expect(controller.setPresentation({
      presentation: "maximized",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PRESENTATION_INVALID"
    });

    fence.topologyRevision = 5;
    await expect(controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PRESENTATION_FENCE_STALE"
    });

    fence.topologyRevision = 4;
    const first = controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    });
    await expect(controller.setPresentation({
      presentation: "fullscreen",
      topologyRevision: 4,
      windowGeneration: 3,
      windowId: "window-1"
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PRESENTATION_BUSY"
    });
    controller.close();
    await expect(first).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PRESENTATION_CLOSED"
    });
  });
});
