// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

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

describe("Tauri Game Window bridge compensation", () => {
  it("delegates creation to one persistence-only shell operation", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const nativeError = new Error("native window failed");
    invoke.mockRejectedValueOnce(nativeError);
    await installTauriBridgeIfNeeded();
    const onShellError = vi.fn();
    window.rionStudio.onShellError(onShellError);

    await expect(window.rionStudio.createGameWindow({
      name: "Failed window",
      targetDisplay: { id: 1 },
      placement: {
        normalBounds: { x: 0, y: 0, width: 960, height: 640 },
        savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
        presentation: "normal"
      }
    })).rejects.toBe(nativeError);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "createGameWindow",
      args: [expect.objectContaining({ name: "Failed window" })]
    });

    bridgeListeners.get("rion://shell-error")?.({
      payload: { code: "ROLE_ALREADY_RUNNING", message: "The role is already running." }
    });
    expect(onShellError).toHaveBeenCalledWith({
      code: "ROLE_ALREADY_RUNNING",
      message: "The role is already running."
    });
  });
});
