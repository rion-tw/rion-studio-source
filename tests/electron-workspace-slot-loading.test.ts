import { describe, expect, it } from "vitest";
import type { CoreEffectRequest, WorkspaceSlotLoadRecord } from "../src/shared/generated";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, globalWebProfile, mixedTab } from "./support/electronChromiumRuntimeEffectFixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function plan(): Extract<CoreEffectRequest["action"], { type: "embeddedLoadWorkspaceSlots" }> {
  const specification = mixedTab();
  return {
    type: "embeddedLoadWorkspaceSlots", tabId: specification.tabId, attemptGeneration: specification.attemptGeneration!, profile: globalWebProfile(),
    roles: specification.roles.filter((view) => !view.web).map((view) => ({
      roleId: view.role.id, resolvedEngine: "chromium", url: view.role.launchUrl, zoomFactor: view.zoomFactor
    })),
    surfaces: specification.slots.filter((slot) => slot.web).map((slot) => ({
      surfaceId: slot.role.id, slotId: slot.slotId, resolvedEngine: "chromium", url: slot.role.launchUrl, zoomFactor: slot.zoomFactor
    }))
  };
}

for (const platform of ["macos", "windows"] as const) describe(`workspace slot loads on ${platform}`, () => {
  it("reveals a ready Website while the Role still awaits its exact native event", async () => {
    const gate = deferred<void>();
    const webReady = deferred<void>();
    const subject = harness(async (input) => {
      await gate.promise;
      return { roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url };
    }, platform);
    subject.reportSlotLoad.mockImplementation(async (record: WorkspaceSlotLoadRecord) => {
      if (record.surfaceId === "web-surface-1" && record.phase === "ready") webReady.resolve();
      return { ...record, revision: record.revision + 1 };
    });
    const specification = mixedTab();
    await createTab(subject, specification);
    const run = await subject.executor.execute(effect(specification.tabId, plan()));
    expect(isCoreEffectEventContinuation(run)).toBe(true);
    if (!isCoreEffectEventContinuation(run)) throw new Error("missing event continuation");
    await webReady.promise;
    expect(subject.createSurface).toHaveBeenCalledTimes(1);
    expect(subject.createWebSurface).toHaveBeenCalledTimes(1);
    expect(subject.reportSlotLoad.mock.calls.some(([record]) => record.surfaceId === "role-1" && record.phase === "ready")).toBe(false);
    expect(subject.closeRole).not.toHaveBeenCalled();
    gate.resolve();
    await run.completion;
    expect(subject.hosts[0]!.applyWorkspaceSlotLoads).toHaveBeenLastCalledWith(specification.tabId, []);
  });

  it("keeps the healthy Web surface and retries only a failed Role after confirmed cleanup", async () => {
    const subject = harness(async () => { throw new Error("classified initial load failure"); }, platform);
    const specification = mixedTab();
    await createTab(subject, specification);
    const run = await subject.executor.execute(effect(specification.tabId, plan()));
    if (!isCoreEffectEventContinuation(run)) throw new Error("missing event continuation");
    await run.completion;
    const failureCall = subject.reportSlotLoad.mock.calls.find(([record]) => record.phase === "failed")!;
    expect(failureCall[0]).toMatchObject({ surfaceId: "role-1", retryable: true });
    expect(subject.closeWebSurface).not.toHaveBeenCalled();
    subject.createSurface.mockImplementation(async (input) => ({
      roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url
    }));
    const admitted: WorkspaceSlotLoadRecord = { ...failureCall[0], phase: "loading", retryable: false,
      loadId: "retry-load", revision: failureCall[0].revision + 2, surfaceGeneration: 0 };
    const retry = await subject.executor.execute(effect(specification.tabId, { type: "embeddedRetryWorkspaceSlot", record: admitted }));
    if (!isCoreEffectEventContinuation(retry)) throw new Error("missing retry continuation");
    await retry.completion;
    expect(subject.createSurface).toHaveBeenCalledTimes(2);
    expect(subject.createWebSurface).toHaveBeenCalledTimes(1);
    expect(subject.closeWebSurface).not.toHaveBeenCalled();
    expect(subject.reportSlotLoad).toHaveBeenLastCalledWith(expect.objectContaining({
      surfaceId: "role-1", surfaceGeneration: 2, phase: "ready", loadId: "retry-load"
    }));
  });

  it("keeps a Role ready when the Website fails independently", async () => {
    const subject = harness(undefined, platform);
    subject.createWebSurface.mockRejectedValue(new Error("website navigation failed"));
    const specification = mixedTab();
    await createTab(subject, specification);
    const run = await subject.executor.execute(effect(specification.tabId, plan()));
    if (!isCoreEffectEventContinuation(run)) throw new Error("missing event continuation");
    await run.completion;
    expect(subject.reportSlotLoad).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: "web-surface-1", phase: "failed", retryable: true
    }));
    expect(subject.reportSlotLoad).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: "role-1", phase: "ready"
    }));
    expect(subject.closeRole).not.toHaveBeenCalled();
  });

  it("cancels an outstanding load without publishing late success or a retryable error", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const subject = harness(async (input) => {
      started.resolve();
      await gate.promise;
      return { roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url };
    }, platform);
    const specification = mixedTab();
    await createTab(subject, specification);
    const run = await subject.executor.execute(effect(specification.tabId, plan()));
    if (!isCoreEffectEventContinuation(run)) throw new Error("missing event continuation");
    await started.promise;
    const terminal = expect(run.completion).rejects.toBeDefined();
    run.cancel("coreCancelled");
    gate.reject(new Error("native load cancelled"));
    await terminal;
    expect(subject.closeRole).toHaveBeenCalledWith("role-1", 1);
    expect(subject.reportSlotLoad.mock.calls.filter(([record]) =>
      record.surfaceId === "role-1").every(([record]) => record.phase === "loading")).toBe(true);
  });

  it("does not offer retry when native retirement was not acknowledged", async () => {
    const subject = harness(async () => { throw new Error("navigation failed"); }, platform);
    subject.closeRole.mockRejectedValue(new Error("retirement unknown"));
    const specification = mixedTab();
    await createTab(subject, specification);
    const run = await subject.executor.execute(effect(specification.tabId, plan()));
    if (!isCoreEffectEventContinuation(run)) throw new Error("missing event continuation");
    await run.completion;
    expect(subject.reportSlotLoad).toHaveBeenCalledWith(expect.objectContaining({
      surfaceId: "role-1", phase: "failed", retryable: false
    }));
    expect(subject.createWebSurface).toHaveBeenCalledTimes(1);
  });

  it("reveals subsequent role loads for an existing workspace outside initial loading", async () => {
    const subject = harness(undefined, platform);
    const specification = mixedTab();
    await createTab(subject, specification);
    const initial = await subject.executor.execute(effect(specification.tabId, plan()));
    if (!isCoreEffectEventContinuation(initial)) throw new Error("missing initial continuation");
    await initial.completion;
    await subject.executor.execute(effect(specification.tabId, { type: "embeddedDestroyRole", roleId: "role-1" }));
    const next = await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedLoadRoles", roles: plan().roles
    }));
    if (!isCoreEffectEventContinuation(next)) throw new Error("missing subsequent continuation");
    await next.completion;
    expect(subject.createSurface).toHaveBeenLastCalledWith(expect.objectContaining({
      roleId: "role-1", generation: 2, visible: true
    }));
  });
});
