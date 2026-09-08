import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  select: vi.fn(), waitUntil: vi.fn(), options: { waitforTimeout: 10_000 }
}));
vi.mock("@wdio/globals", () => ({
  $: driver.select,
  browser: driver,
  expect: (element: Promise<{ getText(): Promise<string | null> }>) => ({
    toHaveText: async (text: string) => expect(await (await element).getText()).toBe(text),
    toBeDisplayed: async () => undefined,
    not: { toExist: async () => undefined }
  })
}));

import { assertSeedPrimaryPage } from "../e2e/desktop/support/primary-navigation";

function installReplacementFixture(platform: "darwin" | "win32", replacementText: string) {
  const headingIds: string[] = [];
  driver.select.mockImplementation(async (selector: string) => {
    const heading = selector === ".app-page h2";
    const obsolete = heading && headingIds.length === 0;
    if (heading) headingIds.push(`${platform}-${obsolete ? "old-route" : "active-route"}`);
    return {
      isExisting: async () => true,
      getText: async () => obsolete ? null : replacementText
    };
  });
  driver.waitUntil.mockImplementation(async (predicate: () => Promise<boolean>) => {
    // Two authoritative DOM observations; no fake elapsed-time success.
    for (let observation = 0; observation < 2; observation += 1) {
      if (await predicate()) return true;
    }
    throw new Error("Active route heading did not match within the unchanged boundary");
  });
  return headingIds;
}

beforeEach(() => vi.clearAllMocks());
describe.each(["darwin", "win32"] as const)("%s primary navigation", (platform) => {
  it("requeries the active heading after lazy navigation replaces the old node", async () => {
    const headingIds = installReplacementFixture(platform, "No roles yet");
    await assertSeedPrimaryPage("/roles");
    expect(headingIds.slice(0, 2)).toEqual([`${platform}-old-route`, `${platform}-active-route`]);
    expect(driver.waitUntil).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      timeout: 10_000, interval: 100
    }));
  });
  it("still fails when the replacement has the wrong heading", async () => {
    installReplacementFixture(platform, "No workspaces yet");
    await expect(assertSeedPrimaryPage("/roles")).rejects.toThrow();
  });
});
