import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri shell parity guard", () => {
  it("keeps the hidden-inset-equivalent main window and bundled startup failure UI", async () => {
    const [baseSource, macSource, shell, startup] = await Promise.all([
      readFile("src-tauri/tauri.conf.json", "utf8"),
      readFile("src-tauri/tauri.macos.conf.json", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src/renderer/index.html", "utf8")
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
      titleBarStyle: "Overlay",
      trafficLightPosition: { x: 18, y: 18 },
      transparent: true
    });
    expect(mac.app.windows[0].windowEffects.effects).toContain("underWindowBackground");
    expect(shell).toContain("renderer_ready");
    expect(shell).toContain("schedule_resize_window");
    expect(shell).toContain("rion-runtime-focus-persist");
    expect(shell).toContain("show_startup_failure");
    expect(shell).toContain("Renderer startup timed out");
    expect(startup).toContain("__rionShowStartupFailure");
  });

  it("owns menus, quick-menu restore, tabs, dividers, and workspace launch requests in Tauri", async () => {
    const [menu, quickMenu, tabs, nativeTabs, nativeTabsHeader, shell, build, capability, roleCapability] = await Promise.all([
      readFile("src-tauri/src/application_menu.rs", "utf8"),
      readFile("src-tauri/src/quick_menu.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8"),
      readFile("src-tauri/native/macos/RionRuntimeTabsController.mm", "utf8"),
      readFile("src-tauri/native/macos/RionRuntimeTabsController.h", "utf8"),
      readFile("src-tauri/src/lib.rs", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/capabilities/runtime-native-chrome.json", "utf8"),
      readFile("src-tauri/capabilities/system-role-overlay.json", "utf8")
    ]);

    expect(menu).toContain("RuntimeWindowPreferencesReplace");
    expect(menu).toContain(".copy()");
    expect(menu).toContain("TOGGLE_FULLSCREEN_ITEM");
    expect(quickMenu).toContain("restore_saved_game_windows");
    expect(quickMenu).toContain("pending_workspace_launch_request");
    expect(tabs).toContain("rion-runtime-shortcut://tabs/");
    expect(tabs).toContain("LayoutResizeDivider");
    expect(tabs).toContain("chrome_display_for_webview");
    expect(shell).toContain("rion_runtime_tab_action");
    expect(tabs).toContain("runtime-divider.html");
    expect(nativeTabs).toContain("contentLayoutRect");
    expect(nativeTabs).toContain("standardWindowButton");
    expect(nativeTabsHeader).toContain('extern "C"');
    expect(shell).toContain("rion_runtime_audio_state");
    expect(build).toContain('"rion_runtime_tab_action"');
    expect(build).toContain('"rion_divider_pointer"');
    expect(build).toContain('"rion_runtime_audio_state"');
    expect(build).toContain("clang_rt.osx");
    expect(JSON.parse(capability)).toMatchObject({
      local: true,
      webviews: ["game-tabs-chrome-*", "game-divider-*"],
      permissions: ["allow-rion-divider-pointer", "allow-rion-runtime-tab-action"]
    });
    expect(JSON.parse(roleCapability)).toMatchObject({
      local: false,
      webviews: ["game-role-*"],
      permissions: ["allow-rion-overlay-request", "allow-rion-runtime-audio-state"]
    });
    expect(shell).toContain('"consumePendingWorkspaceLaunchRequest"');
    expect(shell).not.toContain('"consumePendingWorkspaceLaunchRequest" => Ok(Value::Null)');
  });

  it("runs legacy-root migration before opening AppCore", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(shell.indexOf("migrate_legacy_data_root(")).toBeLessThan(
      shell.indexOf("AppCore::create_with_startup_backup(")
    );
    expect(shell).toContain('const LEGACY_DATA_DIRECTORY_NAME: &str = "rion-studio"');
    expect(shell).toContain('const SHARED_DATA_DIRECTORY_NAME: &str = "Rion Studio"');
  });
});
