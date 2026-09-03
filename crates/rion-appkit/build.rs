fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DESKTOP_E2E");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

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

    let mut runtime_tabs = cc::Build::new();
    runtime_tabs
        .cpp(true)
        .file("native/macos/RionRuntimeTabsController.mm")
        .flag("-fobjc-arc")
        .flag("-std=c++17")
        .flag("-Werror=nullability-completeness")
        .flag("-Werror=nullability")
        .flag("-Werror=nonnull");
    if std::env::var_os("CARGO_FEATURE_DESKTOP_E2E").is_some() {
        runtime_tabs.define("RION_DESKTOP_E2E", None);
    }
    runtime_tabs.compile("rion_runtime_tabs");

    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
    println!("cargo:rerun-if-changed=native/macos/RionRuntimeTabsController.h");
    println!("cargo:rerun-if-changed=native/macos/RionRuntimeTabsController.mm");
    for source in [
        "native/macos/RionRuntimeTabsController/01_geometry.mm",
        "native/macos/RionRuntimeTabsController/02_c_abi_bridge.mm",
        "native/macos/RionRuntimeTabsController/03_shortcut_model.mm",
        "native/macos/RionRuntimeTabsController/03_support_views.mm",
        "native/macos/RionRuntimeTabsController/03_workspace_divider_views.mm",
        "native/macos/RionRuntimeTabsController/04_view_model.mm",
        "native/macos/RionRuntimeTabsController/05_layout.mm",
        "native/macos/RionRuntimeTabsController/06_fullscreen.mm",
        "native/macos/RionRuntimeTabsController/06_modifier_focus.mm",
        "native/macos/RionRuntimeTabsController/07_drag_drop.mm",
        "native/macos/RionRuntimeTabsController/08_controller_lifecycle.mm",
        "native/macos/RionRuntimeTabsController/09_chromium_surface_probe.mm",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }
}
