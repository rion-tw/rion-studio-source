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
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listen.mockClear();
});

describe("renderer log bridge", () => {
  it("contains a rejected log write instead of creating another unhandled rejection", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    invoke.mockRejectedValueOnce(new Error("log database unavailable"));

    await installTauriBridgeIfNeeded();
    window.rionStudio.reportRendererLog({
      event: "unhandled_rejection",
      message: "original failure"
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("rion_core_invoke", {
      command: {
        type: "logsCapture",
        entries: [{
          event: "unhandled_rejection",
          level: "error",
          message: "original failure",
          source: "renderer"
        }]
      }
    });
  });
});
