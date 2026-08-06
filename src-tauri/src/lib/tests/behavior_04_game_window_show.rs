#[test]
fn game_window_show_prefers_live_activation_over_saved_window_work() {
    for saved_tabs_empty in [false, true] {
        assert_eq!(
            game_window_show_route(true, saved_tabs_empty),
            GameWindowShowRoute::ActivateLive,
        );
    }
}

#[test]
fn game_window_show_routes_dormant_windows_by_saved_tab_membership() {
    assert_eq!(
        game_window_show_route(false, false),
        GameWindowShowRoute::RestoreSaved,
    );
    assert_eq!(
        game_window_show_route(false, true),
        GameWindowShowRoute::RegisterEmpty,
    );
}
