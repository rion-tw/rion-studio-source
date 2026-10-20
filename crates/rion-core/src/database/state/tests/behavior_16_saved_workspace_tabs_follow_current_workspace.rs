const FOLLOW_WINDOW: &str = "00000000-0000-4000-8000-0000000000c1";
const FOLLOW_TAB_REPLACED: &str = "00000000-0000-4000-8000-0000000000d1";
const FOLLOW_TAB_ADDED: &str = "00000000-0000-4000-8000-0000000000d2";
const FOLLOW_TAB_EMPTIED: &str = "00000000-0000-4000-8000-0000000000d3";
const FOLLOW_TAB_WEB: &str = "00000000-0000-4000-8000-0000000000d4";
const FOLLOW_TAB_ROLE_B: &str = "00000000-0000-4000-8000-0000000000d5";

fn follow_rect(x: f64, width: f64) -> Value {
    json!({ "x": x, "y": 0.0, "width": width, "height": 1.0 })
}

fn follow_workspace(id: &str, slots: Value) -> Value {
    json!({
        "id": id, "name": id, "template": "two_columns", "slots": slots,
        "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
    })
}

/// A saved Workspace tab whose layout snapshot was taken while Role `a` sat in
/// `slot-1`. The saved geometry (60/40) differs from the current Workspace
/// geometry (50/50) so a rebuilt snapshot shows which geometry it kept.
fn follow_saved_tab(id: &str, workspace_id: &str, second_role: Option<&str>) -> Value {
    let mut role_slots = vec![json!({
        "slotId": "slot-1", "roleId": "a", "rect": follow_rect(0.0, 0.6), "browserZoomPercent": 150.0
    })];
    let mut second = json!({ "id": "slot-2", "rect": follow_rect(0.6, 0.4) });
    if let Some(role_id) = second_role {
        role_slots
            .push(json!({ "slotId": "slot-2", "roleId": role_id, "rect": follow_rect(0.6, 0.4) }));
        second["roleId"] = json!(role_id);
    }
    json!({
        "id": id, "tabType": "workspace", "sourceId": workspace_id, "name": workspace_id,
        "roleSlots": role_slots,
        "workspaceSlots": [
            { "id": "slot-1", "roleId": "a", "browserZoomPercent": 150.0, "rect": follow_rect(0.0, 0.6) },
            second
        ],
        "hidden": false, "audioMuted": false
    })
}

/// Every Workspace tab references Role `a` only through its saved snapshot,
/// while each current Workspace definition was edited after the save.
fn follow_fixture() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    let role = |id: &str| {
        json!({
            "id": id, "gameId": "g1", "name": id, "launchUrl": "https://example.test/play",
            "notes": "", "createdAt": PRUNE_FIXTURE_TIMESTAMP, "updatedAt": PRUNE_FIXTURE_TIMESTAMP
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
            "roles": [role("a"), role("b"), role("c")],
            "launchWorkspaces": [
                // slot-1 was switched from Role a to Role b after the save.
                follow_workspace("w-replaced", json!([
                    { "id": "slot-1", "roleId": "b", "browserZoomPercent": 125.0, "rect": follow_rect(0.0, 0.5) },
                    { "id": "slot-2", "rect": follow_rect(0.5, 0.5) }
                ])),
                // Role b was added to slot-2 after the save.
                follow_workspace("w-added", json!([
                    { "id": "slot-1", "roleId": "a", "rect": follow_rect(0.0, 0.5) },
                    { "id": "slot-2", "roleId": "b", "rect": follow_rect(0.5, 0.5) }
                ])),
                // Role c was removed after the save, so Role a is its last content.
                follow_workspace("w-emptied", json!([
                    { "id": "slot-1", "roleId": "a", "rect": follow_rect(0.0, 0.5) },
                    { "id": "slot-2", "rect": follow_rect(0.5, 0.5) }
                ])),
                // A Web app was added to slot-2 after the save.
                follow_workspace("w-web", json!([
                    { "id": "slot-1", "roleId": "a", "rect": follow_rect(0.0, 0.5) },
                    { "id": "slot-2", "web": { "lastUrl": "https://example.test/docs" }, "browserZoomPercent": 90.0, "rect": follow_rect(0.5, 0.5) }
                ]))
            ],
            "gameWindows": [prune_window(
                FOLLOW_WINDOW,
                "Follow",
                vec![
                    follow_saved_tab(FOLLOW_TAB_REPLACED, "w-replaced", None),
                    follow_saved_tab(FOLLOW_TAB_ADDED, "w-added", None),
                    follow_saved_tab(FOLLOW_TAB_EMPTIED, "w-emptied", Some("c")),
                    follow_saved_tab(FOLLOW_TAB_WEB, "w-web", None),
                    prune_role_tab(FOLLOW_TAB_ROLE_B, "b")
                ],
                FOLLOW_TAB_EMPTIED,
            )],
            "macros": []
        }),
    )
    .unwrap();
    connection
}

fn follow_tab<'a>(window: &'a StateGameWindowRecord, id: &str) -> &'a crate::GameWindowTabRecord {
    window.tabs.iter().find(|tab| tab.id == id).unwrap()
}

fn follow_role_slots(tab: &crate::GameWindowTabRecord) -> Vec<(&str, &str)> {
    tab.role_slots
        .iter()
        .map(|slot| (slot.slot_id.as_str(), slot.role_id.as_str()))
        .collect()
}

/// Asserts the outcome shared by deleting Role `a` and by the schema 32 repair
/// of a saved window left behind by an earlier deletion of Role `a`.
fn assert_saved_workspace_tabs_follow_current_workspace(windows: &[StateGameWindowRecord]) {
    let window = prune_saved_window(windows, FOLLOW_WINDOW);
    assert_eq!(
        prune_tab_ids(window),
        vec![
            FOLLOW_TAB_REPLACED,
            FOLLOW_TAB_ADDED,
            FOLLOW_TAB_WEB,
            FOLLOW_TAB_ROLE_B
        ],
        "a Workspace tab is removed only when its current Workspace has no content left"
    );
    assert_eq!(
        window.active_tab_id.as_deref(),
        Some(FOLLOW_TAB_REPLACED),
        "the removed active tab falls back to the first remaining tab"
    );

    // The snapshot lost its only content, so it is rebuilt from the current
    // Workspace: content and zoom come from the Workspace, and every slot that
    // still exists keeps the saved geometry restore applies by slot id.
    let replaced = follow_tab(window, FOLLOW_TAB_REPLACED);
    assert_eq!(follow_role_slots(replaced), vec![("slot-1", "b")]);
    assert_eq!(
        replaced.role_slots[0].rect,
        replaced.workspace_slots[0].rect
    );
    assert_eq!(replaced.role_slots[0].browser_zoom_percent, Some(125.0));
    assert_eq!(replaced.workspace_slots[0].role_id.as_deref(), Some("b"));
    assert_eq!(replaced.workspace_slots[0].rect.width, 0.6);
    assert_eq!(replaced.workspace_slots[1].role_id, None);
    assert_eq!(replaced.workspace_slots[1].rect.x, 0.6);

    let added = follow_tab(window, FOLLOW_TAB_ADDED);
    assert_eq!(follow_role_slots(added), vec![("slot-2", "b")]);
    assert_eq!(added.workspace_slots[0].role_id, None);
    assert_eq!(added.workspace_slots[0].browser_zoom_percent, None);
    assert_eq!(added.workspace_slots[0].rect.width, 0.6);
    assert_eq!(added.workspace_slots[1].role_id.as_deref(), Some("b"));
    assert_eq!(added.workspace_slots[1].rect.x, 0.6);

    let web = follow_tab(window, FOLLOW_TAB_WEB);
    assert!(
        web.role_slots.is_empty(),
        "a Web-only Workspace keeps its tab"
    );
    assert_eq!(web.workspace_slots[0].role_id, None);
    assert_eq!(
        web.workspace_slots[1]
            .web
            .as_ref()
            .and_then(|web| web.last_url.as_deref()),
        Some("https://example.test/docs")
    );
    assert_eq!(web.workspace_slots[1].browser_zoom_percent, Some(90.0));
}

#[test]
fn role_delete_keeps_saved_workspace_tabs_whose_current_workspace_still_has_content() {
    let mut connection = follow_fixture();
    apply_domain_mutation(
        &mut connection,
        StateMutation::RoleDelete {
            id: "a".to_owned(),
            operation_id: None,
        },
    )
    .unwrap();

    assert_saved_workspace_tabs_follow_current_workspace(&prune_saved_windows(&connection));
}

#[test]
fn bulk_role_delete_keeps_saved_workspace_tabs_whose_current_workspace_still_has_content() {
    let mut connection = follow_fixture();
    apply_domain_mutation(
        &mut connection,
        StateMutation::RolesDelete {
            ids: vec!["a".to_owned()],
            operation_ids: HashMap::new(),
        },
    )
    .unwrap();

    assert_saved_workspace_tabs_follow_current_workspace(&prune_saved_windows(&connection));
}

#[test]
fn workspace_delete_removes_a_saved_workspace_tab_kept_after_its_snapshot_role_was_deleted() {
    let mut connection = follow_fixture();
    apply_domain_mutation(
        &mut connection,
        StateMutation::RoleDelete {
            id: "a".to_owned(),
            operation_id: None,
        },
    )
    .unwrap();
    apply_domain_mutation(
        &mut connection,
        StateMutation::WorkspaceDelete {
            id: "w-replaced".to_owned(),
        },
    )
    .unwrap();

    let windows = prune_saved_windows(&connection);
    assert_eq!(
        prune_tab_ids(prune_saved_window(&windows, FOLLOW_WINDOW)),
        vec![FOLLOW_TAB_ADDED, FOLLOW_TAB_WEB, FOLLOW_TAB_ROLE_B]
    );
}

#[test]
fn role_delete_succeeds_when_a_saved_window_cannot_be_pruned() {
    let mut connection = follow_fixture();
    // A stored window that no longer normalizes cannot be pruned, but it must
    // never turn deleting one of its sources into a failure.
    let mut payload = connection
        .query_row(
            "SELECT payload_json FROM game_windows WHERE id=?1",
            [FOLLOW_WINDOW],
            |row| row.get::<_, String>(0),
        )
        .map(|payload| serde_json::from_str::<Value>(&payload).unwrap())
        .unwrap();
    payload["placement"]["savedWorkArea"]["width"] = json!(0);
    connection
        .execute(
            "UPDATE game_windows SET payload_json=?1 WHERE id=?2",
            params![payload.to_string(), FOLLOW_WINDOW],
        )
        .unwrap();

    apply_domain_mutation(
        &mut connection,
        StateMutation::RoleDelete {
            id: "a".to_owned(),
            operation_id: None,
        },
    )
    .unwrap();

    assert!(
        connection
            .query_row("SELECT COUNT(*) FROM roles WHERE id='a'", [], |row| row
                .get::<_, u32>(0))
            .unwrap()
            == 0
    );
    let stored = connection
        .query_row(
            "SELECT payload_json FROM game_windows WHERE id=?1",
            [FOLLOW_WINDOW],
            |row| row.get::<_, String>(0),
        )
        .map(|payload| serde_json::from_str::<Value>(&payload).unwrap())
        .unwrap();
    assert_eq!(stored, payload, "the unprunable window is left unchanged");
}

#[test]
fn role_delete_removes_a_workspace_tab_whose_rebuilt_snapshot_is_invalid() {
    let mut connection = follow_fixture();
    // Workspace slot ids are not deduplicated, while a saved Game Window
    // snapshot requires unique slot ids: such a Workspace cannot back a
    // rebuilt snapshot, so its tab falls back to removal instead of failing.
    let mut workspace = connection
        .query_row(
            "SELECT payload_json FROM workspaces WHERE id='w-replaced'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|payload| serde_json::from_str::<Value>(&payload).unwrap())
        .unwrap();
    workspace["slots"][1]["id"] = json!("slot-1");
    connection
        .execute(
            "UPDATE workspaces SET payload_json=?1 WHERE id='w-replaced'",
            [workspace.to_string()],
        )
        .unwrap();

    apply_domain_mutation(
        &mut connection,
        StateMutation::RoleDelete {
            id: "a".to_owned(),
            operation_id: None,
        },
    )
    .unwrap();

    let windows = prune_saved_windows(&connection);
    let window = prune_saved_window(&windows, FOLLOW_WINDOW);
    assert_eq!(
        prune_tab_ids(window),
        vec![FOLLOW_TAB_ADDED, FOLLOW_TAB_WEB, FOLLOW_TAB_ROLE_B]
    );
    assert_eq!(
        follow_role_slots(follow_tab(window, FOLLOW_TAB_ADDED)),
        vec![("slot-2", "b")]
    );
}

#[test]
fn schema_thirty_two_keeps_saved_workspace_tabs_whose_current_workspace_still_has_content() {
    let connection = follow_fixture();
    // An earlier deletion removed Role a and cleared it from the Workspaces
    // but left the saved Game Window snapshots referencing it.
    for workspace_id in ["w-added", "w-emptied", "w-web"] {
        let mut workspace = connection
            .query_row(
                "SELECT payload_json FROM workspaces WHERE id=?1",
                [workspace_id],
                |row| row.get::<_, String>(0),
            )
            .map(|payload| serde_json::from_str::<Value>(&payload).unwrap())
            .unwrap();
        workspace["slots"][0]
            .as_object_mut()
            .unwrap()
            .remove("roleId");
        connection
            .execute(
                "UPDATE workspaces SET payload_json=?1 WHERE id=?2",
                params![workspace.to_string(), workspace_id],
            )
            .unwrap();
    }
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM roles WHERE id='a';
             PRAGMA foreign_keys=ON;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (31, 'current');",
        )
        .unwrap();

    create_schema(&connection, false).unwrap();

    let windows = prune_saved_windows(&connection);
    assert_saved_workspace_tabs_follow_current_workspace(&windows);
    create_schema(&connection, false).unwrap();
    assert_eq!(prune_saved_windows(&connection), windows);
}

#[test]
fn schema_thirty_two_removes_saved_workspace_tabs_whose_workspace_is_empty_or_deleted() {
    let connection = follow_fixture();
    // Role a is gone while the Workspace definitions still reference it, and
    // Workspace w-web was deleted outright.
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM roles WHERE id='a';
             DELETE FROM workspaces WHERE id='w-web';
             PRAGMA foreign_keys=ON;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (31, 'current');",
        )
        .unwrap();

    create_schema(&connection, false).unwrap();

    let windows = prune_saved_windows(&connection);
    let window = prune_saved_window(&windows, FOLLOW_WINDOW);
    assert_eq!(
        prune_tab_ids(window),
        vec![FOLLOW_TAB_REPLACED, FOLLOW_TAB_ADDED, FOLLOW_TAB_ROLE_B],
        "the emptied and the deleted Workspace tabs are removed"
    );
    assert_eq!(
        follow_role_slots(follow_tab(window, FOLLOW_TAB_REPLACED)),
        vec![("slot-1", "b")]
    );
    let added = follow_tab(window, FOLLOW_TAB_ADDED);
    assert_eq!(follow_role_slots(added), vec![("slot-2", "b")]);
    assert_eq!(
        added.workspace_slots[0].role_id, None,
        "a missing Role left in the Workspace definition is not restored into the snapshot"
    );
}

#[test]
fn schema_thirty_two_leaves_a_window_unchanged_when_a_workspace_tab_source_does_not_decode() {
    let connection = follow_fixture();
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM roles WHERE id='a';
             UPDATE workspaces SET payload_json='{\"id\":\"w-replaced\"}' WHERE id='w-replaced';
             PRAGMA foreign_keys=ON;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (31, 'current');",
        )
        .unwrap();
    let before = prune_saved_windows(&connection);

    create_schema(&connection, false).unwrap();

    // Without the current definition the repair cannot tell whether the tab
    // still restores content, so it neither removes nor rewrites the window.
    assert_eq!(prune_saved_windows(&connection), before);
}
