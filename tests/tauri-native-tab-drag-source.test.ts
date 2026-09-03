import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("native tab drag latest-intent transaction", () => {
  it("exposes each custom AppKit tab as an actionable accessibility control", async () => {
    const macController = await readFile(
      new URL("../crates/rion-appkit/native/macos/RionRuntimeTabsController.mm", import.meta.url),
      "utf8"
    );

    expect(macController).toContain("self.accessibilityElement = YES;");
    expect(macController).toContain("_iconView.accessibilityElement = NO;");
    expect(macController).toContain("_audioView.accessibilityElement = NO;");
    expect(macController).toContain("_titleField.accessibilityElement = NO;");
    expect(macController).toContain("- (BOOL)accessibilityPerformPress {");
    expect(macController).toContain(
      "return [NSApp sendAction:self.action to:self.target from:self];"
    );
    expect(macController).toContain("- (BOOL)accessibilityPerformShowMenu {");
    expect(macController).toContain("withObject:self.tabIdentifier");
    expect(macController).toContain("NSAccessibilityShowMenuAction");
    expect(macController).toContain("NSAccessibilityDeleteAction");
    expect(macController).toContain("[self performAccessibilityClose]");
    expect(macController).toContain("NSAccessibilityIncrementAction");
    expect(macController).toContain("NSAccessibilityDecrementAction");
    expect(macController).toContain("accessibilityCustomActions");
    expect(macController).toContain("NSAccessibilityActionDescription(");
    expect(macController).toContain("byAccessibilityOffset:(NSInteger)offset");
    expect(macController).toContain('@"type" : @"reorder"');
  });

  it("serializes callbacks while stale semantic events become superseded", async () => {
    const [runtime, macBridge, coordinator, contract, activation] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/runtime_tabs_macos.rs", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_03_tab_drag_intent_coordinator.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_26_tab_drag_contract.rs", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../src-tauri/src/lib/section_01_activation.rs", import.meta.url), "utf8"),
    ]);

    expect(macBridge).toContain("pub(crate) fn reorder_fenced(");
    expect(macBridge).toContain(
      "tokio::sync::mpsc::unbounded_channel::<QueuedNativeTabAction>()"
    );
    expect(macBridge).toContain("stamp_native_tab_drag_action(");
    expect(macBridge).toContain("coalesce_native_tab_drag_actions(");
    expect(macBridge).toContain("release_terminal_tab_drag_pointer_passthrough(");
    expect(macBridge).toContain("run_on_appkit_tracking_main");
    expect(macBridge).toContain("DispatchQueue::main().exec_async");
    expect(macBridge).not.toContain("TAURI_TAB_DRAG_STALE");
    expect(runtime).toContain("struct TabDragIntentCoordinator");
    expect(runtime).toContain("release_tab_drag_pointer_passthrough(");
    expect(runtime).toContain("projection_is_superseded(");
    expect(runtime).toContain("reorder_native_tabs_for_projection(");
    const stampCfg = coordinator.indexOf('#[cfg(any(target_os = "macos", test))]');
    expect(stampCfg).toBeGreaterThanOrEqual(0);
    expect(coordinator.indexOf("pub(crate) struct NativeTabDragActionStamp")).toBeGreaterThan(
      stampCfg
    );
    expect(coordinator).toContain(
      '#[cfg(any(target_os = "macos", test))]\n    pub(crate) fn stamp_action('
    );
    expect(contract).toContain(
      '#[cfg(target_os = "macos")]\n    pub(crate) fn stamp_native_tab_drag_action('
    );
    expect(contract).not.toContain("with_topology_revision");
    expect(activation).toContain(
      '#[cfg(target_os = "macos")]\nuse std::sync::OnceLock;'
    );
    expect(activation).not.toContain("tab_drag_projection_queue:");
  });

  it("uses a lightweight cross-window insertion slot without freezing the viewport", async () => {
    const macController = await readFile(
      new URL("../crates/rion-appkit/native/macos/RionRuntimeTabsController.mm", import.meta.url),
      "utf8"
    );

    expect(macController).toContain("BOOL reorderedLocalTab");
    expect(macController).toContain("showExternalDragGhostForTabIdentifier:");
    expect(macController).toContain("_dragSurfacePositionTabIdentifier");
    expect(macController).toContain("sourceTabWidth:(CGFloat)sourceTabWidth");
    expect(macController).toContain("[overlayHost addSubview:surface");
    expect(macController).toContain("surface.superview != _tabCanvas");
    expect(macController).toContain("[self.tabsController hideInsertionIndicator]");
    expect(macController).toContain("BOOL needsLayout = _dragSurfaceOverlayActive");
    expect(macController).toContain("_dragSurfaceOverlayActive = NO;");
    expect(macController).toContain("resolvedGhostWidth + kRionTabSpacing");
    expect(macController).toContain('@"orderedTabIds" : orderedTabIDs');
    expect(macController).toContain("if (_tabItems.count < 2) return YES;");
    expect(macController).toContain("animatesToStartingPositionsOnCancelOrFail = NO");
    expect(macController).not.toContain("animatesToStartingPositionsOnCancelOrFail = YES");
    expect(macController).toContain("window.ignoresMouseEvents = pointerPassthrough;");
    expect(macController).toContain("[window makeKeyAndOrderFront:nil]");
    const dragExit = macController.slice(
      macController.indexOf("- (void)draggingExited:"),
      macController.indexOf("- (BOOL)performDragOperation:")
    );
    const dragDrop = macController.slice(
      macController.indexOf("- (BOOL)performDragOperation:"),
      macController.indexOf("@implementation RionRuntimeTitlebarAccessoryViewController")
    );
    expect(dragExit).not.toContain("tabDropHandled = YES");
    expect(dragDrop).toContain("sourceItem.tabDropHandled = YES");
    expect(macController).not.toContain("RionRuntimeWindowSnapshot");
  });

  it("releases the visible drag immediately without a Core topology sink", async () => {
    const [handler, projection, cursorLease, provisionalWindow, state] = await Promise.all([
      readFile(
        new URL("../src-tauri/src/lib/section_08_cancel_tab_drag_session.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/lib/section_08_tab_drag_projection.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_10_tab_drag_cursor_lease.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_10_provisional_window_contract.rs",
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

    expect(projection).toContain("fn complete_visible_tab_drag(");
    expect(projection).not.toContain("fn schedule_tab_drag_projection(");
    expect(projection).not.toContain("QueuedTabDragProjection");
    expect(projection).not.toContain("CoreCommand::EmbeddedTabDragTopologyCommit");
    expect(handler).toContain("release_tab_drag_window_motion_suppression(state, session");
    expect(cursorLease).toContain("window_generation");
    expect(cursorLease).toContain("tab_drag_cursor_release_allowed(");
    expect(cursorLease).toContain("reassert_tab_drag_pointer_passthrough_if_leased(");
    expect(cursorLease).toContain("lease.session_id != session_id");
    expect(cursorLease).toContain("position_tab_drag_window(");
    expect(cursorLease).toContain(".set_position(PhysicalPosition::new(");
    expect(cursorLease).toContain("set_appkit_window_interaction(");
    expect(provisionalWindow).toContain("release_tab_drag_cursor_lease(window_id, session_id)");
    expect(state).toContain("tab_drag_cursor_leases");
  });

  it("commits topology before the immediate forward-only macOS surface follower", async () => {
    const [handler, motion, move, commit, actor, nativeChrome, contract] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_handle_game_window_tab_drag.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_tab_drag_motion.rs",
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
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_10_live_tab_drag_commit.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_03_start.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/system_runtime/section_09_record_topology_reconciled.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_tab_drag_contract.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(contract).toContain("fn tab_drag_defers_native_mutations(is_windows: bool");
    expect(contract).toContain("is_windows");
    expect(handler).toContain("finish_deferred_tab_drag_session(");
    expect(commit).toContain("self.presentation.commit_live_topology(LiveTopologyCommitInput");
    expect(commit).toContain("primary_window_id: target_window_id.to_owned()");
    expect(commit).toContain("schedule_native_tab_drag_chrome_projection(");
    expect(commit).toContain("schedule_tab_surface_move_projection(");
    expect(commit).not.toContain("thread::sleep");
    expect(commit).toContain("runtime.native_tab_host_id(&tab_id)");
    expect(commit).toContain("self.relocate_native_tab_reservation(");
    expect(nativeChrome).toContain(
      "self.reorder_native_tabs(target_window_id, target_ordered_tab_ids)?;"
    );
    expect(commit).toContain("let Some(target_ordered_tab_ids) = runtime");
    expect(commit).toContain(
      "is_some_and(|live_order| live_order == target_ordered_tab_ids)"
    );
    expect(actor).toContain("for surface in &state.applied_surfaces");
    expect(actor).toContain("request.surface_owner_tokens");
    expect(motion).toContain(".commit_live_tab_drag_destination(");
    expect(motion).toContain(".provisionally_move_tab_for_live_drag(");
    expect(motion.indexOf(".commit_live_tab_drag_destination(")).toBeLessThan(
      motion.indexOf(".provisionally_move_tab_for_live_drag(")
    );
    expect(handler).toContain("Some(&ordered_tab_ids)");
    expect(move).toContain("surface.reparent(&target_window)");
    expect(move).toContain("run_on_appkit_tracking_main");
    expect(move).toContain(".native_host_for_tab_handle(tab_id)");
    expect(move).toContain("state.native_resources.surface_registry.values_mut()");
    expect(move).not.toContain("native_tab_hosts");
    expect(move).toContain("still_hosts_native_tab");
    expect(move).toContain("state.window_has_attached_tab_handles(window_id)");
    expect(move).toContain("slot.placeholder.as_ref()");
    expect(move).not.toContain("surface.show()");
    expect(move).toContain("reconcile_window_presentation_with_visibility(");
    expect(move).toContain("follow_live_projection_membership()");
    expect(move).toContain('cfg!(target_os = "macos") && live_drag');
    expect(move).toContain("schedule_live_tab_drag_layout(tab_id.to_owned())");
    expect(handler).not.toContain("provisionally_move_tab_for_live_drag(");
    expect(move).not.toContain("tab_drag_presentation_preview");
  });

  it("uses the live macOS native window preview without a frozen window snapshot", async () => {
    const [macController, handler] = await Promise.all([
      readFile(
        new URL("../crates/rion-appkit/native/macos/RionRuntimeTabsController.mm", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_handle_game_window_tab_drag.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(macController).toContain("RionRuntimeTransparentDragImage()");
    expect(macController).toContain('@"type" : @"tabDragMove"');
    expect(macController).toContain("handleHoverWithTabIdentifier");
    expect(macController).toContain("sourceItem.tabDropHandled = YES");
    expect(macController).toContain("if (self.tabDropHandled)");
    expect(macController).not.toContain("if (operation != NSDragOperationNone)");
    expect(macController).toContain('@"orderedTabIds" : orderedTabIDs');
    expect(macController).toContain("_dragHoverSessionIdentifier");
    expect(macController).not.toContain("RionRuntimeWindowSnapshot");
    expect(macController).not.toContain("detachedWindowPreview");
    expect(macController).not.toContain("_dragPreviewImage");
    expect(macController).not.toContain("hideDragSurfaceForTabIdentifier");
    expect(macController).toContain("promotesExternalDragGhost");
    expect(handler).not.toContain("preview_parked_tab_drag_hover");
    expect(handler).toContain("process_tab_drag_motion(");
    expect(handler).toContain("GameWindowTabDragPhase::Attached");
  });

  it("carries an exact terminal order across the macOS bridge", async () => {
    const [header, bridge, rustBridge] = await Promise.all([
      readFile(new URL("../crates/rion-appkit/native/macos/RionRuntimeTabsController.h", import.meta.url), "utf8"),
      readFile(
        new URL("../crates/rion-appkit/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../src-tauri/src/runtime_tabs_macos.rs", import.meta.url), "utf8")
    ]);

    expect(header).toContain("orderedTabIdentifiersJSON");
    expect(bridge).toContain("orderedTabIDsJSON.UTF8String");
    expect(rustBridge).toContain("ordered_tab_ids_json");
    expect(rustBridge).toContain('action["orderedTabIds"]');
  });

  it("commits live in-window order before background drag projection", async () => {
    const [macBridge, handler, liveCommit, windowsDrag] = await Promise.all([
      readFile(
        new URL("../src-tauri/src/runtime_tabs_macos/section_02_labels.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/lib/section_07_handle_game_window_tab_drag.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src-tauri/src/system_runtime/section_10_live_tab_drag_commit.rs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../src/renderer/runtime-shell/runtimeTabStrip/drag.ts", import.meta.url),
        "utf8"
      )
    ]);

    expect(macBridge).toContain('action.action_type == "tabDragHover"');
    expect(macBridge).toContain("commit_live_tab_order_intent(window_id, ordered_tab_ids)");
    expect(handler).toContain("commit_live_tab_order_intent(target_window_id, &ordered_tab_ids)");
    expect(windowsDrag).not.toContain("orderedTabIds: logicalRuntimeTabOrder()");
    expect(windowsDrag).toContain('intentKind: "stop"');
    expect(windowsDrag).toContain("return { type: \"stop\", intent }");
    expect(liveCommit).toContain("commit_live_tab_order_intent(target_window_id, ordered_tab_ids)");
    expect(liveCommit).not.toContain("preview_tab_drag_order_exact(target_window_id, ordered_tab_ids, true)");
  });

  it("keeps Windows HTML tab dragging local to its source window", async () => {
    const [intent, terminal, handler] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_deferred_tab_drag_intent.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/lib/section_08_cancel_tab_drag_session.rs",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_handle_game_window_tab_drag.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(intent).toContain("windows_html_tab_drag_target_is_local(");
    expect(intent).toContain("session.source_cancelled = true;");
    expect(handler).toContain("The Windows HTML tab drag session is no longer active.");
    expect(handler).toContain("&source_window_id,");
    expect(terminal).toContain("Windows HTML tab drag ended without a local drop");
    expect(terminal).toContain("Windows HTML tabs cannot be dragged between windows");
    expect(terminal).not.toContain("float_tab_drag_session(");
    expect(handler).toContain("if deferred_native_commit || single_tab");
  });
});
