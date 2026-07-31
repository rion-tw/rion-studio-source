fn enforce_retention_with_policy(
    connection: &Connection,
    retention: RetentionPolicy,
) -> CoreResult<()> {
    debug_assert!(retention.target_bytes <= retention.max_bytes);
    debug_assert!(retention.delete_batch_size > 0);
    let cutoff = (Utc::now() - ChronoDuration::days(retention.retention_days)).to_rfc3339();
    let expired = connection
        .execute(
            "DELETE FROM log_entries WHERE timestamp < ?1",
            params![cutoff],
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    let mut size = database_size(connection)?;
    if expired > 0 || size > retention.max_bytes {
        reclaim_unused_space(connection)?;
        size = database_size(connection)?;
    }
    if size <= retention.max_bytes {
        return Ok(());
    }

    while size > retention.target_bytes {
        let removed = connection
            .execute(
                "DELETE FROM log_entries WHERE row_id IN (
                   SELECT row_id
                   FROM log_entries
                   WHERE row_id != (
                     SELECT row_id
                     FROM log_entries
                     ORDER BY timestamp DESC, row_id DESC
                     LIMIT 1
                   )
                   ORDER BY timestamp, row_id
                   LIMIT ?1
                 )",
                params![retention.delete_batch_size as i64],
            )
            .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
        if removed == 0 {
            break;
        }
        reclaim_unused_space(connection)?;
        size = database_size(connection)?;
    }
    Ok(())
}

fn reclaim_unused_space(connection: &Connection) -> CoreResult<()> {
    connection
        .execute(
            "INSERT INTO log_entries_fts(log_entries_fts) VALUES ('rebuild')",
            [],
        )
        .map_err(|error| CoreError::LogDatabase(error.to_string()))?;
    run_pragma(connection, "wal_checkpoint", "TRUNCATE")?;
    run_pragma(connection, "incremental_vacuum", i32::MAX)?;
    run_pragma(connection, "wal_checkpoint", "TRUNCATE")?;
    Ok(())
}

fn run_pragma(connection: &Connection, name: &str, value: impl rusqlite::ToSql) -> CoreResult<()> {
    connection
        .pragma(None, name, value, |_| Ok(()))
        .map_err(|error| CoreError::LogDatabase(error.to_string()))
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

fn sqlite_storage_status(path: &Path) -> CoreResult<(u64, u64)> {
    let mut file_count = 0_u64;
    let mut total_bytes = 0_u64;
    for path in sqlite_file_paths(path) {
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {
                file_count = file_count.saturating_add(1);
                total_bytes = total_bytes.saturating_add(metadata.len());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(CoreError::LogDatabase(error.to_string())),
        }
    }
    Ok((file_count, total_bytes))
}

fn sqlite_file_paths(path: &Path) -> [PathBuf; 3] {
    let sidecar = |suffix: &str| {
        let mut value = path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    };
    [path.to_path_buf(), sidecar("-wal"), sidecar("-shm")]
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

fn stored_log_source_values(source: &LogSource) -> &'static [&'static str] {
    match source {
        LogSource::Main => &["main"],
        LogSource::Preload => &["preload"],
        LogSource::Renderer => &["renderer"],
        LogSource::Ipc => &["ipc"],
        LogSource::Browser => &["browser"],
        LogSource::Macro => &["macro"],
        LogSource::Persistence => &["persistence"],
        LogSource::Update => &["update"],
    }
}

fn parse_stored_log_source(source: &str) -> CoreResult<LogSource> {
    serde_json::from_value(Value::String(source.to_owned()))
        .map_err(|error| CoreError::LogDatabase(error.to_string()))
}

fn parse_context_json(value: &str) -> CoreResult<BTreeMap<String, Value>> {
    serde_json::from_str(value).map_err(|error| CoreError::LogDatabase(error.to_string()))
}
