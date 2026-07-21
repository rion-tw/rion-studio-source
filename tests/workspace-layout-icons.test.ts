import { describe, expect, it } from "vitest";

import { workspaceLayoutTemplates } from "../src/shared/workspaceLayout";
import { workspaceLayoutIconNodes } from "../src/shared/workspaceLayoutIcons";

describe("workspace layout icons", () => {
  it("defines shared SVG nodes for every readable workspace template", () => {
    expect(Object.keys(workspaceLayoutIconNodes).sort()).toEqual(
      [...workspaceLayoutTemplates].sort()
    );
    Object.values(workspaceLayoutIconNodes).forEach((nodes) => {
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every(([elementName]) => ["path", "rect"].includes(elementName))).toBe(true);
    });
  });

  it("renders the single layout without internal dividers", () => {
    expect(workspaceLayoutIconNodes.single).toEqual([
      ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "outer" }]
    ]);
  });
});
