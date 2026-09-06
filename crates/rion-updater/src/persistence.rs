use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const UPDATE_PREFERENCES_FILE: &str = "app-update-preferences.json";
pub const INSTALL_JOURNAL_FILE: &str = "app-update-install-journal.json";
pub const INSTALL_TERMINAL_RECEIPT_DIRECTORY: &str = "app-update-terminal-receipts";
pub const PENDING_UPDATE_RECEIPT_FILE: &str = "pending-update-receipt.json";
pub(crate) const PENDING_UPDATE_MANIFEST_FILE: &str = "pending-update-manifest.json";
pub(crate) const UPDATE_STAGING_DIRECTORY: &str = "app-updates/pending";
const INSTALL_JOURNAL_SCHEMA_VERSION: u32 = 1;
pub(crate) const PENDING_UPDATE_SCHEMA_VERSION: u32 = 1;
const MAX_PERSISTED_JSON_BYTES: u64 = 2 * 1024 * 1024;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
type TerminalCleanupTestHook = Box<dyn FnOnce(&Path) + Send>;

#[cfg(test)]
static TERMINAL_CLEANUP_TEST_HOOKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, TerminalCleanupTestHook>>,
> = std::sync::OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePreferences {
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub consecutive_failures: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_version: Option<String>,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            auto_update_enabled: true,
            last_attempt_at: None,
            consecutive_failures: 0,
            pending_version: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallPhase {
    Accepted,
    Preparing,
    Installing,
    Draining,
    InstallerHandoff,
    RestartPending,
    Applied,
    FailedBeforeDrain,
    FailedAfterDrain,
}

impl InstallPhase {
    pub const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Accepted
                | Self::Preparing
                | Self::Installing
                | Self::Draining
                | Self::InstallerHandoff
                | Self::RestartPending
        )
    }

    pub const fn has_started_draining(self) -> bool {
        matches!(
            self,
            Self::Draining | Self::InstallerHandoff | Self::RestartPending | Self::FailedAfterDrain
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallAttemptRecord {
    pub attempt_id: String,
    pub target_version: String,
    pub phase: InstallPhase,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
}

impl InstallAttemptRecord {
    pub(crate) fn accepted(target_version: &Version) -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            attempt_id: format!("update-install-{}", uuid::Uuid::new_v4()),
            target_version: target_version.to_string(),
            phase: InstallPhase::Accepted,
            started_at: now.clone(),
            updated_at: now,
            failure_code: None,
        }
    }

    pub(crate) fn transition(&mut self, phase: InstallPhase, failure_code: Option<&str>) {
        self.phase = phase;
        self.updated_at = Utc::now().to_rfc3339();
        self.failure_code = failure_code.map(str::to_owned);
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStatusRecord {
    pub current_version: String,
    pub install_mode: String,
    pub is_packaged: bool,
    pub auto_update_enabled: bool,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_page_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_attempt: Option<InstallAttemptRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_retry_install: Option<bool>,
}

impl UpdateStatusRecord {
    pub(crate) fn idle(
        current_version: &Version,
        is_packaged: bool,
        auto_update_enabled: bool,
    ) -> Self {
        Self {
            current_version: current_version.to_string(),
            install_mode: "automatic".to_owned(),
            is_packaged,
            auto_update_enabled,
            state: if is_packaged { "idle" } else { "unsupported" }.to_owned(),
            available_version: None,
            download_progress: None,
            download_url: None,
            release_page_url: None,
            installer_name: None,
            error: None,
            error_code: None,
            checked_at: None,
            install_attempt: None,
            can_retry_install: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingUpdateReceipt {
    pub schema_version: u32,
    pub target_version: String,
    pub platform: String,
    pub artifact_file_name: String,
    pub artifact_bytes: u64,
    pub artifact_sha256: String,
    pub signature_sha256: String,
    pub manifest_sha256: String,
    pub staged_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallJournal {
    schema_version: u32,
    attempt: InstallAttemptRecord,
}

struct OpenedPrivateFile {
    file: File,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallTerminalReceiptRecord {
    pub schema_version: u32,
    pub kind: String,
    pub authority: String,
    pub source_journal_bytes: u64,
    pub source_journal_sha256: String,
    pub source_phase: InstallPhase,
    pub running_version: String,
    pub terminal_outcome: InstallPhase,
    pub reconciled_at: String,
    pub attempt: InstallAttemptRecord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InstallJournalCleanup {
    #[cfg(unix)]
    Removed,
    AlreadyAbsent,
    Retained,
    SourceChanged,
    DurabilityUncertain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstallTerminalCommit {
    pub receipt: InstallTerminalReceiptRecord,
    pub journal_cleanup: InstallJournalCleanup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CreateNewFileOutcome {
    Created,
    AlreadyExists,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallJournalRecovery {
    None,
    Applied(InstallAttemptRecord),
    Failed(InstallAttemptRecord, &'static str),
    Corrupt(&'static str),
}

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("UPDATE_PERSISTENCE_PATH_INVALID")]
    InvalidPath,
    #[error("UPDATE_PERSISTENCE_PATH_UNSAFE")]
    UnsafePath,
    #[error("UPDATE_PERSISTENCE_IO_FAILED")]
    Io(#[source] std::io::Error),
    #[error("UPDATE_PERSISTENCE_JSON_INVALID")]
    Json(#[source] serde_json::Error),
    #[error("UPDATE_PERSISTENCE_TOO_LARGE")]
    TooLarge,
    #[error("UPDATE_PERSISTENCE_ATOMIC_REPLACE_FAILED")]
    AtomicReplace,
    #[error("UPDATE_INSTALL_TERMINAL_RECEIPT_CONFLICT")]
    TerminalReceiptConflict,
}

pub(crate) fn load_preferences(path: &Path) -> UpdatePreferences {
    read_bounded_json(path).unwrap_or_default()
}

pub(crate) fn write_preferences(
    path: &Path,
    preferences: &UpdatePreferences,
) -> Result<(), PersistenceError> {
    write_private_json_atomic(path, preferences)
}

pub(crate) fn write_install_journal(
    path: &Path,
    attempt: &InstallAttemptRecord,
) -> Result<(), PersistenceError> {
    write_private_json_atomic(
        path,
        &InstallJournal {
            schema_version: INSTALL_JOURNAL_SCHEMA_VERSION,
            attempt: attempt.clone(),
        },
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn read_install_attempt(path: &Path) -> Result<InstallAttemptRecord, PersistenceError> {
    let journal = read_bounded_json::<InstallJournal>(path)?;
    if journal.schema_version != INSTALL_JOURNAL_SCHEMA_VERSION || !valid_attempt(&journal.attempt)
    {
        return Err(PersistenceError::Json(serde_json::Error::io(
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported update install journal",
            ),
        )));
    }
    Ok(journal.attempt)
}

pub fn reconcile_install_journal(path: &Path, current_version: &str) -> InstallJournalRecovery {
    let journal = match read_bounded_json::<InstallJournal>(path) {
        Ok(journal) => journal,
        Err(PersistenceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return InstallJournalRecovery::None;
        }
        Err(PersistenceError::Json(_)) => {
            remove_corrupt_file(path);
            return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_CORRUPT");
        }
        Err(PersistenceError::TooLarge) => {
            remove_corrupt_file(path);
            return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_TOO_LARGE");
        }
        Err(_) => {
            remove_corrupt_file(path);
            return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_UNREADABLE");
        }
    };
    if journal.schema_version != INSTALL_JOURNAL_SCHEMA_VERSION || !valid_attempt(&journal.attempt)
    {
        remove_corrupt_file(path);
        return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_UNSUPPORTED");
    }
    let mut attempt = journal.attempt;
    attempt.updated_at = Utc::now().to_rfc3339();
    if attempt.target_version == current_version {
        attempt.phase = InstallPhase::Applied;
        attempt.failure_code = None;
        return InstallJournalRecovery::Applied(attempt);
    }
    let (phase, code) = if attempt.phase.has_started_draining() {
        (
            InstallPhase::FailedAfterDrain,
            "UPDATE_INSTALL_VERSION_UNCHANGED",
        )
    } else if attempt.phase == InstallPhase::FailedBeforeDrain {
        (
            InstallPhase::FailedBeforeDrain,
            "UPDATE_INSTALL_FAILED_BEFORE_DRAIN",
        )
    } else {
        (
            InstallPhase::FailedBeforeDrain,
            "UPDATE_INSTALL_INTERRUPTED",
        )
    };
    attempt.transition(phase, Some(code));
    let _ = write_install_journal(path, &attempt);
    InstallJournalRecovery::Failed(attempt, code)
}

pub(crate) fn commit_applied_install_journal(
    path: &Path,
    applied_attempt: &InstallAttemptRecord,
    running_version: &str,
) -> Result<InstallTerminalCommit, PersistenceError> {
    commit_applied_install_journal_with_cleanup_hooks(
        path,
        applied_attempt,
        running_version,
        run_terminal_cleanup_test_hook,
        |_| {},
    )
}

#[cfg(test)]
pub(crate) fn register_terminal_cleanup_test_hook<F>(path: PathBuf, hook: F)
where
    F: FnOnce(&Path) + Send + 'static,
{
    TERMINAL_CLEANUP_TEST_HOOKS
        .get_or_init(Default::default)
        .lock()
        .expect("terminal cleanup test hooks must remain available")
        .insert(path, Box::new(hook));
}

#[cfg(test)]
fn run_terminal_cleanup_test_hook(path: &Path) {
    let hook = TERMINAL_CLEANUP_TEST_HOOKS
        .get_or_init(Default::default)
        .lock()
        .expect("terminal cleanup test hooks must remain available")
        .remove(path);
    if let Some(hook) = hook {
        hook(path);
    }
}

#[cfg(not(test))]
fn run_terminal_cleanup_test_hook(_path: &Path) {}

fn commit_applied_install_journal_with_cleanup_hooks<F, G>(
    path: &Path,
    applied_attempt: &InstallAttemptRecord,
    running_version: &str,
    before_cleanup: F,
    after_detach: G,
) -> Result<InstallTerminalCommit, PersistenceError>
where
    F: FnOnce(&Path),
    G: FnOnce(&Path),
{
    let source = match open_private_file_bounded(path, MAX_PERSISTED_JSON_BYTES, true) {
        Ok(source) => source,
        Err(PersistenceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return replay_absent_install_journal_receipt(path, applied_attempt, running_version);
        }
        Err(error) => return Err(error),
    };
    let journal: InstallJournal =
        serde_json::from_slice(&source.bytes).map_err(PersistenceError::Json)?;
    if journal.schema_version != INSTALL_JOURNAL_SCHEMA_VERSION
        || !valid_attempt(&journal.attempt)
        || !journal.attempt.phase.has_started_draining()
        || applied_attempt.phase != InstallPhase::Applied
        || applied_attempt.failure_code.is_some()
        || journal.attempt.attempt_id != applied_attempt.attempt_id
        || journal.attempt.target_version != applied_attempt.target_version
        || journal.attempt.started_at != applied_attempt.started_at
        || applied_attempt.target_version != running_version
        || Version::parse(running_version).is_err()
        || DateTime::parse_from_rfc3339(&applied_attempt.updated_at).ok()
            < DateTime::parse_from_rfc3339(&journal.attempt.updated_at).ok()
    {
        return Err(PersistenceError::TerminalReceiptConflict);
    }
    let source_journal_sha256 = hex_lower(&Sha256::digest(&source.bytes));
    let parent = path.parent().ok_or(PersistenceError::InvalidPath)?;
    let receipt_directory = parent.join(INSTALL_TERMINAL_RECEIPT_DIRECTORY);
    ensure_private_directory(&receipt_directory)?;
    let receipt_path = receipt_directory.join(format!("{source_journal_sha256}.json"));
    let expected = InstallTerminalReceiptRecord {
        schema_version: 1,
        kind: "rion-updater-install-terminal".to_owned(),
        authority: "target-first-boot-journal-reconciliation".to_owned(),
        source_journal_bytes: source.bytes.len() as u64,
        source_journal_sha256,
        source_phase: journal.attempt.phase,
        running_version: running_version.to_owned(),
        terminal_outcome: InstallPhase::Applied,
        reconciled_at: applied_attempt.updated_at.clone(),
        attempt: applied_attempt.clone(),
    };
    let receipt = match write_private_json_create_new(&receipt_path, &expected)? {
        CreateNewFileOutcome::Created => expected,
        CreateNewFileOutcome::AlreadyExists => {
            let existing = read_bounded_json::<InstallTerminalReceiptRecord>(&receipt_path)?;
            if !same_terminal_recovery(&existing, &expected) {
                return Err(PersistenceError::TerminalReceiptConflict);
            }
            existing
        }
    };
    if DateTime::parse_from_rfc3339(&receipt.reconciled_at).ok()
        < DateTime::parse_from_rfc3339(&journal.attempt.updated_at).ok()
    {
        return Err(PersistenceError::TerminalReceiptConflict);
    }
    // Persist the receipt directory entry in the user-data directory before the
    // active source journal can be removed. A crash may replay the journal, but
    // it must never lose both the journal and its terminal commit marker.
    sync_directory(&receipt_directory)?;
    sync_directory(parent)?;
    let journal_cleanup =
        cleanup_committed_install_journal(path, source, parent, before_cleanup, after_detach);
    Ok(InstallTerminalCommit {
        receipt,
        journal_cleanup,
    })
}

fn replay_absent_install_journal_receipt(
    path: &Path,
    applied_attempt: &InstallAttemptRecord,
    running_version: &str,
) -> Result<InstallTerminalCommit, PersistenceError> {
    const MAX_TERMINAL_RECEIPTS: usize = 1024;
    if applied_attempt.phase != InstallPhase::Applied
        || applied_attempt.failure_code.is_some()
        || applied_attempt.target_version != running_version
        || !valid_attempt(applied_attempt)
        || Version::parse(running_version).is_err()
    {
        return Err(PersistenceError::TerminalReceiptConflict);
    }
    let parent = path.parent().ok_or(PersistenceError::InvalidPath)?;
    let receipt_directory = parent.join(INSTALL_TERMINAL_RECEIPT_DIRECTORY);
    verify_existing_private_directory(parent)?;
    verify_existing_private_directory(&receipt_directory)?;
    let entries = fs::read_dir(&receipt_directory).map_err(PersistenceError::Io)?;
    let mut matching = None;
    for (offset, entry) in entries.enumerate() {
        if offset >= MAX_TERMINAL_RECEIPTS {
            return Err(PersistenceError::TerminalReceiptConflict);
        }
        let entry = entry.map_err(PersistenceError::Io)?;
        let receipt_path = entry.path();
        let Some(file_name) = receipt_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(source_sha256) = file_name.strip_suffix(".json") else {
            continue;
        };
        if source_sha256.len() != 64
            || !source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            continue;
        }
        let receipt = read_bounded_json::<InstallTerminalReceiptRecord>(&receipt_path)?;
        if !terminal_receipt_matches_applied_replay(
            &receipt,
            source_sha256,
            applied_attempt,
            running_version,
        ) {
            continue;
        }
        if matching.replace(receipt).is_some() {
            return Err(PersistenceError::TerminalReceiptConflict);
        }
    }
    verify_existing_private_directory(&receipt_directory)?;
    let receipt = matching
        .ok_or_else(|| PersistenceError::Io(std::io::Error::from(std::io::ErrorKind::NotFound)))?;
    Ok(InstallTerminalCommit {
        receipt,
        journal_cleanup: InstallJournalCleanup::AlreadyAbsent,
    })
}

fn verify_existing_private_directory(path: &Path) -> Result<(), PersistenceError> {
    let metadata = fs::symlink_metadata(path).map_err(PersistenceError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        // SAFETY: geteuid takes no arguments and has no memory-safety
        // preconditions.
        let effective_user = unsafe { libc::geteuid() };
        if metadata.uid() != effective_user || metadata.permissions().mode() & 0o077 != 0 {
            return Err(PersistenceError::UnsafePath);
        }
    }
    rion_platform::restrict_directory_to_current_user(path).map_err(|error| {
        // Preserve the native reason in test output without changing the
        // production error contract or retrying a security mutation.
        #[cfg(test)]
        eprintln!("Private-directory ACL rejection: {error}");
        #[cfg(not(test))]
        let _ = error;
        PersistenceError::UnsafePath
    })
}

fn terminal_receipt_matches_applied_replay(
    receipt: &InstallTerminalReceiptRecord,
    source_sha256: &str,
    applied_attempt: &InstallAttemptRecord,
    running_version: &str,
) -> bool {
    receipt.schema_version == 1
        && receipt.kind == "rion-updater-install-terminal"
        && receipt.authority == "target-first-boot-journal-reconciliation"
        && receipt.source_journal_bytes > 0
        && receipt.source_journal_bytes <= MAX_PERSISTED_JSON_BYTES
        && receipt.source_journal_sha256 == source_sha256
        && receipt.source_phase.has_started_draining()
        && receipt.running_version == running_version
        && receipt.terminal_outcome == InstallPhase::Applied
        && valid_timestamp(&receipt.reconciled_at)
        && receipt.attempt.attempt_id == applied_attempt.attempt_id
        && receipt.attempt.target_version == applied_attempt.target_version
        && receipt.attempt.started_at == applied_attempt.started_at
        && receipt.attempt.phase == InstallPhase::Applied
        && receipt.attempt.failure_code.is_none()
        && receipt.attempt.updated_at == receipt.reconciled_at
        && valid_attempt(&receipt.attempt)
}

fn cleanup_committed_install_journal<F, G>(
    path: &Path,
    source: OpenedPrivateFile,
    parent: &Path,
    before_removal: F,
    after_detach: G,
) -> InstallJournalCleanup
where
    F: FnOnce(&Path),
    G: FnOnce(&Path),
{
    match read_private_bytes_bounded(path, MAX_PERSISTED_JSON_BYTES) {
        Ok(current) if current != source.bytes => return InstallJournalCleanup::SourceChanged,
        Ok(_) => {}
        Err(PersistenceError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return InstallJournalCleanup::AlreadyAbsent;
        }
        Err(_) => return InstallJournalCleanup::Retained,
    }
    if rion_platform::verify_open_file_identity(path, &source.file).is_err() {
        return classify_changed_journal_path(path);
    }

    // Tests place an atomic replacement in the historical compare/remove gap.
    // The platform cleanup below must fence deletion to `source.file`, not to
    // whatever object happens to occupy `path` after this callback.
    before_removal(path);
    if rion_platform::verify_open_file_identity(path, &source.file).is_err() {
        return classify_changed_journal_path(path);
    }

    remove_open_install_journal(path, source.file, parent, after_detach)
}

fn classify_changed_journal_path(path: &Path) -> InstallJournalCleanup {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            InstallJournalCleanup::SourceChanged
        }
        Ok(_) => InstallJournalCleanup::Retained,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            InstallJournalCleanup::AlreadyAbsent
        }
        Err(_) => InstallJournalCleanup::Retained,
    }
}

#[cfg(windows)]
fn remove_open_install_journal<F>(
    path: &Path,
    source: File,
    parent: &Path,
    after_detach: F,
) -> InstallJournalCleanup
where
    F: FnOnce(&Path),
{
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: u8,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            file: *mut c_void,
            information_class: i32,
            information: *const c_void,
            information_bytes: u32,
        ) -> i32;
    }

    const FILE_DISPOSITION_INFO_CLASS: i32 = 4;
    let disposition = FileDispositionInfo { delete_file: 1 };
    // SAFETY: `source` is an owned file handle opened with DELETE access, the
    // information class and buffer layout are the documented Win32
    // FILE_DISPOSITION_INFO contract, and the buffer lives through the call.
    let deleted = unsafe {
        SetFileInformationByHandle(
            source.as_raw_handle().cast(),
            FILE_DISPOSITION_INFO_CLASS,
            (&raw const disposition).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        )
    } != 0;
    if !deleted {
        return InstallJournalCleanup::Retained;
    }
    drop(source);
    after_detach(path);

    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            InstallJournalCleanup::SourceChanged
        }
        Ok(_) => InstallJournalCleanup::Retained,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Windows has no supported directory fsync contract. The durable
            // receipt makes a replay safe, but deletion itself cannot be
            // claimed durable until a later boot observes the path absent.
            let _ = parent;
            InstallJournalCleanup::DurabilityUncertain
        }
        Err(_) => InstallJournalCleanup::DurabilityUncertain,
    }
}

#[cfg(unix)]
fn remove_open_install_journal<F>(
    path: &Path,
    source: File,
    parent: &Path,
    after_detach: F,
) -> InstallJournalCleanup
where
    F: FnOnce(&Path),
{
    let file_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(file_name) => file_name,
        None => return InstallJournalCleanup::Retained,
    };
    let quarantine = parent.join(format!(".{file_name}.{}.cleanup", uuid::Uuid::new_v4()));
    if let Err(error) = rename_no_replace(path, &quarantine) {
        return if error.kind() == std::io::ErrorKind::NotFound {
            InstallJournalCleanup::AlreadyAbsent
        } else {
            classify_changed_journal_path(path)
        };
    }
    if rion_platform::verify_open_file_identity(&quarantine, &source).is_err() {
        // A replacement won the race. Restore it only when the canonical name
        // is still free; otherwise retain both namespaces for diagnosis.
        let _ = rename_no_replace(&quarantine, path);
        return InstallJournalCleanup::SourceChanged;
    }
    drop(source);
    after_detach(path);
    match fs::remove_file(&quarantine) {
        Ok(()) => {
            let durability = sync_directory(parent);
            match fs::symlink_metadata(path) {
                Ok(_) => InstallJournalCleanup::SourceChanged,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if durability.is_ok() {
                        InstallJournalCleanup::Removed
                    } else {
                        InstallJournalCleanup::DurabilityUncertain
                    }
                }
                Err(_) => InstallJournalCleanup::Retained,
            }
        }
        Err(_) => InstallJournalCleanup::Retained,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    #[cfg(target_os = "macos")]
    // SAFETY: both paths are valid, NUL-terminated C strings and remain alive
    // through the atomic no-replace rename call.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    // SAFETY: both paths are valid, NUL-terminated C strings and remain alive
    // through the renameat2 syscall. RENAME_NOREPLACE is value 1 on Linux.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            1_u32,
        ) as i32
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn rename_no_replace(_source: &Path, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic no-replace journal quarantine is unavailable",
    ))
}

fn same_terminal_recovery(
    existing: &InstallTerminalReceiptRecord,
    expected: &InstallTerminalReceiptRecord,
) -> bool {
    existing.schema_version == 1
        && existing.kind == expected.kind
        && existing.authority == expected.authority
        && existing.source_journal_bytes == expected.source_journal_bytes
        && existing.source_journal_sha256 == expected.source_journal_sha256
        && existing.source_phase == expected.source_phase
        && existing.running_version == expected.running_version
        && existing.terminal_outcome == InstallPhase::Applied
        && valid_timestamp(&existing.reconciled_at)
        && existing.attempt.attempt_id == expected.attempt.attempt_id
        && existing.attempt.target_version == expected.attempt.target_version
        && existing.attempt.started_at == expected.attempt.started_at
        && existing.attempt.phase == InstallPhase::Applied
        && existing.attempt.failure_code.is_none()
        && existing.attempt.updated_at == existing.reconciled_at
        && valid_attempt(&existing.attempt)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            use std::fmt::Write;
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

pub(crate) fn staging_directory(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(UPDATE_STAGING_DIRECTORY)
}

pub(crate) fn clear_pending_update(user_data_dir: &Path) -> Result<(), PersistenceError> {
    let staging = staging_directory(user_data_dir);
    let metadata = match fs::symlink_metadata(&staging) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(PersistenceError::Io(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::UnsafePath);
    }
    #[cfg(unix)]
    {
        fs::remove_dir_all(&staging).map_err(PersistenceError::Io)?;
        if let Some(parent) = staging.parent() {
            sync_directory(parent)?;
        }
    }
    #[cfg(windows)]
    {
        let parent = staging.parent().ok_or(PersistenceError::InvalidPath)?;
        let tombstone = parent.join(format!(".pending.{}.cleanup", uuid::Uuid::new_v4()));
        if windows_move_file_no_replace_write_through(&staging, &tombstone)?
            != CreateNewFileOutcome::Created
        {
            return Err(PersistenceError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "pending cleanup tombstone already exists",
            )));
        }
        // The canonical `pending` name is durably absent before terminal
        // receipt publication. Tombstone reclamation is storage hygiene only;
        // a crash can resurrect at most this non-canonical directory.
        let _ = fs::remove_dir_all(&tombstone);
    }
    Ok(())
}

pub(crate) fn write_pending_receipt(
    path: &Path,
    receipt: &PendingUpdateReceipt,
) -> Result<(), PersistenceError> {
    write_private_json_atomic(path, receipt)
}

pub(crate) fn read_pending_receipt(path: &Path) -> Result<PendingUpdateReceipt, PersistenceError> {
    read_bounded_json(path)
}

pub(crate) fn read_private_bytes_bounded(
    path: &Path,
    maximum_bytes: u64,
) -> Result<Vec<u8>, PersistenceError> {
    Ok(open_private_file_bounded(path, maximum_bytes, false)?.bytes)
}

fn open_private_file_bounded(
    path: &Path,
    maximum_bytes: u64,
    delete_access: bool,
) -> Result<OpenedPrivateFile, PersistenceError> {
    let metadata = fs::symlink_metadata(path).map_err(PersistenceError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::UnsafePath);
    }
    if metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err(PersistenceError::TooLarge);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    if delete_access {
        use std::os::windows::fs::OpenOptionsExt;

        const DELETE: u32 = 0x0001_0000;
        const GENERIC_READ: u32 = 0x8000_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options
            .access_mode(GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(not(windows))]
    let _ = delete_access;
    let mut input = options.open(path).map_err(PersistenceError::Io)?;
    rion_platform::verify_open_file_identity(path, &input)
        .map_err(|_| PersistenceError::UnsafePath)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut input)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(PersistenceError::Io)?;
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes {
        return Err(PersistenceError::TooLarge);
    }
    Ok(OpenedPrivateFile { file: input, bytes })
}

pub(crate) fn write_private_bytes_atomic(
    path: &Path,
    content: &[u8],
) -> Result<(), PersistenceError> {
    let parent = path.parent().ok_or(PersistenceError::InvalidPath)?;
    ensure_private_directory(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(PersistenceError::InvalidPath)?;
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary).map_err(PersistenceError::Io)?;
        output.write_all(content).map_err(PersistenceError::Io)?;
        output.sync_all().map_err(PersistenceError::Io)?;
        drop(output);
        rion_platform::atomic_replace_file(&temporary, path)
            .map_err(|_| PersistenceError::AtomicReplace)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_private_json_create_new<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<CreateNewFileOutcome, PersistenceError> {
    let content = serde_json::to_vec(value).map_err(PersistenceError::Json)?;
    write_private_bytes_create_new(path, &content)
}

fn write_private_bytes_create_new(
    path: &Path,
    content: &[u8],
) -> Result<CreateNewFileOutcome, PersistenceError> {
    let parent = path.parent().ok_or(PersistenceError::InvalidPath)?;
    ensure_private_directory(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(PersistenceError::InvalidPath)?;
    let temporary = parent.join(format!(
        ".{file_name}.{}.create-new.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary).map_err(PersistenceError::Io)?;
        output.write_all(content).map_err(PersistenceError::Io)?;
        output.sync_all().map_err(PersistenceError::Io)?;
        drop(output);
        #[cfg(windows)]
        let outcome = windows_move_file_no_replace_write_through(&temporary, path)?;
        #[cfg(not(windows))]
        let outcome = match fs::hard_link(&temporary, path) {
            Ok(()) => CreateNewFileOutcome::Created,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                CreateNewFileOutcome::AlreadyExists
            }
            Err(error) => return Err(PersistenceError::Io(error)),
        };
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        if outcome == CreateNewFileOutcome::Created {
            sync_directory(parent)?;
        }
        Ok(outcome)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn ensure_private_directory(path: &Path) -> Result<(), PersistenceError> {
    fs::create_dir_all(path).map_err(PersistenceError::Io)?;
    let metadata = fs::symlink_metadata(path).map_err(PersistenceError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PersistenceError::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(PersistenceError::Io)?;
    }
    rion_platform::restrict_directory_to_current_user(path)
        .map_err(|_| PersistenceError::UnsafePath)
}

fn write_private_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), PersistenceError> {
    let content = serde_json::to_vec(value).map_err(PersistenceError::Json)?;
    write_private_bytes_atomic(path, &content)
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, PersistenceError> {
    let bytes = read_private_bytes_bounded(path, MAX_PERSISTED_JSON_BYTES)?;
    serde_json::from_slice(&bytes).map_err(PersistenceError::Json)
}

fn valid_attempt(attempt: &InstallAttemptRecord) -> bool {
    !attempt.attempt_id.is_empty()
        && attempt.attempt_id.len() <= 128
        && Version::parse(&attempt.target_version).is_ok()
        && valid_timestamp(&attempt.started_at)
        && valid_timestamp(&attempt.updated_at)
        && attempt
            .failure_code
            .as_ref()
            .is_none_or(|code| !code.is_empty() && code.len() <= 128)
}

fn valid_timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn remove_corrupt_file(path: &Path) {
    let _ = fs::remove_file(path);
}

fn sync_directory(path: &Path) -> Result<(), PersistenceError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(PersistenceError::Io)?;
    }
    #[cfg(windows)]
    {
        // Windows callers publish files with MOVEFILE_WRITE_THROUGH. There is
        // no supported directory-fsync equivalent here, so this function must
        // never upgrade a pathname deletion to a durable `Removed` outcome.
        let _ = path;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_move_file_no_replace_write_through(
    source: &Path,
    destination: &Path,
) -> Result<CreateNewFileOutcome, PersistenceError> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
        fn GetLastError() -> u32;
    }

    fn api_path(path: &Path) -> Result<Vec<u16>, PersistenceError> {
        const SEPARATOR: u16 = b'\\' as u16;
        const QUESTION_MARK: u16 = b'?' as u16;
        const DOT: u16 = b'.' as u16;

        let absolute = std::path::absolute(path).map_err(PersistenceError::Io)?;
        let encoded = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
        let already_namespaced =
            encoded.starts_with(&[SEPARATOR, SEPARATOR, QUESTION_MARK, SEPARATOR])
                || encoded.starts_with(&[SEPARATOR, SEPARATOR, DOT, SEPARATOR]);
        let mut api_path = if already_namespaced {
            encoded
        } else if encoded.starts_with(&[SEPARATOR, SEPARATOR]) {
            "\\\\?\\UNC\\"
                .encode_utf16()
                .chain(encoded.into_iter().skip(2))
                .collect()
        } else {
            "\\\\?\\".encode_utf16().chain(encoded).collect()
        };
        api_path.push(0);
        Ok(api_path)
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    const ERROR_FILE_EXISTS: u32 = 80;
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let source = api_path(source)?;
    let destination = api_path(destination)?;
    // SAFETY: both paths are valid, NUL-terminated UTF-16 buffers. Omitting
    // MOVEFILE_REPLACE_EXISTING provides the no-replace commit, while
    // MOVEFILE_WRITE_THROUGH makes the namespace publication durable before
    // the source install journal may be removed.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } != 0
    {
        return Ok(CreateNewFileOutcome::Created);
    }
    // SAFETY: GetLastError reads the calling thread's immediately preceding
    // Win32 failure state and takes no pointers.
    let error = unsafe { GetLastError() };
    if matches!(error, ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) {
        Ok(CreateNewFileOutcome::AlreadyExists)
    } else {
        Err(PersistenceError::Io(std::io::Error::from_raw_os_error(
            error as i32,
        )))
    }
}

const fn default_auto_update_enabled() -> bool {
    true
}

const fn is_zero(value: &u8) -> bool {
    *value == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(version: &str, phase: InstallPhase) -> InstallAttemptRecord {
        InstallAttemptRecord {
            attempt_id: "update-install-v22-compatible".to_owned(),
            target_version: version.to_owned(),
            phase,
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:00:00Z".to_owned(),
            failure_code: None,
        }
    }

    fn expected_successful_cleanup() -> InstallJournalCleanup {
        #[cfg(windows)]
        {
            InstallJournalCleanup::DurabilityUncertain
        }
        #[cfg(not(windows))]
        {
            InstallJournalCleanup::Removed
        }
    }

    #[test]
    fn reads_and_writes_the_v22_preferences_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(UPDATE_PREFERENCES_FILE);
        fs::write(
            &path,
            br#"{"autoUpdateEnabled":false,"lastAttemptAt":"2026-08-03T00:00:00Z","consecutiveFailures":2,"pendingVersion":"23.0.0"}"#,
        )
        .unwrap();
        let preferences = load_preferences(&path);
        assert!(!preferences.auto_update_enabled);
        assert_eq!(preferences.pending_version.as_deref(), Some("23.0.0"));
        write_preferences(&path, &preferences).unwrap();
        assert_eq!(load_preferences(&path), preferences);
    }

    #[test]
    fn v22_to_v23_and_v23_to_v23_journals_reconcile_by_running_version() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        write_install_journal(&path, &attempt("23.0.0", InstallPhase::RestartPending)).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching v22 journal must reconcile as applied");
        };
        assert!(
            path.exists(),
            "the source journal remains until cleanup commits"
        );
        let commit = commit_applied_install_journal(&path, &applied, "23.0.0").unwrap();
        assert_eq!(commit.receipt.source_phase, InstallPhase::RestartPending);
        assert_eq!(commit.receipt.terminal_outcome, InstallPhase::Applied);
        assert_eq!(commit.receipt.attempt.attempt_id, applied.attempt_id);
        assert_eq!(commit.journal_cleanup, expected_successful_cleanup());
        assert!(!path.exists());

        write_install_journal(&path, &attempt("23.1.0", InstallPhase::InstallerHandoff)).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.1.0")
        else {
            panic!("the matching v23 journal must reconcile as applied");
        };
        let commit = commit_applied_install_journal(&path, &applied, "23.1.0").unwrap();
        assert_eq!(commit.receipt.source_phase, InstallPhase::InstallerHandoff);
        assert_eq!(commit.journal_cleanup, expected_successful_cleanup());
        assert_eq!(
            fs::read_dir(directory.path().join(INSTALL_TERMINAL_RECEIPT_DIRECTORY))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn terminal_receipt_is_an_idempotent_commit_marker_for_the_exact_source_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };
        let first = commit_applied_install_journal(&path, &applied, "23.0.0").unwrap();

        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(replayed) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the replayed journal must reconcile as applied");
        };
        let second = commit_applied_install_journal(&path, &replayed, "23.0.0").unwrap();

        assert_eq!(second, first);
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_reconciler_reuses_the_receipt_after_the_winner_removes_the_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(first_applied) =
            reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the first manager must reconcile the journal as applied");
        };
        let InstallJournalRecovery::Applied(second_applied) =
            reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the concurrent manager must reconcile the journal as applied");
        };

        let winner = commit_applied_install_journal(&path, &first_applied, "23.0.0").unwrap();
        assert!(!path.exists());
        let replay = commit_applied_install_journal(&path, &second_applied, "23.0.0").unwrap();

        assert_eq!(replay.receipt, winner.receipt);
        assert_eq!(replay.journal_cleanup, InstallJournalCleanup::AlreadyAbsent);
        assert_eq!(replay.receipt.attempt.attempt_id, source_attempt.attempt_id);
    }

    #[test]
    fn terminal_receipt_create_new_commit_has_exactly_one_concurrent_winner() {
        use std::sync::{Arc, Barrier};

        // Exercise fresh parent/temporary-file interleavings. A native Windows
        // failure showed an UnsafePath rejection during concurrent
        // publication; every round must still have exactly one durable winner.
        for _round in 0..32 {
            let directory = tempfile::tempdir().unwrap();
            let parent = directory.path().join("receipts");
            ensure_private_directory(&parent).unwrap();
            let path = Arc::new(parent.join("terminal.json"));
            let barrier = Arc::new(Barrier::new(2));
            let threads = ["first", "second"].map(|marker| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let value = serde_json::json!({ "marker": marker });
                    barrier.wait();
                    let outcome = write_private_json_create_new(&path, &value).unwrap();
                    (value, outcome)
                })
            });
            let results = threads.map(|thread| thread.join().unwrap());
            assert_eq!(
                results
                    .iter()
                    .filter(|(_, outcome)| *outcome == CreateNewFileOutcome::Created)
                    .count(),
                1
            );
            assert_eq!(
                results
                    .iter()
                    .filter(|(_, outcome)| *outcome == CreateNewFileOutcome::AlreadyExists)
                    .count(),
                1
            );
            let stored = read_bounded_json::<serde_json::Value>(&path).unwrap();
            let winner = results
                .iter()
                .find(|(_, outcome)| *outcome == CreateNewFileOutcome::Created)
                .unwrap();
            assert_eq!(stored, winner.0);
        }
    }

    #[test]
    fn durable_receipt_replays_after_a_crash_before_source_journal_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let source = read_private_bytes_bounded(&path, MAX_PERSISTED_JSON_BYTES).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };
        let receipt =
            terminal_receipt_for_source(&source, source_attempt.phase, applied.clone(), "23.0.0");
        let receipt_directory = directory.path().join(INSTALL_TERMINAL_RECEIPT_DIRECTORY);
        ensure_private_directory(&receipt_directory).unwrap();
        let receipt_path =
            receipt_directory.join(format!("{}.json", receipt.source_journal_sha256));
        assert_eq!(
            write_private_json_create_new(&receipt_path, &receipt).unwrap(),
            CreateNewFileOutcome::Created
        );
        sync_directory(&receipt_directory).unwrap();
        sync_directory(directory.path()).unwrap();
        assert!(
            path.exists(),
            "the simulated crash retains the source journal"
        );

        let replay = commit_applied_install_journal(&path, &applied, "23.0.0").unwrap();
        assert_eq!(replay.receipt, receipt);
        assert_eq!(replay.journal_cleanup, expected_successful_cleanup());
        assert!(!path.exists());
    }

    #[test]
    fn literal_v22_journal_bytes_bind_the_v23_terminal_receipt() {
        const V22_JOURNAL: &[u8] = br#"{"schemaVersion":1,"attempt":{"attemptId":"update-install-42","targetVersion":"23.0.0","phase":"restartPending","startedAt":"2026-08-03T00:00:00Z","updatedAt":"2026-08-03T00:01:00Z"}}"#;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        fs::write(&path, V22_JOURNAL).unwrap();
        let expected_sha256 = hex_lower(&Sha256::digest(V22_JOURNAL));
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the literal v22 journal must reconcile as applied");
        };
        let commit = commit_applied_install_journal(&path, &applied, "23.0.0").unwrap();

        assert_eq!(
            commit.receipt.source_journal_bytes,
            V22_JOURNAL.len() as u64
        );
        assert_eq!(commit.receipt.source_journal_sha256, expected_sha256);
        assert_eq!(commit.receipt.source_phase, InstallPhase::RestartPending);
        assert_eq!(commit.receipt.attempt.attempt_id, "update-install-42");
        assert_eq!(commit.journal_cleanup, expected_successful_cleanup());
    }

    #[test]
    fn conflicting_terminal_receipt_is_never_replaced_and_retains_the_source_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let source = read_private_bytes_bounded(&path, MAX_PERSISTED_JSON_BYTES).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };
        let mut conflict =
            terminal_receipt_for_source(&source, source_attempt.phase, applied.clone(), "23.0.0");
        conflict.authority = "not-the-target-first-boot-authority".to_owned();
        let receipt_directory = directory.path().join(INSTALL_TERMINAL_RECEIPT_DIRECTORY);
        ensure_private_directory(&receipt_directory).unwrap();
        let receipt_path =
            receipt_directory.join(format!("{}.json", conflict.source_journal_sha256));
        write_private_json_create_new(&receipt_path, &conflict).unwrap();
        let before = fs::read(&receipt_path).unwrap();

        assert!(matches!(
            commit_applied_install_journal(&path, &applied, "23.0.0"),
            Err(PersistenceError::TerminalReceiptConflict)
        ));
        assert_eq!(fs::read(&receipt_path).unwrap(), before);
        assert!(path.exists());
    }

    #[test]
    fn atomic_replacement_in_the_compare_remove_window_is_never_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };

        let commit = commit_applied_install_journal_with_cleanup_hooks(
            &path,
            &applied,
            "23.0.0",
            |journal_path| write_private_bytes_atomic(journal_path, b"replacement").unwrap(),
            |_| {},
        )
        .unwrap();
        assert_eq!(commit.journal_cleanup, InstallJournalCleanup::SourceChanged);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert!(
            directory
                .path()
                .join(INSTALL_TERMINAL_RECEIPT_DIRECTORY)
                .join(format!("{}.json", commit.receipt.source_journal_sha256))
                .is_file()
        );
    }

    #[test]
    fn journal_created_after_exact_source_detach_is_reported_as_source_changed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };

        let commit = commit_applied_install_journal_with_cleanup_hooks(
            &path,
            &applied,
            "23.0.0",
            |_| {},
            |journal_path| write_private_bytes_atomic(journal_path, b"replacement").unwrap(),
        )
        .unwrap();

        assert_eq!(commit.journal_cleanup, InstallJournalCleanup::SourceChanged);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }

    #[test]
    fn terminal_commit_remains_committed_when_journal_cleanup_is_blocked() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::RestartPending);
        write_install_journal(&path, &source_attempt).unwrap();
        let InstallJournalRecovery::Applied(applied) = reconcile_install_journal(&path, "23.0.0")
        else {
            panic!("the matching journal must reconcile as applied");
        };

        let commit = commit_applied_install_journal_with_cleanup_hooks(
            &path,
            &applied,
            "23.0.0",
            |journal_path| {
                fs::remove_file(journal_path).unwrap();
                fs::create_dir(journal_path).unwrap();
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(commit.journal_cleanup, InstallJournalCleanup::Retained);
        assert!(path.is_dir());
        assert!(
            directory
                .path()
                .join(INSTALL_TERMINAL_RECEIPT_DIRECTORY)
                .join(format!("{}.json", commit.receipt.source_journal_sha256))
                .is_file()
        );
    }

    #[test]
    fn terminal_receipt_rejects_a_non_handoff_source_or_mismatched_running_version() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        let source_attempt = attempt("23.0.0", InstallPhase::Preparing);
        write_install_journal(&path, &source_attempt).unwrap();
        let mut fabricated = source_attempt.clone();
        fabricated.phase = InstallPhase::Applied;
        fabricated.updated_at = Utc::now().to_rfc3339();
        assert!(matches!(
            commit_applied_install_journal(&path, &fabricated, "23.0.0"),
            Err(PersistenceError::TerminalReceiptConflict)
        ));
        assert!(matches!(
            commit_applied_install_journal(&path, &fabricated, "23.1.0"),
            Err(PersistenceError::TerminalReceiptConflict)
        ));
        assert!(path.exists());
    }

    fn terminal_receipt_for_source(
        source: &[u8],
        source_phase: InstallPhase,
        applied: InstallAttemptRecord,
        running_version: &str,
    ) -> InstallTerminalReceiptRecord {
        InstallTerminalReceiptRecord {
            schema_version: 1,
            kind: "rion-updater-install-terminal".to_owned(),
            authority: "target-first-boot-journal-reconciliation".to_owned(),
            source_journal_bytes: source.len() as u64,
            source_journal_sha256: hex_lower(&Sha256::digest(source)),
            source_phase,
            running_version: running_version.to_owned(),
            terminal_outcome: InstallPhase::Applied,
            reconciled_at: applied.updated_at.clone(),
            attempt: applied,
        }
    }

    #[test]
    fn journal_recovery_fails_closed_for_interruption_stall_and_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(INSTALL_JOURNAL_FILE);
        write_install_journal(&path, &attempt("23.0.0", InstallPhase::Preparing)).unwrap();
        assert!(matches!(
            reconcile_install_journal(&path, "22.9.0"),
            InstallJournalRecovery::Failed(_, "UPDATE_INSTALL_INTERRUPTED")
        ));
        write_install_journal(&path, &attempt("23.0.0", InstallPhase::Draining)).unwrap();
        assert!(matches!(
            reconcile_install_journal(&path, "22.9.0"),
            InstallJournalRecovery::Failed(_, "UPDATE_INSTALL_VERSION_UNCHANGED")
        ));
        fs::write(&path, b"not-json").unwrap();
        assert_eq!(
            reconcile_install_journal(&path, "22.9.0"),
            InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_CORRUPT")
        );
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn durable_files_are_private_and_never_follow_a_symlink() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("private")
            .join(UPDATE_PREFERENCES_FILE);
        write_preferences(&path, &UpdatePreferences::default()).unwrap();
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let target = directory.path().join("target");
        fs::write(&target, b"{}").unwrap();
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_bounded_json::<UpdatePreferences>(&link).is_err());
    }
}
