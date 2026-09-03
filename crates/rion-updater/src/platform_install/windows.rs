use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
};

use std::os::windows::process::CommandExt;

use super::{
    InstallHandoffEvidence, InstallPrepareEvidence, PlatformInstallRequest,
    UpdatePlatformInstallError, UpdatePlatformInstaller,
};
use crate::{InstallAttemptRecord, UpdatePlatform};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub(super) struct WindowsUpdateInstaller {
    prepared: Mutex<Option<PreparedWindowsInstall>>,
}

#[derive(Clone)]
struct PreparedWindowsInstall {
    attempt_id: String,
    target_version: String,
    installer_path: PathBuf,
}

impl UpdatePlatformInstaller for WindowsUpdateInstaller {
    fn prepare(
        &self,
        request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError> {
        if request.platform != UpdatePlatform::WindowsX86_64 {
            return Err(UpdatePlatformInstallError::PlatformMismatch);
        }
        let metadata =
            fs::symlink_metadata(&request.artifact_path).map_err(UpdatePlatformInstallError::Io)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || request
                .artifact_path
                .extension()
                .and_then(|value| value.to_str())
                != Some("exe")
        {
            return Err(UpdatePlatformInstallError::UnsafeArtifact);
        }
        validate_windows_pe_installer(&request.artifact_path, metadata.len())?;
        *self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)? =
            Some(PreparedWindowsInstall {
                attempt_id: request.attempt.attempt_id.clone(),
                target_version: request.attempt.target_version.clone(),
                installer_path: request.artifact_path.clone(),
            });
        Ok(InstallPrepareEvidence {
            attempt_id: request.attempt.attempt_id.clone(),
            target_version: request.attempt.target_version.clone(),
            platform: request.platform.to_string(),
            replacement_applied: false,
        })
    }

    fn rollback(&self, attempt_id: &str) -> Result<(), UpdatePlatformInstallError> {
        let mut prepared = self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?;
        if prepared
            .as_ref()
            .is_some_and(|prepared| prepared.attempt_id == attempt_id)
        {
            *prepared = None;
            return Ok(());
        }
        Err(UpdatePlatformInstallError::StateUnavailable)
    }

    fn handoff_after_drain(
        &self,
        attempt_id: &str,
        _parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError> {
        let prepared = self
            .prepared
            .lock()
            .map_err(|_| UpdatePlatformInstallError::StateUnavailable)?
            .as_ref()
            .filter(|prepared| prepared.attempt_id == attempt_id)
            .cloned()
            .ok_or(UpdatePlatformInstallError::StateUnavailable)?;
        let child = Command::new(&prepared.installer_path)
            .arg("/S")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| UpdatePlatformInstallError::InstallerSpawnFailed)?;
        Ok(InstallHandoffEvidence {
            attempt_id: prepared.attempt_id,
            target_version: prepared.target_version,
            platform: UpdatePlatform::WindowsX86_64.to_string(),
            child_process_id: child.id(),
        })
    }

    fn finalize_applied(
        &self,
        _attempt: &InstallAttemptRecord,
        _user_data_dir: &std::path::Path,
    ) -> Result<(), UpdatePlatformInstallError> {
        Ok(())
    }
}

fn validate_windows_pe_installer(
    path: &std::path::Path,
    file_bytes: u64,
) -> Result<(), UpdatePlatformInstallError> {
    const DOS_HEADER_BYTES: usize = 64;
    const PE_HEADER_BYTES: usize = 26;
    const PE_OFFSET_INDEX: usize = 0x3c;
    const I386_MACHINE: u16 = 0x014c;
    const AMD64_MACHINE: u16 = 0x8664;
    const EXECUTABLE_IMAGE: u16 = 0x0002;
    const PE32: u16 = 0x010b;
    const PE32_PLUS: u16 = 0x020b;

    if file_bytes < (DOS_HEADER_BYTES + PE_HEADER_BYTES) as u64 {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    let mut input = File::open(path).map_err(UpdatePlatformInstallError::Io)?;
    rion_platform::verify_open_file_identity(path, &input)
        .map_err(|_| UpdatePlatformInstallError::UnsafeArtifact)?;
    let mut dos_header = [0_u8; DOS_HEADER_BYTES];
    input
        .read_exact(&mut dos_header)
        .map_err(|_| UpdatePlatformInstallError::UnsafeArtifact)?;
    if &dos_header[..2] != b"MZ" {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    let pe_offset = u32::from_le_bytes(
        dos_header[PE_OFFSET_INDEX..PE_OFFSET_INDEX + 4]
            .try_into()
            .map_err(|_| UpdatePlatformInstallError::UnsafeArtifact)?,
    ) as u64;
    if pe_offset < DOS_HEADER_BYTES as u64
        || pe_offset
            .checked_add(PE_HEADER_BYTES as u64)
            .is_none_or(|end| end > file_bytes)
    {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    input
        .seek(SeekFrom::Start(pe_offset))
        .map_err(|_| UpdatePlatformInstallError::UnsafeArtifact)?;
    let mut pe_header = [0_u8; PE_HEADER_BYTES];
    input
        .read_exact(&mut pe_header)
        .map_err(|_| UpdatePlatformInstallError::UnsafeArtifact)?;
    let machine = u16::from_le_bytes([pe_header[4], pe_header[5]]);
    let characteristics = u16::from_le_bytes([pe_header[22], pe_header[23]]);
    let optional_magic = u16::from_le_bytes([pe_header[24], pe_header[25]]);
    let architecture_matches = (machine == I386_MACHINE && optional_magic == PE32)
        || (machine == AMD64_MACHINE && optional_magic == PE32_PLUS);
    if &pe_header[..4] != b"PE\0\0"
        || !architecture_matches
        || characteristics & EXECUTABLE_IMAGE == 0
    {
        return Err(UpdatePlatformInstallError::UnsafeArtifact);
    }
    Ok(())
}

#[cfg(test)]
#[path = "windows/tests.rs"]
mod tests;
