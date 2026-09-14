import { projectFencedRolePlaceholderSlots } from "../src/electron/main/chromiumRuntimeRolePlaceholderProjection";
import { describe, expect, it } from "vitest";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { observeRuntimeEffect, runtimeOperationEvidence, setRuntimeOperationJournalSink } from "../src/electron/main/runtimeOperationJournal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("tab lifecycle isolation", () => {
  it.each(["macos", "windows"] as const)("fences a late closed load while another window completes on %s", async platform => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const subject = harness(async input => {
      if (input.roleId === "role-b") { entered.resolve(); await release.promise; }
      return { roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url };
    }, platform);
    const b = tab("tab-b", "window-b", ["role-b"]);
    await createTab(subject, b);
    const pending = loadRoles(subject, b);
    const failed = expect(pending).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_ROLE_LOAD_STALE" });
    await entered.promise;
    const close = await subject.executor.execute(effect(b.tabId, {
      type: "embeddedDestroyTab", tabId: b.tabId, attemptGeneration: b.attemptGeneration
    }));
    if (isCoreEffectEventContinuation(close)) await close.completion;
    const c = tab("tab-c", "window-c", ["role-c"]);
    await createTab(subject, c);
    await loadRoles(subject, c);
    expect(subject.executor.snapshot().roles.map(role => role.roleId)).toEqual(["role-c"]);
    release.resolve();
    await failed;
    expect(subject.executor.snapshot().tabs.map(candidate => candidate.tabId)).toEqual(["tab-c"]);
    expect(subject.focusVisible).not.toHaveBeenCalledWith("role-b", expect.anything());
    await expect(createTab(subject, b)).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_TAB_RETIRED" });
    await subject.executor.dispose();
  });

  it.each(["macos", "windows"] as const)("keeps a retiring role out of native visibility projections on %s", async platform => {
    const subject = harness(undefined, platform);
    const b = tab("tab-b", "window-b", ["role-b"]);
    await createTab(subject, b);
    await loadRoles(subject, b);
    const entered = deferred<void>();
    const released = deferred<boolean>();
    subject.closeRole.mockImplementationOnce(() => { entered.resolve(); return released.promise; });
    const closing = await subject.executor.execute(effect("role-b", {
      type: "embeddedDestroyRole", roleId: "role-b"
    }));
    await entered.promise;
    subject.setVisible.mockClear();
    const c = tab("tab-c", "window-b", ["role-c"]);
    await createTab(subject, c);
    await loadRoles(subject, c);
    expect(subject.setVisible.mock.calls.some(([roleId]) => roleId === "role-b")).toBe(false);
    released.resolve(true);
    if (isCoreEffectEventContinuation(closing)) await closing.completion;
    await subject.executor.dispose();
  });

  it.each(["macos", "windows"] as const)("retains the role reservation when release is unconfirmed on %s", async platform => {
    const subject = harness(async () => { throw new Error("navigation failed"); }, platform);
    subject.closeRole.mockRejectedValue(new Error("release unknown"));
    const b = tab("tab-b", "window-b", ["role-b"]);
    await createTab(subject, b);
    await expect(loadRoles(subject, b)).rejects.toThrow("navigation failed");
    await expect(loadRoles(subject, b)).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_ROLE_LOAD_PENDING" });
    expect(subject.createSurface).toHaveBeenCalledTimes(1);
    subject.closeRole.mockResolvedValue(true);
    const close = await subject.executor.execute(effect(b.tabId, {
      type: "embeddedDestroyTab", tabId: b.tabId, attemptGeneration: b.attemptGeneration
    }));
    if (isCoreEffectEventContinuation(close)) await close.completion;
    await subject.executor.dispose();
  });

  it("ignores unrelated and stale ownership phases while applying the exact current window", () => {
    const a = { windowId: "a", specification: tab("tab-a", "a") };
    const b = { windowId: "b", specification: tab("tab-b", "b") };
    const originalA = a.specification;
    const originalB = b.specification;
    const tabs = new Map([["tab-a", a], ["tab-b", b]]);
    const windows = new Map([["a", { windowGeneration: 1, topologyRevision: 10 }],
      ["b", { windowGeneration: 1, topologyRevision: 20 }]]);
    projectFencedRolePlaceholderSlots(tabs as never, [], windows as never,
      [{ windowId: "a", windowGeneration: 1, topologyRevision: 9 }] as never);
    expect(a.specification).toBe(originalA);
    expect(b.specification).toBe(originalB);
    projectFencedRolePlaceholderSlots(tabs as never, [], windows as never,
      [{ windowId: "a", windowGeneration: 1, topologyRevision: 10 }] as never);
    expect(a.specification).not.toBe(originalA);
    expect(b.specification).toBe(originalB);
  });

  it("bounds journal evidence, retains identity fences, and tolerates a failed log sink", () => {
    setRuntimeOperationJournalSink(() => { throw new Error("log store unavailable"); });
    const request = effect("tab-b", { type: "embeddedCreateTab", tab: tab("tab-b", "window-b") });
    for (let i = 0; i < 520; i++) observeRuntimeEffect(request, "queued");
    setRuntimeOperationJournalSink(undefined);
    const journal = runtimeOperationEvidence();
    expect(journal.entries).toHaveLength(journal.capacity);
    expect(journal.droppedCount).toBeGreaterThanOrEqual(8);
    expect(journal.entries.at(-1)).toMatchObject({
      effectId: request.effectId, operationId: request.operationId,
      fences: { tabId: "tab-b", attemptGeneration: "tab-b-attempt-1", "target.windowId": "window-b" }
    });
    expect(JSON.stringify(journal)).not.toContain("https:");
  });
});
