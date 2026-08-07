#[test]
fn runtime_window_activation_accepts_a_live_empty_native_host() {
    for (platform, live_tab_count, empty_host_available, expected) in [
        ("macos", None, false, false),
        ("windows", None, true, false),
        ("macos", Some(0), false, false),
        ("windows", Some(0), false, false),
        ("windows", Some(0), true, true),
        ("macos", Some(1), false, true),
        ("windows", Some(1), false, true),
    ] {
        assert_eq!(
            live_window_activation_available(live_tab_count, empty_host_available),
            expected,
            "unexpected activation availability on {platform}",
        );
    }
}
