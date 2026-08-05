import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("native tab drag latest-intent transaction", () => {
  it("serializes callbacks and fences stale native projections", async () => {
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
    expect(macBridge).toContain('error.code != "TAURI_TAB_DRAG_STALE"');
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
    expect(activation).toContain("Arc, Mutex, OnceLock");
    expect(activation).toContain("tab_drag_projection_queue:");
  });

  it("uses a lightweight cross-window insertion slot without freezing the viewport", async () => {
    const macController = await readFile(
      new URL("../src-tauri/native/macos/RionRuntimeTabsController.mm", import.meta.url),
      "utf8"
    );

    expect(macController).toContain("BOOL reorderedLocalTab");
    expect(macController).toContain("showExternalDragGhostForTabIdentifier:");
    expect(macController).toContain("_dragSurfacePositionTabIdentifier");
    expect(macController).toContain("sourceTabWidth:(CGFloat)sourceTabWidth");
    expect(macController).toContain("[_clusterContent addSubview:surface");
    expect(macController).toContain("surface.superview != _tabCanvas");
    expect(macController).toContain("[self.tabsController hideInsertionIndicator]");
    expect(macController).toContain("BOOL needsLayout = _dragSurfaceOverlayActive");
    expect(macController).toContain("_dragSurfaceOverlayActive = NO;");
    expect(macController).toContain("_externalDragGhostWidth + kRionTabSpacing");
    expect(macController).toContain('@"orderedTabIds" : orderedTabIDs');
    expect(macController).toContain("if (_tabItems.count < 2) return YES;");
    expect(macController).toContain("animatesToStartingPositionsOnCancelOrFail = NO");
    expect(macController).not.toContain("animatesToStartingPositionsOnCancelOrFail = YES");
    expect(macController).not.toContain("RionRuntimeWindowSnapshot");
  });

  it("releases the visible drag immediately and projects Core state in the background", async () => {
    const [handler, projection, cursorLease, state] = await Promise.all([
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
          "../src-tauri/src/system_runtime/section_04_next_revision.rs",
          import.meta.url
        ),
        "utf8"
      )
    ]);

    expect(projection).toContain("fn complete_visible_tab_drag(");
    expect(projection).toContain("fn schedule_tab_drag_projection(");
    expect(projection).toContain("unbounded_channel::<QueuedTabDragProjection>()");
    expect(projection).toContain("process_tab_drag_projection(&app, queued).await");
    expect(handler).toContain("release_tab_drag_window_motion_suppression(state, session");
    expect(cursorLease).toContain("window_generation");
    expect(cursorLease).toContain("lease.session_id != session_id");
    expect(cursorLease).toContain("position_tab_drag_window(");
    expect(cursorLease).toContain(".set_position(PhysicalPosition::new(");
    expect(state).toContain("tab_drag_cursor_leases");
  });

  it("commits the final topology before moving macOS surfaces in the background", async () => {
    const [handler, move, commit, contract] = await Promise.all([
      readFile(
        new URL(
          "../src-tauri/src/lib/section_07_handle_game_window_tab_drag.rs",
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
    expect(commit).toContain("self.presentation.move_tab(");
    expect(commit).toContain("schedule_native_tab_drag_chrome_retry(");
    expect(commit).toContain("schedule_tab_surface_move_retry(");
    expect(handler).toContain("Some(&ordered_tab_ids)");
    expect(move).toContain("surface.reparent(&target_window)");
    expect(move).toContain("slot.placeholder.as_ref()");
    expect(move).toContain("surface.show()");
    expect(move).toContain('cfg!(target_os = "macos") && live_drag');
    expect(move).toContain("schedule_live_tab_drag_layout(tab_id.to_owned())");
    expect(handler).toContain("provisionally_move_tab_for_live_drag(");
    expect(move).not.toContain("tab_drag_presentation_preview");
  });

  it("uses the live macOS native window preview without a frozen window snapshot", async () => {
    const [macController, handler] = await Promise.all([
      readFile(
        new URL("../src-tauri/native/macos/RionRuntimeTabsController.mm", import.meta.url),
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
    expect(macController).toContain('@"orderedTabIds" : orderedTabIDs');
    expect(macController).toContain("_dragHoverSessionIdentifier");
    expect(macController).not.toContain("RionRuntimeWindowSnapshot");
    expect(macController).not.toContain("detachedWindowPreview");
    expect(macController).not.toContain("_dragPreviewImage");
    expect(macController).not.toContain("hideDragSurfaceForTabIdentifier");
    expect(macController).toContain("promotesExternalDragGhost");
    expect(handler).not.toContain("preview_parked_tab_drag_hover");
    expect(handler).toContain("attach_tab_drag_session(");
    expect(handler).toContain("!session.single_tab && matches!(session.phase");
  });

  it("carries an exact terminal order across the macOS bridge", async () => {
    const [header, bridge, rustBridge] = await Promise.all([
      readFile(new URL("../src-tauri/native/macos/RionRuntimeTabsController.h", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm", import.meta.url),
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
    expect(windowsDrag).toContain("orderedTabIds: logicalRuntimeTabOrder()");
    expect(liveCommit).toContain("commit_live_tab_order_intent(target_window_id, ordered_tab_ids)");
    expect(liveCommit).not.toContain("preview_tab_drag_order_exact(target_window_id, ordered_tab_ids, true)");
  });
});
