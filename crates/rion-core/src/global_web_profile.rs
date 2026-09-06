use std::{fs, io::ErrorKind, path::Path};

use crate::{
    error::{CoreError, CoreResult},
    model::GlobalWebProfilePathsRecord,
};

const GLOBAL_WEB_PROFILE_KEY: &str = "global-web";
const WEB_PROFILES_DIRECTORY: &str = "web-profiles";
const CHROMIUM_DIRECTORY: &str = "chromium";

pub(crate) fn ensure(user_data_dir: &Path) -> CoreResult<GlobalWebProfilePathsRecord> {
    let canonical_user_data_dir =
        fs::canonicalize(user_data_dir).map_err(|error| io_error(user_data_dir, error))?;
    if !canonical_user_data_dir.is_absolute() {
        return Err(invalid_profile_path(&canonical_user_data_dir));
    }

    let profile_root = canonical_user_data_dir
        .join(WEB_PROFILES_DIRECTORY)
        .join(GLOBAL_WEB_PROFILE_KEY);
    let chromium_user_data_dir = profile_root.join(CHROMIUM_DIRECTORY);
    for directory in [
        canonical_user_data_dir.join(WEB_PROFILES_DIRECTORY),
        profile_root,
        chromium_user_data_dir.clone(),
    ] {
        ensure_owned_directory(&directory)?;
    }

    let canonical_chromium_user_data_dir = fs::canonicalize(&chromium_user_data_dir)
        .map_err(|error| io_error(&chromium_user_data_dir, error))?;
    if canonical_chromium_user_data_dir != chromium_user_data_dir
        || !canonical_chromium_user_data_dir.starts_with(&canonical_user_data_dir)
    {
        return Err(invalid_profile_path(&chromium_user_data_dir));
    }

    let chromium_user_data_dir =
        crate::chromium_path::engine_path(&canonical_chromium_user_data_dir)
            .ok_or_else(|| invalid_profile_path(&canonical_chromium_user_data_dir))?;
    let record = GlobalWebProfilePathsRecord {
        profile_key: GLOBAL_WEB_PROFILE_KEY.to_owned(),
        chromium_user_data_dir,
    };
    validate(&record)?;
    Ok(record)
}

pub(crate) fn validate(record: &GlobalWebProfilePathsRecord) -> CoreResult<()> {
    let chromium_user_data_dir = Path::new(&record.chromium_user_data_dir);
    let expected_suffix = Path::new(WEB_PROFILES_DIRECTORY)
        .join(GLOBAL_WEB_PROFILE_KEY)
        .join(CHROMIUM_DIRECTORY);
    if record.profile_key != GLOBAL_WEB_PROFILE_KEY
        || !chromium_user_data_dir.is_absolute()
        || !chromium_user_data_dir.ends_with(expected_suffix)
    {
        return Err(invalid_profile_path(chromium_user_data_dir));
    }
    let metadata = fs::symlink_metadata(chromium_user_data_dir)
        .map_err(|_| invalid_profile_path(chromium_user_data_dir))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_profile_path(chromium_user_data_dir));
    }
    let canonical = fs::canonicalize(chromium_user_data_dir)
        .map_err(|_| invalid_profile_path(chromium_user_data_dir))?;
    if crate::chromium_path::engine_path(&canonical)
        .ok_or_else(|| invalid_profile_path(&canonical))?
        != record.chromium_user_data_dir
    {
        return Err(invalid_profile_path(chromium_user_data_dir));
    }
    Ok(())
}

fn ensure_owned_directory(path: &Path) -> CoreResult<()> {
    loop {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(invalid_profile_path(path));
                }
                return Ok(());
            }
            Err(error) if error.kind() == ErrorKind::NotFound => match fs::create_dir(path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(path, error)),
            },
            Err(error) => return Err(io_error(path, error)),
        }
    }
}

fn invalid_profile_path(path: &Path) -> CoreError {
    CoreError::Domain {
        code: "GLOBAL_WEB_PROFILE_PATH_INVALID",
        message: format!(
            "The global Web Chromium profile path is not an owned directory: {}.",
            path.display()
        ),
    }
}

fn io_error(path: &Path, error: std::io::Error) -> CoreError {
    CoreError::Platform(format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_canonical_global_web_chromium_profile() {
        let directory = tempfile::tempdir().unwrap();
        let record = ensure(directory.path()).unwrap();
        let expected = fs::canonicalize(directory.path())
            .unwrap()
            .join("web-profiles")
            .join("global-web")
            .join("chromium");

        assert_eq!(record.profile_key, "global-web");
        assert_eq!(
            record.chromium_user_data_dir,
            crate::chromium_path::engine_path(&expected).unwrap()
        );
        assert!(expected.is_dir());
        assert!(!directory.path().join("roles").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_global_web_profile_component() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), directory.path().join("web-profiles")).unwrap();

        let error = ensure(directory.path()).unwrap_err();
        assert_eq!(error.code(), "GLOBAL_WEB_PROFILE_PATH_INVALID");
        assert!(!outside.path().join("global-web").exists());
    }
}
