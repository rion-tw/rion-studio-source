use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};

#[test]
fn pinned_tauri_parser_ignores_additive_platform_sha256() {
    assert!(include_str!("../Cargo.toml").contains("tauri-plugin-updater = \"=2.10.1\""));

    let release: RemoteRelease = serde_json::from_str(include_str!(
        "../../tests/fixtures/updater/latest-with-sha256.json"
    ))
    .expect("the pinned updater parser should accept the additive sha256 field");

    assert_eq!(release.version.to_string(), "2.3.4");
    let RemoteReleaseInner::Static { platforms } = release.data else {
        panic!("the golden manifest must parse as a static platform manifest");
    };
    let mac = platforms
        .get("darwin-aarch64")
        .expect("the macOS updater platform should remain available");
    let windows = platforms
        .get("windows-x86_64")
        .expect("the Windows updater platform should remain available");
    assert_eq!(
        mac.url.as_str(),
        "https://downloads.example.test/releases/v2.3.4/Rion.Studio-mac.app.tar.gz"
    );
    assert_eq!(mac.signature, "mac-signature");
    assert_eq!(
        windows.url.as_str(),
        "https://downloads.example.test/releases/v2.3.4/Rion.Studio-win.exe"
    );
    assert_eq!(windows.signature, "windows-signature");
}
