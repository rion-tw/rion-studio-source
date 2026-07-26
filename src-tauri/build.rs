fn main() {
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_MACOS_INPUT_ATTESTED_MAJOR");
    println!("cargo:rerun-if-env-changed=RION_STUDIO_WINDOWS_INPUT_ATTESTED");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos/RionWKWebViewInput.m")
            .flag("-fobjc-arc")
            .compile("rion_wkwebview_input");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rerun-if-changed=native/macos/RionWKWebViewInput.m");
    }
    let manifest = tauri_build::AppManifest::new().commands(&[
        "rion_core_invoke",
        "rion_overlay_request",
        "rion_dispatch_core_effect_results",
        "rion_shared_user_data_dir",
        "rion_shell_invoke",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run the Rion Studio Tauri build script");
}
