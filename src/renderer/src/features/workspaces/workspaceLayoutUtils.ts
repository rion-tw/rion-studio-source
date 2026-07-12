import type { CSSProperties, DragEvent as ReactDragEvent } from "react";

import type { Translator } from "../../i18n";
import type { WorkspaceFormState } from "../../app/types";
import type { LaunchWorkspace, LaunchWorkspaceSlot, NormalizedRect, Role, WorkspaceLayoutTemplate } from "../../../../shared/types";
import {
  DEFAULT_WORKSPACE_TEMPLATE,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
  MIN_WORKSPACE_SLOT_SIZE
} from "../../../../shared/workspaceLayout";

export interface WorkspaceSplits {
  horizontal: number[];
  vertical: number[];
}

export type WorkspaceSplitAxis = keyof WorkspaceSplits;

const EXISTING_LAYOUT_MIN_SPLIT_SIZE = 0.2;

export function createWorkspaceName(workspaces: LaunchWorkspace[], t: Translator): string {
  const baseName = t("workspaces.defaultName");
  const names = new Set(workspaces.map((workspace) => workspace.name.toLocaleLowerCase()));
  let index = workspaces.length + 1;
  let candidate = `${baseName} ${index}`;

  while (names.has(candidate.toLocaleLowerCase())) {
    index += 1;
    candidate = `${baseName} ${index}`;
  }

  return candidate;
}

export function createWorkspaceFormState(workspace: LaunchWorkspace): WorkspaceFormState {
  const template = workspace.template === "single" ? DEFAULT_WORKSPACE_TEMPLATE : workspace.template;

  return {
    id: workspace.id,
    name: workspace.name,
    template,
    slots: template === workspace.template ? workspace.slots : applyWorkspaceTemplate(workspace.slots, template)
  };
}

export function createWorkspaceSlotBackground(role: Role | undefined): CSSProperties | undefined {
  if (!role) {
    return undefined;
  }

  if (role.coverImageDataUrl) {
    return {
      backgroundColor: role.coverImageDominantColor ?? "hsl(var(--muted))",
      backgroundImage: `url("${role.coverImageDataUrl}")`
    };
  }

  return {
    backgroundColor: role.coverImageDominantColor ?? "hsl(var(--muted))"
  };
}

export function rectToPreviewStyle(rect: NormalizedRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`
  };
}

export function applyWorkspaceTemplate(
  slots: LaunchWorkspaceSlot[],
  template: WorkspaceLayoutTemplate
): LaunchWorkspaceSlot[] {
  return getDefaultWorkspaceRects(template).map((rect, index) => {
    const slot = slots[index];

    return {
      id: slot?.id ?? `slot-${index + 1}`,
      ...(slot?.roleId ? { roleId: slot.roleId } : {}),
      rect
    };
  });
}

export function assignRoleToWorkspaceSlot(
  slots: LaunchWorkspaceSlot[],
  slotIndex: number,
  roleId: string | undefined
): LaunchWorkspaceSlot[] {
  return slots.map((slot, index) => {
    const shouldClear = Boolean(roleId && slot.roleId === roleId);
    const nextRoleId = index === slotIndex ? roleId : shouldClear ? undefined : slot.roleId;

    return {
      ...slot,
      ...(nextRoleId ? { roleId: nextRoleId } : { roleId: undefined })
    };
  });
}

export function swapWorkspaceSlotRoles(
  slots: LaunchWorkspaceSlot[],
  sourceSlotIndex: number,
  targetSlotIndex: number
): LaunchWorkspaceSlot[] {
  if (sourceSlotIndex === targetSlotIndex || !slots[sourceSlotIndex] || !slots[targetSlotIndex]) {
    return slots;
  }

  const sourceRoleId = slots[sourceSlotIndex].roleId;
  const targetRoleId = slots[targetSlotIndex].roleId;

  return slots.map((slot, index) => {
    if (index === sourceSlotIndex) {
      return {
        ...slot,
        ...(targetRoleId ? { roleId: targetRoleId } : { roleId: undefined })
      };
    }

    if (index === targetSlotIndex) {
      return {
        ...slot,
        ...(sourceRoleId ? { roleId: sourceRoleId } : { roleId: undefined })
      };
    }

    return slot;
  });
}

export function getWorkspaceSplits(
  template: WorkspaceLayoutTemplate,
  slots: LaunchWorkspaceSlot[]
): WorkspaceSplits {
  const defaultRects = getDefaultWorkspaceRects(template);
  const firstRect = slots[0]?.rect ?? defaultRects[0];
  const secondRect = slots[1]?.rect ?? defaultRects[1] ?? defaultRects[0];

  switch (template) {
    case "single":
      return { horizontal: [], vertical: [] };
    case "two_columns":
      return { horizontal: [], vertical: [firstRect.width] };
    case "main_left_stack_right":
      return { horizontal: [secondRect.height], vertical: [firstRect.width] };
    case "quad":
      return { horizontal: [firstRect.height], vertical: [firstRect.width] };
    case "four_columns":
      return {
        horizontal: [],
        vertical: defaultRects.slice(0, 3).map((defaultRect, index) => {
          const rect = slots[index]?.rect ?? defaultRect;
          return rect.x + rect.width;
        })
      };
  }
}

export function applyWorkspaceSplits(
  template: WorkspaceLayoutTemplate,
  slots: LaunchWorkspaceSlot[],
  splits: WorkspaceSplits
): LaunchWorkspaceSlot[] {
  const rects = createWorkspaceRectsFromSplits(template, splits);

  return slots.slice(0, getWorkspaceTemplateSlotCount(template)).map((slot, index) => ({
    ...slot,
    rect: rects[index]
  }));
}

export function createWorkspaceRectsFromSplits(
  template: WorkspaceLayoutTemplate,
  splits: WorkspaceSplits
): NormalizedRect[] {
  const defaultSplits = getWorkspaceSplits(template, []);
  const splitX = splits.vertical[0] ?? defaultSplits.vertical[0] ?? 1;
  const splitY = splits.horizontal[0] ?? defaultSplits.horizontal[0] ?? 1;

  switch (template) {
    case "single":
      return getDefaultWorkspaceRects(template);
    case "two_columns":
      return [
        { x: 0, y: 0, width: splitX, height: 1 },
        { x: splitX, y: 0, width: 1 - splitX, height: 1 }
      ];
    case "main_left_stack_right":
      return [
        { x: 0, y: 0, width: splitX, height: 1 },
        { x: splitX, y: 0, width: 1 - splitX, height: splitY },
        { x: splitX, y: splitY, width: 1 - splitX, height: 1 - splitY }
      ];
    case "quad":
      return [
        { x: 0, y: 0, width: splitX, height: splitY },
        { x: splitX, y: 0, width: 1 - splitX, height: splitY },
        { x: 0, y: splitY, width: splitX, height: 1 - splitY },
        { x: splitX, y: splitY, width: 1 - splitX, height: 1 - splitY }
      ];
    case "four_columns": {
      const boundaries = [0, ...defaultSplits.vertical.map((value, index) => splits.vertical[index] ?? value), 1];

      return boundaries.slice(0, -1).map((x, index) => ({
        x,
        y: 0,
        width: boundaries[index + 1] - x,
        height: 1
      }));
    }
  }
}

export function getWorkspaceSplitRange(
  template: WorkspaceLayoutTemplate,
  splits: WorkspaceSplits,
  axis: WorkspaceSplitAxis,
  splitIndex: number
): { min: number; max: number } {
  const positions = splits[axis];
  const minimumSize = template === "four_columns" ? MIN_WORKSPACE_SLOT_SIZE : EXISTING_LAYOUT_MIN_SPLIT_SIZE;

  return {
    min: (positions[splitIndex - 1] ?? 0) + minimumSize,
    max: (positions[splitIndex + 1] ?? 1) - minimumSize
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readWorkspaceSlotDragIndex(event: ReactDragEvent): number | undefined {
  const customValue = event.dataTransfer.getData("application/x-rion-workspace-slot");
  const plainValue = event.dataTransfer.getData("text/plain");
  const rawValue = customValue || (plainValue.startsWith("slot:") ? plainValue.slice("slot:".length) : "");
  const index = Number(rawValue);

  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

export function readRoleDragId(event: ReactDragEvent): string | undefined {
  const customValue = event.dataTransfer.getData("application/x-rion-role").trim();

  if (customValue) {
    return customValue;
  }

  const plainValue = event.dataTransfer.getData("text/plain").trim();

  if (plainValue.startsWith("role:")) {
    return plainValue.slice("role:".length).trim() || undefined;
  }

  return undefined;
}
