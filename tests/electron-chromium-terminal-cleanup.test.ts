import { deferred } from "../src/electron/main/macosAppKitRuntimeHostSupport";
import { describe, expect, it, vi } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { observeRuntimeEffectCompletion } from "../src/electron/e2e/runtimeEffectCompletionObservation";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";

describe.each(["macos", "windows"] as const)("%s terminal cleanup", platform => {
  it("finishes a cancelled two-role launch before observing exact tab destruction", async () => {
    const creations = new Map<string, ReturnType<typeof deferred<never>>>();
    const subject = harness(input => {
      const creation = deferred<never>();
      creations.set(input.roleId, creation);
      return creation.promise;
    }, platform);
    subject.closeRole.mockImplementation(async (roleId: string) => {
      creations.get(roleId)!.reject(new Error("cancelled"));
      return true;
    });
    const specification = tab("cancel-tab", "window-1", ["role-a", "role-b"]);
    await createTab(subject, specification);
    const cancellation = new AbortController();
    const loading = await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedLoadRoles", roles: specification.roles.map(role => ({
        roleId: role.role.id, url: role.role.launchUrl, resolvedEngine: "chromium", zoomFactor: 1
      }))
    }), { signal: cancellation.signal });
    if (!isCoreEffectEventContinuation(loading)) throw new Error("load admission missing");
    const failedLoad = expect(loading.completion).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(creations.size).toBe(2));
    expect(subject.executor.roleIdsForInputDrain()).toEqual(["role-a", "role-b"]);
    cancellation.abort();
    await failedLoad;
    expect(subject.closeRole).toHaveBeenCalledTimes(2);
    expect(subject.executor.roleIdsForInputDrain()).toEqual([]);
    const nativeClosed = deferred<void>();
    const host = subject.hosts[0]!;
    host.close.mockImplementation(() => nativeClosed.promise);
    host.readProjection.mockImplementation(() => { throw new Error("STALE_GENERATION"); });
    const result = await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab", tabId: specification.tabId
    }));
    if (!isCoreEffectEventContinuation(result)) throw new Error("close admission missing");
    const observed = vi.fn(() => expect(subject.executor.snapshot()).toMatchObject({ roles: [], tabs: [], windows: [] }));
    const observationFailed = vi.fn();
    observeRuntimeEffectCompletion(result, observed, vi.fn(), observationFailed);
    expect(observed).not.toHaveBeenCalled();
    nativeClosed.resolve();
    await expect(result.completion).resolves.toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    expect(observationFailed).not.toHaveBeenCalled();
    expect(subject.closeRole).toHaveBeenCalledTimes(2);
    expect(await subject.executor.execute(effect(specification.tabId, {
      type: "embeddedDestroyTab", tabId: specification.tabId,
      attemptGeneration: "old-attempt"
    }))).toBe(false);
  });

  it("waits for the real input lane before retiring the original surface without an E2E hook", async () => {
    const subject = harness(undefined, platform);
    await createTab(subject);
    await loadRoles(subject);
    const neutral = deferred<boolean>();
    subject.trustedRetireSurfaceForDestruction.mockReturnValue(neutral.promise);
    const result = await subject.executor.execute(effect("tab-1", { type: "embeddedDestroyTab", tabId: "tab-1" }));
    if (!isCoreEffectEventContinuation(result)) throw new Error("close admission missing");
    await vi.waitFor(() => expect(subject.trustedRetireSurfaceForDestruction).toHaveBeenCalledWith("role-1", 1));
    expect(subject.closeRole).not.toHaveBeenCalled();
    expect(subject.retireOverlay).not.toHaveBeenCalled();
    neutral.resolve(true);
    await expect(result.completion).resolves.toBe(true);
    expect(subject.closeRole).toHaveBeenCalledExactlyOnceWith("role-1", 1);
    expect(subject.hosts[0]!.close).toHaveBeenCalledOnce();
  });
});
