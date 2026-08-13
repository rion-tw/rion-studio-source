#[test]
fn game_window_show_prefers_live_activation_over_saved_window_work() {
    for saved_tabs_empty in [false, true] {
        assert_eq!(
            game_window_show_route(true, saved_tabs_empty, Some(0)),
            GameWindowShowRoute::ActivateLive,
        );
    }
}

#[test]
fn game_window_show_routes_dormant_windows_by_saved_tab_membership() {
    assert_eq!(
        game_window_show_route(false, false, None),
        GameWindowShowRoute::RestoreSaved,
    );
    assert_eq!(
        game_window_show_route(false, true, None),
        GameWindowShowRoute::RegisterEmpty,
    );
    assert_eq!(
        game_window_show_route(false, false, Some(0)),
        GameWindowShowRoute::RegisterEmpty,
    );
    assert_eq!(
        game_window_show_route(false, true, Some(1)),
        GameWindowShowRoute::RegisterEmpty,
    );
}

#[test]
fn saved_window_restore_focus_is_user_initiated_and_selects_one_initial_target() {
    let window = |id: &str| {
        serde_json::from_value::<StateGameWindowRecord>(json!({
            "id": id,
            "name": id,
            "targetDisplay": { "id": 1 },
            "placement": {
                "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                "presentation": "normal"
            },
            "tabs": [],
            "activeTabId": null,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    };
    let selected = vec![window("window-a"), window("window-b")];

    assert_eq!(
        saved_window_restore_focus_target(
            SavedWindowRestoreActivation::Background,
            &selected,
            Some("window-b"),
        ),
        None
    );
    assert_eq!(
        saved_window_restore_focus_target(
            SavedWindowRestoreActivation::UserInitiated,
            &selected,
            Some("window-b"),
        )
        .as_deref(),
        Some("window-b")
    );
    assert_eq!(
        saved_window_restore_focus_target(
            SavedWindowRestoreActivation::UserInitiated,
            &selected,
            Some("retired-window"),
        )
        .as_deref(),
        Some("window-a")
    );
}

#[test]
fn recovery_cohort_only_scopes_user_restore_all() {
    let dormant = HashSet::from([
        "normally-closed".to_owned(),
        "session-window".to_owned(),
    ]);
    let recovery = HashSet::from(["session-window".to_owned()]);

    assert_eq!(
        saved_window_restore_candidate_ids(
            SavedWindowRestoreActivation::UserInitiated,
            "all",
            &dormant,
            &recovery,
            None,
        ),
        recovery,
    );
    assert_eq!(
        saved_window_restore_candidate_ids(
            SavedWindowRestoreActivation::Background,
            "all",
            &dormant,
            &HashSet::new(),
            None,
        ),
        dormant,
    );
    assert_eq!(
        saved_window_restore_candidate_ids(
            SavedWindowRestoreActivation::UserInitiated,
            "window",
            &HashSet::from(["normally-closed".to_owned()]),
            &HashSet::from(["session-window".to_owned()]),
            None,
        ),
        HashSet::from(["normally-closed".to_owned()]),
    );

    let clean_exit_visible = HashSet::from(["session-window".to_owned()]);
    assert_eq!(
        saved_window_restore_candidate_ids(
            SavedWindowRestoreActivation::Background,
            "all",
            &dormant,
            &HashSet::new(),
            Some(&clean_exit_visible),
        ),
        clean_exit_visible,
    );
    assert!(
        saved_window_restore_candidate_ids(
            SavedWindowRestoreActivation::Background,
            "all",
            &dormant,
            &HashSet::new(),
            Some(&HashSet::new()),
        )
        .is_empty(),
        "a clean exit with no live Game Windows must not reopen dormant windows"
    );
}
