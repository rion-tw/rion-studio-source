use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value, json};
use uuid::{Uuid, Version};

use crate::error::{CoreError, CoreResult};

const JOURNAL_FILE: &str = "portable-import-transaction.json";
const STAGE_DIRECTORY: &str = "portable-import-transaction.stage";
const WORKSPACE_SCHEMA_VERSION: u32 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StorageKind {
    Json,
    Sqlite,
}

pub(super) struct RecoveryPlan {
    pub storage_kind: StorageKind,
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
    let storage_kind = match object.get("storageKind").and_then(Value::as_str) {
        None | Some("json") => StorageKind::Json,
        Some("sqlite") => StorageKind::Sqlite,
        Some(value) => {
            return Err(CoreError::Migration(format!(
                "portable recovery storage kind is invalid: {value}"
            )));
        }
    };
    let committed = match object.get("phase").and_then(Value::as_str) {
        None | Some("prepared") => false,
        Some("committed") => true,
        Some(value) => {
            return Err(CoreError::Migration(format!(
                "portable recovery phase is invalid: {value}"
            )));
        }
    };
    if object
        .get("workspaceFileSchemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > u64::from(WORKSPACE_SCHEMA_VERSION))
    {
        return Err(CoreError::Migration(
            "portable recovery workspace schema is newer than this application".to_owned(),
        ));
    }
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
            .ok_or_else(|| CoreError::Migration(format!("portable recovery requires {key}")))?;
        if !value.is_array() {
            return Err(CoreError::Migration(format!(
                "portable recovery {key} must be an array"
            )));
        }
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
    normalize_workspace_policies(&mut snapshot_fields)?;
    Ok(Some(RecoveryPlan {
        storage_kind,
        snapshot_fields,
        remove_created_role_ids: if committed {
            Vec::new()
        } else {
            created_role_ids
        },
    }))
}

pub(super) fn recover_legacy_json(user_data_dir: &Path) -> CoreResult<bool> {
    let Some(plan) = load(user_data_dir)? else {
        return Ok(false);
    };
    if plan.storage_kind != StorageKind::Json {
        return Ok(false);
    }
    write_json_atomic(
        &user_data_dir.join("games.json"),
        &json!({ "games": field(&plan, "games")? }),
    )?;
    write_json_atomic(
        &user_data_dir.join("roles.json"),
        &json!({ "roles": field(&plan, "roles")? }),
    )?;
    write_json_atomic(
        &user_data_dir.join("launch-workspaces.json"),
        &json!({
            "schemaVersion": WORKSPACE_SCHEMA_VERSION,
            "workspaces": field(&plan, "launchWorkspaces")?
        }),
    )?;
    write_json_atomic(
        &user_data_dir.join("macros.json"),
        &json!({ "macros": field(&plan, "macros")? }),
    )?;
    for (key, filename) in [
        ("gameBrowserSettings", "game-browser-settings.json"),
        ("macroSettings", "macro-settings.json"),
    ] {
        if let Some(value) = plan.snapshot_fields.get(key) {
            write_json_atomic(&user_data_dir.join(filename), value)?;
        }
    }
    finish(user_data_dir, &plan.remove_created_role_ids)?;
    Ok(true)
}

pub(super) fn finish(user_data_dir: &Path, remove_created_role_ids: &[String]) -> CoreResult<()> {
    for role_id in remove_created_role_ids {
        // IDs were parsed as v4 UUIDs by `load`; joining a single validated path
        // component keeps recovery from escaping the application-owned roles root.
        remove_directory_if_present(&user_data_dir.join("roles").join(role_id))?;
    }
    remove_directory_if_present(&user_data_dir.join(STAGE_DIRECTORY))?;
    remove_file_if_present(&user_data_dir.join(JOURNAL_FILE))
}

fn field<'a>(plan: &'a RecoveryPlan, key: &str) -> CoreResult<&'a Value> {
    plan.snapshot_fields
        .get(key)
        .ok_or_else(|| CoreError::Migration(format!("portable recovery snapshot requires {key}")))
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

fn normalize_workspace_policies(fields: &mut Map<String, Value>) -> CoreResult<()> {
    let workspaces = fields
        .get_mut("launchWorkspaces")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            CoreError::Migration("portable recovery workspaces are invalid".to_owned())
        })?;
    for workspace in workspaces {
        let object = workspace.as_object_mut().ok_or_else(|| {
            CoreError::Migration("portable recovery workspace must be an object".to_owned())
        })?;
        let mode = object
            .get("resourcePolicy")
            .and_then(Value::as_object)
            .and_then(|policy| policy.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("adaptive");
        object.insert(
            "resourcePolicy".to_owned(),
            json!({ "mode": if mode == "unrestricted" { "unrestricted" } else { "adaptive" } }),
        );
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> CoreResult<()> {
    let parent = path.parent().ok_or_else(|| {
        CoreError::Migration(format!(
            "portable recovery path has no parent: {}",
            path.display()
        ))
    })?;
    fs::create_dir_all(parent).map_err(|error| recovery_error(parent, error))?;
    let temp = temporary_path(path);
    let result = (|| {
        let mut file = fs::File::create(&temp).map_err(|error| recovery_error(&temp, error))?;
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|error| CoreError::Migration(error.to_string()))?;
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| recovery_error(&temp, error))?;
        fs::rename(&temp, path).map_err(|error| recovery_error(path, error))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("portable-recovery");
    path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()))
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
    fn legacy_prepared_journal_restores_original_files_and_removes_created_role() {
        let directory = tempdir().unwrap();
        let role_id = "12345678-1234-4123-8123-123456789abc";
        fs::create_dir_all(directory.path().join("roles").join(role_id).join("browser")).unwrap();
        fs::write(
            directory.path().join(JOURNAL_FILE),
            format!(
                r#"{{"createdRoleIds":["{role_id}"],"games":[],"roles":[],"workspaces":[],"macros":[]}}"#
            ),
        )
        .unwrap();

        assert!(recover_legacy_json(directory.path()).unwrap());

        assert!(!directory.path().join(JOURNAL_FILE).exists());
        assert!(!directory.path().join("roles").join(role_id).exists());
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(directory.path().join("launch-workspaces.json")).unwrap()
            )
            .unwrap()["schemaVersion"],
            WORKSPACE_SCHEMA_VERSION
        );
    }

    #[test]
    fn unsafe_role_id_keeps_journal_and_never_removes_outside_paths() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join(JOURNAL_FILE),
            r#"{"createdRoleIds":["../outside"],"games":[],"roles":[],"workspaces":[],"macros":[]}"#,
        )
        .unwrap();

        assert!(recover_legacy_json(directory.path()).is_err());
        assert!(directory.path().join(JOURNAL_FILE).exists());
    }
}
