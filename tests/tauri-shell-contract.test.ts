import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("Tauri shell contract guard", () => {
  it("keeps the hidden-inset-equivalent main window and bundled startup failure UI", async () => {
    const [baseSource, macSource, shell, startup, bootStyles, startupFallback, rendererMain] = await Promise.all([
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("src-tauri/tauri.macos.conf.json", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/src/boot.css", "utf8"),
      readFile("src/renderer/src/app/startupFallback.ts", "utf8"),
      readFile("src/renderer/src/main.tsx", "utf8")
    ]);
    const base = JSON.parse(baseSource);
    const mac = JSON.parse(macSource);

    expect(base.app.windows[0]).toMatchObject({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      visible: false
    });
    expect(mac.app.windows[0]).toMatchObject({
      title: "",
      titleBarStyle: "Overlay",
      trafficLightPosition: { x: 18, y: 18 },
      transparent: true
    });
    expect(mac.app.windows[0].windowEffects.effects).toContain("underWindowBackground");
    expect(shell).toContain("renderer_ready");
    expect(shell).toContain("StartupWindowState");
    expect(shell).toContain("reveal_once()");
    expect(shell).toContain("PageLoadEvent::Finished");
    expect(shell).toContain("schedule_resize_window");
    expect(shell).toContain("rion-runtime-focus-persist");
    expect(shell).toContain("show_startup_failure");
    expect(shell).toContain("did not become ready within 15 seconds");
    expect(shell).toContain('"rendererStartupFailed"');
    expect(shell).toContain('"waitForNativeStartup"');
    expect(shell).toContain("startup.wait_for_native_startup().await?");
    const shellInvokeStart = shell.indexOf("async fn rion_shell_invoke(");
    const shellInvokeSignature = shell.slice(
      shellInvokeStart,
      shell.indexOf(") -> Result<Value, CoreErrorPayload>", shellInvokeStart)
    );
    expect(shellInvokeSignature).not.toContain("State<'_, CoreState>");
    expect(startupFallback).toContain("__rionShowStartupFailure");
    expect(startup).toContain("startupFallback.ts");
    expect(startup).toContain("boot.css");
    expect(bootStyles).toContain("boot-fallback-error-mark");
    expect(bootStyles).toContain("prefers-reduced-motion: reduce");
    expect(rendererMain).toContain("await waitForNativeStartup()");
    expect(rendererMain).toContain("createHashRouter([");
    expect(rendererMain.indexOf("await waitForNativeStartup()"))
      .toBeLessThan(rendererMain.indexOf("createHashRouter(["));
  });

  it("owns menus, quick-menu restore, tabs, dividers, and workspace launch requests in Tauri", async () => {
    const [menu, quickMenu, quickMenuMac, nativeDockMenu, tabMenu, tabs, nativeTabs, nativeTabsHeader, nativeTabsBridge, nativeInput, shell, build, capability, roleCapability] = await Promise.all([
      readFile("src-tauri/src/application_menu.rs", "utf8"),
      readFile("src-tauri/src/quick_menu.rs", "utf8"),
      readFile("src-tauri/src/quick_menu_macos.rs", "utf8"),
      readFile("src-tauri/native/macos/RionDockMenu.m", "utf8"),
      readFile("src-tauri/src/runtime_tab_menu.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8"),
      readFile("src-tauri/native/macos/RionRuntimeTabsController.mm", "utf8"),
      readFile("src-tauri/native/macos/RionRuntimeTabsController.h", "utf8"),
      readFile("src-tauri/src/runtime_tabs_macos.rs", "utf8"),
      readFile("src-tauri/native/macos/RionWKWebViewInput.m", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/capabilities/runtime-native-shell.json", "utf8"),
      readFile("src-tauri/capabilities/system-role-overlay.json", "utf8")
    ]);

    expect(menu).toContain("RuntimeWindowPreferencesReplace");
    expect(menu).toContain(".copy()");
    expect(menu).toContain("TOGGLE_FULLSCREEN_ITEM");
    expect(menu).toContain('#[cfg(target_os = "macos")]');
    expect(menu).toContain("pub fn install(_app: &AppHandle");
    expect(menu).toContain("ApplicationShortcutTarget::RuntimeWindow");
    expect(menu).toContain("window_id_for_webview(webview_label)");
    const roleZoom = menu.slice(
      menu.indexOf("fn zoom("),
      menu.indexOf("fn zoom_runtime_window(")
    );
    expect(roleZoom).toContain(".zoom_role_for_webview(webview_label, action)");
    expect(roleZoom).not.toContain("window_id_for_webview(webview_label)");
    expect(menu).toContain('#[cfg(target_os = "macos")]\nstruct Labels');
    expect(menu).toContain('#[cfg(target_os = "macos")]\nfn labels(');
    expect(quickMenu).toContain("restore_saved_game_windows");
    expect(quickMenu).toContain("BrowserRuntimeSnapshot");
    expect(quickMenu).toContain("GameWindowsList");
    expect(quickMenu).not.toContain("targetDisplay");
    expect(quickMenu).toContain("QuickMenuPlatform::Macos");
    expect(quickMenu).not.toContain("MenuEntry::Header");
    expect(quickMenu).not.toContain(".on_menu_event(");
    expect(quickMenuMac).toContain("muda::{ContextMenu");
    expect(quickMenuMac).toContain("DOCK_MENU: RefCell<Option<Submenu>>");
    expect(quickMenuMac).not.toContain("rion_dock_menu_promote_section_header");
    expect(nativeDockMenu).toContain("applicationDockMenu:");
    expect(nativeDockMenu).toContain("class_addMethod(");
    expect(nativeDockMenu).toContain("RionForeignDockMenu");
    expect(nativeDockMenu).not.toContain("sectionHeaderWithTitle:");
    expect(shell).toContain("if !quick_menu::handle_event(");
    expect(tabs).not.toContain("rion-runtime-shortcut://tabs/");
    expect(tabs).toContain("AcceleratorKeyPressedEventHandler");
    expect(nativeTabs).toContain("NSEventModifierFlagControl");
    expect(tabs).toContain('unwrap_or(RION_STUDIO_APP_NAME)');
    expect(tabs).toContain("LayoutResizeDivider");
    expect(tabs).toContain("tab_strip_window_for_webview");
    expect(tabMenu).toContain('format!("{RELOAD_PREFIX}{tab_id}")');
    expect(tabMenu).toContain("state.runtime.reload_tab(tab_id)");
    expect(shell).toContain("rion_runtime_tab_action");
    expect(shell).toContain('window.label() != "main"');
    expect(tabs).toContain("runtime-divider.html");
    expect(nativeTabs).toContain("contentLayoutRect");
    expect(nativeTabs).toContain("standardWindowButton");
    expect(nativeTabsHeader).toContain('extern "C"');
    expect(nativeTabs).toContain('@"sourceWindowId"');
    expect(nativeTabsHeader).toContain("sourceWindowID");
    expect(nativeTabsBridge).toContain("TAURI_RUNTIME_TAB_MENU_FAILED");
    expect(nativeTabsBridge).toContain("target_window_id.or(host_window_id)");
    expect(nativeTabsBridge).toContain("open_launcher(&app, window_id)");
    expect(nativeTabs).toContain('@"type" : @"tabDragStart"');
    expect(nativeTabs).toContain('@"type" : @"tabDragMove"');
    expect(nativeTabs).toContain('@"type" : @"tabDragEnd"');
    expect(nativeTabsBridge).toContain("handle_game_window_tab_drag");
    expect(shell).toContain("rion_runtime_audio_state");
    expect(build).toContain('"rion_runtime_tab_action"');
    expect(build).toContain('"rion_divider_pointer"');
    expect(build).toContain('"rion_runtime_audio_state"');
    expect(build).toContain("clang_rt.osx");
    expect(nativeInput).toContain("rion_wk_install_role_zoom_shortcut");
    expect(nativeInput).toContain("RionRoleZoomBindingForResponder");
    expect(tabs).toContain("AcceleratorKeyPressedEventHandler");
    expect(tabs).toContain(
      '#[cfg(target_os = "macos")]\nfn dispatch_role_zoom_shortcut('
    );
    expect(JSON.parse(capability)).toMatchObject({
      local: true,
      webviews: ["game-tab-strip-*", "game-divider-*"],
      permissions: ["allow-rion-divider-pointer", "allow-rion-runtime-tab-action"]
    });
    expect(JSON.parse(roleCapability)).toMatchObject({
      local: false,
      webviews: ["game-role-*"],
      permissions: [
        "allow-rion-browser-font-payload",
        "allow-rion-overlay-request",
        "allow-rion-local-storage-sync-changed",
        "allow-rion-runtime-audio-state"
      ]
    });
    expect(shell).toContain('"moveGameWindowTabToNewWindow"');
    expect(shell).toContain("struct WorkspaceConflictRollbackPlan");
    expect(shell).toContain("rollback_workspace_conflicts(");
    expect(shell).toContain("restore_workspace_conflict_metadata(");
    expect(shell).toContain("TAURI_WORKSPACE_CONFLICT_ROLLBACK_FAILED");
    expect(shell).toContain("&rollback_plans[..=index]");
    expect(shell).toContain("&rollback_plans[..stopped_count]");
    expect(shell).not.toContain('"consumePendingWorkspaceLaunchRequest"');
  });

  it("opens only the canonical data root and ignores the retired sibling", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(shell).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
    expect(shell).toContain("AppCore::create_with_startup_backup(");
    expect(shell).not.toContain("LEGACY_DATA_DIRECTORY_NAME");
    expect(shell).not.toContain("reject_retired_data_root");
  });

  it("routes diagnostics exports through the asynchronous core dispatcher", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    const start = shell.indexOf("async fn export_diagnostics(");
    const end = shell.indexOf("\nfn runtime_versions(", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const exportDiagnostics = shell.slice(start, end);
    expect(exportDiagnostics).toContain("invoke_core_async(");
    expect(exportDiagnostics).not.toContain("invoke_core_sync(");
    expect(exportDiagnostics).toMatch(/invoke_core_async\([\s\S]*\)\s*\.await\s*\}\s*$/);
  });
});
