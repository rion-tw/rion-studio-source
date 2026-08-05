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
