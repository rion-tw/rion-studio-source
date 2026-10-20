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
/// Windows Chrome's process-singleton lock in the user data directory. Chrome
/// holds it for its whole lifetime with write access, read-only sharing, and
/// `FILE_FLAG_DELETE_ON_CLOSE`, so Windows deletes it on every exit, including
/// a crash. POSIX Chrome uses the Singleton* markers instead.
#[cfg(windows)]
const WINDOWS_LOCK_FILE: &str = "lockfile";
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
        || windows_lock_file_held(source)
}

/// Probes whether a live process holds Chrome's Windows `lockfile`. A
/// read-only open that refuses to share writing conflicts with Chrome's write
/// handle, so only a held lock reports a sharing violation; the probe never
/// writes, creates, or deletes the file.
#[cfg(windows)]
fn windows_lock_file_held(source: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    let probe = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
        .open(source.join(WINDOWS_LOCK_FILE))
        .map(drop);
    lock_file_probe_indicates_in_use(probe)
}

#[cfg(not(windows))]
fn windows_lock_file_held(_source: &Path) -> bool {
    false
}

#[cfg(any(windows, test))]
fn lock_file_probe_indicates_in_use(probe: std::io::Result<()>) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match probe {
        // Nobody holds the file, so it is stale evidence (for example after
        // a power loss) rather than a running Chrome.
        Ok(()) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => true,
        // An unclassified state, such as a pending delete or denied access,
        // fails closed; apply re-checks before reading any source data.
        Err(_) => true,
    }
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
    Ok(hex::encode(digest.finalize()))
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
            "{}:{}:{}:{}",
            relative.to_string_lossy(),
            metadata.len(),
            modified,
            hex::encode(content_digest.finalize())
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

fn operation(path: &Path, error: std::io::Error) -> PlatformError {
    PlatformError::Operation(format!("{}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn discovers_profiles_and_fingerprints_only_transferable_data() {
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

        let fingerprint = chrome_profile_source_fingerprint(source.path(), "Default").unwrap();
        fs::write(source.path().join("Default/History"), b"history changed").unwrap();
        fs::write(
            source.path().join("Default/Login Data"),
            b"passwords changed",
        )
        .unwrap();
        fs::write(
            source.path().join("Default/Preferences"),
            b"preferences changed",
        )
        .unwrap();
        fs::write(
            source.path().join("Default/IndexedDB/data"),
            b"indexed changed",
        )
        .unwrap();
        assert_eq!(
            chrome_profile_source_fingerprint(source.path(), "Default").unwrap(),
            fingerprint
        );
        fs::write(
            source.path().join("Default/Network/Cookies"),
            b"cookie changed",
        )
        .unwrap();
        assert_ne!(
            chrome_profile_source_fingerprint(source.path(), "Default").unwrap(),
            fingerprint
        );
    }

    #[test]
    fn rejects_profile_path_traversal_and_detects_lock_markers() {
        let source = tempdir().unwrap();
        fs::create_dir(source.path().join("Default")).unwrap();
        fs::write(source.path().join("Local State"), "{}").unwrap();
        assert!(chrome_profile_source_fingerprint(source.path(), "../Default").is_err());
        assert!(!chrome_user_data_in_use(source.path()));
        fs::write(source.path().join("SingletonLock"), b"locked").unwrap();
        assert!(chrome_user_data_in_use(source.path()));
    }

    /// Holds `lockfile` the way the running browser does on each platform:
    /// Windows Chrome keeps a write handle with read-only sharing and
    /// delete-on-close; POSIX Chrome never uses this file.
    fn hold_lock_file_like_running_chrome(source: &Path) -> fs::File {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_SHARE_READ: u32 = 0x0000_0001;
            const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
            options
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_DELETE_ON_CLOSE);
        }
        options.open(source.join("lockfile")).unwrap()
    }

    #[test]
    fn windows_lock_file_marks_the_source_in_use_only_while_chrome_holds_it() {
        let source = tempdir().unwrap();
        assert!(!chrome_user_data_in_use(source.path()));

        let held = hold_lock_file_like_running_chrome(source.path());
        // macOS keeps its Singleton-marker detection unchanged.
        assert_eq!(chrome_user_data_in_use(source.path()), cfg!(windows));
        drop(held);
        if cfg!(windows) {
            // Chrome's delete-on-close handle removes the file at exit.
            assert!(!source.path().join("lockfile").exists());
        }
        assert!(!chrome_user_data_in_use(source.path()));

        // A lockfile nobody holds is stale evidence, not a running Chrome.
        fs::write(source.path().join("lockfile"), b"").unwrap();
        assert!(!chrome_user_data_in_use(source.path()));
    }

    #[test]
    fn windows_lock_file_probe_fails_closed_on_unknown_open_errors() {
        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        assert!(!lock_file_probe_indicates_in_use(Ok(())));
        assert!(!lock_file_probe_indicates_in_use(Err(
            std::io::ErrorKind::NotFound.into()
        )));
        assert!(lock_file_probe_indicates_in_use(Err(
            std::io::Error::from_raw_os_error(ERROR_SHARING_VIOLATION)
        )));
        assert!(lock_file_probe_indicates_in_use(Err(
            std::io::Error::from_raw_os_error(ERROR_ACCESS_DENIED)
        )));
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
