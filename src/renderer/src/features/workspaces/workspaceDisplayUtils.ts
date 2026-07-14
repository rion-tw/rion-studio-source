import type { WorkspaceDisplayInfo, WorkspaceDisplayLaunchOption } from "../../../../shared/types";
import type { Translator } from "../../i18n";

export interface WorkspaceTargetDisplayPresentation {
  isUnavailable: boolean;
  label: string;
  title: string;
}

export function formatWorkspaceDisplayLabel(
  display: WorkspaceDisplayInfo,
  index: number,
  t: Translator
): string {
  const name = display.label || t("workspaces.displayFallback").replace("{index}", String(index + 1));
  const details = [`${display.bounds.width}×${display.bounds.height}`];
  if (display.isPrimary) {
    details.push(t("workspaces.displayPrimary"));
  }
  if (display.isInternal) {
    details.push(t("workspaces.displayInternal"));
  }
  return `${name} · ${details.join(" · ")}`;
}

export function getWorkspaceTargetDisplayPresentation(
  targetDisplayId: number | undefined,
  displays: WorkspaceDisplayInfo[],
  t: Translator
): WorkspaceTargetDisplayPresentation {
  if (targetDisplayId === undefined) {
    const label = t("workspaces.targetDisplayFollowApp");
    return {
      isUnavailable: false,
      label,
      title: `${t("workspaces.targetDisplay")}: ${label}`
    };
  }

  const displayIndex = displays.findIndex((display) => display.id === targetDisplayId);
  if (displayIndex === -1) {
    const label = t("workspaces.targetDisplayUnavailable").replace("{id}", String(targetDisplayId));
    return {
      isUnavailable: true,
      label,
      title: `${t("workspaces.targetDisplay")}: ${label}`
    };
  }

  const display = displays[displayIndex];
  const label = display.label || t("workspaces.displayFallback").replace("{index}", String(displayIndex + 1));
  return {
    isUnavailable: false,
    label,
    title: `${t("workspaces.targetDisplay")}: ${formatWorkspaceDisplayLabel(display, displayIndex, t)}`
  };
}

export function getFirstAvailableWorkspaceDisplayId(
  displays: WorkspaceDisplayLaunchOption[]
): number | null {
  return displays.find((display) => !display.occupiedByWorkspace)?.id ?? null;
}

export function hasAvailableWorkspaceDisplay(displays: WorkspaceDisplayLaunchOption[]): boolean {
  return getFirstAvailableWorkspaceDisplayId(displays) !== null;
}
