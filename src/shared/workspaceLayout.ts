import type { LaunchWorkspaceSlot, NormalizedRect, WorkspaceLayoutTemplate } from "./types";

export const MAX_WORKSPACE_SLOTS = 4;
export const DEFAULT_WORKSPACE_TEMPLATE: WorkspaceLayoutTemplate = "two_columns";

export const workspaceLayoutTemplates: WorkspaceLayoutTemplate[] = [
  "two_columns",
  "main_left_stack_right",
  "quad"
];

const readableWorkspaceLayoutTemplates: WorkspaceLayoutTemplate[] = ["single", ...workspaceLayoutTemplates];

export function getWorkspaceTemplateSlotCount(template: WorkspaceLayoutTemplate): number {
  switch (template) {
    case "single":
      return 1;
    case "two_columns":
      return 2;
    case "main_left_stack_right":
      return 3;
    case "quad":
      return 4;
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
    case "main_left_stack_right":
      return [
        { x: 0, y: 0, width: 0.5, height: 1 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
    case "quad":
      return [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
      ];
  }
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
