#[test]
fn runtime_window_activation_accepts_a_live_empty_native_host() {
    for (
        platform,
        presented_tab_count,
        native_tab_count,
        empty_host_available,
        launch_or_restore_pending,
        expected,
    ) in [
        ("macos", None, 0, false, false, false),
        ("windows", None, 0, true, false, false),
        ("macos", Some(0), 0, false, false, false),
        ("windows", Some(0), 0, false, false, false),
        ("windows", Some(0), 0, true, false, true),
        ("windows", Some(2), 0, true, false, false),
        ("windows", Some(2), 0, true, true, true),
        ("macos", Some(1), 1, false, false, true),
        ("windows", Some(1), 1, false, false, true),
    ] {
        assert_eq!(
            live_window_activation_available(
                presented_tab_count,
                native_tab_count,
                empty_host_available,
                launch_or_restore_pending,
            ),
            expected,
            "unexpected activation availability on {platform}",
        );
    }
}
