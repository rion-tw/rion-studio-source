import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreAppSnapshotRecord } from "../src/shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from "../src/electron/main/chromiumRuntimeSnapshot";
import { MacosAppKitRuntimeEventBridge } from "../src/electron/main/macosAppKitRuntimeEventBridge";
import { RuntimeWindowProjectionFence } from "../src/electron/main/runtimeWindowProjectionFence";
import { ElectronDesktopE2eGameWindowRuntimeObservation } from "../src/electron/e2e/gameWindowRuntimeObservation";

const WINDOW = "window-1";
const scope = `window:${WINDOW}`;
const action = MacosAppKitRuntimeEventBridge.prototype.receiveAction;
const layout = MacosAppKitRuntimeEventBridge.prototype.receiveLayout;
afterEach(() => {
  MacosAppKitRuntimeEventBridge.prototype.receiveAction = action;
  MacosAppKitRuntimeEventBridge.prototype.receiveLayout = layout;
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(platform: "darwin" | "win32" = "darwin", bindInitially = true) {
  const bounds = { x: 32, y: 31, width: 960, height: 637 };
  const window = {
    windowId: WINDOW, activeTabId: "tab-1", tabIds: ["tab-1"], displayId: 1,
    bounds, visible: true, focused: true, presentation: "maximized" as const,
    windowGeneration: 3, topologyRevision: 15, parentNativeHostId: 2,
    ...(platform === "darwin" ? { appKitIdentity: {
      logicalWindowId: WINDOW, launchGeneration: "launch-1", nativeGeneration: 1
    } } : {}),
    target: { windowId: WINDOW, persistedName: "Window", displayId: 1,
      scaleFactor: 1, workArea: { x: 0, y: 31, width: 1024, height: 677 },
      bounds, presentation: "maximized" as const }
  };
  let snapshot: ChromiumRuntimeExecutorSnapshot = { windows: [window], tabs: [], roles: [], webSurfaces: [] };
  // Only the original reader's consumed Core fields are needed by this fixture.
  const core = { logicalWindows: [{ windowId: WINDOW, windowGeneration: 3, revision: 16,
    tabs: [{ id: "tab-1" }] }], browserRuntime: { windows: [{ windowId: WINDOW, tabIds: ["tab-1"] }] }
  } as unknown as CoreAppSnapshotRecord;
  const projections = new RuntimeWindowProjectionFence();
  const native = new RuntimeWindowProjectionFence();
  const projectionObservers: Array<ReturnType<typeof projections.observe>> = [];
  const eventObservers: Array<ReturnType<typeof native.observe>> = [];
  const observe = (fence: RuntimeWindowProjectionFence, observers: typeof projectionObservers) => {
    const progress = fence.observe(WINDOW);
    const wrapped = { readSequence: progress.readSequence, dispose: vi.fn(progress.dispose) };
    observers.push(wrapped);
    return wrapped;
  };
  const runtime = {
    snapshot: vi.fn(() => snapshot), desktopE2eStatusPresentation: vi.fn(() => 0),
    observeWindowProjection: vi.fn(() => observe(projections, projectionObservers)),
    settleWindowProjection: vi.fn((id: string) => projections.settle(id))
  };
  const readCore = vi.fn(async () => core);
  // Capture the actual public bridge receiver without submitting any native UI
  // action. Its admitted-work fences below are the real production primitive.
  const receiveAction = vi.spyOn(MacosAppKitRuntimeEventBridge.prototype, "receiveAction").mockImplementation(() => undefined);
  vi.spyOn(MacosAppKitRuntimeEventBridge.prototype, "receiveLayout").mockImplementation(() => undefined);
  const bridge = Object.assign(Object.create(MacosAppKitRuntimeEventBridge.prototype) as MacosAppKitRuntimeEventBridge, {
    observeWindowEvents: vi.fn(() => observe(native, eventObservers)),
    settleWindowEvents: vi.fn((id: string) => native.settle(id))
  });
  const reader = new ElectronDesktopE2eGameWindowRuntimeObservation();
  reader.install();
  const bind = () => bridge.receiveAction({} as never);
  if (bindInitially) bind();
  const read = () => reader.read({ windowId: WINDOW, platform, runtime, readCore });
  const disposed = () => {
    expect(projectionObservers).toHaveLength(1);
    expect(eventObservers).toHaveLength(1);
    for (const observer of [...projectionObservers, ...eventObservers]) expect(observer.dispose).toHaveBeenCalledTimes(1);
  };
  return { window, core, runtime, native, projections, readCore, read, bind, bridge, reader, disposed,
    receiveAction, setSnapshot: (next: ChromiumRuntimeExecutorSnapshot) => { snapshot = next; } };
}

describe.each(["darwin", "win32"] as const)("exact-window Game Window evidence (%s)", platform => {
  it.each(["native event", "projection"])("waits for the admitted %s receipt before accepting Core16/native16", async lane => {
    const f = fixture(platform);
    const gate = deferred();
    (lane === "native event" ? f.native : f.projections).retain([scope], gate.promise);
    const outcome = f.read();
    let settled = false;
    void outcome.then(() => { settled = true; }, () => { settled = true; });
    await turn();
    expect(f.readCore).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    f.window.topologyRevision = 16;
    gate.resolve();
    const result = await outcome;
    expect(result.currentRuntime).toMatchObject({ windowGeneration: 3, topologyRevision: 16, parentNativeHostId: 2 });
    expect(f.readCore).toHaveBeenCalledTimes(2);
    f.disposed();
  });

  it("does not await a held load when the strict pair is already coherent", async () => {
    const f = fixture(platform);
    f.window.topologyRevision = 16;
    const held = deferred();
    f.projections.retain([scope, "window:other"], held.promise);
    await expect(f.read()).resolves.toMatchObject({ currentRuntime: { topologyRevision: 16 } });
    expect(f.runtime.settleWindowProjection).not.toHaveBeenCalled();
    held.resolve();
    f.disposed();
  });

  it("rejects a permanent revision mismatch instead of waiting for unrelated-window work", async () => {
    const f = fixture(platform);
    const held = deferred();
    f.projections.retain(["window:other"], held.promise);
    await expect(f.read()).rejects.toThrow("stale Core/native Chromium fence");
    expect(f.readCore).toHaveBeenCalledTimes(1);
    held.resolve();
    f.disposed();
  });

  it.each(["native event", "projection"])("propagates the original failed %s receipt", async lane => {
    const f = fixture(platform);
    const gate = deferred();
    (lane === "native event" ? f.native : f.projections).retain([scope], gate.promise);
    const pending = f.read();
    const outcome = pending.catch(error => error);
    await turn();
    const failure = new Error("exact native acknowledgement failed");
    gate.reject(failure);
    await expect(outcome).resolves.toBe(failure);
    f.disposed();
  });

  it.each(["native event", "projection"])("retains a %s failure completed during a coherent Core RPC", async lane => {
    const f = fixture(platform);
    const failure = new Error("failed during snapshot");
    f.readCore.mockImplementationOnce(async () => {
      const gate = deferred();
      (lane === "native event" ? f.native : f.projections).retain([scope], gate.promise);
      f.window.topologyRevision = 16;
      gate.reject(failure);
      await turn();
      return f.core;
    });
    await expect(f.read()).rejects.toBe(failure);
    f.disposed();
  });

  it("observes exact-window work that finishes entirely during the Core RPC", async () => {
    const f = fixture(platform);
    f.readCore.mockImplementationOnce(async () => {
      const gate = deferred();
      f.projections.retain([scope], gate.promise);
      gate.resolve();
      await turn();
      return f.core;
    }).mockImplementationOnce(async () => { f.window.topologyRevision = 16; return f.core; });
    await expect(f.read()).resolves.toMatchObject({ currentRuntime: { topologyRevision: 16 } });
    expect(f.readCore).toHaveBeenCalledTimes(2);
    f.disposed();
  });

  it("captures the first native event owner during the RPC before its exact work is admitted", async () => {
    const f = fixture(platform, false);
    f.readCore.mockImplementationOnce(async () => {
      f.bind();
      const gate = deferred();
      f.native.retain([scope], gate.promise);
      gate.resolve();
      await turn();
      return f.core;
    }).mockImplementationOnce(async () => { f.window.topologyRevision = 16; return f.core; });
    await expect(f.read()).resolves.toMatchObject({ currentRuntime: { topologyRevision: 16 } });
    expect(f.readCore).toHaveBeenCalledTimes(2);
    f.disposed();
  });

  it("rejects a replacement native owner despite a coherent replacement pair", async () => {
    const f = fixture(platform);
    f.readCore.mockImplementationOnce(async () => {
      f.window.topologyRevision = 16;
      f.window.parentNativeHostId = 3;
      return f.core;
    });
    await expect(f.read()).rejects.toThrow("changed its exact native owner");
    f.disposed();
  });

  it.each(["generation", "parent", "AppKit identity"])("rejects %s replacement while awaiting the exact projection", async changed => {
    const f = fixture(platform);
    const gate = deferred();
    f.projections.retain([scope], gate.promise);
    const pending = f.read();
    const outcome = pending.catch(error => error);
    await turn();
    f.window.topologyRevision = 16;
    if (changed === "generation") {
      f.window.windowGeneration = 4;
      f.core.logicalWindows[0]!.windowGeneration = 4;
    }
    if (changed === "parent") f.window.parentNativeHostId = 3;
    if (changed === "AppKit identity") f.window.appKitIdentity = {
      logicalWindowId: WINDOW, launchGeneration: "replacement", nativeGeneration: 2
    };
    gate.resolve();
    expect(await outcome).toMatchObject({ message: expect.stringContaining("changed its exact native owner") });
    f.disposed();
  });

  it("propagates actor stop while waiting and disposes both bounded observers", async () => {
    const f = fixture(platform);
    const stopped = new Error("exact projection actor stopped");
    f.runtime.settleWindowProjection.mockRejectedValueOnce(stopped);
    await expect(f.read()).rejects.toBe(stopped);
    f.disposed();
  });

  it("disposes both observers when the Core RPC fails", async () => {
    const f = fixture(platform);
    const stopped = new Error("Core stream failed");
    f.readCore.mockRejectedValueOnce(stopped);
    await expect(f.read()).rejects.toBe(stopped);
    f.disposed();
  });

  it("does not use historical progress to repeat a still-unmatched revision", async () => {
    const f = fixture(platform);
    f.readCore.mockImplementationOnce(async () => {
      const gate = deferred();
      f.projections.retain([scope], gate.promise);
      gate.resolve();
      await turn();
      return f.core;
    });
    await expect(f.read()).rejects.toThrow("stale Core/native Chromium fence");
    expect(f.readCore).toHaveBeenCalledTimes(2);
    f.disposed();
  });

  it.each(["tabs", "generation", "target"])("rejects an invalid %s fence despite admitted progress", async changed => {
    const f = fixture(platform);
    const held = deferred();
    f.projections.retain([scope], held.promise);
    if (changed === "tabs") f.window.tabIds.push("forged-tab");
    if (changed === "generation") f.core.logicalWindows[0]!.windowGeneration += 1;
    if (changed === "target") f.window.target.displayId = 9;
    await expect(f.read()).rejects.toThrow("stale Core/native Chromium fence");
    expect(f.runtime.settleWindowProjection).not.toHaveBeenCalled();
    held.resolve();
    f.disposed();
  });

  it("rejects an invalid platform-native host before waiting for its held revision projection", async () => {
    const f = fixture(platform);
    f.window.appKitIdentity = platform === "darwin" ? undefined : {
      logicalWindowId: WINDOW, launchGeneration: "foreign-AppKit", nativeGeneration: 1
    };
    const held = deferred();
    f.projections.retain([scope], held.promise);
    await expect(f.read()).rejects.toThrow("has an invalid platform-native Chromium host");
    expect(f.bridge.settleWindowEvents).not.toHaveBeenCalled();
    expect(f.runtime.settleWindowProjection).not.toHaveBeenCalled();
    expect(f.readCore).toHaveBeenCalledTimes(1);
    held.resolve();
    f.disposed();
  });
});
