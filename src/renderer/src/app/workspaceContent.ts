import type { LaunchWorkspaceSlot, Role } from "../../../shared/types";

import type { Translator } from "../i18n";

type WorkspaceRoleName = Pick<Role, "name">;

export interface WorkspaceContentProjection {
  contentCount: number;
  hasContent: boolean;
  names: string[];
  roleCount: number;
  webCount: number;
}

export function projectWorkspaceContent(
  slots: readonly LaunchWorkspaceSlot[],
  roleById?: ReadonlyMap<string, WorkspaceRoleName>
): WorkspaceContentProjection {
  const names: string[] = [];
  let roleCount = 0;
  let webCount = 0;

  for (const slot of slots) {
    if (slot.roleId) {
      roleCount += 1;
      const roleName = roleById?.get(slot.roleId)?.name.trim();
      if (roleName) names.push(roleName);
      continue;
    }

    if (slot.web) {
      webCount += 1;
      const webName = slot.web.name.trim();
      if (webName) names.push(webName);
    }
  }

  const contentCount = roleCount + webCount;
  return {
    contentCount,
    hasContent: contentCount > 0,
    names,
    roleCount,
    webCount
  };
}

export function formatWorkspaceContentSummary(
  content: Pick<WorkspaceContentProjection, "hasContent" | "roleCount" | "webCount">,
  t: Translator
): string {
  if (!content.hasContent) {
    return t("workspaces.contentSummary.empty");
  }

  const parts: string[] = [];
  if (content.roleCount > 0) {
    parts.push(
      t(content.roleCount === 1
        ? "workspaces.contentSummary.roleOne"
        : "workspaces.contentSummary.roleMany")
        .replace("{count}", String(content.roleCount))
    );
  }
  if (content.webCount > 0) {
    parts.push(
      t(content.webCount === 1
        ? "workspaces.contentSummary.webOne"
        : "workspaces.contentSummary.webMany")
        .replace("{count}", String(content.webCount))
    );
  }
  return parts.join(" · ");
}
