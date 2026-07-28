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

afterEach(() => {
  vi.useRealTimers();
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
});

describe("Tauri bridge collection refresh recovery", () => {
  it("retries a failed query and falls back to an authoritative app snapshot", async () => {
    vi.useFakeTimers();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const snapshot = {
      embeddedRuntimeState: { windows: [], tabs: [] },
      games: [{ id: "snapshot-game" }],
      gameWindows: [{ id: "snapshot-window" }],
      roles: [{ id: "snapshot-role" }],
      roleStatuses: [{ roleId: "snapshot-role", state: "running" }],
      launchWorkspaces: [{ id: "snapshot-workspace" }],
      displays: [{ id: 1 }],
      macros: [{ id: "snapshot-macro" }],
      macroStatuses: [{ macroId: "snapshot-macro" }]
    };
    invoke.mockImplementation((_command: string, args?: { command?: { type?: string }; operation?: string }) => {
      if (args?.command?.type === "gamesList") {
        return Promise.reject(new Error("temporary query failure"));
      }
      if (args?.operation === "appSnapshot") return Promise.resolve(snapshot);
      return Promise.reject(new Error("unexpected invocation"));
    });

    await installTauriBridgeIfNeeded();
    const onGamesChanged = vi.fn();
    const onRolesChanged = vi.fn();
    const onRuntimeChanged = vi.fn();
    window.rionStudio.onGamesChanged(onGamesChanged);
    window.rionStudio.onRolesChanged(onRolesChanged);
    window.rionStudio.onEmbeddedRuntimeStateChanged(onRuntimeChanged);

    bridgeListeners.get("rion://core-events")?.({
      payload: [{
        type: "stateChanged",
        revision: 1,
        changedCollections: ["games"]
      }]
    });
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(4);
    expect(onGamesChanged).toHaveBeenCalledWith(snapshot.games);
    expect(onRolesChanged).toHaveBeenCalledWith(snapshot.roles);
    expect(onRuntimeChanged).toHaveBeenCalledWith(snapshot.embeddedRuntimeState);
  });
});
