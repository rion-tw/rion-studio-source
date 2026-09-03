import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("runtime window lifecycle authority", () => {
  it("returns from the macOS native shortcut before waiting for AppKit presentation", async () => {
    const [menu, windowControl] = await Promise.all([
      readFile(new URL("../src-tauri/src/application_menu.rs", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_12_handle_divider_pointer.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);
    const focusedShortcut = menu.slice(
      menu.indexOf("ApplicationShortcutTarget::Focused =>"),
      menu.indexOf("ApplicationShortcutTarget::MainWindow")
    );
    const requestOnly = windowControl.slice(
      windowControl.indexOf("pub fn request_focused_runtime_fullscreen("),
      windowControl.indexOf("pub fn toggle_runtime_window_fullscreen(")
    );

    expect(focusedShortcut).toContain("request_focused_runtime_fullscreen()");
    expect(focusedShortcut).not.toContain("runtime_operation_receipt_result");
    expect(requestOnly).toContain("request_runtime_window_toggle_fullscreen");
    expect(requestOnly).not.toContain("wait_native_operation_summary");
  });

  it("refreshes Windows toolbar geometry after exact fullscreen and preference terminals", async () => {
    const [windowControl, metadata, layout] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_12_handle_divider_pointer.rs",
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
          "../src-tauri/src/system_runtime/section_11_provisionally_move_tab_with_visibility.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);
    const fullscreen = windowControl.slice(
      windowControl.indexOf("pub fn toggle_runtime_window_fullscreen("),
      windowControl.indexOf("fn collect_browser_performance_diagnostics(")
    );
    const refreshMetadata = metadata.slice(
      metadata.indexOf("pub(crate) fn refresh_projection_metadata("),
      metadata.indexOf("fn projection_metadata(")
    );
    const refreshLayout = layout.slice(
      layout.indexOf("fn refresh_windows_active_window_layout("),
      layout.indexOf("pub fn set_windows_toolbar_revealed(")
    );

    expect(fullscreen).toContain("let summary = self.wait_native_operation_summary(&operation_id)?");
    expect(fullscreen).toContain("SystemRuntimeOperationStatus::Applied");
    expect(fullscreen).toContain("SystemRuntimeOperationStatus::Degraded");
    expect(fullscreen).toContain("self.refresh_windows_active_window_layout(window_id)");
    expect(fullscreen.indexOf("wait_native_operation_summary"))
      .toBeLessThan(fullscreen.indexOf("refresh_windows_active_window_layout"));
    expect(refreshMetadata).toContain("always_show_toolbar_in_full_screen");
    expect(refreshMetadata).toContain("!= next_metadata");
    expect(refreshMetadata).toContain("if refresh_windows_layout");
    expect(refreshMetadata).toContain("drop(metadata)");
    expect(refreshMetadata).toContain("window.is_fullscreen().unwrap_or(false)");
    expect(refreshMetadata).toContain("self.refresh_windows_active_window_layout(&window_id)");
    expect(refreshMetadata.indexOf("*metadata = next_metadata"))
      .toBeLessThan(refreshMetadata.indexOf("refresh_windows_active_window_layout"));
    expect(refreshLayout).toContain("window.selected_tab_id.clone()");
    expect(refreshLayout).toContain("windows_active_tab_is_materialized");
    expect(refreshLayout).toContain("self.layout_runtime_tab(&tab_id)");
  });

  it("routes active-tab selection through revision-fenced Core authority", async () => {
    const [selection, core] = await Promise.all([
      readFile(new URL("../src-tauri/src/lib/section_01_activation.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/app.rs", import.meta.url), "utf8")
    ]);

    expect(selection).toContain("schedule_live_window_state_persistence(window_id)");
    expect(selection).not.toContain("TabSelectionCommitCoordinator");
    expect(selection).not.toContain("The active tab metadata did not converge");
    expect(core).toContain("CoreCommand::EmbeddedTabActivate");
    expect(core).toContain("CoreCommand::EmbeddedTabHide");
    expect(core).toContain("fn apply_runtime_tab_action(");
    expect(core).toContain("if window.window_generation != window_generation");
    expect(core).toContain("|| window.revision != topology_revision");
    expect(core).toContain("RuntimeIntent::CommitTopology(");
    expect(core).toContain("project_embedded_runtime_snapshot_without_persistence");
    expect(core).not.toContain("apply_embedded_tab_selection_without_native_effect");
  });

  it("authorizes behavior-layer tab actions only against live topology", async () => {
    const [overlay, menu, shell, runtimeBehavior, quickMenu, quickMenuActions] =
      await Promise.all([
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
      readFile(
        new URL(
          "../src-tauri/src/quick_menu/section_02_handle_menu_event.rs",
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
    expect(quickMenu).toContain("runtime.launcher_presence_snapshot()?");
    expect(quickMenu).toMatch(/let mut running_window_ids = presence\s+\.windows/u);
    expect(quickMenuActions).toContain("focus_live_runtime_window(&window_id)");
    expect(quickMenu).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
  });

  it("has no Core terminal drag topology command", async () => {
    const core = await readFile(
      new URL(
        "../crates/rion-core/src/app/section_08_tab_mutation.rs",
        import.meta.url
      ),
      "utf8"
    );
    expect(core).not.toContain("apply_embedded_tab_drag_topology_commit");
    expect(core).not.toContain("BrowserRuntimeCommand::CommitTabDragTopology");
    expect(core).not.toContain("EmbeddedTabDragTopologyCommit");
  });

  it("commits ordinary tab behavior without a Core topology sink", async () => {
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
    expect(shell).toContain("commit_live_tab_mutation_intent(");
    expect(shell).toContain("accept_tab_stop(");
    expect(shell).not.toContain("QueuedTabMutationSink");
    expect(shell).not.toContain("schedule_tab_mutation_core_sink(");
    expect(core).not.toContain("fn apply_embedded_tab_mutation(");
    expect(core).not.toContain("EmbeddedTabMutation");
    expect(coordinator).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
    expect(coordinator).not.toContain("matches_projection(");
    expect(coordinator).not.toContain("schedule_tab_mutation_projection_diagnostic");
    expect(coordinator).toContain("fn tab_stop_window_id(");
    expect(coordinator).toContain(".close_previews");
    expect(coordinator).not.toContain("request.target_window");
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
      persistence.indexOf("fn schedule_window_state_persistence"),
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
    expect(worker).toContain("GameWindowRuntimeSnapshotBatchCommit");
    expect(worker).toContain("lane.input.clone()");
    expect(worker).toContain("retire_window_state_persist_lane(");
    expect(worker).not.toContain("runtime_window_snapshot_commit_input");
  });

  it("saves a detached live window without consulting or compensating Core topology", async () => {
    const [menuSave, coreSave, coreModel] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/runtime_tab_menu/section_02_open_tab_from_model.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../crates/rion-core/src/app/section_08_stop_embedded_workspace_with_operation_lease.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../crates/rion-core/src/model/section_02_core_command.rs", import.meta.url),
        "utf8"
      )
    ]);
    const saveMenu = menuSave.slice(
      menuSave.indexOf("fn save_runtime_game_window("),
      menuSave.indexOf("fn saved_game_windows(")
    );
    const saveCore = coreSave.slice(
      coreSave.indexOf("fn save_runtime_game_window("),
      coreSave.lastIndexOf("\n}")
    );

    expect(saveMenu).toContain("runtime_game_window_save_input");
    expect(saveMenu).toContain("GameWindowSaveRuntime");
    expect(saveMenu).not.toContain("GameWindowDeleteIfUnchanged");
    expect(saveMenu).not.toContain("rollback");
    expect(saveCore).toContain("StateMutation::GameWindowSaveRuntime(input)");
    expect(saveCore).not.toContain("BrowserRuntimeCommand::Snapshot");
    expect(saveCore).not.toContain("browser_runtime");
    expect(saveCore).not.toContain("embedded_window_sequence");
    expect(saveCore).not.toContain("embedded_runtime_sequence");
    expect(coreModel).not.toContain("GameWindowDeleteIfUnchanged");
  });

  it("retains the complete live revision while a window close tears down its tabs", async () => {
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
    expect(tabClose).toContain("if parent_operation_id.is_none()");
    expect(tabClose).toContain("schedule_tab_close_window_state_persistence(");
    expect(persistence).toContain(
      "if !allow_window_retirement && self.current_window_close_in_progress(window_id)"
    );
    expect(persistence).toContain(
      "self.schedule_window_state_persistence(window_id, true, closes_last_tab)"
    );
    expect(saveInput).toContain("Self::live_game_window_tabs(&live_window)");
    expect(saveInput).toContain("let target_display = live_window");
    expect(saveInput).toContain("let placement = live_window");
    expect(saveInput).not.toContain("CoreCommand::BrowserRuntimeSnapshot");
    expect(saveInput).not.toContain("current_monitor()");
    expect(saveInput).not.toContain("snapshot.tabs.iter().any(|tab| tab.id == *tab_id)");
  });

  it("scopes window teardown to the atomically admitted Core close plan", async () => {
    const [shellClose, coreClose, closeContract] = await Promise.all([
      readFile(new URL("../src-tauri/src/lib/section_02_drop.rs", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../crates/rion-core/src/app/section_08_stop_embedded_workspace_with_operation_lease.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_14_window_close_contract.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(closeContract).toContain("pub(crate) fn snapshot_window_stop_request(");
    expect(shellClose).toContain("CoreCommand::BrowserWindowCloseAdmit { request }");
    expect(shellClose).toContain("runtime.commit_visible_window_close(");
    expect(closeContract).toContain("let tab_ids = stop_request.tab_ids.clone()");
    expect(closeContract).toContain("stop_request.parent_operation_id != operation_id");
    expect(closeContract).toContain("self.presentation.remove(window_id)");
    expect(shellClose).toContain("CoreCommand::BrowserWindowStop { request }");
    expect(closeContract).toContain("RuntimeWindowStopRequestRecord {");
    expect(closeContract).toContain("parent_operation_id");
    expect(coreClose).toContain("fn admit_embedded_window_close(");
    expect(coreClose).toContain("request.closing_tabs = closing_tabs");
    expect(coreClose).toContain("Some(&request.parent_operation_id)");
    expect(coreClose).toContain("for tab_id in &request.tab_ids");
  });

  it("keeps the native parent alive until every closing tab has isolated", async () => {
    const [closeContract, layout, closeFollower, create] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_14_window_close_contract.rs",
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
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_27_add_child_bounded.rs",
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
      )
    ]);
    const visibleClose = closeContract.slice(
      closeContract.indexOf("pub(crate) fn commit_visible_window_close"),
      closeContract.indexOf("pub(crate) fn complete_window_close_state_commit")
    );

    expect(visibleClose).toContain("request_platform_window_hide(&window)");
    expect(visibleClose).not.toContain("window.hide()");
    expect(visibleClose).not.toContain("window.close()");
    expect(visibleClose).toContain("retiring_window_tabs");
    expect(visibleClose).toContain(
      "cancel_provisional_tab_launch_with_presentation(tab_id, false)"
    );
    expect(visibleClose).toMatch(
      /preview_tab_close_with_presentation\(\s*tab_id,\s*false,\s*Some\(operation_id\)/u
    );
    expect(visibleClose.indexOf("request_platform_window_hide(&window)")).toBeLessThan(
      visibleClose.indexOf("self.presentation.remove(window_id)")
    );
    expect(visibleClose).toContain(
      "schedule_retiring_window_tab_cleanup(operation_id, window_id, &tab_ids)"
    );
    expect(layout).toContain("complete_retiring_window_tab");
    expect(layout).toContain("retiring_window_cleanup_failed");
    expect(layout).toContain("with_native_window_lifecycle_lane(window_id");
    expect(closeFollower).toContain("complete_retiring_window_tab(");
    expect(closeFollower).toContain("tombstone.retirement_revision");
    expect(closeFollower).toContain("retire_quarantined_tab_after_close(tab_id)");
    expect(closeFollower).toContain("return self.refresh_role_placeholders(role_id, None)");
    expect(create.indexOf("commit_live_window_record(")).toBeLessThan(
      create.indexOf("runtime_tab_from_effect(")
    );
    expect(create).toContain("state.close_previews.contains_key(&created_tab_id)");
    expect(create).toContain("wait_for_tab_close_fence(");
    expect(create).toContain("SYSTEM_RUNTIME_PREVIOUS_CLOSE_PENDING");
  });

  it("reprojects surviving role placeholders after the exact owner-tab terminal", async () => {
    const closeFollower = await readFile(
      new URL(
        "../src-tauri/src/system_runtime/section_27_add_child_bounded.rs",
        import.meta.url
      ),
      "utf8"
    );
    const successfulClose = closeFollower.slice(
      closeFollower.indexOf("state.native_resources.tabs.remove(tab_id)")
    );

    expect(successfulClose).toContain("drop(state)");
    expect(successfulClose).toContain(
      "self.schedule_released_role_placeholder_refresh(role_ids.clone())"
    );
    expect(successfulClose.indexOf('"runtime-tab-close-terminal"'))
      .toBeLessThan(successfulClose.indexOf("schedule_released_role_placeholder_refresh"));
    expect(successfulClose).not.toContain(
      "self.refresh_role_placeholders(&released.role_id, None)?"
    );
  });

  it("retires the claimed slot placeholder but reprojects sibling slots in place", async () => {
    const source = await readFile(
      new URL(
        "../src-tauri/src/system_runtime/section_23_claim_role_slot.rs",
        import.meta.url
      ),
      "utf8"
    );
    const refresh = source.slice(
      source.indexOf("fn refresh_role_placeholders("),
      source.indexOf("fn schedule_released_role_placeholder_refresh(")
    );

    expect(refresh).toContain("tab_id.as_str() == owner.tab_id");
    expect(refresh).toContain("self.close_role_placeholder_surface(placeholder)?");
    expect(refresh).toContain("runtime_slot.placeholder = None");
    expect(refresh).toContain("__rionRefreshRoleSlotIdentity");
    expect(refresh).not.toContain("self.create_role_placeholder(");
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
    expect(executor).toContain("create_effect_pending_status");
    expect(executor).toContain("Unknown Core ownership can never authorize a destructive mutation");
    expect(admission).toContain(".core_effect_is_pending");
    expect(admission).toContain(".ok()");
    expect(executor).toContain("retire_unacknowledged_created_tab");
    expect(executor).toContain("optional_divider_hydration_can_continue");
    expect(executor).toContain("self.close_managed_divider(&surface_instance_id)?");
    expect(admission).toContain("self.destroy_tab(tab_id)?");
    expect(admission).toContain('"tab.stale-create-retired"');
  });

  it("accepts relaunch immediately while old native ownership remains generation-fenced", async () => {
    const [menu, preview, fence] = await Promise.all([
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

    expect(menu).not.toContain("defer_launch_until_close_settles");
    expect(preview).not.toContain('"SYSTEM_RUNTIME_TAB_CLOSING"');
    expect(fence).not.toContain("launcher_source_is_closing");
    expect(fence).not.toContain("optimistic_closed_tabs");
    expect(fence).toContain("snapshot.tombstones.contains_key(tab_id)");
  });

  it("stages saved role slots before an accepted restore can race native tab registration", async () => {
    const [activation, create, roleSlots, state] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_01_on_demand_tab_activation.rs",
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

    const onDemandLaunch = activation.slice(
      activation.indexOf("async fn activate_runtime_tab_on_demand("),
      activation.indexOf("async fn activate_adjacent_runtime_tab_on_demand(")
    );
    expect(onDemandLaunch).toContain(
      "activate_runtime_tab_on_demand_at_revision(app, state, tab_id, native_style_applied, None)"
    );
    expect(onDemandLaunch).toContain(
      ".claim_runtime_tab_activation(tab_id, expected_revision)"
    );
    expect(
      onDemandLaunch.indexOf(".claim_runtime_tab_activation(tab_id, expected_revision)")
    ).toBeLessThan(
      onDemandLaunch.indexOf("preview_and_commit_tab_selection_inner(")
    );
    expect(onDemandLaunch).toContain("expected_revision.is_some() && !claim_applied");
    expect(onDemandLaunch).toContain("selected_dormant_tab_revision(tab_id)");
    expect(onDemandLaunch).toContain("native geometry churn");
    expect(onDemandLaunch).toContain("false,\n        None,");
    expect(onDemandLaunch).toContain("prepare_restored_tab_role_slots");
    expect(onDemandLaunch.indexOf("prepare_restored_tab_role_slots")).toBeLessThan(
      onDemandLaunch.indexOf("invoke_runtime_source_launch(")
    );
    expect(onDemandLaunch).toContain("Some(launch.tab_id.clone())");
    expect(onDemandLaunch).toContain("Some(launch.role_slots)");
    expect(onDemandLaunch).toContain(
      'mark_runtime_tab_activation_failed(tab_id, "TAURI_RUNTIME_TAB_ACTION_FAILED")'
    );
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

  it("restores full tab topology while launching only the valid foreground tab", async () => {
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
    expect(restore).toContain("let foreground_tab = saved_window_foreground_tab(&saved)");
    expect(restore).toContain("activate_selected_restored_tab_on_demand(");
    expect(restore).not.toContain("authoritative_runtime_tab_for_source(");
    expect(restore).not.toContain('"type": "browserRoleLaunch"');
    expect(restore).toContain("&target");
    expect(restore).toContain("&saved.name");
    expect(restore).toContain("&saved.tabs");
    expect(restore).toContain("finish_prepared_restored_window_tabs");
    expect(restore).not.toContain("CoreCommand::GameWindowUpdate");
    expect(restore).not.toContain("restore_workspace_conflict_metadata");
    expect(create).toContain("restored_tab_selection_intent");
    expect(create).toContain("reconcile_prepared_restored_window_tabs");
    expect(contract).toContain("self.seed_dormant_runtime_tabs(window_id, ordered_tab_ids.clone())");
    expect(contract).toContain(".set_presentation_phase(&tab.id, TabRuntimePhase::Dormant)");
    expect(contract).toContain("completion_tab_ids: foreground_tab_id.iter().cloned().collect()");
    expect(contract).toContain("self.reserve_native_tab(");
    expect(contract).toContain("self.schedule_native_tab_order_projection(window_id.to_owned(), visible_tab_ids)");
    expect(contract).toContain("self.presentation.commit_live_topology(LiveTopologyCommitInput");
    expect(contract.indexOf("commit_live_topology(LiveTopologyCommitInput")).toBeLessThan(
      contract.indexOf("with_native_creation_lane(window_id")
    );
    expect(contract).not.toContain("live.reorder_known_tabs(&prepared.ordered_tab_ids)");
    expect(contract).toContain("mark_restored_native_tab_reserved");
    expect(contract).toContain("prepared.reserved_tab_ids.contains(tab_id)");
    expect(contract).toContain("mark_restored_tab_creation_terminal");
    expect(contract).toContain("prepared.terminal_tab_ids.contains(tab_id)");
    expect(contract).toContain("prepared.successful_tab_ids.contains(tab_id)");
    expect(contract).toContain("active_tab_id: foreground_tab_id.clone()");
    expect(contract).not.toContain("self.reorder_native_tabs(");
    expect(persistence).toContain("self.pending_window_tab_restore(window_id).is_some()");
    expect(projection).toContain("state.pending_window_tab_restores.clone()");
    expect(projection).not.toContain(
      ".unwrap_or(runtime_window.tab_ids.as_slice())"
    );
    expect(projection).toContain(".map(LiveWindowRecord::tab_ids)");
    expect(projection).toContain(
      "pending_window_tab_restores.contains_key(&runtime_window.window_id)"
    );
    expect(projection).not.toContain("restore.active_tab_id.clone()");
    expect(contract).toContain("visibility_fence: foreground_tab_id.clone()");
    expect(configuration).toContain("GameWindowRuntimeSnapshotBatch");
    expect(configuration).not.toContain("pending_game_window_configurations");
    expect(state).toContain("pending_window_tab_restores");
  });

  it("waits for the old window generation without rebuilding live topology from Core", async () => {
    const [restore, activation, applyRuntime, liveSnapshot, nativeClose, runtimeLayout, launch] = await Promise.all([
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
      readFile(
        new URL("../src-tauri/src/system_runtime/section_14_window_close_contract.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_21_runtime_layout.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_22_with_native_creation_lane.rs", import.meta.url),
        "utf8"
      ),
    ]);

    expect(restore).toContain("wait_for_window_close_before_reopen");
    expect(nativeClose).toContain("retiring_native_window_hosts");
    expect(nativeClose).toContain("complete_window_destroyed");
    expect(nativeClose).toContain("self.tab_close_changed.notify_all()");
    const destroyedStart = nativeClose.indexOf(
      "pub(crate) fn complete_window_destroyed"
    );
    const destroyedEnd = nativeClose.indexOf(
      "fn finish_window_close_operation",
      destroyedStart
    );
    const destroyed = nativeClose.slice(destroyedStart, destroyedEnd);
    const retireTopology = destroyed.indexOf("self.presentation.remove(window_id)");
    const releaseFence = destroyed.indexOf(
      "state.retiring_native_window_hosts.remove(label)"
    );
    const notifyWaiters = destroyed.indexOf(
      "self.tab_close_changed.notify_all()"
    );
    expect(retireTopology).toBeGreaterThan(-1);
    expect(releaseFence).toBeGreaterThan(retireTopology);
    expect(notifyWaiters).toBeGreaterThan(releaseFence);
    expect(destroyed).toContain("host.window_id == *window_id");
    expect(destroyed).toContain("host.generation == *generation");
    expect(runtimeLayout).toContain("RetiringNativeWindowHost");
    expect(launch).toContain("wait_for_window_close_before_reopen");
    expect(activation).not.toContain("repair_missing_tab_presentation");
    expect(activation).toContain(".tab_window(tab_id)?");
    expect(applyRuntime).toContain(".compose_live_runtime_snapshot(roles)");
    expect(applyRuntime).not.toContain("move_tab_with_activation(");
    expect(applyRuntime).toContain("Core supplies only generation-fenced role ownership");
    expect(liveSnapshot).toContain("fn compose_live_runtime_snapshot(");
    expect(liveSnapshot).toContain("roles: Vec<BrowserRuntimeRoleRecord>");
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
      "surface.webview.label() == surface_label"
    );
    expect(viewportRefresh).toContain("live_ready_surface_identity");
    expect(viewportRefresh).toContain("closing_tabs.contains(tab_id)");
    expect(viewportRefresh).toContain("closing_roles.contains(role_id)");
    expect(viewportRefresh).toContain("closing_webviews");
    expect(viewportRefresh).toContain("ready_viewport_pair_needs_apply(");
    expect(viewportRefresh).not.toContain("Duration::from_millis(120)");
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
    expect(layout).toContain("quarantine_disconnected_layout_surfaces");
    expect(layout).toContain("require_live_role_restart");
    expect(layout).not.toContain("schedule_terminated_surface_recovery");
    expect(layout).not.toContain("apply_reversible_fanout");
    expect(layout).toContain("Ok(())");
  });
});
