use super::{is_live_tab_owner, should_fence_background_tab_action};

#[test]
fn appkit_close_callback_requires_the_current_live_owner() {
    assert!(is_live_tab_owner(Some("window-1"), Some("window-1")));
    assert!(!is_live_tab_owner(Some("window-2"), Some("window-1")));
    assert!(!is_live_tab_owner(Some("window-1"), None));
    assert!(!is_live_tab_owner(None, None));
}

#[test]
fn background_stop_survives_the_callbacks_live_membership_removal() {
    assert!(!should_fence_background_tab_action(
        "stop",
        Some("window-1"),
        None,
    ));
}

#[test]
fn background_hide_and_reorder_keep_the_live_owner_fence() {
    for action_type in ["hide", "reorder"] {
        assert!(should_fence_background_tab_action(
            action_type,
            Some("window-2"),
            Some("window-1"),
        ));
        assert!(!should_fence_background_tab_action(
            action_type,
            Some("window-1"),
            Some("window-1"),
        ));
    }
}
