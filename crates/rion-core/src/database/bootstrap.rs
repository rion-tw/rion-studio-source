use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{Connection, OpenFlags, OptionalExtension, backup::Backup};
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

use super::{RETIRED_DATA_MARKERS, logs, state};

pub const STATE_DATABASE_FILENAME: &str = "rion-studio.sqlite3";
pub const LOG_DATABASE_FILENAME: &str = "logs.sqlite3";

#[derive(Debug, Clone)]
pub struct DatabasePaths {
    pub state: PathBuf,
    pub logs: PathBuf,
    pub migration_backup: Option<PathBuf>,
}

pub fn preflight_supported_data(user_data_dir: &Path) -> CoreResult<()> {
    if !user_data_dir.exists() {
        return Ok(());
    }
    let state_path = user_data_dir.join(STATE_DATABASE_FILENAME);
    let retired_marker = RETIRED_DATA_MARKERS
        .iter()
        .map(|name| user_data_dir.join(name))
        .find(|path| path.exists())
        .or_else(|| {
            user_data_dir
                .join("logs")
                .is_dir()
                .then(|| user_data_dir.join("logs"))
        });
    if !state_path.is_file() {
        if let Some(marker) = retired_marker {
            return Err(CoreError::UnsupportedDataVersion(format!(
                "retired metadata was found at {}; only SQLite schemas 19 through {} are supported",
                marker.display(),
                state::SCHEMA_VERSION
            )));
        }
        return Ok(());
    }

    let connection = Connection::open_with_flags(&state_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?;
    let has_schema_table = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .is_some();
    if !has_schema_table {
        return Err(CoreError::UnsupportedDataVersion(
            "the state database predates the supported SQLite schema".to_owned(),
        ));
    }
    let version = connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<u32>>(0)
        })
        .map_err(|error| CoreError::StateDatabase(error.to_string()))?
        .unwrap_or(0);
    if !(19..=state::SCHEMA_VERSION).contains(&version) {
        return Err(CoreError::UnsupportedDataVersion(format!(
            "SQLite schema {version} is unsupported; expected 19 through {}",
            state::SCHEMA_VERSION
        )));
    }
    Ok(())
}

pub fn bootstrap_databases(user_data_dir: &Path) -> CoreResult<DatabasePaths> {
    preflight_supported_data(user_data_dir)?;
    fs::create_dir_all(user_data_dir).map_err(|error| {
        CoreError::Migration(format!("unable to create user data directory: {error}"))
    })?;
    let state_path = user_data_dir.join(STATE_DATABASE_FILENAME);
    let log_path = user_data_dir.join(LOG_DATABASE_FILENAME);
    let needs_state = !state_path.exists();
    let needs_logs = !log_path.exists();
    if !needs_state && !needs_logs {
        return Ok(DatabasePaths {
            state: state_path,
            logs: log_path,
            migration_backup: None,
        });
    }

    let suffix = format!("{}.{}", std::process::id(), Uuid::new_v4());
    let state_temp = user_data_dir.join(format!("{STATE_DATABASE_FILENAME}.{suffix}.migrating"));
    let logs_temp = user_data_dir.join(format!("{LOG_DATABASE_FILENAME}.{suffix}.migrating"));

    let mut installed_state = false;
    let result: CoreResult<()> = (|| {
        if needs_state {
            let connection = Connection::open(&state_temp)
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            state::create_schema(&connection, false)?;
            validate_database(&connection, "state")?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            drop(connection);
        }
        if needs_logs {
            let connection = Connection::open(&logs_temp)
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            logs::create_schema(&connection, false)?;
            validate_database(&connection, "logs")?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            drop(connection);
        }
        if needs_state {
            fs::rename(&state_temp, &state_path).map_err(|error| {
                CoreError::Migration(format!("unable to install state database: {error}"))
            })?;
            installed_state = true;
        }
        if needs_logs {
            fs::rename(&logs_temp, &log_path).map_err(|error| {
                CoreError::Migration(format!("unable to install log database: {error}"))
            })?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&state_temp);
        let _ = fs::remove_file(&logs_temp);
        if installed_state {
            let _ = fs::remove_file(&state_path);
        }
    }
    result?;

    Ok(DatabasePaths {
        state: state_path,
        logs: log_path,
        migration_backup: None,
    })
}

pub fn create_online_startup_backup(
    user_data_dir: &Path,
    label: &str,
    app_version: &str,
) -> CoreResult<Option<PathBuf>> {
    if label.is_empty()
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CoreError::InvalidInput(
            "startup backup label contains unsupported characters".to_owned(),
        ));
    }
    let sources = [
        (
            STATE_DATABASE_FILENAME,
            user_data_dir.join(STATE_DATABASE_FILENAME),
        ),
        (
            LOG_DATABASE_FILENAME,
            user_data_dir.join(LOG_DATABASE_FILENAME),
        ),
    ];
    if sources.iter().all(|(_, source)| !source.is_file()) {
        return Ok(None);
    }
    let name = format!(
        "{}-{}-{}",
        Utc::now().format("%Y%m%dT%H%M%SZ"),
        label,
        Uuid::new_v4()
    );
    let backup_dir = user_data_dir.join("shell-migration-backups").join(name);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
    let result: CoreResult<()> = (|| {
        let mut copied = Vec::new();
        for (filename, source_path) in &sources {
            if !source_path.is_file() {
                continue;
            }
            let source = Connection::open(source_path)
                .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
            let destination_path = backup_dir.join(filename);
            let mut destination = Connection::open(&destination_path)
                .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
            Backup::new(&source, &mut destination)
                .and_then(|backup| backup.run_to_completion(64, Duration::from_millis(10), None))
                .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
            validate_database(&destination, filename)?;
            drop(destination);
            set_read_only(&destination_path)?;
            copied.push((*filename).to_owned());
        }
        let manifest = serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "createdAt": Utc::now().to_rfc3339(),
            "label": label,
            "appVersion": app_version,
            "files": copied
        }))
        .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
        fs::write(backup_dir.join("manifest.json"), manifest)
            .map_err(|error| CoreError::Migration(format!("startup backup failed: {error}")))?;
        set_read_only(&backup_dir.join("manifest.json"))?;
        set_read_only(&backup_dir)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(error);
    }
    Ok(Some(backup_dir))
}

fn validate_database(connection: &Connection, label: &str) -> CoreResult<()> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    if integrity != "ok" {
        return Err(CoreError::Migration(format!(
            "{label} database integrity check failed: {integrity}"
        )));
    }
    let foreign_key_error_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    if foreign_key_error_count != 0 {
        return Err(CoreError::Migration(format!(
            "{label} database contains {foreign_key_error_count} foreign-key violations"
        )));
    }
    Ok(())
}

fn set_read_only(path: &Path) -> CoreResult<()> {
    let mut permissions = fs::metadata(path)
        .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
        .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn creates_fresh_schema_twenty_eight_databases() {
        let directory = tempdir().unwrap();
        let paths = bootstrap_databases(directory.path()).unwrap();

        assert!(paths.state.is_file());
        assert!(paths.logs.is_file());
        assert!(paths.migration_backup.is_none());
        let connection = Connection::open(paths.state).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, u32>(0)
                })
                .unwrap(),
            28
        );
    }

    #[test]
    fn retired_json_is_rejected_without_writes() {
        let directory = tempdir().unwrap();
        let source = r#"{"games":[{"id":"g1","name":"Game"}]}"#;
        fs::write(directory.path().join("games.json"), source).unwrap();

        let error = bootstrap_databases(directory.path()).unwrap_err();

        assert_eq!(error.code(), "CORE_DATA_VERSION_UNSUPPORTED");
        assert_eq!(
            fs::read_to_string(directory.path().join("games.json")).unwrap(),
            source
        );
        assert!(!directory.path().join(STATE_DATABASE_FILENAME).exists());
        assert!(!directory.path().join(LOG_DATABASE_FILENAME).exists());
        let leftovers = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".migrating"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty());
    }
}
