import { describe, expect, it } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.each(["macos", "windows"] as const)("%s Role navigation admission", (platform) => {
  it("releases admission for a newer projection while navigation remains pending", async () => {
    const navigation = deferred();
    const subject = harness(async input => {
      await navigation.promise;
      return { roleId: input.roleId, generation: input.generation,
        parentId: input.parent.id, url: input.url };
    }, platform);
    const specification = tab();
    await createTab(subject, specification);
    const execution = await subject.executor.execute(effect("tab-1", {
      type: "embeddedLoadRoles", roles: [{ roleId: "role-1", resolvedEngine: "chromium",
        url: "https://role-1.test/play", zoomFactor: 1 }]
    }));
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing admission continuation");
    expect(subject.executor.snapshot().roles).toEqual([]);
    await expect(subject.executor.execute(effect("tab-1", {
      type: "embeddedLoadRoles", roles: [{ roleId: "role-1", resolvedEngine: "chromium",
        url: "https://role-1.test/play", zoomFactor: 1 }]
    }))).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_ROLE_LOAD_PENDING" });
    let completed = false;
    const terminal = execution.completion.then(() => { completed = true; });
    await subject.executor.execute(effect("window-1", {
      type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1,
      roles: [{ roleId: "role-1", runtime: "embedded", state: "launching",
        owner: { tabId: "tab-1", slotId: "slot-1", generation: 1 } }],
      windows: [{ windowId: "window-1", windowGeneration: 3, topologyRevision: 8,
        tabIds: ["tab-1"], tabPhases: [{ tabId: "tab-1", phase: "activating" }],
        hiddenTabIds: [], activeTabId: "tab-1" }],
      revealWindowIds: [], focusWindowIds: []
    }));
    expect(subject.executor.snapshot().windows[0]?.topologyRevision).toBe(8);
    expect(completed).toBe(false);
    navigation.resolve();
    await terminal;
    expect(completed).toBe(true);
  });

  it("does not resurrect a tab destroyed before navigation completes", async () => {
    const navigation = deferred();
    const subject = harness(async input => {
      await navigation.promise;
      return { roleId: input.roleId, generation: input.generation,
        parentId: input.parent.id, url: input.url };
    }, platform);
    await createTab(subject);
    const execution = await subject.executor.execute(effect("tab-1", {
      type: "embeddedLoadRoles", roles: [{ roleId: "role-1", resolvedEngine: "chromium",
        url: "https://role-1.test/play", zoomFactor: 1 }]
    }));
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing admission continuation");
    const terminal = expect(execution.completion).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_ROLE_LOAD_STALE"
    });
    await subject.executor.execute(effect("tab-1", {
      type: "embeddedDestroyTab", tabId: "tab-1"
    }));
    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    navigation.resolve();
    await terminal;
    expect(subject.executor.snapshot()).toEqual({ windows: [], tabs: [], roles: [], webSurfaces: [] });
  });
});
