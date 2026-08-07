use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use chrono::{Duration as ChronoDuration, Utc};
use crossbeam_channel::{Receiver, RecvTimeoutError, SendTimeoutError, Sender, bounded};
use rusqlite::{Connection, params, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use serde_json::Value;

use crate::{
    database::join_worker_if_finished,
    error::{CoreError, CoreResult},
    model::{
        LogEntry, LogErrorDetails, LogLevel, LogPageRecord, LogQuery, LogSource,
        LogStorageStatusRecord,
    },
};

const RETENTION_DAYS: i64 = 14;
const MAX_BYTES: i64 = 100 * 1024 * 1024;
const RETENTION_TARGET_BYTES: i64 = 90 * 1024 * 1024;
const RETENTION_DELETE_BATCH_SIZE: usize = 1_000;
const BATCH_INTERVAL: Duration = Duration::from_millis(250);
const BATCH_MAX_ENTRIES: usize = 50;
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Shutdown may need to wait for SQLite's five-second busy timeout before it
// can flush pending entries and checkpoint the WAL. Leave enough headroom for
// that durable completion on busy Windows filesystems.
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
struct RetentionPolicy {
    retention_days: i64,
    max_bytes: i64,
    target_bytes: i64,
    delete_batch_size: usize,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            retention_days: RETENTION_DAYS,
            max_bytes: MAX_BYTES,
            target_bytes: RETENTION_TARGET_BYTES,
            delete_batch_size: RETENTION_DELETE_BATCH_SIZE,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    pub entry_count: u64,
    pub file_count: u64,
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
    Shutdown(Sender<CoreResult<()>>),
}

struct PendingAppend {
    accepted: usize,
    response: Sender<CoreResult<usize>>,
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
        match ready_receiver.recv_timeout(WORKER_START_TIMEOUT) {
            Ok(result) => result?,
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreError::LogDatabase(format!(
                    "log worker startup timed out after {} seconds",
                    WORKER_START_TIMEOUT.as_secs()
                )));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CoreError::LogDatabase(
                    "log worker stopped during startup".to_owned(),
                ));
            }
        }
        Ok(Self {
            sender,
            join: Some(join),
        })
    }

    pub fn append(&self, entries: Vec<LogEntry>) -> CoreResult<usize> {
        request(&self.sender, |response| Request::Append(entries, response))
    }

    pub fn query(&self, query: LogQuery) -> CoreResult<LogPageRecord> {
        request(&self.sender, |response| Request::Query(query, response))
    }

    pub fn clear(&self) -> CoreResult<()> {
        request(&self.sender, Request::Clear)
    }

    pub fn status(&self) -> CoreResult<LogStatus> {
        request(&self.sender, Request::Status)
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
            entry_count: status.entry_count,
            file_count: status.file_count,
            total_bytes: status.total_bytes,
            oldest_timestamp: status.oldest_timestamp,
            newest_timestamp: status.newest_timestamp,
            retention_days: status.retention_days,
            max_bytes: status.max_bytes,
            directory,
        })
    }

    pub fn export_jsonl_to(&self, path: PathBuf) -> CoreResult<()> {
        request(&self.sender, |response| Request::ExportTo(path, response))
    }

    pub fn shutdown(&mut self) -> CoreResult<()> {
        if self.join.is_none() {
            return Ok(());
        }
        let (sender, receiver) = bounded(1);
        let result = match self
            .sender
            .send_timeout(Request::Shutdown(sender), WORKER_SHUTDOWN_TIMEOUT)
        {
            Ok(()) => match receiver.recv_timeout(WORKER_SHUTDOWN_TIMEOUT) {
                Ok(result) => result,
                Err(RecvTimeoutError::Timeout) => Err(CoreError::LogDatabase(format!(
                    "log worker shutdown timed out after {} seconds",
                    WORKER_SHUTDOWN_TIMEOUT.as_secs()
                ))),
                Err(RecvTimeoutError::Disconnected) => Err(CoreError::ShuttingDown),
            },
            Err(SendTimeoutError::Timeout(_)) => Err(CoreError::LogDatabase(format!(
                "log worker shutdown queue timed out after {} seconds",
                WORKER_SHUTDOWN_TIMEOUT.as_secs()
            ))),
            Err(SendTimeoutError::Disconnected(_)) => Err(CoreError::ShuttingDown),
        };
        join_worker_if_finished(&mut self.join);
        result
    }
}

impl Drop for LogDatabaseWorker {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn request<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
) -> CoreResult<T> {
    request_with_timeout(sender, create, WORKER_REQUEST_TIMEOUT)
}

fn request_with_timeout<T>(
    sender: &Sender<Request>,
    create: impl FnOnce(Sender<CoreResult<T>>) -> Request,
    timeout: Duration,
) -> CoreResult<T> {
    let (response_sender, response_receiver) = bounded(1);
    match sender.send_timeout(create(response_sender), timeout) {
        Ok(()) => {}
        Err(SendTimeoutError::Timeout(_)) => {
            return Err(CoreError::LogDatabase(format!(
                "log worker queue timed out after {} milliseconds",
                timeout.as_millis()
            )));
        }
        Err(SendTimeoutError::Disconnected(_)) => return Err(CoreError::ShuttingDown),
    }
    match response_receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(CoreError::LogDatabase(format!(
            "log worker response timed out after {} milliseconds; the operation may still complete",
            timeout.as_millis()
        ))),
        Err(RecvTimeoutError::Disconnected) => Err(CoreError::ShuttingDown),
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
    let mut pending_appends = Vec::<PendingAppend>::new();
    let mut last_flush = Instant::now();
    loop {
        let timeout = BATCH_INTERVAL.saturating_sub(last_flush.elapsed());
        let message = match receiver.recv_timeout(timeout) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => {
                let _ = flush_pending(&mut connection, &mut pending, &mut pending_appends);
                last_flush = Instant::now();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = flush_pending(&mut connection, &mut pending, &mut pending_appends);
                break;
            }
        };
        match message {
            Request::Append(entries, response) => {
                let accepted = entries.len();
                if let Err(error) = entries.iter().try_for_each(validate_entry) {
                    let _ = response.send(Err(error));
                } else {
                    let urgent = entries
                        .iter()
                        .any(|entry| matches!(entry.level, LogLevel::Warn | LogLevel::Error));
                    pending.extend(entries);
                    pending_appends.push(PendingAppend { accepted, response });
                    if urgent || pending.len() >= BATCH_MAX_ENTRIES {
                        let _ = flush_pending(&mut connection, &mut pending, &mut pending_appends);
                        last_flush = Instant::now();
                    }
                }
            }
            Request::Query(query, response) => {
                let result = flush_pending(&mut connection, &mut pending, &mut pending_appends)
                    .and_then(|_| query_entries(&connection, &query));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Clear(response) => {
                let result = flush_pending(&mut connection, &mut pending, &mut pending_appends)
                    .and_then(|_| clear_entries(&connection));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Status(response) => {
                let result = flush_pending(&mut connection, &mut pending, &mut pending_appends)
                    .and_then(|_| read_status(&connection, &path));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::ExportTo(path, response) => {
                let result = flush_pending(&mut connection, &mut pending, &mut pending_appends)
                    .and_then(|_| export_jsonl_to(&connection, &path));
                last_flush = Instant::now();
                let _ = response.send(result);
            }
            Request::Shutdown(response) => {
                let result = flush_pending(&mut connection, &mut pending, &mut pending_appends)
                    .and_then(|_| {
                        connection
                            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                            .map_err(|error| CoreError::LogDatabase(error.to_string()))
                    });
                let _ = response.send(result);
                break;
            }
        }
    }
}

fn flush_pending(
    connection: &mut Connection,
    pending: &mut Vec<LogEntry>,
    pending_appends: &mut Vec<PendingAppend>,
) -> CoreResult<usize> {
    if pending.is_empty() {
        debug_assert!(pending_appends.is_empty());
        return Ok(0);
    }
    let entries = std::mem::take(pending);
    let appends = std::mem::take(pending_appends);
    let result = append_entries(connection, &entries);
    match &result {
        Ok(_) => {
            for append in appends {
                let _ = append.response.send(Ok(append.accepted));
            }
        }
        Err(error) => {
            let message = error.to_string();
            for append in appends {
                let _ = append
                    .response
                    .send(Err(CoreError::LogDatabase(message.clone())));
            }
        }
    }
    result
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

fn append_entries(connection: &mut Connection, entries: &[LogEntry]) -> CoreResult<usize> {
    append_entries_with_policy(connection, entries, RetentionPolicy::default())
}

fn append_entries_with_policy(
    connection: &mut Connection,
    entries: &[LogEntry],
    retention: RetentionPolicy,
) -> CoreResult<usize> {
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
    enforce_retention_with_policy(connection, retention)?;
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
        let stored_sources = sources
            .iter()
            .flat_map(|source| stored_log_source_values(source).iter().copied())
            .collect::<Vec<_>>();
        conditions.push(format!(
            "source IN ({})",
            placeholders(values.len(), stored_sources.len())
        ));
        values.extend(
            stored_sources
                .iter()
                .map(|source| SqlValue::Text((*source).to_owned())),
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
            source: parse_stored_log_source(&source)?,
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
    reclaim_unused_space(connection)
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
    let (file_count, total_bytes) = sqlite_storage_status(path)?;
    Ok(LogStatus {
        entry_count: entry_count.max(0) as u64,
        file_count,
        total_bytes,
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
            source: parse_stored_log_source(&source)?,
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
