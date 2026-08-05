#[test]
fn drag_cursor_lease_requires_the_exact_session_and_window_generation() {
    let lease = TabDragCursorLease {
        session_id: "drag-new".to_owned(),
        window_generation: 7,
    };

    assert!(tab_drag_cursor_lease_matches(&lease, "drag-new", 7));
    assert!(!tab_drag_cursor_lease_matches(&lease, "drag-old", 7));
    assert!(!tab_drag_cursor_lease_matches(&lease, "drag-new", 8));
    assert!(tab_drag_cursor_release_allowed(None, "drag-new", 7));
    assert!(tab_drag_cursor_release_allowed(
        Some(&lease),
        "drag-new",
        7
    ));
    assert!(!tab_drag_cursor_release_allowed(
        Some(&lease),
        "drag-old",
        7
    ));
}

#[test]
fn closing_workspace_tombstone_fences_only_its_exact_owned_slot_generation() {
    let close = TabCloseTombstone {
        revision: 10,
        slot_owners: vec![("slot-a".to_owned(), "role-a".to_owned(), Some(4))],
        source_id: "workspace-a".to_owned(),
        tab_type: "workspace".to_owned(),
        window_id: "window-a".to_owned(),
    };

    assert_eq!(close.slot_owners[0].0, "slot-a");
    assert_eq!(close.slot_owners[0].1, "role-a");
    assert_eq!(close.slot_owners[0].2, Some(4));
}

#[test]
fn successful_native_destroy_retires_the_stable_tab_close_fence() {
    let mut state = RuntimeState::default();
    state.optimistic_closed_tabs.insert("tab-a".to_owned());
    state.close_previews.insert(
        "tab-a".to_owned(),
        TabCloseTombstone {
            revision: 11,
            slot_owners: vec![("slot-a".to_owned(), "role-a".to_owned(), Some(3))],
            source_id: "role-a".to_owned(),
            tab_type: "role".to_owned(),
            window_id: "window-a".to_owned(),
        },
    );

    let tombstone = retire_completed_tab_close_fence(&mut state, "tab-a")
        .expect("the completed close must own its tombstone");

    assert_eq!(tombstone.window_id, "window-a");
    assert!(!state.optimistic_closed_tabs.contains("tab-a"));
    assert!(!state.close_previews.contains_key("tab-a"));
}
