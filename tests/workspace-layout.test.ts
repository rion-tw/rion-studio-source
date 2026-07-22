import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKSPACE_TEMPLATE,
  isWorkspaceLayoutTemplate,
  workspaceLayoutTemplates
} from "../src/shared/workspaceLayout";

describe("workspace layout templates", () => {
  it("offers single before multi-slot templates without changing the default", () => {
    expect(workspaceLayoutTemplates[0]).toBe("single");
    expect(workspaceLayoutTemplates).toContain("two_columns");
    expect(isWorkspaceLayoutTemplate("single")).toBe(true);
    expect(DEFAULT_WORKSPACE_TEMPLATE).toBe("two_columns");
  });
});
