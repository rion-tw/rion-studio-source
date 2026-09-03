import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("shared AppKit runtime controller", () => {
  it("is compiled once without inheriting the stable WebKit compatibility hook", async () => {
    const [
      appKitManifest,
      appKitBuild,
      appKitRust,
      controllerHeader,
      controllerBridge,
      tauriBuild
    ] =
      await Promise.all([
        readFile("crates/rion-appkit/Cargo.toml", "utf8"),
        readFile("crates/rion-appkit/build.rs", "utf8"),
        readFile("crates/rion-appkit/src/lib.rs", "utf8"),
        readFile("crates/rion-appkit/native/macos/RionRuntimeTabsController.h", "utf8"),
        readFile(
          "crates/rion-appkit/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
          "utf8"
        ),
        readFile("src-tauri/build.rs", "utf8")
      ]);

    expect(appKitManifest).toContain('links = "rion_appkit_native"');
    expect(appKitBuild).toContain('file("native/macos/RionRuntimeTabsController.mm")');
    expect(appKitBuild).toContain('rustc-link-lib=framework=AppKit');
    expect(appKitBuild).toContain('rustc-link-lib=framework=QuartzCore');
    expect(appKitBuild).not.toContain("WebKit");
    expect(appKitRust).toContain("RUNTIME_TABS_ABI_VERSION: u32 = 6");
    expect(controllerHeader).not.toContain("safe_tao");
    expect(controllerBridge).toMatch(
      /rion_appkit_runtime_tabs_abi_version\(void\)\s*\{\s*return 6;\s*\}/u
    );
    expect(controllerBridge).not.toContain("TaoWindow");
    expect(tauriBuild).not.toContain('file("native/macos/RionRuntimeTabsController.mm")');
  });

  it("keeps the Tao and WK fallback hook inside the stable Tauri shell", async () => {
    const [compatibility, tauriBuild, tauriBridge] = await Promise.all([
      readFile("src-tauri/native/macos/RionTauriWebKitEventCompatibility.m", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile(
        "src-tauri/src/runtime_tabs_macos/section_01_controller_creation_timeout.rs",
        "utf8"
      )
    ]);

    expect(compatibility).toContain('NSClassFromString(@"TaoWindow")');
    expect(compatibility).toContain("RionTauriIsMarkedWebKitMacroFallbackEvent");
    expect(tauriBuild).toContain('file("native/macos/RionTauriWebKitEventCompatibility.m")');
    expect(tauriBridge).toContain("rion_tauri_install_safe_tao_webkit_event_dispatch");
  });

  it("keeps the stable v22 WebKit probe out of the Chromium addon", async () => {
    const [nodeManifest, tauriManifest, platformProbe] = await Promise.all([
      readFile("crates/rion-node/Cargo.toml", "utf8"),
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("crates/rion-platform/src/system_webview.rs", "utf8")
    ]);

    expect(nodeManifest).toContain(
      'rion-platform = { path = "../rion-platform", default-features = false }'
    );
    expect(tauriManifest).toContain(
      'rion-platform = { path = "../crates/rion-platform", features = ["system-webview-probe"] }'
    );
    expect(platformProbe).toContain(
      '#[cfg(all(target_os = "macos", feature = "system-webview-probe"))]'
    );
    expect(platformProbe).toContain('#[link(name = "WebKit", kind = "framework")]');
  });

  it("propagates desktop E2E and exposes a fail-closed Electron NSView boundary", async () => {
    const [tauriManifest, nodeManifest, header, bridge] = await Promise.all([
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("crates/rion-node/Cargo.toml", "utf8"),
      readFile("crates/rion-appkit/native/macos/RionRuntimeTabsController.h", "utf8"),
      readFile(
        "crates/rion-appkit/native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
        "utf8"
      )
    ]);

    expect(tauriManifest).toContain('rion-appkit = { path = "../crates/rion-appkit" }');
    expect(tauriManifest).toContain('"rion-appkit/desktop-e2e"');
    expect(nodeManifest).toContain('rion-appkit = { path = "../rion-appkit" }');
    expect(nodeManifest).toContain('desktop-e2e = ["rion-appkit/desktop-e2e"]');
    expect(header).toContain("rion_appkit_resolve_electron_native_view_window");
    expect(bridge).toContain("if (!NSThread.isMainThread)");
    expect(bridge).toContain("NSWindow *nativeWindow = nativeView.window");
    expect(bridge).toContain("kRionAppKitWindowResolutionDetachedView");
  });

  it("keeps native handles inside a bounded Electron-main N-API lifecycle", async () => {
    const [nodeAdapter, nodeValidation, nodePlatform, hostFactory, electronMain,
      bootstrap] =
      await Promise.all([
      readFile("crates/rion-node/src/appkit_runtime_host.rs", "utf8"),
      readFile("crates/rion-node/src/appkit_runtime_host/validation.rs", "utf8"),
      readFile("crates/rion-node/src/appkit_runtime_host/platform.rs", "utf8"),
      readFile("src/electron/main/macosAppKitRuntimeHostFactory.ts", "utf8"),
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/main/chromiumRuntimeBootstrap.ts", "utf8")
    ]);

    expect(nodeValidation).toContain("std::mem::size_of::<usize>()");
    expect(nodeValidation).toContain("usize::from_ne_bytes(native_bytes)");
    expect(nodeAdapter).toContain("resolve_native_window");
    expect(nodePlatform).toContain("resolve_electron_native_view_window");
    expect(nodePlatform).toContain("#[cfg(target_os = \"macos\")]");
    expect(nodeAdapter).toContain("APPKIT_EVENT_QUEUE_CAPACITY");
    expect(nodeAdapter).toContain("context.accepting.store(false");
    expect(hostFactory).toContain("Electron BaseWindow carries Chromium child views");
    expect(hostFactory).toContain("attachAppKitRuntimeHost");
    expect(hostFactory).toContain("controller.destroy(record.identity)");
    expect(hostFactory).not.toContain("BrowserWindow");
    expect(hostFactory).not.toContain("runtime-windows-host.html");
    expect(hostFactory).not.toMatch(/set(?:Interval|Timeout)\s*\(/u);
    expect(hostFactory).not.toContain("webPreferences");
    expect(nodeAdapter).not.toContain("WebKit");
    expect(nodeAdapter).not.toContain("remote-debugging");
    expect(nodePlatform).not.toContain("WebKit");
    expect(nodePlatform).not.toContain("remote-debugging");
    expect(electronMain).toContain("MacosAppKitChromiumRuntimeHostFactory");
    expect(electronMain).toContain("capabilities: MACOS_APPKIT_CHROMIUM_CAPABILITIES");
    const adapterFactory = electronMain.slice(
      electronMain.indexOf("function createMacosAppKitAdapter("),
      electronMain.indexOf("function currentWindow(")
    );
    expect(adapterFactory).toContain(
      "): MacosAppKitRuntimeBootstrapAdapter {"
    );
    expect(adapterFactory).toContain("throw new RionBridgeError(normalized);");
    expect(adapterFactory).not.toContain("return undefined;");
    expect(electronMain).toContain(
      'if (runtimePlatform === "darwin" && !appKit) {'
    );
    expect(electronMain).toContain(
      'code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE"'
    );
    expect(electronMain).not.toContain(
      "capabilities: UNAVAILABLE_CHROMIUM_CAPABILITIES"
    );
    expect(bootstrap).toContain(
      "const capabilities = copyCapabilities(input.appKit.capabilities)"
    );
    expect(bootstrap).not.toContain("...WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES,");
  });

  it("retires all native tab projection indexes after a visible close", async () => {
    const controller = await readFile(
      "crates/rion-appkit/native/macos/RionRuntimeTabsController/06_fullscreen.mm",
      "utf8"
    );
    const closeTab = controller.slice(
      controller.indexOf("- (void)closeTab:(NSString *)tabIdentifier"),
      controller.indexOf("- (void)showTabMenu:(NSString *)tabIdentifier")
    );

    expect(closeTab).toContain(
      "[_tabItemsByIdentifier removeObjectForKey:tabIdentifier];"
    );
    expect(closeTab).toContain(
      "[_tabModelsByIdentifier removeObjectForKey:tabIdentifier];"
    );
    expect(closeTab).toContain("[_tabIconCache removeObjectForKey:tabIdentifier];");
    expect(closeTab).toContain("[_tabIconCacheKeys removeObjectForKey:tabIdentifier];");
  });
});
