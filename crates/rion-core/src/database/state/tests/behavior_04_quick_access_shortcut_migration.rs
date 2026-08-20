fn insert_schema_twenty_five_macro(
    connection: &Connection,
    id: &str,
    name: &str,
    trigger: Value,
) {
    let payload = json!({
        "id": id,
        "enabled": true,
        "activationMode": "toggle",
        "name": name,
        "roleIds": ["role-1"],
        "shortcutSourceScope": {"type":"selected_roles","roleIds":["role-1"]},
        "trigger": trigger,
        "repeat": {"type":"count","count":3,"intervalMs":40},
        "steps": [{"type":"delay","id":"step-1","ms":25}],
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    });
    connection
        .execute(
            "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, 0, ?2, ?3)",
            params![id, name, serde_json::to_string(&payload).unwrap()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO macro_roles(macro_id, ordinal, role_id) VALUES (?1, 0, 'role-1')",
            [id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO macro_steps(macro_id, ordinal, payload_json) VALUES (?1, 0, ?2)",
            params![id, serde_json::to_string(&payload["steps"][0]).unwrap()],
        )
        .unwrap();
}

fn prepare_schema_twenty_five(connection: &Connection) {
    let role = json!({
        "id":"role-1","gameId":"builtin-flyff-universe","name":"Role 1",
        "launchUrl":"https://universe.flyff.com/play","notes":"",
        "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"
    });
    connection
        .execute(
            "INSERT INTO roles(id, ordinal, game_id, name, payload_json)
             VALUES ('role-1', 0, 'builtin-flyff-universe', 'Role 1', ?1)",
            [serde_json::to_string(&role).unwrap()],
        )
        .unwrap();
    connection
        .execute_batch(
            "DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (25, 'current');",
        )
        .unwrap();
}

#[test]
fn schema_twenty_five_clears_only_quick_access_triggers_and_preserves_macro_data() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    prepare_schema_twenty_five(&connection);
    insert_schema_twenty_five_macro(
        &connection,
        "ctrl-k",
        "Ctrl K",
        json!({"code":"KeyK","ctrl":true,"alt":false,"shift":false,"meta":false}),
    );
    insert_schema_twenty_five_macro(
        &connection,
        "meta-k",
        "Meta K",
        json!({"code":"KeyK","ctrl":false,"alt":false,"shift":false,"meta":true}),
    );
    insert_schema_twenty_five_macro(
        &connection,
        "shifted-k",
        "Shifted K",
        json!({"code":"KeyK","ctrl":true,"alt":false,"shift":true,"meta":false}),
    );

    create_schema(&connection, false).unwrap();

    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        26
    );
    for id in ["ctrl-k", "meta-k"] {
        let payload: Value = serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM macros WHERE id=?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(payload["trigger"].is_null());
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["roleIds"], json!(["role-1"]));
        assert_eq!(
            payload["shortcutSourceScope"],
            json!({"type":"selected_roles","roleIds":["role-1"]})
        );
        assert_eq!(payload["steps"][0]["ms"], 25);
    }
    let shifted: Value = serde_json::from_str(
        &connection
            .query_row(
                "SELECT payload_json FROM macros WHERE id='shifted-k'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(shifted["trigger"]["shift"], true);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM macro_roles", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM macro_steps", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        3
    );
}

#[test]
fn schema_twenty_five_quick_access_migration_rolls_back_payload_and_version() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    prepare_schema_twenty_five(&connection);
    insert_schema_twenty_five_macro(
        &connection,
        "ctrl-k",
        "Ctrl K",
        json!({"code":"KeyK","ctrl":true,"alt":false,"shift":false,"meta":false}),
    );
    connection
        .execute_batch(
            "CREATE TRIGGER reject_schema_twenty_six BEFORE INSERT ON schema_migrations
             WHEN NEW.version=26 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();

    assert!(create_schema(&connection, false).is_err());

    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        25
    );
    let payload: Value = serde_json::from_str(
        &connection
            .query_row(
                "SELECT payload_json FROM macros WHERE id='ctrl-k'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["trigger"]["code"], "KeyK");
}
