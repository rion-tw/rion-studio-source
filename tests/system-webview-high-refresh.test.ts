import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("macOS System WebView high refresh mode", () => {
  it("applies the guarded WebKit preference only to role surfaces and popups", async () => {
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
    expect(roleBuilder).toContain("popup_high_refresh_rate");
    expect(roleBuilder).toContain("configure_platform_high_refresh_rate");
    expect(createTab).toContain("configure_platform_high_refresh_rate");
    expect(recovery).toContain("configure_platform_high_refresh_rate");
    expect(runtime).toContain("#[cfg(not(target_os = \"macos\"))]");
    expect(runtime).not.toContain("disable-frame-rate-limit");
    expect(runtime).not.toContain("force-high-performance-gpu");
  });
});
