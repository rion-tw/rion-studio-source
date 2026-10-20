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

fn insert_schema_thirty_one_macro(
    connection: &Connection,
    id: &str,
    activation_mode: &str,
    trigger: Option<Value>,
) {
    let mut payload = json!({
        "id": id,
        "enabled": true,
        "activationMode": activation_mode,
        "name": id,
        "roleIds": [],
        "repeat": {"type":"once"},
        "steps": [{"id":"step-1","type":"delay","ms":1}],
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z"
    });
    if let Some(trigger) = trigger {
        payload["trigger"] = trigger;
    }
    let ordinal = connection
        .query_row("SELECT COUNT(*) FROM macros", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap();
    connection
        .execute(
            "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?1, ?3)",
            params![id, ordinal, serde_json::to_string(&payload).unwrap()],
        )
        .unwrap();
}

fn read_schema_thirty_one_macro(connection: &Connection, id: &str) -> String {
    connection
        .query_row("SELECT payload_json FROM macros WHERE id=?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
}

#[test]
fn schema_thirty_two_turns_a_hold_macro_without_a_trigger_into_a_press_macro() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    connection
        .execute_batch(
            "DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (31, 'current');",
        )
        .unwrap();
    let f6 = json!({"code":"F6","ctrl":false,"alt":false,"shift":false,"meta":false});
    // An upgrade through schema 26 cleared a `while_held` Macro's Ctrl/Cmd+K
    // trigger and schema 31 then renamed it to `hold`, leaving a hold Macro
    // without the shortcut every later update requires.
    insert_schema_thirty_one_macro(&connection, "null-trigger", "hold", Some(Value::Null));
    insert_schema_thirty_one_macro(&connection, "missing-trigger", "hold", None);
    insert_schema_thirty_one_macro(&connection, "held-f6", "hold", Some(f6.clone()));
    insert_schema_thirty_one_macro(&connection, "pressed", "press", Some(Value::Null));
    let untouched = ["held-f6", "pressed"].map(|id| read_schema_thirty_one_macro(&connection, id));

    create_schema(&connection, false).unwrap();

    let read = |id: &str| -> Value {
        serde_json::from_str(&read_schema_thirty_one_macro(&connection, id)).unwrap()
    };
    for id in ["null-trigger", "missing-trigger"] {
        let payload = read(id);
        assert_eq!(payload["activationMode"], "press", "{id}");
        assert!(payload["trigger"].is_null(), "{id}");
        assert_eq!(payload["enabled"], true, "{id}");
    }
    assert_eq!(read("held-f6")["trigger"], f6);
    assert_eq!(
        ["held-f6", "pressed"].map(|id| read_schema_thirty_one_macro(&connection, id)),
        untouched,
        "a hold Macro with a trigger and a press Macro are left unchanged"
    );

    // The repair is idempotent: a current schema leaves the Macros alone.
    let repaired = read_schema_thirty_one_macro(&connection, "null-trigger");
    create_schema(&connection, false).unwrap();
    assert_eq!(
        read_schema_thirty_one_macro(&connection, "null-trigger"),
        repaired
    );
}
