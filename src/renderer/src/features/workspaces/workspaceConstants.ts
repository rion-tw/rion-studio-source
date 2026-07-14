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
import type { WorkspaceCompanionPlacement, WorkspaceLayoutTemplate } from "../../../../shared/types";

export const workspaceCompanionPlacementLabelKeys: Record<WorkspaceCompanionPlacement, TranslationKey> = {
  left: "workspaces.companion.placement.left",
  right: "workspaces.companion.placement.right",
  top: "workspaces.companion.placement.top",
  bottom: "workspaces.companion.placement.bottom"
};

const Grid3X2 = createLucideIcon("Grid3X2", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M9 3v18", key: "left-column" }],
  ["path", { d: "M15 3v18", key: "right-column" }],
  ["path", { d: "M3 12h18", key: "row" }]
]);

const Grid4X2 = createLucideIcon("Grid4X2", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M7.5 3v18", key: "column-1" }],
  ["path", { d: "M12 3v18", key: "column-2" }],
  ["path", { d: "M16.5 3v18", key: "column-3" }],
  ["path", { d: "M3 12h18", key: "row" }]
]);

const MainCenterSideStacks = createLucideIcon("MainCenterSideStacks", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M8 3v18", key: "left-column" }],
  ["path", { d: "M16 3v18", key: "right-column" }],
  ["path", { d: "M3 12h5", key: "left-row" }],
  ["path", { d: "M16 12h5", key: "right-row" }]
]);

const ThreeTopTwoBottom = createLucideIcon("ThreeTopTwoBottom", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M3 12h18", key: "row" }],
  ["path", { d: "M9 3v9", key: "top-column-1" }],
  ["path", { d: "M15 3v9", key: "top-column-2" }],
  ["path", { d: "M12 12v9", key: "bottom-column" }]
]);

const TwoTopThreeBottom = createLucideIcon("TwoTopThreeBottom", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }],
  ["path", { d: "M3 12h18", key: "row" }],
  ["path", { d: "M12 3v9", key: "top-column" }],
  ["path", { d: "M9 12v9", key: "bottom-column-1" }],
  ["path", { d: "M15 12v9", key: "bottom-column-2" }]
]);

export const workspaceTemplateLabelKeys: Record<WorkspaceLayoutTemplate, TranslationKey> = {
  single: "workspace.layout.single",
  two_columns: "workspace.layout.twoColumns",
  three_columns: "workspace.layout.threeColumns",
  main_left_stack_right: "workspace.layout.mainLeftStackRight",
  main_right_stack_left: "workspace.layout.mainRightStackLeft",
  main_center_side_stacks: "workspace.layout.mainCenterSideStacks",
  three_top_two_bottom: "workspace.layout.threeTopTwoBottom",
  two_top_three_bottom: "workspace.layout.twoTopThreeBottom",
  quad: "workspace.layout.quad",
  four_columns: "workspace.layout.fourColumns",
  six_grid: "workspace.layout.sixGrid",
  eight_grid: "workspace.layout.eightGrid"
};

export const workspaceTemplateIcons: Record<WorkspaceLayoutTemplate, LucideIcon> = {
  single: Columns2,
  two_columns: Columns2,
  three_columns: Columns3,
  main_left_stack_right: PanelsLeftBottom,
  main_right_stack_left: PanelsRightBottom,
  main_center_side_stacks: MainCenterSideStacks,
  three_top_two_bottom: ThreeTopTwoBottom,
  two_top_three_bottom: TwoTopThreeBottom,
  quad: Grid2X2,
  four_columns: Columns4,
  six_grid: Grid3X2,
  eight_grid: Grid4X2
};
