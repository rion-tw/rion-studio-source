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
        parent_operation_id: None,
        revision: 10,
        retirement_revision: Some(5),
        slot_owners: vec![("slot-a".to_owned(), "role-a".to_owned(), Some(4))],
        source_id: "workspace-a".to_owned(),
        tab_type: "workspace".to_owned(),
        window_id: "window-a".to_owned(),
    };

    assert_eq!(close.slot_owners[0].0, "slot-a");
    assert_eq!(close.slot_owners[0].1, "role-a");
    assert_eq!(close.slot_owners[0].2, Some(4));
    assert_eq!(close.retirement_revision, Some(5));
}

#[test]
fn delayed_host_retirement_is_fenced_by_the_latest_reopen_revision() {
    assert!(window_retirement_revision_is_current(7, Some(7)));
    assert!(!window_retirement_revision_is_current(8, Some(7)));
    assert!(window_retirement_revision_is_current(8, None));
}

#[test]
fn optional_divider_hydration_stops_at_every_close_or_topology_fence() {
    assert!(optional_divider_hydration_can_continue(
        true, true, false, false, true,
    ));
    assert!(!optional_divider_hydration_can_continue(
        false, true, false, false, true,
    ));
    assert!(!optional_divider_hydration_can_continue(
        true, false, false, false, true,
    ));
    assert!(!optional_divider_hydration_can_continue(
        true, true, true, false, true,
    ));
    assert!(!optional_divider_hydration_can_continue(
        true, true, false, true, true,
    ));
    assert!(!optional_divider_hydration_can_continue(
        true, true, false, false, false,
    ));
}

#[test]
fn immediate_relaunch_waits_for_the_previous_stable_tab_generation() {
    let mut runtime_state = RuntimeState::default();
    runtime_state.close_previews.insert(
        "tab-a".to_owned(),
        TabCloseTombstone {
            parent_operation_id: None,
            revision: 12,
            retirement_revision: Some(9),
            slot_owners: Vec::new(),
            source_id: "workspace-a".to_owned(),
            tab_type: "workspace".to_owned(),
            window_id: "window-a".to_owned(),
        },
    );
    runtime_state
        .close_coordinator
        .closing_tabs
        .insert("tab-a".to_owned());
    let state = Arc::new(Mutex::new(runtime_state));
    let changed = Arc::new(Condvar::new());
    let release_state = Arc::clone(&state);
    let release_changed = Arc::clone(&changed);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(10));
        let mut state = release_state.lock().unwrap();
        state.close_previews.remove("tab-a");
        state.close_coordinator.closing_tabs.remove("tab-a");
        drop(state);
        release_changed.notify_all();
    });

    assert!(wait_for_tab_close_fence(
        &state,
        &changed,
        "tab-a",
        Duration::from_millis(250),
    ));
    release.join().unwrap();
}

#[test]
fn immediate_relaunch_fences_retiring_roles_even_when_the_new_tab_id_differs() {
    let role_ids = HashSet::from(["role-a".to_owned(), "role-b".to_owned()]);
    let mut state = RuntimeState::default();
    state
        .role_tabs
        .insert("role-a".to_owned(), "closed-tab".to_owned());
    state
        .role_tabs
        .insert("role-b".to_owned(), "closed-tab".to_owned());
    state
        .close_coordinator
        .closing_roles
        .insert("role-a".to_owned());

    assert_eq!(
        role_relaunch_fence_state(&state, &HashSet::from(["new-tab".to_owned()]), &role_ids),
        RoleRelaunchFenceState::Pending
    );
}

#[test]
fn a_role_owned_by_another_live_tab_remains_a_shared_slot_instead_of_a_close_fence() {
    let role_ids = HashSet::from(["role-a".to_owned()]);
    let mut state = RuntimeState::default();
    state
        .role_tabs
        .insert("role-a".to_owned(), "live-tab".to_owned());

    assert_eq!(
        role_relaunch_fence_state(
            &state,
            &HashSet::from(["live-tab".to_owned()]),
            &role_ids,
        ),
        RoleRelaunchFenceState::Ready
    );
}

#[test]
fn an_unverified_old_role_surface_fails_closed_instead_of_becoming_a_placeholder() {
    let role_ids = HashSet::from(["role-a".to_owned()]);
    let mut state = RuntimeState::default();
    state
        .close_coordinator
        .quarantined_roles
        .insert("role-a".to_owned());

    assert_eq!(
        role_relaunch_fence_state(&state, &HashSet::new(), &role_ids),
        RoleRelaunchFenceState::Quarantined
    );
}

#[test]
fn successful_native_destroy_retires_the_stable_tab_close_fence() {
    let mut state = RuntimeState::default();
    state.optimistic_closed_tabs.insert("tab-a".to_owned());
    state.close_previews.insert(
        "tab-a".to_owned(),
        TabCloseTombstone {
            parent_operation_id: None,
            revision: 11,
            retirement_revision: Some(6),
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
