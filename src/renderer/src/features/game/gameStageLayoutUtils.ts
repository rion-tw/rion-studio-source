import type { CSSProperties } from "react";

import type { GameStageLayout, GameStageViewBounds } from "../../../../shared/types";

export function createGameStageSlotStyle(
  rect: GameStageLayout["slots"][number]["rect"]
): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`
  };
}

export function createGameStageViewBounds(
  roleId: string,
  rect: Pick<DOMRect, "height" | "left" | "top" | "width">
): GameStageViewBounds | null {
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }

  return {
    roleId,
    bounds: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  };
}
