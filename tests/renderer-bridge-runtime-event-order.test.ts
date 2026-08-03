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
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
  vi.restoreAllMocks();
});

describe("Tauri bridge runtime event ordering", () => {
  it("ignores stale queries, lets native events supersede queries, and handles rejection", async () => {
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
    const superseded = deferred<RuntimeProjection>();
    const rejected = deferred<RuntimeProjection>();
    invoke
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
      .mockImplementationOnce(() => superseded.promise)
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
    superseded.resolve({
      revision: 3,
      capturedAt: "2026-08-03T00:00:03Z",
      tabs: [{ id: "superseded" }],
      windows: []
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRuntimeState).toHaveBeenCalledTimes(2);
    expect(onRuntimeState).toHaveBeenLastCalledWith(native);

    onNativeRuntimeState?.({ payload: {
      revision: 2,
      capturedAt: "2026-08-03T00:00:02Z",
      tabs: [{ id: "stale-native" }],
      windows: []
    } });
    expect(onRuntimeState).toHaveBeenCalledTimes(2);
    const lateSubscriber = vi.fn();
    window.rionStudio.onEmbeddedRuntimeStateChanged(lateSubscriber);
    expect(lateSubscriber).toHaveBeenCalledOnce();
    expect(lateSubscriber).toHaveBeenCalledWith(native);

    onCoreEvents?.({ payload: [{ type: "browserStatuses", statuses: [] }] });
    rejected.reject(new Error("runtime state unavailable"));
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(onRuntimeState).toHaveBeenCalledTimes(2);
  });
});
