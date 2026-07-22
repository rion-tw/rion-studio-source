use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::Duration,
};

use chrono::{Duration as ChronoDuration, Utc};
use crossbeam_channel::{Receiver, Sender, bounded};
use rusqlite::{Connection, params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{
    error::{CoreError, CoreResult},
    model::{LogEntry, LogQuery},
};

const RETENTION_DAYS: i64 = 14;
const MAX_BYTES: i64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    pub entry_count: u64,
    pub total_bytes: u64,
    pub oldest_timestamp: Option<String>,
    pub newest_timestamp: Option<String>,
    pub retention_days: u32,
    pub max_bytes: u64,
    pub database_path: String,
}

enum Request {
    Append(Vec<LogEntry>, Sender<CoreResult<usize>>),
    Query(LogQuery, Sender<CoreResult<Value>>),
    Clear(Sender<CoreResult<()>>),
    Status(Sender<CoreResult<LogStatus>>),
    Export(Sender<CoreResult<String>>),
    ExportTo(PathBuf, Sender<CoreResult<()>>),
    Shutdown(Sender<()>),
}

pub struct LogDatabaseWorker {
    sender: Sender<Request>,
    join: Option<JoinHandle<()>>,
}

impl LogDatabaseWorker {
    pub fn start(path: PathBuf) -> CoreResult<Self> {
        let (sender, receiver) = bounded::<Request>(256);
        let (ready_sender, ready_receiver) = bounded(1);
        let join = thread::Builder::new()
            .name("rion-log-db".to_owned())
            .spawn(move || run_worker(path, receiver, ready_sender))
            .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        ready_receiver.recv().map_err(|_| {
            CoreError::LogDatabase("log worker stopped during startup".to_owned())
        })??;
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn append(&self, entries: Vec<LogEntry>) -> CoreResult<usize> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Append(entries, sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn query(&self, query: LogQuery) -> CoreResult<Value> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Query(query, sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn clear(&self) -> CoreResult<()> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Clear(sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn status(&self) -> CoreResult<LogStatus> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Status(sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn export_jsonl(&self) -> CoreResult<String> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::Export(sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
    }

    pub fn export_jsonl_to(&self, path: PathBuf) -> CoreResult<()> {
        let (sender, receiver) = bounded(1);
        self.sender
            .send(Request::ExportTo(path, sender))
            .map_err(|_| CoreError::ShuttingDown)?;
        receiver.recv().map_err(|_| CoreError::ShuttingDown)?
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

impl Drop for LogDatabaseWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_worker(path: PathBuf, receiver: Receiver<Request>, ready: Sender<CoreResult<()>>) {
    let connection = Connection::open(&path)
        .map_err(|error| CoreError::LogDatabase(error.to_string()))
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
            Request::Append(entries, response) => {
                let _ = response.send(append_entries(&mut connection, &entries));
            }
            Request::Query(query, response) => {
                let _ = response.send(query_entries(&connection, &query));
            }
            Request::Clear(response) => {
                let _ = response.send(clear_entries(&connection));
            }
            Request::Status(response) => {
                let _ = response.send(read_status(&connection, &path));
            }
            Request::Export(response) => {
                let _ = response.send(export_jsonl(&connection));
            }
            Request::ExportTo(path, response) => {
                let _ = response.send(export_jsonl_to(&connection, &path));
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
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    connection
        .execute_batch(if runtime {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA auto_vacuum=INCREMENTAL;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA auto_vacuum=INCREMENTAL;"
        })
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS log_entries (
              row_id INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              timestamp TEXT NOT NULL,
              level TEXT NOT NULL,
              source TEXT NOT NULL,
              event TEXT NOT NULL,
              message TEXT NOT NULL,
              session_id TEXT NOT NULL,
              context_json TEXT,
              error_json TEXT,
              search_text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS log_entries_time_idx ON log_entries(timestamp DESC, id DESC);
            CREATE INDEX IF NOT EXISTS log_entries_level_time_idx ON log_entries(level, timestamp DESC);
            CREATE INDEX IF NOT EXISTS log_entries_source_time_idx ON log_entries(source, timestamp DESC);
            CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts USING fts5(
              search_text,
              content='log_entries',
              content_rowid='row_id'
            );
            CREATE TRIGGER IF NOT EXISTS log_entries_ai AFTER INSERT ON log_entries BEGIN
              INSERT INTO log_entries_fts(rowid, search_text) VALUES (new.row_id, new.search_text);
            END;
            CREATE TRIGGER IF NOT EXISTS log_entries_ad AFTER DELETE ON log_entries BEGIN
              INSERT INTO log_entries_fts(log_entries_fts, rowid, search_text)
              VALUES ('delete', old.row_id, old.search_text);
            END;
            ",
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    Ok(())
}

pub(super) fn import_legacy_logs(connection: &mut Connection, directory: &Path) -> CoreResult<()> {
    if !directory.is_dir() {
        return Ok(());
    }
    let mut files = fs::read_dir(directory)
        .map_err(|error| CoreError::Migration(error.to_string()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|value| value == "jsonl"))
        .collect::<Vec<_>>();
    files.sort();
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    for path in files {
        let file = File::open(&path).map_err(|error| CoreError::Migration(error.to_string()))?;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<LogEntry>(&line) else {
                continue;
            };
            insert_entry(&transaction, &entry)?;
        }
    }
    transaction
        .commit()
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    Ok(())
}

fn append_entries(connection: &mut Connection, entries: &[LogEntry]) -> CoreResult<usize> {
    if entries.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let mut inserted = 0;
    for entry in entries {
        validate_entry(entry)?;
        inserted += insert_entry(&transaction, entry)?;
    }
    transaction
        .commit()
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    enforce_retention(connection)?;
    Ok(inserted)
}

fn insert_entry(connection: &Connection, entry: &LogEntry) -> CoreResult<usize> {
    let context_json = entry
        .context
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let error_json = entry
        .error
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let search_text =
        serde_json::to_string(entry).map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO log_entries(
              id, timestamp, level, source, event, message, session_id,
              context_json, error_json, search_text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                entry.id,
                entry.timestamp,
                entry.level,
                entry.source,
                entry.event,
                entry.message,
                entry.session_id,
                context_json,
                error_json,
                search_text,
            ],
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))
}

fn query_entries(connection: &Connection, query: &LogQuery) -> CoreResult<Value> {
    validate_query(query)?;
    let offset = query
        .cursor
        .as_deref()
        .unwrap_or("0")
        .parse::<u64>()
        .map_err(|_| CoreError::InvalidInput("invalid log cursor".to_owned()))?;
    let limit = query.limit.unwrap_or(100).clamp(1, 200) as u64;
    let mut conditions = Vec::<String>::new();
    let mut values = Vec::<SqlValue>::new();
    let levels = query.levels.as_deref().unwrap_or_default();
    if !levels.is_empty() {
        conditions.push(format!(
            "level IN ({})",
            placeholders(values.len(), levels.len())
        ));
        values.extend(levels.iter().cloned().map(SqlValue::Text));
    }
    let sources = query.sources.as_deref().unwrap_or_default();
    if !sources.is_empty() {
        conditions.push(format!(
            "source IN ({})",
            placeholders(values.len(), sources.len())
        ));
        values.extend(sources.iter().cloned().map(SqlValue::Text));
    }
    if let Some(from) = &query.from {
        values.push(SqlValue::Text(from.clone()));
        conditions.push(format!("timestamp >= ?{}", values.len()));
    }
    if let Some(to) = &query.to {
        values.push(SqlValue::Text(to.clone()));
        conditions.push(format!("timestamp <= ?{}", values.len()));
    }
    if let Some(search) = query
        .search
        .as_ref()
        .map(|value| value.trim())
        .filter(|v| !v.is_empty())
    {
        values.push(SqlValue::Text(format!(
            "\"{}\"",
            search.replace('"', "\"\"")
        )));
        conditions.push(format!(
            "row_id IN (SELECT rowid FROM log_entries_fts WHERE log_entries_fts MATCH ?{})",
            values.len()
        ));
    }
    values.push(SqlValue::Integer((limit + 1) as i64));
    let limit_index = values.len();
    values.push(SqlValue::Integer(offset as i64));
    let offset_index = values.len();
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT id, timestamp, level, source, event, message, session_id, context_json, error_json
         FROM log_entries {where_clause}
         ORDER BY timestamp DESC, id DESC LIMIT ?{limit_index} OFFSET ?{offset_index}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let context: Option<String> = row.get(7)?;
            let error: Option<String> = row.get(8)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                context,
                error,
            ))
        })
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, timestamp, level, source, event, message, session_id, context, error) =
            row.map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        let mut entry = Map::new();
        entry.insert("id".to_owned(), Value::String(id));
        entry.insert("timestamp".to_owned(), Value::String(timestamp));
        entry.insert("level".to_owned(), Value::String(level));
        entry.insert("source".to_owned(), Value::String(source));
        entry.insert("event".to_owned(), Value::String(event));
        entry.insert("message".to_owned(), Value::String(message));
        entry.insert("sessionId".to_owned(), Value::String(session_id));
        if let Some(context) = context {
            entry.insert("context".to_owned(), parse_optional_json(&context)?);
        }
        if let Some(error) = error {
            entry.insert("error".to_owned(), parse_optional_json(&error)?);
        }
        entries.push(Value::Object(entry));
    }
    let has_more = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    Ok(json!({
      "entries": entries,
      "nextCursor": has_more.then(|| (offset + limit).to_string())
    }))
}

fn clear_entries(connection: &Connection) -> CoreResult<()> {
    connection
        .execute("DELETE FROM log_entries", [])
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    connection
        .execute_batch("INSERT INTO log_entries_fts(log_entries_fts) VALUES ('rebuild'); PRAGMA incremental_vacuum;")
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    Ok(())
}

fn read_status(connection: &Connection, path: &Path) -> CoreResult<LogStatus> {
    let (entry_count, oldest, newest) = connection
        .query_row(
            "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM log_entries",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    Ok(LogStatus {
        entry_count: entry_count.max(0) as u64,
        total_bytes: database_size(connection)?.max(0) as u64,
        oldest_timestamp: oldest,
        newest_timestamp: newest,
        retention_days: RETENTION_DAYS as u32,
        max_bytes: MAX_BYTES as u64,
        database_path: path.to_string_lossy().into_owned(),
    })
}

fn export_jsonl(connection: &Connection) -> CoreResult<String> {
    let mut output = Vec::new();
    write_jsonl(connection, &mut output)?;
    String::from_utf8(output).map_err(|error| CoreError::LogDatabase(error.to_string()))
}

fn export_jsonl_to(connection: &Connection, path: &Path) -> CoreResult<()> {
    if !path.is_absolute() {
        return Err(CoreError::InvalidInput(
            "log export path must be absolute".to_owned(),
        ));
    }
    let file = File::create(path).map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let mut writer = BufWriter::new(file);
    write_jsonl(connection, &mut writer)?;
    writer
        .flush()
        .map_err(|error| CoreError::LogDatabase(error.to_string()))
}

fn write_jsonl(connection: &Connection, output: &mut impl Write) -> CoreResult<()> {
    let mut statement = connection
        .prepare(
            "SELECT id, timestamp, level, source, event, message, session_id, context_json, error_json
             FROM log_entries ORDER BY timestamp, id",
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    for row in rows {
        let (id, timestamp, level, source, event, message, session_id, context, error) =
            row.map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        let entry = LogEntry {
            id,
            timestamp,
            level,
            source,
            event,
            message,
            session_id,
            context: context.as_deref().map(parse_optional_json).transpose()?,
            error: error.as_deref().map(parse_optional_json).transpose()?,
        };
        serde_json::to_writer(&mut *output, &entry)
            .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        output
            .write_all(b"\n")
            .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    }
    Ok(())
}

fn enforce_retention(connection: &Connection) -> CoreResult<()> {
    let cutoff = (Utc::now() - ChronoDuration::days(RETENTION_DAYS)).to_rfc3339();
    connection
        .execute(
            "DELETE FROM log_entries WHERE timestamp < ?1",
            params![cutoff],
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let mut rounds = 0;
    while database_size(connection)? > MAX_BYTES && rounds < 200 {
        let removed = connection
            .execute(
                "DELETE FROM log_entries WHERE row_id IN (
                   SELECT row_id FROM log_entries ORDER BY timestamp, row_id LIMIT 1000
                 )",
                [],
            )
            .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        if removed == 0 {
            break;
        }
        rounds += 1;
    }
    connection
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(256);")
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    Ok(())
}

fn database_size(connection: &Connection) -> CoreResult<i64> {
    let pages: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    Ok(pages.saturating_mul(page_size))
}

fn validate_entry(entry: &LogEntry) -> CoreResult<()> {
    if entry.id.is_empty()
        || entry.timestamp.is_empty()
        || entry.event.is_empty()
        || entry.message.is_empty()
    {
        return Err(CoreError::InvalidInput(
            "log entry is missing a required field".to_owned(),
        ));
    }
    if !matches!(entry.level.as_str(), "debug" | "info" | "warn" | "error") {
        return Err(CoreError::InvalidInput("invalid log level".to_owned()));
    }
    Ok(())
}

fn validate_query(query: &LogQuery) -> CoreResult<()> {
    if query
        .levels
        .iter()
        .flatten()
        .any(|level| !matches!(level.as_str(), "debug" | "info" | "warn" | "error"))
    {
        return Err(CoreError::InvalidInput(
            "invalid log level filter".to_owned(),
        ));
    }
    if query.search.as_ref().is_some_and(|value| value.len() > 200) {
        return Err(CoreError::InvalidInput("invalid log search".to_owned()));
    }
    if query.limit.is_some_and(|value| value == 0 || value > 200) {
        return Err(CoreError::InvalidInput("invalid log page size".to_owned()));
    }
    Ok(())
}

fn placeholders(existing: usize, count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{}", existing + index))
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_optional_json(value: &str) -> CoreResult<Value> {
    serde_json::from_str(value).map_err(|error| CoreError::LogDatabase(error.to_string()))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn entry(id: &str, message: &str) -> LogEntry {
        LogEntry {
            id: id.to_owned(),
            timestamp: Utc::now().to_rfc3339(),
            level: "info".to_owned(),
            source: "main".to_owned(),
            event: "test".to_owned(),
            message: message.to_owned(),
            session_id: "session".to_owned(),
            context: None,
            error: None,
        }
    }

    #[test]
    fn appends_and_queries_without_loading_files() {
        let directory = tempdir().unwrap();
        let mut connection = Connection::open(directory.path().join("logs.sqlite3")).unwrap();
        create_schema(&connection, false).unwrap();
        append_entries(&mut connection, &[entry("1", "alpha"), entry("2", "beta")]).unwrap();
        let page = query_entries(
            &connection,
            &LogQuery {
                search: Some("beta".to_owned()),
                ..LogQuery::default()
            },
        )
        .unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 1);
        assert_eq!(page["entries"][0]["id"], "2");
    }
}
