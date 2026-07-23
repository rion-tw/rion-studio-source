use std::path::Path;

use crate::PlatformError;

#[cfg(not(windows))]
pub fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    std::fs::rename(source, destination).map_err(|error| {
        PlatformError::Operation(format!(
            "failed to atomically replace {} with {}: {error}",
            destination.display(),
            source.display()
        ))
    })
}

#[cfg(windows)]
pub fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), PlatformError> {
    use std::os::windows::ffi::OsStrExt;

    use windows::{
        Win32::Storage::FileSystem::{
            MOVE_FILE_FLAGS, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVE_FILE_FLAGS(MOVEFILE_REPLACE_EXISTING.0 | MOVEFILE_WRITE_THROUGH.0);
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }.map_err(
        |error| PlatformError::Operation(format!("atomic file replacement failed: {error}")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_file_without_exposing_a_partial_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.tmp");
        let destination = directory.path().join("result.json");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(&destination, b"old").unwrap();

        atomic_replace_file(&source, &destination).unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(!source.exists());
    }
}
