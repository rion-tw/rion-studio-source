import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn() }));
vi.mock("@wdio/globals", () => ({ browser: { electron: { execute: mocks.execute } } }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eGameWindowRuntime: mocks.inspect
}));

const windowId = "10000000-0000-4000-8000-000000000001";
const inspection = { hostKind: "appkit", windowId, windowGeneration: 2, topologyRevision: 5,
  native: { windowId, windowGeneration: 2, topologyRevision: 5 } };
const runtime = () => ({ windowId, currentRuntime: {
  windowId, windowGeneration: 2, topologyRevision: 5, parentNativeHostId: 731,
  hostKind: "appkit-chromium", visible: true, coreTabIds: ["tab"], nativeTabIds: ["tab"],
  nativeDisplay: { presentation: "normal" },
  appKitIdentity: { launchGeneration: "launch", logicalWindowId: windowId, nativeGeneration: 3 }
} });
const nativeHost = () => ({ id: 731, isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true),
  isMinimized: vi.fn(() => false), isFullScreen: vi.fn(() => false), isMaximized: vi.fn(() => false),
  getNativeWindowHandle: vi.fn(() => Buffer.from([1, 2, 3, 4])),
  getMinimumSize: vi.fn(() => [640, 520]),
  getBounds: vi.fn(() => ({ x: 56, y: 31, width: 935, height: 676 })),
  focus: vi.fn(), show: vi.fn(), setMinimumSize: vi.fn()
});

let host: ReturnType<typeof nativeHost>;
let current: ReturnType<typeof nativeHost> | null;
beforeEach(() => {
  vi.clearAllMocks();
  host = nativeHost(); current = host;
  mocks.inspect.mockImplementation(async () => runtime());
  mocks.execute.mockImplementation(async (callback: (
    electron: { BaseWindow: { fromId(id: number): typeof current } },
    target: { processId: number; parentNativeHostId: number }
  ) => unknown, target: { processId: number; parentNativeHostId: number }) => callback({
    BaseWindow: { fromId: id => id === 731 ? current : null }
  }, target));
});

const read = async (processId = process.pid) => {
  // This helper runs in the separate WDIO compilation graph.
  const helper = await vi.importActual<{
    readMacosRuntimeWindowConstraints(input: { inspection: typeof inspection; processId: number }):
      Promise<{ minimumWidth: number; minimumHeight: number }>;
  }>("../e2e/desktop/support/macos-runtime-window-constraints");
  return helper.readMacosRuntimeWindowConstraints({ inspection, processId });
};

describe("exact macOS runtime frame constraints", () => {
  it("reads the live outer-frame minimum without adding content/chrome insets or mutating the host", async () => {
    await expect(read()).resolves.toMatchObject({ processId: process.pid, windowId,
      parentNativeHostId: 731, windowGeneration: 2, topologyRevision: 5,
      nativeWindowHandle: "01020304", minimumWidth: 640, minimumHeight: 520,
      appKitIdentity: runtime().currentRuntime.appKitIdentity,
      frame: { x: 56, y: 31, width: 935, height: 676 } });
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(host.getMinimumSize).toHaveBeenCalledTimes(1);
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
    "rejects native %s while reading the minimum", async change => {
      host.getMinimumSize.mockImplementation(() => {
        if (change === "replacement") current = nativeHost();
        if (change === "destroyed") host.isDestroyed.mockReturnValue(true);
        if (change === "hidden") host.isVisible.mockReturnValue(false);
        if (change === "minimized") host.isMinimized.mockReturnValue(true);
        if (change === "fullscreen") host.isFullScreen.mockReturnValue(true);
        if (change === "maximized") host.isMaximized.mockReturnValue(true);
        return [640, 520];
      });
      await expect(read()).rejects.toThrow("exact live normal BaseWindow");
      expect(mocks.inspect).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a raw native handle changed by the getter", async () => {
    host.getNativeWindowHandle.mockReturnValueOnce(Buffer.from([1])).mockReturnValueOnce(Buffer.from([2]));
    await expect(read()).rejects.toThrow("native readback changed");
  });

  it.each([[0, 520], [640, -1], [640, Number.NaN], [640, 520.5]])(
    "rejects invalid native minimum %j", async (width, height) => {
      host.getMinimumSize.mockReturnValue([width, height]);
      await expect(read()).rejects.toThrow("native readback changed or is invalid");
    }
  );

  it("rejects a process mismatch without admitting the native constraints", async () => {
    await expect(read(process.pid + 1)).rejects.toThrow("exact live normal BaseWindow");
    expect(host.getMinimumSize).not.toHaveBeenCalled();
  });

  it("preserves a native getter failure without retry or fallback", async () => {
    const failure = new Error("native minimum unavailable");
    host.getMinimumSize.mockImplementation(() => { throw failure; });
    await expect(read()).rejects.toBe(failure);
    expect(host.getMinimumSize).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
