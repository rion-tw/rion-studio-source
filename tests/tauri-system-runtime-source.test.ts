import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Tauri System WebView runtime source", () => {
  it("keeps popup, download, crash recovery, and platform input inside the native runtime", async () => {
    const [runtime, shell, macInput, inputVerifier, restoreVerifier, fileVerifier, platformProbe] = await Promise.all([
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
    expect(runtime).toContain("run_proxy_attestation");
    expect(runtime).toContain("proxy_configuration_applied");
    expect(runtime).toContain("DOWNLOAD_ATTESTATION_BODY");
    expect(runtime).toContain("add_ProcessFailed");
    expect(runtime).toContain("PermissionRequestedEventHandler");
    expect(runtime).toContain("ServerCertificateErrorDetectedEventHandler");
    expect(runtime).toContain("COREWEBVIEW2_PERMISSION_STATE_DENY");
    expect(runtime).toContain("COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL");
    expect(runtime).toContain("EmbeddedSystemSurfaceFailed");
    expect(runtime).toContain("EmbeddedSystemSurfaceRecovered");
    expect(runtime).toContain("SURFACE_RECOVERY_LIMIT");
    expect(runtime).toContain("RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR");
    expect(runtime).toContain("+trusted-input-attested");
    expect(runtime).toContain("start_trusted_input_attestation");
    expect(runtime).toContain("TRUSTED_INPUT_ATTESTATION_SOURCE");
    expect(runtime).toContain("const CYCLES: u64 = 1_000");
    expect(runtime).toContain("run_role_count_attestation");
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
    expect(shell).toContain("CoreCommand::EmbeddedDisplayRemove");
    expect(shell).toContain("CoreCommand::WorkspaceReconcileDisplays");
    expect(shell).toContain('"restoreSavedGameWindows"');
    expect(shell).toContain('"autoRestoreSavedGameWindows"');
    expect(macInput).toContain("NSEventTypeFlagsChanged");
    expect(macInput).toContain("[responder keyDown:event]");
    expect(macInput).toContain("rion_wk_install_security_policy");
    expect(macInput).toContain("rion_wk_window_content_layout_metrics");
    expect(macInput).toContain("window.contentLayoutRect");
    expect(macInput).toContain("rion_wk_has_proxy_configuration");
    expect(macInput).toContain('valueForKey:@"proxyConfigurations"');
    expect(macInput).toContain("rion_wk_terminate_web_content_process");
    expect(macInput).toContain('@"_webProcessIdentifier"');
    expect(macInput).toContain("kill(pid, SIGKILL)");
    expect(macInput).toContain("RionJavaScriptConfirm");
    expect(macInput).toContain("WKPermissionDecisionDeny");
    expect(macInput).not.toContain("CGEventPost");
    expect(inputVerifier).toContain("RION_STUDIO_INPUT_ATTESTATION_OUTPUT");
    expect(inputVerifier).toContain("stress?.keyDown !== 1000");
    expect(inputVerifier).toContain("JSON.stringify([1, 3, 6, 9])");
    expect(inputVerifier).toContain("roleParity?.createDestroyCycles !== 100");
    expect(inputVerifier).toContain("popupDownload?.popupSharedStore !== true");
    expect(inputVerifier).toContain("popupDownload?.downloadContentVerified !== true");
    expect(inputVerifier).toContain("popupDownload?.uploadContentVerified !== true");
    expect(macInput).toContain("rion_wk_install_upload_attestation");
    expect(macInput).toContain("runOpenPanelWithParameters");
    expect(inputVerifier).toContain("layout?.pixelParity !== true");
    expect(inputVerifier).toContain("proxy?.configurationApplied !== true");
    expect(inputVerifier).toContain('expectedPlatform === "windows"');
    expect(inputVerifier).toContain("recovery?.nativeHandleReplaced !== true");
    expect(inputVerifier).toContain("recovery?.processTerminationObserved !== true");
    expect(inputVerifier).toContain("recovery?.inputRestored !== true");
    expect(inputVerifier).toContain("--require-compiled-attestation");
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
  });
});
