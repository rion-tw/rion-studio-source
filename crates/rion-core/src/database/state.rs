use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crossbeam_channel::{Receiver, Sender, bounded};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::macro_graph::validate_macro_graph;

const SCHEMA_VERSION: u32 = 1;

enum Request {
    Snapshot(Sender<CoreResult<Value>>),
    Replace(String, Value, Sender<CoreResult<u64>>),
    ReplaceSnapshot(Value, Sender<CoreResult<u64>>),
    Metadata(Sender<CoreResult<Value>>),
    Shutdown(Sender<()>),
}

pub struct StateDatabaseWorker {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl StateDatabaseWorker {
    pub fn start(path: PathBuf) -> CoreResult<Self> {
        let (sender, receiver) = bounded::<Request>(128);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-state-db".to_owned())
            .spawn(move || run_worker(path, receiver, ready_sender))
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        ready_receiver.recv().map_err(|_| {
            CoreError::StateDatabase("state worker stopped during startup".to_owned())
        })??;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn snapshot(&self) -> CoreResult<Value> {
        request(&self.sender, Request::Snapshot)
    }

    pub fn replace_snapshot(&self, snapshot: Value) -> CoreResult<u64> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::ReplaceSnapshot(snapshot, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn replace(&self, key: String, value: Value) -> CoreResult<u64> {
        let (response_sender, response_receiver) = bounded(1);
        self.sender
            .send(Request::Replace(key, value, response_sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        response_receiver
            .recv()
            .map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn metadata(&self) -> CoreResult<Value> {
        request(&self.sender, Request::Metadata)
    }

    pub fn shutdown(&mut self) {
        let (sender, receiver) = bounded(1);
        let _ = self.sender.send(Request::Shutdown(sender));
        let _ = receiver.recv_timeout(Duration::from_secs(3));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for StateDatabaseWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn request<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
) -> CoreResult<T> {
    let (response_sender, response_receiver) = bounded(1);
    sender
        .send(create(response_sender))
        .map_err(|_| CoreError::ShuttingDown)?;
    response_receiver
        .recv()
        .map_err(|_| CoreError::ShuttingDown)?
}

fn run_worker(path: PathBuf, receiver: Receiver<Request>, ready: Sender<CoreResult<()>>) {
    let connection = Connection::open(path)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))
        .and_then(|connection| {
            create_schema(&connection, true)?;
            Ok(connection)
        });
    let mut connection = match connection {
        Ok(connection) => {
            let _ = ready.send(Ok(()));
            connection
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    while let Ok(message) = receiver.recv() {
        match message {
            Request::Snapshot(response) => {
                let _ = response.send(read_snapshot(&connection));
            }
            Request::ReplaceSnapshot(snapshot, response) => {
                let _ = response.send(replace_snapshot(&mut connection, &snapshot));
            }
            Request::Replace(key, value, response) => {
                let _ = response.send(replace_snapshot_field(&mut connection, &key, value));
            }
            Request::Metadata(response) => {
                let _ = response.send(read_metadata(&connection));
            }
            Request::Shutdown(response) => {
                let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                let _ = response.send(());
                break;
            }
        }
    }
}

pub(super) fn create_schema(connection: &Connection, runtime: bool) -> CoreResult<()> {
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
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            );",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let newest_version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<u32>>(0)
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .unwrap_or(0);
    if newest_version > SCHEMA_VERSION {
        return Err(CoreError::StateDatabase(format!(
            "database schema {newest_version} is newer than supported schema {SCHEMA_VERSION}"
        )));
    }
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS games (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS game_images (
              game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
              field TEXT NOT NULL CHECK(field IN ('iconImageDataUrl', 'coverImageDataUrl')),
              mime TEXT NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY(game_id, field)
            );
            CREATE TABLE IF NOT EXISTS roles (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS role_images (
              role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
              field TEXT NOT NULL CHECK(field = 'coverImageDataUrl'),
              mime TEXT NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY(role_id, field)
            );
            CREATE INDEX IF NOT EXISTS roles_game_id_idx ON roles(game_id, ordinal);
            CREATE TABLE IF NOT EXISTS workspaces (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspace_slots (
              workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY(workspace_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS workspace_slots_role_idx ON workspace_slots(role_id);
            CREATE TABLE IF NOT EXISTS macros (
              id TEXT PRIMARY KEY,
              ordinal INTEGER NOT NULL,
              name TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS macro_roles (
              macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
              PRIMARY KEY(macro_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS macro_roles_role_idx ON macro_roles(role_id);
            CREATE TABLE IF NOT EXISTS macro_steps (
              macro_id TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY(macro_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS legal_acceptance (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS compatibility_reports (
              game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            );
            ",
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(())
}

pub(super) fn import_legacy_files(
    connection: &mut Connection,
    user_data_dir: &Path,
) -> CoreResult<()> {
    let games = read_array_file(user_data_dir.join("games.json"), "games")?;
    let roles = if user_data_dir.join("roles.json").is_file() {
        read_array_file(user_data_dir.join("roles.json"), "roles")?
    } else {
        read_array_file(user_data_dir.join("profiles.json"), "profiles")?
    };
    let workspace_file = read_object_file(user_data_dir.join("launch-workspaces.json"))?;
    let workspaces = workspace_file
        .as_ref()
        .and_then(|value| value.get("workspaces"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let macros = read_array_file(user_data_dir.join("macros.json"), "macros")?;
    let compatibility =
        read_array_file_lenient(user_data_dir.join("game-compatibility.json"), "reports");
    let mut snapshot = Map::new();
    snapshot.insert("games".to_owned(), Value::Array(games));
    snapshot.insert("roles".to_owned(), Value::Array(roles));
    snapshot.insert("launchWorkspaces".to_owned(), Value::Array(workspaces));
    snapshot.insert("macros".to_owned(), Value::Array(macros));
    snapshot.insert(
        "compatibilityReports".to_owned(),
        Value::Array(compatibility),
    );
    for (key, file) in [
        ("gameBrowserSettings", "game-browser-settings.json"),
        ("macroSettings", "macro-settings.json"),
        (
            "runtimeWindowPreferences",
            "runtime-window-preferences.json",
        ),
    ] {
        if let Some(value) = read_object_file_lenient(user_data_dir.join(file)) {
            snapshot.insert(key.to_owned(), value);
        }
    }
    if let Some(value) = read_object_file_lenient(user_data_dir.join("legal-acceptance.json")) {
        snapshot.insert("legalAcceptance".to_owned(), value);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    replace_snapshot_transaction(&transaction, &Value::Object(snapshot))?;
    transaction
        .commit()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    Ok(())
}

fn read_snapshot(connection: &Connection) -> CoreResult<Value> {
    let mut object = Map::new();
    object.insert("games".to_owned(), read_payloads(connection, "games")?);
    object.insert("roles".to_owned(), read_payloads(connection, "roles")?);
    object.insert(
        "launchWorkspaces".to_owned(),
        read_payloads(connection, "workspaces")?,
    );
    object.insert("macros".to_owned(), read_payloads(connection, "macros")?);
    object.insert(
        "compatibilityReports".to_owned(),
        read_payloads(connection, "compatibility_reports")?,
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

fn replace_snapshot(connection: &mut Connection, snapshot: &Value) -> CoreResult<u64> {
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

fn replace_snapshot_field(connection: &mut Connection, key: &str, value: Value) -> CoreResult<u64> {
    if !matches!(
        key,
        "games"
            | "roles"
            | "launchWorkspaces"
            | "macros"
            | "compatibilityReports"
            | "gameBrowserSettings"
            | "macroSettings"
            | "runtimeWindowPreferences"
            | "legalAcceptance"
    ) {
        return Err(CoreError::InvalidInput(format!(
            "state key is invalid: {key}"
        )));
    }
    let mut snapshot = read_snapshot(connection)?;
    snapshot
        .as_object_mut()
        .ok_or_else(|| CoreError::StateDatabase("state snapshot must be an object".to_owned()))?
        .insert(key.to_owned(), value);
    replace_snapshot(connection, &snapshot)
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
            DELETE FROM macro_steps;
            DELETE FROM macro_roles;
            DELETE FROM macros;
            DELETE FROM compatibility_reports;
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
    insert_macros(transaction, array_field(object, "macros")?)?;
    insert_compatibility(transaction, array_field(object, "compatibilityReports")?)?;
    for key in [
        "gameBrowserSettings",
        "macroSettings",
        "runtimeWindowPreferences",
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
        "macros",
        "compatibilityReports",
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
            transaction
                .execute(
                    "INSERT INTO workspace_slots(workspace_id, ordinal, role_id, payload_json)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, slot_ordinal as i64, role_id, serialize_payload(slot)?],
                )
                .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
        }
    }
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

fn insert_compatibility(transaction: &Transaction<'_>, values: &[Value]) -> CoreResult<()> {
    for (ordinal, value) in values.iter().enumerate() {
        let object = entity_object(value, "compatibility report")?;
        let game_id = required_string(object, "gameId", "compatibility report")?;
        transaction
            .execute(
                "INSERT INTO compatibility_reports(game_id, ordinal, payload_json) VALUES (?1, ?2, ?3)",
                params![game_id, ordinal as i64, serialize_payload(value)?],
            )
            .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    }
    Ok(())
}

fn increment_revision(transaction: &Transaction<'_>) -> CoreResult<u64> {
    let current = transaction
        .query_row(
            "SELECT value FROM metadata WHERE key='revision'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let next = current.saturating_add(1);
    transaction
        .execute(
            "INSERT INTO metadata(key, value) VALUES ('revision', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![next.to_string()],
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    Ok(next)
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

fn read_array_file(path: PathBuf, key: &str) -> CoreResult<Vec<Value>> {
    let Some(value) = read_object_file(path)? else {
        return Ok(Vec::new());
    };
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| CoreError::Migration(format!("legacy {key} data is invalid")))
}

fn read_array_file_lenient(path: PathBuf, key: &str) -> Vec<Value> {
    read_object_file_lenient(path)
        .and_then(|value| value.get(key).and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn read_object_file_lenient(path: PathBuf) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn read_object_file(path: PathBuf) -> CoreResult<Option<Value>> {
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CoreError::Migration(format!("{}: {error}", path.display()))),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| CoreError::Migration(format!("{}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn snapshot_round_trips_in_one_transaction() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("state.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        let snapshot = json!({
          "games": [{"id":"g1","name":"Game"}],
          "roles": [{"id":"r1","gameId":"g1","name":"Role"}],
          "launchWorkspaces": [{"id":"w1","name":"Workspace","slots":[{"id":"s1","roleId":"r1"}]}],
          "macros": [{"id":"m1","name":"Macro","roleIds":["r1"],"steps":[]}],
          "compatibilityReports": []
        });
        replace_snapshot(&mut connection, &snapshot).unwrap();
        assert_eq!(read_snapshot(&connection).unwrap(), snapshot);
    }

    #[test]
    fn failed_replace_preserves_previous_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({"games":[{"name":"Missing id"}]});
        assert!(replace_snapshot(&mut connection, &invalid).is_err());
        assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
    }

    #[test]
    fn foreign_key_failure_rolls_back_the_whole_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let valid = json!({"games":[{"id":"g1","name":"Game"}]});
        replace_snapshot(&mut connection, &valid).unwrap();
        let invalid = json!({
            "games":[{"id":"g2","name":"Other"}],
            "roles":[{"id":"r1","gameId":"missing","name":"Role"}]
        });

        assert!(replace_snapshot(&mut connection, &invalid).is_err());
        assert_eq!(read_snapshot(&connection).unwrap()["games"][0]["id"], "g1");
    }

    #[test]
    fn replaces_snapshots_that_already_have_compatibility_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{"id":"g1","name":"Game"}],
            "compatibilityReports":[{"gameId":"g1","status":"compatible"}]
        });
        replace_snapshot(&mut connection, &original).unwrap();
        let replacement = json!({
            "games":[{"id":"g2","name":"Other"}],
            "compatibilityReports":[{"gameId":"g2","status":"unknown"}]
        });

        replace_snapshot(&mut connection, &replacement).unwrap();

        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], replacement["games"]);
        assert_eq!(
            stored["compatibilityReports"],
            replacement["compatibilityReports"]
        );
    }

    #[test]
    fn replaces_one_state_field_without_a_javascript_snapshot_round_trip() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let original = json!({
            "games":[{"id":"g1","name":"Game"}],
            "gameBrowserSettings":{"launchMode":"embedded"}
        });
        replace_snapshot(&mut connection, &original).unwrap();

        replace_snapshot_field(
            &mut connection,
            "gameBrowserSettings",
            json!({"launchMode":"external"}),
        )
        .unwrap();

        let stored = read_snapshot(&connection).unwrap();
        assert_eq!(stored["games"], original["games"]);
        assert_eq!(
            stored["gameBrowserSettings"],
            json!({"launchMode":"external"})
        );
        assert!(replace_snapshot_field(&mut connection, "unknown", Value::Null).is_err());
    }

    #[test]
    fn rejects_a_database_created_by_a_newer_application_version() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (999, 'future');",
            )
            .unwrap();

        assert!(
            create_schema(&connection, false)
                .unwrap_err()
                .to_string()
                .contains("newer than supported")
        );
    }

    #[test]
    fn corrupt_optional_legacy_files_do_not_block_migration() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("games.json"), r#"{"games":[]}"#).unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            "not-json",
        )
        .unwrap();
        fs::write(directory.path().join("game-compatibility.json"), "not-json").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();

        import_legacy_files(&mut connection, directory.path()).unwrap();

        let snapshot = read_snapshot(&connection).unwrap();
        assert_eq!(snapshot["compatibilityReports"], json!([]));
        assert!(snapshot.get("gameBrowserSettings").is_none());
    }

    #[test]
    fn stores_images_as_blobs_and_restores_data_urls_at_the_api_boundary() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_schema(&connection, false).unwrap();
        let data_url = "data:image/png;base64,AQIDBA==";
        let snapshot = json!({
            "games": [{"id":"g1","name":"Game","iconImageDataUrl":data_url}],
            "roles": [{"id":"r1","gameId":"g1","name":"Role","coverImageDataUrl":data_url}]
        });

        replace_snapshot(&mut connection, &snapshot).unwrap();

        let game_payload: String = connection
            .query_row("SELECT payload_json FROM games", [], |row| row.get(0))
            .unwrap();
        let image_bytes: Vec<u8> = connection
            .query_row("SELECT data FROM game_images", [], |row| row.get(0))
            .unwrap();
        assert!(!game_payload.contains("base64"));
        assert_eq!(image_bytes, vec![1, 2, 3, 4]);
        let restored = read_snapshot(&connection).unwrap();
        assert_eq!(restored["games"], snapshot["games"]);
        assert_eq!(restored["roles"], snapshot["roles"]);
    }
}
