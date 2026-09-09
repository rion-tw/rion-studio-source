use crate::{CoreError, CoreResult, model::GraphicsSettingsSnapshotRecord};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::Path;

/// Synchronous, read-only bootstrap before the desktop shell is ready. Never migrates or repairs a store.
pub fn read_graphics_settings_at_startup(
    user_data_dir: &Path,
) -> CoreResult<GraphicsSettingsSnapshotRecord> {
    let path = user_data_dir.join("rion-studio.sqlite3");
    match path.try_exists() {
        Ok(false) => return Ok(GraphicsSettingsSnapshotRecord::default()),
        Err(error) => return Err(CoreError::StateDatabase(error.to_string())),
        Ok(true) => {}
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let has_settings: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    if !has_settings {
        return Ok(GraphicsSettingsSnapshotRecord::default());
    }
    let payload = connection
        .query_row(
            "SELECT payload_json FROM settings WHERE key='graphicsSettings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    payload
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                CoreError::StateDatabase(format!("stored graphicsSettings is invalid: {error}"))
            })
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

#[cfg(test)]
mod tests;
