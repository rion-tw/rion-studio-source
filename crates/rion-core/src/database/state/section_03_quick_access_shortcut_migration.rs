fn migrate_reserved_quick_access_shortcuts(connection: &Connection) -> CoreResult<()> {
    let rows = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM macros ORDER BY ordinal")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    };
    for (macro_id, payload_json) in rows {
        let mut payload = parse_payload(&payload_json)?;
        if !payload
            .get("trigger")
            .is_some_and(is_legacy_quick_access_trigger)
        {
            continue;
        }
        payload["trigger"] = Value::Null;
        connection
            .execute(
                "UPDATE macros SET payload_json=?1 WHERE id=?2",
                params![serialize_payload(&payload)?, macro_id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn is_legacy_quick_access_trigger(trigger: &Value) -> bool {
    let Some(trigger) = trigger.as_object() else {
        return false;
    };
    trigger.get("code").and_then(Value::as_str) == Some("KeyK")
        && trigger.get("alt").and_then(Value::as_bool) == Some(false)
        && trigger.get("shift").and_then(Value::as_bool) == Some(false)
        && matches!(
            (
                trigger.get("ctrl").and_then(Value::as_bool),
                trigger.get("meta").and_then(Value::as_bool),
            ),
            (Some(true), Some(false)) | (Some(false), Some(true))
        )
}
