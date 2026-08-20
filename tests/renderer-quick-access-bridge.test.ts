// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ pinnedItems: [], recentItems: [] })),
  listen: vi.fn((
    _event: string,
    _callback: (event: { payload: never }) => void
  ) => Promise.resolve(vi.fn()))
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
  it("maps preferences and presentation requests to their owning boundaries", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    await installTauriBridgeIfNeeded();
    const role = { kind: "role", id: "role-1" } as const;

    await window.rionStudio.setQuickAccessPinned(role, true);
    await window.rionStudio.recordQuickAccessUse(role);
    await window.rionStudio.clearQuickAccessRecent();
    await window.rionStudio.consumePendingQuickAccessRequest();
    await window.rionStudio.presentQuickAccessRequest("request-1");
    await window.rionStudio.resolveQuickAccessRequest("request-1", "cancel");

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_core_invoke", {
      command: { type: "quickAccessPinSet", item: role, pinned: true }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_core_invoke", {
      command: { type: "quickAccessRecentRecord", item: role }
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_core_invoke", {
      command: { type: "quickAccessRecentClear" }
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "rion_shell_invoke", {
      operation: "consumePendingQuickAccessRequest",
      args: []
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "rion_shell_invoke", {
      operation: "presentQuickAccessRequest",
      args: ["request-1"]
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "rion_shell_invoke", {
      operation: "resolveQuickAccessRequest",
      args: ["request-1", "cancel"]
    });
    const callback = vi.fn();
    window.rionStudio.onQuickAccessRequested(callback);
    const registration = listen.mock.calls.find(
      ([event]) => event === "rion://quick-access-request"
    );
    expect(registration).toBeDefined();
    registration?.[1]({ payload: { requestId: "request-2" } as never });
    expect(callback).toHaveBeenCalledWith({ requestId: "request-2" });
  });
});
