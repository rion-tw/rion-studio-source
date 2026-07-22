use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::Connection;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

use super::{legacy, logs, portable_recovery, state};

pub const STATE_DATABASE_FILENAME: &str = "rion-studio.sqlite3";
pub const LOG_DATABASE_FILENAME: &str = "logs.sqlite3";

const LEGACY_STATE_FILES: &[&str] = &[
    "games.json",
    "roles.json",
    "profiles.json",
    "launch-workspaces.json",
    "macros.json",
    "game-browser-settings.json",
    "macro-settings.json",
    "runtime-window-preferences.json",
    "legal-acceptance.json",
    "game-compatibility.json",
    "background-activity-migration.json",
    "portable-import-transaction.json",
    "chrome-profile-import-transaction.json",
    "chrome-profile-import-previews.json",
];

#[derive(Debug, Clone)]
pub struct DatabasePaths {
    pub state: PathBuf,
    pub logs: PathBuf,
    pub migration_backup: Option<PathBuf>,
}

pub fn bootstrap_databases(user_data_dir: &Path) -> CoreResult<DatabasePaths> {
    fs::create_dir_all(user_data_dir).map_err(|error| {
        CoreError::Migration(format!("unable to create user data directory: {error}"))
    })?;
    let state_path = user_data_dir.join(STATE_DATABASE_FILENAME);
    let log_path = user_data_dir.join(LOG_DATABASE_FILENAME);
    portable_recovery::recover_legacy_json(user_data_dir)?;
    legacy::recover_chrome_profile_import(user_data_dir, &state_path)?;
    let needs_state = !state_path.exists();
    let needs_logs = !log_path.exists();
    if !needs_state && !needs_logs {
        return Ok(DatabasePaths {
            state: state_path,
            logs: log_path,
            migration_backup: None,
        });
    }

    let backup = create_backup_if_needed(user_data_dir)?;
    let suffix = format!("{}.{}", std::process::id(), Uuid::new_v4());
    let state_temp = user_data_dir.join(format!("{STATE_DATABASE_FILENAME}.{suffix}.migrating"));
    let logs_temp = user_data_dir.join(format!("{LOG_DATABASE_FILENAME}.{suffix}.migrating"));

    let mut installed_state = false;
    let mut migrated_roles = Vec::new();
    let result: CoreResult<()> = (|| {
        if needs_state {
            let mut connection = Connection::open(&state_temp)
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            state::create_schema(&connection, false)?;
            state::import_legacy_files(&mut connection, user_data_dir)?;
            validate_database(&connection, "state")?;
            validate_import_metadata(&connection)?;
            migrated_roles = connection
                .prepare("SELECT payload_json FROM roles ORDER BY ordinal")
                .map_err(|error| CoreError::Migration(error.to_string()))?
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| CoreError::Migration(error.to_string()))?
                .map(|row| {
                    row.map_err(|error| CoreError::Migration(error.to_string()))
                        .and_then(|raw| {
                            serde_json::from_str(&raw)
                                .map_err(|error| CoreError::Migration(error.to_string()))
                        })
                })
                .collect::<CoreResult<Vec<_>>>()?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            drop(connection);
        }
        if needs_logs {
            let mut connection = Connection::open(&logs_temp)
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            logs::create_schema(&connection, false)?;
            logs::import_legacy_logs(&mut connection, &user_data_dir.join("logs"))?;
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
        if needs_state {
            legacy::migrate_role_directories(user_data_dir, &migrated_roles)?;
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
        migration_backup: backup,
    })
}

fn validate_import_metadata(connection: &Connection) -> CoreResult<()> {
    let hash: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='snapshot_sha256'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    let row_count: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='snapshot_row_count'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| CoreError::Migration(error.to_string()))?;
    if hash.len() != 64 || row_count.parse::<u64>().is_err() {
        return Err(CoreError::Migration(
            "state import count/hash verification failed".to_owned(),
        ));
    }
    Ok(())
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

fn create_backup_if_needed(user_data_dir: &Path) -> CoreResult<Option<PathBuf>> {
    let has_legacy_state = LEGACY_STATE_FILES
        .iter()
        .any(|name| user_data_dir.join(name).is_file());
    let has_legacy_logs = user_data_dir.join("logs").is_dir();
    if !has_legacy_state && !has_legacy_logs {
        return Ok(None);
    }

    let name = format!("{}-{}", Utc::now().format("%Y%m%dT%H%M%SZ"), Uuid::new_v4());
    let backup = user_data_dir.join("migration-backups").join(name);
    fs::create_dir_all(&backup).map_err(|error| {
        CoreError::Migration(format!("unable to create migration backup: {error}"))
    })?;
    for name in LEGACY_STATE_FILES {
        let source = user_data_dir.join(name);
        if source.is_file() {
            copy_read_only(&source, &backup.join(name))?;
        }
    }
    let logs = user_data_dir.join("logs");
    if logs.is_dir() {
        copy_directory_read_only(&logs, &backup.join("logs"))?;
    }
    set_read_only(&backup)?;
    Ok(Some(backup))
}

fn copy_directory_read_only(source: &Path, destination: &Path) -> CoreResult<()> {
    fs::create_dir_all(destination)
        .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?;
    for entry in fs::read_dir(source)
        .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?
    {
        let entry =
            entry.map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?;
        let file_type = entry
            .file_type()
            .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory_read_only(&entry.path(), &target)?;
        } else if file_type.is_file() {
            copy_read_only(&entry.path(), &target)?;
        }
    }
    set_read_only(destination)?;
    Ok(())
}

fn copy_read_only(source: &Path, destination: &Path) -> CoreResult<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?;
    }
    fs::copy(source, destination)
        .map_err(|error| CoreError::Migration(format!("backup failed: {error}")))?;
    set_read_only(destination)
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
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn imports_legacy_files_once_and_keeps_a_read_only_backup() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("games.json"),
            r#"{"games":[{"id":"g1","name":"Game"}]}"#,
        )
        .unwrap();
        fs::write(directory.path().join("roles.json"), r#"{"roles":[]}"#).unwrap();

        let paths = bootstrap_databases(directory.path()).unwrap();

        assert!(paths.state.is_file());
        assert!(paths.logs.is_file());
        let backup = paths.migration_backup.unwrap();
        assert_eq!(
            fs::read_to_string(backup.join("games.json")).unwrap(),
            r#"{"games":[{"id":"g1","name":"Game"}]}"#
        );
        assert!(fs::metadata(&backup).unwrap().permissions().readonly());
        let connection = Connection::open(paths.state).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM games", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert!(
            bootstrap_databases(directory.path())
                .unwrap()
                .migration_backup
                .is_none()
        );
        make_writable(&backup);
    }

    #[test]
    fn failed_import_preserves_legacy_files_and_installs_no_database() {
        let directory = tempdir().unwrap();
        let source = r#"{"games":[{"id":"missing-name"}]}"#;
        fs::write(directory.path().join("games.json"), source).unwrap();

        assert!(bootstrap_databases(directory.path()).is_err());

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
        let backup_root = directory.path().join("migration-backups");
        if backup_root.is_dir() {
            make_writable(&backup_root);
        }
    }

    #[cfg(unix)]
    fn make_writable(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
        if path.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                make_writable(&entry.unwrap().path());
            }
        }
    }

    #[cfg(not(unix))]
    fn make_writable(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
        if path.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                make_writable(&entry.unwrap().path());
            }
        }
    }
}
