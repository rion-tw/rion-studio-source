import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("keeps runtime UI actions behind exact Core topology fences", async () => {
  const source = await readFile(
    new URL(
      "../crates/rion-core/src/app/section_19_runtime_ui_actions.rs",
      import.meta.url
    ),
    "utf8"
  );

  expect(source).toContain("fn apply_runtime_tab_action(");
  expect(source).toContain("if window.window_generation != window_generation");
  expect(source).toContain("|| window.revision != topology_revision");
  expect(source).toContain("RuntimeIntent::CommitTopology(");
  expect(source).toContain("project_embedded_runtime_snapshot_without_persistence");
});
