#[test]
fn workspace_web_slot_columns_migrate_and_store_normalized_identity() {
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
                    "web":{"name":"YouTube","startUrl":"https://www.youtube.com/"},
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
                "SELECT content_kind, web_name, web_start_url FROM workspace_slots",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                "web".to_owned(),
                "YouTube".to_owned(),
                "https://www.youtube.com/".to_owned()
            )
        );
    }
}
