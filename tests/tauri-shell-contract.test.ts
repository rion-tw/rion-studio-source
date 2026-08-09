import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("Tauri shell contract guard", () => {
  it("keeps the hidden-inset-equivalent main window and bundled startup failure UI", async () => {
    const [baseSource, macSource, windowsSource, shell, runtime, windowsMaterial, startup, bootStyles, runtimeTabs, startupFallback, rendererMain, runtimeTabScript] = await Promise.all([
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("src-tauri/tauri.macos.conf.json", "utf8"),
      readFile("src-tauri/tauri.windows.conf.json", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/platform/windows/material.rs", "utf8"),
      readFile("src/renderer/index.html", "utf8"),
      readFile("src/renderer/src/boot.css", "utf8"),
      readFile("src/renderer/runtime-tabs.css", "utf8"),
      readFile("src/renderer/src/app/startupFallback.ts", "utf8"),
      readFile("src/renderer/src/main.tsx", "utf8"),
      readFile("src/renderer/runtime-shell/runtimeTabStrip.ts", "utf8")
    ]);
    const base = JSON.parse(baseSource);
    const mac = JSON.parse(macSource);
    const windows = JSON.parse(windowsSource);

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
    expect(windows.app.windows[0]).toMatchObject({
      decorations: false,
      shadow: true,
      transparent: true
    });
    expect(windows.app.windows[0].windowEffects).toBeUndefined();
    expect(windowsMaterial).toContain("RtlGetVersion");
    expect(windowsMaterial).toContain("Effect::Mica");
    expect(windowsMaterial).toContain("retrying with an opaque host");
    expect(runtime).toContain("build_windows_runtime_host_window");
    expect(runtime).toContain("__rionRuntimeTabWindowsMicaEnabled");
    expect(shell).toContain("renderer_ready");
    expect(shell).toContain("StartupWindowState");
    expect(shell).toContain("reveal_once()");
    expect(shell).toContain("PageLoadEvent::Finished");
    expect(shell).toContain("observe_resize_window");
    expect(shell).toContain("rion-runtime-focus-persist");
    expect(shell).toContain("show_startup_failure");
    expect(shell).toContain("did not become ready within 15 seconds");
    expect(shell).toContain('"rendererStartupFailed"');
    expect(shell).toContain('"waitForNativeStartup"');
    expect(shell).toContain("startup.wait_for_native_startup().await?");
    expect(shell).toContain("windowsMicaEnabled");
    expect(startup).toContain("dataset.windowsMica");
    expect(bootStyles).toContain('data-windows-mica="fallback"');
    expect(runtimeTabs).toContain('data-windows-mica="enabled"');
    expect(rendererMain).toContain("startup.windowsMicaEnabled");
    const tabInitializationStart = runtime.indexOf(
      "fn windows_runtime_tab_initialization_script("
    );
    const tabInitialization = runtime.slice(
      tabInitializationStart,
      runtime.indexOf("fn native_runtime_window_title_for_platform", tabInitializationStart)
    );
    expect(tabInitialization).toContain("__rionRuntimeTabWindowsMicaEnabled");
    expect(tabInitialization).toContain("__rionRuntimeTabChromeIdentity");
    expect(tabInitialization).not.toContain("document.");
    expect(runtimeTabScript).toContain("window.__rionRuntimeTabWindowsMicaEnabled");
    expect(runtimeTabScript).toContain("document.documentElement.dataset.windowsMica");
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
    const [menu, quickMenu, quickMenuMac, nativeDockMenu, tabMenu, tabs, nativeTabs, nativeTabsHeader, nativeTabsBridge, nativeInput, shell, build, capability, placeholderCapability, roleCapability] = await Promise.all([
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
      readFile("src-tauri/capabilities/runtime-role-placeholder.json", "utf8"),
      readFile("src-tauri/capabilities/system-role-overlay.json", "utf8")
    ]);

    expect(menu).toContain("RuntimeWindowPreferencesReplace");
    expect(menu).toContain(".copy()");
    expect(menu).toContain("TOGGLE_FULLSCREEN_ITEM");
    expect(menu).toContain('const QUIT_ITEM: &str = "rion-application-quit"');
    expect(menu).toContain("crate::request_application_shutdown(app, &state)");
    expect(menu).toContain('.accelerator("CmdOrCtrl+Q")');
    expect(menu).not.toContain(".quit()");
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
    expect(quickMenu).toContain("runtime.launcher_presence_snapshot()?");
    expect(quickMenu).toMatch(/let mut running_window_ids = presence\s+\.windows/u);
    expect(quickMenu).toContain("live_window_tab_ids(&window_id)");
    expect(quickMenu).toContain("if is_live {");
    expect(quickMenu).toContain("focus_live_runtime_window(&window_id)");
    expect(quickMenu).not.toContain("BrowserRuntimeSnapshot");
    expect(quickMenu).toContain("GameWindowsList");
    expect(quickMenu).not.toContain("targetDisplay");
    expect(quickMenu).toContain("QuickMenuPlatform::Macos");
    expect(quickMenu).not.toContain("MenuEntry::Header");
    expect(quickMenu).not.toContain(".on_menu_event(");
    expect(quickMenuMac).toContain("muda::{CheckMenuItem, ContextMenu");
    expect(quickMenu).toContain("MenuEntry::CheckItem");
    expect(quickMenu).toContain("CheckMenuItemBuilder::with_id");
    expect(quickMenu).toContain("state.last_fingerprint = None;");
    expect(quickMenuMac).toContain("CheckMenuItem::with_id");
    const roleLaunch = shell.slice(
      shell.indexOf("async fn launch_role_from_shell("),
      shell.indexOf("async fn launch_workspace_from_shell(")
    );
    expect(roleLaunch).toContain(".launch_intents");
    expect(roleLaunch).toContain('submit(&role_id, false, None, "renderer-role-list")');
    expect(roleLaunch).not.toContain("CoreCommand::BrowserRoleLaunch");
    const workspaceLaunch = shell.slice(
      shell.indexOf("async fn launch_workspace_from_shell("),
      shell.indexOf("enum RuntimeLaunchDestination")
    );
    expect(workspaceLaunch).toContain(".launch_intents");
    expect(workspaceLaunch).toContain(
      'submit(&workspace_id, true, None, "renderer-workspace-list")'
    );
    expect(workspaceLaunch).not.toContain("CoreCommand::BrowserWorkspaceLaunch");
    expect(quickMenu).toContain("launch_intents.try_launch_source(");
    expect(quickMenuMac).toContain("DOCK_MENU: RefCell<Option<Submenu>>");
    expect(quickMenuMac).not.toContain("rion_dock_menu_promote_section_header");
    expect(nativeDockMenu).toContain("applicationDockMenu:");
    expect(nativeDockMenu).toContain("class_addMethod(");
    expect(nativeDockMenu).toContain("RionForeignDockMenu");
    expect(nativeDockMenu).not.toContain("sectionHeaderWithTitle:");
    expect(shell).toContain("if !quick_menu::handle_event(");
    expect(tabs).not.toContain("rion-runtime-shortcut://tabs/");
    expect(tabs).toContain("AcceleratorKeyPressedEventHandler");
    expect(shell).toContain('Some("runtime-tab-shortcut")');
    expect(shell).toContain("overlay_webview_is_selected");
    expect(shell).toContain("dispatch_runtime_tab_shortcut");
    expect(nativeTabs).toContain("NSEventModifierFlagControl");
    expect(tabs).toContain('unwrap_or(RION_STUDIO_APP_NAME)');
    expect(tabs).toContain("resize_workspace_divider");
    expect(tabs).not.toContain("CoreCommand::LayoutResizeDivider");
    expect(tabs).toContain("tab_strip_window_for_webview");
    expect(tabMenu).toContain('format!("{RELOAD_PREFIX}{tab_id}")');
    expect(tabMenu).toContain("spawn_blocking(move || runtime.reload_tab(&tab_id))");
    expect(tabMenu).toContain('matches!(receipt.status.as_str(), "applied" | "superseded")');
    expect(shell).toContain("rion_runtime_tab_action");
    expect(shell).toContain('window.label() != "main"');
    expect(tabs).toContain("runtime-divider.html");
    expect(nativeTabs).toContain("contentLayoutRect");
    expect(nativeTabs).toContain("standardWindowButton");
    expect(nativeTabsHeader).toContain('extern "C"');
    expect(nativeTabs).toContain('@"sourceWindowId"');
    expect(nativeTabsHeader).toContain("sourceWindowID");
    expect(nativeTabsBridge).toContain("TAURI_RUNTIME_TAB_MENU_FAILED");
    expect(nativeTabsBridge).toContain("target_window_id.or_else(|| host_window_id.clone())");
    expect(nativeTabsBridge).toContain("open_launcher(&app, window_id)");
    expect(nativeTabs).toContain('@"type" : @"tabDragStart"');
    expect(nativeTabs).toContain('@"type" : @"tabDragMove"');
    expect(nativeTabs).toContain('@"type" : @"tabDragEnd"');
    expect(nativeTabsBridge).toContain("handle_game_window_tab_drag");
    expect(shell).toContain("rion_runtime_audio_state");
    expect(build).toContain('"rion_runtime_tab_action"');
    expect(build).toContain('"rion_runtime_role_slot_action"');
    expect(build).toContain('"rion_divider_pointer"');
    expect(build).toContain('"rion_runtime_audio_state"');
    expect(build).toContain("clang_rt.osx");
    expect(nativeInput).toContain("rion_wk_install_role_zoom_shortcut");
    expect(nativeInput).toContain("RionRoleZoomBindingForResponder");
    expect(tabs).toContain("AcceleratorKeyPressedEventHandler");
    expect(tabs).toContain(
      '#[cfg(target_os = "macos")]\npub(in crate::system_runtime) fn dispatch_role_zoom_shortcut('
    );
    expect(JSON.parse(capability)).toMatchObject({
      local: true,
      webviews: ["game-tab-strip-*", "game-divider-*"],
      permissions: ["allow-rion-divider-pointer", "allow-rion-runtime-tab-action"]
    });
    expect(JSON.parse(placeholderCapability)).toMatchObject({
      local: true,
      webviews: ["role-placeholder-*"],
      permissions: ["allow-rion-runtime-role-slot-action"]
    });
    expect(capability).not.toContain("allow-rion-runtime-role-slot-action");
    expect(JSON.parse(roleCapability)).toMatchObject({
      local: false,
      webviews: ["game-role-*"],
      permissions: [
        "allow-rion-browser-font-payload",
        "allow-rion-overlay-request",
        "allow-rion-runtime-audio-state"
      ]
    });
    expect(roleCapability).not.toContain("allow-rion-runtime-role-slot-action");
    expect(roleCapability).not.toContain("local-storage-sync");
    expect(shell).toContain('"moveGameWindowTabToNewWindow"');
    expect(shell).toContain('"reorderGameWindowTab"');
    expect(shell).not.toContain("WorkspaceConflictRollbackPlan");
    expect(shell).not.toContain("rollback_workspace_conflicts(");
    expect(shell).not.toContain("restore_workspace_conflict_metadata(");
    expect(shell).not.toContain("TAURI_WORKSPACE_CONFLICT_ROLLBACK_FAILED");
    expect(shell).not.toContain('"consumePendingWorkspaceLaunchRequest"');
  });

  it("opens only the canonical data root and ignores the retired sibling", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(shell).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
    expect(shell).toContain("AppCore::create_with_startup_backup(");
    expect(shell).not.toContain("LEGACY_DATA_DIRECTORY_NAME");
    expect(shell).not.toContain("reject_retired_data_root");
  });

  it("installs the native Windows application shortcut handler on the main WebView2", async () => {
    const [run, runtime, windowsInput] = await Promise.all([
      readFile("src-tauri/src/lib/section_09_run.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8"),
      readFile(
        "src-tauri/src/system_runtime/platform/windows/input_security.rs",
        "utf8"
      )
    ]);

    expect(run).toContain(
      "install_windows_main_application_shortcut_handler("
    );
    expect(runtime).toContain(
      "install_main_application_shortcut_handler(window.as_ref(), app)"
    );
    expect(windowsInput).toContain(
      "WindowsApplicationShortcutTarget::MainWindow"
    );
    expect(windowsInput).toContain(
      "ApplicationShortcutTarget::MainWindow("
    );
    expect(windowsInput).toContain("execute_shortcut(");
  });

  it("defers Windows application shortcut effects until after the WebView2 accelerator callback", async () => {
    const windowsInput = await readFile(
      "src-tauri/src/system_runtime/platform/windows/input_security.rs",
      "utf8"
    );
    const callbackStart = windowsInput.indexOf(
      "AcceleratorKeyPressedEventHandler::create"
    );
    const callbackEnd = windowsInput.indexOf(
      "let mut token = 0;",
      callbackStart
    );
    const callback = windowsInput.slice(callbackStart, callbackEnd);

    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    expect(callback).toContain("defer_windows_application_shortcut(");
    expect(callback).not.toContain(".try_state::<crate::CoreState>()");
    expect(callback).not.toContain("execute_shortcut(");
    expect(windowsInput).toContain("app.run_on_main_thread(move || {");
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
