import type {
  LaunchWorkspaceSlot,
  NormalizedRect,
  WorkspaceBrowserZoomMode,
  WorkspaceBrowserZoomPercent,
  WorkspaceSlotBrowserZoomPercent,
  WorkspaceLayoutTemplate,
  WorkspaceResourcePolicy
} from "./types";

export const MAX_WORKSPACE_SLOTS = 9;
export const MIN_WORKSPACE_SLOT_SIZE = 0.12;
export const DEFAULT_WORKSPACE_TEMPLATE: WorkspaceLayoutTemplate = "two_columns";
export const DEFAULT_WORKSPACE_BROWSER_ZOOM_MODE: WorkspaceBrowserZoomMode = "adaptive";
export const DEFAULT_WORKSPACE_BROWSER_ZOOM_PERCENT: WorkspaceBrowserZoomPercent = 100;
export const MIN_WORKSPACE_SLOT_BROWSER_ZOOM_PERCENT = 50;
export const MAX_WORKSPACE_SLOT_BROWSER_ZOOM_PERCENT = 300;
export const DEFAULT_WORKSPACE_RESOURCE_POLICY: WorkspaceResourcePolicy = {
  mode: "adaptive"
};
export const workspaceBrowserZoomPercents: WorkspaceBrowserZoomPercent[] = [
  25,
  33,
  50,
  67,
  75,
  80,
  90,
  100,
  110,
  125
];

export const workspaceLayoutTemplates: WorkspaceLayoutTemplate[] = [
  "single",
  "two_columns",
  "three_columns",
  "main_left_stack_right",
  "main_right_stack_left",
  "main_center_side_stacks",
  "three_top_two_bottom",
  "two_top_three_bottom",
  "quad",
  "four_columns",
  "six_grid",
  "eight_grid",
  "nine_grid"
];

export function getDefaultWorkspaceBrowserZoomPercent(
  template: WorkspaceLayoutTemplate
): WorkspaceBrowserZoomPercent {
  if (template === "eight_grid") {
    return 75;
  }

  if (template === "nine_grid") {
    return 80;
  }

  if (
    template === "six_grid" ||
    template === "main_center_side_stacks" ||
    template === "three_top_two_bottom" ||
    template === "two_top_three_bottom"
  ) {
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

export function isWorkspaceSlotBrowserZoomPercent(
  value: unknown
): value is WorkspaceSlotBrowserZoomPercent {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_WORKSPACE_SLOT_BROWSER_ZOOM_PERCENT &&
    value <= MAX_WORKSPACE_SLOT_BROWSER_ZOOM_PERCENT
  );
}

export function isWorkspaceBrowserZoomMode(value: unknown): value is WorkspaceBrowserZoomMode {
  return value === "adaptive" || value === "fixed";
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
    case "main_center_side_stacks":
    case "three_top_two_bottom":
    case "two_top_three_bottom":
      return 5;
    case "six_grid":
      return 6;
    case "eight_grid":
      return 8;
    case "nine_grid":
      return 9;
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
    case "main_center_side_stacks":
      return [
        { x: 0.3, y: 0, width: 0.4, height: 1 },
        { x: 0, y: 0, width: 0.3, height: 0.5 },
        { x: 0, y: 0.5, width: 0.3, height: 0.5 },
        { x: 0.7, y: 0, width: 0.3, height: 0.5 },
        { x: 0.7, y: 0.5, width: 0.3, height: 0.5 }
      ];
    case "three_top_two_bottom":
      return createSplitRowRects(3, 2);
    case "two_top_three_bottom":
      return createSplitRowRects(2, 3);
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
    case "eight_grid":
      return createGridRects(4, 2);
    case "nine_grid":
      return createGridRects(3, 3);
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

function createSplitRowRects(topColumnCount: number, bottomColumnCount: number): NormalizedRect[] {
  return [
    ...createEqualColumnRects(topColumnCount).map((rect) => ({ ...rect, height: 0.5 })),
    ...createEqualColumnRects(bottomColumnCount).map((rect) => ({ ...rect, y: 0.5, height: 0.5 }))
  ];
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
  return typeof value === "string" && workspaceLayoutTemplates.includes(value as WorkspaceLayoutTemplate);
}
