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
  it("performs one immediate authoritative snapshot recovery after a failed query", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const snapshot = {
      embeddedRuntimeState: {
        revision: 1,
        capturedAt: "2026-08-03T00:00:00Z",
        windows: [],
        tabs: []
      },
      games: [{ id: "snapshot-game" }],
      gameWindows: [{ id: "snapshot-window" }],
      roles: [{ id: "snapshot-role" }],
      roleStatuses: [{ roleId: "snapshot-role", state: "running" }],
      launchWorkspaces: [{ id: "snapshot-workspace" }],
      displayTopology: {
        revision: 1,
        capturedAt: "2026-08-03T00:00:00Z",
        cause: "snapshot",
        displays: [{ id: 1 }]
      },
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
    await vi.waitFor(() => expect(onGamesChanged).toHaveBeenCalledWith(snapshot.games));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(onGamesChanged).toHaveBeenCalledWith(snapshot.games);
    expect(onRolesChanged).toHaveBeenCalledWith(snapshot.roles);
    expect(onRuntimeChanged).toHaveBeenCalledWith(snapshot.embeddedRuntimeState);
  });
});
