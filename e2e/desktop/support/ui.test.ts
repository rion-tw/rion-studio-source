import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findElement: vi.fn(),
  browser: {
    execute: vi.fn(),
    executeAsync: vi.fn(),
    getTimeouts: vi.fn(),
    refresh: vi.fn(),
    setTimeout: vi.fn(),
    waitUntil: vi.fn()
  }
}));

vi.mock("@wdio/globals", () => ({
  $: mocks.findElement,
  $$: vi.fn(),
  browser: mocks.browser,
  expect: vi.fn()
}));

vi.mock("webdriverio", () => ({
  Key: { Ctrl: "Control" }
}));

import { ensureEnglishUi, navigate } from "./ui";

describe("desktop E2E renderer readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findElement.mockResolvedValue({
      isExisting: vi.fn().mockResolvedValue(false)
    });
    mocks.browser.getTimeouts.mockResolvedValue({ script: 55_000 });
    mocks.browser.refresh.mockResolvedValue(undefined);
    mocks.browser.setTimeout.mockResolvedValue(undefined);
    mocks.browser.waitUntil.mockImplementation(async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (await condition()) return true;
      }
      throw new Error("readiness condition timed out");
    });
  });

  it("refreshes through WebDriver and retries a reclaimed script completion", async () => {
    mocks.browser.execute
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("Script execution timed out"))
      .mockResolvedValueOnce(true);

    await expect(ensureEnglishUi()).resolves.toBeUndefined();

    expect(mocks.browser.refresh).toHaveBeenCalledOnce();
    expect(mocks.browser.execute).toHaveBeenCalledTimes(4);
    expect(mocks.browser.setTimeout.mock.calls).toEqual([
      [{ script: 5_000 }],
      [{ script: 55_000 }],
      [{ script: 5_000 }],
      [{ script: 55_000 }]
    ]);
  });

  it("navigates through the renderer router instead of mutating the hash", async () => {
    mocks.browser.executeAsync.mockResolvedValue({ ok: true });
    mocks.browser.execute.mockResolvedValue(true);

    await expect(navigate("/games/new")).resolves.toBeUndefined();

    expect(mocks.browser.executeAsync).toHaveBeenCalledOnce();
    expect(mocks.browser.executeAsync.mock.calls[0]?.[1]).toBe("/games/new");
  });
});
