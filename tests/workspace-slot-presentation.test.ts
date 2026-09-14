import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSlotLoadRecord } from "../src/shared/generated";
import { isWorkspaceSlotLoadPresentation, isWorkspaceSlotLoadRecord } from "../src/shared/workspaceSlotLoading";
import { projectWorkspaceSlotLoads } from "../src/electron/main/chromiumWorkspaceSlotLoading";
import type { ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord } from "../src/electron/main/chromiumRuntimeAppKitProjection";
import { mixedTab } from "./support/electronChromiumRuntimeEffectFixtures";

const receipt: WorkspaceSlotLoadRecord = {
  tabId: "mixed-tab-1", slotId: "slot-1", surfaceId: "role-1", windowId: "source",
  windowGeneration: 1, attemptGeneration: "attempt", loadId: "load", ownerGeneration: 1,
  surfaceGeneration: 1, phase: "failed", retryable: true, revision: 2
};

describe("workspace status projections", () => {
  it.each(["macos", "windows"] as const)("uses the committed destination geometry without altering the slot receipt on %s", (platform) => {
    const apply = vi.fn();
    const retry = vi.fn(async () => true);
    const window = {
      activeTabId: receipt.tabId, windowGeneration: 3,
      host: { logicalWindowId: "destination", isVisible: () => true,
        applyWorkspaceSlotLoads: apply, bindWorkspaceSlotRetry: vi.fn(),
        ...(platform === "macos" ? { appKitIdentity: { logicalWindowId: "destination", launchGeneration: "host", nativeGeneration: 1 } } : {}) }
    } as unknown as ChromiumRuntimeWindowRecord;
    const tab: ChromiumRuntimeTabRecord = {
      specification: mixedTab(), windowId: "destination", roleViews: new Map(), webViews: new Map(), audioMuted: false,
      slotLoads: new Map([[receipt.slotId, { ...receipt }]]), slotRetry: retry
    };
    const bounds = { x: 506, y: 40, width: 494, height: 600 };
    projectWorkspaceSlotLoads(tab, window, new Map([[receipt.surfaceId, bounds]]));
    expect(apply).toHaveBeenLastCalledWith(receipt.tabId, [{
      record: { ...receipt, windowId: "destination", windowGeneration: 3 }, bounds, visible: true
    }]);
    expect(tab.slotLoads!.get(receipt.slotId)).toEqual(receipt);
    tab.slotLoads!.set(receipt.slotId, { ...receipt, phase: "ready", retryable: false });
    projectWorkspaceSlotLoads(tab, window, new Map([[receipt.surfaceId, bounds]]));
    expect(apply).toHaveBeenLastCalledWith(receipt.tabId, []);
  });

  it("rejects malformed phase, generation, and cell geometry at the local renderer boundary", () => {
    expect(isWorkspaceSlotLoadRecord(receipt)).toBe(true);
    expect(isWorkspaceSlotLoadRecord({ ...receipt, phase: "finished" })).toBe(false);
    expect(isWorkspaceSlotLoadRecord({ ...receipt, surfaceGeneration: -1 })).toBe(false);
    expect(isWorkspaceSlotLoadRecord({ ...receipt, revision: 0 })).toBe(false);
    expect(isWorkspaceSlotLoadPresentation({ record: receipt, visible: true,
      bounds: { x: 0, y: 40, width: 0, height: 200 } })).toBe(false);
  });
});
