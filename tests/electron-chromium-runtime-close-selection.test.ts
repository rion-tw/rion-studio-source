import { describe, expect, it } from "vitest";
import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";

describe.each(["macos", "windows"] as const)("%s native tab close selection", (platform) => {
  it("retains the surviving active tab when a background tab is destroyed", async () => {
    const subject = harness(undefined, platform);
    for (const id of ["alpha", "beta", "gamma"]) {
      await createTab(subject, tab(id, "window-1", []));
    }
    expect(subject.executor.snapshot().windows[0]?.activeTabId).toBe("gamma");
    await subject.executor.execute(effect("alpha", {
      type: "embeddedDestroyTab", tabId: "alpha"
    }));
    expect(subject.executor.snapshot().windows[0]).toMatchObject({
      activeTabId: "gamma", tabIds: ["beta", "gamma"]
    });
  });

  it("applies an explicit Core successor when the active tab is destroyed", async () => {
    const subject = harness(undefined, platform);
    for (const id of ["alpha", "beta", "gamma"]) {
      await createTab(subject, tab(id, "window-1", []));
    }
    await subject.executor.execute(effect("gamma", {
      type: "embeddedDestroyTab", tabId: "gamma", nextActiveTabId: "alpha"
    }));
    expect(subject.executor.snapshot().windows[0]).toMatchObject({
      activeTabId: "alpha", tabIds: ["alpha", "beta"]
    });
  });
});
