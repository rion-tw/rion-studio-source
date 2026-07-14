import {
  Columns2,
  Columns3,
  Columns4,
  createLucideIcon,
  Grid2X2,
  PanelsLeftBottom,
  PanelsRightBottom,
  type LucideIcon
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { WorkspaceLayoutTemplate } from "../../../../shared/types";

const Grid3X2 = createLucideIcon("Grid3X2", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M9 3v18", key: "left-column" }],
  ["path", { d: "M15 3v18", key: "right-column" }],
  ["path", { d: "M3 12h18", key: "row" }]
]);

const MainCenterSideStacks = createLucideIcon("MainCenterSideStacks", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M8 3v18", key: "left-column" }],
  ["path", { d: "M16 3v18", key: "right-column" }],
  ["path", { d: "M3 12h5", key: "left-row" }],
  ["path", { d: "M16 12h5", key: "right-row" }]
]);

export const workspaceTemplateLabelKeys: Record<WorkspaceLayoutTemplate, TranslationKey> = {
  single: "workspace.layout.single",
  two_columns: "workspace.layout.twoColumns",
  three_columns: "workspace.layout.threeColumns",
  main_left_stack_right: "workspace.layout.mainLeftStackRight",
  main_right_stack_left: "workspace.layout.mainRightStackLeft",
  main_center_side_stacks: "workspace.layout.mainCenterSideStacks",
  quad: "workspace.layout.quad",
  four_columns: "workspace.layout.fourColumns",
  six_grid: "workspace.layout.sixGrid"
};

export const workspaceTemplateIcons: Record<WorkspaceLayoutTemplate, LucideIcon> = {
  single: Columns2,
  two_columns: Columns2,
  three_columns: Columns3,
  main_left_stack_right: PanelsLeftBottom,
  main_right_stack_left: PanelsRightBottom,
  main_center_side_stacks: MainCenterSideStacks,
  quad: Grid2X2,
  four_columns: Columns4,
  six_grid: Grid3X2
};
