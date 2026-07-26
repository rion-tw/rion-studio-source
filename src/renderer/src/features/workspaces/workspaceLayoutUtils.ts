import type { CSSProperties } from "react";

import type { Translator } from "../../i18n";
import type { WorkspaceFormState } from "../../app/types";
import { DEFAULT_ROLE_COVER_COLOR, roleCoverPlaceholderUrl } from "../../app/roleCoverPlaceholder";
import type { LaunchWorkspace, LaunchWorkspaceSlot, NormalizedRect, Role, WorkspaceLayoutTemplate } from "../../../../shared/types";
import type { WorkspaceDisplayInfo } from "../../../../shared/types";
import {
  DEFAULT_WORKSPACE_TEMPLATE,
  DEFAULT_WORKSPACE_BROWSER_ZOOM_MODE,
  getDefaultWorkspaceBrowserZoomPercent,
  getDefaultWorkspaceRects,
  getWorkspaceTemplateSlotCount,
  MIN_WORKSPACE_SLOT_SIZE
} from "../../../../shared/workspaceLayout";
import {
  cloneWorkspaceDisplayTarget,
  createWorkspaceDisplayTarget,
  resolveWorkspaceDisplayTarget
} from "../../../../shared/workspaceDisplays";

export interface WorkspaceSplits {
  horizontal: number[];
  vertical: number[];
}

export interface WorkspaceHorizontalResizeHandle {
  splitIndex: number;
  x: number;
  y: number;
}

export interface WorkspaceVerticalResizeHandle {
  splitIndex: number;
  x: number;
  y: number;
}

export function mergeWorkspaceRoleZoomOverrides(
  currentSlots: LaunchWorkspaceSlot[],
  previousPersistedSlots: LaunchWorkspaceSlot[],
  nextPersistedSlots: LaunchWorkspaceSlot[]
): LaunchWorkspaceSlot[] {
  const previousByRoleId = new Map(
    previousPersistedSlots.flatMap((slot) => slot.roleId ? [[slot.roleId, slot] as const] : [])
  );
  const nextByRoleId = new Map(
    nextPersistedSlots.flatMap((slot) => slot.roleId ? [[slot.roleId, slot] as const] : [])
  );

  return currentSlots.map((slot) => {
    if (!slot.roleId) {
      return slot;
    }
    const previous = previousByRoleId.get(slot.roleId);
    const next = nextByRoleId.get(slot.roleId);
    if (!previous || !next || slot.browserZoomPercent !== previous.browserZoomPercent) {
      return slot;
    }

    const { browserZoomPercent: _browserZoomPercent, ...rest } = slot;
    return {
      ...rest,
      ...(next.browserZoomPercent === undefined
        ? {}
        : { browserZoomPercent: next.browserZoomPercent })
    };
  });
}

export type WorkspaceSplitAxis = keyof WorkspaceSplits;

const EXISTING_LAYOUT_MIN_SPLIT_SIZE = 0.2;

function isMultiColumnTemplate(template: WorkspaceLayoutTemplate): boolean {
  return (
    template === "three_columns" ||
    template === "four_columns" ||
    template === "six_grid" ||
    template === "eight_grid" ||
    template === "nine_grid" ||
    template === "main_center_side_stacks" ||
    template === "three_top_two_bottom" ||
    template === "two_top_three_bottom"
  );
}

function getSplitRowVerticalIndexGroups(template: WorkspaceLayoutTemplate): number[][] | undefined {
  if (template === "three_top_two_bottom") {
    return [[0, 1], [2]];
  }

  if (template === "two_top_three_bottom") {
    return [[0], [1, 2]];
  }

  return undefined;
}

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

export function createEmptyWorkspaceForm(workspaces: LaunchWorkspace[], t: Translator): WorkspaceFormState {
  return {
    name: createWorkspaceName(workspaces, t),
    template: DEFAULT_WORKSPACE_TEMPLATE,
    browserEngine: "inherit",
    browserZoomMode: DEFAULT_WORKSPACE_BROWSER_ZOOM_MODE,
    browserZoomPercent: getDefaultWorkspaceBrowserZoomPercent(DEFAULT_WORKSPACE_TEMPLATE),
    slots: applyWorkspaceTemplate([], DEFAULT_WORKSPACE_TEMPLATE)
  };
}

export function createWorkspaceFormState(
  workspace: LaunchWorkspace,
  displays: WorkspaceDisplayInfo[] = []
): WorkspaceFormState {
  const resolvedTargetDisplay = resolveWorkspaceDisplayTarget(workspace.targetDisplay, displays);
  const targetDisplay = resolvedTargetDisplay
    ? createWorkspaceDisplayTarget(resolvedTargetDisplay)
    : workspace.targetDisplay
      ? cloneWorkspaceDisplayTarget(workspace.targetDisplay)
      : undefined;

  return {
    id: workspace.id,
    name: workspace.name,
    template: workspace.template,
    browserEngine: workspace.browserEngine ?? "inherit",
    browserZoomMode: workspace.browserZoomMode,
    browserZoomPercent: workspace.browserZoomPercent,
    ...(targetDisplay === undefined ? {} : { targetDisplay }),
    slots: workspace.slots
  };
}

export function createWorkspaceSlotBackground(role: Role | undefined): CSSProperties | undefined {
  if (!role) {
    return undefined;
  }

  return {
    backgroundColor: role.coverImageDominantColor ?? DEFAULT_ROLE_COVER_COLOR,
    backgroundImage: `url("${role.coverImageDataUrl ?? roleCoverPlaceholderUrl}")`
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
      ...(slot?.roleId && slot.browserZoomPercent !== undefined
        ? { browserZoomPercent: slot.browserZoomPercent }
        : {}),
      rect
    };
  });
}

export function assignRoleToWorkspaceSlot(
  slots: LaunchWorkspaceSlot[],
  slotIndex: number,
  roleId: string | undefined
): LaunchWorkspaceSlot[] {
  const sourceSlotIndex = roleId
    ? slots.findIndex((slot) => slot.roleId === roleId)
    : -1;
  const sourceZoomPercent = sourceSlotIndex === -1
    ? undefined
    : slots[sourceSlotIndex].browserZoomPercent;

  return slots.map((slot, index) => {
    if (index === slotIndex) {
      return withWorkspaceSlotRole(slot, roleId, sourceZoomPercent);
    }
    if (index === sourceSlotIndex) {
      return withWorkspaceSlotRole(slot, undefined);
    }
    return slot;
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
  const sourceZoomPercent = slots[sourceSlotIndex].browserZoomPercent;
  const targetZoomPercent = slots[targetSlotIndex].browserZoomPercent;

  return slots.map((slot, index) => {
    if (index === sourceSlotIndex) {
      return withWorkspaceSlotRole(slot, targetRoleId, targetZoomPercent);
    }

    if (index === targetSlotIndex) {
      return withWorkspaceSlotRole(slot, sourceRoleId, sourceZoomPercent);
    }

    return slot;
  });
}

function withWorkspaceSlotRole(
  slot: LaunchWorkspaceSlot,
  roleId: string | undefined,
  browserZoomPercent?: number
): LaunchWorkspaceSlot {
  const {
    roleId: _roleId,
    browserZoomPercent: _browserZoomPercent,
    ...rest
  } = slot;
  return {
    ...rest,
    ...(roleId ? { roleId } : {}),
    ...(roleId && browserZoomPercent !== undefined ? { browserZoomPercent } : {})
  };
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
    case "main_right_stack_left":
      return { horizontal: [secondRect.height], vertical: [secondRect.width] };
    case "main_center_side_stacks": {
      const mainRect = firstRect;
      return {
        horizontal: [secondRect.height],
        vertical: [secondRect.width, mainRect.x + mainRect.width]
      };
    }
    case "three_top_two_bottom": {
      const topMiddleRect = slots[1]?.rect ?? defaultRects[1];
      const bottomLeftRect = slots[3]?.rect ?? defaultRects[3];
      return {
        horizontal: [firstRect.height],
        vertical: [
          firstRect.x + firstRect.width,
          topMiddleRect.x + topMiddleRect.width,
          bottomLeftRect.x + bottomLeftRect.width
        ]
      };
    }
    case "two_top_three_bottom": {
      const bottomLeftRect = slots[2]?.rect ?? defaultRects[2];
      const bottomMiddleRect = slots[3]?.rect ?? defaultRects[3];
      return {
        horizontal: [firstRect.height],
        vertical: [
          firstRect.x + firstRect.width,
          bottomLeftRect.x + bottomLeftRect.width,
          bottomMiddleRect.x + bottomMiddleRect.width
        ]
      };
    }
    case "quad":
      return { horizontal: [firstRect.height], vertical: [firstRect.width] };
    case "six_grid":
    case "eight_grid":
    case "nine_grid": {
      const columnCount = template === "eight_grid" ? 4 : 3;
      return {
        horizontal: template === "nine_grid"
          ? [firstRect.height, firstRect.height + (slots[3]?.rect.height ?? defaultRects[3].height)]
          : [firstRect.height],
        vertical: defaultRects.slice(0, columnCount - 1).map((defaultRect, index) => {
          const rect = slots[index]?.rect ?? defaultRect;
          return rect.x + rect.width;
        })
      };
    }
    case "three_columns":
    case "four_columns":
      return {
        horizontal: [],
        vertical: defaultRects.slice(0, -1).map((defaultRect, index) => {
          const rect = slots[index]?.rect ?? defaultRect;
          return rect.x + rect.width;
        })
      };
  }
}

export function getWorkspaceHorizontalResizeHandles(
  template: WorkspaceLayoutTemplate,
  splits: WorkspaceSplits
): WorkspaceHorizontalResizeHandle[] {
  const splitX = splits.vertical[0] ?? 1;
  const splitX2 = splits.vertical[1] ?? 1;
  const xPositions =
    template === "main_center_side_stacks"
      ? [splitX / 2, splitX2 + (1 - splitX2) / 2]
      : template === "quad" || template === "six_grid" || template === "eight_grid"
        ? [0.25]
        : template === "nine_grid"
          ? [0.5]
        : template === "main_left_stack_right"
          ? [splitX + (1 - splitX) / 2]
          : template === "main_right_stack_left"
            ? [splitX / 2]
            : [0.5];

  return splits.horizontal.flatMap((y, splitIndex) =>
    xPositions.map((x) => ({ splitIndex, x, y }))
  );
}

export function getWorkspaceVerticalResizeHandles(
  template: WorkspaceLayoutTemplate,
  splits: WorkspaceSplits
): WorkspaceVerticalResizeHandle[] {
  const splitRowGroups = getSplitRowVerticalIndexGroups(template);

  if (splitRowGroups) {
    const splitY = splits.horizontal[0] ?? 0.5;
    const rowCenters = [splitY / 2, splitY + (1 - splitY) / 2];

    return splitRowGroups.flatMap((splitIndices, rowIndex) =>
      splitIndices.map((splitIndex) => ({
        splitIndex,
        x: splits.vertical[splitIndex],
        y: rowCenters[rowIndex]
      }))
    );
  }

  const y = template === "quad" || template === "six_grid" || template === "eight_grid"
    ? 0.25
    : template === "nine_grid"
      ? 0.5
      : 0.5;
  return splits.vertical.map((x, splitIndex) => ({ splitIndex, x, y }));
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
    case "main_right_stack_left":
      return [
        { x: splitX, y: 0, width: 1 - splitX, height: 1 },
        { x: 0, y: 0, width: splitX, height: splitY },
        { x: 0, y: splitY, width: splitX, height: 1 - splitY }
      ];
    case "main_center_side_stacks": {
      const splitX2 = splits.vertical[1] ?? defaultSplits.vertical[1] ?? 1;
      return [
        { x: splitX, y: 0, width: splitX2 - splitX, height: 1 },
        { x: 0, y: 0, width: splitX, height: splitY },
        { x: 0, y: splitY, width: splitX, height: 1 - splitY },
        { x: splitX2, y: 0, width: 1 - splitX2, height: splitY },
        { x: splitX2, y: splitY, width: 1 - splitX2, height: 1 - splitY }
      ];
    }
    case "three_top_two_bottom": {
      const vertical = defaultSplits.vertical.map((value, index) => splits.vertical[index] ?? value);
      return [
        ...createWorkspaceRowRects([0, vertical[0], vertical[1], 1], 0, splitY),
        ...createWorkspaceRowRects([0, vertical[2], 1], splitY, 1 - splitY)
      ];
    }
    case "two_top_three_bottom": {
      const vertical = defaultSplits.vertical.map((value, index) => splits.vertical[index] ?? value);
      return [
        ...createWorkspaceRowRects([0, vertical[0], 1], 0, splitY),
        ...createWorkspaceRowRects([0, vertical[1], vertical[2], 1], splitY, 1 - splitY)
      ];
    }
    case "quad":
      return [
        { x: 0, y: 0, width: splitX, height: splitY },
        { x: splitX, y: 0, width: 1 - splitX, height: splitY },
        { x: 0, y: splitY, width: splitX, height: 1 - splitY },
        { x: splitX, y: splitY, width: 1 - splitX, height: 1 - splitY }
      ];
    case "six_grid":
    case "eight_grid":
    case "nine_grid": {
      const columnBoundaries = [
        0,
        ...defaultSplits.vertical.map((value, index) => splits.vertical[index] ?? value),
        1
      ];
      const rowBoundaries = template === "nine_grid"
        ? [0, splitY, splits.horizontal[1] ?? defaultSplits.horizontal[1] ?? 1, 1]
        : [0, splitY, 1];

      return rowBoundaries.slice(0, -1).flatMap((y, rowIndex) =>
        columnBoundaries.slice(0, -1).map((x, columnIndex) => ({
          x,
          y,
          width: columnBoundaries[columnIndex + 1] - x,
          height: rowBoundaries[rowIndex + 1] - y
        }))
      );
    }
    case "three_columns":
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

function createWorkspaceRowRects(boundaries: number[], y: number, height: number): NormalizedRect[] {
  return boundaries.slice(0, -1).map((x, index) => ({
    x,
    y,
    width: boundaries[index + 1] - x,
    height
  }));
}

export function getWorkspaceSplitRange(
  template: WorkspaceLayoutTemplate,
  splits: WorkspaceSplits,
  axis: WorkspaceSplitAxis,
  splitIndex: number
): { min: number; max: number } {
  const positions = splits[axis];

  if (template === "main_center_side_stacks" && axis === "vertical") {
    return splitIndex === 0
      ? { min: MIN_WORKSPACE_SLOT_SIZE, max: (positions[1] ?? 1) - EXISTING_LAYOUT_MIN_SPLIT_SIZE }
      : { min: (positions[0] ?? 0) + EXISTING_LAYOUT_MIN_SPLIT_SIZE, max: 1 - MIN_WORKSPACE_SLOT_SIZE };
  }

  const splitRowGroup = axis === "vertical"
    ? getSplitRowVerticalIndexGroups(template)?.find((group) => group.includes(splitIndex))
    : undefined;

  if (splitRowGroup) {
    const indexInGroup = splitRowGroup.indexOf(splitIndex);
    const previousSplitIndex = splitRowGroup[indexInGroup - 1];
    const nextSplitIndex = splitRowGroup[indexInGroup + 1];

    return {
      min: (previousSplitIndex === undefined ? 0 : positions[previousSplitIndex]) + MIN_WORKSPACE_SLOT_SIZE,
      max: (nextSplitIndex === undefined ? 1 : positions[nextSplitIndex]) - MIN_WORKSPACE_SLOT_SIZE
    };
  }

  const minimumSize = axis === "vertical" && isMultiColumnTemplate(template)
    ? MIN_WORKSPACE_SLOT_SIZE
    : EXISTING_LAYOUT_MIN_SPLIT_SIZE;

  return {
    min: (positions[splitIndex - 1] ?? 0) + minimumSize,
    max: (positions[splitIndex + 1] ?? 1) - minimumSize
  };
}

export function getWorkspaceResizeAffectedSlotIndexes(
  template: WorkspaceLayoutTemplate,
  slots: LaunchWorkspaceSlot[],
  axis: WorkspaceSplitAxis,
  splitIndex: number
): number[] {
  const splits = getWorkspaceSplits(template, slots);
  const currentPosition = splits[axis][splitIndex];
  if (currentPosition === undefined) {
    return [];
  }

  const range = getWorkspaceSplitRange(template, splits, axis, splitIndex);
  const comparisonPosition = Math.abs(currentPosition - range.max) > 0.000_001 ? range.max : range.min;
  if (Math.abs(currentPosition - comparisonPosition) < 0.000_001) {
    return [];
  }

  const comparisonSplits = {
    horizontal: [...splits.horizontal],
    vertical: [...splits.vertical]
  };
  comparisonSplits[axis][splitIndex] = comparisonPosition;
  const comparisonRects = createWorkspaceRectsFromSplits(template, comparisonSplits);
  const startKey = axis === "vertical" ? "x" : "y";
  const sizeKey = axis === "vertical" ? "width" : "height";

  return slots.flatMap((slot, index) => {
    const comparisonRect = comparisonRects[index];
    if (!comparisonRect) {
      return [];
    }

    const changed =
      Math.abs(slot.rect[startKey] - comparisonRect[startKey]) >= 0.000_001 ||
      Math.abs(slot.rect[sizeKey] - comparisonRect[sizeKey]) >= 0.000_001;
    return changed ? [index] : [];
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
