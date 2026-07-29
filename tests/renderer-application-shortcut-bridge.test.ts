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

describe("application shortcut bridge", () => {
  it("routes typed commands through the Tauri shell", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });

    await installTauriBridgeIfNeeded();
    await window.rionStudio.executeApplicationShortcut("zoomIn");

    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "executeApplicationShortcut",
      args: ["zoomIn"]
    });
  });
});
