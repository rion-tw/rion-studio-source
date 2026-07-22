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

const REMOVE_RETRIES: usize = 8;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(100);

pub fn paths(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    validate_role_id(role_id)?;
    Ok(RolePathsRecord {
        browser_user_data_dir: browser_directory(user_data_dir, role_id)
            .to_string_lossy()
            .into_owned(),
    })
}

pub fn ensure(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    let paths = paths(user_data_dir, role_id)?;
    fs::create_dir_all(&paths.browser_user_data_dir)
        .map_err(|error| io_error(Path::new(&paths.browser_user_data_dir), error))?;
    Ok(paths)
}

pub fn reset(user_data_dir: &Path, role_id: &str) -> CoreResult<RolePathsRecord> {
    let paths = paths(user_data_dir, role_id)?;
    let directory = Path::new(&paths.browser_user_data_dir);
    remove_with_retry(directory)?;
    fs::create_dir_all(directory).map_err(|error| io_error(directory, error))?;
    Ok(paths)
}

pub fn remove(user_data_dir: &Path, role_id: &str) -> CoreResult<()> {
    validate_role_id(role_id)?;
    remove_with_retry(&user_data_dir.join("roles").join(role_id))
}

fn browser_directory(user_data_dir: &Path, role_id: &str) -> PathBuf {
    user_data_dir.join("roles").join(role_id).join("browser")
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
        fs::write(browser.join("session"), b"state").unwrap();

        reset(directory.path(), "role-1").unwrap();
        assert!(browser.is_dir());
        assert!(!browser.join("session").exists());

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
}
