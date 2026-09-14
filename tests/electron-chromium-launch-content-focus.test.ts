import { describe, expect, it } from "vitest";
import type { CoreEffectRequest } from "../src/shared/generated";
import { isCoreEffectEventContinuation } from "../src/electron/main/coreEffectContinuation";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { createTab, harness, loadRoles } from "./support/electronChromiumRuntimeEffectExecutorHarness";

type Ownership = Extract<CoreEffectRequest["action"], { type: "embeddedFollowRoleOwnership" }>;

function projection(ready: boolean, focus: boolean): Ownership {
  return {
    type: "embeddedFollowRoleOwnership", lifecycleEpoch: 1,
    roles: [{ roleId: "role-1", runtime: "embedded",
      owner: { tabId: "tab-1", slotId: "slot-1", generation: 1 },
      state: ready ? "running" : "launching" }],
    windows: [{ windowId: "window-1", windowGeneration: 3, topologyRevision: ready ? 8 : 7,
      tabIds: ["tab-1"], activeTabId: "tab-1", hiddenTabIds: [],
      tabPhases: [{ tabId: "tab-1", phase: ready ? "ready" : "activating" }] }],
    revealWindowIds: focus ? ["window-1"] : [],
    focusWindowIds: focus ? ["window-1"] : [],
    ...(focus ? { focusTabId: "tab-1" } : {})
  };
}

async function apply(subject: ReturnType<typeof harness>, action: Ownership): Promise<void> {
  const result = await subject.executor.execute(effect("window-1", action));
  if (isCoreEffectEventContinuation(result)) await result.completion;
}

describe("launch completion content focus", () => {
  it.each(["macos", "windows"] as const)("never reactivates a background host on %s", async platform => {
    const subject = harness(undefined, platform);
    await createTab(subject);
    await apply(subject, projection(false, true));
    const host = subject.hosts[0]!;
    expect(host.focus).toHaveBeenCalledOnce();
    host.focused = false; // External application, launcher or another runtime host.
    await loadRoles(subject);
    host.show.mockClear(); host.showInactive.mockClear(); host.focus.mockClear();
    await apply(subject, projection(true, false));
    expect(host.focus).not.toHaveBeenCalled();
    expect(host.show).not.toHaveBeenCalled();
    expect(host.showInactive).not.toHaveBeenCalled();
    expect(subject.focusVisible).not.toHaveBeenCalled();
    host.focused = true;
    await apply(subject, projection(true, false));
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("does not reveal an explicitly shown restore again after the user hides it", async () => {
    const subject = harness();
    subject.executor.beginSavedWindowRestore("window-1", true);
    await createTab(subject);
    await apply(subject, projection(false, true));
    subject.hosts[0]!.hide();
    subject.hosts[0]!.showInactive.mockClear();
    await loadRoles(subject);
    await apply(subject, projection(true, false));
    subject.executor.finishSavedWindowRestore("window-1");
    expect(subject.hosts[0]!.isVisible()).toBe(false);
    expect(subject.hosts[0]!.showInactive).not.toHaveBeenCalled();
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("hands a foreground standalone Role its responder once without activating the host", async () => {
    const subject = harness();
    await createTab(subject);
    await apply(subject, projection(false, true));
    await loadRoles(subject);
    subject.hosts[0]!.focus.mockClear();
    await apply(subject, projection(true, false));
    await apply(subject, projection(true, false));
    expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
    expect(subject.focusVisible).toHaveBeenCalledExactlyOnceWith("role-1", 1);
  });

  it("does not give hydration or workspace readiness a responder claim", async () => {
    for (const workspace of [false, true]) {
      const subject = harness();
      const specification = tab();
      if (workspace) specification.workspaceId = "workspace-1";
      await createTab(subject, specification);
      await apply(subject, projection(false, workspace));
      await loadRoles(subject, specification);
      subject.hosts[0]!.focused = true;
      subject.hosts[0]!.focus.mockClear();
      await apply(subject, projection(true, false));
      expect(subject.hosts[0]!.focus).not.toHaveBeenCalled();
      expect(subject.focusVisible).not.toHaveBeenCalled();
    }
  });

  it("consumes completion after a newer tab selection without focusing either Role", async () => {
    const subject = harness();
    await createTab(subject);
    await apply(subject, projection(false, true));
    await loadRoles(subject);
    await createTab(subject, tab("tab-2", "window-1", ["role-2"]));
    const ready = projection(true, false);
    ready.windows![0]!.tabIds.push("tab-2");
    ready.windows![0]!.tabPhases.push({ tabId: "tab-2", phase: "ready" });
    ready.windows![0]!.activeTabId = "tab-2";
    await apply(subject, ready);
    expect(subject.focusVisible).not.toHaveBeenCalled();
  });

  it("does not focus a replaced role owner or a mismatched native generation", async () => {
    for (const stale of ["owner", "native"] as const) {
      const subject = harness();
      await createTab(subject);
      await apply(subject, projection(false, true));
      await loadRoles(subject);
      const ready = projection(true, false);
      if (stale === "owner") ready.roles[0]!.owner.generation = 2;
      else subject.hosts[0]!.applyAppKitPhaseProjection.mockImplementation(() => undefined);
      await apply(subject, ready);
      expect(subject.focusVisible).not.toHaveBeenCalled();
    }
  });
});
