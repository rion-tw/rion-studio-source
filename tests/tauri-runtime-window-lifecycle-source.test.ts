import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("runtime window lifecycle authority", () => {
  it("keeps Core active-tab metadata as a silent background projection", async () => {
    const selection = await readFile(
      new URL(
        "../src-tauri/src/lib/section_01_tab_selection_commit.rs",
        import.meta.url
      ),
      "utf8"
    );

    expect(selection).toContain("Background active-tab projection remains pending");
    expect(selection).toContain("TabActivationComponentStatus::Superseded");
    expect(selection).not.toContain("tab_selection_commit_matches");
    expect(selection).not.toContain("TAB_SELECTION_COMMIT_RETRY_DELAY");
    expect(selection).not.toContain("reconcile_tab_activation");
    expect(selection).not.toContain("The active tab metadata did not converge");
    expect(selection).not.toContain("reveal_shell_error(&request.app");
  });

  it("authorizes behavior-layer tab actions only against live topology", async () => {
    const [overlay, menu, shell, runtimeBehavior, quickMenu] = await Promise.all([
      readFile(
        new URL("../src-tauri/src/lib/section_03_rion_overlay_request.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/runtime_tab_menu/section_02_open_tab_from_model.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/lib/section_04_rion_shell_invoke.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_12_handle_divider_pointer.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/quick_menu/section_01_tray_id.rs",
          import.meta.url
        ),
        "utf8"
      ),
    ]);
    const overlayActions = overlay.slice(
      overlay.indexOf('Some("hide" | "move" | "reorder")'),
      overlay.indexOf('Some("windowControl")')
    );
    const menuActions = menu.slice(
      menu.indexOf("pub async fn handle_scoped_action("),
      menu.indexOf("fn spawn_tab_mutation(")
    );
    const shellReorder = shell.slice(
      shell.indexOf('"reorderGameWindowTab" =>'),
      shell.indexOf('"setGameWindowTabMuted" =>')
    );

    for (const source of [overlayActions, menuActions, shellReorder]) {
      expect(source).toContain("live_tab_window_id");
      expect(source).not.toContain("BrowserRuntimeSnapshot");
    }
    expect(runtimeBehavior).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
    expect(runtimeBehavior).toContain("self.presentation.selected_tabs()");
    expect(quickMenu).toContain("runtime.live_window_ids()?");
    expect(quickMenu).toContain("runtime.launcher_presence_snapshot()?");
    expect(quickMenu).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
  });

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

  it("commits every tab behavior to live state before a one-way Core sink", async () => {
    const [shell, core, coordinator] = await Promise.all([
      readFile(
        new URL("../src-tauri/src/lib/section_01_tab_mutation.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../crates/rion-core/src/app/section_08_tab_mutation.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_03_tab_mutation_coordinator.rs",
          import.meta.url
        ),
        "utf8"
      ),
    ]);
    const mutation = shell.slice(
      shell.indexOf("async fn execute_tab_mutation("),
      shell.indexOf("struct QueuedTabMutationSink")
    );
    const sink = shell.slice(
      shell.indexOf("struct QueuedTabMutationSink"),
      shell.indexOf("fn tab_stop_terminal_outcome")
    );
    const coreMutation = core.slice(
      core.indexOf("fn apply_embedded_tab_mutation("),
      core.indexOf("fn serialized_embedded_tab_mutation")
    );

    expect(mutation.indexOf("commit_live_tab_mutation_intent(")).toBeLessThan(
      mutation.indexOf("schedule_tab_mutation_core_sink(")
    );
    expect(sink).toContain("unbounded_channel::<QueuedTabMutationSink>()");
    expect(sink).not.toContain("publish_projection");
    expect(sink).not.toContain("schedule_live_window_state_persistence");
    expect(coreMutation).toContain("self.emit_browser_statuses()");
    expect(coreMutation).not.toContain("EmbeddedApplyRuntime");
    expect(coreMutation).not.toContain("apply_embedded_runtime_command_inner");
    expect(coordinator).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
    expect(coordinator).not.toContain("matches_projection(");
    expect(coordinator).not.toContain("schedule_tab_mutation_projection_diagnostic");
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
    expect(saveInput).toContain("Persistence is a projection of the already-committed in-memory UI state");
    expect(saveInput).toMatch(/live_window\s*\.tabs/);
    expect(saveInput).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
    expect(saveInput).not.toContain("current_monitor()");
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
    const [
      restore,
      create,
      contract,
      state,
      persistence,
      projection,
      configuration
    ] = await Promise.all([
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
      ),
      readFile(
        new URL(
          "../crates/rion-core/src/app/section_13_game_window_configuration.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(restore).toContain("prepare_restored_window_tabs");
    expect(restore).toContain("&target");
    expect(restore).toContain("&saved.tabs");
    expect(restore).toContain("finish_prepared_restored_window_tabs");
    expect(restore).not.toContain("CoreCommand::GameWindowUpdate");
    expect(restore).not.toContain("restore_workspace_conflict_metadata");
    expect(create).toContain("restored_tab_selection_intent");
    expect(create).toContain("reconcile_prepared_restored_window_tabs");
    expect(contract).toContain("phase: TabPresentationPhase::Reserved");
    expect(contract).toContain("self.reserve_native_tab(");
    expect(contract).toContain("self.reorder_native_tabs(window_id, &visible_tab_ids)");
    expect(contract).toContain("live.reorder_known_tabs(&prepared.ordered_tab_ids)");
    expect(contract).toContain("mark_restored_native_tab_reserved");
    expect(contract).toContain("prepared.reserved_tab_ids.contains(tab_id)");
    expect(contract).toContain("mark_restored_tab_creation_terminal");
    expect(contract).toContain("prepared.terminal_tab_ids.contains(tab_id)");
    expect(contract).toContain("prepared.successful_tab_ids.contains(tab_id)");
    expect(contract).toContain("live.select(active_tab_id, revision)");
    expect(contract.match(/self\.reorder_native_tabs\(/g)).toHaveLength(1);
    expect(persistence).toContain("self.pending_window_tab_restore(window_id).is_some()");
    expect(projection).toContain("state.pending_window_tab_restores.clone()");
    expect(projection).not.toContain(
      ".unwrap_or(runtime_window.tab_ids.as_slice())"
    );
    expect(projection).toContain(".map(LiveWindowTabState::tab_ids)");
    expect(projection).toContain(
      "pending_window_tab_restores.contains_key(&runtime_window.window_id)"
    );
    expect(projection).toContain("restore.active_tab_id.clone()");
    expect(configuration).toContain(
      "self.mark_pending_game_window_configuration(&window_id)"
    );
    expect(state).toContain("pending_window_tab_restores");
  });

  it("waits for the old window generation without rebuilding live topology from Core", async () => {
    const [restore, activation, applyRuntime, liveSnapshot] = await Promise.all([
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
        new URL("../src-tauri/src/system_runtime/section_25_apply_runtime.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_14_preview_tab_close.rs", import.meta.url),
        "utf8"
      ),
    ]);

    expect(restore).toContain("wait_for_window_close_before_reopen");
    expect(activation).not.toContain("repair_missing_tab_presentation");
    expect(activation).toContain(".tab_window(tab_id)?");
    expect(applyRuntime).toContain(".snapshot_with_live_tab_topology(snapshot)");
    expect(applyRuntime).not.toContain("move_tab_with_activation(");
    expect(applyRuntime).toContain("selection belongs exclusively to");
    expect(liveSnapshot).toContain("fn snapshot_with_live_tab_topology(");
    expect(liveSnapshot).toContain("live.all_tab_ids()");
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
