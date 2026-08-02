fn migrate_flyff_local_storage_sync_selectors(connection: &Connection) -> CoreResult<()> {
    let payload = connection
        .query_row(
            "SELECT payload_json FROM games WHERE id='builtin-flyff-universe'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let Some(payload) = payload else {
        return Ok(());
    };
    let mut value: Value = serde_json::from_str(&payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| CoreError::StateDatabase("stored Flyff game is invalid".to_owned()))?;
    let mut migrated = false;
    let mut migrated_settings = false;
    if let Some(keys) = object
        .get_mut("localStorageSyncKeys")
        .and_then(Value::as_array_mut)
    {
        let previous_len = keys.len();
        migrated_settings = keys
            .iter()
            .any(|key| key.as_str() == Some("game_client_settings"));
        keys.retain(|key| {
            !matches!(
                key.as_str(),
                Some("game_client_settings" | "game_client_sessions")
            )
        });
        migrated = keys.len() != previous_len;
    }
    if migrated_settings {
        object.insert(
            "localStorageSyncSelectors".to_owned(),
            json!(crate::domain::FLYFF_LOCAL_STORAGE_SYNC_SELECTORS),
        );
    }
    if migrated {
        let payload = serde_json::to_string(&value)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        connection
            .execute(
                "UPDATE games SET payload_json=?1 WHERE id='builtin-flyff-universe'",
                [payload],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn migrate_flyff_china_local_storage_sync_selectors(
    connection: &Connection,
) -> CoreResult<()> {
    let payload = connection
        .query_row(
            "SELECT payload_json FROM games WHERE id='builtin-feifei-infinite-universe'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let Some(payload) = payload else {
        return Ok(());
    };
    let mut value: Value = serde_json::from_str(&payload)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let object = value.as_object_mut().ok_or_else(|| {
        CoreError::StateDatabase("stored Flyff China game is invalid".to_owned())
    })?;
    let mut migrated = false;
    if let Some(keys) = object
        .get_mut("localStorageSyncKeys")
        .and_then(Value::as_array_mut)
    {
        let previous_len = keys.len();
        keys.retain(|key| {
            !matches!(
                key.as_str(),
                Some("game_client_settings" | "game_client_sessions")
            )
        });
        migrated = keys.len() != previous_len;
    }
    let selectors_need_default = object
        .get("localStorageSyncSelectors")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if selectors_need_default {
        object.insert(
            "localStorageSyncSelectors".to_owned(),
            json!(crate::domain::FLYFF_CHINA_LOCAL_STORAGE_SYNC_SELECTORS),
        );
        migrated = true;
    }
    if migrated {
        let payload = serde_json::to_string(&value)
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        connection
            .execute(
                "UPDATE games SET payload_json=?1 WHERE id='builtin-feifei-infinite-universe'",
                [payload],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}
