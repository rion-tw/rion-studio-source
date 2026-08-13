import { readSourceTree as readFile } from "./helpers/readSourceTree";

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
    expect(native).toContain("UseGPUProcessForWebGLEnabled");
    expect(native).toContain("UseGPUProcessForDOMRenderingEnabled");
    expect(native).toContain("UseGPUProcessForCanvasRenderingEnabled");
    expect(native).not.toContain('configuration, @"UseGPUProcessForCanvasEnabled"');
    expect(native).toContain("setEnabledSelector, enabled, feature");
    expect(native).toContain("RionWKConfigureFeatureForPreferences");
    expect(native).toContain("RionWKMaximumWebGLPerformanceFailed");
    expect(native).toContain("RionWKRejectingPreferencesFixture");
    expect(native).toContain("rion_wk_copy_runtime_version");
    expect(native).toContain("bundleForClass:WKWebView.class");
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
    expect(createTab).toContain("web_gl_configuration,");
    expect(recovery).toContain("self.role_webview_builder(");
    expect(recovery).toContain("high_refresh_rate_status,");
    expect(recovery).toContain("web_gl_configuration,");
    expect(runtime).toContain("rion_wk_create_role_configuration");
    expect(runtime).toContain("builder.with_webview_configuration(configuration)");
    expect(runtime).toContain("mac_web_gl_policy");
    expect(runtime).toContain('const WEBKIT_26_5_BUILD: &str = "21624.2.5.11.4"');
    expect(runtime).toContain("certified_direct_web_gl_build");
    expect(runtime).toContain("WebKitFeaturePreference::KeepDefault");
    expect(runtime).not.toContain("if !high_refresh_rate_enabled && !maximum_web_gl_performance_enabled");
    expect(runtime).toContain("#[cfg(not(target_os = \"macos\"))]");
    expect(runtime).not.toContain("disable-frame-rate-limit");
    expect(runtime).not.toContain("force-high-performance-gpu");
  });
});
