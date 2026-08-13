import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browser: {
    execute: vi.fn(),
    getTimeouts: vi.fn(),
    setTimeout: vi.fn(),
    waitUntil: vi.fn()
  }
}));

vi.mock("@wdio/globals", () => ({
  $: vi.fn(),
  $$: vi.fn(),
  browser: mocks.browser,
  expect: vi.fn()
}));

vi.mock("webdriverio", () => ({
  Key: { Ctrl: "Control" }
}));

import { ensureEnglishUi } from "./ui";

describe("desktop E2E renderer readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.browser.getTimeouts.mockResolvedValue({ script: 55_000 });
    mocks.browser.setTimeout.mockResolvedValue(undefined);
    mocks.browser.waitUntil.mockImplementation(async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (await condition()) return true;
      }
      throw new Error("readiness condition timed out");
    });
  });

  it("retries a reclaimed WebKit script completion after the English reload", async () => {
    mocks.browser.execute
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Script execution timed out"))
      .mockResolvedValueOnce(true);

    await expect(ensureEnglishUi()).resolves.toBeUndefined();

    expect(mocks.browser.execute).toHaveBeenCalledTimes(5);
    expect(mocks.browser.setTimeout.mock.calls).toEqual([
      [{ script: 5_000 }],
      [{ script: 55_000 }],
      [{ script: 5_000 }],
      [{ script: 55_000 }]
    ]);
  });
});
