import type {
  WorkspaceDisplayInfo,
  WorkspaceDisplayLaunchOption,
  WorkspaceDisplayTarget
} from "../../../../shared/types";
import { resolveWorkspaceDisplayTarget } from "../../../../shared/workspaceDisplays";
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
  const details = [`${display.resolution.width}×${display.resolution.height}`];
  if (display.isPrimary) {
    details.push(t("workspaces.displayPrimary"));
  }
  if (display.isInternal) {
    details.push(t("workspaces.displayInternal"));
  }
  return `${name} · ${details.join(" · ")}`;
}

export function getWorkspaceTargetDisplayPresentation(
  targetDisplay: WorkspaceDisplayTarget | undefined,
  displays: WorkspaceDisplayInfo[],
  t: Translator
): WorkspaceTargetDisplayPresentation {
  if (!targetDisplay) {
    const label = t("workspaces.targetDisplayFollowApp");
    return {
      isUnavailable: false,
      label,
      title: `${t("workspaces.targetDisplay")}: ${label}`
    };
  }

  const resolvedDisplay = resolveWorkspaceDisplayTarget(targetDisplay, displays);
  const displayIndex = resolvedDisplay
    ? displays.findIndex((display) => display.id === resolvedDisplay.id)
    : -1;
  if (displayIndex === -1) {
    const label = t("workspaces.targetDisplayUnavailable").replace("{id}", String(targetDisplay.id));
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
