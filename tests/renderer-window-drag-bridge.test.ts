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

describe("main window drag bridge", () => {
  it("routes drag and maximize requests through the typed Tauri shell bridge", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });

    await installTauriBridgeIfNeeded();
    await window.rionStudio.startCurrentWindowDrag();
    await window.rionStudio.toggleCurrentWindowMaximize();

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_shell_invoke", {
      operation: "startCurrentWindowDrag",
      args: []
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_shell_invoke", {
      operation: "toggleCurrentWindowMaximize",
      args: []
    });
  });
});
