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
