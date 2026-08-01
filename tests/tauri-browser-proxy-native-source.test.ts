import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("native role proxy integration", () => {
  it("keeps macOS proxy application in its own fail-closed Network.framework unit", async () => {
    const [nativeProxy, build, macosRuntime] = await Promise.all([
      readFile("src-tauri/native/macos/RionWKWebViewProxy.m", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/platform/macos.rs", "utf8")
    ]);

    expect(nativeProxy).toContain("nw_proxy_config_create_http_connect");
    expect(nativeProxy).toContain("nw_proxy_config_create_socksv5");
    expect(nativeProxy).toContain("nw_proxy_config_set_failover_allowed(proxy, false)");
    expect(nativeProxy).toContain("dataStore.proxyConfigurations = nil");
    expect(build).toContain('rustc-link-lib=framework=Network');
    expect(macosRuntime).toContain("rion_wk_create_role_network_configuration");
    expect(macosRuntime).toContain('"BROWSER_PROXY_APPLY_FAILED"');
  });

  it("pins one proxy snapshot across visible, popup, recovery, and hidden role stores", async () => {
    const [builder, recovery, hidden, runtime] = await Promise.all([
      readFile("src-tauri/src/system_runtime/section_19_webview_builder.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_17_rebuild_role_surface.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/section_20_verify_role_authentication.rs", "utf8"),
      readFile("src-tauri/src/system_runtime/browser_proxy.rs", "utf8")
    ]);

    expect(builder).toContain("popup_proxy_snapshot");
    expect(builder).toContain("role_store_webview_builder");
    expect(builder).toContain("ensure_webview2_environment");
    expect(recovery).toContain("register_webview2_lifecycle");
    expect(hidden).toContain("role_store_webview_builder");
    expect(runtime).toContain('"BROWSER_PROXY_RESTART_REQUIRED"');
    expect(runtime).toContain("wait_for_browser_process_exit");
  });
});
