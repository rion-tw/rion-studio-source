#[test]
fn chromium_fonts_use_the_shell_inventory_and_keep_rust_cache_and_fallback() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 23);
        let listed = core.invoke(command(json!({
            "type": "systemFontsList", "families": ["  Test   Family ", "test family", "Bad\u{0000}Font"]
        }))).unwrap();
        assert_eq!(listed, json!([{ "family": "Test Family", "label": "Test Family" }]), "{platform}");
        assert_eq!(core.invoke(command(json!({
            "type": "systemFontsList", "families": ["Changed"]
        }))).unwrap(), listed, "{platform}");
        core.shutdown();

        let (_directory, fallback_core) = core_for_platform_contract(platform, 23);
        let fallback = fallback_core.invoke(command(json!({ "type": "systemFontsList" }))).unwrap();
        assert_eq!(fallback, serde_json::to_value(crate::system_fonts::normalize_or_fallback(Vec::new())).unwrap(), "{platform}");
        fallback_core.shutdown();
    }
}

#[test]
fn retained_v22_fonts_do_not_consume_the_chromium_inventory() {
    for platform in ["darwin", "win32"] {
        let (_directory, core) = core_for_platform_contract(platform, 22);
        let listed = core.invoke(command(json!({
            "type": "systemFontsList", "families": ["Rion CP06 shell-only fixture"]
        }))).unwrap();
        assert!(!listed.as_array().unwrap().iter().any(|font| font["family"] == "Rion CP06 shell-only fixture"), "{platform}");
        core.shutdown();
    }
}
