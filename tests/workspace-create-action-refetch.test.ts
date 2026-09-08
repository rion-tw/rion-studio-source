import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  select: vi.fn(), waitUntil: vi.fn(), execute: vi.fn(), options: { waitforInterval: 100 }
}));
vi.mock("@wdio/globals", () => ({ $: driver.select, $$: vi.fn(), browser: driver, expect: vi.fn() }));
import { clickWorkspaceCreateAction } from "../e2e/desktop/support/workspace-create-action";

beforeEach(() => vi.clearAllMocks());
describe.each(["darwin", "win32"] as const)("%s workspace create readiness", platform => {
  it("refetches the current action when an obsolete handle reports false without a stale error", async () => {
    const oldClick = vi.fn();
    const currentClick = vi.fn();
    let observations = 0;
    driver.select.mockImplementation(async (selector: string) => {
      const exists = selector === "button=Create workspace";
      const obsolete = observations < 2;
      return {
        elementId: `${platform}-${obsolete ? "old" : "current"}`,
        isExisting: async () => exists,
        isClickable: async () => exists && !obsolete,
        waitForClickable: async () => { throw new Error("obsolete WebElement remains non-clickable"); },
        click: obsolete ? oldClick : currentClick
      };
    });
    driver.waitUntil.mockImplementation(async (predicate: () => Promise<boolean>) => {
      for (observations = 1; observations <= 2; observations++) if (await predicate()) return;
      throw new Error("readiness boundary failed");
    });
    await clickWorkspaceCreateAction();
    expect(currentClick).toHaveBeenCalledOnce();
    expect(oldClick).not.toHaveBeenCalled();
    expect(driver.waitUntil).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      timeout: 10_000, interval: 100
    }));
  });

  it.each(["absent", "blocked"])("still fails for a current %s action", async state => {
    const click = vi.fn();
    const failure = new Error("original clickable deadline");
    driver.select.mockResolvedValue({
      elementId: `${platform}-current`, isExisting: async () => state !== "absent",
      isClickable: async () => false, waitForClickable: async () => { throw failure; }, click
    });
    driver.execute.mockResolvedValue({ route: "#/workspaces", controls: [] });
    driver.waitUntil.mockImplementation(async (predicate: () => Promise<boolean>) => {
      expect(await predicate()).toBe(false);
      expect(await predicate()).toBe(false);
      throw failure;
    });
    await expect(clickWorkspaceCreateAction()).rejects.toHaveProperty("cause", failure);
    expect(click).not.toHaveBeenCalled();
  });

  it("preserves both readiness and diagnostic errors without clicking", async () => {
    const primary = new Error("original readiness failure");
    const diagnostic = new Error("current document unavailable");
    driver.waitUntil.mockRejectedValue(primary);
    driver.execute.mockRejectedValue(diagnostic);
    const error = await clickWorkspaceCreateAction().catch(error => error as AggregateError);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected failed readiness");
    expect(error.cause).toBe(primary);
    expect(error.errors).toEqual([primary, diagnostic]);
  });
});
