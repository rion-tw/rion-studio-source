fn migrate_workspace_web_navigation_state(connection: &Connection) -> CoreResult<()> {
    let workspace_payloads = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM workspaces ORDER BY ordinal")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    };
    for (id, payload) in workspace_payloads {
        let mut value = parse_payload(&payload)?;
        reset_legacy_workspace_web_slots(&mut value, false);
        connection
            .execute(
                "UPDATE workspaces SET payload_json=?1 WHERE id=?2",
                params![serialize_payload(&value)?, id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }

    let game_window_payloads = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM game_windows ORDER BY ordinal")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    };
    for (id, payload) in game_window_payloads {
        let mut value = parse_payload(&payload)?;
        reset_legacy_workspace_web_slots(&mut value, true);
        connection
            .execute(
                "UPDATE game_windows SET payload_json=?1 WHERE id=?2",
                params![serialize_payload(&value)?, id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }

    connection
        .execute_batch(
            "DROP INDEX IF EXISTS workspace_slots_role_idx;
             DROP TABLE workspace_slots;
             CREATE TABLE workspace_slots (
               workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
               content_kind TEXT NOT NULL DEFAULT 'empty' CHECK(content_kind IN ('empty', 'role', 'web')),
               web_last_url TEXT,
               payload_json TEXT NOT NULL,
               PRIMARY KEY(workspace_id, ordinal)
             );
             CREATE INDEX workspace_slots_role_idx ON workspace_slots(role_id);",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;

    let workspaces = read_payloads(connection, "workspaces")?;
    let values = workspaces
        .as_array()
        .ok_or_else(|| CoreError::StateDatabase("stored workspaces are invalid".to_owned()))?;
    for value in values {
        let object = entity_object(value, "workspace")?;
        let workspace_id = required_string(object, "id", "workspace")?;
        let slots = object
            .get("slots")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CoreError::StateDatabase("stored workspace slots are invalid".to_owned())
            })?;
        for (ordinal, slot) in slots.iter().enumerate() {
            let role_id = slot.get("roleId").and_then(Value::as_str);
            let stored_role_id = match role_id {
                Some(role_id) if stored_role_exists(connection, role_id)? => Some(role_id),
                _ => None,
            };
            let web = slot.get("web").and_then(Value::as_object);
            let content_kind = if role_id.is_some() {
                "role"
            } else if web.is_some() {
                "web"
            } else {
                "empty"
            };
            connection.execute(
                "INSERT INTO workspace_slots(workspace_id, ordinal, role_id, content_kind, web_last_url, payload_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![workspace_id, ordinal as i64, stored_role_id, content_kind,
                    web.and_then(|web| web.get("lastUrl")).and_then(Value::as_str),
                    serialize_payload(slot)?],
            ).map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn stored_role_exists(connection: &Connection, role_id: &str) -> CoreResult<bool> {
    connection
        .query_row("SELECT 1 FROM roles WHERE id=?1", [role_id], |_| Ok(()))
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn reset_legacy_workspace_web_slots(value: &mut Value, game_window: bool) {
    let slot_arrays = if game_window {
        value
            .get_mut("tabs")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
            .filter_map(|tab| tab.get_mut("workspaceSlots").and_then(Value::as_array_mut))
            .collect::<Vec<_>>()
    } else {
        value
            .get_mut("slots")
            .and_then(Value::as_array_mut)
            .into_iter()
            .collect::<Vec<_>>()
    };
    for slots in slot_arrays {
        for slot in slots {
            if let Some(slot) = slot.as_object_mut()
                && slot.get("web").is_some_and(Value::is_object)
            {
                slot.insert("web".to_owned(), json!({}));
            }
        }
    }
}
