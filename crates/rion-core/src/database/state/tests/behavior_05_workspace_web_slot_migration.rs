#[test]
fn workspace_web_slot_columns_migrate_and_store_last_url() {
    {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspace_slots (
                   workspace_id TEXT NOT NULL,
                   ordinal INTEGER NOT NULL,
                   role_id TEXT,
                   payload_json TEXT NOT NULL
                 );
                 INSERT INTO workspace_slots VALUES ('workspace-1', 0, 'role-1', '{}');
                 INSERT INTO workspace_slots VALUES ('workspace-1', 1, NULL, '{}');",
            )
            .unwrap();
        migrate_workspace_web_slots(&connection).unwrap();
        let kinds = connection
            .prepare("SELECT content_kind FROM workspace_slots ORDER BY ordinal")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(kinds, vec!["role", "empty"]);
    }

    {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let transaction = connection.transaction().unwrap();
        insert_workspaces(
            &transaction,
            &[json!({
                "id":"workspace-web",
                "name":"Video",
                "template":"single",
                "slots":[{
                    "id":"slot-1",
                    "web":{"lastUrl":"https://www.youtube.com/watch?v=1"},
                    "rect":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}
                }],
                "createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z"
            })],
        )
        .unwrap();
        transaction.commit().unwrap();
        let stored = connection
            .query_row(
                "SELECT content_kind, web_last_url FROM workspace_slots",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                "web".to_owned(),
                "https://www.youtube.com/watch?v=1".to_owned()
            )
        );
    }
}

#[test]
fn schema_29_resets_legacy_workspace_and_saved_window_web_urls() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(
        "PRAGMA foreign_keys=OFF;
         CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
         INSERT INTO schema_migrations VALUES (29, '2026-01-01T00:00:00Z');
         CREATE TABLE roles(id TEXT PRIMARY KEY);
         CREATE TABLE workspaces(id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, name TEXT NOT NULL, payload_json TEXT NOT NULL);
         CREATE TABLE game_windows(id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, name TEXT NOT NULL, payload_json TEXT NOT NULL);
         CREATE TABLE macros(id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, name TEXT NOT NULL, payload_json TEXT NOT NULL);
         CREATE TABLE settings(key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
         CREATE TABLE workspace_slots(
           workspace_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role_id TEXT,
           content_kind TEXT NOT NULL, web_name TEXT, web_start_url TEXT,
           payload_json TEXT NOT NULL, PRIMARY KEY(workspace_id, ordinal)
         );
         INSERT INTO workspaces VALUES (
           'workspace-1', 0, 'Legacy',
           '{\"id\":\"workspace-1\",\"name\":\"Legacy\",\"template\":\"single\",\"slots\":[{\"id\":\"slot-1\",\"web\":{\"name\":\"Old\",\"startUrl\":\"https://old.example/\"},\"rect\":{\"x\":0.0,\"y\":0.0,\"width\":1.0,\"height\":1.0}}],\"createdAt\":\"2026-01-01T00:00:00Z\",\"updatedAt\":\"2026-01-01T00:00:00Z\"}'
         );
         INSERT INTO workspace_slots VALUES (
           'workspace-1', 0, NULL, 'web', 'Old', 'https://old.example/',
           '{\"id\":\"slot-1\",\"web\":{\"name\":\"Old\",\"startUrl\":\"https://old.example/\"},\"rect\":{\"x\":0.0,\"y\":0.0,\"width\":1.0,\"height\":1.0}}'
         );
         INSERT INTO game_windows VALUES (
           'window-1', 0, 'Saved',
           '{\"id\":\"window-1\",\"name\":\"Saved\",\"targetDisplay\":{\"id\":1},\"placement\":{\"normalBounds\":{\"x\":0,\"y\":0,\"width\":800,\"height\":600},\"savedWorkArea\":{\"x\":0,\"y\":0,\"width\":800,\"height\":600},\"presentation\":\"normal\"},\"tabs\":[{\"id\":\"tab-1\",\"tabType\":\"workspace\",\"sourceId\":\"workspace-1\",\"name\":\"Legacy\",\"roleSlots\":[],\"workspaceSlots\":[{\"id\":\"slot-1\",\"web\":{\"name\":\"Old\",\"startUrl\":\"https://old.example/\"},\"rect\":{\"x\":0.0,\"y\":0.0,\"width\":1.0,\"height\":1.0}}],\"hidden\":false,\"audioMuted\":false}],\"createdAt\":\"2026-01-01T00:00:00Z\",\"updatedAt\":\"2026-01-01T00:00:00Z\"}'
         );"
    ).unwrap();

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
    let workspace: Value = serde_json::from_str(
        &connection
            .query_row(
                "SELECT payload_json FROM workspaces WHERE id='workspace-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    let window: Value = serde_json::from_str(
        &connection
            .query_row(
                "SELECT payload_json FROM game_windows WHERE id='window-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(workspace["slots"][0]["web"], json!({}));
    assert_eq!(window["tabs"][0]["workspaceSlots"][0]["web"], json!({}));
    assert_eq!(
        connection
            .query_row("SELECT web_last_url FROM workspace_slots", [], |row| row
                .get::<_, Option<
                String,
            >>(
                0
            ))
            .unwrap(),
        None
    );
}
