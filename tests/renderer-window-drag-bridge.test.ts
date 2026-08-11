// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn((): Promise<unknown> => Promise.resolve()),
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

describe("main window chrome bridge", () => {
  it("routes focus-neutral drag, maximize, minimize, and close through the typed shell", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    invoke.mockResolvedValue({ status: "applied" });

    await installTauriBridgeIfNeeded();
    await window.rionStudio.minimizeCurrentWindow();
    await window.rionStudio.startCurrentWindowDrag();
    await window.rionStudio.toggleCurrentWindowMaximize();
    await window.rionStudio.requestCurrentWindowClose();

    expect(invoke).toHaveBeenNthCalledWith(1, "rion_shell_invoke", {
      operation: "minimizeCurrentWindow",
      args: []
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "rion_shell_invoke", {
      operation: "startCurrentWindowDrag",
      args: []
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "rion_shell_invoke", {
      operation: "toggleCurrentWindowMaximize",
      args: []
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "rion_shell_invoke", {
      operation: "requestCurrentWindowClose",
      args: []
    });
  });
});
