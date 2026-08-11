// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
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

describe("runtime launch destination bridge", () => {
  it("omits automatic destination args and forwards explicit typed requests", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    await installTauriBridgeIfNeeded();

    await window.rionStudio.launchRole("role-main");
    await window.rionStudio.launchRole("role-main", {
      kind: "game-window",
      windowId: "window-main"
    });
    await window.rionStudio.launchWorkspace("workspace-main", { kind: "new-window" });

    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "launchRole",
      args: ["role-main"]
    });
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "launchRole",
      args: ["role-main", { kind: "game-window", windowId: "window-main" }]
    });
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "launchWorkspace",
      args: ["workspace-main", { kind: "new-window" }]
    });
  });
});
