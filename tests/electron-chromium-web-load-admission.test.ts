import { describe, expect, it } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, globalWebProfile, webTab } from "./support/electronChromiumRuntimeEffectFixtures";

function pendingWeb(platform: "macos" | "windows") {
  let resolve!: () => void;
  const navigation = new Promise<void>(done => { resolve = done; });
  const subject = harness(undefined, platform);
  subject.createWebSurface.mockImplementation(async input => {
    await navigation;
    return { surfaceId: input.surfaceId, slotId: input.slotId, generation: input.generation,
      parentId: input.parent.id, url: input.url };
  });
  const specification = webTab();
  const action = effect(specification.tabId, {
    type: "embeddedLoadWebSurfaces", tabId: specification.tabId,
    attemptGeneration: specification.attemptGeneration!, profile: globalWebProfile(),
    surfaces: [{ surfaceId: "web-surface-1", slotId: "web-slot-1",
      url: specification.roles[0]!.web!.startUrl, zoomFactor: specification.roles[0]!.zoomFactor, resolvedEngine: "chromium" }]
  });
  return { subject, specification, action, resolve };
}

describe.each(["macos", "windows"] as const)("%s Web navigation admission", platform => {
  it("admits newer projection and rejects duplicate navigation before readiness", async () => {
    const { subject, specification, action, resolve } = pendingWeb(platform);
    await createTab(subject, specification);
    const execution = await subject.executor.execute(action);
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing Web admission continuation");
    expect(subject.executor.snapshot().webSurfaces).toEqual([]);
    await expect(subject.executor.execute(action)).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_LOAD_PENDING"
    });
    await subject.executor.execute(effect(specification.target.windowId, {
      type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1, roles: [],
      windows: [{ windowId: specification.target.windowId, windowGeneration: 3, topologyRevision: 8,
        tabIds: [specification.tabId], tabPhases: [{ tabId: specification.tabId, phase: "activating" }],
        hiddenTabIds: [], activeTabId: specification.tabId }],
      revealWindowIds: [], focusWindowIds: []
    }));
    expect(subject.executor.snapshot().windows[0]?.topologyRevision).toBe(8);
    expect(subject.executor.snapshot().webSurfaces).toEqual([]);
    resolve();
    await execution.completion;
    expect(subject.executor.snapshot().webSurfaces).toHaveLength(1);
  });

  it("retires an opening Web surface and rejects late readiness without resurrection", async () => {
    const { subject, specification, action, resolve } = pendingWeb(platform);
    await createTab(subject, specification);
    const execution = await subject.executor.execute(action);
    if (!isCoreEffectEventContinuation(execution)) throw new Error("missing Web admission continuation");
    const terminal = expect(execution.completion).rejects.toMatchObject({
      code: "ELECTRON_GLOBAL_WEB_LOAD_STALE"
    });
    await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab", tabId: specification.tabId
    }));
    expect(subject.closeWebSurface).toHaveBeenCalledWith("web-surface-1", 1);
    resolve();
    await terminal;
    expect(subject.executor.snapshot()).toEqual({ windows: [], tabs: [], roles: [], webSurfaces: [] });
  });
});
