use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Platform, PlatformError};

const LOCK_FILES: &[&str] = &["SingletonCookie", "SingletonLock", "SingletonSocket"];
const COPY_FILES: &[&str] = &[
    "Cookies",
    "Cookies-wal",
    "Cookies-shm",
    "Network/Cookies",
    "Network/Cookies-wal",
    "Network/Cookies-shm",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileEntry {
    pub directory_name: String,
    pub id: String,
    pub name: String,
}

pub fn default_chrome_user_data_directory(platform: Platform) -> Option<PathBuf> {
    default_chrome_user_data_directory_from(
        platform,
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("LOCALAPPDATA").as_deref(),
    )
}

fn default_chrome_user_data_directory_from(
    platform: Platform,
    home: Option<&std::ffi::OsStr>,
    local_app_data: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    match platform {
        Platform::Macos => {
            home.map(|home| PathBuf::from(home).join("Library/Application Support/Google/Chrome"))
        }
        Platform::Windows => local_app_data
            .map(|local_app_data| PathBuf::from(local_app_data).join("Google/Chrome/User Data")),
    }
}

pub fn chrome_user_data_in_use(source: &Path) -> bool {
    LOCK_FILES
        .iter()
        .any(|name| fs::symlink_metadata(source.join(name)).is_ok())
}

pub fn discover_chrome_profiles(source: &Path) -> Result<Vec<ChromeProfileEntry>, PlatformError> {
    validate_directory(source)?;
    let local_state = fs::read_to_string(source.join("Local State"))
        .map_err(|error| operation(&source.join("Local State"), error))?;
    let local_state: Value = serde_json::from_str(&local_state).map_err(|error| {
        PlatformError::Operation(format!("Chrome Local State is invalid: {error}"))
    })?;
    let info_cache = local_state
        .get("profile")
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object);
    let mut directory_names = fs::read_dir(source)
        .map_err(|error| operation(source, error))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir() && !kind.is_symlink())
                .and_then(|_| entry.file_name().into_string().ok())
                .filter(|name| is_profile_directory(name))
        })
        .collect::<Vec<_>>();
    directory_names.sort();
    if directory_names.is_empty() {
        return Err(PlatformError::Operation(
            "no Chrome profiles were found in the selected folder".to_owned(),
        ));
    }
    Ok(directory_names
        .into_iter()
        .map(|directory_name| {
            let name = info_cache
                .and_then(|cache| cache.get(&directory_name))
                .and_then(|metadata| metadata.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&directory_name)
                .chars()
                .take(80)
                .collect::<String>();
            ChromeProfileEntry {
                id: directory_name.clone(),
                directory_name,
                name,
            }
        })
        .collect())
}

/// Copies only data needed by the one-time session transfer. The destination is
/// staging owned by Rion Studio and is never used as a browser profile.
pub fn stage_chrome_profile(
    source_user_data: &Path,
    directory_name: &str,
    destination: &Path,
) -> Result<(), PlatformError> {
    validate_directory(source_user_data)?;
    if !is_profile_directory(directory_name) {
        return Err(PlatformError::Operation(
            "Chrome profile directory name is invalid".to_owned(),
        ));
    }
    if !destination.is_absolute() || destination.starts_with(source_user_data) {
        return Err(PlatformError::Operation(
            "Chrome profile staging destination is invalid".to_owned(),
        ));
    }
    let source_profile = source_user_data.join(directory_name);
    validate_directory(&source_profile)?;
    fs::create_dir_all(destination).map_err(|error| operation(destination, error))?;
    copy_file_if_present(
        &source_user_data.join("Local State"),
        &destination.join("Local State"),
    )?;
    let destination_profile = destination.join("Default");
    fs::create_dir_all(&destination_profile)
        .map_err(|error| operation(&destination_profile, error))?;
    for relative in COPY_FILES {
        copy_file_if_present(
            &source_profile.join(relative),
            &destination_profile.join(relative),
        )?;
    }
    copy_directory_if_present(
        &source_profile.join("Local Storage/leveldb"),
        &destination_profile.join("Local Storage/leveldb"),
    )?;
    Ok(())
}

pub fn chrome_profile_source_fingerprint(
    source_user_data: &Path,
    directory_name: &str,
) -> Result<String, PlatformError> {
    validate_directory(source_user_data)?;
    if !is_profile_directory(directory_name) {
        return Err(PlatformError::Operation(
            "Chrome profile directory name is invalid".to_owned(),
        ));
    }
    let profile = source_user_data.join(directory_name);
    validate_directory(&profile)?;
    let mut entries = Vec::new();
    fingerprint_path(
        source_user_data,
        &source_user_data.join("Local State"),
        &mut entries,
    )?;
    for relative in COPY_FILES {
        fingerprint_path(source_user_data, &profile.join(relative), &mut entries)?;
    }
    fingerprint_path(
        source_user_data,
        &profile.join("Local Storage/leveldb"),
        &mut entries,
    )?;
    entries.sort();
    let mut digest = Sha256::new();
    for entry in entries {
        digest.update(entry);
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn fingerprint_path(
    root: &Path,
    path: &Path,
    output: &mut Vec<String>,
) -> Result<(), PlatformError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(operation(path, error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(PlatformError::Operation(format!(
            "Chrome profile contains an unsupported symbolic link: {}",
            path.display()
        )));
    }
    let relative = path.strip_prefix(root).map_err(|_| {
        PlatformError::Operation("Chrome profile fingerprint path escaped its source".to_owned())
    })?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| operation(path, error))? {
            let entry = entry.map_err(|error| operation(path, error))?;
            fingerprint_path(root, &entry.path(), output)?;
        }
    } else if metadata.is_file() {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let mut file = fs::File::open(path).map_err(|error| operation(path, error))?;
        let mut content_digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| operation(path, error))?;
            if read == 0 {
                break;
            }
            content_digest.update(&buffer[..read]);
        }
        output.push(format!(
            "{}:{}:{}:{:x}",
            relative.to_string_lossy(),
            metadata.len(),
            modified,
            content_digest.finalize()
        ));
    }
    Ok(())
}

fn validate_directory(path: &Path) -> Result<(), PlatformError> {
    if !path.is_absolute() {
        return Err(PlatformError::Operation(
            "Chrome profile path must be absolute".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| operation(path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PlatformError::Operation(
            "Chrome profile path must be a real directory".to_owned(),
        ));
    }
    Ok(())
}

fn is_profile_directory(name: &str) -> bool {
    name == "Default"
        || name.strip_prefix("Profile ").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn copy_directory_if_present(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(operation(source, error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PlatformError::Operation(format!(
            "Chrome profile contains an unsupported path: {}",
            source.display()
        )));
    }
    fs::create_dir_all(destination).map_err(|error| operation(destination, error))?;
    for entry in fs::read_dir(source).map_err(|error| operation(source, error))? {
        let entry = entry.map_err(|error| operation(source, error))?;
        let entry_type = entry
            .file_type()
            .map_err(|error| operation(&entry.path(), error))?;
        if entry_type.is_symlink() {
            return Err(PlatformError::Operation(format!(
                "Chrome profile contains an unsupported symbolic link: {}",
                entry.path().display()
            )));
        }
        if entry_type.is_dir() {
            copy_directory_if_present(&entry.path(), &destination.join(entry.file_name()))?;
        } else if entry_type.is_file() {
            copy_file(&entry.path(), &destination.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn copy_file_if_present(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    match fs::symlink_metadata(source) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(PlatformError::Operation(format!(
                "Chrome profile contains an unsupported symbolic link: {}",
                source.display()
            )))
        }
        Ok(metadata) if metadata.is_file() => copy_file(source, destination),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(operation(source, error)),
    }
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| operation(parent, error))?;
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| operation(source, error))
}

fn operation(path: &Path, error: std::io::Error) -> PlatformError {
    PlatformError::Operation(format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn discovers_profiles_and_stages_only_cookie_and_local_storage_data() {
        let source = tempdir().unwrap();
        fs::create_dir_all(source.path().join("Default/Network")).unwrap();
        fs::create_dir_all(source.path().join("Default/Local Storage/leveldb")).unwrap();
        fs::write(
            source.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}"#,
        )
        .unwrap();
        fs::write(source.path().join("Default/Network/Cookies"), b"cookie").unwrap();
        fs::write(
            source
                .path()
                .join("Default/Local Storage/leveldb/000001.log"),
            b"local",
        )
        .unwrap();
        fs::write(source.path().join("Default/History"), b"history").unwrap();
        fs::write(source.path().join("Default/Login Data"), b"passwords").unwrap();
        fs::write(source.path().join("Default/Preferences"), b"preferences").unwrap();
        fs::create_dir_all(source.path().join("Default/IndexedDB")).unwrap();
        fs::write(source.path().join("Default/IndexedDB/data"), b"indexed").unwrap();
        assert_eq!(
            discover_chrome_profiles(source.path()).unwrap()[0].name,
            "Personal"
        );

        let staging = tempdir().unwrap().keep().join("staging");
        stage_chrome_profile(source.path(), "Default", &staging).unwrap();
        assert!(staging.join("Default/Network/Cookies").is_file());
        assert!(
            staging
                .join("Default/Local Storage/leveldb/000001.log")
                .is_file()
        );
        assert!(!staging.join("Default/History").exists());
        assert!(!staging.join("Default/Login Data").exists());
        assert!(!staging.join("Default/Preferences").exists());
        assert!(!staging.join("Default/IndexedDB").exists());
    }

    #[test]
    fn rejects_profile_path_traversal_and_detects_lock_markers() {
        let source = tempdir().unwrap();
        fs::create_dir(source.path().join("Default")).unwrap();
        fs::write(source.path().join("Local State"), "{}").unwrap();
        let staging = tempdir().unwrap().keep().join("staging");
        assert!(stage_chrome_profile(source.path(), "../Default", &staging).is_err());
        assert!(!chrome_user_data_in_use(source.path()));
        fs::write(source.path().join("SingletonLock"), b"locked").unwrap();
        assert!(chrome_user_data_in_use(source.path()));
    }

    #[test]
    fn source_fingerprint_changes_when_restricted_content_changes() {
        let source = tempdir().unwrap();
        fs::create_dir_all(source.path().join("Default/Network")).unwrap();
        fs::write(source.path().join("Local State"), "{}").unwrap();
        let cookies = source.path().join("Default/Network/Cookies");
        fs::write(&cookies, b"before").unwrap();
        let before = chrome_profile_source_fingerprint(source.path(), "Default").unwrap();
        fs::write(&cookies, b"after!").unwrap();
        let after = chrome_profile_source_fingerprint(source.path(), "Default").unwrap();
        assert_ne!(before, after);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links_in_selected_profile_data() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir_all(source.path().join("Default/Local Storage/leveldb")).unwrap();
        fs::write(source.path().join("Local State"), "{}").unwrap();
        fs::write(outside.path().join("secret"), b"outside").unwrap();
        symlink(
            outside.path().join("secret"),
            source
                .path()
                .join("Default/Local Storage/leveldb/000001.log"),
        )
        .unwrap();
        let staging = tempdir().unwrap().keep().join("staging");
        assert!(stage_chrome_profile(source.path(), "Default", &staging).is_err());
        assert!(chrome_profile_source_fingerprint(source.path(), "Default").is_err());
    }

    #[test]
    fn resolves_cross_platform_defaults() {
        assert_eq!(
            default_chrome_user_data_directory_from(
                Platform::Macos,
                Some(std::ffi::OsStr::new("/Users/test")),
                None,
            ),
            Some(PathBuf::from(
                "/Users/test/Library/Application Support/Google/Chrome"
            ))
        );
        assert_eq!(
            default_chrome_user_data_directory_from(
                Platform::Windows,
                None,
                Some(std::ffi::OsStr::new("C:/Users/test/AppData/Local")),
            ),
            Some(PathBuf::from(
                "C:/Users/test/AppData/Local/Google/Chrome/User Data"
            ))
        );
    }
}
