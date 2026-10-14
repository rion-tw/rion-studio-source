import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), toolbar: vi.fn(), execute: vi.fn() }));
vi.mock("@wdio/globals", () => ({ browser: { electron: { execute: mocks.execute } } }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eGameWindowRuntime: mocks.inspect,
  electronDesktopE2eFullscreenToolbarRuntime: mocks.toolbar
}));

const windowId = "10000000-0000-4000-8000-000000000001";
const inspection = { hostKind: "appkit", presentation: "normal", windowId, windowGeneration: 2, topologyRevision: 5,
  native: { windowId, windowGeneration: 2, topologyRevision: 5,
    appKit: { minimumFrameSize: { width: 640, height: 520 } } } };
const runtime = () => ({ windowId, currentRuntime: {
  windowId, windowGeneration: 2, topologyRevision: 5, parentNativeHostId: 731,
  hostKind: "appkit-chromium", visible: true, coreTabIds: ["tab"], nativeTabIds: ["tab"],
  nativeDisplay: { presentation: "normal" },
  appKitIdentity: { launchGeneration: "launch", logicalWindowId: windowId, nativeGeneration: 3 }
} });
const nativeHost = () => ({ id: 731, isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
  isMinimized: vi.fn(() => false), isFullScreen: vi.fn(() => false), isMaximized: vi.fn(() => false),
  getNativeWindowHandle: vi.fn(() => Buffer.from([1, 2, 3, 4])),
  getMinimumSize: vi.fn(() => [640, 512]),
  getBounds: vi.fn(() => ({ x: 56, y: 31, width: 935, height: 676 })),
  focus: vi.fn(), show: vi.fn(), setMinimumSize: vi.fn()
});

let host: ReturnType<typeof nativeHost>;
let current: ReturnType<typeof nativeHost> | null;
beforeEach(() => {
  vi.clearAllMocks();
  host = nativeHost(); current = host;
  mocks.inspect.mockImplementation(async () => runtime());
  mocks.toolbar.mockImplementation(async () => structuredClone(inspection));
  mocks.execute.mockImplementation(async (callback: (
    electron: { BaseWindow: { fromId(id: number): typeof current } },
    target: { processId: number; parentNativeHostId: number }
  ) => unknown, target: { processId: number; parentNativeHostId: number }) => callback({
    BaseWindow: { fromId: id => id === 731 ? current : null }
  }, target));
});

const read = async (processId = process.pid, expectedInspection = inspection) => {
  // This helper runs in the separate WDIO compilation graph.
  const helper = await vi.importActual<{
    readMacosRuntimeWindowConstraints(input: { inspection: typeof inspection; processId: number }):
      Promise<{ minimumWidth: number; minimumHeight: number }>;
  }>("../e2e/desktop/support/macos-runtime-window-constraints");
  return helper.readMacosRuntimeWindowConstraints({ inspection: expectedInspection, processId });
};

describe("exact macOS runtime frame constraints", () => {
  it("uses actual NSWindow minimum rather than Electron's cached 512px content constraint conversion", async () => {
    await expect(read()).resolves.toMatchObject({ processId: process.pid, windowId,
      parentNativeHostId: 731, windowGeneration: 2, topologyRevision: 5,
      nativeWindowHandle: "01020304", minimumWidth: 640, minimumHeight: 520,
      appKitIdentity: runtime().currentRuntime.appKitIdentity,
      frame: { x: 56, y: 31, width: 935, height: 676 } });
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(mocks.toolbar).toHaveBeenCalledTimes(2);
    expect(host.getMinimumSize).not.toHaveBeenCalled();
    expect(host.focus).not.toHaveBeenCalled();
    expect(host.show).not.toHaveBeenCalled();
    expect(host.setMinimumSize).not.toHaveBeenCalled();
  });

  it.each([
    { windowGeneration: 1 }, { topologyRevision: 4 }, { windowId: "another" },
    { parentNativeHostId: 0 }, { hostKind: "bundled-chromium" }, { visible: false },
    { appKitIdentity: null }, { nativeTabIds: ["other-tab"] },
    { nativeDisplay: { presentation: "fullscreen" } }
  ])("rejects an inadmissible Core/native owner before native reads: %j", async change => {
    const value = runtime();
    mocks.inspect.mockResolvedValue({ ...value, currentRuntime: { ...value.currentRuntime, ...change } });
    await expect(read()).rejects.toThrow("exact visible Core/AppKit owner");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { parentNativeHostId: 732 }, { windowGeneration: 3 }, { topologyRevision: 6 },
    { coreTabIds: ["other-tab"], nativeTabIds: ["other-tab"] },
    { appKitIdentity: { launchGeneration: "another-launch", logicalWindowId: windowId, nativeGeneration: 3 } },
    { appKitIdentity: { launchGeneration: "launch", logicalWindowId: windowId, nativeGeneration: 4 } },
    { appKitIdentity: { launchGeneration: "launch", logicalWindowId: "another", nativeGeneration: 3 } }
  ])("rejects changed Core/AppKit fences after a native read: %j", async change => {
    const value = runtime();
    mocks.inspect.mockResolvedValueOnce(value).mockResolvedValueOnce({
      ...value, currentRuntime: { ...value.currentRuntime, ...change }
    });
    await expect(read()).rejects.toThrow(/Mac resize constraints/u);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["replacement", "destroyed", "hidden", "minimized", "fullscreen", "maximized"])(
    "rejects native %s while reading its live identity", async change => {
      host.getBounds.mockImplementation(() => {
        if (change === "replacement") current = nativeHost();
        if (change === "destroyed") host.isDestroyed.mockReturnValue(true);
        if (change === "hidden") host.isVisible.mockReturnValue(false);
        if (change === "minimized") host.isMinimized.mockReturnValue(true);
        if (change === "fullscreen") host.isFullScreen.mockReturnValue(true);
        if (change === "maximized") host.isMaximized.mockReturnValue(true);
        return { x: 56, y: 31, width: 935, height: 676 };
      });
      await expect(read()).rejects.toThrow("exact live normal BaseWindow");
      expect(mocks.inspect).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a raw native handle changed by the getter", async () => {
    host.getNativeWindowHandle.mockReturnValueOnce(Buffer.from([1])).mockReturnValueOnce(Buffer.from([2]));
    await expect(read()).rejects.toThrow("native readback changed");
  });

  it.each([[0, 520], [640, -1], [640, Number.NaN], [640, Number.POSITIVE_INFINITY]])(
    "rejects invalid native minimum %j", async (width, height) => {
      mocks.toolbar.mockResolvedValue({ ...inspection, native: { ...inspection.native,
        appKit: { minimumFrameSize: { width, height } } } });
      await expect(read()).rejects.toThrow("exact current AppKit minimum");
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );

  it("rejects a process mismatch without admitting the native constraints", async () => {
    await expect(read(process.pid + 1)).rejects.toThrow("exact live normal BaseWindow");
    expect(host.getBounds).not.toHaveBeenCalled();
  });

  it("preserves a native getter failure without retry or fallback", async () => {
    const failure = new Error("native frame unavailable");
    host.getBounds.mockImplementation(() => { throw failure; });
    await expect(read()).rejects.toBe(failure);
    expect(host.getBounds).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a native minimum changed after the live BaseWindow read without admitting either cached value", async () => {
    mocks.toolbar.mockResolvedValueOnce(structuredClone(inspection)).mockResolvedValueOnce({
      ...inspection, native: { ...inspection.native, appKit: { minimumFrameSize: { width: 640, height: 528 } } }
    });
    await expect(read()).rejects.toThrow("exact current AppKit minimum");
    expect(host.getMinimumSize).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves the same positive fractional NSWindow minimum across both native reads", async () => {
    const fractional = { ...inspection, native: { ...inspection.native,
      appKit: { minimumFrameSize: { width: 640.5, height: 520.25 } } } };
    mocks.toolbar.mockResolvedValue(fractional);
    await expect(read(process.pid, fractional)).resolves.toMatchObject({ minimumWidth: 640.5, minimumHeight: 520.25 });
    expect(mocks.toolbar).toHaveBeenCalledTimes(2);
    expect(host.getMinimumSize).not.toHaveBeenCalled();
  });

  it.each([{ windowGeneration: 3 }, { topologyRevision: 6 }, { windowId: "another" }])(
    "rejects changed native controller fences %j", async change => {
      mocks.toolbar.mockResolvedValue({ ...inspection, ...change });
      await expect(read()).rejects.toThrow("exact current AppKit minimum");
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );

  it.each([{ windowGeneration: 3 }, { topologyRevision: 6 }, { windowId: "another" }])(
    "rejects stale inner native controller fences %j", async change => {
      mocks.toolbar.mockResolvedValue({ ...inspection, native: { ...inspection.native, ...change } });
      await expect(read()).rejects.toThrow("exact current AppKit minimum");
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );
});
