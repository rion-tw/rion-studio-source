import type {
  LaunchWorkspaceSlot,
  NormalizedRect,
  WorkspaceBrowserZoomPercent,
  WorkspaceLayoutTemplate
} from "./types";

export const MAX_WORKSPACE_SLOTS = 6;
export const MIN_WORKSPACE_SLOT_SIZE = 0.12;
export const DEFAULT_WORKSPACE_TEMPLATE: WorkspaceLayoutTemplate = "two_columns";
export const DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT: WorkspaceBrowserZoomPercent = 100;
export const workspaceBrowserZoomPercents: WorkspaceBrowserZoomPercent[] = [80, 90, 100, 110, 125];

export const workspaceLayoutTemplates: WorkspaceLayoutTemplate[] = [
  "two_columns",
  "three_columns",
  "main_left_stack_right",
  "main_right_stack_left",
  "quad",
  "four_columns",
  "six_grid"
];

const readableWorkspaceLayoutTemplates: WorkspaceLayoutTemplate[] = ["single", ...workspaceLayoutTemplates];

export function getDefaultWorkspaceBrowserZoomPercent(
  template: WorkspaceLayoutTemplate
): WorkspaceBrowserZoomPercent {
  if (template === "six_grid") {
    return 80;
  }

  return template === "three_columns" || template === "quad" || template === "four_columns" ? 90 : 100;
}

export function isWorkspaceBrowserZoomPercent(value: unknown): value is WorkspaceBrowserZoomPercent {
  return (
    typeof value === "number" &&
    workspaceBrowserZoomPercents.includes(value as WorkspaceBrowserZoomPercent)
  );
}

export function getWorkspaceTemplateSlotCount(template: WorkspaceLayoutTemplate): number {
  switch (template) {
    case "single":
      return 1;
    case "two_columns":
      return 2;
    case "three_columns":
    case "main_left_stack_right":
    case "main_right_stack_left":
      return 3;
    case "quad":
    case "four_columns":
      return 4;
    case "six_grid":
      return 6;
  }
}

export function getDefaultWorkspaceRects(template: WorkspaceLayoutTemplate): NormalizedRect[] {
  switch (template) {
    case "single":
      return [{ x: 0, y: 0, width: 1, height: 1 }];
    case "two_columns":
      return [
        { x: 0, y: 0, width: 0.5, height: 1 },
        { x: 0.5, y: 0, width: 0.5, height: 1 }
      ];
    case "three_columns":
      return createEqualColumnRects(3);
    case "main_left_stack_right":
      return [
        { x: 0, y: 0, width: 0.5, height: 1 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "main_right_stack_left":
      return [
        { x: 0.5, y: 0, width: 0.5, height: 1 },
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "quad":
      return [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "four_columns":
      return createEqualColumnRects(4);
    case "six_grid":
      return createGridRects(3, 2);
  }
}

function createGridRects(columnCount: number, rowCount: number): NormalizedRect[] {
  return Array.from({ length: columnCount * rowCount }, (_value, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);

    return {
      x: column / columnCount,
      y: row / rowCount,
      width: 1 / columnCount,
      height: 1 / rowCount
    };
  });
}

function createEqualColumnRects(columnCount: number): NormalizedRect[] {
  return Array.from({ length: columnCount }, (_value, index) => ({
    x: index / columnCount,
    y: 0,
    width: 1 / columnCount,
    height: 1
  }));
}

export function createDefaultWorkspaceSlots(template: WorkspaceLayoutTemplate): LaunchWorkspaceSlot[] {
  return getDefaultWorkspaceRects(template).map((rect, index) => ({
    id: `slot-${index + 1}`,
    rect
  }));
}

export function isWorkspaceLayoutTemplate(value: unknown): value is WorkspaceLayoutTemplate {
  return typeof value === "string" && readableWorkspaceLayoutTemplates.includes(value as WorkspaceLayoutTemplate);
}
