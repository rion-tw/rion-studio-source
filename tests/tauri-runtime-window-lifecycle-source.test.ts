import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("runtime window lifecycle authority", () => {
  it("commits terminal drag topology without replaying the native presentation", async () => {
    const core = await readFile(
      new URL(
        "../crates/rion-core/src/app/section_08_tab_mutation.rs",
        import.meta.url
      ),
      "utf8"
    );
    const commit = core.slice(
      core.indexOf("fn apply_embedded_tab_drag_topology_commit"),
      core.indexOf("fn serialized_embedded_tab_drag_topology_commit")
    );

    expect(commit).toContain("BrowserRuntimeCommand::CommitTabDragTopology");
    expect(commit).toContain("self.emit_browser_statuses()");
    expect(commit).not.toContain("apply_embedded_runtime_command_inner");
    expect(commit).not.toContain("EmbeddedApplyRuntime");
    expect(commit).not.toContain("run_embedded_runtime_effect");
  });

  it("retains the full persistence input before the debounce worker can outlive its host", async () => {
    const persistence = await readFile(
      new URL(
        "../src-tauri/src/system_runtime/section_15_window_state_persistence.rs",
        import.meta.url
      ),
      "utf8"
    );
    const schedule = persistence.slice(
      persistence.indexOf("pub(crate) fn schedule_live_window_state_persistence"),
      persistence.indexOf("pub(crate) fn flush_live_window_state")
    );

    expect(schedule).toContain("runtime_window_snapshot_commit_input(window_id)");
    expect(schedule).toContain("input.snapshot.window_generation");
    expect(schedule).toContain("Some(input)");
    expect(schedule).not.toContain("live_window_identity(window_id)");
    const worker = persistence.slice(
      persistence.indexOf("fn run_window_state_persist_worker"),
      persistence.indexOf("fn retire_window_state_persist_lane")
    );
    expect(worker).toContain("let Some(input) = retained_input else");
    expect(worker).not.toContain("runtime_window_snapshot_commit_input");
  });

  it("keeps a disconnected tab surface outside the native window geometry transaction", async () => {
    const [geometry, layout] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_26_geometry_contract.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_21_runtime_layout.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);
    const rollback = geometry.slice(
      geometry.indexOf("fn rollback_window_geometry_native"),
      geometry.indexOf("fn submit_window_tab_layouts")
    );

    expect(geometry).toContain("self.submit_window_tab_layouts(tab_ids)");
    expect(rollback).not.toContain("layout_runtime_tab_inner");
    expect(layout).toContain("native_surface_channel_is_unavailable");
    expect(layout).toContain("schedule_layout_surface_recovery");
    expect(layout).not.toContain("apply_reversible_fanout");
    expect(layout).toContain("Ok(())");
  });
});
