import { Columns2, Grid2X2, PanelsTopLeft, type LucideIcon } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { WorkspaceLayoutTemplate } from "../../../../shared/types";

export const workspaceTemplateLabelKeys: Record<WorkspaceLayoutTemplate, TranslationKey> = {
  single: "workspace.layout.single",
  two_columns: "workspace.layout.twoColumns",
  main_left_stack_right: "workspace.layout.mainLeftStackRight",
  quad: "workspace.layout.quad"
};

export const workspaceTemplateIcons: Record<WorkspaceLayoutTemplate, LucideIcon> = {
  single: Columns2,
  two_columns: Columns2,
  main_left_stack_right: PanelsTopLeft,
  quad: Grid2X2
};
