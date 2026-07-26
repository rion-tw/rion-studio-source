fn main() {
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_ENDPOINT");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let runtime_output = std::process::Command::new("xcrun")
            .args(["clang", "--print-runtime-dir"])
            .output()
            .expect("failed to locate the Apple clang runtime directory");
        if !runtime_output.status.success() {
            panic!("Apple clang did not report its runtime directory");
        }
        let runtime_directory = String::from_utf8(runtime_output.stdout)
            .expect("Apple clang runtime directory was not UTF-8");
        let runtime_directory = runtime_directory.trim();
        if !std::path::Path::new(runtime_directory)
            .join("libclang_rt.osx.a")
            .is_file()
        {
            panic!("Apple clang runtime library was not found in {runtime_directory}");
        }
        println!("cargo:rustc-link-search=native={runtime_directory}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        cc::Build::new()
            .file("native/macos/RionWKWebViewInput.m")
            .flag("-fobjc-arc")
            .compile("rion_wkwebview_input");
        cc::Build::new()
            .cpp(true)
            .file("native/macos/RionRuntimeTabsController.mm")
            .flag("-fobjc-arc")
            .flag("-std=c++17")
            .compile("rion_runtime_tabs");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rerun-if-changed=native/macos/RionWKWebViewInput.m");
        println!("cargo:rerun-if-changed=native/macos/RionRuntimeTabsController.h");
        println!("cargo:rerun-if-changed=native/macos/RionRuntimeTabsController.mm");
    }
    let manifest = tauri_build::AppManifest::new().commands(&[
        "rion_core_invoke",
        "rion_divider_pointer",
        "rion_overlay_request",
        "rion_runtime_audio_state",
        "rion_runtime_tab_action",
        "rion_dispatch_core_effect_results",
        "rion_shared_user_data_dir",
        "rion_shell_invoke",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run the Rion Studio Tauri build script");
}
