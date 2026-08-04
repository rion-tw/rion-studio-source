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

  it("freezes the complete live snapshot while a window close tears down its tabs", async () => {
    const [close, tabClose, persistence, saveInput] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_14_window_close_contract.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_14_preview_tab_close.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_15_window_state_persistence.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_08_runtime_window_snapshot_input.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(close).toContain("current_window_close_in_progress");
    expect(tabClose).toContain("if !self.current_window_close_in_progress(&window_id)");
    expect(persistence).toContain("if self.current_window_close_in_progress(window_id)");
    expect(saveInput).toContain("LiveWindowTabState owns which tabs are saved");
    expect(saveInput).toMatch(/live_window\s*\.tabs/);
    expect(saveInput).not.toContain("snapshot.tabs.iter().any(|tab| tab.id == *tab_id)");
  });

  it("fences cancelled create effects and retires a create that loses its Core acknowledgement race", async () => {
    const [executor, admission, core] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_07_hydrate_tab_dividers.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_07_effect_admission.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../crates/rion-core/src/operation_actor/section_01_default_pending_effect_capacity.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(core).toContain("pub fn effect_is_pending");
    expect(executor).toContain("create_effect_is_still_pending");
    expect(executor).toContain("retire_unacknowledged_created_tab");
    expect(admission).toContain("self.destroy_tab(tab_id)?");
    expect(admission).toContain('"tab.stale-create-retired"');
  });

  it("queues relaunch behind both active tombstones and fenced closing tabs", async () => {
    const [menu, preview, state] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/runtime_tab_menu/section_03_launch_from_menu.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_22_with_native_creation_lane.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_10_tab_close_fence.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(menu).toContain("defer_launch_until_close_settles");
    expect(menu).toContain('message == "The runtime tab is closing."');
    expect(preview).toContain('"SYSTEM_RUNTIME_TAB_CLOSING"');
    expect(state).toContain("launcher_source_is_closing");
    expect(state).toContain("close_previews");
    expect(state).toContain("optimistic_close_matches_launcher_source");
    expect(state).toContain("optimistic_closed_tabs");
  });

  it("stages saved role slots before an accepted restore can race native tab registration", async () => {
    const [restore, create, roleSlots, state] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_05_invoke_core_async.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_23_create_tab.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_12_role_view_contract.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_04_next_revision.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    const missingRestore = restore.slice(
      restore.indexOf("RuntimeRestoreTabMatch::Missing =>"),
      restore.indexOf("// A launch publishes a partial runtime snapshot")
    );
    expect(missingRestore).toContain("prepare_restored_tab_role_slots");
    expect(missingRestore.indexOf("prepare_restored_tab_role_slots")).toBeLessThan(
      missingRestore.indexOf('"type": "browserRoleLaunch"')
    );
    expect(restore).toContain("if !prepared_role_slots");
    expect(state).toContain("pending_restore_role_slots");
    expect(create).toContain("apply_prepared_role_slots_to_effect(&mut state, &mut tab)");
    expect(roleSlots).toContain("fn apply_prepared_role_slots_to_effect");
  });

  it("discards crash recovery without clearing permanent saved-window tabs", async () => {
    const source = await readFile(
      new URL(
        "../src-tauri/src/lib/section_06_select_non_conflicting_saved_windows.rs",
        import.meta.url
      ),
      "utf8"
    );
    const discard = source.slice(
      source.indexOf("fn discard_saved_game_windows"),
      source.indexOf("fn string_argument")
    );

    expect(discard).toContain("replace_restore_progress(state, Vec::new())");
    expect(discard).toContain("persist_restore_session(false)");
    expect(discard).not.toContain("CoreCommand::GameWindowUpdate");
    expect(discard).not.toContain("tabs: Some(Vec::new())");
  });

  it("restores surfaces in owner priority without changing saved tab order or active tab", async () => {
    const [restore, create, contract, state, persistence, projection] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_05_invoke_core_async.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_23_create_tab.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_12_window_restore_contract.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_04_next_revision.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_15_window_state_persistence.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_25_apply_runtime.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(restore).toContain("prepare_restored_window_tabs");
    expect(restore).toContain("finish_prepared_restored_window_tabs");
    expect(restore).not.toContain("CoreCommand::GameWindowUpdate");
    expect(restore).not.toContain("restore_workspace_conflict_metadata");
    expect(create).toContain("restored_tab_selection_intent");
    expect(create).toContain("reconcile_prepared_restored_window_tabs");
    expect(contract).toContain("live.reorder_known_tabs(&prepared.ordered_tab_ids)");
    expect(contract).toContain("mark_restored_native_tab_reserved");
    expect(contract).toContain("prepared.reserved_tab_ids.contains(tab_id)");
    expect(contract).toContain("mark_restored_tab_creation_terminal");
    expect(contract).toContain("prepared.terminal_tab_ids.contains(tab_id)");
    expect(contract).toContain("prepared.successful_tab_ids.contains(tab_id)");
    expect(contract).toContain("live.select(active_tab_id, revision)");
    expect(contract).toContain("self.reorder_native_tabs(window_id, &ordered)");
    expect(persistence).toContain("self.pending_window_tab_restore(window_id).is_some()");
    expect(projection).toContain("state.pending_window_tab_restores.clone()");
    expect(projection).toContain("restore.ordered_tab_ids.as_slice()");
    expect(projection).toContain("restore.active_tab_id.clone()");
    expect(state).toContain("pending_window_tab_restores");
  });

  it("waits for the old window generation and repairs live presentation metadata before activation", async () => {
    const [restore, activation, repair] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_05_invoke_core_async.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_13_window_zoom_indicator_label.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_09_presentation_repair.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(restore).toContain("wait_for_window_close_before_reopen");
    expect(activation).toContain("repair_missing_tab_presentation");
    expect(activation).not.toContain(
      "Runtime tab was not found in the presentation registry."
    );
    expect(repair).toContain('"tab.presentation-repaired"');
    expect(repair).toContain("live.surface_bindings");
    expect(repair).toContain("self.try_ensure_native_tab");
  });

  it("refreshes a restored macOS role viewport after the main frame becomes ready", async () => {
    const [create, viewportRefresh] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_23_create_tab.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_21_ready_surface_viewport.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(create).toContain("schedule_ready_surface_viewport_refresh");
    expect(viewportRefresh).toContain("layout_runtime_tab_inner(&tab_id)");
    expect(viewportRefresh).toContain(
      'window.dispatchEvent(new Event("resize"))'
    );
    expect(viewportRefresh).toContain(
      "surface.webview.label() == surface_label.as_str()"
    );
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
