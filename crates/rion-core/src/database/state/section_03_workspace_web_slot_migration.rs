fn migrate_workspace_web_slots(connection: &Connection) -> CoreResult<()> {
    for (column, definition) in [
        (
            "content_kind",
            "content_kind TEXT NOT NULL DEFAULT 'empty' CHECK(content_kind IN ('empty', 'role', 'web'))",
        ),
        ("web_name", "web_name TEXT"),
        ("web_start_url", "web_start_url TEXT"),
    ] {
        if !workspace_slot_column_exists(connection, column)? {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE workspace_slots ADD COLUMN {definition};"
                ))
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    connection
        .execute(
            "UPDATE workspace_slots
               SET content_kind = CASE WHEN role_id IS NULL THEN 'empty' ELSE 'role' END
             WHERE content_kind = 'empty'",
            [],
        )
        .map(|_| ())
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn workspace_slot_column_exists(connection: &Connection, column: &str) -> CoreResult<bool> {
    let mut statement = connection
        .prepare("PRAGMA table_info(workspace_slots)")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for name in names {
        if name.map_err(|error| CoreError::StateDatabase(error.to_string()))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
