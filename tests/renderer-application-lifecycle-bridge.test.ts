// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationLifecycleStatusRecord } from "../src/shared/generated";

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

afterEach(() => {
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
});

describe("application lifecycle bridge", () => {
  it("returns and emits revisioned lifecycle status", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    const status: ApplicationLifecycleStatusRecord = {
      revision: 8,
      capturedAt: "2026-08-03T01:00:00Z",
      lifecycleEpoch: 3,
      state: "resuming",
      reason: "windows-power-resume",
      platform: "windows"
    };
    invoke.mockResolvedValue(status);
    await installTauriBridgeIfNeeded();
    await expect(window.rionStudio.getApplicationLifecycleStatus()).resolves.toEqual(status);

    const onStatus = vi.fn();
    window.rionStudio.onApplicationLifecycleChanged(onStatus);
    bridgeListeners.get("rion://application-lifecycle")?.({ payload: status });
    expect(onStatus).toHaveBeenCalledWith(status);
  });
});
