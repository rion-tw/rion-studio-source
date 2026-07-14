import type {
  PixelBounds,
  WorkspaceCompanion,
  WorkspaceCompanionPlacement,
  WorkspaceCompanionSizePercent
} from "./types";

export const workspaceCompanionPlacements = ["left", "right", "top", "bottom"] as const;
export const workspaceCompanionSizePercents = [25, 33, 40, 50] as const;

export function isWorkspaceCompanionPlacement(value: unknown): value is WorkspaceCompanionPlacement {
  return workspaceCompanionPlacements.includes(value as WorkspaceCompanionPlacement);
}

export function isWorkspaceCompanionSizePercent(value: unknown): value is WorkspaceCompanionSizePercent {
  return workspaceCompanionSizePercents.includes(value as WorkspaceCompanionSizePercent);
}

export function splitWorkspaceWorkArea(
  workArea: PixelBounds,
  companion: Pick<WorkspaceCompanion, "placement" | "sizePercent">
): { roleWorkArea: PixelBounds; companionWorkArea: PixelBounds } {
  const isHorizontal = companion.placement === "left" || companion.placement === "right";
  const totalSize = isHorizontal ? workArea.width : workArea.height;
  const companionSize = Math.round((totalSize * companion.sizePercent) / 100);
  const roleSize = totalSize - companionSize;

  if (isHorizontal) {
    const companionOnStart = companion.placement === "left";
    return {
      roleWorkArea: {
        x: companionOnStart ? workArea.x + companionSize : workArea.x,
        y: workArea.y,
        width: roleSize,
        height: workArea.height
      },
      companionWorkArea: {
        x: companionOnStart ? workArea.x : workArea.x + roleSize,
        y: workArea.y,
        width: companionSize,
        height: workArea.height
      }
    };
  }

  const companionOnStart = companion.placement === "top";
  return {
    roleWorkArea: {
      x: workArea.x,
      y: companionOnStart ? workArea.y + companionSize : workArea.y,
      width: workArea.width,
      height: roleSize
    },
    companionWorkArea: {
      x: workArea.x,
      y: companionOnStart ? workArea.y : workArea.y + roleSize,
      width: workArea.width,
      height: companionSize
    }
  };
}
