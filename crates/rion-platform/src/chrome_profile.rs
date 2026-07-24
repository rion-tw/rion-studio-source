use std::{fs, path::Path};

use serde::Serialize;
use serde_json::Value;

use crate::{Platform, PlatformError};

const COPY_PATHS: &[&str] = &[
    "Cookies",
    "Network/Cookies",
    "Local Storage",
    "Session Storage",
    "IndexedDB",
    "Service Worker",
];

pub fn default_chrome_user_data_directory(platform: Platform) -> Option<std::path::PathBuf> {
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
) -> Option<std::path::PathBuf> {
    match platform {
        Platform::Macos => home.map(|home| {
            std::path::PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome")
        }),
        Platform::Windows => local_app_data.map(|local_app_data| {
            std::path::PathBuf::from(local_app_data)
                .join("Google")
                .join("Chrome")
                .join("User Data")
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileEntry {
    pub directory_name: String,
    pub id: String,
    pub name: String,
}

pub fn discover_chrome_profiles(source: &Path) -> Result<Vec<ChromeProfileEntry>, PlatformError> {
    validate_directory(source)?;
    let local_state = fs::read_to_string(source.join("Local State"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let info_cache = local_state
        .get("profile")
        .and_then(|profile| profile.get("info_cache"))
        .and_then(Value::as_object);
    let mut directory_names = fs::read_dir(source)
        .map_err(|error| operation(source, error))?
        .filter_map(|entry| entry.ok())
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

pub fn copy_chrome_profile(
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
    if !destination.is_absolute() || destination == source_user_data {
        return Err(PlatformError::Operation(
            "Chrome profile destination is invalid".to_owned(),
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
    for relative in COPY_PATHS {
        copy_path_if_present(
            &source_profile.join(relative),
            &destination_profile.join(relative),
        )?;
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

fn copy_path_if_present(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(operation(source, error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(PlatformError::Operation(format!(
            "Chrome profile contains an unsupported symbolic link: {}",
            source.display()
        )));
    }
    if metadata.is_file() {
        return copy_file(source, destination);
    }
    if !metadata.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination).map_err(|error| operation(destination, error))?;
    for entry in fs::read_dir(source).map_err(|error| operation(source, error))? {
        let entry = entry.map_err(|error| operation(source, error))?;
        copy_path_if_present(&entry.path(), &destination.join(entry.file_name()))?;
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
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_profiles_with_local_state_names() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("Default")).unwrap();
        fs::create_dir(directory.path().join("Profile 2")).unwrap();
        fs::create_dir(directory.path().join("System Profile")).unwrap();
        fs::write(
            directory.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 2":{"name":"Work"}}}}"#,
        )
        .unwrap();

        assert_eq!(
            discover_chrome_profiles(directory.path()).unwrap(),
            vec![
                ChromeProfileEntry {
                    directory_name: "Default".to_owned(),
                    id: "Default".to_owned(),
                    name: "Default".to_owned(),
                },
                ChromeProfileEntry {
                    directory_name: "Profile 2".to_owned(),
                    id: "Profile 2".to_owned(),
                    name: "Work".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn copies_only_session_paths_and_rejects_symlinks() {
        let source = tempdir().unwrap();
        let destination = tempdir().unwrap().keep().join("copy");
        fs::create_dir_all(source.path().join("Default/Network")).unwrap();
        fs::create_dir_all(source.path().join("Default/Local Storage")).unwrap();
        fs::create_dir_all(source.path().join("Default/Session Storage")).unwrap();
        fs::create_dir_all(source.path().join("Default/IndexedDB")).unwrap();
        fs::create_dir_all(source.path().join("Default/Service Worker/CacheStorage")).unwrap();
        fs::write(source.path().join("Default/Network/Cookies"), b"cookies").unwrap();
        fs::write(
            source.path().join("Default/Local Storage/leveldb.log"),
            b"local",
        )
        .unwrap();
        fs::write(
            source.path().join("Default/Session Storage/session.log"),
            b"session",
        )
        .unwrap();
        fs::write(source.path().join("Default/IndexedDB/auth.log"), b"indexed").unwrap();
        fs::write(
            source
                .path()
                .join("Default/Service Worker/CacheStorage/cache.log"),
            b"cache",
        )
        .unwrap();
        fs::write(source.path().join("Default/History"), b"history").unwrap();
        fs::write(source.path().join("Default/Login Data"), b"passwords").unwrap();
        fs::write(source.path().join("Default/Web Data"), b"autofill").unwrap();
        fs::write(source.path().join("Default/Bookmarks"), b"bookmarks").unwrap();
        fs::write(source.path().join("Default/Preferences"), b"preferences").unwrap();

        copy_chrome_profile(source.path(), "Default", &destination).unwrap();

        crate::v1_case!("portable-profile-9f7a0ac7cef6", {
            for (relative, expected) in [
                ("Network/Cookies", b"cookies".as_slice()),
                ("Local Storage/leveldb.log", b"local".as_slice()),
                ("Session Storage/session.log", b"session".as_slice()),
                ("IndexedDB/auth.log", b"indexed".as_slice()),
                ("Service Worker/CacheStorage/cache.log", b"cache".as_slice()),
            ] {
                assert_eq!(
                    fs::read(destination.join("Default").join(relative)).unwrap(),
                    expected
                );
            }
            for relative in [
                "Bookmarks",
                "History",
                "Login Data",
                "Preferences",
                "Web Data",
            ] {
                assert!(!destination.join("Default").join(relative).exists());
            }
        });
    }

    #[test]
    fn resolves_explicit_cross_platform_default_profile_paths() {
        crate::v1_case!("portable-profile-aad628b05d99", {
            assert_eq!(
                default_chrome_user_data_directory_from(
                    Platform::Macos,
                    Some(std::ffi::OsStr::new("/Users/test")),
                    None,
                ),
                Some(
                    std::path::PathBuf::from("/Users/test")
                        .join("Library/Application Support/Google/Chrome")
                )
            );
        });
        crate::v1_case!("portable-profile-c11abfcf2af2", {
            assert_eq!(
                default_chrome_user_data_directory_from(
                    Platform::Windows,
                    Some(std::ffi::OsStr::new("C:/Users/test")),
                    Some(std::ffi::OsStr::new("C:/Users/test/AppData/Local")),
                ),
                Some(
                    std::path::PathBuf::from("C:/Users/test/AppData/Local")
                        .join("Google/Chrome/User Data")
                )
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symbolic_link_inside_copied_storage() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        let destination = tempdir().unwrap().keep().join("copy");
        fs::create_dir_all(source.path().join("Default/Local Storage")).unwrap();
        symlink(
            source.path().join("Default"),
            source.path().join("Default/Local Storage/escape"),
        )
        .unwrap();

        crate::v1_case!("portable-profile-5754b66f2010", {
            let error = copy_chrome_profile(source.path(), "Default", &destination).unwrap_err();
            assert!(error.to_string().contains("unsupported symbolic link"));
            assert!(!destination.join("Default/Local Storage/escape").exists());
        });
    }
}
