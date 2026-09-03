fn git_output(args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn is_full_git_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn main() {
    println!("cargo:rerun-if-env-changed=RION_STUDIO_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DESKTOP_E2E");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    println!("cargo:rerun-if-changed=windows-test-manifest.rc");
    if let Some(git_head_path) = git_output(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={git_head_path}");
    }
    if let Some(git_reference) = git_output(&["symbolic-ref", "-q", "HEAD"])
        && let Some(git_reference_path) =
            git_output(&["rev-parse", "--git-path", git_reference.as_str()])
    {
        println!("cargo:rerun-if-changed={git_reference_path}");
    }
    let build_commit = std::env::var("RION_STUDIO_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&["rev-parse", "HEAD"]))
        .filter(|value| is_full_git_commit(value))
        .unwrap_or_else(|| {
            if std::env::var("PROFILE").as_deref() == Ok("release") {
                panic!(
                    "release builds require a full Git commit in RION_STUDIO_BUILD_COMMIT or the checkout metadata"
                );
            }
            "unknown".to_owned()
        });
    println!("cargo:rustc-env=RION_STUDIO_BUILD_COMMIT={build_commit}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile_for_everything("windows-test-manifest.rc", embed_resource::NONE)
            .manifest_required()
            .expect("failed to embed the Windows application manifest");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos/RionWKWebViewInput.m")
            .flag("-fobjc-arc")
            .flag("-Werror=nullability-completeness")
            .flag("-Werror=nullability")
            .flag("-Werror=nonnull")
            .compile("rion_wkwebview_input");
        cc::Build::new()
            .file("native/macos/RionDockMenu.m")
            .flag("-fobjc-arc")
            .flag("-Werror=nullability-completeness")
            .flag("-Werror=nullability")
            .flag("-Werror=nonnull")
            .compile("rion_dock_menu");
        cc::Build::new()
            .file("native/macos/RionPowerLifecycle.m")
            .flag("-fobjc-arc")
            .flag("-Werror=nullability-completeness")
            .flag("-Werror=nullability")
            .flag("-Werror=nonnull")
            .compile("rion_power_lifecycle");
        cc::Build::new()
            .file("native/macos/RionTauriWebKitEventCompatibility.m")
            .flag("-fobjc-arc")
            .flag("-Werror=nullability-completeness")
            .flag("-Werror=nullability")
            .flag("-Werror=nonnull")
            .compile("rion_tauri_webkit_event_compatibility");
        if std::env::var_os("CARGO_FEATURE_DESKTOP_E2E").is_some() {
            cc::Build::new()
                .file("native/macos/RionDesktopE2E.m")
                .flag("-fobjc-arc")
                .flag("-Werror=nullability-completeness")
                .flag("-Werror=nullability")
                .flag("-Werror=nonnull")
                .compile("rion_desktop_e2e");
            println!("cargo:rerun-if-changed=native/macos/RionDesktopE2E.m");
        }
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rerun-if-changed=native/macos/RionWKWebViewInput.m");
        println!("cargo:rerun-if-changed=native/macos/RionDockMenu.m");
        println!("cargo:rerun-if-changed=native/macos/RionPowerLifecycle.m");
        println!("cargo:rerun-if-changed=native/macos/RionTauriWebKitEventCompatibility.h");
        println!("cargo:rerun-if-changed=native/macos/RionTauriWebKitEventCompatibility.m");
        for source in [
            "native/macos/RionWKWebViewInput/01_surface_lifecycle_security.m",
            "native/macos/RionWKWebViewInput/02_input_zoom.m",
            "native/macos/RionWKWebViewInput/03_role_session_export.m",
        ] {
            println!("cargo:rerun-if-changed={source}");
        }
    }
    const PRODUCT_COMMANDS: &[&str] = &[
        "rion_core_invoke",
        "rion_browser_font_payload",
        "rion_divider_pointer",
        "rion_macro_key_event_observed",
        "rion_managed_shortcut_key_phase",
        "rion_overlay_request",
        "rion_runtime_audio_state",
        "rion_workspace_web_chrome_action",
        "rion_workspace_web_fullscreen_transition",
        "rion_runtime_role_slot_action",
        "rion_runtime_role_slot_ready",
        "rion_runtime_tab_action",
        "rion_dispatch_core_effect_results",
        "rion_shared_user_data_dir",
        "rion_shell_invoke",
    ];
    const DESKTOP_E2E_COMMANDS: &[&str] = &[
        "rion_core_invoke",
        "rion_browser_font_payload",
        "rion_divider_pointer",
        "rion_macro_key_event_observed",
        "rion_managed_shortcut_key_phase",
        "rion_overlay_request",
        "rion_runtime_audio_state",
        "rion_workspace_web_chrome_action",
        "rion_workspace_web_fullscreen_transition",
        "rion_runtime_role_slot_action",
        "rion_runtime_role_slot_ready",
        "rion_runtime_tab_action",
        "rion_dispatch_core_effect_results",
        "rion_shared_user_data_dir",
        "rion_shell_invoke",
        "desktop_e2e_probe",
        "desktop_e2e_wait_event",
        "desktop_e2e_window_snapshot",
        "desktop_e2e_inject_duplicate_role_cookie_checkpoint",
        "desktop_e2e_arm_indeterminate_macro_input",
        "desktop_e2e_application_lifecycle_signal",
        "desktop_e2e_arm_automation_readiness_failure",
        "desktop_e2e_suspend_automation_surface",
        "desktop_e2e_inject_page_finish_failure",
        "desktop_e2e_control_window",
        "desktop_e2e_runtime_ui_action",
        "desktop_e2e_input_diagnostics",
        "desktop_e2e_keyboard_input",
        "desktop_e2e_mouse_input",
        "desktop_e2e_shutdown",
    ];
    let commands = if std::env::var_os("CARGO_FEATURE_DESKTOP_E2E").is_some() {
        DESKTOP_E2E_COMMANDS
    } else {
        PRODUCT_COMMANDS
    };
    let manifest = tauri_build::AppManifest::new().commands(commands);
    // The shared resource above supplies the application manifest to binaries and test harnesses.
    // Keep Tauri's generated icon/version resource, but avoid embedding a second manifest in bins.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(manifest)
            .windows_attributes(windows),
    )
    .expect("failed to run the Rion Studio Tauri build script");
}
