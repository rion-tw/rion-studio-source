use super::Result;
use crate::session_transfer::{
    RoleSessionTransferBytesRecord as Bytes, RoleSessionTransferLocalStorageEntryRecord as Entry,
};
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeSet, path::Path};

/// Reads only a run-owned snapshot, with its WAL next to the database. Calling
/// SQLite without immutable=1 is essential: immutable would omit committed WAL.
pub(crate) fn read(path: &Path) -> Result<Vec<Entry>> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "WEBKIT_SQLITE_INVALID")?;
    connection
        .execute_batch("PRAGMA query_only=ON; BEGIN;")
        .map_err(|_| "WEBKIT_SQLITE_READ_FAILED")?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| "WEBKIT_SQLITE_INVALID")?;
    if integrity != "ok" {
        return Err("WEBKIT_SQLITE_INVALID");
    }
    let mut schema = connection
        .prepare("PRAGMA table_info(ItemTable)")
        .map_err(|_| "WEBKIT_SQLITE_SCHEMA_UNKNOWN")?;
    let columns = schema
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(|_| "WEBKIT_SQLITE_SCHEMA_UNKNOWN")?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "WEBKIT_SQLITE_SCHEMA_UNKNOWN")?;
    if columns
        != [
            ("key".to_owned(), "TEXT".to_owned()),
            ("value".to_owned(), "BLOB".to_owned()),
        ]
    {
        return Err("WEBKIT_SQLITE_SCHEMA_UNKNOWN");
    }
    let mut query = connection
        .prepare("SELECT key, value FROM ItemTable ORDER BY key")
        .map_err(|_| "WEBKIT_SQLITE_SCHEMA_UNKNOWN")?;
    let records = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|_| "WEBKIT_SQLITE_READ_FAILED")?;
    let mut entries = Vec::new();
    let mut keys = BTreeSet::new();
    let mut bytes = 0;
    for record in records {
        let (key, value) = record.map_err(|_| "WEBKIT_SQLITE_READ_FAILED")?;
        if value.len() % 2 != 0 {
            return Err("WEBKIT_UTF16_INVALID");
        }
        if !keys.insert(key.clone()) {
            return Err("WEBKIT_DUPLICATE_KEY");
        }
        bytes += key.len() + value.len();
        if entries.len() >= 100_000 || bytes > 40 * 1024 * 1024 {
            return Err("WEBKIT_ENTRY_LIMIT");
        }
        let units = value
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        entries.push(Entry {
            key: Bytes::from_utf16_le_code_units(&key.encode_utf16().collect::<Vec<_>>()),
            value: Bytes::from_utf16_le_code_units(&units),
        });
    }
    Ok(entries)
}
