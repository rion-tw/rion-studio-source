import { describe, expect, it } from "vitest";

import { workspaceLayoutTemplates } from "../src/shared/workspaceLayout";
import { workspaceLayoutIconNodes } from "../src/shared/workspaceLayoutIcons";

describe("workspace layout icons", () => {
  it("defines shared SVG nodes for every readable workspace template", () => {
    expect(Object.keys(workspaceLayoutIconNodes).sort()).toEqual(
      ["single", ...workspaceLayoutTemplates].sort()
    );
    Object.values(workspaceLayoutIconNodes).forEach((nodes) => {
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every(([elementName]) => ["path", "rect"].includes(elementName))).toBe(true);
    });
  });
});
