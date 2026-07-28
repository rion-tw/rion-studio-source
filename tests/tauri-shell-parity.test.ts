import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri shell parity guard", () => {
  it("keeps the hidden-inset-equivalent main window and bundled startup failure UI", async () => {
    const [baseSource, macSource, shell, startup, startupFallback, rendererMain] = await Promise.all([
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("src-tauri/tauri.macos.conf.json", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src/renderer/index.html", "utf8"),
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
    expect(startup).toContain("boot-fallback-error-mark");
    expect(startup).toContain("prefers-reduced-motion: reduce");
    expect(rendererMain).toContain("await waitForNativeStartup()");
    expect(rendererMain).toContain("createHashRouter([");
    expect(rendererMain.indexOf("await waitForNativeStartup()"))
      .toBeLessThan(rendererMain.indexOf("createHashRouter(["));
  });

  it("owns menus, quick-menu restore, tabs, dividers, and workspace launch requests in Tauri", async () => {
    const [menu, quickMenu, tabMenu, tabs, nativeTabs, nativeTabsHeader, nativeTabsBridge, nativeInput, shell, build, capability, roleCapability] = await Promise.all([
      readFile("src-tauri/src/application_menu.rs", "utf8"),
      readFile("src-tauri/src/quick_menu.rs", "utf8"),
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
    expect(quickMenu).toContain("restore_saved_game_windows");
    expect(quickMenu).not.toContain("targetDisplay");
    expect(tabs).toContain("rion-runtime-shortcut://tabs/");
    expect(tabs).toContain('unwrap_or(RION_STUDIO_APP_NAME)');
    expect(tabs).toContain("LayoutResizeDivider");
    expect(tabs).toContain("tab_strip_window_for_webview");
    expect(tabMenu).toContain('format!("{RELOAD_PREFIX}{tab_id}")');
    expect(tabMenu).toContain("state.runtime.reload_tab(tab_id)");
    expect(shell).toContain("rion_runtime_tab_action");
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
    expect(shell).not.toContain('"consumePendingWorkspaceLaunchRequest"');
  });

  it("runs legacy-root migration before opening AppCore", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(shell.indexOf("migrate_legacy_data_root(")).toBeLessThan(
      shell.indexOf("AppCore::create_with_startup_backup(")
    );
    expect(shell).toContain('const LEGACY_DATA_DIRECTORY_NAME: &str = "rion-studio"');
    expect(shell).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
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
