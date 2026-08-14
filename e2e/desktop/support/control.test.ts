import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  executeAsync: vi.fn()
}));

vi.mock("@wdio/globals", () => ({
  browser: {
    executeAsync: mocks.executeAsync,
    tauri: { execute: mocks.execute }
  }
}));

import { closeWindowAndWait, type DesktopE2eWindowSnapshot } from "./control";

describe("desktop E2E native window controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RION_STUDIO_E2E_SESSION_TOKEN", "test-session-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fences close completion from before the native control is submitted", async () => {
    const snapshot = {
      windowGeneration: 3,
      windowId: "window-a"
    } as DesktopE2eWindowSnapshot;
    const destroyed = {
      details: {},
      generation: 3,
      kind: "window-destroyed",
      sequence: 12,
      timestamp: "2026-08-13T15:39:13.968201+00:00",
      windowId: "window-a"
    };
    mocks.execute
      .mockResolvedValueOnce({ latestSequence: 10 })
      .mockResolvedValueOnce({ submitted: true });
    mocks.executeAsync.mockResolvedValueOnce({ ok: true, value: destroyed });

    await expect(closeWindowAndWait(snapshot)).resolves.toEqual(destroyed);

    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.executeAsync).toHaveBeenCalledTimes(1);
    expect(mocks.executeAsync.mock.calls[0]?.[2]).toEqual({
      afterSequence: 10,
      kind: "window-destroyed",
      minimumGeneration: 3,
      timeoutMs: 45_000,
      windowId: "window-a"
    });
  });
});
