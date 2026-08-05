#[test]
fn drag_cursor_lease_requires_the_exact_session_and_window_generation() {
    let lease = TabDragCursorLease {
        session_id: "drag-new".to_owned(),
        window_generation: 7,
    };

    assert!(tab_drag_cursor_lease_matches(&lease, "drag-new", 7));
    assert!(!tab_drag_cursor_lease_matches(&lease, "drag-old", 7));
    assert!(!tab_drag_cursor_lease_matches(&lease, "drag-new", 8));
}

#[test]
fn closing_workspace_fences_its_roles_but_not_unrelated_launcher_sources() {
    let close = TabCloseTombstone {
        revision: 10,
        role_ids: vec!["role-a".to_owned(), "role-b".to_owned()],
        slot_owners: vec![("slot-a".to_owned(), "role-a".to_owned(), Some(4))],
        source_id: "workspace-a".to_owned(),
        tab_type: "workspace".to_owned(),
        window_id: "window-a".to_owned(),
    };

    assert!(tab_close_matches_launcher_source(
        &close,
        "workspace-a",
        "workspace"
    ));
    assert!(tab_close_matches_launcher_source(&close, "role-a", "role"));
    assert!(tab_close_matches_launcher_source(&close, "role-b", "role"));
    assert!(!tab_close_matches_launcher_source(
        &close,
        "workspace-b",
        "workspace"
    ));
    assert!(!tab_close_matches_launcher_source(&close, "role-c", "role"));
}

#[test]
fn successful_native_destroy_retires_the_stable_tab_close_fence() {
    let mut state = RuntimeState::default();
    state.optimistic_closed_tabs.insert("tab-a".to_owned());
    state.close_previews.insert(
        "tab-a".to_owned(),
        TabCloseTombstone {
            revision: 11,
            role_ids: vec!["role-a".to_owned()],
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
