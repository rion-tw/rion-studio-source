import { describe, expect, it } from "vitest";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";

describe.each(["macos", "windows"] as const)("%s mounted loading Role", platform => {
  it("does not retain an opening owner after synchronous creation rejection", async () => {
    const subject = harness(undefined, platform);
    const specification = tab();
    await createTab(subject, specification);
    subject.createSurface.mockImplementationOnce(() => { throw new Error("invalid creation"); });
    subject.closeRole.mockResolvedValue(false);
    const load = await subject.executor.execute(effect("tab-1", { type: "embeddedLoadRoles",
      roles: [{ roleId: "role-1", resolvedEngine: "chromium", url: specification.roles[0]!.role.launchUrl, zoomFactor: 1 }] }));
    if (!isCoreEffectEventContinuation(load)) throw new Error("missing loading continuation");
    await expect(load.completion).rejects.toThrow("invalid creation");
    const close = await subject.executor.execute(effect("tab-1", { type: "embeddedDestroyTab", tabId: "tab-1" }));
    if (isCoreEffectEventContinuation(close)) await close.completion;
    expect(subject.closeRole).toHaveBeenCalledTimes(1);
    expect(subject.executor.snapshot().windows).toEqual([]);
  });

  it.each([false, true])("ignores attachment and completion after close (already attached=%s)", async alreadyAttached => {
    let attach!: () => void, complete!: () => void;
    const navigation = new Promise<void>(resolve => { complete = resolve; });
    const subject = harness(async input => {
      attach = () => input.onAttached?.();
      if (alreadyAttached) attach();
      await navigation;
      return { roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url };
    }, platform);
    const specification = tab();
    await createTab(subject, specification);
    const load = await subject.executor.execute(effect(specification.tabId, { type: "embeddedLoadRoles",
      roles: [{ roleId: "role-1", resolvedEngine: "chromium", url: specification.roles[0]!.role.launchUrl, zoomFactor: 1 }] }));
    if (!isCoreEffectEventContinuation(load)) throw new Error("missing loading continuation");
    const terminal = load.completion.catch(error => error);
    const close = await subject.executor.execute(effect("tab-1", { type: "embeddedDestroyTab", tabId: "tab-1" }));
    if (isCoreEffectEventContinuation(close)) await close.completion;
    const visibilityCalls = subject.setVisible.mock.calls.length;
    attach(); attach(); complete();
    await terminal;
    expect(subject.executor.snapshot().roles).toEqual([]);
    expect(subject.executor.snapshot().tabs).toEqual([]);
    expect(subject.setVisible).toHaveBeenCalledTimes(visibilityCalls);
    expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
  });

  it("switches visibility before navigation completes and preserves the latest selection", async () => {
    let complete!: () => void;
    const navigation = new Promise<void>(resolve => { complete = resolve; });
    const subject = harness(async input => {
      input.onAttached?.();
      if (input.roleId === "role-2") await navigation;
      return { roleId: input.roleId, generation: input.generation, parentId: input.parent.id, url: input.url };
    }, platform);
    const visibility = new Map<string, boolean>();
    subject.setVisible.mockImplementation((roleId: string, _generation: number, visible: boolean) => { visibility.set(roleId, visible); });
    subject.surfaces.readProjection = roleId => ({ bounds: { x: 0, y: 44, width: 500, height: 656 },
      visible: visibility.get(roleId) ?? true });
    const a = tab(), b = tab("tab-2", "window-1", ["role-2"]);
    await createTab(subject, a); await loadRoles(subject, a);
    await createTab(subject, b);
    const load = await subject.executor.execute(effect(b.tabId, { type: "embeddedLoadRoles", roles: b.roles.map(role => ({
      roleId: role.role.id, resolvedEngine: "chromium", url: role.role.launchUrl, zoomFactor: role.zoomFactor
    })) }));
    if (!isCoreEffectEventContinuation(load)) throw new Error("missing loading continuation");
    const host = subject.hosts[0]!;
    Object.defineProperty(host, "prepareWorkspaceDividerProjection", { value: () => ({
      commit: () => undefined, rollback: () => undefined, requiresQuarantine: () => false
    }) });
    host.prepareAppKitProjection.mockImplementation(projection => ({
      commit: () => { host.topologyRevision = projection.topologyRevision; },
      rollback: () => undefined, requiresQuarantine: () => false
    }));
    const select = (activeTabId: string, revision: number) => subject.executor.execute(effect("window-1", platform === "macos" ? {
      type: "embeddedApplyAppKitProjection", projection: { eventId: `selection-${revision}`, windows: [{
        identity: host.appKitIdentity, adapterSequence: revision, windowGeneration: 3, topologyRevision: revision,
        logicalTabIds: [a.tabId, b.tabId], hiddenTabIds: [], activeTabId,
        tabs: [a, b].map(tab => ({ tabId: tab.tabId, name: tab.name, phase: tab === a ? "ready" : "loading",
          tabType: "role", audioMuted: false })),
        roles: activeTabId === a.tabId ? [{ roleId: "role-1", tabId: a.tabId, ownerGeneration: 1,
          bounds: { x: 0, y: 44, width: 1000, height: 656 } }] : [],
        webSurfaces: [], workspaceDividers: [], workspaceAppearance: { background: "black", gap: 4 }, windowVisible: true
      }] }
    } : {
      type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1,
      roles: [{ roleId: "role-1", runtime: "embedded", state: "running", owner: { tabId: "tab-1", slotId: "slot-1", generation: 1 } },
        { roleId: "role-2", runtime: "embedded", state: "launching", owner: { tabId: "tab-2", slotId: "slot-1", generation: 1 } }],
      windows: [{ windowId: "window-1", windowGeneration: 3, topologyRevision: revision,
        tabIds: ["tab-1", "tab-2"], hiddenTabIds: [], activeTabId,
        tabPhases: [{ tabId: "tab-1", phase: "ready" }, { tabId: "tab-2", phase: "activating" }] }],
      revealWindowIds: [], focusWindowIds: []
    }));
    await select("tab-1", 8);
    expect(subject.executor.snapshot().roles.map(role => role.roleId)).toEqual(["role-1"]);
    expect(subject.setVisible).toHaveBeenCalledWith("role-2", 1, false);
    await select("tab-2", 9);
    expect(subject.setVisible.mock.calls.filter(call => call[0] === "role-2").at(-1)).toEqual(["role-2", 1, true]);
    await select("tab-1", 10);
    complete(); await load.completion;
    expect(subject.setVisible.mock.calls.filter(call => call[0] === "role-2").at(-1)).toEqual(["role-2", 1, false]);
    expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
  });
});
