/// Legacy migration fixtures reference Roles that their saved windows need;
/// schema 32 otherwise prunes those tabs as left by an earlier deletion.
fn insert_legacy_fixture_roles(connection: &Connection, role_ids: &[&str]) {
    for (ordinal, role_id) in role_ids.iter().enumerate() {
        let role = json!({
            "id": role_id, "gameId": "builtin-flyff-universe", "name": role_id,
            "launchUrl": "https://universe.flyff.com/play", "notes": "",
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"
        });
        connection
            .execute(
                "INSERT INTO roles(id, ordinal, game_id, name, payload_json)
                 VALUES (?1, ?2, 'builtin-flyff-universe', ?1, ?3)",
                params![role_id, ordinal as i64, role.to_string()],
            )
            .unwrap();
    }
}

#[test]
fn schema_thirty_two_repairs_saved_windows_left_by_earlier_deletions() {
    let connection = prune_fixture();
    // Deletions committed before deletion pruned saved Game Windows.
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM roles WHERE id='r1';
             DELETE FROM workspaces WHERE id='w2';
             PRAGMA foreign_keys=ON;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (31, 'current');",
        )
        .unwrap();
    let untouched =
        prune_saved_window(&prune_saved_windows(&connection), PRUNE_WINDOW_OTHER).clone();

    create_schema(&connection, false).unwrap();

    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                .get::<_, u32>(
                0
            ))
            .unwrap(),
        SCHEMA_VERSION
    );
    let windows = prune_saved_windows(&connection);
    let mixed = prune_saved_window(&windows, PRUNE_WINDOW_MIXED);
    assert_eq!(
        mixed
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .collect::<Vec<_>>(),
        vec![PRUNE_TAB_WORKSPACE_W1, PRUNE_TAB_ROLE_R2]
    );
    let workspace_tab = &mixed.tabs[0];
    assert_eq!(
        workspace_tab
            .role_slots
            .iter()
            .map(|slot| slot.role_id.as_str())
            .collect::<Vec<_>>(),
        vec!["r2"]
    );
    assert!(workspace_tab.workspace_slots[0].role_id.is_none());
    assert!(
        workspace_tab.workspace_slots[0]
            .browser_zoom_percent
            .is_none()
    );
    assert!(
        mixed
            .active_tab_id
            .as_deref()
            .is_some_and(|id| mixed.tabs.iter().any(|tab| tab.id == id))
    );
    assert!(
        prune_saved_window(&windows, PRUNE_WINDOW_SINGLE_ROLE)
            .tabs
            .is_empty()
    );
    assert_eq!(prune_saved_window(&windows, PRUNE_WINDOW_OTHER), &untouched);

    // A current schema leaves the repaired windows alone on the next start.
    create_schema(&connection, false).unwrap();
    assert_eq!(prune_saved_windows(&connection), windows);
}
