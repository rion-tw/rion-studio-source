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

describe("runtime theme bridge", () => {
  it("routes only resolved themes through the typed core command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });

    await installTauriBridgeIfNeeded();
    await window.rionStudio.setRuntimeTheme("dark");

    expect(invoke).toHaveBeenCalledWith("rion_core_invoke", {
      command: { type: "runtimeThemeSet", theme: "dark" }
    });
  });
});
