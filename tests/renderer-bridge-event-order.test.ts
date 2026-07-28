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
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
});

describe("Tauri bridge state event ordering", () => {
  it("does not emit an older collection query after a newer revision completes", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const older = deferred<unknown[]>();
    const newer = deferred<unknown[]>();
    invoke
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    await installTauriBridgeIfNeeded();
    const onGamesChanged = vi.fn();
    window.rionStudio.onGamesChanged(onGamesChanged);
    const onCoreEvents = bridgeListeners.get("rion://core-events");
    expect(onCoreEvents).toBeDefined();

    onCoreEvents?.({
      payload: [{
        type: "stateChanged",
        revision: 10,
        changedCollections: ["games"]
      }]
    });
    onCoreEvents?.({
      payload: [{
        type: "stateChanged",
        revision: 11,
        changedCollections: ["games"]
      }]
    });
    newer.resolve([{ id: "newer" }]);
    await newer.promise;
    await vi.waitFor(() => expect(onGamesChanged).toHaveBeenCalledOnce());
    expect(onGamesChanged).toHaveBeenLastCalledWith([{ id: "newer" }]);

    older.resolve([{ id: "older" }]);
    await older.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onGamesChanged).toHaveBeenCalledOnce();

    invoke.mockResolvedValue([{ id: "latest" }]);
    onCoreEvents?.({
      payload: [{
        type: "stateChanged",
        revision: 13,
        changedCollections: ["games"]
      }]
    });
    await vi.waitFor(() => expect(onGamesChanged).toHaveBeenCalledTimes(2));
    onCoreEvents?.({
      payload: [{
        type: "stateChanged",
        revision: 12,
        changedCollections: ["games"]
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(onGamesChanged).toHaveBeenLastCalledWith([{ id: "latest" }]);
  });
});
