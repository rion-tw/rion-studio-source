use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use rion_core::AppUpdateInstallAttemptRecord;
use serde::{Deserialize, Serialize};

pub(crate) const INSTALL_JOURNAL_FILE: &str = "app-update-install-journal.json";
const INSTALL_JOURNAL_SCHEMA_VERSION: u32 = 1;
static INSTALL_ATTEMPT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static INSTALL_JOURNAL_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallPlatform {
    #[cfg(any(target_os = "macos", test))]
    Macos,
    Windows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallBoundary {
    InstallReturned,
    BeforeExit,
}

pub(crate) fn install_boundary_contract(
    platform: InstallPlatform,
    boundary: InstallBoundary,
) -> Result<(&'static str, &'static str), &'static str> {
    match (platform, boundary) {
        #[cfg(any(target_os = "macos", test))]
        (InstallPlatform::Macos, InstallBoundary::InstallReturned) => {
            Ok(("restartPending", "restart_pending"))
        }
        (InstallPlatform::Windows, InstallBoundary::BeforeExit) => {
            Ok(("installerHandoff", "restart_pending"))
        }
        (InstallPlatform::Windows, InstallBoundary::InstallReturned) => {
            Err("UPDATE_INSTALLER_HANDOFF_RETURNED")
        }
        #[cfg(any(target_os = "macos", test))]
        (InstallPlatform::Macos, InstallBoundary::BeforeExit) => {
            Err("UPDATE_INSTALL_MACOS_BEFORE_EXIT_UNEXPECTED")
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallJournal {
    schema_version: u32,
    attempt: AppUpdateInstallAttemptRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InstallJournalRecovery {
    None,
    Applied(AppUpdateInstallAttemptRecord),
    Failed(AppUpdateInstallAttemptRecord, &'static str),
    Corrupt(&'static str),
}

#[derive(Default)]
pub(crate) struct InstallAttemptGate {
    current: Mutex<Option<AppUpdateInstallAttemptRecord>>,
}

impl InstallAttemptGate {
    pub(crate) fn active_attempt(&self) -> Result<Option<AppUpdateInstallAttemptRecord>, String> {
        self.current
            .lock()
            .map_err(|_| "Update install gate is unavailable.".to_owned())
            .map(|current| {
                current
                    .as_ref()
                    .filter(|attempt| install_phase_is_active(&attempt.phase))
                    .cloned()
            })
    }

    pub(crate) fn accept(
        &self,
        target_version: &str,
    ) -> Result<(AppUpdateInstallAttemptRecord, bool), String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Update install gate is unavailable.".to_owned())?;
        if let Some(attempt) = current.as_ref()
            && install_phase_is_active(&attempt.phase)
        {
            return Ok((attempt.clone(), false));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let sequence = INSTALL_ATTEMPT_SEQUENCE.fetch_add(1, Ordering::AcqRel);
        let attempt = AppUpdateInstallAttemptRecord {
            attempt_id: format!("update-install-{sequence}"),
            target_version: target_version.to_owned(),
            phase: "accepted".to_owned(),
            started_at: now.clone(),
            updated_at: now,
            failure_code: None,
        };
        *current = Some(attempt.clone());
        Ok((attempt, true))
    }

    pub(crate) fn transition(
        &self,
        phase: &str,
        failure_code: Option<&str>,
    ) -> Result<AppUpdateInstallAttemptRecord, String> {
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Update install gate is unavailable.".to_owned())?;
        let attempt = current
            .as_mut()
            .ok_or_else(|| "No update install attempt is active.".to_owned())?;
        attempt.phase = phase.to_owned();
        attempt.updated_at = chrono::Utc::now().to_rfc3339();
        attempt.failure_code = failure_code.map(str::to_owned);
        Ok(attempt.clone())
    }

    pub(crate) fn has_started_draining(&self) -> bool {
        self.current
            .lock()
            .ok()
            .and_then(|attempt| attempt.as_ref().map(|attempt| attempt.phase.clone()))
            .is_some_and(|phase| {
                matches!(
                    phase.as_str(),
                    "draining" | "installerHandoff" | "restartPending" | "failedAfterDrain"
                )
            })
    }
}

pub(crate) fn install_journal_path(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(INSTALL_JOURNAL_FILE)
}

pub(crate) fn write_install_journal(
    path: &Path,
    attempt: &AppUpdateInstallAttemptRecord,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Update install journal path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{INSTALL_JOURNAL_FILE}.{}.{}.tmp",
        std::process::id(),
        INSTALL_JOURNAL_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let journal = InstallJournal {
            schema_version: INSTALL_JOURNAL_SCHEMA_VERSION,
            attempt: attempt.clone(),
        };
        let content = serde_json::to_vec(&journal).map_err(|error| error.to_string())?;
        fs::write(&temporary, content).map_err(|error| error.to_string())?;
        rion_platform::atomic_replace_file(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn reconcile_install_journal(
    path: &Path,
    current_version: &str,
) -> InstallJournalRecovery {
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return InstallJournalRecovery::None;
        }
        Err(_) => {
            let _ = fs::remove_file(path);
            return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_UNREADABLE");
        }
    };
    let Ok(journal) = serde_json::from_slice::<InstallJournal>(&content) else {
        let _ = fs::remove_file(path);
        return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_CORRUPT");
    };
    if journal.schema_version != INSTALL_JOURNAL_SCHEMA_VERSION {
        let _ = fs::remove_file(path);
        return InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_UNSUPPORTED");
    }
    let mut attempt = journal.attempt;
    attempt.updated_at = chrono::Utc::now().to_rfc3339();
    if attempt.target_version == current_version {
        attempt.phase = "applied".to_owned();
        attempt.failure_code = None;
        let _ = fs::remove_file(path);
        return InstallJournalRecovery::Applied(attempt);
    }
    let (phase, code) = match attempt.phase.as_str() {
        "draining" | "installerHandoff" | "restartPending" | "failedAfterDrain" => {
            ("failedAfterDrain", "UPDATE_INSTALL_VERSION_UNCHANGED")
        }
        "failedBeforeDrain" => ("failedBeforeDrain", "UPDATE_INSTALL_FAILED_BEFORE_DRAIN"),
        _ => ("failedBeforeDrain", "UPDATE_INSTALL_INTERRUPTED"),
    };
    attempt.phase = phase.to_owned();
    attempt.failure_code = Some(code.to_owned());
    let _ = write_install_journal(path, &attempt);
    InstallJournalRecovery::Failed(attempt, code)
}

fn install_phase_is_active(phase: &str) -> bool {
    matches!(
        phase,
        "accepted"
            | "preparing"
            | "installing"
            | "draining"
            | "installerHandoff"
            | "restartPending"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(version: &str, phase: &str) -> AppUpdateInstallAttemptRecord {
        AppUpdateInstallAttemptRecord {
            attempt_id: "attempt-1".to_owned(),
            target_version: version.to_owned(),
            phase: phase.to_owned(),
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:00:00Z".to_owned(),
            failure_code: None,
        }
    }

    #[test]
    fn install_gate_deduplicates_active_attempts_and_allows_retry_after_failure() {
        let gate = InstallAttemptGate::default();
        let (first, leader) = gate.accept("2.0.0").unwrap();
        assert!(leader);
        assert_eq!(gate.active_attempt().unwrap(), Some(first.clone()));
        let (duplicate, leader) = gate.accept("2.0.0").unwrap();
        assert!(!leader);
        assert_eq!(duplicate.attempt_id, first.attempt_id);
        gate.transition("failedBeforeDrain", Some("UPDATE_PREPARE_FAILED"))
            .unwrap();
        assert_eq!(gate.active_attempt().unwrap(), None);
        let (retry, leader) = gate.accept("2.0.0").unwrap();
        assert!(leader);
        assert_ne!(retry.attempt_id, first.attempt_id);
    }

    #[test]
    fn pre_drain_failure_keeps_runtime_available_but_post_drain_failure_requires_restart() {
        for platform in ["macos", "windows"] {
            let gate = InstallAttemptGate::default();
            gate.accept("2.0.0").unwrap();
            gate.transition("installing", None).unwrap();
            assert!(!gate.has_started_draining(), "{platform}");
            gate.transition("draining", None).unwrap();
            assert!(gate.has_started_draining(), "{platform}");
        }
    }

    #[test]
    fn platform_install_boundaries_preserve_macos_and_windows_ordering() {
        let cases = [
            (
                InstallPlatform::Macos,
                InstallBoundary::InstallReturned,
                Ok(("restartPending", "restart_pending")),
            ),
            (
                InstallPlatform::Windows,
                InstallBoundary::BeforeExit,
                Ok(("installerHandoff", "restart_pending")),
            ),
            (
                InstallPlatform::Windows,
                InstallBoundary::InstallReturned,
                Err("UPDATE_INSTALLER_HANDOFF_RETURNED"),
            ),
            (
                InstallPlatform::Macos,
                InstallBoundary::BeforeExit,
                Err("UPDATE_INSTALL_MACOS_BEFORE_EXIT_UNEXPECTED"),
            ),
        ];
        for (platform, boundary, expected) in cases {
            assert_eq!(install_boundary_contract(platform, boundary), expected);
        }
    }

    #[test]
    fn journal_reconciles_success_version_stall_interrupt_and_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let path = install_journal_path(directory.path());

        write_install_journal(&path, &attempt("2.0.0", "restartPending")).unwrap();
        assert!(matches!(
            reconcile_install_journal(&path, "2.0.0"),
            InstallJournalRecovery::Applied(_)
        ));

        write_install_journal(&path, &attempt("3.0.0", "installerHandoff")).unwrap();
        assert!(matches!(
            reconcile_install_journal(&path, "2.0.0"),
            InstallJournalRecovery::Failed(_, "UPDATE_INSTALL_VERSION_UNCHANGED")
        ));

        write_install_journal(&path, &attempt("3.0.0", "preparing")).unwrap();
        assert!(matches!(
            reconcile_install_journal(&path, "2.0.0"),
            InstallJournalRecovery::Failed(_, "UPDATE_INSTALL_INTERRUPTED")
        ));

        fs::write(&path, b"not-json").unwrap();
        assert_eq!(
            reconcile_install_journal(&path, "2.0.0"),
            InstallJournalRecovery::Corrupt("UPDATE_INSTALL_JOURNAL_CORRUPT")
        );
        assert!(!path.exists());
    }
}
