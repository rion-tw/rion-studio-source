use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use chrono::{Duration as ChronoDuration, Utc};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, bounded};
use rusqlite::{Connection, params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use serde_json::Value;

use crate::{
    error::{CoreError, CoreResult},
    model::{LogEntry, LogErrorDetails, LogLevel, LogPageRecord, LogQuery, LogStorageStatusRecord},
};

const RETENTION_DAYS: i64 = 14;
const MAX_BYTES: i64 = 100 * 1024 * 1024;
const BATCH_INTERVAL: Duration = Duration::from_millis(250);
const BATCH_MAX_ENTRIES: usize = 50;

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
    Query(LogQuery, Sender<CoreResult<LogPageRecord>>),
    Clear(Sender<CoreResult<()>>),
    Status(Sender<CoreResult<LogStatus>>),
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

    pub fn query(&self, query: LogQuery) -> CoreResult<LogPageRecord> {
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

    pub fn storage_status(&self, current_level: LogLevel) -> CoreResult<LogStorageStatusRecord> {
        let status = self.status()?;
        let directory = Path::new(&status.database_path)
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_string_lossy()
            .into_owned();
        Ok(LogStorageStatusRecord {
            current_level,
            file_count: u64::from(status.entry_count > 0),
            total_bytes: status.total_bytes,
            oldest_timestamp: status.oldest_timestamp,
            newest_timestamp: status.newest_timestamp,
            retention_days: status.retention_days,
            max_bytes: status.max_bytes,
            directory,
        })
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
    let mut pending = Vec::<LogEntry>::with_capacity(BATCH_MAX_ENTRIES);
    let mut last_flush = Instant::now();
    let mut sticky_error: Option<String> = None;
    loop {
        let timeout = BATCH_INTERVAL.saturating_sub(last_flush.elapsed());
        let message = match receiver.recv_timeout(timeout) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                if let Err(error) = flush_pending(&mut connection, &mut pending) {
                    sticky_error = Some(error.to_string());
                }
                last_flush = Instant::now();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = flush_pending(&mut connection, &mut pending);
                break;
            }
        };
        match message {
            Request::Append(entries, response) => {
                let accepted = entries.len();
                let result = if let Some(error) = sticky_error.take() {
                    Err(CoreError::LogDatabase(error))
                } else if let Err(error) = entries.iter().try_for_each(validate_entry) {
                    Err(error)
                } else {
                    let urgent = entries
                        .iter()
                        .any(|entry| matches!(entry.level, LogLevel::Warn | LogLevel::Error));
                    pending.extend(entries);
                    if urgent || pending.len() >= BATCH_MAX_ENTRIES {
                        let result = flush_pending(&mut connection, &mut pending).map(|_| accepted);
                        last_flush = Instant::now();
                        result
                    } else {
                        Ok(accepted)
                    }
                };
                let _ = response.send(result);
            }
            Request::Query(query, response) => {
                let result = flush_pending(&mut connection, &mut pending)
                    .and_then(|_| query_entries(&connection, &query));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Clear(response) => {
                let result = flush_pending(&mut connection, &mut pending)
                    .and_then(|_| clear_entries(&connection));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Status(response) => {
                let result = flush_pending(&mut connection, &mut pending)
                    .and_then(|_| read_status(&connection, &path));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::ExportTo(path, response) => {
                let result = flush_pending(&mut connection, &mut pending)
                    .and_then(|_| export_jsonl_to(&connection, &path));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Shutdown(response) => {
                let _ = flush_pending(&mut connection, &mut pending);
                let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                let _ = response.send(());
                break;
            }
        }
    }
}

fn flush_pending(connection: &mut Connection, pending: &mut Vec<LogEntry>) -> CoreResult<usize> {
    if pending.is_empty() {
        return Ok(0);
    }
    let entries = std::mem::take(pending);
    match append_entries(connection, &entries) {
        Ok(inserted) => Ok(inserted),
        Err(error) => {
            *pending = entries;
            Err(error)
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
                entry.level.as_str(),
                entry.source.as_str(),
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

fn query_entries(connection: &Connection, query: &LogQuery) -> CoreResult<LogPageRecord> {
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
        values.extend(
            levels
                .iter()
                .map(|level| SqlValue::Text(level.as_str().to_owned())),
        );
    }
    let sources = query.sources.as_deref().unwrap_or_default();
    if !sources.is_empty() {
        conditions.push(format!(
            "source IN ({})",
            placeholders(values.len(), sources.len())
        ));
        values.extend(
            sources
                .iter()
                .map(|source| SqlValue::Text(source.as_str().to_owned())),
        );
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
        entries.push(LogEntry {
            id,
            timestamp,
            level: serde_json::from_value(Value::String(level))
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
            source: serde_json::from_value(Value::String(source))
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
            event,
            message,
            session_id,
            context: context.as_deref().map(parse_context_json).transpose()?,
            error: error
                .as_deref()
                .map(serde_json::from_str::<LogErrorDetails>)
                .transpose()
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
        });
    }
    let has_more = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    Ok(LogPageRecord {
        entries,
        next_cursor: has_more.then(|| (offset + limit).to_string()),
    })
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
            level: serde_json::from_value(Value::String(level))
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
            source: serde_json::from_value(Value::String(source))
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
            event,
            message,
            session_id,
            context: context.as_deref().map(parse_context_json).transpose()?,
            error: error
                .as_deref()
                .map(serde_json::from_str::<LogErrorDetails>)
                .transpose()
                .map_err(|error| CoreError::LogDatabase(error.to_string()))?,
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
    Ok(())
}

fn validate_query(query: &LogQuery) -> CoreResult<()> {
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

fn parse_context_json(value: &str) -> CoreResult<BTreeMap<String, Value>> {
    serde_json::from_str(value).map_err(|error| CoreError::LogDatabase(error.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::model::{LogCaptureRecord, LogSource};

    fn entry(id: &str, message: &str) -> LogEntry {
        LogEntry {
            id: id.to_owned(),
            timestamp: Utc::now().to_rfc3339(),
            level: LogLevel::Info,
            source: LogSource::Main,
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
        let mut browser = entry("1", "alpha role");
        browser.source = LogSource::Browser;
        browser.context = Some(BTreeMap::from([
            ("roleId".to_owned(), json!("role-1")),
            ("token".to_owned(), json!("<REDACTED>")),
        ]));
        let mut warning = entry("2", "beta macro");
        warning.level = LogLevel::Warn;
        warning.source = LogSource::Macro;
        append_entries(
            &mut connection,
            &[browser.clone(), warning.clone(), entry("3", "gamma role")],
        )
        .unwrap();
        crate::v1_case!("logging-9fcfdf8da221", {
            let filtered = query_entries(
                &connection,
                &LogQuery {
                    sources: Some(vec![LogSource::Browser]),
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(filtered.entries.len(), 1);
            assert_eq!(filtered.entries[0].id, browser.id);
            assert_eq!(filtered.entries[0].context, browser.context);
            let first = query_entries(
                &connection,
                &LogQuery {
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(first.entries.len(), 1);
            assert_eq!(first.next_cursor.as_deref(), Some("1"));
            let second = query_entries(
                &connection,
                &LogQuery {
                    cursor: first.next_cursor,
                    limit: Some(1),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(second.entries.len(), 1);
            assert_ne!(first.entries[0].id, second.entries[0].id);
            let searched = query_entries(
                &connection,
                &LogQuery {
                    search: Some("beta".to_owned()),
                    ..LogQuery::default()
                },
            )
            .unwrap();
            assert_eq!(searched.entries.len(), 1);
            assert_eq!(searched.entries[0].id, warning.id);
            assert!(
                read_status(&connection, directory.path())
                    .unwrap()
                    .total_bytes
                    > 0
            );
        });
    }

    #[test]
    fn default_level_clear_and_query_validation_match_v1() {
        crate::v1_case!("logging-1a70a51d1e39", {
            let directory = tempdir().unwrap();
            let path = directory.path().join("logs.sqlite3");
            let mut connection = Connection::open(&path).unwrap();
            create_schema(&connection, false).unwrap();
            let mut capture = crate::log_capture::LogCaptureRuntime::new(directory.path().into());
            let hidden = capture.capture(vec![LogCaptureRecord {
                level: LogLevel::Debug,
                source: LogSource::Main,
                event: "hidden".to_owned(),
                message: "Hidden debug message.".to_owned(),
                context_raw_json: None,
                error: None,
            }]);
            assert!(hidden.is_empty());
            capture.set_level(LogLevel::Debug);
            let visible = capture.capture(vec![LogCaptureRecord {
                level: LogLevel::Debug,
                source: LogSource::Main,
                event: "visible".to_owned(),
                message: "Visible debug message.".to_owned(),
                context_raw_json: None,
                error: None,
            }]);
            append_entries(&mut connection, &visible).unwrap();
            assert_eq!(
                query_entries(&connection, &LogQuery::default())
                    .unwrap()
                    .entries[0]
                    .event,
                "visible"
            );
            clear_entries(&connection).unwrap();
            assert!(
                query_entries(&connection, &LogQuery::default())
                    .unwrap()
                    .entries
                    .is_empty()
            );
        });

        crate::v1_case!("logging-ab48857b7878", {
            let connection = Connection::open_in_memory().unwrap();
            create_schema(&connection, false).unwrap();
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        limit: Some(201),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        cursor: Some("../file".to_owned()),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
            assert!(
                query_entries(
                    &connection,
                    &LogQuery {
                        search: Some("x".repeat(201)),
                        ..LogQuery::default()
                    }
                )
                .is_err()
            );
        });
    }

    #[test]
    fn worker_flushes_warn_immediately_and_pending_info_before_reads() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut worker = LogDatabaseWorker::start(path.clone()).unwrap();
        worker.append(vec![entry("info", "queued")]).unwrap();
        let mut warning = entry("warn", "urgent");
        warning.level = LogLevel::Warn;
        worker.append(vec![warning]).unwrap();

        let reader = Connection::open(&path).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM log_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            2
        );

        worker.append(vec![entry("later", "pending")]).unwrap();
        assert_eq!(worker.status().unwrap().entry_count, 3);
        worker.shutdown();
    }

    #[test]
    fn worker_flushes_the_bounded_queue_during_shutdown() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("logs.sqlite3");
        let mut worker = LogDatabaseWorker::start(path.clone()).unwrap();
        worker.append(vec![entry("shutdown", "pending")]).unwrap();
        worker.shutdown();

        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM log_entries", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }
}
