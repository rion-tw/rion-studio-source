#[test]
fn runtime_window_activation_requires_live_tab_membership() {
    for (platform, live_tab_count, expected) in [
        ("macos", None, false),
        ("windows", None, false),
        ("macos", Some(0), false),
        ("windows", Some(0), false),
        ("macos", Some(1), true),
        ("windows", Some(1), true),
    ] {
        assert_eq!(
            live_window_activation_available(live_tab_count),
            expected,
            "unexpected activation availability on {platform}",
        );
    }
}
