import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri System WebView runtime source", () => {
  it("keeps popup, download, crash recovery, and platform input inside the native runtime", async () => {
    const [
      runtime,
      shell,
      macInput,
      inputVerifier,
      macroGameVerifier,
      sessionImportVerifier,
      restoreVerifier,
      fileVerifier,
      platformProbe
    ] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(
        new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../scripts/verifySystemTrustedInput.mjs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../scripts/verifySystemMacroGame.mjs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../scripts/verifySystemSessionImport.mjs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../scripts/verifySystemRuntimeRestore.mjs", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../scripts/verifySystemFileOperations.mjs", import.meta.url),
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
    expect(runtime).toContain("verify_popup_download_attestation");
    expect(runtime).toContain("DOM.setFileInputFiles");
    expect(runtime).toContain("wk-open-panel-callback");
    expect(runtime).toContain("uploadContentVerified");
    expect(runtime).toContain("verify_surface_recovery_attestation");
    expect(runtime).not.toContain("proxy_url");
    expect(runtime).not.toContain("proxy_attestation");
    expect(runtime).toContain("DOWNLOAD_ATTESTATION_BODY");
    expect(runtime).toContain("add_ProcessFailed");
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
    expect(runtime).not.toContain("rion-runtime-audio://");
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
    expect(windowsTabStrip).toContain("Value::String(icon.clone())");
    expect(windowsTabStrip).toContain(".unwrap_or(Value::Null)");
    expect(windowsTabStrip).not.toContain(".unwrap_or_else(|_| Value::Null)");
    expect(applyRuntime).toContain("surface.reparent(&window)");
    expect(applyRuntime).toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");
    expect(applyRuntime).toContain("is_visible().unwrap_or(false)");
    const closeRuntimeWindow = runtime.slice(
      runtime.indexOf("pub fn handle_window_close_requested("),
      runtime.indexOf("pub fn resize_window(")
    );
    expect(closeRuntimeWindow).toContain("window.hide()");
    expect(closeRuntimeWindow).not.toContain("BrowserRoleStop");
    expect(closeRuntimeWindow).not.toContain("BrowserWorkspaceStop");
    expect(runtime).toContain('document.addEventListener("DOMContentLoaded", publish, { once: true })');
    expect(runtime).not.toContain('  publish();\n})();\n"#;');
    expect(runtime).not.toContain("RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR");
    expect(runtime).not.toContain("RION_STUDIO_WINDOWS_INPUT_ATTESTED");
    expect(runtime).not.toContain("+trusted-input-attested");
    expect(runtime).toContain("start_trusted_input_attestation");
    expect(runtime).toContain("TRUSTED_INPUT_ATTESTATION_SOURCE");
    expect(runtime).toContain("const CYCLES: u64 = 1_000");
    expect(runtime).toContain("TRUSTED_INPUT_EVENT_INTERVAL: Duration = Duration::from_millis(25)");
    const attestKey = runtime.slice(
      runtime.indexOf("fn attest_key("),
      runtime.indexOf("fn attestation_snapshot(")
    );
    expect(attestKey).not.toContain("sleep(Duration::from_millis(2))");
    const trustedInputAttestation = runtime.slice(
      runtime.indexOf("fn run_trusted_input_attestation("),
      runtime.indexOf("fn run_simulated_input_stress(")
    );
    expect(trustedInputAttestation).not.toContain("sleep(Duration::from_millis(2))");
    const mouseDown = trustedInputAttestation.indexOf(
      'dispatch_mouse_effect(webview, ClickPoint { x: 32, y: 32 }, "left", true)'
    );
    const pressedBarrier = trustedInputAttestation.indexOf(
      "mouse_down: 1,\n            mouse_up: 0",
      mouseDown
    );
    const mouseUp = trustedInputAttestation.indexOf(
      'dispatch_mouse_effect(webview, ClickPoint { x: 32, y: 32 }, "left", false)',
      pressedBarrier
    );
    const releasedBarrier = trustedInputAttestation.indexOf(
      "mouse_down: 1,\n            mouse_up: 1",
      mouseUp
    );
    expect(mouseDown).toBeGreaterThan(-1);
    expect(pressedBarrier).toBeGreaterThan(mouseDown);
    expect(mouseUp).toBeGreaterThan(pressedBarrier);
    expect(releasedBarrier).toBeGreaterThan(mouseUp);
    const inputCountMatcher = runtime.slice(
      runtime.indexOf("impl AttestationInputCounts"),
      runtime.indexOf("fn wait_for_attestation_state(")
    );
    expect(inputCountMatcher).toContain('snapshot.get("mouseDown")');
    expect(inputCountMatcher).toContain('snapshot.get("mouseUp")');
    const windowsAudioMute = runtime.slice(
      runtime.indexOf('#[cfg(windows)]\nfn set_audio_muted('),
      runtime.indexOf('#[cfg(not(any(windows, target_os = "macos")))]\nfn set_audio_muted(')
    );
    expect(windowsAudioMute).toContain("SetIsMuted(muted)");
    expect(windowsAudioMute).not.toContain("SetIsMuted(muted.into())");
    expect(runtime).toContain("run_role_count_attestation");
    expect(runtime).toContain("verify_shared_display_host_attestation");
    const destroyAttestationTab = runtime.slice(
      runtime.indexOf("fn destroy_attestation_tab("),
      runtime.indexOf("fn run_role_count_attestation(")
    );
    expect(destroyAttestationTab).toContain("runtime.destroy_tab(tab_id)?");
    expect(destroyAttestationTab).toContain("runtime.discard_provisional_game_window(window_id)");
    const roleCountAttestation = runtime.slice(
      runtime.indexOf("fn run_role_count_attestation("),
      runtime.indexOf("fn verify_compatibility_surface_attestation(")
    );
    expect(roleCountAttestation).toContain(
      "destroy_attestation_tab(runtime, &tab_id, &window_id)"
    );
    const sharedHostAttestation = runtime.slice(
      runtime.indexOf("fn verify_shared_display_host_attestation("),
      runtime.indexOf("fn runtime_window_native_identity(")
    );
    expect(sharedHostAttestation).toContain(
      "destroy_attestation_tab(runtime, second_tab_id, WINDOW_ID)"
    );
    const createDestroyAttestation = runtime.slice(
      runtime.indexOf("fn run_create_destroy_attestation("),
      runtime.indexOf("fn attestation_role(")
    );
    expect(createDestroyAttestation).toContain(
      "destroy_attestation_tab(runtime, &tab_id, &window_id)?"
    );
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
    expect(compatibilitySurface).toContain('format!("{}:{}", plan.game_id, plan.started_at)');
    expect(runtime).toContain("for count in [1_usize, 3, 6, 9]");
    expect(runtime).toContain("role_bounds_for_content");
    expect(runtime).toContain("logical_window_content_metrics");
    expect(runtime).toContain('"pixelParity": true');
    expect(runtime).toContain("const CYCLES: u64 = 100");
    expect(runtime).toContain("localStorage.setItem('rion-attestation-role'");
    expect(runtime).toContain('"modifierObserved"');
    expect(runtime).toContain('cfg!(target_os = "macos")');
    expect(shell).toContain("on_web_content_process_terminate");
    expect(shell).toContain("rion-tauri-display-watcher");
    expect(shell).not.toContain("CoreCommand::EmbeddedDisplayRemove");
    expect(shell).not.toContain("CoreCommand::WorkspaceReconcileDisplays");
    expect(shell).toContain('"rion://displays"');
    expect(shell).toContain('"restoreSavedGameWindows"');
    expect(shell).toContain('"autoRestoreSavedGameWindows"');
    expect(macInput).toContain("NSEventTypeFlagsChanged");
    expect(macInput).toContain("[responder keyDown:event]");
    expect(macInput).toContain("rion_wk_install_security_policy");
    expect(macInput).toContain("rion_wk_window_content_layout_metrics");
    expect(macInput).toContain("window.contentLayoutRect");
    expect(macInput).toContain("NSRect viewportBounds = webView.bounds");
    expect(macInput).not.toContain("NSIntersectionRect(webView.bounds, layoutInView)");
    expect(macInput).not.toContain("proxyConfigurations");
    expect(macInput).toContain("rion_wk_terminate_web_content_process");
    expect(macInput).toContain("[window makeFirstResponder:webView]");
    expect(macInput).toContain("RionWKContentView(webView)");
    expect(macInput).toContain("[candidateView isDescendantOf:webView]");
    expect(macInput).toContain("[responder keyUp:event]");
    expect(runtime).toContain("MACOS_KEY_DISPATCH_STATE");
    expect(runtime).toContain("MACOS_KEY_DISPATCH_SETTLE_INTERVAL");
    expect(runtime).toContain("macos_key_dispatch_needs_settle");
    expect(macInput).toContain('@"_webProcessIdentifier"');
    expect(macInput).toContain("kill(pid, SIGKILL)");
    expect(macInput).toContain("RionJavaScriptConfirm");
    expect(macInput).toContain("WKPermissionDecisionDeny");
    expect(macInput).not.toContain("CGEventPost");
    expect(inputVerifier).toContain("RION_STUDIO_INPUT_ATTESTATION_OUTPUT");
    expect(inputVerifier).toContain("simulatedStress?.keyDown !== 1000");
    expect(inputVerifier).toContain('simulatedStress?.transport !== "simulated-core-input-state"');
    expect(runtime).toContain("run_simulated_input_stress(&runtime.core)");
    expect(inputVerifier).toContain("JSON.stringify([1, 3, 6, 9])");
    expect(inputVerifier).toContain("roleParity?.createDestroyCycles !== 100");
    expect(inputVerifier).toContain("compatibility?.probeExecuted !== true");
    expect(inputVerifier).toContain("compatibility?.isolatedStorage !== true");
    expect(inputVerifier).toContain("sharedDisplayHost?.nativeHandleStable !== true");
    expect(inputVerifier).toContain("sharedDisplayHost?.contentStateStable !== true");
    expect(inputVerifier).toContain("popupDownload?.popupSharedStore !== true");
    expect(inputVerifier).toContain("popupDownload?.downloadContentVerified !== true");
    expect(inputVerifier).toContain("popupDownload?.uploadContentVerified !== true");
    expect(macInput).toContain("rion_wk_install_upload_attestation");
    expect(macInput).toContain("runOpenPanelWithParameters");
    expect(inputVerifier).toContain("layout?.pixelParity !== true");
    expect(inputVerifier).not.toContain("roleParity?.proxy");
    expect(inputVerifier).toContain('expectedPlatform === "windows"');
    expect(inputVerifier).toContain("recovery?.nativeHandleReplaced !== true");
    expect(inputVerifier).toContain("recovery?.processTerminationObserved !== true");
    expect(inputVerifier).toContain("recovery?.inputRestored !== true");
    expect(macroGameVerifier).toContain(
      "embedded_macro_from_one_role_runs_three_iterations_for_all_assigned_roles"
    );
    expect(macroGameVerifier).toContain("macro_runtime::tests");
    expect(macroGameVerifier).toContain("compatibility_runtime::tests");
    expect(macroGameVerifier).toContain("RION_STUDIO_MACRO_GAME_ATTESTATION_OUTPUT");
    expect(macroGameVerifier).toContain("productionMacroStart !== true");
    expect(macroGameVerifier).toContain("cancelStoppedDispatch !== true");
    expect(macroGameVerifier).toContain("trustedEventsOnly !== true");
    expect(macroGameVerifier).toContain("verifySystemTrustedInput.mjs");
    expect(sessionImportVerifier).toContain("session_import::tests");
    expect(sessionImportVerifier).toContain("chrome_profile_import::tests");
    expect(sessionImportVerifier).toContain('"session_transfer_"');
    expect(sessionImportVerifier).toContain("verifySystemTrustedInput.mjs");
    expect(inputVerifier).not.toContain("--require-compiled-attestation");
    expect(inputVerifier).toContain('backgroundInput !== "supported"');
    expect(shell).toContain("RION_STUDIO_RUNTIME_RESTORE_ATTESTATION_STAGE");
    expect(shell).toContain("start_runtime_restore_attestation");
    expect(shell).toContain("safe_display_id");
    expect(restoreVerifier).toContain('["seed", "restore", "clean-check"]');
    expect(restoreVerifier).toContain("roleStorePreserved !== true");
    expect(restoreVerifier).toContain("savedTargetDisplayUnavailable !== true");
    expect(restoreVerifier).toContain("hotplugDisplayRemovalApplied !== true");
    expect(restoreVerifier).toContain("displayFallbackApplied !== true");
    expect(restoreVerifier).toContain("autoRestoreEligible !== true");
    expect(shell).toContain("RION_STUDIO_FILE_OPERATIONS_ATTESTATION_OUTPUT");
    expect(shell).toContain("run_file_operations_attestation");
    expect(fileVerifier).toContain("portableAtomicFailurePreserved !== true");
    expect(fileVerifier).toContain("diagnosticsAtomicFailurePreserved !== true");
    expect(runtime).toContain('b"_setPageMuted:\\0"');
    expect(runtime).not.toContain('b"_setMuted:\\0"');
    expect(platformProbe).toContain('has_instance_selector(webview, "_setPageMuted:")');
    expect(platformProbe).not.toContain('has_instance_selector(webview, "_setMuted:")');
    expect(platformProbe).toContain("macro_input_available");
    expect(platformProbe).not.toContain("trusted-input-unverified");
    expect(platformProbe).not.toContain("background-input-unverified");
  });

  it("keeps macro overlay refresh, app activation, pending routing, and navigation release wired", async () => {
    const [runtime, shell, app] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8")
    ]);

    const refresh = runtime.slice(
      runtime.indexOf("pub fn refresh_macro_overlays("),
      runtime.indexOf("pub(crate) fn evaluate_role_for_attestation(")
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
