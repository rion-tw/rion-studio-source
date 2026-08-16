import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop E2E build isolation", () => {
  it("keeps WebDriver permissions out of the production Tauri config", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    expect(config.app.withGlobalTauri).not.toBe(true);
    expect(JSON.stringify(config.app.security.capabilities ?? []))
      .not.toMatch(/wdio|desktop-e2e/iu);
  });

  it("compiles the control plane only behind the desktop-e2e feature", async () => {
    const source = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(source).toContain("#[cfg(feature = \"desktop-e2e\")]\nmod desktop_e2e;");
    const control = await readFile("src-tauri/src/desktop_e2e.rs", "utf8");
    expect(control).toContain("#[cfg(not(debug_assertions))]");
    expect(control).toContain("compile_error!");
  });

  it("keeps native keyboard injection out of product commands and capabilities", async () => {
    const [build, productConfig, run] = await Promise.all([
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("src-tauri/src/lib/section_09_run.rs", "utf8")
    ]);
    const productCommands = build.slice(
      build.indexOf("const PRODUCT_COMMANDS"),
      build.indexOf("const DESKTOP_E2E_COMMANDS")
    );
    const productHandler = run.slice(
      run.indexOf("#[cfg(not(feature = \"desktop-e2e\"))]"),
      run.indexOf("#[cfg(feature = \"desktop-e2e\")]")
    );

    expect(productCommands).not.toContain("desktop_e2e_keyboard_input");
    expect(productHandler).not.toContain("desktop_e2e_keyboard_input");
    expect(productConfig).not.toContain("desktop-e2e-keyboard-input");
    expect(build).toContain('"desktop_e2e_keyboard_input"');
    expect(run).toContain("desktop_e2e_keyboard_input");
  });

  it("reasserts only the explicitly focused role before debug keydown", async () => {
    const [control, runtimeUi, inputSupport] = await Promise.all([
      readFile("src-tauri/src/desktop_e2e.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_31_desktop_e2e_ui.rs", "utf8"),
      readFile("e2e/desktop/support/control.ts", "utf8")
    ]);

    expect(control).toContain("DesktopE2eRuntimeUiActionRequest::FocusRole");
    expect(control).toContain("remember_keyboard_target");
    expect(control).toContain("request.focus.unwrap_or(true)");
    expect(control).toContain("&& let Some(target)");
    expect(control).toContain("desktop_e2e_focus_keyboard_target(");
    expect(runtimeUi).toContain("desktop_e2e_require_selected_tab");
    expect(runtimeUi).toContain("request_platform_window_show_foreground(&window)");
    expect(runtimeUi).toContain("webview.set_focus()");
    expect(inputSupport).toContain("let focusNextKeyDown = true");
    expect(inputSupport).toContain("request: { ...request, focus }");
  });

  it("projects held macOS modifier sides onto every debug keyboard event", async () => {
    const source = await readFile("src-tauri/native/macos/RionDesktopE2E.m", "utf8");

    expect(source).toContain("RionDesktopE2EHeldModifierCodes");
    expect(source).toContain('isEqualToString:@"ShiftLeft"');
    expect(source).toContain('isEqualToString:@"ShiftRight"');
    expect(source).toContain("kCGEventFlagMaskShift");
    expect(source).toContain(
      "CGEventSetFlags(event, RionDesktopE2EUpdateModifierFlags(code, keyDown))"
    );
    expect(source.indexOf("RionDesktopE2EUpdateModifierFlags(code, keyDown)"))
      .toBeLessThan(source.indexOf("CGEventPost(kCGHIDEventTap, event)"));
  });

  it("grants native runtime evidence commands only in the desktop E2E capability", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.e2e.conf.json", "utf8"));
    const capabilities = config.app.security.capabilities as Array<{
      identifier?: string;
      permissions?: string[];
    }>;
    const debug = capabilities.find((capability) =>
      capability.identifier === "desktop-e2e-debug-only"
    );
    expect(debug?.permissions).toEqual(expect.arrayContaining([
      "core:window:allow-set-focus",
      "allow-desktop-e2e-input-diagnostics",
      "allow-desktop-e2e-keyboard-input",
      "allow-desktop-e2e-inject-duplicate-role-cookie-checkpoint",
      "allow-desktop-e2e-runtime-ui-action"
    ]));
  });

  it("keeps renderer reload readiness probes retryable", async () => {
    const source = await readFile("e2e/desktop/support/ui.ts", "utf8");

    expect(source).toContain("const RENDERER_PROBE_TIMEOUT_MS = 5_000;");
    expect(source).toContain("const RENDERER_READY_TIMEOUT_MS = 30_000;");
    expect(source).toContain("await browser.getTimeouts()");
    expect(source).toContain("await browser.setTimeout({ script: RENDERER_PROBE_TIMEOUT_MS })");
    expect(source).toContain("await browser.setTimeout({ script: previousScriptTimeout })");
    expect(source).toContain("lastProbeError = error;");
    expect(source).toContain("return false;");
    expect(source).toContain('localStorage.getItem(storageKey) !== "en"');
    expect(source).toContain('document.documentElement.lang !== "en"');
    expect(source).toContain("await browser.refresh()");
    expect(source).not.toContain("window.location.reload()");
  });

  it("fences runtime projection waits to exact tab visibility", async () => {
    const [journal, journey] = await Promise.all([
      readFile("e2e/desktop/support/renderer-events.ts", "utf8"),
      readFile("e2e/desktop/specs/cross-domain-runtime.e2e.ts", "utf8")
    ]);

    expect(journal).toContain("hidden?: boolean;");
    expect(journal).toContain("tabId?: string;");
    expect(journal).toContain("journal.runtimeStates.length - 1");
    expect(journal).toContain("if (entry.sequence <= afterSequence) continue;");
    expect(journal).toContain("candidate.id === waitRequest.tabId");
    expect(journal).toContain("tab?.hidden !== waitRequest.hidden");
    expect(journey).toContain("hiddenBeforeLaunch");
    expect(journey).toContain("hidden: false");
    expect(journey).toContain("tabId: tab.id");
  });

  it("keeps router-native test navigation out of production renderer assets", async () => {
    const renderer = await readFile("src/renderer/src/main.tsx", "utf8");
    const isolationCheck = await readFile("scripts/verifyDesktopE2eIsolation.mjs", "utf8");

    expect(renderer).toContain("if (__RION_DESKTOP_E2E__)");
    expect(renderer).toContain("window.__rionStudioDesktopE2eNavigate");
    expect(renderer).toContain("router.navigate(path)");
    expect(isolationCheck).toContain("__rionStudioDesktopE2eNavigate");
  });

  it("submits Windows close through the native window queue", async () => {
    const source = await readFile(
      "src-tauri/src/system_runtime/section_31_desktop_e2e.rs",
      "utf8"
    );
    const windowsControl = source.slice(
      source.indexOf("#[cfg(windows)]\nfn desktop_e2e_apply_native_window_control("),
      source.indexOf("#[cfg(target_os = \"macos\")]\nfn desktop_e2e_apply_native_window_control(")
    );
    const closeControl = windowsControl.slice(
      windowsControl.indexOf("DesktopE2eWindowControlRequest::Close =>"),
      windowsControl.indexOf("DesktopE2eWindowControlRequest::Minimize =>")
    );

    expect(closeControl).toContain("PostMessageW(");
    expect(closeControl).toContain("WM_CLOSE");
    expect(closeControl).not.toContain("window.close()");
  });

  it("observes Windows minimize geometry through debug-only native evidence", async () => {
    const [control, viewport, receipts, journey] = await Promise.all([
      readFile("src-tauri/src/system_runtime/section_31_desktop_e2e.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_31_desktop_e2e_viewport.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_18_resize_diagnostics.rs", "utf8"),
      readFile("e2e/desktop/specs/cross-domain-runtime.e2e.ts", "utf8")
    ]);

    expect(control).toContain("DesktopE2eWindowControlRequest::ClickVisibleMinimize");
    expect(control).toContain("DesktopE2eVisibleChromePointer::Minimize");
    expect(control).toContain("SendInput(");
    expect(viewport).toContain(".Bounds(&mut bounds)");
    expect(viewport).toContain("GetClientRect(parent, &mut host_bounds)");
    expect(viewport).toContain("WebMessageReceivedEventHandler::create");
    expect(viewport).toContain("rion-desktop-e2e-role-viewport-v1");
    expect(viewport).toContain('addEventListener("resize"');
    expect(receipts).toContain('"windows-geometry-receipt"');
    expect(journey).toContain('status: "unchanged"');
    expect(journey).toContain("expect(restoredB.native.roleSurfaces).toEqual");
  });

  it("records an authoritative foreground precondition on both native hosts", async () => {
    const source = await readFile(
      "src-tauri/src/system_runtime/section_31_desktop_e2e.rs",
      "utf8"
    );

    expect(source).toContain("DesktopE2eWindowControlRequest::Focus => \"focus\"");
    expect(source.match(/request_platform_window_show_foreground\(window\)/g)).toHaveLength(2);
    expect(source).toContain('"window-focus-acknowledged"');
  });

  it("focuses the native Game Window before the desktop E2E role surface", async () => {
    const [controlSource, journeySource] = await Promise.all([
      readFile("src-tauri/src/system_runtime/section_31_desktop_e2e_ui.rs", "utf8"),
      readFile("e2e/desktop/specs/game-window-lifecycle.e2e.ts", "utf8")
    ]);
    const focusRole = controlSource.slice(
      controlSource.indexOf("DesktopE2eRuntimeUiActionRequest::FocusRole"),
      controlSource.indexOf("DesktopE2eRuntimeUiActionRequest::PressRoleSlot")
    );
    const forceTerminate = journeySource.slice(
      journeySource.indexOf("async function forceTerminatePhase"),
      journeySource.indexOf("async function crashRestartPhase")
    );

    expect(focusRole).toContain("host.window.clone()");
    expect(focusRole.indexOf("request_platform_window_show_foreground(&window)"))
      .toBeLessThan(focusRole.indexOf("webview.set_focus()"));
    expect(forceTerminate.indexOf('kind: "window-focus-persisted"'))
      .toBeLessThan(forceTerminate.indexOf("await runtimeUiAction(WINDOW_C"));
  });

  it("keeps native tab gestures feature-gated and user-input driven", async () => {
    const [command, windowsPointer, macHeader, macBridge, macPointer, build] =
      await Promise.all([
        readFile("src-tauri/src/desktop_e2e.rs", "utf8"),
        readFile(
          "src-tauri/src/system_runtime/section_31_desktop_e2e_pointer.rs",
          "utf8"
        ),
        readFile("src-tauri/native/macos/RionRuntimeTabsController.h", "utf8"),
        readFile(
          "src-tauri/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
          "utf8"
        ),
        readFile(
          "src-tauri/native/macos/RionRuntimeTabsController/06_fullscreen.mm",
          "utf8"
        ),
        readFile("src-tauri/build.rs", "utf8")
      ]);

    expect(command).toContain("pub(crate) async fn desktop_e2e_runtime_ui_action");
    expect(command).toContain("tauri::async_runtime::spawn_blocking");
    expect(windowsPointer).toContain("core.ExecuteScript(&script, &handler)");
    expect(windowsPointer).toContain("WindowFromPoint(start)");
    expect(windowsPointer).toContain("expected_parent: usize");
    expect(windowsPointer).toContain("hit_root == parent_root");
    expect(windowsPointer).toContain("HWND_TOPMOST");
    expect(windowsPointer).toContain("HWND_NOTOPMOST");
    expect(windowsPointer).toContain("WS_EX_TRANSPARENT");
    expect(windowsPointer).toContain("extended_style");
    expect(windowsPointer).toContain("dispatch_barrier");
    expect(windowsPointer).toContain("'click', 'contextmenu'");
    expect(windowsPointer).toContain("The native runtime-tab pointer dispatch was not acknowledged");
    expect(windowsPointer).toContain("pointer_result.and(restore_result)");
    expect(windowsPointer).toContain("SendInput(&inputs");
    expect(macHeader).toContain("#if defined(RION_DESKTOP_E2E)");
    expect(macBridge).toContain("rion_runtime_tabs_accessibility_show_menu");
    expect(macPointer).toContain("NSEventTypeLeftMouseDragged");
    expect(macPointer).toContain("[NSApp postEvent:drag atStart:NO]");
    expect(macPointer).toContain("[sourceItem mouseDown:down]");
    expect(macPointer).toContain("[sourceItem mouseDragged:firstDrag]");
    expect(build).toContain('runtime_tabs.define("RION_DESKTOP_E2E", None)');
  });

  it("foregrounds the exact AppKit drag windows before posting pointer input", async () => {
    const source = await readFile(
      "src-tauri/native/macos/RionRuntimeTabsController/06_fullscreen.mm",
      "utf8"
    );
    const drag = source.slice(
      source.indexOf("- (BOOL)performDesktopE2EDragForTabIdentifier:"),
      source.indexOf("#endif", source.indexOf(
        "- (BOOL)performDesktopE2EDragForTabIdentifier:"
      ))
    );

    expect(drag).toContain("[targetWindow orderFront:nil]");
    expect(drag).toContain("[sourceWindow makeKeyAndOrderFront:nil]");
    expect(drag.indexOf("[sourceWindow makeKeyAndOrderFront:nil]"))
      .toBeLessThan(drag.indexOf("NSEvent *down"));
    expect(drag).toContain("!sourceWindow.isVisible || !targetWindow.isVisible");
  });

  it("posts AppKit menu input outside the modal main-thread tracking loop", async () => {
    const source = await readFile(
      "src-tauri/src/runtime_tabs_macos/section_01_controller_creation_timeout.rs",
      "utf8"
    );
    const selection = source.slice(
      source.indexOf("pub fn desktop_e2e_select_menu_item("),
      source.indexOf("pub fn hide_status(")
    );

    expect(selection).toContain("rion_runtime_tabs_desktop_e2e_select_menu_item(action, target_rank)");
    expect(selection).not.toContain("run_on_appkit_tracking_main");
    expect(selection).toContain("one-shot NSMenu tracking notification");
    const bridge = await readFile(
      "src-tauri/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
      "utf8"
    );
    expect(bridge).toContain("NSMenuDidBeginTrackingNotification");
    expect(bridge).toContain("RionDesktopE2EPostMenuSelection(action, targetRank)");
  });
});
