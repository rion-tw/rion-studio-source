import { describe, expect, it, vi } from "vitest";
import type { CoreEffectRequest } from "../src/shared/generated";
import { isClosedCoreEffectRequest } from "../src/electron/core/coreEffectActionValidation";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";

type Ownership = Extract<CoreEffectRequest["action"], { type: "embeddedFollowRoleOwnership" }>;

async function fixture(loaded = true) {
  const subject = harness(undefined, "windows");
  const tabs = [tab(), tab("tab-2", "window-1", ["role-2"])];
  for (const specification of tabs) {
    await createTab(subject, specification);
    if (loaded) await loadRoles(subject, specification);
  }
  const host = subject.hosts[0]!;
  host.focused = true;
  let revision = 7;
  const projection = (selected: string, phase: "ready" | "loading" | "failed" = "ready", focus = true): Ownership => ({
    type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1,
    roles: tabs.map(specification => ({ roleId: specification.sourceId, runtime: "embedded",
      owner: { tabId: specification.tabId, slotId: specification.slots[0]!.owner!.slotId, generation: 1 },
      state: phase === "ready" ? "running" : "launching" })),
    windows: [{ windowId: "window-1", windowGeneration: 3, topologyRevision: ++revision,
      tabIds: tabs.map(tab => tab.tabId), activeTabId: selected, hiddenTabIds: [],
      tabPhases: tabs.map(tab => ({ tabId: tab.tabId, phase })) }],
    revealWindowIds: [], focusWindowIds: [], ...(focus ? { contentFocusTabId: selected } : {})
  });
  const apply = (action: Ownership, signal?: AbortSignal) =>
    subject.executor.execute(effect("window-1", action), signal ? { signal } : undefined);
  return { ...subject, tabs, host, projection, apply };
}

describe("Windows tab activation content focus", () => {
  it("accepts the Core content-only intent and rejects malformed wire values", async () => {
    const subject = await fixture();
    const request = effect("window-1", subject.projection("tab-1"));
    expect(isClosedCoreEffectRequest(request)).toBe(true);
    for (const value of [null, false, 3, "", {}]) {
      const malformed = JSON.parse(JSON.stringify(request));
      malformed.action.contentFocusTabId = value;
      expect(isClosedCoreEffectRequest(malformed)).toBe(false);
    }
  });

  it("hands forward and reverse selections to their exact visible content without activating the host", async () => {
    const subject = await fixture();
    subject.focusVisible.mockImplementation((roleId, generation) => {
      expect(subject.setVisible).toHaveBeenCalledWith(roleId, generation, true);
    });
    for (const id of ["tab-1", "tab-2", "tab-1"]) await subject.apply(subject.projection(id));
    expect(subject.focusVisible.mock.calls).toEqual([["role-1", 1], ["role-2", 1], ["role-1", 1]]);
    expect(subject.host.focus).not.toHaveBeenCalled();
    expect(subject.host.show).not.toHaveBeenCalled();
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).toHaveBeenCalledTimes(3);
  });

  it("holds a loading selection until the exact role becomes ready, then consumes it once", async () => {
    const subject = await fixture(false);
    const focusLocalChrome = vi.fn();
    Object.assign(subject.host, { focusLocalChrome });
    await subject.apply(subject.projection("tab-1", "loading"));
    expect(focusLocalChrome).toHaveBeenCalledOnce();
    await subject.apply(subject.projection("tab-1", "loading", false));
    expect(focusLocalChrome).toHaveBeenCalledOnce();
    expect(subject.focusVisible).not.toHaveBeenCalled();
    for (const specification of subject.tabs) await loadRoles(subject, specification);
    await subject.apply(subject.projection("tab-1", "ready", false));
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-1", 1);
    expect(focusLocalChrome).toHaveBeenCalledOnce();
    expect(subject.host.focus).not.toHaveBeenCalled();
  });

  it("keeps ready/loading/ready keyboard selections within the current native host", async () => {
    const subject = await fixture(false);
    const focusLocalChrome = vi.fn();
    Object.assign(subject.host, { focusLocalChrome });
    await loadRoles(subject, subject.tabs[0]!);
    await subject.apply(subject.projection("tab-1"));
    expect(focusLocalChrome).not.toHaveBeenCalled();
    subject.focusVisible.mockClear();
    await subject.apply(subject.projection("tab-2", "loading"));
    expect(focusLocalChrome).toHaveBeenCalledOnce();
    expect(subject.focusVisible).not.toHaveBeenCalled();
    await subject.apply(subject.projection("tab-1"));
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-1", 1);
    expect(subject.host.focus).not.toHaveBeenCalled();
    expect(subject.host.show).not.toHaveBeenCalled();
  });

  it.each(["blur", "selection", "failure", "abort", "close"] as const)(
    "revokes a loading content claim on %s", async reason => {
      const subject = await fixture(false);
      const controller = new AbortController();
      await subject.apply(subject.projection("tab-1", "loading"), controller.signal);
      if (reason === "blur" || reason === "close") {
        subject.host.focused = false;
        for (const observer of [...subject.host.observers]) observer({
          ...subject.host.readRuntimeWindowState(), source: reason === "blur" ? "blur" : "closed"
        });
        subject.host.focused = true;
      } else if (reason === "selection") await subject.apply(subject.projection("tab-2", "loading", false));
      else if (reason === "failure") await subject.apply(subject.projection("tab-1", "failed", false));
      else controller.abort();
      for (const specification of subject.tabs) await loadRoles(subject, specification);
      await subject.apply(subject.projection("tab-1", "ready", false));
      expect(subject.focusVisible).not.toHaveBeenCalled();
    }
  );

  it("does not acquire a claim in a background window", async () => {
    const subject = await fixture();
    const focusLocalChrome = vi.fn();
    Object.assign(subject.host, { focusLocalChrome });
    subject.host.focused = false;
    await subject.apply(subject.projection("tab-1", "loading"));
    subject.host.focused = true;
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).not.toHaveBeenCalled();
    expect(focusLocalChrome).not.toHaveBeenCalled();
  });

  it("revokes a pending claim when its native generation is replaced", async () => {
    const subject = await fixture(false);
    await subject.apply(subject.projection("tab-1", "loading"));
    for (const observer of [...subject.host.observers]) observer({
      ...subject.host.readRuntimeWindowState(), nativeGeneration: 99
    });
    for (const specification of subject.tabs) await loadRoles(subject, specification);
    await subject.apply(subject.projection("tab-1", "ready", false));
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("rejects an inactive focus target before native mutation", async () => {
    const subject = await fixture();
    const projection = subject.projection("tab-1");
    projection.contentFocusTabId = "tab-2";
    subject.setVisible.mockClear();
    await expect(subject.apply(projection)).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_CONTENT_FOCUS_INVALID" });
    expect(subject.setVisible).not.toHaveBeenCalled();
  });
});
