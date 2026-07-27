import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("workspace launch workflow", () => {
  it("uses Game Window conflict confirmation without display occupancy routing", async () => {
    const workflow = await readFile(
      "src/renderer/src/hooks/useWorkspaceWorkflow.ts",
      "utf8"
    );

    expect(workflow).toContain("launchWorkspace(workspace.id)");
    expect(workflow).toContain('result.kind === "conflict"');
    expect(workflow).toContain("stopConflicts: true");
    expect(workflow).not.toContain("selectDisplay");
    expect(workflow).not.toContain("target_occupied");
  });
});
