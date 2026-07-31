//! Recovery for interrupted imports written by the current SQLite portable flow.
//!
//! Retired JSON journals are deliberately rejected without applying changes.

use std::{fs, path::Path};

use serde_json::{Map, Value};
use uuid::{Uuid, Version};

use crate::error::{CoreError, CoreResult};

const JOURNAL_FILE: &str = "portable-import-transaction.json";
const STAGE_DIRECTORY: &str = "portable-import-transaction.stage";
const WORKSPACE_SCHEMA_VERSION: u64 = 7;

#[derive(Debug)]
pub(super) struct RecoveryPlan {
    pub snapshot_fields: Map<String, Value>,
    pub remove_created_role_ids: Vec<String>,
}

pub(super) fn load(user_data_dir: &Path) -> CoreResult<Option<RecoveryPlan>> {
    let journal_path = user_data_dir.join(JOURNAL_FILE);
    let raw = match fs::read_to_string(&journal_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_directory_if_present(&user_data_dir.join(STAGE_DIRECTORY))?;
            return Ok(None);
        }
        Err(error) => return Err(recovery_error(&journal_path, error)),
    };
    let journal = serde_json::from_str::<Value>(&raw).map_err(|error| {
        CoreError::Migration(format!("portable recovery journal is invalid: {error}"))
    })?;
    let object = journal.as_object().ok_or_else(|| {
        CoreError::Migration("portable recovery journal must be an object".to_owned())
    })?;
    if object.get("storageKind").and_then(Value::as_str) != Some("sqlite") {
        return Err(CoreError::UnsupportedDataVersion(
            "only SQLite portable recovery journals are supported".to_owned(),
        ));
    }
    if object
        .get("workspaceFileSchemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version != WORKSPACE_SCHEMA_VERSION)
    {
        return Err(CoreError::UnsupportedDataVersion(format!(
            "portable recovery workspace schema must be {WORKSPACE_SCHEMA_VERSION}"
        )));
    }
    let committed = match object.get("phase").and_then(Value::as_str) {
        Some("prepared") => false,
        Some("committed") => true,
        _ => {
            return Err(CoreError::Migration(
                "portable recovery phase must be prepared or committed".to_owned(),
            ));
        }
    };
    let created_role_ids = required_string_array(object, "createdRoleIds")?;
    for role_id in &created_role_ids {
        let uuid = Uuid::parse_str(role_id).map_err(|_| {
            CoreError::Migration("portable recovery contains an unsafe role id".to_owned())
        })?;
        if uuid.get_version() != Some(Version::Random) {
            return Err(CoreError::Migration(
                "portable recovery contains an unsafe role id".to_owned(),
            ));
        }
    }
    let mut snapshot_fields = Map::new();
    for (snapshot_key, original_key, target_key) in [
        ("games", "games", "targetGames"),
        ("roles", "roles", "targetRoles"),
        ("launchWorkspaces", "workspaces", "targetWorkspaces"),
        ("macros", "macros", "targetMacros"),
    ] {
        let key = if committed { target_key } else { original_key };
        let value = object
            .get(key)
            .filter(|value| value.is_array())
            .ok_or_else(|| {
                CoreError::Migration(format!("portable recovery requires array {key}"))
            })?;
        snapshot_fields.insert(snapshot_key.to_owned(), value.clone());
    }
    for (snapshot_key, original_key, target_key) in [
        (
            "gameBrowserSettings",
            "gameBrowserSettings",
            "targetGameBrowserSettings",
        ),
        ("macroSettings", "macroSettings", "targetMacroSettings"),
    ] {
        let key = if committed { target_key } else { original_key };
        if let Some(value) = object.get(key) {
            if !value.is_object() {
                return Err(CoreError::Migration(format!(
                    "portable recovery {key} must be an object"
                )));
            }
            snapshot_fields.insert(snapshot_key.to_owned(), value.clone());
        }
    }
    Ok(Some(RecoveryPlan {
        snapshot_fields,
        remove_created_role_ids: if committed {
            Vec::new()
        } else {
            created_role_ids
        },
    }))
}

pub(super) fn finish(user_data_dir: &Path, remove_created_role_ids: &[String]) -> CoreResult<()> {
    for role_id in remove_created_role_ids {
        remove_directory_if_present(&user_data_dir.join("roles").join(role_id))?;
    }
    remove_directory_if_present(&user_data_dir.join(STAGE_DIRECTORY))?;
    remove_file_if_present(&user_data_dir.join(JOURNAL_FILE))
}

fn required_string_array(object: &Map<String, Value>, key: &str) -> CoreResult<Vec<String>> {
    object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Migration(format!("portable recovery requires {key}")))?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                CoreError::Migration(format!("portable recovery {key} must contain strings"))
            })
        })
        .collect()
}

fn remove_directory_if_present(path: &Path) -> CoreResult<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(recovery_error(path, error)),
    }
}

fn remove_file_if_present(path: &Path) -> CoreResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(recovery_error(path, error)),
    }
}

fn recovery_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Migration(format!(
        "portable recovery failed for {}: {error}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn accepts_current_sqlite_recovery_journal() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join(JOURNAL_FILE),
            r#"{"storageKind":"sqlite","phase":"prepared","workspaceFileSchemaVersion":7,"createdRoleIds":[],"games":[],"roles":[],"workspaces":[],"macros":[]}"#,
        )
        .unwrap();

        assert!(load(directory.path()).unwrap().is_some());
    }

    #[test]
    fn rejects_retired_json_recovery_without_mutation() {
        let directory = tempdir().unwrap();
        let journal = r#"{"storageKind":"json","phase":"prepared","createdRoleIds":[],"games":[],"roles":[],"workspaces":[],"macros":[]}"#;
        fs::write(directory.path().join(JOURNAL_FILE), journal).unwrap();

        let error = load(directory.path()).unwrap_err();

        assert_eq!(error.code(), "CORE_DATA_VERSION_UNSUPPORTED");
        assert_eq!(
            fs::read_to_string(directory.path().join(JOURNAL_FILE)).unwrap(),
            journal
        );
    }
}
