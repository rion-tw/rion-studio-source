fn read_overlay_configuration(
    connection: &Connection,
) -> CoreResult<(Vec<MacroDefinition>, MacroBadgePositionRecord)> {
    let (macros, _) = read_macro_configuration(connection)?;
    let settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .map(|payload| {
            serde_json::from_str::<GameBrowserSettingsRecord>(&payload).map_err(|error| {
                CoreError::StateDatabase(format!(
                    "stored game browser settings are invalid: {error}"
                ))
            })
        })
        .transpose()?
        .unwrap_or_else(default_game_browser_settings);
    Ok((macros, settings.macro_badge_position))
}

fn recover_sqlite_portable_import(
    connection: &mut Connection,
    user_data_dir: &Path,
) -> CoreResult<bool> {
    let Some(plan) = portable_recovery::load(user_data_dir)? else {
        return Ok(false);
    };
    let mut snapshot = read_snapshot(connection)?;
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| CoreError::StateDatabase("state snapshot must be an object".to_owned()))?;
    object.extend(plan.snapshot_fields);
    replace_snapshot(connection, &snapshot)?;
    portable_recovery::finish(user_data_dir, &plan.remove_created_role_ids)?;
    Ok(true)
}

pub(super) fn create_schema(connection: &Connection, runtime: bool) -> CoreResult<()> {
    let schema_table_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .is_some();
    let current_version = if schema_table_exists {
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, Option<u32>>(0)
            })
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?
            .unwrap_or(0)
    } else {
        0
    };
    let user_table_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if current_version == 0 && user_table_count > 0 {
        return Err(CoreError::UnsupportedDataVersion(
            "the state database predates supported schema 19".to_owned(),
        ));
    }
    if current_version != 0 && !(19..=SCHEMA_VERSION).contains(&current_version) {
        return Err(CoreError::UnsupportedDataVersion(format!(
            "SQLite schema {current_version} is unsupported; only schemas 19 through {SCHEMA_VERSION} are accepted"
        )));
    }

    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute_batch(if runtime {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;

    if (19..=24).contains(&current_version) {
        connection
            .execute_batch("BEGIN IMMEDIATE;")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        let migration = (|| {
            if current_version == 19 {
                connection
                    .execute_batch(
                        "DROP TABLE IF EXISTS legacy_session_restores;
                         INSERT INTO schema_migrations(version, applied_at)
                         VALUES (20, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));",
                    )
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            if current_version <= 22 {
                migrate_retired_role_storage_sync(connection)?;
                connection
                    .execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (23, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        [],
                    )
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            if current_version <= 23 {
                migrate_macro_shortcut_source_scopes(connection)?;
                connection
                    .execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (24, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        [],
                    )
                    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
            }
            migrate_game_window_role_slots(connection)?;
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    [],
                )
                .map(|_| ())
                .map_err(|error| CoreError::StateDatabase(error.to_string()))
        })();
        if let Err(error) = migration {
            let _ = connection.execute_batch("ROLLBACK;");
            return Err(error);
        }
        connection
            .execute_batch("COMMIT;")
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    } else if current_version == 0 {
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   applied_at TEXT NOT NULL
                 );
                 CREATE TABLE metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 );
                 CREATE TABLE state_revision (
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   revision INTEGER NOT NULL CHECK(revision >= 0)
                 );
                 INSERT INTO state_revision(singleton, revision) VALUES (1, 0);
                 CREATE TABLE games (
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE game_images (
                   game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                   field TEXT NOT NULL CHECK(field IN ('iconImageDataUrl', 'coverImageDataUrl')),
                   mime TEXT NOT NULL,
                   data BLOB NOT NULL,
                   PRIMARY KEY(game_id, field)
                 );
                 CREATE TABLE roles (
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                   name TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE role_images (
                   role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                   field TEXT NOT NULL CHECK(field = 'coverImageDataUrl'),
                   mime TEXT NOT NULL,
                   data BLOB NOT NULL,
                   PRIMARY KEY(role_id, field)
                 );
                 CREATE INDEX roles_game_id_idx ON roles(game_id, ordinal);
                 CREATE TABLE workspaces (
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE workspace_slots (
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                   ordinal INTEGER NOT NULL,
                   role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
                   payload_json TEXT NOT NULL,
                   PRIMARY KEY(workspace_id, ordinal)
                 );
                 CREATE INDEX workspace_slots_role_idx ON workspace_slots(role_id);
                 CREATE TABLE game_windows (
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   name TEXT NOT NULL COLLATE NOCASE,
                   payload_json TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX game_windows_name_unique_idx ON game_windows(name COLLATE NOCASE);
                 CREATE TABLE macros (
                   id TEXT PRIMARY KEY,
                   ordinal INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE macro_roles (
                   macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
                   ordinal INTEGER NOT NULL,
                   role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                   PRIMARY KEY(macro_id, ordinal)
                 );
                 CREATE INDEX macro_roles_role_idx ON macro_roles(role_id);
                 CREATE TABLE macro_steps (
                   macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
                   ordinal INTEGER NOT NULL,
                   payload_json TEXT NOT NULL,
                   PRIMARY KEY(macro_id, ordinal)
                 );
                 CREATE TABLE settings (
                   key TEXT PRIMARY KEY,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE legal_acceptance (
                   singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE operation_journal (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL,
                   phase TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE INDEX operation_journal_kind_phase_idx ON operation_journal(kind, phase);
                 INSERT INTO schema_migrations(version, applied_at)
                 VALUES (25, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
                 COMMIT;",
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        seed_builtin_games(connection)?;
        repair_required_settings(connection)?;
    }
    repair_optional_log_level(connection)?;
    Ok(())
}

fn seed_builtin_games(connection: &Connection) -> CoreResult<()> {
    let timestamp = chrono::Utc::now().to_rfc3339();
    for (ordinal, (id, key, name, launch_url)) in [
        (
            "builtin-flyff-universe",
            "flyff-universe",
            "Flyff Universe",
            "https://universe.flyff.com/play",
        ),
        (
            "builtin-feifei-infinite-universe",
            "feifei-infinite-universe",
            "飞飞：无限宇宙",
            "https://ffcli.ruiwoo.cn/",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let payload = serde_json::to_string(&json!({
            "id": id,
            "source": "builtin",
            "builtinKey": key,
            "name": name,
            "defaultLaunchUrl": launch_url,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        connection
            .execute(
                "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, ordinal as i64, name, payload],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn repair_optional_log_level(connection: &Connection) -> CoreResult<()> {
    let payload = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='logLevel'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if payload
        .as_deref()
        .is_some_and(|payload| serde_json::from_str::<LogLevel>(payload).is_err())
    {
        connection
            .execute("DELETE FROM settings WHERE key='logLevel'", [])
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn repair_required_settings(connection: &Connection) -> CoreResult<()> {
    let browser_settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<GameBrowserSettingsRecord>(&payload).ok())
        .map(normalize_game_browser_settings)
        .unwrap_or_else(default_game_browser_settings);
    let macro_settings = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='macroSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<MacroSettingsRecord>(&payload).ok())
        .map(normalize_macro_settings)
        .unwrap_or_else(default_macro_settings);
    let window_preferences = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='runtimeWindowPreferences'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|payload| serde_json::from_str::<RuntimeWindowPreferencesRecord>(&payload).ok())
        .unwrap_or_else(default_runtime_window_preferences);
    for (key, payload) in [
        (
            "gameBrowserSettings",
            serde_json::to_string(&browser_settings)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
        (
            "macroSettings",
            serde_json::to_string(&macro_settings)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
        (
            "runtimeWindowPreferences",
            serde_json::to_string(&window_preferences)
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?,
        ),
    ] {
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                params![key, payload],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

pub(super) fn read_snapshot(connection: &Connection) -> CoreResult<Value> {
    let mut object = Map::new();
    object.insert("games".to_owned(), read_payloads(connection, "games")?);
    object.insert("roles".to_owned(), read_payloads(connection, "roles")?);
    object.insert(
        "launchWorkspaces".to_owned(),
        read_payloads(connection, "workspaces")?,
    );
    object.insert("macros".to_owned(), read_payloads(connection, "macros")?);
    object.insert(
        "gameWindows".to_owned(),
        read_payloads(connection, "game_windows")?,
    );
    let mut statement = connection
        .prepare("SELECT key, payload_json FROM settings ORDER BY key")
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for row in rows {
        let (key, payload) = row.map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        object.insert(key, parse_payload(&payload)?);
    }
    if let Some(payload) = connection
        .query_row(
            "SELECT payload_json FROM legal_acceptance WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
    {
        object.insert("legalAcceptance".to_owned(), parse_payload(&payload)?);
    }
    Ok(Value::Object(object))
}

fn read_scalar(connection: &Connection, key: &str) -> CoreResult<Option<Value>> {
    let payload = if key == "legalAcceptance" {
        connection
            .query_row(
                "SELECT payload_json FROM legal_acceptance WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
    } else if matches!(
        key,
        "gameBrowserSettings"
            | "macroSettings"
            | "runtimeWindowPreferences"
            | "runtimeRestoreSession"
            | "logLevel"
    ) {
        connection
            .query_row(
                "SELECT payload_json FROM settings WHERE key=?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
    } else {
        return Err(CoreError::InvalidInput(format!(
            "scalar state key is invalid: {key}"
        )));
    }
    .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    payload.map(|payload| parse_payload(&payload)).transpose()
}

fn collection_table(collection: &str) -> CoreResult<(&'static str, &'static str)> {
    match collection {
        "games" => Ok(("games", "id")),
        "roles" => Ok(("roles", "id")),
        "launchWorkspaces" => Ok(("workspaces", "id")),
        "gameWindows" => Ok(("game_windows", "id")),
        "macros" => Ok(("macros", "id")),
        _ => Err(CoreError::InvalidInput(format!(
            "state collection is invalid: {collection}"
        ))),
    }
}

fn read_collection(connection: &Connection, collection: &str) -> CoreResult<Value> {
    let (table, _) = collection_table(collection)?;
    read_payloads(connection, table)
}

fn read_typed_collection<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    collection: &str,
) -> CoreResult<Vec<T>> {
    serde_json::from_value(read_collection(connection, collection)?).map_err(|error| {
        CoreError::StateDatabase(format!("stored {collection} are invalid: {error}"))
    })
}

fn read_record(connection: &Connection, collection: &str, id: &str) -> CoreResult<Option<Value>> {
    let (table, id_column) = collection_table(collection)?;
    let sql = format!("SELECT payload_json FROM {table} WHERE {id_column}=?1");
    let payload = connection
        .query_row(&sql, params![id], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let mut value = parse_payload(&payload)?;
    if matches!(table, "games" | "roles") {
        restore_entity_images(connection, table, std::slice::from_mut(&mut value))?;
    }
    Ok(Some(value))
}

fn read_payloads(connection: &Connection, table: &str) -> CoreResult<Value> {
    let sql = format!("SELECT payload_json FROM {table} ORDER BY ordinal");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let mut values = rows
        .map(|row| {
            row.map_err(|error| CoreError::StateDatabase(error.to_string()))
                .and_then(|payload| parse_payload(&payload))
        })
        .collect::<CoreResult<Vec<_>>>()?;
    if matches!(table, "games" | "roles") {
        restore_entity_images(connection, table, &mut values)?;
    }
    Ok(Value::Array(values))
}

pub(super) fn replace_snapshot(connection: &mut Connection, snapshot: &Value) -> CoreResult<u64> {
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    replace_snapshot_transaction(&transaction, snapshot)?;
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(revision)
}

fn replace_snapshot_if_changed(
    connection: &mut Connection,
    snapshot: &Value,
) -> CoreResult<(u64, bool)> {
    if read_snapshot(connection)? == *snapshot {
        return Ok((read_revision(connection)?, false));
    }
    Ok((replace_snapshot(connection, snapshot)?, true))
}

fn replace_scalar(connection: &mut Connection, key: &str, value: Value) -> CoreResult<u64> {
    if !matches!(
        key,
        "gameBrowserSettings"
            | "macroSettings"
            | "runtimeWindowPreferences"
            | "runtimeRestoreSession"
            | "legalAcceptance"
            | "logLevel"
    ) {
        return Err(CoreError::InvalidInput(format!(
            "scalar state key is invalid: {key}"
        )));
    }
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if key == "legalAcceptance" {
        transaction
            .execute(
                "INSERT INTO legal_acceptance(singleton, payload_json) VALUES (1, ?1)
                 ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json",
                params![serialize_payload(&value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    } else {
        transaction
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json",
                params![key, serialize_payload(&value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    let revision = increment_revision(&transaction)?;
    transaction
        .commit()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(revision)
}

fn replace_snapshot_transaction(transaction: &Transaction<'_>, snapshot: &Value) -> CoreResult<()> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| CoreError::InvalidInput("state snapshot must be an object".to_owned()))?;
    validate_macro_graph(array_field(object, "macros")?)?;
    transaction
        .execute_batch(
            "
            DELETE FROM workspace_slots;
            DELETE FROM workspaces;
            DELETE FROM game_windows;
            DELETE FROM macro_steps;
            DELETE FROM macro_roles;
            DELETE FROM macros;
            DELETE FROM role_images;
            DELETE FROM roles;
            DELETE FROM game_images;
            DELETE FROM games;
            DELETE FROM settings;
            DELETE FROM legal_acceptance;
            ",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    insert_entities(transaction, "games", array_field(object, "games")?)?;
    insert_entities(transaction, "roles", array_field(object, "roles")?)?;
    insert_workspaces(transaction, array_field(object, "launchWorkspaces")?)?;
    let game_windows = object
        .get("gameWindows")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    validate_game_window_collection(
        &game_windows
            .iter()
            .cloned()
            .map(serde_json::from_value)
            .collect::<Result<Vec<StateGameWindowRecord>, _>>()
            .map_err(|error| CoreError::InvalidInput(format!("invalid game windows: {error}")))?,
    )?;
    insert_game_windows(transaction, game_windows)?;
    insert_macros(transaction, array_field(object, "macros")?)?;
    for key in [
        "gameBrowserSettings",
        "macroSettings",
        "runtimeWindowPreferences",
        "runtimeRestoreSession",
        "logLevel",
    ] {
        if let Some(value) = object.get(key) {
            transaction
                .execute(
                    "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)",
                    params![key, serialize_payload(value)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
    if let Some(value) = object.get("legalAcceptance") {
        transaction
            .execute(
                "INSERT INTO legal_acceptance(singleton, payload_json) VALUES (1, ?1)",
                params![serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    let hash = snapshot_hash(snapshot)?;
    let row_count = [
        "games",
        "roles",
        "launchWorkspaces",
        "gameWindows",
        "macros",
    ]
    .into_iter()
    .map(|key| array_field(object, key).map(<[Value]>::len))
    .try_fold(0_usize, |total, count| {
        count.map(|count| total.saturating_add(count))
    })?;
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('snapshot_sha256', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![hash],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('snapshot_row_count', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![row_count.to_string()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

fn insert_entities(transaction: &Transaction<'_>, table: &str, values: &[Value]) -> CoreResult<()> {
    let sql = match table {
        "games" => "INSERT INTO games(id, ordinal, name, payload_json) VALUES (?1, ?2, ?3, ?4)",
        "roles" => {
            "INSERT INTO roles(id, ordinal, game_id, name, payload_json) VALUES (?1, ?2, ?3, ?4, ?5)"
        }
        _ => return Err(CoreError::Internal("invalid entity table".to_owned())),
    };
    let mut statement = transaction
        .prepare(sql)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, table)?;
        let id = required_string(object, "id", table)?;
        let name = required_string(object, "name", table)?;
        let (payload, images) = split_entity_images(table, value)?;
        if table == "games" {
            statement.execute(params![
                id,
                ordinal as i64,
                name,
                serialize_payload(&payload)?
            ])
        } else {
            let game_id = object.get("gameId").and_then(Value::as_str).unwrap_or("");
            statement.execute(params![
                id,
                ordinal as i64,
                game_id,
                name,
                serialize_payload(&payload)?
            ])
        }
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        insert_entity_images(transaction, table, id, images)?;
    }
    Ok(())
}
