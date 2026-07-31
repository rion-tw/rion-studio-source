import { readSourceTree as readFile } from "./helpers/readSourceTree";

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
    expect(runtime).toContain("controller_identity");
    expect(runtime).toContain("controller.Close()");
    expect(runtime).toContain("mark_native_surface_released");
    expect(runtime).toContain("fn add_child_bounded(");
    expect(runtime).toContain("fn create_window_bounded(");
    expect(runtime).toContain("surface_host_initialization_requires_visible_parent");
    expect(runtime).toContain("set_windows_surface_host_initialization_visibility");
    expect(runtime).toContain("SW_SHOWNOACTIVATE");
    expect(runtime).not.toContain("surface-host-main-thread-flush");
    expect(runtime).toContain("WINDOWS_RUNTIME_TAB_RESERVATION_SCRIPT");
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
      runtime.indexOf("fn sync_native_tab_metadata(")
    );
    expect(applyRuntime).not.toContain("sync_native_tab_metadata");
    expect(runtime).toContain("struct RuntimeDisplayHost");
    expect(runtime).toContain('runtime_label("game-display"');
    expect(runtime).not.toContain('runtime_label("game-tab", &tab.tab_id)');
    const windowsTabStrip = runtime.slice(
      runtime.indexOf("fn sync_windows_tab_metadata("),
      runtime.indexOf("fn windows_tab_strip_height(")
    );
    expect(windowsTabStrip).toContain("__rionUpdateRuntimeTabMetadataBatch");
    expect(windowsTabStrip).not.toContain("__rionApplyRuntimeTabState");
    expect(windowsTabStrip).not.toContain("display_inventory");
    expect(windowsTabStrip).toContain("presented.phase.as_str()");
    const nativeMacTabs = runtime.slice(
      runtime.indexOf("fn sync_native_tab_metadata("),
      runtime.indexOf("fn sync_windows_tab_metadata(")
    );
    expect(nativeMacTabs).not.toContain("resolved_theme");
    expect(nativeMacTabs).toContain("controller.update_metadata(");
    expect(nativeMacTabs).not.toContain("controller.update(");
    expect(applyRuntime).toContain("surface.reparent(&window)");
    expect(applyRuntime).toContain("move_tab_with_activation(");
    expect(applyRuntime).toContain("relocate_native_tab_reservation(");
    expect(applyRuntime).toContain("try_ensure_native_tab(");
    expect(applyRuntime).toContain("reorder_native_tabs(");
    expect(applyRuntime).toContain("let projected_native_tab_window_ids = snapshot");
    expect(applyRuntime).toContain("resolved_runtime_window_selection(");
    expect(applyRuntime).toContain("dispatch_native_presentation(");
    expect(applyRuntime).toContain("SYSTEM_RUNTIME_TOPOLOGY_INVALID");
    expect(applyRuntime).toContain("self.presentation.remove(&window_id)");
    expect(applyRuntime).not.toContain("visibility_mutations");
    expect(applyRuntime).not.toContain("webview.set_focus()");
    expect(applyRuntime).not.toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");
    expect(applyRuntime).toContain("runtime_host_should_receive_window_focus(");
    expect(applyRuntime).toContain("update.window.unminimize()");
    expect(applyRuntime).toContain("update.window.set_focus()");
    expect(runtime).toContain("self.record_runtime_stage_failure(");
    expect(runtime).toContain("&setup_stage,");
    expect(runtime).toContain("record_presentation_event_with_error(");
    expect(runtime).toContain("completion.error.as_ref()");

    const closeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub(crate) fn begin_window_close_requested("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(closeRuntimeWindow).toContain("allow_window_close_labels.remove(label)");
    expect(closeRuntimeWindow).toContain("pending_window_close_labels.insert(label.to_owned())");
    expect(closeRuntimeWindow).toContain("RuntimeWindowCloseRequest::Pending");
    expect(closeRuntimeWindow).toContain("RuntimeWindowCloseRequest::Start");
    expect(closeRuntimeWindow).toContain("finish_window_close_requested");
    expect(closeRuntimeWindow).not.toContain(".hide()");
    expect(shell).toContain("match state.runtime.begin_window_close_requested(&label)");
    expect(shell).toContain("process_game_window_close_requested(");
    expect(shell).toContain("CoreCommand::BrowserWindowStop");
    expect(shell).toContain("confirm_game_window_close(&app, &window, copy)");
    expect(shell).toContain("runtime.persist_game_window_placement(&label)");
    expect(shell).toContain('"windowLabel": label');
    expect(shell).not.toContain("prune_empty_game_window_records");
    expect(shell).not.toContain("delete_empty_game_window");
    const showGameWindow = shell.slice(
      shell.indexOf('"showGameWindow" =>'),
      shell.indexOf('"updateGameWindow" =>')
    );
    expect(showGameWindow).toContain("game_window_record(&state.core, &window_id)");
    expect(showGameWindow).toContain("saved.tabs.is_empty()");
    expect(showGameWindow).toContain("CoreCommand::EmbeddedWindowRegister");
    expect(showGameWindow).toContain("restore_saved_game_windows(");
    const restoreSavedWindows = shell.slice(
      shell.indexOf("async fn restore_saved_game_windows("),
      shell.indexOf("fn browser_runtime_snapshot(")
    );
    expect(restoreSavedWindows).not.toContain("CoreCommand::GameWindowDelete");
    expect(restoreSavedWindows).not.toContain("game_windows.retain");
    const resizeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub fn resize_window("),
      runtime.indexOf("pub fn move_window(")
    );
    expect(resizeRuntimeWindow).toContain("runtime_window_resize_is_actionable");
    expect(resizeRuntimeWindow).toContain("TAURI_RUNTIME_WINDOW_LAYOUT_FAILED");
    expect(resizeRuntimeWindow).not.toContain("persist_game_window_placement");
    const resizeScheduler = runtime.slice(
      runtime.indexOf("pub fn schedule_resize_window("),
      runtime.indexOf("pub fn prepare_runtime_window_fullscreen(")
    );
    expect(resizeScheduler).toContain("schedule_window_placement_persistence");
    expect(resizeScheduler).toContain("WINDOW_PLACEMENT_PERSIST_DEBOUNCE");
    expect(runtime).toContain('document.addEventListener("DOMContentLoaded", publish, { once: true })');
    expect(runtime).not.toContain('  publish();\n})();\n"#;');

    const roleLoading = runtime.slice(
      runtime.indexOf("fn start_role_loads("),
      runtime.indexOf("fn install_overlays(")
    );
    expect(roleLoading).toContain("let mut pending_navigations");
    expect(roleLoading.indexOf("begin_controlled_navigation")).toBeLessThan(
      roleLoading.indexOf("surface.navigate")
    );
    expect(roleLoading.indexOf("pending_navigations.push")).toBeGreaterThan(
      roleLoading.indexOf("surface.navigate")
    );
    expect(roleLoading.indexOf("fn load_roles(")).toBeGreaterThan(
      roleLoading.indexOf("pending_navigations.push")
    );
    const compatibilityWait = roleLoading.slice(roleLoading.indexOf("fn load_roles("));
    expect(compatibilityWait.indexOf("finish_controlled_navigations")).toBeGreaterThan(
      compatibilityWait.indexOf(".wait()")
    );
    expect(runtime).toContain("navigation.wait_async().await");

    const reloadTab = runtime.slice(
      runtime.indexOf("pub fn reload_tab("),
      runtime.indexOf("pub fn set_tab_audio_muted(")
    );
    expect(reloadTab).toMatch(/tab\s*\.roles/);
    expect(reloadTab).toContain("webview.reload()");
    expect(reloadTab).not.toContain("popup_roles");

    expect(runtime).not.toContain("CompatibilitySurface");
    expect(runtime).not.toContain("create_compatibility_surface");
    expect(runtime).not.toContain("compatibility_session_paths");
    expect(runtime).toContain("role_bounds_for_content");
    expect(runtime).toContain("logical_window_content_metrics");
    expect(runtime).toContain('type === "beforeunload"');
    expect(runtime).toContain("__rionPrepareForNativeClose");
    expect(runtime).toContain("globalThis.frames[index].postMessage");
    const dividerPointer = runtime.slice(
      runtime.indexOf("pub fn handle_divider_pointer("),
      runtime.indexOf("fn send_divider_indicators(")
    );
    expect(dividerPointer).toContain("persist_runtime_tab_role_views");
    expect(dividerPointer).not.toContain("persist_restore_session(false)");
    expect(runtime).toContain("pub fn restore_tab_role_views(");

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
    expect(macInput).toContain("RionWKSurfaceLease");
    expect(macInput).toContain("rion_wk_track_surface");
    expect(macInput).toContain("rion_wk_quiesce_surface");
    expect(macInput).toContain("evaluateJavaScript:");
    expect(macInput).toContain("blankNavigationRequested");
    expect(macInput).toContain("__rionPrepareForNativeClose");
    expect(macInput).toContain("rion_wk_surface_quiesced");
    expect(macInput).toContain("rion_wk_surface_released");
    expect(macInput).toContain("webView.superview || webView.window");
    expect(macInput).toContain('[url.absoluteString isEqualToString:@"about:blank"]');
    expect(macInput).toContain("rion_wk_surface_lifecycle_self_test");
    const nativeQuiesce = macInput.slice(
      macInput.indexOf("static bool RionWKQuiesceSurfaceOnMain("),
      macInput.indexOf("bool rion_wk_quiesce_surface(")
    );
    expect(nativeQuiesce).toContain("completionHandler:nil");
    expect(nativeQuiesce.indexOf("[webView stopLoading]")).toBeGreaterThan(
      nativeQuiesce.indexOf("evaluateJavaScript:")
    );
    expect(nativeQuiesce).not.toContain("weakWebView");
    expect(macInput).toContain("rion_wk_window_content_layout_metrics");
    expect(macInput).toContain("window.contentLayoutRect");
    expect(macInput).not.toContain("[window makeFirstResponder:webView]");
    expect(macInput).toContain("RionWKContentView(webView)");
    expect(macInput).toContain("RionResponderBelongsToView(candidate, webView)");
    expect(macInput).toContain("RionRestoreFirstResponder(");
    expect(macInput).toContain("(id<RionFirstResponderHost>)window");
    expect(macInput).toContain("rion_wk_background_input_focus_self_test");
    expect(macInput).not.toContain("CGEventPost");

    expect(runtime).toContain("MACOS_KEY_DISPATCH_STATE");
    expect(runtime).toContain("MACOS_KEY_DISPATCH_SETTLE_INTERVAL");
    expect(runtime).toContain("macos_key_dispatch_needs_settle");
    expect(runtime).toContain('b"_setPageMuted:\\0"');
    expect(runtime).not.toContain('b"_setMuted:\\0"');
    const surfaceLogging = runtime.slice(
      runtime.indexOf("fn record_surface_event("),
      runtime.indexOf("pub(crate) fn tab_drag_window_snapshot(")
    );
    expect(surfaceLogging).toContain('"instanceId"');
    expect(surfaceLogging).toContain('"generation"');
    expect(surfaceLogging).toContain('"roleId"');
    expect(surfaceLogging).not.toContain('"url"');
    expect(surfaceLogging).not.toMatch(/cookie|session/i);
    expect(platformProbe).toContain('has_instance_selector(webview, "_setPageMuted:")');
    expect(platformProbe).not.toContain('has_instance_selector(webview, "_setMuted:")');
    expect(platformProbe).toContain("macro_input_available");
    expect(platformProbe).toContain("GetAvailableCoreWebView2BrowserVersionString");
    expect(platformProbe).toContain("classify_windows_runtime_version");
    expect(platformProbe).not.toContain("LoadLibraryW");
    expect(platformProbe).not.toContain("WebView2Loader.dll");

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
    expect(overlayRequest).toContain("authorize_overlay_request(webview.label(), &capability)");
    expect(overlayRequest).toContain('"OVERLAY_REQUEST_UNAUTHORIZED"');
    expect(overlayRequest.indexOf("authorize_overlay_request(webview.label(), &capability)"))
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
    expect(mainNavigation).toContain("allow_navigation_after_macro_release(");
    expect(runtime).toContain('matches!(url.scheme(), "http" | "https")');

    const navigationPolicy = runtime.slice(
      runtime.indexOf("fn allow_navigation_after_macro_release("),
      runtime.indexOf("fn begin_controlled_navigation(")
    );
    expect(navigationPolicy).toContain("release_macros_for_unblocked_navigation(");
    expect(navigationPolicy).toContain(".invoke_async(CoreCommand::MacroReleaseRole");
    expect(navigationPolicy).not.toContain("webview.navigate(url)");
    expect(navigationPolicy).not.toContain('"url"');

    const windowsDocumentHandler = runtime.slice(
      runtime.indexOf("fn install_document_navigation_macro_release_handler("),
      runtime.indexOf("fn complete_windows_document_navigation_deferral(")
    );
    expect(windowsDocumentHandler).toContain("WebResourceRequestedEventHandler");
    expect(windowsDocumentHandler).toContain("AddWebResourceRequestedFilter");
    expect(windowsDocumentHandler).toContain("COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT");
    expect(windowsDocumentHandler).toContain("args.GetDeferral()");
    expect(windowsDocumentHandler).toContain("unsafe { args.GetDeferral() }");
    expect(windowsDocumentHandler).toMatch(
      /unsafe\s*\{\s*core_webview\.AddWebResourceRequestedFilter/
    );
    expect(windowsDocumentHandler).toContain(
      "unsafe { core_webview.add_WebResourceRequested(&handler, &mut token) }"
    );
    expect(windowsDocumentHandler).toContain("retain_windows_document_navigation_deferral(deferral)");
    expect(windowsDocumentHandler).toContain(".invoke_async(CoreCommand::MacroReleaseRole");
    expect(windowsDocumentHandler).toContain("run_on_main_thread");
    expect(windowsDocumentHandler).not.toContain("navigate(");
    expect(runtime).toContain("WINDOWS_DOCUMENT_NAVIGATION_DEFERRALS");
    expect(runtime).not.toContain("AgileReference");
    expect(runtime).not.toContain("RoGetAgileReference");
    expect(runtime).toContain("deferral.Complete()");
    expect(runtime).toContain("register_windows_document_navigation_handler(");
    const windowsRoleSetup = runtime.slice(
      runtime.indexOf('#[cfg(windows)]\nfn install_windows_role_surface_handlers('),
      runtime.indexOf('#[cfg(windows)]\nfn windows_role_setup_error(')
    );
    expect(windowsRoleSetup.match(/\.with_webview\(/g)).toHaveLength(1);
    expect(windowsRoleSetup).toContain("register_windows_document_navigation_handler(");

    const popupNavigation = runtime.slice(
      runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("),
      runtime.indexOf(".on_download(move |_webview, event|", runtime.indexOf("let popup_builder = WebviewWindowBuilder::new("))
    );
    expect(popupNavigation).toContain("allow_navigation_after_macro_release(");

    const pendingRoute = app.slice(
      app.indexOf("const consumePendingPageRequest"),
      app.indexOf("const consumePendingLaunchRequest")
    );
    expect(pendingRoute).toContain("consumePendingMacroPageRequest()");
    expect(pendingRoute.indexOf("openListForRole(request.roleId)"))
      .toBeLessThan(pendingRoute.indexOf("navigateToMacros()"));
  });
});
