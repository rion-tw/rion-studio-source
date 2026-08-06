#[test]
fn windows_mica_requires_windows_eleven_or_newer() {
    assert_eq!(
        windows_mica_material_for_version(10, 19_045),
        WindowsMicaMaterial::Opaque
    );
    assert_eq!(
        windows_mica_material_for_version(10, 22_000),
        WindowsMicaMaterial::Mica
    );
    assert_eq!(
        windows_mica_material_for_version(10, 26_100),
        WindowsMicaMaterial::Mica
    );
    assert_eq!(
        windows_mica_material_for_version(11, 0),
        WindowsMicaMaterial::Mica
    );
}

#[test]
fn windows_tab_material_initialization_does_not_require_a_parsed_document() {
    for (enabled, expected_value) in [(true, "value: true"), (false, "value: false")] {
        let script = windows_runtime_tab_initialization_script("window-1", 2, 3, enabled)
            .expect("tab initialization script should serialize");

        assert!(script.contains("__rionRuntimeTabWindowsMicaEnabled"));
        assert!(script.contains(expected_value));
        assert!(script.contains("__rionRuntimeTabChromeIdentity"));
        assert!(!script.contains("document."));
    }
}
