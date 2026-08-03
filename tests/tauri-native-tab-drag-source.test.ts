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
    expect(runtime).toContain("struct TabDragIntentCoordinator");
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
    expect(activation).toContain(
      '#[cfg(target_os = "macos")]\nuse std::sync::OnceLock;'
    );
  });

  it("uses a non-owning cross-window ghost slot", async () => {
    const macController = await readFile(
      new URL("../src-tauri/native/macos/RionRuntimeTabsController.mm", import.meta.url),
      "utf8"
    );

    expect(macController).toContain("BOOL reorderedLocalTab");
    expect(macController).toContain("Cross-window hover is a presentation-only ghost");
    expect(macController).toContain("showExternalDragGhostBeforeIdentifier:");
    expect(macController).toContain("_externalDragGhostWidth + kRionTabSpacing");
  });
});
