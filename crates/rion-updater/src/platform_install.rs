use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{InstallAttemptRecord, UpdatePlatform};

#[cfg(target_os = "macos")]
#[path = "platform_install/macos.rs"]
mod macos;
#[cfg(windows)]
#[path = "platform_install/windows.rs"]
mod windows;

#[derive(Clone, Debug)]
pub struct PlatformInstallRequest {
    pub attempt: InstallAttemptRecord,
    pub platform: UpdatePlatform,
    pub artifact_path: PathBuf,
    pub user_data_dir: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPrepareEvidence {
    pub attempt_id: String,
    pub target_version: String,
    pub platform: String,
    pub replacement_applied: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHandoffEvidence {
    pub attempt_id: String,
    pub target_version: String,
    pub platform: String,
    pub child_process_id: u32,
}

pub trait UpdatePlatformInstaller: Send + Sync {
    fn prepare(
        &self,
        request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError>;

    fn rollback(&self, attempt_id: &str) -> Result<(), UpdatePlatformInstallError>;

    fn handoff_after_drain(
        &self,
        attempt_id: &str,
        parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError>;

    fn finalize_applied(
        &self,
        _attempt: &InstallAttemptRecord,
        _user_data_dir: &std::path::Path,
    ) -> Result<(), UpdatePlatformInstallError> {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum UpdatePlatformInstallError {
    #[error("UPDATE_INSTALL_PLATFORM_UNSUPPORTED")]
    Unsupported,
    #[error("UPDATE_INSTALL_PLATFORM_MISMATCH")]
    PlatformMismatch,
    #[error("UPDATE_INSTALL_ARTIFACT_UNSAFE")]
    UnsafeArtifact,
    #[error("UPDATE_INSTALL_ARCHIVE_INVALID")]
    InvalidArchive,
    #[error("UPDATE_INSTALL_BUNDLE_INVALID")]
    InvalidBundle,
    #[error("UPDATE_INSTALL_BUNDLE_SIGNATURE_INVALID")]
    InvalidBundleSignature,
    #[error("UPDATE_INSTALL_REPLACEMENT_FAILED")]
    ReplacementFailed,
    #[error("UPDATE_INSTALL_ROLLBACK_FAILED")]
    RollbackFailed,
    #[error("UPDATE_INSTALL_HELPER_SPAWN_FAILED")]
    HelperSpawnFailed,
    #[error("UPDATE_INSTALL_HELPER_PARENT_WAIT_FAILED")]
    HelperParentWaitFailed,
    #[error("UPDATE_INSTALL_INSTALLER_SPAWN_FAILED")]
    InstallerSpawnFailed,
    #[error("UPDATE_INSTALL_STATE_UNAVAILABLE")]
    StateUnavailable,
    #[error("UPDATE_INSTALL_IO_FAILED")]
    Io(#[source] std::io::Error),
}

impl UpdatePlatformInstallError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "UPDATE_INSTALL_PLATFORM_UNSUPPORTED",
            Self::PlatformMismatch => "UPDATE_INSTALL_PLATFORM_MISMATCH",
            Self::UnsafeArtifact => "UPDATE_INSTALL_ARTIFACT_UNSAFE",
            Self::InvalidArchive => "UPDATE_INSTALL_ARCHIVE_INVALID",
            Self::InvalidBundle => "UPDATE_INSTALL_BUNDLE_INVALID",
            Self::InvalidBundleSignature => "UPDATE_INSTALL_BUNDLE_SIGNATURE_INVALID",
            Self::ReplacementFailed => "UPDATE_INSTALL_REPLACEMENT_FAILED",
            Self::RollbackFailed => "UPDATE_INSTALL_ROLLBACK_FAILED",
            Self::HelperSpawnFailed => "UPDATE_INSTALL_HELPER_SPAWN_FAILED",
            Self::HelperParentWaitFailed => "UPDATE_INSTALL_HELPER_PARENT_WAIT_FAILED",
            Self::InstallerSpawnFailed => "UPDATE_INSTALL_INSTALLER_SPAWN_FAILED",
            Self::StateUnavailable => "UPDATE_INSTALL_STATE_UNAVAILABLE",
            Self::Io(_) => "UPDATE_INSTALL_IO_FAILED",
        }
    }
}

pub fn production_platform_installer() -> Arc<dyn UpdatePlatformInstaller> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacosUpdateInstaller::default())
    }
    #[cfg(windows)]
    {
        Arc::new(windows::WindowsUpdateInstaller::default())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Arc::new(UnsupportedUpdateInstaller)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
struct UnsupportedUpdateInstaller;

#[cfg(not(any(target_os = "macos", windows)))]
impl UpdatePlatformInstaller for UnsupportedUpdateInstaller {
    fn prepare(
        &self,
        _request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }

    fn rollback(&self, _attempt_id: &str) -> Result<(), UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }

    fn handoff_after_drain(
        &self,
        _attempt_id: &str,
        _parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError> {
        Err(UpdatePlatformInstallError::Unsupported)
    }
}

pub fn run_macos_relaunch_helper(
    user_data_dir: PathBuf,
    attempt_id: String,
    current_version: String,
    parent_process_id: u32,
) -> Result<u32, UpdatePlatformInstallError> {
    #[cfg(target_os = "macos")]
    {
        macos::run_relaunch_helper(
            &user_data_dir,
            &attempt_id,
            &current_version,
            parent_process_id,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            user_data_dir,
            attempt_id,
            current_version,
            parent_process_id,
        );
        Err(UpdatePlatformInstallError::Unsupported)
    }
}

pub fn verify_macos_relaunch_target(
    user_data_dir: PathBuf,
    attempt_id: String,
    current_version: String,
) -> Result<(), UpdatePlatformInstallError> {
    #[cfg(target_os = "macos")]
    {
        macos::verify_relaunch_target(&user_data_dir, &attempt_id, &current_version)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (user_data_dir, attempt_id, current_version);
        Err(UpdatePlatformInstallError::Unsupported)
    }
}
