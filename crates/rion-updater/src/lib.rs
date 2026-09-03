//! Shell-independent update verification for the Chromium desktop runtime.
//!
//! Electron is a transport and presentation layer only. Release selection,
//! artifact identity, SHA-256, and Minisign verification remain Rust-owned.

mod manager;
mod manifest;
mod persistence;
mod platform_install;
mod transport;
mod verification;

#[cfg(test)]
mod package_probe;

pub use manager::{
    ChromiumUpdateManager, ChromiumUpdateManagerConfig, InstallAcceptance, InstallDrainReceipt,
    InstallHandoffReceipt, InstallPrepareReceipt, UpdateManagerError, UpdateStatusEnvelope,
};
pub use manifest::{
    MAX_UPDATE_MANIFEST_BYTES, UpdateCandidate, UpdateManifestError, UpdatePlatform,
    select_update_candidate, validate_update_endpoint,
};
pub use persistence::{
    INSTALL_JOURNAL_FILE, INSTALL_TERMINAL_RECEIPT_DIRECTORY, InstallAttemptRecord,
    InstallJournalRecovery, InstallPhase, InstallTerminalReceiptRecord,
    PENDING_UPDATE_RECEIPT_FILE, PersistenceError, UPDATE_PREFERENCES_FILE, UpdatePreferences,
    UpdateStatusRecord, reconcile_install_journal,
};
pub use platform_install::{
    InstallHandoffEvidence, InstallPrepareEvidence, PlatformInstallRequest,
    UpdatePlatformInstallError, UpdatePlatformInstaller, production_platform_installer,
    run_macos_relaunch_helper, verify_macos_relaunch_target,
};
pub use transport::{ReqwestUpdateTransport, UpdateTransport, UpdateTransportError};
pub use verification::{
    MAX_UPDATE_ARTIFACT_BYTES, UpdateArtifactReceipt, UpdateVerificationError,
    verify_update_artifact,
};
