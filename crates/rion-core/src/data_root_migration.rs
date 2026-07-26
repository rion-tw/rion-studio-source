use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, backup::Backup};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{CoreError, CoreResult};

const STATE_DATABASE: &str = "rion-studio.sqlite3";
const LOG_DATABASE: &str = "logs.sqlite3";
const INSTANCE_LOCK: &str = "rion-studio.instance.lock";
const ACTIVATION_ENDPOINT: &str = "rion-studio.activation.json";
const COMPLETION_MARKER: &str = ".rion-tauri-data-migration.json";
const JOURNAL_NAME: &str = ".rion-studio-data-migration.json";
const LOCK_NAME: &str = ".rion-studio-data-migration.lock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataRootMigrationOutcome {
    NotNeeded,
    AlreadyCompleted,
    Migrated { backup: Option<PathBuf> },
    Recovered,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionMarker {
    schema_version: u32,
    completed_at: String,
    source_path: String,
    source_fingerprint: String,
    app_version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationJournal {
    schema_version: u32,
    phase: MigrationPhase,
    source: PathBuf,
    destination: PathBuf,
    staging: PathBuf,
    backup: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum MigrationPhase {
    Staged,
    DestinationBackedUp,
    Installed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DatabaseSummary {
    schema_version: Option<i64>,
    counts: BTreeMap<String, i64>,
}

/// Moves the unpublished Electron-era data root into the stable Tauri data root.
///
/// The source is never renamed or deleted. A verified staging copy is installed by
/// atomic rename, while any pre-existing destination is retained as a timestamped
/// backup beside it. A completion marker prevents a later launch from overwriting
/// newer Tauri data with the legacy snapshot.
pub fn migrate_legacy_data_root(
    source: &Path,
    destination: &Path,
    app_version: &str,
) -> CoreResult<DataRootMigrationOutcome> {
    if source == destination {
        return Ok(DataRootMigrationOutcome::NotNeeded);
    }
    let parent = destination.parent().ok_or_else(|| {
        CoreError::Migration("stable data directory has no parent directory".to_owned())
    })?;
    fs::create_dir_all(parent).map_err(migration_error("create migration parent"))?;

    let migration_lock = open_lock(&parent.join(LOCK_NAME))?;
    migration_lock
        .try_lock_exclusive()
        .map_err(|_| CoreError::Domain {
            code: "DATA_ROOT_MIGRATION_LOCKED",
            message: "Another Rion Studio data migration is already running.".to_owned(),
        })?;

    let journal_path = parent.join(JOURNAL_NAME);
    if journal_path.is_file() {
        let _instance_locks = acquire_data_root_locks(source, destination)?;
        if recover_journal(&journal_path, source, destination)? {
            set_private_permissions(destination)?;
            return Ok(DataRootMigrationOutcome::Recovered);
        }
    }
    if has_valid_completion_marker(destination)? {
        set_private_permissions(destination)?;
        return Ok(DataRootMigrationOutcome::AlreadyCompleted);
    }
    if !source.is_dir() || !has_persistent_data(source) {
        return Ok(DataRootMigrationOutcome::NotNeeded);
    }

    let _instance_locks = acquire_data_root_locks(source, destination)?;
    let id = Uuid::new_v4();
    let staging = parent.join(format!(".Rion Studio.migrating-{id}"));
    let backup = if destination.exists() {
        Some(parent.join(format!(
            "Rion Studio.pre-migration-{}-{id}",
            Utc::now().format("%Y%m%dT%H%M%SZ")
        )))
    } else {
        None
    };

    let result = (|| -> CoreResult<DataRootMigrationOutcome> {
        fs::create_dir(&staging).map_err(migration_error("create migration staging"))?;
        let source_summary = copy_and_verify_tree(source, &staging)?;
        let source_fingerprint = fingerprint(&source_summary);
        let marker = CompletionMarker {
            schema_version: 1,
            completed_at: Utc::now().to_rfc3339(),
            source_path: source.to_string_lossy().into_owned(),
            source_fingerprint,
            app_version: app_version.to_owned(),
        };
        write_json_atomic(&staging.join(COMPLETION_MARKER), &marker)?;
        set_private_permissions(&staging)?;

        let mut journal = MigrationJournal {
            schema_version: 1,
            phase: MigrationPhase::Staged,
            source: source.to_path_buf(),
            destination: destination.to_path_buf(),
            staging: staging.clone(),
            backup: backup.clone(),
        };
        write_json_atomic(&journal_path, &journal)?;

        if let Some(backup_path) = &backup {
            fs::rename(destination, backup_path)
                .map_err(migration_error("back up existing stable data directory"))?;
            journal.phase = MigrationPhase::DestinationBackedUp;
            write_json_atomic(&journal_path, &journal)?;
        }
        if let Err(error) = fs::rename(&staging, destination) {
            if let Some(backup_path) = &backup
                && !destination.exists()
                && fs::rename(backup_path, destination).is_ok()
            {
                journal.phase = MigrationPhase::Staged;
                let _ = write_json_atomic(&journal_path, &journal);
            }
            return Err(CoreError::Migration(format!(
                "install migrated data directory: {error}"
            )));
        }
        journal.phase = MigrationPhase::Installed;
        write_json_atomic(&journal_path, &journal)?;
        set_private_permissions(destination)?;
        fs::remove_file(&journal_path).map_err(migration_error("finish migration journal"))?;
        Ok(DataRootMigrationOutcome::Migrated { backup })
    })();

    if result.is_err() && staging.exists() && !journal_path.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn acquire_data_root_locks(source: &Path, destination: &Path) -> CoreResult<Vec<File>> {
    let mut locks = Vec::new();
    for root in [source, destination] {
        let path = root.join(INSTANCE_LOCK);
        if !path.exists() {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(migration_error("open application instance lock"))?;
        file.try_lock_exclusive().map_err(|_| CoreError::Domain {
            code: "APP_INSTANCE_LOCKED",
            message: format!(
                "Rion Studio data is in use and cannot be migrated: {}",
                root.display()
            ),
        })?;
        locks.push(file);
    }
    Ok(locks)
}

fn open_lock(path: &Path) -> CoreResult<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(migration_error("open migration lock"))
}

fn recover_journal(path: &Path, source: &Path, destination: &Path) -> CoreResult<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let journal: MigrationJournal =
        serde_json::from_slice(&fs::read(path).map_err(migration_error("read migration journal"))?)
            .map_err(|error| CoreError::Migration(format!("parse migration journal: {error}")))?;
    validate_journal(&journal, source, destination)?;
    match journal.phase {
        MigrationPhase::Staged => {
            if !has_valid_completion_marker(&journal.destination)? {
                if journal.destination.exists() {
                    if let Some(backup) = &journal.backup {
                        fs::rename(&journal.destination, backup)
                            .map_err(migration_error("recover destination backup"))?;
                    } else {
                        return Err(CoreError::Migration(
                            "migration journal found an unexpected destination".to_owned(),
                        ));
                    }
                }
                fs::rename(&journal.staging, &journal.destination)
                    .map_err(migration_error("recover staged data"))?;
            }
        }
        MigrationPhase::DestinationBackedUp => {
            if journal.destination.exists()
                && !has_valid_completion_marker(&journal.destination)?
                && journal.staging.exists()
            {
                let backup = journal.backup.as_ref().ok_or_else(|| {
                    CoreError::Migration(
                        "migration recovery has no destination backup path".to_owned(),
                    )
                })?;
                if !backup.exists() {
                    fs::rename(&journal.destination, backup)
                        .map_err(migration_error("recover destination backup"))?;
                }
                fs::rename(&journal.staging, &journal.destination)
                    .map_err(migration_error("recover staged data after restored backup"))?;
            } else if !journal.destination.exists() {
                fs::rename(&journal.staging, &journal.destination)
                    .map_err(migration_error("recover staged data after backup"))?;
            }
        }
        MigrationPhase::Installed => {}
    }
    if !has_valid_completion_marker(&journal.destination)? {
        return Err(CoreError::Migration(
            "recovered data is missing its verified completion marker".to_owned(),
        ));
    }
    fs::remove_file(path).map_err(migration_error("remove recovered migration journal"))?;
    Ok(true)
}

fn validate_journal(
    journal: &MigrationJournal,
    source: &Path,
    destination: &Path,
) -> CoreResult<()> {
    let parent = destination.parent().ok_or_else(|| {
        CoreError::Migration("stable data directory has no parent directory".to_owned())
    })?;
    let staging_name = journal
        .staging
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let valid_backup = journal.backup.as_ref().is_none_or(|backup| {
        backup.parent() == Some(parent)
            && backup
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("Rion Studio.pre-migration-"))
            && backup != source
            && backup != destination
            && backup != &journal.staging
    });
    if journal.schema_version != 1
        || journal.source != source
        || journal.destination != destination
        || journal.staging.parent() != Some(parent)
        || !staging_name.starts_with(".Rion Studio.migrating-")
        || journal.staging == source
        || journal.staging == destination
        || !valid_backup
    {
        return Err(CoreError::Migration(
            "migration journal contains paths outside the expected data roots".to_owned(),
        ));
    }
    Ok(())
}

fn copy_and_verify_tree(source: &Path, destination: &Path) -> CoreResult<BTreeMap<String, String>> {
    let mut manifest = BTreeMap::new();
    copy_directory(source, destination, source, &mut manifest)?;
    for database in [STATE_DATABASE, LOG_DATABASE] {
        let source_path = source.join(database);
        if !source_path.is_file() {
            continue;
        }
        let destination_path = destination.join(database);
        online_backup(&source_path, &destination_path)?;
        let source_summary = database_summary(&source_path, database == STATE_DATABASE)?;
        let destination_summary = database_summary(&destination_path, database == STATE_DATABASE)?;
        if source_summary != destination_summary {
            return Err(CoreError::Migration(format!(
                "{database} row-count or schema verification failed"
            )));
        }
        manifest.insert(
            format!("database:{database}"),
            format!("{source_summary:?}"),
        );
    }
    verify_manifest(destination, &manifest)?;
    verify_role_directories(source, destination)?;
    Ok(manifest)
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    source_root: &Path,
    manifest: &mut BTreeMap<String, String>,
) -> CoreResult<()> {
    fs::create_dir_all(destination).map_err(migration_error("create copied directory"))?;
    for entry in fs::read_dir(source).map_err(migration_error("read source directory"))? {
        let entry = entry.map_err(migration_error("read source entry"))?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if should_exclude(&name_text) {
            continue;
        }
        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let file_type = entry
            .file_type()
            .map_err(migration_error("inspect source entry"))?;
        if file_type.is_dir() {
            if source_path == source_root.join("browser-host") {
                continue;
            }
            copy_directory(&source_path, &destination_path, source_root, manifest)?;
        } else if file_type.is_file() {
            let relative = source_path
                .strip_prefix(source_root)
                .map_err(|error| CoreError::Migration(error.to_string()))?;
            if matches!(relative.to_str(), Some(STATE_DATABASE | LOG_DATABASE)) {
                continue;
            }
            let hash = copy_hashed(&source_path, &destination_path)?;
            manifest.insert(path_key(relative), hash);
        } else if file_type.is_symlink() {
            copy_symlink(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn should_exclude(name: &str) -> bool {
    matches!(
        name,
        INSTANCE_LOCK | ACTIVATION_ENDPOINT | COMPLETION_MARKER
    ) || name.starts_with("Singleton")
        || name == "RunningChromeVersion"
        || name.ends_with("-wal")
        || name.ends_with("-shm")
        || name.ends_with("-journal")
        || name.ends_with(".tmp")
        || name.ends_with(".temp")
        || name.contains(".migrating")
}

fn copy_hashed(source: &Path, destination: &Path) -> CoreResult<String> {
    let mut input = File::open(source).map_err(migration_error("open source file"))?;
    let mut output = File::create(destination).map_err(migration_error("create copied file"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(migration_error("read source file"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(migration_error("write copied file"))?;
    }
    output
        .sync_all()
        .map_err(migration_error("sync copied file"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_manifest(root: &Path, manifest: &BTreeMap<String, String>) -> CoreResult<()> {
    for (relative, expected) in manifest {
        if relative.starts_with("database:") {
            continue;
        }
        let actual = hash_file(&root.join(relative))?;
        if &actual != expected {
            return Err(CoreError::Migration(format!(
                "copied file hash mismatch: {relative}"
            )));
        }
    }
    Ok(())
}

fn verify_role_directories(source: &Path, destination: &Path) -> CoreResult<()> {
    let source_roles = source.join("roles");
    if !source_roles.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&source_roles).map_err(migration_error("read role directories"))? {
        let entry = entry.map_err(migration_error("read role directory"))?;
        if entry.path().is_dir() && !destination.join("roles").join(entry.file_name()).is_dir() {
            return Err(CoreError::Migration(format!(
                "role browser directory was not migrated: {}",
                entry.file_name().to_string_lossy()
            )));
        }
    }
    Ok(())
}

fn online_backup(source: &Path, destination: &Path) -> CoreResult<()> {
    let source = Connection::open(source).map_err(migration_error("open source database"))?;
    let mut destination =
        Connection::open(destination).map_err(migration_error("open staging database"))?;
    Backup::new(&source, &mut destination)
        .and_then(|backup| backup.run_to_completion(64, Duration::from_millis(10), None))
        .map_err(|error| CoreError::Migration(format!("SQLite online backup failed: {error}")))?;
    validate_database(&destination)?;
    Ok(())
}

fn database_summary(path: &Path, state: bool) -> CoreResult<DatabaseSummary> {
    let connection =
        Connection::open(path).map_err(migration_error("open database for validation"))?;
    validate_database(&connection)?;
    let has_schema_migrations: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')",
            [],
            |row| row.get(0),
        )
        .map_err(migration_error("inspect database schema version"))?;
    let schema_version = if has_schema_migrations {
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(migration_error("read database schema"))?
            .flatten()
    } else {
        None
    };
    let tables: &[&str] = if state {
        &[
            "games",
            "roles",
            "workspaces",
            "workspace_slots",
            "macros",
            "settings",
            "legal_acceptance",
        ]
    } else {
        &["log_entries"]
    };
    let mut counts = BTreeMap::new();
    for table in tables {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .map_err(migration_error("inspect database schema"))?;
        if exists == 1 {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .map_err(migration_error("count migrated database rows"))?;
            counts.insert((*table).to_owned(), count);
        }
    }
    Ok(DatabaseSummary {
        schema_version,
        counts,
    })
}

fn validate_database(connection: &Connection) -> CoreResult<()> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(migration_error("check database integrity"))?;
    if integrity != "ok" {
        return Err(CoreError::Migration(format!(
            "database integrity check failed: {integrity}"
        )));
    }
    let foreign_keys: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(migration_error("check database foreign keys"))?;
    if foreign_keys != 0 {
        return Err(CoreError::Migration(format!(
            "database contains {foreign_keys} foreign-key violations"
        )));
    }
    Ok(())
}

fn has_persistent_data(root: &Path) -> bool {
    [
        STATE_DATABASE,
        LOG_DATABASE,
        "roles",
        "games.json",
        "roles.json",
    ]
    .iter()
    .any(|name| root.join(name).exists())
}

fn has_valid_completion_marker(root: &Path) -> CoreResult<bool> {
    let path = root.join(COMPLETION_MARKER);
    if !path.is_file() {
        return Ok(false);
    }
    let marker: CompletionMarker = serde_json::from_slice(
        &fs::read(path).map_err(migration_error("read data migration marker"))?,
    )
    .map_err(|error| CoreError::Migration(format!("parse data migration marker: {error}")))?;
    Ok(marker.schema_version == 1 && marker.source_fingerprint.len() == 64)
}

fn fingerprint(manifest: &BTreeMap<String, String>) -> String {
    let mut hasher = Sha256::new();
    for (path, value) in manifest {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0xff]);
    }
    format!("{:x}", hasher.finalize())
}

fn hash_file(path: &Path) -> CoreResult<String> {
    let mut file =
        File::open(path).map_err(migration_error("open copied file for verification"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(migration_error("read copied file for verification"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn path_key(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> CoreResult<()> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| CoreError::Migration(format!("serialize migration metadata: {error}")))?;
    let mut file =
        File::create(&temporary).map_err(migration_error("create migration metadata"))?;
    file.write_all(&bytes)
        .map_err(migration_error("write migration metadata"))?;
    file.sync_all()
        .map_err(migration_error("sync migration metadata"))?;
    fs::rename(&temporary, path).map_err(migration_error("install migration metadata"))?;
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> CoreResult<()> {
    let target = fs::read_link(source).map_err(migration_error("read source symlink"))?;
    std::os::unix::fs::symlink(target, destination).map_err(migration_error("copy source symlink"))
}

#[cfg(windows)]
fn copy_symlink(source: &Path, destination: &Path) -> CoreResult<()> {
    let target = fs::read_link(source).map_err(migration_error("read source symlink"))?;
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    }
    .map_err(migration_error("copy source symlink"))
}

#[cfg(unix)]
fn set_private_permissions(root: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;

    if !root.exists() {
        return Ok(());
    }
    let metadata =
        fs::symlink_metadata(root).map_err(migration_error("inspect migrated permissions"))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
    fs::set_permissions(root, fs::Permissions::from_mode(mode))
        .map_err(migration_error("restrict migrated permissions"))?;
    if metadata.is_dir() {
        for entry in fs::read_dir(root).map_err(migration_error("read migrated permissions"))? {
            let entry = entry.map_err(migration_error("read migrated permissions entry"))?;
            set_private_permissions(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn set_private_permissions(root: &Path) -> CoreResult<()> {
    rion_platform::restrict_directory_to_current_user(root)
        .map_err(|error| CoreError::Migration(error.to_string()))
}

fn migration_error<E: std::fmt::Display>(context: &'static str) -> impl FnOnce(E) -> CoreError {
    move |error| CoreError::Migration(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::tempdir;

    fn create_state_database(path: &Path, role_count: usize) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations VALUES(7, 'now');
                 CREATE TABLE roles(id TEXT PRIMARY KEY);
                 CREATE TABLE games(id TEXT PRIMARY KEY);
                 CREATE TABLE workspaces(id TEXT PRIMARY KEY);
                 CREATE TABLE workspace_slots(id TEXT PRIMARY KEY);
                 CREATE TABLE macros(id TEXT PRIMARY KEY);
                 CREATE TABLE settings(id TEXT PRIMARY KEY);
                 CREATE TABLE legal_acceptance(id TEXT PRIMARY KEY);",
            )
            .unwrap();
        for index in 0..role_count {
            connection
                .execute(
                    "INSERT INTO roles VALUES(?1)",
                    params![format!("role-{index}")],
                )
                .unwrap();
        }
    }

    fn populate_anonymous_legacy_fixture(path: &Path) {
        create_state_database(path, 11);
        let connection = Connection::open(path).unwrap();
        for index in 0..4 {
            connection
                .execute(
                    "INSERT INTO workspaces VALUES(?1)",
                    params![format!("workspace-{index}")],
                )
                .unwrap();
        }
        for index in 0..6 {
            connection
                .execute(
                    "INSERT INTO macros VALUES(?1)",
                    params![format!("macro-{index}")],
                )
                .unwrap();
        }
        connection
            .execute("INSERT INTO settings VALUES('appearance')", [])
            .unwrap();
        connection
            .execute("INSERT INTO legal_acceptance VALUES('2026-07-26')", [])
            .unwrap();
    }

    fn create_log_database(path: &Path, entry_count: usize) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE log_entries(
                   row_id INTEGER PRIMARY KEY,
                   id TEXT NOT NULL UNIQUE
                 );",
            )
            .unwrap();
        for index in 0..entry_count {
            connection
                .execute(
                    "INSERT INTO log_entries(id) VALUES(?1)",
                    params![format!("log-{index}")],
                )
                .unwrap();
        }
    }

    #[test]
    fn migrates_database_profiles_and_replaces_unpublished_destination_once() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(source.join("roles/role-1/browser")).unwrap();
        fs::write(source.join("roles/role-1/browser/Cookies"), b"session").unwrap();
        create_state_database(&source.join(STATE_DATABASE), 2);
        create_log_database(&source.join(LOG_DATABASE), 3);
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("test-only"), b"replace me").unwrap();

        let outcome = migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap();
        let backup = match outcome {
            DataRootMigrationOutcome::Migrated { backup: Some(path) } => path,
            other => panic!("unexpected outcome: {other:?}"),
        };
        assert_eq!(
            fs::read(destination.join("roles/role-1/browser/Cookies")).unwrap(),
            b"session"
        );
        assert!(backup.join("test-only").is_file());
        assert!(source.join(STATE_DATABASE).is_file());
        assert_eq!(
            database_summary(&destination.join(LOG_DATABASE), false)
                .unwrap()
                .counts["log_entries"],
            3
        );

        fs::write(destination.join("newer-tauri-data"), b"keep").unwrap();
        assert_eq!(
            migrate_legacy_data_root(&source, &destination, "1.0.1").unwrap(),
            DataRootMigrationOutcome::AlreadyCompleted
        );
        assert!(destination.join("newer-tauri-data").is_file());
    }

    #[test]
    fn anonymous_legacy_fixture_preserves_roles_workspaces_macros_and_assets() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(source.join("roles/role-0/browser")).unwrap();
        fs::create_dir_all(source.join("images")).unwrap();
        fs::write(
            source.join("roles/role-0/browser/session.bin"),
            b"anonymous-session-fixture",
        )
        .unwrap();
        fs::write(source.join("images/role-0.png"), b"anonymous-image").unwrap();
        populate_anonymous_legacy_fixture(&source.join(STATE_DATABASE));

        migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap();

        let summary = database_summary(&destination.join(STATE_DATABASE), true).unwrap();
        assert_eq!(summary.counts["roles"], 11);
        assert_eq!(summary.counts["workspaces"], 4);
        assert_eq!(summary.counts["macros"], 6);
        assert_eq!(summary.counts["settings"], 1);
        assert_eq!(summary.counts["legal_acceptance"], 1);
        assert_eq!(
            hash_file(&destination.join("roles/role-0/browser/session.bin")).unwrap(),
            hash_file(&source.join("roles/role-0/browser/session.bin")).unwrap()
        );
        assert_eq!(
            hash_file(&destination.join("images/role-0.png")).unwrap(),
            hash_file(&source.join("images/role-0.png")).unwrap()
        );
        assert!(source.join(STATE_DATABASE).is_file());
    }

    #[test]
    fn manifest_hash_mismatch_is_rejected() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("asset.bin"), b"copied-data").unwrap();
        let manifest = BTreeMap::from([("asset.bin".to_owned(), "0".repeat(64))]);

        let error = verify_manifest(directory.path(), &manifest).unwrap_err();

        assert!(error.to_string().contains("copied file hash mismatch"));
    }

    #[test]
    fn does_nothing_for_empty_legacy_root() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        assert_eq!(
            migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap(),
            DataRootMigrationOutcome::NotNeeded
        );
        assert!(!destination.exists());
    }

    #[test]
    fn rejects_corrupt_source_without_replacing_destination() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join(STATE_DATABASE), b"not sqlite").unwrap();
        fs::write(destination.join("safe"), b"still here").unwrap();

        assert!(migrate_legacy_data_root(&source, &destination, "1.0.0").is_err());
        assert_eq!(fs::read(destination.join("safe")).unwrap(), b"still here");
        assert!(source.join(STATE_DATABASE).is_file());
    }

    #[test]
    fn online_backup_includes_uncheckpointed_wal_rows() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        create_state_database(&source.join(STATE_DATABASE), 1);
        let connection = Connection::open(source.join(STATE_DATABASE)).unwrap();
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        connection
            .execute("INSERT INTO roles VALUES('role-from-wal')", [])
            .unwrap();

        migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap();

        assert_eq!(
            database_summary(&destination.join(STATE_DATABASE), true)
                .unwrap()
                .counts["roles"],
            2
        );
        assert!(source.join(format!("{STATE_DATABASE}-wal")).exists());
    }

    #[test]
    fn refuses_migration_while_source_instance_lock_is_held() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"[]").unwrap();
        let lock = open_lock(&source.join(INSTANCE_LOCK)).unwrap();
        lock.try_lock_exclusive().unwrap();

        let error = migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap_err();

        assert_eq!(error.code(), "APP_INSTANCE_LOCKED");
        assert!(!destination.exists());
        assert!(source.join("roles.json").is_file());
    }

    #[test]
    fn refuses_migration_while_unpublished_destination_instance_lock_is_held() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("roles.json"), b"[]").unwrap();
        let lock = open_lock(&destination.join(INSTANCE_LOCK)).unwrap();
        lock.try_lock_exclusive().unwrap();

        let error = migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap_err();

        assert_eq!(error.code(), "APP_INSTANCE_LOCKED");
        assert!(source.join("roles.json").is_file());
    }

    #[test]
    fn recovers_an_installed_staging_directory_before_the_phase_write() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        let staging = parent.path().join(".Rion Studio.migrating-test");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"source").unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("roles.json"), b"installed").unwrap();
        write_json_atomic(
            &destination.join(COMPLETION_MARKER),
            &CompletionMarker {
                schema_version: 1,
                completed_at: Utc::now().to_rfc3339(),
                source_path: source.to_string_lossy().into_owned(),
                source_fingerprint: "1".repeat(64),
                app_version: "1.0.0".to_owned(),
            },
        )
        .unwrap();
        write_json_atomic(
            &parent.path().join(JOURNAL_NAME),
            &MigrationJournal {
                schema_version: 1,
                phase: MigrationPhase::Staged,
                source: source.clone(),
                destination: destination.clone(),
                staging,
                backup: None,
            },
        )
        .unwrap();

        assert_eq!(
            migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap(),
            DataRootMigrationOutcome::Recovered
        );
        assert_eq!(
            fs::read(destination.join("roles.json")).unwrap(),
            b"installed"
        );
        assert_eq!(fs::read(source.join("roles.json")).unwrap(), b"source");
        assert!(!parent.path().join(JOURNAL_NAME).exists());
    }

    #[test]
    fn recovers_destination_backed_up_journal_without_touching_source() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        let staging = parent.path().join(".Rion Studio.migrating-test");
        let backup = parent.path().join("Rion Studio.pre-migration-test");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"source").unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("roles.json"), b"staged").unwrap();
        write_json_atomic(
            &staging.join(COMPLETION_MARKER),
            &CompletionMarker {
                schema_version: 1,
                completed_at: Utc::now().to_rfc3339(),
                source_path: source.to_string_lossy().into_owned(),
                source_fingerprint: "0".repeat(64),
                app_version: "1.0.0".to_owned(),
            },
        )
        .unwrap();
        write_json_atomic(
            &parent.path().join(JOURNAL_NAME),
            &MigrationJournal {
                schema_version: 1,
                phase: MigrationPhase::DestinationBackedUp,
                source: source.clone(),
                destination: destination.clone(),
                staging,
                backup: Some(backup),
            },
        )
        .unwrap();

        assert_eq!(
            migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap(),
            DataRootMigrationOutcome::Recovered
        );
        assert_eq!(fs::read(destination.join("roles.json")).unwrap(), b"staged");
        assert_eq!(fs::read(source.join("roles.json")).unwrap(), b"source");
        assert!(!parent.path().join(JOURNAL_NAME).exists());
    }

    #[test]
    fn installed_journal_is_finalized_without_recopying_the_source() {
        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        let staging = parent.path().join(".Rion Studio.migrating-test");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"legacy-source").unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("roles.json"), b"installed-data").unwrap();
        write_json_atomic(
            &destination.join(COMPLETION_MARKER),
            &CompletionMarker {
                schema_version: 1,
                completed_at: Utc::now().to_rfc3339(),
                source_path: source.to_string_lossy().into_owned(),
                source_fingerprint: "2".repeat(64),
                app_version: "1.0.0".to_owned(),
            },
        )
        .unwrap();
        write_json_atomic(
            &parent.path().join(JOURNAL_NAME),
            &MigrationJournal {
                schema_version: 1,
                phase: MigrationPhase::Installed,
                source: source.clone(),
                destination: destination.clone(),
                staging,
                backup: None,
            },
        )
        .unwrap();

        assert_eq!(
            migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap(),
            DataRootMigrationOutcome::Recovered
        );
        assert_eq!(
            fs::read(destination.join("roles.json")).unwrap(),
            b"installed-data"
        );
        assert_eq!(
            fs::read(source.join("roles.json")).unwrap(),
            b"legacy-source"
        );
    }

    #[test]
    fn rejects_a_journal_that_points_outside_the_expected_data_roots() {
        let parent = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"source").unwrap();
        write_json_atomic(
            &parent.path().join(JOURNAL_NAME),
            &MigrationJournal {
                schema_version: 1,
                phase: MigrationPhase::Staged,
                source: source.clone(),
                destination: outside.path().join("unexpected"),
                staging: outside.path().join(".Rion Studio.migrating-forged"),
                backup: None,
            },
        )
        .unwrap();

        let error = migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap_err();

        assert!(
            error
                .to_string()
                .contains("outside the expected data roots")
        );
        assert_eq!(fs::read(source.join("roles.json")).unwrap(), b"source");
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn permission_failure_never_replaces_existing_destination() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let protected = source.join("roles.json");
        fs::write(&protected, b"source").unwrap();
        fs::write(destination.join("safe"), b"destination").unwrap();
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o000)).unwrap();

        let result = migrate_legacy_data_root(&source, &destination, "1.0.0");
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o600)).unwrap();

        assert!(result.is_err());
        assert_eq!(fs::read(destination.join("safe")).unwrap(), b"destination");
        assert_eq!(fs::read(protected).unwrap(), b"source");
    }

    #[cfg(unix)]
    #[test]
    fn migrated_data_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempdir().unwrap();
        let source = parent.path().join("rion-studio");
        let destination = parent.path().join("Rion Studio");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("roles.json"), b"[]").unwrap();
        migrate_legacy_data_root(&source, &destination, "1.0.0").unwrap();
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(destination.join("roles.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
