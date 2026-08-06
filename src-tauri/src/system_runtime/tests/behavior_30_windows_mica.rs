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
