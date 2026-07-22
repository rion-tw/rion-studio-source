use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

const DEFAULT_MODE: &str = "automatic";

pub fn read_graphics_mode(user_data_dir: &Path) -> String {
    read_sqlite_mode(&user_data_dir.join("rion-studio.sqlite3"))
        .or_else(|| read_legacy_mode(&user_data_dir.join("game-browser-settings.json")))
        .unwrap_or_else(|| DEFAULT_MODE.to_owned())
}

fn read_sqlite_mode(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let payload = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='gameBrowserSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()??;
    read_mode(&serde_json::from_str(&payload).ok()?)
}

fn read_legacy_mode(path: &Path) -> Option<String> {
    let payload = fs::read(path).ok()?;
    read_mode(&serde_json::from_slice(&payload).ok()?)
}

fn read_mode(value: &Value) -> Option<String> {
    value
        .get("graphics")?
        .get("mode")?
        .as_str()
        .filter(|mode| matches!(*mode, "automatic" | "high_performance" | "experimental"))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use rusqlite::params;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn reads_sqlite_as_the_authoritative_bootstrap_source() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"experimental"}}"#,
        )
        .unwrap();
        let connection = Connection::open(directory.path().join("rion-studio.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings(key TEXT PRIMARY KEY, payload_json TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO settings(key, payload_json) VALUES (?1, ?2)",
                params![
                    "gameBrowserSettings",
                    r#"{"graphics":{"mode":"high_performance"}}"#
                ],
            )
            .unwrap();

        assert_eq!(read_graphics_mode(directory.path()), "high_performance");
    }

    #[test]
    fn reads_legacy_before_first_migration_and_defaults_invalid_values() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"experimental"}}"#,
        )
        .unwrap();
        assert_eq!(read_graphics_mode(directory.path()), "experimental");

        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"unsafe"}}"#,
        )
        .unwrap();
        assert_eq!(read_graphics_mode(directory.path()), DEFAULT_MODE);
    }
}
