// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>()
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { waitForNativeStartup } from "../src/renderer/src/tauri/installTauriBridge";

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockClear();
});

describe("native startup gate", () => {
  it("waits through the state-independent Tauri shell operation", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });

    invoke.mockResolvedValueOnce({ windowsMicaEnabled: true });

    await expect(waitForNativeStartup()).resolves.toEqual({ windowsMicaEnabled: true });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "waitForNativeStartup",
      args: []
    });
  });

  it("does not invoke Tauri outside the desktop runtime", async () => {
    await expect(waitForNativeStartup()).resolves.toEqual({ windowsMicaEnabled: false });

    expect(invoke).not.toHaveBeenCalled();
  });
});
