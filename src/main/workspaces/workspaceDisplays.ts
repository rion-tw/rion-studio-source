import type { Display } from "electron";

import type { WorkspaceDisplayInfo } from "../../shared/types";

export function createWorkspaceDisplayInfos(
  displays: Display[],
  primaryDisplayId: number
): WorkspaceDisplayInfo[] {
  return displays
    .filter((display) => display.id !== -1)
    .map((display) => ({
      id: display.id,
      label: display.label.trim(),
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
      scaleFactor: display.scaleFactor,
      isPrimary: display.id === primaryDisplayId,
      isInternal: display.internal
    }))
    .sort(compareDisplays);
}

function compareDisplays(left: WorkspaceDisplayInfo, right: WorkspaceDisplayInfo): number {
  return (
    left.bounds.x - right.bounds.x ||
    left.bounds.y - right.bounds.y ||
    Number(right.isPrimary) - Number(left.isPrimary) ||
    left.id - right.id
  );
}
