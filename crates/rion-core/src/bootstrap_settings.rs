use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use crate::model::BrowserGraphicsSettingsRecord;

pub fn read_graphics_settings(user_data_dir: &Path) -> String {
    let settings = read_sqlite_settings(&user_data_dir.join("rion-studio.sqlite3"))
        .or_else(|| read_legacy_settings(&user_data_dir.join("game-browser-settings.json")))
        .unwrap_or_else(BrowserGraphicsSettingsRecord::aggressive_default);
    serde_json::to_string(&settings).unwrap_or_else(|_| {
        serde_json::to_string(&BrowserGraphicsSettingsRecord::aggressive_default())
            .expect("graphics settings must serialize")
    })
}

fn read_sqlite_settings(path: &Path) -> Option<BrowserGraphicsSettingsRecord> {
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
    read_settings(&serde_json::from_str(&payload).ok()?)
}

fn read_legacy_settings(path: &Path) -> Option<BrowserGraphicsSettingsRecord> {
    let payload = fs::read(path).ok()?;
    read_settings(&serde_json::from_slice(&payload).ok()?)
}

fn read_settings(value: &Value) -> Option<BrowserGraphicsSettingsRecord> {
    serde_json::from_value(value.get("graphics")?.clone()).ok()
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

        let settings: BrowserGraphicsSettingsRecord =
            serde_json::from_str(&read_graphics_settings(directory.path())).unwrap();
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("high_performance")
        );
    }

    #[test]
    fn reads_legacy_before_first_migration_and_defaults_invalid_values() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"experimental"}}"#,
        )
        .unwrap();
        let settings: BrowserGraphicsSettingsRecord =
            serde_json::from_str(&read_graphics_settings(directory.path())).unwrap();
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("experimental")
        );

        fs::write(
            directory.path().join("game-browser-settings.json"),
            r#"{"graphics":{"mode":"unsafe"}}"#,
        )
        .unwrap();
        let settings: BrowserGraphicsSettingsRecord =
            serde_json::from_str(&read_graphics_settings(directory.path())).unwrap();
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::from_legacy_mode("automatic")
        );
    }

    #[test]
    fn defaults_new_installations_to_aggressive_graphics_settings() {
        let directory = tempdir().unwrap();
        let settings: BrowserGraphicsSettingsRecord =
            serde_json::from_str(&read_graphics_settings(directory.path())).unwrap();
        assert_eq!(
            settings,
            BrowserGraphicsSettingsRecord::aggressive_default()
        );
    }
}
