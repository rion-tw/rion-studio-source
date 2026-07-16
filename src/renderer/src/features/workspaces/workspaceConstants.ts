import {
  createLucideIcon,
  type LucideIcon
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { WorkspaceLayoutTemplate } from "../../../../shared/types";
import { workspaceLayoutIconNodes } from "../../../../shared/workspaceLayoutIcons";

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
  single: createLucideIcon("WorkspaceSingle", workspaceLayoutIconNodes.single),
  two_columns: createLucideIcon("WorkspaceTwoColumns", workspaceLayoutIconNodes.two_columns),
  three_columns: createLucideIcon("WorkspaceThreeColumns", workspaceLayoutIconNodes.three_columns),
  main_left_stack_right: createLucideIcon(
    "WorkspaceMainLeftStackRight",
    workspaceLayoutIconNodes.main_left_stack_right
  ),
  main_right_stack_left: createLucideIcon(
    "WorkspaceMainRightStackLeft",
    workspaceLayoutIconNodes.main_right_stack_left
  ),
  main_center_side_stacks: createLucideIcon(
    "WorkspaceMainCenterSideStacks",
    workspaceLayoutIconNodes.main_center_side_stacks
  ),
  three_top_two_bottom: createLucideIcon(
    "WorkspaceThreeTopTwoBottom",
    workspaceLayoutIconNodes.three_top_two_bottom
  ),
  two_top_three_bottom: createLucideIcon(
    "WorkspaceTwoTopThreeBottom",
    workspaceLayoutIconNodes.two_top_three_bottom
  ),
  quad: createLucideIcon("WorkspaceQuad", workspaceLayoutIconNodes.quad),
  four_columns: createLucideIcon("WorkspaceFourColumns", workspaceLayoutIconNodes.four_columns),
  six_grid: createLucideIcon("WorkspaceSixGrid", workspaceLayoutIconNodes.six_grid),
  eight_grid: createLucideIcon("WorkspaceEightGrid", workspaceLayoutIconNodes.eight_grid)
};
