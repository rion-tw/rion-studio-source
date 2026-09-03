use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, Sender},
    },
};

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use crate::{
    InstallAttemptRecord, InstallHandoffEvidence, InstallJournalRecovery, InstallPhase,
    InstallPrepareEvidence, PlatformInstallRequest, UpdateCandidate, UpdateManifestError,
    UpdatePlatform, UpdatePlatformInstallError, UpdatePlatformInstaller, UpdateStatusRecord,
    UpdateTransport, UpdateTransportError, UpdateVerificationError,
    persistence::{
        INSTALL_JOURNAL_FILE, InstallJournalCleanup, PENDING_UPDATE_MANIFEST_FILE,
        PENDING_UPDATE_RECEIPT_FILE, PersistenceError, UPDATE_PREFERENCES_FILE, UpdatePreferences,
        clear_pending_update, commit_applied_install_journal, load_preferences,
        read_pending_receipt, read_private_bytes_bounded, reconcile_install_journal,
        staging_directory, write_install_journal, write_preferences,
    },
};

#[path = "manager/check.rs"]
mod check;
#[path = "manager/install.rs"]
mod install;

#[derive(Clone)]
pub struct ChromiumUpdateManagerConfig {
    pub user_data_dir: PathBuf,
    pub current_version: Version,
    pub platform: UpdatePlatform,
    pub packaged: bool,
    pub endpoint: Url,
    pub public_key_base64: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusEnvelope {
    pub revision: u64,
    pub status: UpdateStatusRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAcceptance {
    pub attempt: InstallAttemptRecord,
    pub leader: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPrepareReceipt {
    pub attempt: InstallAttemptRecord,
    pub evidence: InstallPrepareEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallDrainReceipt {
    pub attempt: InstallAttemptRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHandoffReceipt {
    pub attempt: InstallAttemptRecord,
    pub evidence: InstallHandoffEvidence,
}

pub struct ChromiumUpdateManager {
    pub(super) config: ChromiumUpdateManagerConfig,
    pub(super) transport: Arc<dyn UpdateTransport>,
    pub(super) installer: Arc<dyn UpdatePlatformInstaller>,
    pub(super) state: Mutex<ManagerState>,
    pub(super) completion: Condvar,
    subscribers: Mutex<Vec<Sender<UpdateStatusEnvelope>>>,
    event_stream_failed: AtomicBool,
}

pub(super) struct ManagerState {
    pub status: UpdateStatusRecord,
    pub revision: u64,
    pub preferences: UpdatePreferences,
    pub pending: Option<PendingUpdate>,
    pub check_in_flight: Option<u64>,
    pub next_check_identity: u64,
    pub install_attempt: Option<InstallAttemptRecord>,
    pub prepare_in_flight: bool,
    pub prepare_evidence: Option<InstallPrepareEvidence>,
    pub prepare_failure_code: Option<&'static str>,
    pub handoff_in_flight: bool,
    pub handoff_evidence: Option<InstallHandoffEvidence>,
    pub handoff_failure_code: Option<&'static str>,
    pub recovery_blocked: Option<&'static str>,
}

#[derive(Clone)]
pub(super) struct PendingUpdate {
    pub candidate: UpdateCandidate,
    pub artifact_path: PathBuf,
}

#[derive(Debug, Error)]
pub enum UpdateManagerError {
    #[error("UPDATE_MANAGER_STATE_UNAVAILABLE")]
    StateUnavailable,
    #[error("UPDATE_EVENT_STREAM_UNAVAILABLE")]
    EventStreamUnavailable,
    #[error("UPDATE_MANAGER_CONFIG_INVALID")]
    InvalidConfig,
    #[error("UPDATE_NOT_READY")]
    NoPendingUpdate,
    #[error("UPDATE_INSTALL_ATTEMPT_INVALID")]
    InvalidInstallAttempt,
    #[error("{0}")]
    Stable(&'static str),
    #[error("UPDATE_MANIFEST_INVALID")]
    Manifest(#[source] UpdateManifestError),
    #[error("UPDATE_TRANSPORT_FAILED")]
    Transport(#[source] UpdateTransportError),
    #[error("UPDATE_VERIFICATION_FAILED")]
    Verification(#[source] UpdateVerificationError),
    #[error("UPDATE_PERSISTENCE_FAILED")]
    Persistence(#[source] PersistenceError),
    #[error("UPDATE_PLATFORM_INSTALL_FAILED")]
    PlatformInstall(#[source] UpdatePlatformInstallError),
}

impl UpdateManagerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::StateUnavailable => "UPDATE_MANAGER_STATE_UNAVAILABLE",
            Self::EventStreamUnavailable => "UPDATE_EVENT_STREAM_UNAVAILABLE",
            Self::InvalidConfig => "UPDATE_MANAGER_CONFIG_INVALID",
            Self::NoPendingUpdate => "UPDATE_NOT_READY",
            Self::InvalidInstallAttempt => "UPDATE_INSTALL_ATTEMPT_INVALID",
            Self::Stable(code) => code,
            Self::Manifest(error) => match error {
                UpdateManifestError::TooLarge => "UPDATE_MANIFEST_TOO_LARGE",
                UpdateManifestError::InvalidJson => "UPDATE_MANIFEST_INVALID_JSON",
                UpdateManifestError::InvalidVersion => "UPDATE_MANIFEST_VERSION_INVALID",
                UpdateManifestError::InvalidPublishedAt => "UPDATE_MANIFEST_PUBLISHED_AT_INVALID",
                UpdateManifestError::InvalidNotes => "UPDATE_MANIFEST_NOTES_INVALID",
                UpdateManifestError::InvalidArtifactUrl => "UPDATE_MANIFEST_ARTIFACT_URL_INVALID",
                UpdateManifestError::InvalidSignature => "UPDATE_MANIFEST_SIGNATURE_INVALID",
                UpdateManifestError::InvalidSha256 => "UPDATE_MANIFEST_SHA256_INVALID",
            },
            Self::Transport(error) => error.code(),
            Self::Verification(error) => match error {
                UpdateVerificationError::Unreadable(_) => "UPDATE_ARTIFACT_UNREADABLE",
                UpdateVerificationError::NotRegular => "UPDATE_ARTIFACT_NOT_REGULAR",
                UpdateVerificationError::TooLarge => "UPDATE_ARTIFACT_TOO_LARGE",
                UpdateVerificationError::SizeMismatch => "UPDATE_ARTIFACT_SIZE_MISMATCH",
                UpdateVerificationError::Sha256Mismatch => "UPDATE_ARTIFACT_SHA256_MISMATCH",
                UpdateVerificationError::InvalidPublicKey => "UPDATE_SIGNATURE_KEY_INVALID",
                UpdateVerificationError::InvalidSignature => "UPDATE_SIGNATURE_INVALID",
            },
            Self::Persistence(error) => match error {
                PersistenceError::InvalidPath => "UPDATE_PERSISTENCE_PATH_INVALID",
                PersistenceError::UnsafePath => "UPDATE_PERSISTENCE_PATH_UNSAFE",
                PersistenceError::Io(_) => "UPDATE_PERSISTENCE_IO_FAILED",
                PersistenceError::Json(_) => "UPDATE_PERSISTENCE_JSON_INVALID",
                PersistenceError::TooLarge => "UPDATE_PERSISTENCE_TOO_LARGE",
                PersistenceError::AtomicReplace => "UPDATE_PERSISTENCE_ATOMIC_REPLACE_FAILED",
                PersistenceError::TerminalReceiptConflict => {
                    "UPDATE_INSTALL_TERMINAL_RECEIPT_CONFLICT"
                }
            },
            Self::PlatformInstall(error) => error.code(),
        }
    }
}

impl ChromiumUpdateManager {
    pub fn new(
        config: ChromiumUpdateManagerConfig,
        transport: Arc<dyn UpdateTransport>,
        installer: Arc<dyn UpdatePlatformInstaller>,
    ) -> Result<Self, UpdateManagerError> {
        validate_config(&config)?;
        let preferences_path = config.user_data_dir.join(UPDATE_PREFERENCES_FILE);
        let install_journal_path = config.user_data_dir.join(INSTALL_JOURNAL_FILE);
        let mut preferences = load_preferences(&preferences_path);
        let recovery =
            reconcile_install_journal(&install_journal_path, &config.current_version.to_string());
        let mut status = UpdateStatusRecord::idle(
            &config.current_version,
            config.packaged,
            preferences.auto_update_enabled,
        );
        let has_configuration_error = config.packaged && config.public_key_base64.is_empty();
        if has_configuration_error {
            status.state = "error".to_owned();
            status.error = Some("UPDATE_SIGNATURE_KEY_MISSING".to_owned());
            status.error_code = Some("UPDATE_SIGNATURE_KEY_MISSING".to_owned());
        }
        let mut recovery_blocked = None;
        let install_attempt = match &recovery {
            InstallJournalRecovery::Applied(attempt) => {
                installer
                    .finalize_applied(attempt, &config.user_data_dir)
                    .map_err(UpdateManagerError::PlatformInstall)?;
                clear_pending_update(&config.user_data_dir)
                    .map_err(UpdateManagerError::Persistence)?;
                preferences.pending_version = None;
                preferences.consecutive_failures = 0;
                write_preferences(&preferences_path, &preferences)
                    .map_err(UpdateManagerError::Persistence)?;
                let terminal_commit = commit_applied_install_journal(
                    &install_journal_path,
                    attempt,
                    &config.current_version.to_string(),
                )
                .map_err(UpdateManagerError::Persistence)?;
                let terminal_attempt = terminal_commit.receipt.attempt;
                if terminal_commit.journal_cleanup == InstallJournalCleanup::SourceChanged {
                    recovery_blocked = Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED");
                }
                apply_applied_recovery_status(
                    &mut status,
                    &terminal_attempt,
                    terminal_commit.journal_cleanup,
                    has_configuration_error,
                );
                Some(terminal_attempt)
            }
            InstallJournalRecovery::Failed(attempt, code) => {
                status.state = "install_failed".to_owned();
                status.available_version = Some(attempt.target_version.clone());
                status.error = Some((*code).to_owned());
                status.error_code = Some((*code).to_owned());
                status.install_attempt = Some(attempt.clone());
                status.can_retry_install = Some(!attempt.phase.has_started_draining());
                Some(attempt.clone())
            }
            InstallJournalRecovery::Corrupt(code) => {
                status.state = "install_failed".to_owned();
                status.error = Some((*code).to_owned());
                status.error_code = Some((*code).to_owned());
                status.can_retry_install = Some(true);
                None
            }
            InstallJournalRecovery::None => None,
        };
        let pending = if recovery_blocked.is_none()
            && config.packaged
            && !config.public_key_base64.is_empty()
        {
            match restore_pending_update(&config) {
                Ok(pending) => pending,
                Err(error) => {
                    let code = error.code();
                    status.state = "error".to_owned();
                    status.error = Some(code.to_owned());
                    status.error_code = Some(code.to_owned());
                    None
                }
            }
        } else {
            None
        };
        if let Some(pending) = &pending {
            status.state = "downloaded".to_owned();
            status.available_version = Some(pending.candidate.version.to_string());
            status.download_progress = Some(100);
            status.checked_at = Some(chrono::Utc::now().to_rfc3339());
        }
        Ok(Self {
            config,
            transport,
            installer,
            state: Mutex::new(ManagerState {
                status,
                revision: 1,
                preferences,
                pending,
                check_in_flight: None,
                next_check_identity: 1,
                install_attempt,
                prepare_in_flight: false,
                prepare_evidence: None,
                prepare_failure_code: None,
                handoff_in_flight: false,
                handoff_evidence: None,
                handoff_failure_code: None,
                recovery_blocked,
            }),
            completion: Condvar::new(),
            subscribers: Mutex::new(Vec::new()),
            event_stream_failed: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> Result<UpdateStatusEnvelope, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        self.ensure_event_stream_available()?;
        Ok(envelope(&state))
    }

    pub fn subscribe(&self) -> Result<Receiver<UpdateStatusEnvelope>, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        self.subscribe_with_snapshot_observer(|| {})
    }

    fn subscribe_with_snapshot_observer(
        &self,
        after_snapshot: impl FnOnce(),
    ) -> Result<Receiver<UpdateStatusEnvelope>, UpdateManagerError> {
        let (sender, receiver) = std::sync::mpsc::channel();
        let state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        let current = envelope(&state);
        after_snapshot();
        // Keep the state fence through registration. Publishers hold the same
        // state -> subscribers lock order, so no revision can land between the
        // subscriber's initial snapshot and its durable stream membership.
        let mut subscribers = self.lock_subscribers()?;
        sender
            .send(current)
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        subscribers.push(sender);
        Ok(receiver)
    }

    pub fn set_auto_update_enabled(
        &self,
        enabled: bool,
    ) -> Result<UpdateStatusEnvelope, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        self.ensure_event_stream_available()?;
        let mut next = state.preferences.clone();
        next.auto_update_enabled = enabled;
        write_preferences(
            &self.config.user_data_dir.join(UPDATE_PREFERENCES_FILE),
            &next,
        )
        .map_err(UpdateManagerError::Persistence)?;
        state.preferences = next;
        state.status.auto_update_enabled = enabled;
        self.publish_locked(&mut state)
    }

    pub(super) fn publish_locked(
        &self,
        state: &mut ManagerState,
    ) -> Result<UpdateStatusEnvelope, UpdateManagerError> {
        // Acquire delivery authority before minting a revision. A poisoned
        // registry has unknown delivery history, so it cannot be recovered as
        // a live stream or silently skipped.
        self.ensure_event_stream_available()?;
        let mut subscribers = self.lock_subscribers()?;
        state.revision = state.revision.saturating_add(1);
        let event = envelope(state);
        subscribers.retain(|sender| sender.send(event.clone()).is_ok());
        Ok(event)
    }

    fn lock_subscribers(
        &self,
    ) -> Result<MutexGuard<'_, Vec<Sender<UpdateStatusEnvelope>>>, UpdateManagerError> {
        match self.subscribers.lock() {
            Ok(subscribers) => Ok(subscribers),
            Err(poisoned) => {
                self.event_stream_failed.store(true, Ordering::Release);
                // Recovery is used only to drop every sender and wake each
                // receiver into its authoritative terminal path. The poisoned
                // registry remains poisoned and is never reused for delivery.
                poisoned.into_inner().clear();
                Err(UpdateManagerError::EventStreamUnavailable)
            }
        }
    }

    pub(super) fn ensure_event_stream_available(&self) -> Result<(), UpdateManagerError> {
        if self.event_stream_failed.load(Ordering::Acquire) {
            return Err(UpdateManagerError::EventStreamUnavailable);
        }
        if self.subscribers.is_poisoned() {
            return self.lock_subscribers().map(|_| ());
        }
        Ok(())
    }

    pub(super) fn persist_preferences_locked(
        &self,
        state: &ManagerState,
    ) -> Result<(), UpdateManagerError> {
        write_preferences(
            &self.config.user_data_dir.join(UPDATE_PREFERENCES_FILE),
            &state.preferences,
        )
        .map_err(UpdateManagerError::Persistence)
    }

    pub(super) fn install_request_locked(
        &self,
        state: &ManagerState,
        attempt_id: &str,
    ) -> Result<PlatformInstallRequest, UpdateManagerError> {
        self.ensure_recovery_mutations_allowed(state)?;
        let attempt = state
            .install_attempt
            .as_ref()
            .filter(|attempt| attempt.attempt_id == attempt_id && attempt.phase.is_active())
            .ok_or(UpdateManagerError::InvalidInstallAttempt)?;
        let pending = state
            .pending
            .as_ref()
            .filter(|pending| pending.candidate.version.to_string() == attempt.target_version)
            .ok_or(UpdateManagerError::NoPendingUpdate)?;
        Ok(PlatformInstallRequest {
            attempt: attempt.clone(),
            platform: self.config.platform,
            artifact_path: pending.artifact_path.clone(),
            user_data_dir: self.config.user_data_dir.clone(),
        })
    }

    pub(super) fn transition_install_locked(
        &self,
        state: &mut ManagerState,
        phase: InstallPhase,
        status_name: &str,
        failure_code: Option<&str>,
        can_retry: Option<bool>,
    ) -> Result<InstallAttemptRecord, UpdateManagerError> {
        self.ensure_recovery_mutations_allowed(state)?;
        let attempt = state
            .install_attempt
            .as_mut()
            .ok_or(UpdateManagerError::InvalidInstallAttempt)?;
        attempt.transition(phase, failure_code);
        write_install_journal(
            &self.config.user_data_dir.join(INSTALL_JOURNAL_FILE),
            attempt,
        )
        .map_err(UpdateManagerError::Persistence)?;
        let attempt = attempt.clone();
        state.status.state = status_name.to_owned();
        state.status.available_version = Some(attempt.target_version.clone());
        state.status.install_attempt = Some(attempt.clone());
        state.status.error_code = failure_code.map(str::to_owned);
        state.status.error = failure_code.map(str::to_owned);
        state.status.can_retry_install = can_retry;
        state.status.checked_at = Some(chrono::Utc::now().to_rfc3339());
        self.publish_locked(state)?;
        Ok(attempt)
    }

    pub(super) fn ensure_recovery_mutations_allowed(
        &self,
        state: &ManagerState,
    ) -> Result<(), UpdateManagerError> {
        if let Some(code) = state.recovery_blocked {
            Err(UpdateManagerError::Stable(code))
        } else {
            Ok(())
        }
    }
}

fn apply_applied_recovery_status(
    status: &mut UpdateStatusRecord,
    terminal_attempt: &InstallAttemptRecord,
    cleanup: InstallJournalCleanup,
    preserve_configuration_error: bool,
) {
    status.install_attempt = Some(terminal_attempt.clone());
    if preserve_configuration_error {
        return;
    }
    let code = match cleanup {
        InstallJournalCleanup::Removed
        | InstallJournalCleanup::AlreadyAbsent
        | InstallJournalCleanup::Retained
        | InstallJournalCleanup::DurabilityUncertain => {
            status.state = "idle".to_owned();
            status.error = None;
            status.error_code = None;
            status.can_retry_install = None;
            return;
        }
        InstallJournalCleanup::SourceChanged => "UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED",
    };
    // The immutable receipt still establishes Applied, but another canonical
    // journal is a separate authority that must quarantine further mutation.
    status.state = "error".to_owned();
    status.error = Some(code.to_owned());
    status.error_code = Some(code.to_owned());
    status.can_retry_install = Some(false);
}

fn validate_config(config: &ChromiumUpdateManagerConfig) -> Result<(), UpdateManagerError> {
    if !config.user_data_dir.is_absolute()
        || crate::validate_update_endpoint(config.endpoint.as_str()).is_err()
        || config.public_key_base64.trim() != config.public_key_base64
    {
        return Err(UpdateManagerError::InvalidConfig);
    }
    Ok(())
}

fn restore_pending_update(
    config: &ChromiumUpdateManagerConfig,
) -> Result<Option<PendingUpdate>, UpdateManagerError> {
    let staging = staging_directory(&config.user_data_dir);
    let receipt_path = staging.join(PENDING_UPDATE_RECEIPT_FILE);
    if !receipt_path.exists() {
        return Ok(None);
    }
    let receipt = read_pending_receipt(&receipt_path).map_err(UpdateManagerError::Persistence)?;
    if receipt.schema_version != crate::persistence::PENDING_UPDATE_SCHEMA_VERSION
        || receipt.platform != config.platform.to_string()
        || receipt.artifact_file_name != config.platform.staged_file_name()
    {
        return Err(UpdateManagerError::Stable(
            "UPDATE_PENDING_RECEIPT_UNSUPPORTED",
        ));
    }
    let manifest_path = staging.join(PENDING_UPDATE_MANIFEST_FILE);
    let manifest =
        read_private_bytes_bounded(&manifest_path, crate::MAX_UPDATE_MANIFEST_BYTES as u64)
            .map_err(UpdateManagerError::Persistence)?;
    if hex_lower(&Sha256::digest(&manifest)) != receipt.manifest_sha256 {
        return Err(UpdateManagerError::Stable(
            "UPDATE_PENDING_MANIFEST_SHA256_MISMATCH",
        ));
    }
    let candidate = crate::select_update_candidate(
        &manifest,
        &config.current_version.to_string(),
        config.platform,
    )
    .map_err(UpdateManagerError::Manifest)?
    .ok_or(UpdateManagerError::Stable(
        "UPDATE_PENDING_VERSION_NOT_NEWER",
    ))?;
    let artifact_path = staging.join(&receipt.artifact_file_name);
    let verified = crate::verify_update_artifact(
        &artifact_path,
        &candidate,
        Some(receipt.artifact_bytes),
        &config.public_key_base64,
    )
    .map_err(UpdateManagerError::Verification)?;
    if verified.artifact_sha256 != receipt.artifact_sha256
        || verified.signature_sha256 != receipt.signature_sha256
        || verified.version.to_string() != receipt.target_version
    {
        return Err(UpdateManagerError::Stable(
            "UPDATE_PENDING_RECEIPT_MISMATCH",
        ));
    }
    Ok(Some(PendingUpdate {
        candidate,
        artifact_path,
    }))
}

fn envelope(state: &ManagerState) -> UpdateStatusEnvelope {
    UpdateStatusEnvelope {
        revision: state.revision,
        status: state.status.clone(),
    }
}

pub(super) fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;

    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

#[cfg(test)]
#[path = "manager/tests.rs"]
mod tests;
