use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use crate::{
    error::{CoreError, CoreResult},
    model::RolePathsRecord,
};
use sha2::{Digest, Sha256};

const REMOVE_RETRIES: usize = 8;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(100);

pub fn paths(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    validate_role_id(role_id)?;
    let browser_user_data_dir = browser_directory(user_data_dir, role_id);
    Ok(RolePathsRecord {
        browser_user_data_dir: browser_user_data_dir.to_string_lossy().into_owned(),
        electron_browser_user_data_dir: browser_user_data_dir.to_string_lossy().into_owned(),
        system_browser_data_dir: browser_user_data_dir
            .join("system")
            .to_string_lossy()
            .into_owned(),
        webview2_user_data_dir: browser_user_data_dir
            .join("webview2")
            .to_string_lossy()
            .into_owned(),
        webkit_data_store_key: format!("role:{role_id}:wkwebview"),
        webkit_data_store_identifier: webkit_data_store_identifier(role_id),
    })
}

fn webkit_data_store_identifier(role_id: &str) -> String {
    let digest = Sha256::digest(format!("rion-studio:wkwebsite-data-store:{role_id}"));
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // RFC 9562 UUIDv8 is reserved for application-defined deterministic UUIDs.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

pub fn ensure(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    let paths = paths(user_data_dir, role_id)?;
    fs::create_dir_all(&paths.browser_user_data_dir)
        .map_err(|error| io_error(Path::new(&paths.browser_user_data_dir), error))?;
    for directory in [
        &paths.system_browser_data_dir,
        &paths.webview2_user_data_dir,
    ] {
        fs::create_dir_all(directory).map_err(|error| io_error(Path::new(directory), error))?;
    }
    Ok(paths)
}

pub fn reset(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    let paths = paths(user_data_dir, role_id)?;
    let directory = Path::new(&paths.browser_user_data_dir);
    remove_with_retry(directory)?;
    ensure(user_data_dir, role_id)
}

pub fn remove(user_data_dir: &Path, role_id: &str) -> CoreResult<()> {
    validate_role_id(role_id)?;
    remove_with_retry(&user_data_dir.join("roles").join(role_id))
}

pub fn quarantine(user_data_dir: &Path, role_id: &str, operation_id: &str) -> CoreResult<bool> {
    validate_role_id(role_id)?;
    validate_operation_id(operation_id)?;
    let source = user_data_dir.join("roles").join(role_id);
    if !source.exists() {
        return Ok(false);
    }
    let target = quarantine_directory(user_data_dir, operation_id);
    if target.exists() {
        return Err(CoreError::Platform(format!(
            "role quarantine already exists: {}",
            target.display()
        )));
    }
    let parent = target
        .parent()
        .ok_or_else(|| CoreError::Internal("role quarantine has no parent".to_owned()))?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    fs::rename(&source, &target).map_err(|error| io_error(&source, error))?;
    Ok(true)
}

pub fn restore_quarantine(
    user_data_dir: &Path,
    role_id: &str,
    operation_id: &str,
) -> CoreResult<()> {
    validate_role_id(role_id)?;
    validate_operation_id(operation_id)?;
    let source = quarantine_directory(user_data_dir, operation_id);
    if !source.exists() {
        return Ok(());
    }
    let target = user_data_dir.join("roles").join(role_id);
    if target.exists() {
        return Err(CoreError::Platform(format!(
            "role directory exists while restoring quarantine: {}",
            target.display()
        )));
    }
    fs::rename(&source, &target).map_err(|error| io_error(&source, error))
}

pub fn discard_quarantine(user_data_dir: &Path, operation_id: &str) -> CoreResult<()> {
    validate_operation_id(operation_id)?;
    remove_with_retry(&quarantine_directory(user_data_dir, operation_id))
}

fn browser_directory(user_data_dir: &Path, role_id: &str) -> PathBuf {
    user_data_dir.join("roles").join(role_id).join("browser")
}

fn quarantine_directory(user_data_dir: &Path, operation_id: &str) -> PathBuf {
    user_data_dir
        .join("roles")
        .join(".quarantine")
        .join(operation_id)
}

fn remove_with_retry(path: &Path) -> CoreResult<()> {
    for attempt in 0..=REMOVE_RETRIES {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) if attempt < REMOVE_RETRIES => {
                let _ = error;
                thread::sleep(REMOVE_RETRY_DELAY);
            }
            Err(error) => return Err(io_error(path, error)),
        }
    }
    Ok(())
}

fn validate_role_id(role_id: &str) -> CoreResult<()> {
    if role_id.is_empty()
        || role_id == "."
        || role_id == ".."
        || role_id.contains('/')
        || role_id.contains('\\')
        || role_id.chars().any(|character| character <= '\u{1f}')
    {
        Err(CoreError::InvalidInput("Role id is invalid.".to_owned()))
    } else {
        Ok(())
    }
}

fn validate_operation_id(operation_id: &str) -> CoreResult<()> {
    if operation_id.len() > 128
        || operation_id.is_empty()
        || !operation_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        Err(CoreError::InvalidInput(
            "Operation id is invalid.".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn io_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn ensures_resets_and_removes_isolated_role_directories() {
        let directory = tempdir().unwrap();
        let paths = ensure(directory.path(), "role-1").unwrap();
        let browser = Path::new(&paths.browser_user_data_dir);
        let system = Path::new(&paths.system_browser_data_dir);
        let webview2 = Path::new(&paths.webview2_user_data_dir);
        assert_eq!(
            paths.electron_browser_user_data_dir,
            paths.browser_user_data_dir
        );
        assert_eq!(paths.webkit_data_store_key, "role:role-1:wkwebview");
        assert_eq!(
            paths.webkit_data_store_identifier,
            webkit_data_store_identifier("role-1")
        );
        assert_eq!(
            paths.webkit_data_store_identifier,
            super::paths(directory.path(), "role-1")
                .unwrap()
                .webkit_data_store_identifier
        );
        assert_ne!(
            paths.webkit_data_store_identifier,
            webkit_data_store_identifier("role-2")
        );
        assert!(system.is_dir());
        assert!(webview2.is_dir());
        fs::write(browser.join("session"), b"state").unwrap();
        fs::write(system.join("locator.json"), b"{}").unwrap();
        fs::write(webview2.join("cookie-store"), b"state").unwrap();

        let reset_paths = reset(directory.path(), "role-1").unwrap();
        assert!(browser.is_dir());
        assert!(!browser.join("session").exists());
        assert!(Path::new(&reset_paths.system_browser_data_dir).is_dir());
        assert!(Path::new(&reset_paths.webview2_user_data_dir).is_dir());
        assert!(!system.join("locator.json").exists());
        assert!(!webview2.join("cookie-store").exists());

        remove(directory.path(), "role-1").unwrap();
        assert!(!directory.path().join("roles/role-1").exists());
    }

    #[test]
    fn rejects_role_id_path_traversal() {
        let directory = tempdir().unwrap();
        for role_id in ["", ".", "..", "../escape", "nested/role", "nested\\role"] {
            assert!(paths(directory.path(), role_id).is_err());
        }
    }

    #[test]
    fn quarantines_restores_and_discards_role_directories() {
        let directory = tempdir().unwrap();
        let browser = PathBuf::from(
            ensure(directory.path(), "role-1")
                .unwrap()
                .browser_user_data_dir,
        );
        fs::write(browser.join("session"), b"state").unwrap();

        assert!(quarantine(directory.path(), "role-1", "operation-1").unwrap());
        assert!(!directory.path().join("roles/role-1").exists());
        restore_quarantine(directory.path(), "role-1", "operation-1").unwrap();
        assert!(browser.join("session").exists());

        quarantine(directory.path(), "role-1", "operation-2").unwrap();
        discard_quarantine(directory.path(), "operation-2").unwrap();
        assert!(!directory.path().join("roles/role-1").exists());
    }
}
