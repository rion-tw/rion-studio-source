// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ pinnedItems: [], recentItems: [] })),
  listen: vi.fn(() => Promise.resolve(vi.fn()))
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { installTauriBridgeIfNeeded } from "../src/renderer/src/tauri/installTauriBridge";

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockClear();
  listen.mockClear();
});

describe("quick access bridge", () => {
  it("maps pin, MRU, and clear actions to generated Core commands", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    await installTauriBridgeIfNeeded();
    const role = { kind: "role", id: "role-1" } as const;

    await window.rionStudio.setQuickAccessPinned(role, true);
    await window.rionStudio.recordQuickAccessUse(role);
    await window.rionStudio.clearQuickAccessRecent();

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_core_invoke", {
      command: { type: "quickAccessPinSet", item: role, pinned: true }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_core_invoke", {
      command: { type: "quickAccessRecentRecord", item: role }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_core_invoke", {
      command: { type: "quickAccessRecentClear" }
    });
  });
});
