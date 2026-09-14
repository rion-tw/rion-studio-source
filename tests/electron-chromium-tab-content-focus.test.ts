import { isClosedCoreEffectRequest } from "../src/electron/core/coreEffectActionValidation";
import { describe, expect, it } from "vitest";
import type { AppKitRuntimeProjectionEffectRecord } from "../src/shared/generated";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";

type Phase = "loading" | "ready" | "failed";
async function fixture(loaded = true) {
  const subject = harness();
  const tabs = [tab(), tab("tab-2", "window-1", ["role-2"])];
  for (const specification of tabs) {
    await createTab(subject, specification);
    if (loaded) await loadRoles(subject, specification);
  }
  const host = subject.hosts[0]!;
  host.focused = true;
  Object.defineProperty(host, "prepareWorkspaceDividerProjection", { value: () => ({
    commit: () => undefined, rollback: () => undefined, requiresQuarantine: () => false
  }) });
  host.prepareAppKitProjection.mockImplementation(projection => ({
    commit: () => { host.topologyRevision = projection.topologyRevision; },
    rollback: () => undefined, requiresQuarantine: () => false
  }));
  let sequence = 0;
  const projection = (selected: string, phase: Phase = "ready", focus = true): AppKitRuntimeProjectionEffectRecord => ({
    eventId: `activate-${++sequence}`, ...(focus ? { contentFocusTabId: selected } : {}),
    windows: [{ identity: host.appKitIdentity, adapterSequence: sequence,
      windowGeneration: 3, topologyRevision: 7 + sequence,
      logicalTabIds: tabs.map(tab => tab.tabId), hiddenTabIds: [], activeTabId: selected,
      tabs: tabs.map(tab => ({ tabId: tab.tabId, name: tab.name, phase,
        tabType: "role", audioMuted: false })),
      roles: phase === "ready" ? tabs.map(tab => ({ roleId: tab.sourceId, tabId: tab.tabId,
        ownerGeneration: 1, bounds: { x: 0, y: 44, width: 1000, height: 656 } })) : [],
      webSurfaces: [], workspaceDividers: [], workspaceAppearance: { background: "black", gap: 4 },
      windowVisible: true }]
  });
  const apply = (projection: AppKitRuntimeProjectionEffectRecord, signal?: AbortSignal) =>
    subject.executor.execute(effect("window-1", { type: "embeddedApplyAppKitProjection", projection }),
      signal ? { signal } : undefined);
  return { ...subject, tabs, host, projection, apply };
}

describe("AppKit tab activation content focus", () => {
  it("admits the optional Core focus intent and rejects malformed wire values", async () => {
    const subject = await fixture();
    const request = effect("window-1", { type: "embeddedApplyAppKitProjection",
      projection: subject.projection("tab-1") });
    expect(isClosedCoreEffectRequest(JSON.parse(JSON.stringify(request)))).toBe(true);
    for (const value of [null, false, 3, "", {}]) {
      const malformed = JSON.parse(JSON.stringify(request));
      malformed.action.projection.contentFocusTabId = value;
      expect(isClosedCoreEffectRequest(malformed)).toBe(false);
    }
    const passive = JSON.parse(JSON.stringify(request));
    delete passive.action.projection.contentFocusTabId;
    expect(isClosedCoreEffectRequest(passive)).toBe(true);
  });

  it("focuses the newly visible Role once after native commit and preserves the host", async () => {
    const subject = await fixture();
    const projection = subject.projection("tab-1");
    subject.focusVisible.mockImplementation(() => {
      expect(subject.host.topologyRevision).toBe(projection.windows[0]!.topologyRevision);
      expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, true);
    });
    await subject.apply(projection);
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-1", 1);
    expect(subject.host.focus).not.toHaveBeenCalled();
    await expect(subject.apply(projection)).rejects.toMatchObject({ code: "ELECTRON_MACOS_APPKIT_PROJECTION_STALE" });
    expect(subject.focusVisible).toHaveBeenCalledTimes(1);
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).toHaveBeenCalledTimes(1);
  });

  it("only focuses the latest selected tab, including reverse selection", async () => {
    const subject = await fixture();
    for (const id of ["tab-1", "tab-2", "tab-1"]) await subject.apply(subject.projection(id));
    expect(subject.focusVisible.mock.calls).toEqual([["role-1", 1], ["role-2", 1], ["role-1", 1]]);
  });

  it("waits for readiness and consumes the claim once", async () => {
    const subject = await fixture(false);
    await subject.apply(subject.projection("tab-1", "loading"));
    expect(subject.focusVisible).not.toHaveBeenCalled();
    for (const specification of subject.tabs) await loadRoles(subject, specification);
    await subject.apply(subject.projection("tab-1", "ready", false));
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-1", 1);
  });

  it.each(["blur", "selection", "failure", "abort", "close"] as const)(
    "cancels a loading claim on %s even if the user returns before readiness", async reason => {
      const subject = await fixture(false);
      const controller = new AbortController();
      await subject.apply(subject.projection("tab-1", "loading"), controller.signal);
      if (reason === "blur") {
        subject.host.focused = false;
        for (const observer of [...subject.host.observers]) observer({ ...subject.host.readRuntimeWindowState(), source: "blur" });
        subject.host.focused = true;
      } else if (reason === "selection") {
        await subject.apply(subject.projection("tab-2", "loading", false));
      } else if (reason === "failure") {
        await subject.apply(subject.projection("tab-1", "failed", false));
      } else if (reason === "abort") controller.abort();
      else {
        for (const observer of [...subject.host.observers]) observer({ ...subject.host.readRuntimeWindowState(), source: "closed" });
      }
      for (const specification of subject.tabs) await loadRoles(subject, specification);
      await subject.apply(subject.projection("tab-1", "ready", false));
      expect(subject.focusVisible).not.toHaveBeenCalled();
    }
  );

  it("does not focus background activation", async () => {
    const subject = await fixture();
    subject.host.focused = false;
    await subject.apply(subject.projection("tab-1"));
    subject.host.focused = true;
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("excludes workspaces from the standalone responder policy", async () => {
    const subject = await fixture();
    subject.tabs[0]!.workspaceId = "workspace-1";
    await subject.apply(subject.projection("tab-1"));
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("rejects older topology and native generation before acquiring focus", async () => {
    const subject = await fixture();
    const old = subject.projection("tab-1");
    await subject.apply(subject.projection("tab-2"));
    old.windows[0]!.adapterSequence += 2;
    await expect(subject.apply(old)).rejects.toMatchObject({ code: "MACOS_APPKIT_CHROMIUM_PROJECTION_SUPERSEDED" });
    const replaced = subject.projection("tab-1");
    replaced.windows[0]!.identity = { ...replaced.windows[0]!.identity, nativeGeneration: 99 };
    await expect(subject.apply(replaced)).rejects.toMatchObject({ code: "ELECTRON_MACOS_APPKIT_PROJECTION_STALE" });
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-2", 1);
  });

  it("does not give a replacement owner the loading claim", async () => {
    const subject = await fixture(false);
    await subject.apply(subject.projection("tab-1", "loading"));
    subject.tabs[0]!.slots[0]!.owner!.generation = 2;
    for (const specification of subject.tabs) await loadRoles(subject, specification);
    const ready = subject.projection("tab-1", "ready", false);
    ready.windows[0]!.roles[0]!.ownerGeneration = 2;
    await subject.apply(ready);
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("releases the pending native subscription when the executor stops", async () => {
    const subject = await fixture(false);
    const initial = subject.host.observers.size;
    await subject.apply(subject.projection("tab-1", "loading"));
    expect(subject.host.observers.size).toBe(initial + 1);
    await subject.executor.dispose();
    expect(subject.host.observers.size).toBe(0);
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("reports focus failure after commit without rollback or retry", async () => {
    const subject = await fixture();
    subject.focusVisible.mockImplementationOnce(() => { throw new Error("focus failed"); });
    const projection = subject.projection("tab-1");
    await expect(subject.apply(projection)).rejects.toThrow("focus failed");
    expect(subject.host.topologyRevision).toBe(projection.windows[0]!.topologyRevision);
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).toHaveBeenCalledTimes(1);
  });

  it("rejects an inactive focus target before native mutation", async () => {
    const subject = await fixture();
    const projection = subject.projection("tab-1");
    projection.contentFocusTabId = "tab-2";
    await expect(subject.apply(projection)).rejects.toMatchObject({ code: "ELECTRON_MACOS_APPKIT_CONTENT_FOCUS_INVALID" });
    expect(subject.host.prepareAppKitProjection).not.toHaveBeenCalled();
  });
});
