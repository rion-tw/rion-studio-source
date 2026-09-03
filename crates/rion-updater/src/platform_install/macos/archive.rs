use std::{
    fs::File,
    path::{Component, Path},
};

use flate2::read::GzDecoder;

use crate::UpdatePlatformInstallError;

const MAX_EXPANDED_UPDATE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 200_000;

pub(super) fn unpack_archive(
    archive_path: &Path,
    staging_root: &Path,
) -> Result<(), UpdatePlatformInstallError> {
    let archive = File::open(archive_path).map_err(UpdatePlatformInstallError::Io)?;
    let decoder = GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|_| UpdatePlatformInstallError::InvalidArchive)?;
    let mut expanded_bytes = 0_u64;
    for (entry_index, entry) in entries.enumerate() {
        if entry_index >= MAX_ARCHIVE_ENTRIES {
            return Err(UpdatePlatformInstallError::InvalidArchive);
        }
        let mut entry = entry.map_err(|_| UpdatePlatformInstallError::InvalidArchive)?;
        let path = entry
            .path()
            .map_err(|_| UpdatePlatformInstallError::InvalidArchive)?
            .into_owned();
        validate_relative_path(&path)?;
        let entry_type = entry.header().entry_type();
        expanded_bytes = expanded_bytes
            .checked_add(entry.header().size().unwrap_or(u64::MAX))
            .filter(|total| *total <= MAX_EXPANDED_UPDATE_BYTES)
            .ok_or(UpdatePlatformInstallError::InvalidArchive)?;
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            let target = entry
                .link_name()
                .map_err(|_| UpdatePlatformInstallError::InvalidArchive)?
                .ok_or(UpdatePlatformInstallError::InvalidArchive)?;
            validate_link_target(&path, &target, entry_type.is_hard_link())?;
        } else if !(entry_type.is_file() || entry_type.is_dir()) {
            return Err(UpdatePlatformInstallError::InvalidArchive);
        }
        if !entry
            .unpack_in(staging_root)
            .map_err(|_| UpdatePlatformInstallError::InvalidArchive)?
        {
            return Err(UpdatePlatformInstallError::InvalidArchive);
        }
    }
    Ok(())
}

pub(super) fn validate_relative_path(path: &Path) -> Result<(), UpdatePlatformInstallError> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(UpdatePlatformInstallError::InvalidArchive);
    }
    Ok(())
}

pub(super) fn validate_link_target(
    entry_path: &Path,
    target: &Path,
    hard_link: bool,
) -> Result<(), UpdatePlatformInstallError> {
    if target.is_absolute() {
        return Err(UpdatePlatformInstallError::InvalidArchive);
    }
    let combined = if hard_link {
        target.to_path_buf()
    } else {
        entry_path.parent().unwrap_or(Path::new("")).join(target)
    };
    let mut depth = 0_usize;
    for component in combined.components() {
        match component {
            Component::Normal(_) => depth = depth.saturating_add(1),
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::CurDir => {}
            _ => return Err(UpdatePlatformInstallError::InvalidArchive),
        }
    }
    if depth == 0 {
        return Err(UpdatePlatformInstallError::InvalidArchive);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_archive_paths_and_links_that_can_escape_the_staging_root() {
        assert!(validate_relative_path(Path::new("Rion Studio.app/Contents/MacOS/Rion")).is_ok());
        assert!(validate_relative_path(Path::new("../outside")).is_err());
        assert!(validate_relative_path(Path::new("/outside")).is_err());
        assert!(
            validate_link_target(
                Path::new("Rion Studio.app/Contents/Frameworks/Current"),
                Path::new("A"),
                false,
            )
            .is_ok()
        );
        assert!(
            validate_link_target(
                Path::new("Rion Studio.app/link"),
                Path::new("../../outside"),
                false,
            )
            .is_err()
        );
    }
}
