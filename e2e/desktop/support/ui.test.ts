import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findElement: vi.fn(),
  findElements: vi.fn(),
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
  $$: mocks.findElements,
  browser: mocks.browser,
  expect: vi.fn()
}));

vi.mock("webdriverio", () => ({
  Key: { Ctrl: "Control" }
}));

import { acceptLegalAndSkipFirstRun, ensureEnglishUi, navigate, waitForRoute } from "./ui";

describe("desktop E2E renderer readiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("waits for the async legal gate before accepting and skipping first run", async () => {
    let screen: "first-run" | "legal" | "loading" | "main" = "loading";
    const checkboxClicks = [vi.fn(), vi.fn()];
    const element = (selector: string) => ({
      click: vi.fn(async () => {
        if (selector === "[data-testid='legal-onboarding-continue']") screen = "first-run";
        if (selector === "[data-testid='onboarding-skip']") screen = "main";
      }),
      isExisting: vi.fn(async () => (
        (selector === "[data-testid='legal-onboarding-continue']" && screen === "legal")
        || (selector === "[data-testid='onboarding-skip']" && screen === "first-run")
        || (selector === ".app-main-sidebar" && screen === "main")
      )),
      waitForEnabled: vi.fn().mockResolvedValue(undefined),
      waitForExist: vi.fn().mockResolvedValue(undefined)
    });
    mocks.findElement.mockImplementation(async (selector: string) => element(selector));
    mocks.findElements.mockImplementation(async () => {
      if (screen !== "legal") throw new Error("Agreement checkboxes queried before legal readiness");
      return checkboxClicks.map((click) => ({ click }));
    });
    mocks.browser.waitUntil.mockImplementation(async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await condition()) return true;
        if (screen === "loading") screen = "legal";
      }
      throw new Error("readiness condition timed out");
    });

    await expect(acceptLegalAndSkipFirstRun()).resolves.toBeUndefined();

    expect(checkboxClicks[0]).toHaveBeenCalledOnce();
    expect(checkboxClicks[1]).toHaveBeenCalledOnce();
    expect(screen).toBe("main");
  });

  it("navigates through the renderer router instead of mutating the hash", async () => {
    mocks.browser.executeAsync.mockResolvedValue({ ok: true });
    mocks.browser.execute.mockResolvedValue(true);

    await expect(navigate("/games/new")).resolves.toBeUndefined();

    expect(mocks.browser.executeAsync).toHaveBeenCalledOnce();
    expect(mocks.browser.executeAsync.mock.calls[0]?.[1]).toBe("/games/new");
  });

  it("does not treat an editor child route as its parent list route", async () => {
    vi.stubGlobal("window", { location: { hash: "#/games/new" } });
    mocks.browser.execute.mockImplementation(async (condition, expected) => condition(expected));

    await expect(waitForRoute("/games")).rejects.toThrow("readiness condition timed out");
  });
});
