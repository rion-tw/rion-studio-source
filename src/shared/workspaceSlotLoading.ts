import type { LayoutBounds, WorkspaceSlotLoadRecord } from "./generated";

export interface WorkspaceSlotLoadPresentation {
  readonly record: WorkspaceSlotLoadRecord;
  readonly bounds: LayoutBounds;
  readonly visible: boolean;
}

export function isWorkspaceSlotLoadRecord(value: unknown): value is WorkspaceSlotLoadRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["tabId", "slotId", "surfaceId", "windowId", "attemptGeneration", "loadId"]
    .every((key) => typeof record[key] === "string" && record[key].length > 0 &&
      record[key] === record[key].trim()) &&
    ["windowGeneration", "ownerGeneration", "surfaceGeneration", "revision"]
      .every((key) => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0) &&
    Number(record.windowGeneration) > 0 && Number(record.revision) > 0 &&
    ["loading", "ready", "failed"].includes(String(record.phase)) &&
    typeof record.retryable === "boolean" &&
    ["loadingLabel", "failureLabel", "retryLabel"].every((key) =>
      record[key] === undefined || typeof record[key] === "string");
}

export function isWorkspaceSlotLoadPresentation(value: unknown): value is WorkspaceSlotLoadPresentation {
  if (typeof value !== "object" || value === null) return false;
  const slot = value as WorkspaceSlotLoadPresentation;
  return isWorkspaceSlotLoadRecord(slot.record) && typeof slot.visible === "boolean" &&
    typeof slot.bounds === "object" && slot.bounds !== null &&
    [slot.bounds.x, slot.bounds.y, slot.bounds.width, slot.bounds.height].every(Number.isSafeInteger) &&
    slot.bounds.x >= 0 && slot.bounds.y >= 0 && slot.bounds.width > 0 && slot.bounds.height > 0;
}
