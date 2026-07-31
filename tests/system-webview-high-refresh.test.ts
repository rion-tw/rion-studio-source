import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("macOS System WebView high refresh mode", () => {
  it("configures role data stores and high refresh before WKWebView initialization", async () => {
    const [runtime, native] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url), "utf8")
    ]);
    const roleBuilder = runtime.slice(
      runtime.indexOf("fn webview_builder("),
      runtime.indexOf("fn clear_role_browser_data(")
    );
    const createTab = runtime.slice(
      runtime.indexOf("fn create_tab("),
      runtime.indexOf("fn load_roles(")
    );
    const recovery = runtime.slice(
      runtime.indexOf("fn recover_system_surface("),
      runtime.indexOf("fn prepare_automation_focus(")
    );

    expect(native).toContain("PreferPageRenderingUpdatesNear60FPSEnabled");
    expect(native).toContain("_setEnabled:forFeature:");
    expect(native).toContain("respondsToSelector");
    expect(native).toContain("WKWebViewConfiguration *configuration");
    expect(native).toContain("configuration.preferences");
    expect(native).not.toContain("webView.configuration.preferences");
    expect(native).toContain("dataStoreForIdentifier:identifier");
    expect(native).toContain("configuration.websiteDataStore = dataStore");
    expect(roleBuilder).toContain("fn role_webview_builder(");
    expect(roleBuilder).toContain("prepare_platform_role_webview_builder");
    expect(roleBuilder).toContain(".window_features(features)");
    expect(roleBuilder).not.toContain("popup_high_refresh_rate");
    expect(roleBuilder).not.toContain("configure_platform_high_refresh_rate");
    expect(createTab).toContain("self.role_webview_builder(");
    expect(createTab).toContain("high_refresh_rate_status,");
    expect(recovery).toContain("self.role_webview_builder(");
    expect(recovery).toContain("high_refresh_rate_status,");
    expect(runtime).toContain("rion_wk_create_role_configuration");
    expect(runtime).toContain("builder.with_webview_configuration(configuration)");
    expect(runtime).toContain("#[cfg(not(target_os = \"macos\"))]");
    expect(runtime).not.toContain("disable-frame-rate-limit");
    expect(runtime).not.toContain("force-high-performance-gpu");
  });
});
