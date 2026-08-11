import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("workspace launch workflow", () => {
  it("passes the optional authoritative Game Window destination without occupancy routing", async () => {
    const workflow = await readFile(
      "src/renderer/src/hooks/useWorkspaceWorkflow.ts",
      "utf8"
    );

    expect(workflow).toContain("launchWorkspace(workspace.id, destination)");
    expect(workflow).not.toContain('result.kind === "conflict"');
    expect(workflow).not.toContain("stopConflicts: true");
    expect(workflow).not.toContain("selectDisplay");
    expect(workflow).not.toContain("target_occupied");
  });
});
