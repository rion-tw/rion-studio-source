import { describe, expect, it, vi } from "vitest";

import {
  isPlaywrightUserDataInUseError,
  withPlaywrightUserDataLockRetry
} from "../src/main/browser/playwrightUserDataRetry";
import { BrowserUserDataLockTimeoutError } from "../src/main/browser/BrowserUserDataLockWatcher";

describe("playwright user data lock retry", () => {
  it("retries Playwright user-data-in-use errors", async () => {
    let now = 0;
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("browserType.launchPersistentContext: Opening in existing browser session."))
      .mockResolvedValue("ok");

    await expect(
      withPlaywrightUserDataLockRetry(operation, {
        timeoutMs: 50,
        intervalMs: 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-lock errors", async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("navigation failed"));

    await expect(
      withPlaywrightUserDataLockRetry(operation, {
        timeoutMs: 50,
        intervalMs: 5,
        sleep: async () => undefined
      })
    ).rejects.toThrow("navigation failed");

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("throws a friendly timeout after repeated lock errors", async () => {
    let now = 0;
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("browserType.launchPersistentContext: Opening in existing browser session."));

    await expect(
      withPlaywrightUserDataLockRetry(operation, {
        timeoutMs: 20,
        intervalMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        }
      })
    ).rejects.toBeInstanceOf(BrowserUserDataLockTimeoutError);
  });

  it("detects the known Chromium user data lock messages", () => {
    expect(isPlaywrightUserDataInUseError(new Error("Opening in existing browser session."))).toBe(true);
    expect(isPlaywrightUserDataInUseError(new Error("user data directory is already in use"))).toBe(true);
    expect(isPlaywrightUserDataInUseError(new Error("navigation failed"))).toBe(false);
  });
});
