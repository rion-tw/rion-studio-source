import type { LayoutBounds } from "../../shared/generated";
import type { ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord } from
  "./chromiumRuntimeAppKitProjection";

export type { WorkspaceSlotLoadPresentation } from "../../shared/workspaceSlotLoading";

/** Receipts are follower state; every phase/revision is returned by Rust. */
export function projectWorkspaceSlotLoads(
  tab: ChromiumRuntimeTabRecord,
  window: ChromiumRuntimeWindowRecord,
  bounds: ReadonlyMap<string, LayoutBounds>
): void {
  if (!tab.slotLoads || !window.host.applyWorkspaceSlotLoads) return;
  if (tab.slotRetry) window.host.bindWorkspaceSlotRetry?.(tab.slotRetry);
  window.host.applyWorkspaceSlotLoads(tab.specification.tabId,
    [...tab.slotLoads.values()].flatMap((record) => {
      if (record.phase === "ready") return [];
      const rect = bounds.get(record.surfaceId);
      // Window identity comes from the separately fenced Rust topology projection.
      return rect ? [{ record: { ...record, windowId: tab.windowId, windowGeneration: window.windowGeneration }, bounds: rect, visible:
        window.activeTabId === record.tabId && window.host.isVisible() }] : [];
    }));
}
