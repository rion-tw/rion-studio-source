import { describe, expect, it } from "vitest";

import { normalizeWorkspaceRectEdges } from "../src/shared/workspaceLayout";

describe("workspace rectangle edge normalization", () => {
  it("repairs legacy four-decimal shared edges without mutating the input", () => {
    const rects = [
      { x: 0, y: 0, width: 0.3333, height: 1 },
      { x: 0.3333, y: 0, width: 0.3333, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ];

    expect(normalizeWorkspaceRectEdges(rects)).toEqual([
      { x: 0, y: 0, width: 0.3333, height: 1 },
      { x: 0.3333, y: 0, width: 0.3334, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ]);
    expect(rects[1]).toEqual({ x: 0.3333, y: 0, width: 0.3333, height: 1 });
  });

  it("repairs shared horizontal edges only where perpendicular spans overlap", () => {
    expect(normalizeWorkspaceRectEdges([
      { x: 0, y: 0, width: 0.5, height: 0.4999 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 }
    ])).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 }
    ]);
  });

  it("preserves a real gap larger than the persistence tolerance", () => {
    expect(normalizeWorkspaceRectEdges([
      { x: 0, y: 0, width: 0.6665, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ])).toEqual([
      { x: 0, y: 0, width: 0.6665, height: 1 },
      { x: 0.6667, y: 0, width: 0.3333, height: 1 }
    ]);
  });
});
