import { createElement, type ReactElement } from "react";
import { Columns2, Columns3, Columns4, Grid2X2, PanelsTopLeft, type LucideIcon, type LucideProps } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import type { WorkspaceLayoutTemplate } from "../../../../shared/types";

export const workspaceTemplateLabelKeys: Record<WorkspaceLayoutTemplate, TranslationKey> = {
  single: "workspace.layout.single",
  two_columns: "workspace.layout.twoColumns",
  three_columns: "workspace.layout.threeColumns",
  main_left_stack_right: "workspace.layout.mainLeftStackRight",
  main_right_stack_left: "workspace.layout.mainRightStackLeft",
  quad: "workspace.layout.quad",
  four_columns: "workspace.layout.fourColumns"
};

interface WorkspaceTemplateIconConfig {
  Icon: LucideIcon;
  className?: string;
}

const workspaceTemplateIcons: Record<WorkspaceLayoutTemplate, WorkspaceTemplateIconConfig> = {
  single: { Icon: Columns2 },
  two_columns: { Icon: Columns2 },
  three_columns: { Icon: Columns3 },
  main_left_stack_right: { Icon: PanelsTopLeft },
  main_right_stack_left: { Icon: PanelsTopLeft, className: "scale-x-[-1]" },
  quad: { Icon: Grid2X2 },
  four_columns: { Icon: Columns4 }
};

interface WorkspaceTemplateIconProps extends LucideProps {
  template: WorkspaceLayoutTemplate;
}

export function WorkspaceTemplateIcon({
  template,
  className,
  ...props
}: WorkspaceTemplateIconProps): ReactElement {
  const { Icon, className: templateClassName } = workspaceTemplateIcons[template];

  return createElement(Icon, {
    ...props,
    className: cn(templateClassName, className)
  });
}
