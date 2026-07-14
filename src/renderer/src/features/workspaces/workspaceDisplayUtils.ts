import type { WorkspaceDisplayInfo, WorkspaceDisplayLaunchOption } from "../../../../shared/types";
import type { Translator } from "../../i18n";

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

export function getFirstAvailableWorkspaceDisplayId(
  displays: WorkspaceDisplayLaunchOption[]
): number | null {
  return displays.find((display) => !display.occupiedByWorkspace)?.id ?? null;
}

export function hasAvailableWorkspaceDisplay(displays: WorkspaceDisplayLaunchOption[]): boolean {
  return getFirstAvailableWorkspaceDisplayId(displays) !== null;
}
