fn remove_retired_storage_fields(value: &mut Value, fields: &[&str]) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    fields
        .iter()
        .filter(|field| object.remove(**field).is_some())
        .count()
        > 0
}

fn migrate_retired_role_storage_sync(connection: &Connection) -> CoreResult<()> {
    for (table, fields) in [
        (
            "games",
            ["localStorageSyncKeys", "localStorageSyncSelectors"].as_slice(),
        ),
        ("roles", ["localStorageSourceRoleId"].as_slice()),
    ] {
        let sql = format!("SELECT id, payload_json FROM {table}");
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        drop(statement);

        for (id, payload) in rows {
            let mut value: Value = serde_json::from_str(&payload)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            if !remove_retired_storage_fields(&mut value, fields) {
                continue;
            }
            let payload = serde_json::to_string(&value)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            connection
                .execute(
                    &format!("UPDATE {table} SET payload_json=?1 WHERE id=?2"),
                    params![payload, id],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn migrate_macro_shortcut_source_scopes(connection: &Connection) -> CoreResult<()> {
    let mut statement = connection
        .prepare("SELECT id, payload_json FROM macros")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    drop(statement);

    for (id, payload) in rows {
        let mut value: Value = serde_json::from_str(&payload)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let object = value.as_object_mut().ok_or_else(|| {
            CoreError::StateDatabase("stored macro payload must be an object".to_owned())
        })?;
        if object.contains_key("shortcutSourceScope") {
            continue;
        }
        object.insert(
            "shortcutSourceScope".to_owned(),
            serde_json::json!({ "type": "all_execution_roles" }),
        );
        let payload = serde_json::to_string(&value)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        connection
            .execute(
                "UPDATE macros SET payload_json=?1 WHERE id=?2",
                params![payload, id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}
