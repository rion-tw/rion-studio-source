#[test]
fn destructive_tab_stop_requires_chrome_and_native_release_for_applied() {
    for platform in ["macos", "windows"] {
        assert_eq!(
            tab_stop_terminal_outcome(true, true),
            (
                "tabStopConverged",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
        assert_eq!(
            tab_stop_terminal_outcome(false, true),
            (
                "tabStopChromeUnconfirmed",
                RuntimeTabMutationTerminalStatus::Degraded,
                Some("TAB_MUTATION_CHROME_NOT_CONFIRMED"),
            ),
            "{platform}"
        );
        assert_eq!(
            tab_stop_terminal_outcome(true, false),
            (
                "tabStopReleasePending",
                RuntimeTabMutationTerminalStatus::Degraded,
                None,
            ),
            "{platform}"
        );
    }
}
