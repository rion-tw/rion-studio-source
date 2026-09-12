fn insert_schema_thirty_macro(connection: &Connection, id: &str, activation_mode: Option<&str>) {
    let mut payload = json!({
        "id": id,
        "enabled": true,
        "name": id,
        "roleIds": [],
        "repeat": {"type":"once"},
        "steps": [{"id":"step-1","type":"delay","ms":1}],
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    });
    if let Some(mode) = activation_mode {
        payload["activationMode"] = json!(mode);
    }
    if activation_mode == Some("while_held") {
        payload["trigger"] =
            json!({"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false});
    }
    connection
        .execute(
            "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?1, ?3)",
            params![id, connection.query_row("SELECT COUNT(*) FROM macros", [], |row| {
                row.get::<_, u32>(0)
            }).unwrap(), serde_json::to_string(&payload).unwrap()],
        )
        .unwrap();
}

fn prepare_schema_thirty(connection: &Connection) {
    create_schema(connection, false).unwrap();
    connection
        .execute_batch(
            "DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (30, 'current');",
        )
        .unwrap();
}

#[test]
fn schema_thirty_one_normalizes_every_legacy_macro_activation_mode() {
    let connection = Connection::open_in_memory().unwrap();
    prepare_schema_thirty(&connection);
    insert_schema_thirty_macro(&connection, "missing", None);
    insert_schema_thirty_macro(&connection, "toggle", Some("toggle"));
    insert_schema_thirty_macro(&connection, "held", Some("while_held"));

    create_schema(&connection, false).unwrap();

    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    for (id, expected) in [("missing", "press"), ("toggle", "press"), ("held", "hold")] {
        let payload: Value = serde_json::from_str(
            &connection
                .query_row("SELECT payload_json FROM macros WHERE id=?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["activationMode"], expected);
    }
}

#[test]
fn schema_thirty_one_rolls_back_payloads_when_version_commit_fails() {
    let connection = Connection::open_in_memory().unwrap();
    prepare_schema_thirty(&connection);
    insert_schema_thirty_macro(&connection, "legacy", Some("toggle"));
    connection
        .execute_batch(
            "CREATE TRIGGER reject_schema_thirty_one BEFORE INSERT ON schema_migrations
             WHEN NEW.version=31 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();

    assert!(create_schema(&connection, false).is_err());

    let payload: Value = serde_json::from_str(
        &connection
            .query_row("SELECT payload_json FROM macros WHERE id='legacy'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["activationMode"], "toggle");
    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        30
    );
}
