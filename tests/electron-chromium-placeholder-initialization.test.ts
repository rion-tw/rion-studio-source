import type { EmbeddedTabEffectRecord } from "../src/shared/generated";
import { expect, it } from "vitest";
import { createTab, harness } from "./support/electronChromiumRuntimeEffectExecutorHarness";
import { effect, tab } from "./support/electronChromiumRuntimeEffectFixtures";

it.each(["windows", "macos"] as const)(
  "initializes blocked placeholders only from fenced ownership on %s", async platform => {
    const subject = harness(undefined, platform);
    const owner = tab("owner-tab", "owner-window", ["shared-role"]);
    const blocked: EmbeddedTabEffectRecord = {
      ...tab("blocked-tab", "blocked-window", ["shared-role"]),
      roles: [],
      slots: owner.slots.map(slot => ({ ...slot, state: "blocked" }))
    };
    if (platform === "windows") {
      for (const specification of [owner, blocked]) {
        delete specification.appkitWindowGeneration;
        delete specification.appkitTopologyRevision;
      }
    }
    await createTab(subject, owner);
    await createTab(subject, blocked);
    expect(subject.reconcileRolePlaceholders).not.toHaveBeenCalled();
    const projectedWindows = [owner, blocked].map(specification => ({
      windowId: specification.target.windowId,
      windowGeneration: 3,
      topologyRevision: 7,
      tabIds: [specification.tabId],
      tabPhases: [{ tabId: specification.tabId, phase: "activating" as const }],
      hiddenTabIds: [],
      activeTabId: specification.tabId
    }));
    await subject.executor.execute(effect("embedded-runtime-projection", {
      type: "embeddedFollowRoleOwnership",
      lifecycleEpoch: 1,
      roles: [{
        roleId: "shared-role", runtime: "embedded", state: "running",
        owner: { tabId: owner.tabId, slotId: "slot-1", generation: 1 }
      }],
      windows: projectedWindows,
      revealWindowIds: [],
      focusWindowIds: []
    }));
    expect(subject.reconcileRolePlaceholders).toHaveBeenLastCalledWith([
      expect.objectContaining({
        roleId: "shared-role", tabId: blocked.tabId, windowId: blocked.target.windowId,
        windowGeneration: 3, topologyRevision: 7, ownerGeneration: 1,
        ownerTabName: owner.name
      })
    ]);
    await subject.executor.dispose();
  }
);
