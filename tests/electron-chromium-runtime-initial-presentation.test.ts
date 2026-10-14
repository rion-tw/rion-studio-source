import { describe, expect, it, vi } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { FakeChromiumRuntimeEffectHost as FakeHost } from "./support/electronChromiumRuntimeEffectHostFixture";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { createChromiumSavedWindowRestorePresentation } from "../src/electron/main/chromiumSavedWindowRestorePresentation";
import type { ChromiumRuntimeLaunchCorePort } from "../src/electron/main/chromiumRuntimeLaunchCoordinator";

describe.each(["maximized", "fullscreen"] as const)("staged initial Windows %s", presentation => {
  it("keeps the restore callback pending until the runtime's exact native presentation receipt", async () => {
    let acknowledge!: () => void;
    const receipt = new Promise<void>(resolve => { acknowledge = resolve; });
    const callbacks = createChromiumSavedWindowRestorePresentation({
      core: { invoke: vi.fn() } as unknown as ChromiumRuntimeLaunchCorePort,
      runtime: {
        beginSavedWindowRestore: vi.fn(),
        finishSavedWindowRestore: vi.fn(() => receipt)
      }
    });
    const finish = callbacks.finishSavedWindowRestore!("window-1");
    let settled = false;
    void Promise.resolve(finish).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge();
    await finish;
    expect(settled).toBe(true);
  });
  it.each([false, true])("awaits staged mode after exact Core reveal; cancelled=%s", async (cancelled) => {
    const subject = harness(undefined, "windows");
    const target = { ...tab("unused-tab", "empty-window", []).target, presentation };
    const create = subject.createEmptyHost.getMockImplementation() as (...args: unknown[]) => Promise<FakeHost>;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const complete = vi.fn();
    subject.createEmptyHost.mockImplementationOnce(async (...args) => {
      const host = await create(...args);
      host.projection = { ...host.projection, presentation: "normal" };
      let pending = true;
      complete.mockImplementation(async (fence) => {
        expect(host.visible).toBe(true);
        expect(fence).toEqual({ windowId: "empty-window", windowGeneration: 4, topologyRevision: 9 });
        await acknowledgement;
        host.projection = { ...host.projection, presentation };
        pending = false;
      });
      Object.defineProperties(host, {
        readPendingInitialPresentation: { value: () => pending ? presentation : null },
        completeInitialPresentation: { value: complete }
      });
      return host;
    });
    const controller = new AbortController();
    const result = await subject.executor.execute(effect("embedded-runtime", {
      type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1, roles: [],
      windows: [{ windowId: "empty-window", windowGeneration: 4, topologyRevision: 9,
        tabIds: [], tabPhases: [], hiddenTabIds: [] }],
      target, revealWindowIds: ["empty-window"], focusWindowIds: ["empty-window"]
    }, "empty-max-window"), { signal: controller.signal });
    expect(isCoreEffectEventContinuation(result)).toBe(true);
    if (!isCoreEffectEventContinuation(result)) throw new Error("Expected event-bound continuation.");
    let settled = false;
    void result.completion.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(subject.hosts[0]!.showInactive).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    if (cancelled) controller.abort();
    acknowledge();
    if (cancelled) {
      await expect(result.completion).rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_WINDOW_TRANSITION_CANCELLED"
      });
    } else {
      await expect(result.completion).resolves.toMatchObject({ status: "applied" });
    }
    expect(subject.executor.snapshot().windows[0]!.presentation).toBe(presentation);
  });

  it("keeps populated staged-mode hydration hidden and awaits background reveal without focus", async () => {
    const subject = harness(undefined, "windows");
    const specification = tab();
    specification.target.presentation = presentation;
    const create = subject.createHost.getMockImplementation() as (...args: unknown[]) => Promise<FakeHost>;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const complete = vi.fn();
    subject.createHost.mockImplementationOnce(async (...args) => {
      const host = await create(...args);
      host.visible = false;
      host.projection = { ...host.projection, presentation: "normal" };
      let pending = true;
      complete.mockImplementation(async () => {
        expect(host.visible).toBe(true);
        expect(host.focused).toBe(false);
        await acknowledgement;
        host.projection = { ...host.projection, presentation };
        pending = false;
      });
      Object.defineProperties(host, {
        readPendingInitialPresentation: { value: () => pending ? presentation : null },
        completeInitialPresentation: { value: complete }
      });
      return host;
    });
    subject.executor.beginSavedWindowRestore(specification.target.windowId);
    await createTab(subject, specification);
    await loadRoles(subject, specification);
    expect(complete).not.toHaveBeenCalled();
    expect(subject.hosts[0]!.visible).toBe(false);
    expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
    subject.setVisible.mockClear();
    const finish = subject.executor.finishSavedWindowRestore(specification.target.windowId);
    expect(complete).toHaveBeenCalledOnce();
    expect(subject.setVisible).not.toHaveBeenCalledWith("role-1", 1, true);
    acknowledge();
    await finish;
    expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
    expect(subject.executor.snapshot().windows[0]!.presentation).toBe(presentation);
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
  });
});
