import { describe, expect, it } from "vitest";

import {
  createGameStageSlotStyle,
  createGameStageViewBounds
} from "../src/renderer/src/features/game/gameStageLayoutUtils";

describe("game stage layout utilities", () => {
  it("maps normalized workspace slots to percentage-positioned stage cells", () => {
    expect(createGameStageSlotStyle({ x: 0.5, y: 0, width: 0.5, height: 1 })).toEqual({
      left: "50%",
      top: "0%",
      width: "50%",
      height: "100%"
    });
  });

  it("rounds DOM viewport rectangles for Electron view bounds", () => {
    expect(
      createGameStageViewBounds("role-1", {
        left: 251.6,
        top: 82.4,
        width: 706.7,
        height: 511.2
      })
    ).toEqual({
      roleId: "role-1",
      bounds: { x: 252, y: 82, width: 707, height: 511 }
    });
  });

  it("omits collapsed viewports", () => {
    expect(createGameStageViewBounds("role-1", { left: 0, top: 0, width: 0, height: 400 })).toBeNull();
  });
});
