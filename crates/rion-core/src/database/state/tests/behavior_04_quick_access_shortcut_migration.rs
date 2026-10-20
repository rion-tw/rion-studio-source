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
             DROP TABLE role_session_migrations;
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
        SCHEMA_VERSION
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

#[test]
fn schema_twenty_five_turns_a_hold_quick_access_macro_into_a_press_macro() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    prepare_schema_twenty_five(&connection);
    insert_schema_twenty_five_macro(
        &connection,
        "hold-k",
        "Hold K",
        json!({"code":"KeyK","ctrl":true,"alt":false,"shift":false,"meta":false}),
    );
    let read_payload = |connection: &Connection| -> Value {
        serde_json::from_str(
            &connection
                .query_row(
                    "SELECT payload_json FROM macros WHERE id='hold-k'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap()
    };
    let mut payload = read_payload(&connection);
    payload["activationMode"] = json!("hold");
    connection
        .execute(
            "UPDATE macros SET payload_json=?1 WHERE id='hold-k'",
            [serde_json::to_string(&payload).unwrap()],
        )
        .unwrap();

    create_schema(&connection, false).unwrap();

    let payload = read_payload(&connection);
    assert!(payload["trigger"].is_null());
    assert_eq!(payload["activationMode"], "press");
}

fn read_schema_twenty_five_macro(connection: &Connection, id: &str) -> Value {
    serde_json::from_str(
        &connection
            .query_row("SELECT payload_json FROM macros WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
    )
    .unwrap()
}

fn set_schema_twenty_five_activation_mode(connection: &Connection, id: &str, mode: &str) {
    let mut payload = read_schema_twenty_five_macro(connection, id);
    payload["activationMode"] = json!(mode);
    connection
        .execute(
            "UPDATE macros SET payload_json=?1 WHERE id=?2",
            params![serde_json::to_string(&payload).unwrap(), id],
        )
        .unwrap();
}

#[test]
fn schema_twenty_five_turns_a_while_held_quick_access_macro_into_a_press_macro() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    prepare_schema_twenty_five(&connection);
    insert_schema_twenty_five_macro(
        &connection,
        "held-k",
        "Held K",
        json!({"code":"KeyK","ctrl":true,"alt":false,"shift":false,"meta":false}),
    );
    // Schema 25 stored the hold activation as `while_held`; `hold` is the
    // schema 31 name.
    set_schema_twenty_five_activation_mode(&connection, "held-k", "while_held");

    create_schema(&connection, false).unwrap();

    let payload = read_schema_twenty_five_macro(&connection, "held-k");
    assert!(payload["trigger"].is_null());
    assert_eq!(payload["activationMode"], "press");
}

#[test]
fn schema_twenty_six_quick_access_migration_turns_a_while_held_macro_into_a_press_macro() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    prepare_schema_twenty_five(&connection);
    insert_schema_twenty_five_macro(
        &connection,
        "held-k",
        "Held K",
        json!({"code":"KeyK","ctrl":false,"alt":false,"shift":false,"meta":true}),
    );
    set_schema_twenty_five_activation_mode(&connection, "held-k", "while_held");

    migrate_reserved_quick_access_shortcuts(&connection).unwrap();

    let payload = read_schema_twenty_five_macro(&connection, "held-k");
    assert!(payload["trigger"].is_null());
    assert_eq!(
        payload["activationMode"], "press",
        "the schema 26 step sees the activation name schema 25 stored"
    );
}

