const PRUNE_WINDOW_MIXED: &str = "00000000-0000-4000-8000-0000000000a1";
const PRUNE_WINDOW_SINGLE_ROLE: &str = "00000000-0000-4000-8000-0000000000a2";
const PRUNE_WINDOW_OTHER: &str = "00000000-0000-4000-8000-0000000000a3";
const PRUNE_TAB_ROLE_R1: &str = "00000000-0000-4000-8000-0000000000b1";
const PRUNE_TAB_WORKSPACE_W1: &str = "00000000-0000-4000-8000-0000000000b2";
const PRUNE_TAB_WORKSPACE_W2: &str = "00000000-0000-4000-8000-0000000000b3";
const PRUNE_TAB_ROLE_R2: &str = "00000000-0000-4000-8000-0000000000b4";
const PRUNE_TAB_SINGLE_R1: &str = "00000000-0000-4000-8000-0000000000b5";
const PRUNE_TAB_WORKSPACE_W3: &str = "00000000-0000-4000-8000-0000000000b6";
const PRUNE_TAB_ROLE_R3: &str = "00000000-0000-4000-8000-0000000000b7";
const PRUNE_FIXTURE_TIMESTAMP: &str = "2026-01-01T00:00:00Z";

fn prune_rect(x: f64, width: f64) -> Value {
    json!({ "x": x, "y": 0.0, "width": width, "height": 1.0 })
}

fn prune_role_tab(id: &str, role_id: &str) -> Value {
    json!({
        "id": id, "tabType": "role", "sourceId": role_id, "name": role_id,
        "roleSlots": [{ "slotId": format!("role:{role_id}"), "roleId": role_id, "rect": prune_rect(0.0, 1.0) }],
        "hidden": false, "audioMuted": false
    })
}

fn prune_window(id: &str, name: &str, tabs: Vec<Value>, active_tab_id: &str) -> Value {
    json!({
        "id": id, "name": name, "targetDisplay": { "id": 1 },
        "placement": {
            "normalBounds": { "x": 0, "y": 0, "width": 1280, "height": 720 },
            "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
            "presentation": "normal"
        },
        "tabs": tabs, "activeTabId": active_tab_id,
        "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
    })
}

fn prune_fixture() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    let role = |id: &str| {
        json!({
            "id": id, "gameId": "g1", "name": id, "launchUrl": "https://example.test/play",
            "notes": "", "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
        })
    };
    let single_workspace = |id: &str, role_id: &str| {
        json!({
            "id": id, "name": id, "template": "single",
            "slots": [{ "id": "slot-1", "roleId": role_id, "rect": prune_rect(0.0, 1.0) }],
            "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
        })
    };
    let single_workspace_tab = |id: &str, workspace_id: &str, role_id: &str| {
        json!({
            "id": id, "tabType": "workspace", "sourceId": workspace_id, "name": workspace_id,
            "roleSlots": [{ "slotId": "slot-1", "roleId": role_id, "rect": prune_rect(0.0, 1.0) }],
            "workspaceSlots": [{ "id": "slot-1", "roleId": role_id, "rect": prune_rect(0.0, 1.0) }],
            "hidden": false, "audioMuted": false
        })
    };
    replace_snapshot(
        &mut connection,
        &json!({
            "games": [{
                "id": "g1", "source": "custom", "name": "Game",
                "defaultLaunchUrl": "https://example.test/play", "browserLaunchMode": "inherit",
                "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
            }],
            "roles": [role("r1"), role("r2"), role("r3")],
            "launchWorkspaces": [
                {
                    "id": "w1", "name": "w1", "template": "two_columns",
                    "slots": [
                        { "id": "slot-1", "roleId": "r1", "browserZoomPercent": 150.0, "rect": prune_rect(0.0, 0.5) },
                        { "id": "slot-2", "roleId": "r2", "rect": prune_rect(0.5, 0.5) }
                    ],
                    "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
                },
                single_workspace("w2", "r1"),
                single_workspace("w3", "r3")
            ],
            "gameWindows": [
                prune_window(
                    PRUNE_WINDOW_MIXED,
                    "Mixed",
                    vec![
                        prune_role_tab(PRUNE_TAB_ROLE_R1, "r1"),
                        json!({
                            "id": PRUNE_TAB_WORKSPACE_W1, "tabType": "workspace", "sourceId": "w1", "name": "w1",
                            "roleSlots": [
                                { "slotId": "slot-1", "roleId": "r1", "rect": prune_rect(0.0, 0.5), "browserZoomPercent": 150.0 },
                                { "slotId": "slot-2", "roleId": "r2", "rect": prune_rect(0.5, 0.5) }
                            ],
                            "workspaceSlots": [
                                { "id": "slot-1", "roleId": "r1", "browserZoomPercent": 150.0, "rect": prune_rect(0.0, 0.5) },
                                { "id": "slot-2", "roleId": "r2", "rect": prune_rect(0.5, 0.5) }
                            ],
                            "hidden": false, "audioMuted": false
                        }),
                        single_workspace_tab(PRUNE_TAB_WORKSPACE_W2, "w2", "r1"),
                        prune_role_tab(PRUNE_TAB_ROLE_R2, "r2")
                    ],
                    PRUNE_TAB_ROLE_R1,
                ),
                prune_window(
                    PRUNE_WINDOW_SINGLE_ROLE,
                    "Single role",
                    vec![prune_role_tab(PRUNE_TAB_SINGLE_R1, "r1")],
                    PRUNE_TAB_SINGLE_R1,
                ),
                prune_window(
                    PRUNE_WINDOW_OTHER,
                    "Other",
                    vec![
                        single_workspace_tab(PRUNE_TAB_WORKSPACE_W3, "w3", "r3"),
                        prune_role_tab(PRUNE_TAB_ROLE_R3, "r3")
                    ],
                    PRUNE_TAB_WORKSPACE_W3,
                )
            ],
            "macros": []
        }),
    )
    .unwrap();
    connection
}

fn prune_saved_windows(connection: &Connection) -> Vec<StateGameWindowRecord> {
    let windows = read_typed_collection::<StateGameWindowRecord>(connection, "gameWindows").unwrap();
    // Every saved window must stay restorable under the same domain rules
    // that admitted it, including after its deleted sources are pruned.
    validate_game_window_collection(&windows).unwrap();
    windows
}

fn prune_saved_window<'a>(
    windows: &'a [StateGameWindowRecord],
    id: &str,
) -> &'a StateGameWindowRecord {
    windows.iter().find(|window| window.id == id).unwrap()
}

fn assert_prune_announces_game_windows(mutation: &StateMutation) {
    assert!(
        mutation
            .changed_collections()
            .iter()
            .any(|collection| matches!(collection, StateCollection::GameWindows)),
        "source deletion must announce the saved Game Window change"
    );
}

fn prune_tab_ids(window: &StateGameWindowRecord) -> Vec<&str> {
    window.tabs.iter().map(|tab| tab.id.as_str()).collect()
}

#[test]
fn role_delete_prunes_saved_game_window_tabs_that_reference_the_role() {
    let mut connection = prune_fixture();
    let before = prune_saved_windows(&connection);
    let mutation = StateMutation::RoleDelete {
        id: "r1".to_owned(),
        operation_id: None,
    };
    assert_prune_announces_game_windows(&mutation);
    apply_domain_mutation(&mut connection, mutation).unwrap();

    let windows = prune_saved_windows(&connection);
    let mixed = prune_saved_window(&windows, PRUNE_WINDOW_MIXED);
    assert_eq!(
        prune_tab_ids(mixed),
        vec![PRUNE_TAB_WORKSPACE_W1, PRUNE_TAB_ROLE_R2],
        "the deleted role tab and the tab of the Workspace left without content are removed"
    );
    assert_eq!(mixed.active_tab_id.as_deref(), Some(PRUNE_TAB_WORKSPACE_W1));
    let workspace_tab = &mixed.tabs[0];
    assert_eq!(workspace_tab.role_slots.len(), 1);
    assert_eq!(workspace_tab.role_slots[0].role_id, "r2");
    assert_eq!(workspace_tab.workspace_slots[0].role_id, None);
    assert_eq!(
        workspace_tab.workspace_slots[0].browser_zoom_percent, None,
        "a slot emptied by role deletion keeps no zoom"
    );
    assert_eq!(workspace_tab.workspace_slots[1].role_id.as_deref(), Some("r2"));
    assert_ne!(mixed.updated_at, PRUNE_FIXTURE_TIMESTAMP);

    let single = prune_saved_window(&windows, PRUNE_WINDOW_SINGLE_ROLE);
    assert!(single.tabs.is_empty(), "an emptied saved window is retained");
    assert_eq!(single.active_tab_id, None);

    assert_eq!(
        prune_saved_window(&windows, PRUNE_WINDOW_OTHER),
        prune_saved_window(&before, PRUNE_WINDOW_OTHER),
        "windows without the deleted role are untouched"
    );
}

#[test]
fn bulk_role_delete_prunes_every_deleted_role_from_saved_game_windows() {
    let mut connection = prune_fixture();
    let before = prune_saved_windows(&connection);
    let mutation = StateMutation::RolesDelete {
        ids: vec!["r2".to_owned(), "r3".to_owned(), "missing".to_owned()],
        operation_ids: HashMap::new(),
    };
    assert_prune_announces_game_windows(&mutation);
    let result = apply_domain_mutation(&mut connection, mutation).unwrap();
    assert_eq!(result["value"]["deletedIds"], json!(["r2", "r3"]));

    let windows = prune_saved_windows(&connection);
    let mixed = prune_saved_window(&windows, PRUNE_WINDOW_MIXED);
    assert_eq!(
        prune_tab_ids(mixed),
        vec![PRUNE_TAB_ROLE_R1, PRUNE_TAB_WORKSPACE_W1, PRUNE_TAB_WORKSPACE_W2]
    );
    assert_eq!(mixed.active_tab_id.as_deref(), Some(PRUNE_TAB_ROLE_R1));
    let workspace_tab = &mixed.tabs[1];
    assert_eq!(workspace_tab.role_slots.len(), 1);
    assert_eq!(workspace_tab.role_slots[0].role_id, "r1");
    assert_eq!(workspace_tab.role_slots[0].browser_zoom_percent, Some(150.0));
    assert_eq!(workspace_tab.workspace_slots[1].role_id, None);

    let other = prune_saved_window(&windows, PRUNE_WINDOW_OTHER);
    assert!(other.tabs.is_empty());
    assert_eq!(other.active_tab_id, None);

    assert_eq!(
        prune_saved_window(&windows, PRUNE_WINDOW_SINGLE_ROLE),
        prune_saved_window(&before, PRUNE_WINDOW_SINGLE_ROLE)
    );
}

#[test]
fn workspace_delete_prunes_saved_game_window_tabs_for_the_workspace() {
    let mut connection = prune_fixture();
    let before = prune_saved_windows(&connection);
    let mutation = StateMutation::WorkspaceDelete {
        id: "w1".to_owned(),
    };
    assert_prune_announces_game_windows(&mutation);
    apply_domain_mutation(&mut connection, mutation).unwrap();

    let windows = prune_saved_windows(&connection);
    let mixed = prune_saved_window(&windows, PRUNE_WINDOW_MIXED);
    assert_eq!(
        prune_tab_ids(mixed),
        vec![PRUNE_TAB_ROLE_R1, PRUNE_TAB_WORKSPACE_W2, PRUNE_TAB_ROLE_R2]
    );
    assert_eq!(mixed.active_tab_id.as_deref(), Some(PRUNE_TAB_ROLE_R1));
    for id in [PRUNE_WINDOW_SINGLE_ROLE, PRUNE_WINDOW_OTHER] {
        assert_eq!(
            prune_saved_window(&windows, id),
            prune_saved_window(&before, id)
        );
    }
}

#[test]
fn bulk_workspace_delete_prunes_saved_game_window_tabs_and_moves_the_active_tab() {
    let mut connection = prune_fixture();
    let before = prune_saved_windows(&connection);
    let mutation = StateMutation::WorkspacesDelete {
        ids: vec!["w2".to_owned(), "w3".to_owned()],
    };
    assert_prune_announces_game_windows(&mutation);
    apply_domain_mutation(&mut connection, mutation).unwrap();

    let windows = prune_saved_windows(&connection);
    let mixed = prune_saved_window(&windows, PRUNE_WINDOW_MIXED);
    assert_eq!(
        prune_tab_ids(mixed),
        vec![PRUNE_TAB_ROLE_R1, PRUNE_TAB_WORKSPACE_W1, PRUNE_TAB_ROLE_R2]
    );
    let other = prune_saved_window(&windows, PRUNE_WINDOW_OTHER);
    assert_eq!(prune_tab_ids(other), vec![PRUNE_TAB_ROLE_R3]);
    assert_eq!(
        other.active_tab_id.as_deref(),
        Some(PRUNE_TAB_ROLE_R3),
        "the removed active tab falls back to the first remaining tab"
    );
    assert_eq!(
        prune_saved_window(&windows, PRUNE_WINDOW_SINGLE_ROLE),
        prune_saved_window(&before, PRUNE_WINDOW_SINGLE_ROLE)
    );
}
