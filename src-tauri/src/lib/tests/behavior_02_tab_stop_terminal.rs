#[test]
fn destructive_tab_stop_completes_after_isolation_while_chrome_and_release_reconcile() {
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
                "tabStopChromeReconcilePending",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
        assert_eq!(
            tab_stop_terminal_outcome(true, false),
            (
                "tabStopIsolatedReleasePending",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
        assert_eq!(
            tab_stop_terminal_outcome(false, false),
            (
                "tabStopIsolatedReleaseAndChromeReconcilePending",
                RuntimeTabMutationTerminalStatus::Applied,
                None,
            ),
            "{platform}"
        );
    }
}
