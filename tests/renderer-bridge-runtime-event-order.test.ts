// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen, bridgeListeners } = vi.hoisted(() => {
  const bridgeListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    bridgeListeners,
    invoke: vi.fn(),
    listen: vi.fn(async (
      event: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      bridgeListeners.set(event, callback);
      return vi.fn();
    })
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { installTauriBridgeIfNeeded } from "../src/renderer/src/tauri/installTauriBridge";

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
  vi.restoreAllMocks();
});

describe("Tauri bridge runtime event ordering", () => {
  it("revision-fences concurrent native events and queries, and handles rejection", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    type RuntimeProjection = {
      revision: number;
      capturedAt: string;
      tabs: unknown[];
      windows: unknown[];
    };
    const older = deferred<RuntimeProjection>();
    const newer = deferred<RuntimeProjection>();
    const newerThanNative = deferred<RuntimeProjection>();
    const rejected = deferred<RuntimeProjection>();
    invoke
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
      .mockImplementationOnce(() => newerThanNative.promise)
      .mockImplementationOnce(() => rejected.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await installTauriBridgeIfNeeded();
    const onRuntimeState = vi.fn();
    window.rionStudio.onEmbeddedRuntimeStateChanged(onRuntimeState);
    const onCoreEvents = bridgeListeners.get("rion://core-events");
    const onNativeRuntimeState = bridgeListeners.get("rion://runtime-state");

    onCoreEvents?.({ payload: [{ type: "browserStatuses", statuses: [] }] });
    onCoreEvents?.({ payload: [{ type: "browserStatuses", statuses: [] }] });
    newer.resolve({
      revision: 2,
      capturedAt: "2026-08-03T00:00:02Z",
      tabs: [{ id: "newer" }],
      windows: []
    });
    await vi.waitFor(() => expect(onRuntimeState).toHaveBeenCalledOnce());
    older.resolve({
      revision: 1,
      capturedAt: "2026-08-03T00:00:01Z",
      tabs: [{ id: "older" }],
      windows: []
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRuntimeState).toHaveBeenCalledOnce();

    onCoreEvents?.({ payload: [{ type: "browserStatuses", statuses: [] }] });
    const native = {
      revision: 4,
      capturedAt: "2026-08-03T00:00:04Z",
      tabs: [{ id: "native" }],
      windows: []
    };
    onNativeRuntimeState?.({ payload: native });
    const queryAfterNative = {
      revision: 5,
      capturedAt: "2026-08-03T00:00:05Z",
      tabs: [{ id: "query-after-native" }],
      windows: []
    };
    newerThanNative.resolve(queryAfterNative);
    await vi.waitFor(() => expect(onRuntimeState).toHaveBeenCalledTimes(3));
    expect(onRuntimeState).toHaveBeenLastCalledWith(queryAfterNative);

    onNativeRuntimeState?.({ payload: {
      revision: 2,
      capturedAt: "2026-08-03T00:00:02Z",
      tabs: [{ id: "stale-native" }],
      windows: []
    } });
    expect(onRuntimeState).toHaveBeenCalledTimes(3);
    const lateSubscriber = vi.fn();
    window.rionStudio.onEmbeddedRuntimeStateChanged(lateSubscriber);
    expect(lateSubscriber).toHaveBeenCalledOnce();
    expect(lateSubscriber).toHaveBeenCalledWith(queryAfterNative);

    onCoreEvents?.({ payload: [{ type: "browserStatuses", statuses: [] }] });
    rejected.reject(new Error("runtime state unavailable"));
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(onRuntimeState).toHaveBeenCalledTimes(3);

    const onWindowState = vi.fn();
    window.rionStudio.onCurrentWindowStateChanged(onWindowState);
    const nativeWindowState = bridgeListeners.get("rion://window-state");
    const state = (revision: number, fullscreen: boolean) => ({
      revision,
      capturedAt: `2026-08-03T00:00:0${revision}Z`,
      windowId: "main",
      windowGeneration: 4,
      lifecycleEpoch: 0,
      visible: true,
      minimized: false,
      maximized: false,
      fullscreen,
      focused: true
    });

    nativeWindowState?.({ payload: state(2, true) });
    nativeWindowState?.({ payload: state(1, false) });
    expect(onWindowState).toHaveBeenCalledOnce();
    expect(onWindowState).toHaveBeenLastCalledWith(state(2, true));

    const lateWindowSubscriber = vi.fn();
    window.rionStudio.onCurrentWindowStateChanged(lateWindowSubscriber);
    expect(lateWindowSubscriber).toHaveBeenCalledOnce();
    expect(lateWindowSubscriber).toHaveBeenCalledWith(state(2, true));
  });
});
