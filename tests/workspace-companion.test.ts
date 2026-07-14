import { describe, expect, it } from "vitest";

import {
  splitWorkspaceWorkArea,
  workspaceCompanionPlacements,
  workspaceCompanionSizePercents
} from "../src/shared/workspaceCompanion";

describe("workspace companion geometry", () => {
  it.each(workspaceCompanionPlacements)("splits every supported size on the %s edge without gaps", (placement) => {
    const workArea = { x: -1_919, y: -101, width: 1_919, height: 1_079 };

    for (const sizePercent of workspaceCompanionSizePercents) {
      const { roleWorkArea, companionWorkArea } = splitWorkspaceWorkArea(workArea, {
        placement,
        sizePercent
      });
      const isHorizontal = placement === "left" || placement === "right";
      const expectedCompanionSize = Math.round(
        ((isHorizontal ? workArea.width : workArea.height) * sizePercent) / 100
      );

      if (isHorizontal) {
        expect(companionWorkArea.width).toBe(expectedCompanionSize);
        expect(roleWorkArea.width + companionWorkArea.width).toBe(workArea.width);
        expect(roleWorkArea.y).toBe(workArea.y);
        expect(companionWorkArea.y).toBe(workArea.y);
        expect(roleWorkArea.height).toBe(workArea.height);
        expect(companionWorkArea.height).toBe(workArea.height);
        expect(Math.min(roleWorkArea.x, companionWorkArea.x)).toBe(workArea.x);
        expect(Math.max(
          roleWorkArea.x + roleWorkArea.width,
          companionWorkArea.x + companionWorkArea.width
        )).toBe(workArea.x + workArea.width);
      } else {
        expect(companionWorkArea.height).toBe(expectedCompanionSize);
        expect(roleWorkArea.height + companionWorkArea.height).toBe(workArea.height);
        expect(roleWorkArea.x).toBe(workArea.x);
        expect(companionWorkArea.x).toBe(workArea.x);
        expect(roleWorkArea.width).toBe(workArea.width);
        expect(companionWorkArea.width).toBe(workArea.width);
        expect(Math.min(roleWorkArea.y, companionWorkArea.y)).toBe(workArea.y);
        expect(Math.max(
          roleWorkArea.y + roleWorkArea.height,
          companionWorkArea.y + companionWorkArea.height
        )).toBe(workArea.y + workArea.height);
      }
    }
  });

  it("uses one rounded boundary for an odd right-side split", () => {
    expect(splitWorkspaceWorkArea(
      { x: 10, y: 20, width: 1_001, height: 701 },
      { placement: "right", sizePercent: 33 }
    )).toEqual({
      roleWorkArea: { x: 10, y: 20, width: 671, height: 701 },
      companionWorkArea: { x: 681, y: 20, width: 330, height: 701 }
    });
  });
});
