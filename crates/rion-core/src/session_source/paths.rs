use super::Result;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

pub(crate) fn existing(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("ABSOLUTE_PATH_REQUIRED");
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("PATH_TRAVERSAL");
        }
        cursor.push(part);
        let info = fs::symlink_metadata(&cursor).map_err(|_| "SOURCE_PATH_UNAVAILABLE")?;
        if info.file_type().is_symlink() {
            return Err("SYMLINK_FORBIDDEN");
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if info.file_attributes() & 0x400 != 0 {
                return Err("REPARSE_POINT_FORBIDDEN");
            }
        }
    }
    fs::canonicalize(path).map_err(|_| "SOURCE_PATH_UNAVAILABLE")
}

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn create_output(output: &Path, sources: &[PathBuf]) -> Result<PathBuf> {
    if !output.is_absolute() || output.exists() || fs::symlink_metadata(output).is_ok() {
        return Err("NEW_ABSOLUTE_OUTPUT_REQUIRED");
    }
    let parent = existing(output.parent().ok_or("OUTPUT_PARENT_REQUIRED")?)?;
    let name = output.file_name().ok_or("OUTPUT_NAME_REQUIRED")?;
    let destination = parent.join(name);
    // A directly invoked Rust fixture must reject real application roots too;
    // this is not delegated to the JavaScript command-line wrapper.
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let mut protected = Vec::new();
    if let Some(home) = home {
        let home = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            protected.push(home.join("Library/Application Support"));
            protected.push(home.join("Library/WebKit"));
        }
    }
    if cfg!(windows) {
        protected.extend(
            ["APPDATA", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from),
        );
    }
    for root in protected {
        if let Ok(root) = fs::canonicalize(root)
            && destination.starts_with(root)
        {
            return Err("OUTPUT_OVERLAPS_USER_DATA");
        }
    }
    for source in sources {
        if destination.starts_with(source) || source.starts_with(&destination) {
            return Err("OUTPUT_OVERLAPS_SOURCE");
        }
    }
    fs::create_dir(&destination).map_err(|_| "OUTPUT_CREATE_FAILED")?;
    rion_platform::restrict_directory_to_current_user(&destination)
        .map_err(|_| "OUTPUT_PROTECTION_FAILED")?;
    Ok(destination)
}

#[cfg(feature = "session-migration-diagnostics")]
pub(crate) fn role_id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        Ok(())
    } else {
        Err("INVALID_ROLE_ID")
    }
}

/// Bounded inventory; caches are counted as excluded, never advertised as backed up.
pub(crate) fn files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(path: &Path, depth: u8, result: &mut Vec<PathBuf>) -> Result<()> {
        if depth > 12 {
            return Err("SOURCE_DEPTH_LIMIT");
        }
        for entry in fs::read_dir(path).map_err(|_| "SOURCE_ENUMERATION_FAILED")? {
            let entry = entry.map_err(|_| "SOURCE_ENUMERATION_FAILED")?;
            let path = entry.path();
            existing(&path)?;
            let info = entry.metadata().map_err(|_| "SOURCE_METADATA_FAILED")?;
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if info.is_dir() {
                if !name.contains("cache") {
                    visit(&path, depth + 1, result)?;
                }
            } else if info.is_file() {
                result.push(path);
                if result.len() > 4096 {
                    return Err("SOURCE_FILE_LIMIT");
                }
            } else {
                return Err("SPECIAL_FILE_FORBIDDEN");
            }
        }
        Ok(())
    }
    let mut result = Vec::new();
    visit(root, 0, &mut result)?;
    result.sort();
    Ok(result)
}
