import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri System WebView runtime source", () => {
  it("keeps production popup, download, recovery, lifecycle, and platform input native", async () => {
    const [runtime, shell, macInput, platformProbe] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../crates/rion-platform/src/system_webview.rs", import.meta.url),
        "utf8"
      )
    ]);

    expect(runtime).toContain("NewWindowResponse::Create");
    expect(runtime).toContain("window_features(features)");
    expect(runtime).toContain("data_directory(popup_webview2_data_directory.clone())");
    expect(runtime).toContain("data_store_identifier(popup_webkit_data_store_identifier)");
    expect(runtime).toContain("on_download");
    expect(runtime).not.toContain("proxy_url");
    expect(runtime).toContain("add_ProcessFailed");
    expect(runtime).toContain("add_BrowserProcessExited");
    expect(runtime).toContain("fn add_child_bounded(");
    expect(runtime).toContain("fn create_window_bounded(");
    expect(runtime).toContain("surface_host_initialization_requires_visible_parent");
    expect(runtime).toContain("set_windows_surface_host_initialization_visibility");
    expect(runtime).toContain("SW_SHOWNOACTIVATE");
    expect(runtime).toContain("surface-host-main-thread-flush");
    expect(runtime).toContain("run_serial_runtime_work_loop");
    expect(runtime).toContain("SYSTEM_WEBVIEW_CREATION_STALLED");
    expect(runtime).toContain("PermissionRequestedEventHandler");
    expect(runtime).toContain("ServerCertificateErrorDetectedEventHandler");
    expect(runtime).toContain("COREWEBVIEW2_PERMISSION_STATE_DENY");
    expect(runtime).toContain("COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL");
    expect(runtime).toContain("EmbeddedSystemSurfaceFailed");
    expect(runtime).toContain("EmbeddedSystemSurfaceRecovered");
    expect(runtime).toContain("SURFACE_RECOVERY_LIMIT");
    expect(runtime).toContain(
      '#[cfg(target_os = "macos")]\n    pub fn handle_web_content_process_terminated('
    );
    expect(runtime).toContain('internals.invoke("rion_runtime_audio_state", { audible })');
    expect(runtime).toContain("set_webview_audible");
    expect(shell).toContain("rion_runtime_audio_state");

    const applyRuntime = runtime.slice(
      runtime.indexOf("fn apply_runtime("),
      runtime.indexOf("fn sync_native_tab_strip(")
    );
    expect(applyRuntime).not.toContain("sync_native_tab_strip");
    expect(runtime).toContain("struct RuntimeDisplayHost");
    expect(runtime).toContain('runtime_label("game-display"');
    expect(runtime).not.toContain('runtime_label("game-tab", &tab.tab_id)');
    const windowsTabStrip = runtime.slice(
      runtime.indexOf("fn sync_windows_tab_strip("),
      runtime.indexOf("fn windows_tab_strip_height(")
    );
    expect(windowsTabStrip).toContain("crate::display_inventory(&window)");
    expect(windowsTabStrip).not.toContain("crate::workspace_displays(&window)");
    expect(applyRuntime).toContain("surface.reparent(&window)");
    expect(applyRuntime).toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");

    const closeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub fn handle_window_close_requested("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(closeRuntimeWindow).toContain("window.hide()");
    expect(closeRuntimeWindow).not.toContain("BrowserRoleStop");
    expect(closeRuntimeWindow).not.toContain("BrowserWorkspaceStop");
    expect(runtime).toContain('document.addEventListener("DOMContentLoaded", publish, { once: true })');
    expect(runtime).not.toContain('  publish();\n})();\n"#;');

    const roleLoading = runtime.slice(
      runtime.indexOf("fn load_roles("),
      runtime.indexOf("fn install_overlays(")
    );
    expect(roleLoading).toContain("let mut pending_navigations");
    expect(roleLoading.indexOf("pending_navigations.push")).toBeGreaterThan(
      roleLoading.indexOf("surface.navigate")
    );
    expect(roleLoading.indexOf(".wait()")).toBeGreaterThan(
      roleLoading.indexOf("pending_navigations.push")
    );

    const compatibilitySurface = runtime.slice(
      runtime.indexOf("fn create_compatibility_surface("),
      runtime.indexOf("fn require_compatibility_surface(")
    );
    expect(compatibilitySurface.indexOf("let mut state = match self.state()"))
      .toBeGreaterThan(compatibilitySurface.indexOf("install_platform_security_policy"));
    expect(compatibilitySurface).toContain("A compatibility surface was created concurrently");
    expect(runtime).toContain("role_bounds_for_content");
    expect(runtime).toContain("logical_window_content_metrics");

    expect(shell).toContain("on_web_content_process_terminate");
    expect(shell).toContain("rion-tauri-display-watcher");
    expect(shell).not.toContain("CoreCommand::EmbeddedDisplayRemove");
    expect(shell).not.toContain("CoreCommand::WorkspaceReconcileDisplays");
    expect(shell).toContain('"rion://displays"');
    expect(shell).toContain('"restoreSavedGameWindows"');
    expect(shell).toContain('"autoRestoreSavedGameWindows"');

    expect(macInput).toContain("NSEventTypeFlagsChanged");
    expect(macInput).toContain("[responder keyDown:event]");
    expect(macInput).toContain("[responder keyUp:event]");
    expect(macInput).toContain("rion_wk_install_security_policy");
    expect(macInput).toContain("rion_wk_window_content_layout_metrics");
    expect(macInput).toContain("window.contentLayoutRect");
    expect(macInput).toContain("[window makeFirstResponder:webView]");
    expect(macInput).toContain("RionWKContentView(webView)");
    expect(macInput).toContain("[candidateView isDescendantOf:webView]");
    expect(macInput).not.toContain("CGEventPost");

    expect(runtime).toContain("MACOS_KEY_DISPATCH_STATE");
    expect(runtime).toContain("MACOS_KEY_DISPATCH_SETTLE_INTERVAL");
    expect(runtime).toContain("macos_key_dispatch_needs_settle");
    expect(runtime).toContain('b"_setPageMuted:\\0"');
    expect(runtime).not.toContain('b"_setMuted:\\0"');
    expect(platformProbe).toContain('has_instance_selector(webview, "_setPageMuted:")');
    expect(platformProbe).not.toContain('has_instance_selector(webview, "_setMuted:")');
    expect(platformProbe).toContain("macro_input_available");

    for (const source of [runtime, shell, macInput]) {
      expect(source).not.toMatch(/attestation/i);
      expect(source).not.toContain("RION_STUDIO_INPUT_ATTESTATION");
    }
  });


  it("keeps macro overlay refresh, app activation, pending routing, and navigation release wired", async () => {
    const [runtime, shell, app] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8")
    ]);

    const refresh = runtime.slice(
      runtime.indexOf("pub fn refresh_macro_overlays("),
      runtime.indexOf("pub fn role_id_for_webview(")
    );
    expect(refresh).toContain("should_refresh_macro_overlay(role_ids, role_id)");
    expect(refresh).toMatch(/state\s*\.popup_roles/);
    expect(refresh).toContain("self.app.get_webview(&label)");
    expect(refresh).toContain("refresh_macro_overlay_handles(webviews");
    expect(refresh).toContain("webview.eval(MACRO_OVERLAY_REFRESH_SOURCE)");
    expect(refresh.indexOf("refresh_macro_overlay_handles(webviews")).toBeGreaterThan(
      refresh.indexOf("(webviews, popup_labels)")
    );
    expect(shell).toContain("CoreEvent::OverlayChanged { role_ids } => {");
    expect(shell).toContain("effect_runtime.refresh_macro_overlays(&role_ids);");
    expect(shell).toContain("renderer_events.push(CoreEvent::OverlayChanged { role_ids });");

    const overlayRequest = shell.slice(
      shell.indexOf("async fn rion_overlay_request("),
      shell.indexOf("async fn rion_runtime_audio_state(")
    );
    expect(overlayRequest).toContain("overlay_request_activates_webview(&payload)");
    expect(overlayRequest).toContain("webview.set_focus()");
    expect(overlayRequest).toContain('"OVERLAY_WEBVIEW_FOCUS_FAILED"');
    expect(overlayRequest.indexOf("role_id_for_webview(webview.label())"))
      .toBeLessThan(overlayRequest.indexOf("webview.set_focus()"));

    const openMacroPage = runtime.slice(
      runtime.indexOf("CoreEffectAction::OverlayOpenMacroPage { role_id } => {"),
      runtime.indexOf("CoreEffectAction::OverlayCopyCoordinate")
    );
    expect(openMacroPage.indexOf("pending_macro_page_request = Some(request.clone())"))
      .toBeLessThan(openMacroPage.indexOf("run_on_main_thread"));
    expect(openMacroPage).toContain("window.unminimize()");
    expect(openMacroPage).toContain("window.show()");
    expect(openMacroPage).toContain("window.set_focus()");
    expect(openMacroPage.indexOf("window.set_focus()"))
      .toBeLessThan(openMacroPage.indexOf('emit("rion://macro-page-request", request)'));

    const mainNavigation = runtime.slice(
      runtime.indexOf(".on_navigation(move |url| {"),
      runtime.indexOf(".on_new_window(move |url, features|")
    );
    expect(mainNavigation).toContain("should_release_macros_for_navigation(url)");
    expect(mainNavigation).toContain("CoreCommand::MacroReleaseRole { role_id }");
    expect(runtime).toContain('matches!(url.scheme(), "http" | "https")');
    expect(mainNavigation.indexOf('url.scheme() == "rion-runtime-shortcut"'))
      .toBeLessThan(mainNavigation.indexOf("should_release_macros_for_navigation(url)"));

    const pendingRoute = app.slice(
      app.indexOf("const consumePendingPageRequest"),
      app.indexOf("const consumePendingLaunchRequest")
    );
    expect(pendingRoute).toContain("consumePendingMacroPageRequest()");
    expect(pendingRoute.indexOf("openListForRole(request.roleId)"))
      .toBeLessThan(pendingRoute.indexOf("navigateToMacros()"));
  });
});
