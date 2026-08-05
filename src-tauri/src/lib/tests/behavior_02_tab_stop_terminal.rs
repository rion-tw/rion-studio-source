#[test]
fn destructive_tab_stop_completes_after_isolation_without_chrome_convergence() {
    for platform in ["macos", "windows"] {
        assert_eq!(
            tab_stop_terminal_outcome(true),
            (
                "tabStopIsolated",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
        assert_eq!(
            tab_stop_terminal_outcome(false),
            (
                "tabStopIsolatedReleasePending",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
    }
}

#[test]
fn stale_live_tab_callbacks_are_superseded_without_hiding_real_native_failures() {
    for message in [
        "The runtime tab was not found.",
        "The tab presentation is no longer live.",
        "Runtime tab was not found in the presentation state.",
    ] {
        assert!(stale_live_tab_action_error(message), "{message}");
    }
    assert!(!stale_live_tab_action_error(
        "Runtime display host was not found."
    ));
}
