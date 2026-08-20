struct EntityImage {
    field: String,
    mime: String,
    data: Vec<u8>,
}

fn split_entity_images(table: &str, value: &Value) -> CoreResult<(Value, Vec<EntityImage>)> {
    let mut payload = value.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| CoreError::InvalidInput(format!("{table} must be an object")))?;
    let fields: &[&str] = match table {
        "games" => &["iconImageDataUrl", "coverImageDataUrl"],
        "roles" => &["coverImageDataUrl"],
        _ => &[],
    };
    let mut images = Vec::new();
    for field in fields {
        let Some(value) = object.remove(*field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let data_url = value.as_str().ok_or_else(|| {
            CoreError::InvalidInput(format!("{table}.{field} must be an image data URL"))
        })?;
        let (mime, encoded) = data_url.split_once(";base64,").ok_or_else(|| {
            CoreError::InvalidInput(format!("{table}.{field} must be an image data URL"))
        })?;
        if !matches!(
            mime,
            "data:image/png"
                | "data:image/jpeg"
                | "data:image/jpg"
                | "data:image/webp"
                | "data:image/gif"
        ) {
            return Err(CoreError::InvalidInput(format!(
                "{table}.{field} uses an unsupported image MIME type"
            )));
        }
        let data = BASE64.decode(encoded).map_err(|error| {
            CoreError::InvalidInput(format!("{table}.{field} has invalid base64: {error}"))
        })?;
        images.push(EntityImage {
            field: (*field).to_owned(),
            mime: mime.trim_start_matches("data:").to_owned(),
            data,
        });
    }
    Ok((payload, images))
}

fn insert_entity_images(
    transaction: &Transaction<'_>,
    table: &str,
    id: &str,
    images: Vec<EntityImage>,
) -> CoreResult<()> {
    let (image_table, id_column) = match table {
        "games" => ("game_images", "game_id"),
        "roles" => ("role_images", "role_id"),
        _ => return Ok(()),
    };
    let sql = format!(
        "INSERT INTO {image_table}({id_column}, field, mime, data) VALUES (?1, ?2, ?3, ?4)"
    );
    let mut statement = transaction
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for image in images {
        statement
            .execute(params![id, image.field, image.mime, image.data])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn restore_entity_images(
    connection: &Connection,
    table: &str,
    values: &mut [Value],
) -> CoreResult<()> {
    let (image_table, id_column) = match table {
        "games" => ("game_images", "game_id"),
        "roles" => ("role_images", "role_id"),
        _ => return Ok(()),
    };
    let mut by_id = HashMap::<String, usize>::new();
    for (index, value) in values.iter().enumerate() {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_owned(), index);
        }
    }
    let sql = format!(
        "SELECT {id_column}, field, mime, data FROM {image_table} ORDER BY {id_column}, field"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (id, field, mime, data) =
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let Some(index) = by_id.get(&id).copied() else {
            continue;
        };
        let object = values[index].as_object_mut().ok_or_else(|| {
            CoreError::StateDatabase("entity payload must be an object".to_owned())
        })?;
        object.insert(
            field,
            Value::String(format!("data:{mime};base64,{}", BASE64.encode(data))),
        );
    }
    Ok(())
}

fn insert_workspaces(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "workspace")?;
        let id = required_string(object, "id", "workspace")?;
        let name = required_string(object, "name", "workspace")?;
        transaction
            .execute(
                "INSERT INTO workspaces(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, ordinal as i64, name, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let slots = object
            .get("slots")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidInput(format!("workspace {id} has invalid slots")))?;
        for (slot_ordinal, slot) in slots.iter().enumerate() {
            let role_id = slot.get("roleId").and_then(Value::as_str);
            let web = slot.get("web").and_then(Value::as_object);
            let content_kind = if role_id.is_some() {
                "role"
            } else if web.is_some() {
                "web"
            } else {
                "empty"
            };
            transaction
                .execute(
                    "INSERT INTO workspace_slots(
                       workspace_id, ordinal, role_id, content_kind, web_name, web_start_url, payload_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        id,
                        slot_ordinal as i64,
                        role_id,
                        content_kind,
                        web.and_then(|value| value.get("name")).and_then(Value::as_str),
                        web.and_then(|value| value.get("startUrl")).and_then(Value::as_str),
                        serialize_payload(slot)?
                    ],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn insert_game_windows(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        upsert_game_window(transaction, value, ordinal)?;
    }
    Ok(())
}

fn upsert_game_window(
    transaction: &Transaction<'_>,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, "game window")?;
    let id = required_string(object, "id", "game window")?;
    let name = required_string(object, "name", "game window")?;
    transaction
        .execute(
            "INSERT INTO game_windows(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn insert_macros(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "macro")?;
        let id = required_string(object, "id", "macro")?;
        let name = required_string(object, "name", "macro")?;
        transaction
            .execute(
                "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, ordinal as i64, name, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let role_ids = object
            .get("roleIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (role_ordinal, role_id) in role_ids.iter().enumerate() {
            let role_id = role_id.as_str().ok_or_else(|| {
                CoreError::InvalidInput(format!("macro {id} contains an invalid role id"))
            })?;
            transaction
                .execute(
                    "INSERT INTO macro_roles(macro_id, ordinal, role_id) VALUES (?1, ?2, ?3)",
                    params![id, role_ordinal as i64, role_id],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
        let steps = object
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidInput(format!("macro {id} has invalid steps")))?;
        for (step_ordinal, step) in steps.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO macro_steps(macro_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                    params![id, step_ordinal as i64, serialize_payload(step)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    Ok(())
}

fn upsert_entity(
    transaction: &Transaction<'_>,
    table: &str,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, table)?;
    let id = required_string(object, "id", table)?;
    let name = required_string(object, "name", table)?;
    let (payload, images) = split_entity_images(table, value)?;
    match table {
        "games" => transaction.execute(
            "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(&payload)?],
        ),
        "roles" => transaction.execute(
            "INSERT INTO roles(id, ordinal, game_id, name, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, game_id=excluded.game_id,
               name=excluded.name, payload_json=excluded.payload_json",
            params![
                id,
                ordinal as i64,
                object.get("gameId").and_then(Value::as_str).unwrap_or(""),
                name,
                serialize_payload(&payload)?
            ],
        ),
        _ => return Err(CoreError::Internal("invalid entity table".to_owned())),
    }
    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let (image_table, id_column) = if table == "games" {
        ("game_images", "game_id")
    } else {
        ("role_images", "role_id")
    };
    transaction
        .execute(
            &format!("DELETE FROM {image_table} WHERE {id_column}=?1"),
            params![id],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    insert_entity_images(transaction, table, id, images)
}

fn upsert_workspace(
    transaction: &Transaction<'_>,
    value: &Value,
    ordinal: usize,
) -> CoreResult<()> {
    let object = entity_object(value, "workspace")?;
    let id = required_string(object, "id", "workspace")?;
    let name = required_string(object, "name", "workspace")?;
    transaction
        .execute(
            "INSERT INTO workspaces(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute(
            "DELETE FROM workspace_slots WHERE workspace_id=?1",
            params![id],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (slot_ordinal, slot) in object
        .get("slots")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidInput(format!("workspace {id} has invalid slots")))?
        .iter()
        .enumerate()
    {
        let role_id = slot.get("roleId").and_then(Value::as_str);
        let web = slot.get("web").and_then(Value::as_object);
        let content_kind = if role_id.is_some() {
            "role"
        } else if web.is_some() {
            "web"
        } else {
            "empty"
        };
        transaction
            .execute(
                "INSERT INTO workspace_slots(
                   workspace_id, ordinal, role_id, content_kind, web_name, web_start_url, payload_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    slot_ordinal as i64,
                    role_id,
                    content_kind,
                    web.and_then(|value| value.get("name")).and_then(Value::as_str),
                    web.and_then(|value| value.get("startUrl")).and_then(Value::as_str),
                    serialize_payload(slot)?
                ],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn upsert_macro(transaction: &Transaction<'_>, value: &Value, ordinal: usize) -> CoreResult<()> {
    let object = entity_object(value, "macro")?;
    let id = required_string(object, "id", "macro")?;
    let name = required_string(object, "name", "macro")?;
    transaction
        .execute(
            "INSERT INTO macros(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, name=excluded.name,
               payload_json=excluded.payload_json",
            params![id, ordinal as i64, name, serialize_payload(value)?],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute("DELETE FROM macro_roles WHERE macro_id=?1", params![id])
        .and_then(|_| transaction.execute("DELETE FROM macro_steps WHERE macro_id=?1", params![id]))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (role_ordinal, role_id) in object
        .get("roleIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let role_id = role_id.as_str().ok_or_else(|| {
            CoreError::InvalidInput(format!("macro {id} contains an invalid role id"))
        })?;
        transaction
            .execute(
                "INSERT INTO macro_roles(macro_id, ordinal, role_id) VALUES (?1, ?2, ?3)",
                params![id, role_ordinal as i64, role_id],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    for (step_ordinal, step) in object
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::InvalidInput(format!("macro {id} has invalid steps")))?
        .iter()
        .enumerate()
    {
        transaction
            .execute(
                "INSERT INTO macro_steps(macro_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                params![id, step_ordinal as i64, serialize_payload(step)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn sync_workspaces(
    transaction: &Transaction<'_>,
    workspaces: &[crate::model::StateLaunchWorkspaceRecord],
) -> CoreResult<()> {
    for (ordinal, workspace) in workspaces.iter().enumerate() {
        upsert_workspace(transaction, &json_value(workspace)?, ordinal)?;
    }
    Ok(())
}

fn sync_macros(transaction: &Transaction<'_>, macros: &[StateMacroRecord]) -> CoreResult<()> {
    for (ordinal, macro_record) in macros.iter().enumerate() {
        upsert_macro(transaction, &json_value(macro_record)?, ordinal)?;
    }
    Ok(())
}

fn update_ordinals(transaction: &Transaction<'_>, table: &str, ids: &[String]) -> CoreResult<()> {
    if !matches!(table, "roles" | "workspaces" | "game_windows") {
        return Err(CoreError::Internal("invalid ordinal table".to_owned()));
    }
    let sql = format!("UPDATE {table} SET ordinal=?1 WHERE id=?2");
    for (ordinal, id) in ids.iter().enumerate() {
        transaction
            .execute(&sql, params![ordinal as i64, id])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn json_value(value: &impl serde::Serialize) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::Internal(error.to_string()))
}

fn increment_revision(transaction: &Transaction<'_>) -> CoreResult<u64> {
    let current = transaction
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .unwrap_or(0)
        .max(0) as u64;
    let next = current.saturating_add(1);
    transaction
        .execute(
            "INSERT INTO state_revision(singleton, revision) VALUES (1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision",
            params![i64::try_from(next).unwrap_or(i64::MAX)],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(next)
}

fn read_revision(connection: &Connection) -> CoreResult<u64> {
    connection
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|revision| revision.max(0) as u64)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn read_metadata(connection: &Connection) -> CoreResult<Value> {
    let mut values = Map::new();
    let mut statement = connection
        .prepare("SELECT key, value FROM metadata ORDER BY key")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (key, value) = row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        values.insert(key, Value::String(value));
    }
    let revision = connection
        .query_row(
            "SELECT revision FROM state_revision WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    values.insert("revision".to_owned(), Value::String(revision.to_string()));
    values.insert("schemaVersion".to_owned(), json!(SCHEMA_VERSION));
    Ok(Value::Object(values))
}

fn array_field<'a>(object: &'a Map<String, Value>, key: &str) -> CoreResult<&'a [Value]> {
    match object.get(key) {
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| CoreError::InvalidInput(format!("{key} must be an array"))),
        None => Ok(&[]),
    }
}

fn entity_object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::InvalidInput(format!("{label} must be an object")))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> CoreResult<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CoreError::InvalidInput(format!("{label} requires {key}")))
}

fn serialize_payload(value: &Value) -> CoreResult<String> {
    serde_json::to_string(value).map_err(|error| CoreError::InvalidInput(error.to_string()))
}

fn parse_payload(value: &str) -> CoreResult<Value> {
    serde_json::from_str(value).map_err(|error| CoreError::StateDatabase(error.to_string()))
}

fn snapshot_hash(snapshot: &Value) -> CoreResult<String> {
    let serialized = serialize_payload(snapshot)?;
    Ok(format!("{:x}", Sha256::digest(serialized.as_bytes())))
}
