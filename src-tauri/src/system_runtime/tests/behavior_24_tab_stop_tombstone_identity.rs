#[test]
fn tab_stop_identity_survives_the_live_close_commit() {
    assert_eq!(
        resolve_tab_stop_window_id(Some("live".to_owned()), Some("tombstone".to_owned())),
        Some("live".to_owned())
    );
    assert_eq!(
        resolve_tab_stop_window_id(None, Some("tombstone".to_owned())),
        Some("tombstone".to_owned())
    );
    assert_eq!(resolve_tab_stop_window_id(None, None), None);
}
