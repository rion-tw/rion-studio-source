use std::{
    fs,
    path::Path,
    sync::{
        Arc, Barrier, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use sha2::{Digest, Sha256};
use tempfile::TempDir;
use url::Url;

use super::*;
use crate::{
    InstallHandoffEvidence, InstallPrepareEvidence, PlatformInstallRequest,
    UpdatePlatformInstallError,
};

const PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

struct FakeTransport {
    manifest: Vec<u8>,
    artifact: Vec<u8>,
    fetches: AtomicUsize,
    downloads: AtomicUsize,
    entered: Option<Arc<Barrier>>,
    release: Option<Arc<Barrier>>,
}

impl UpdateTransport for FakeTransport {
    fn fetch_manifest(&self, _endpoint: &Url) -> Result<Vec<u8>, UpdateTransportError> {
        self.fetches.fetch_add(1, Ordering::AcqRel);
        if let Some(entered) = &self.entered {
            entered.wait();
        }
        if let Some(release) = &self.release {
            release.wait();
        }
        Ok(self.manifest.clone())
    }

    fn download_artifact(
        &self,
        _url: &Url,
        destination: &Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<u64, UpdateTransportError> {
        self.downloads.fetch_add(1, Ordering::AcqRel);
        fs::write(destination, &self.artifact).map_err(UpdateTransportError::Io)?;
        progress(self.artifact.len() as u64, Some(self.artifact.len() as u64));
        Ok(self.artifact.len() as u64)
    }
}

#[derive(Default)]
struct FakeInstaller {
    prepare_calls: AtomicUsize,
    rollback_calls: AtomicUsize,
    handoff_calls: AtomicUsize,
    finalize_calls: AtomicUsize,
    fail_prepare: AtomicBool,
    fail_handoff: AtomicBool,
    fail_finalize: AtomicBool,
    prepared: Mutex<Option<PlatformInstallRequest>>,
}

impl UpdatePlatformInstaller for FakeInstaller {
    fn prepare(
        &self,
        request: &PlatformInstallRequest,
    ) -> Result<InstallPrepareEvidence, UpdatePlatformInstallError> {
        self.prepare_calls.fetch_add(1, Ordering::AcqRel);
        if self.fail_prepare.load(Ordering::Acquire) {
            return Err(UpdatePlatformInstallError::ReplacementFailed);
        }
        *self.prepared.lock().unwrap() = Some(request.clone());
        Ok(InstallPrepareEvidence {
            attempt_id: request.attempt.attempt_id.clone(),
            target_version: request.attempt.target_version.clone(),
            platform: request.platform.to_string(),
            replacement_applied: request.platform == UpdatePlatform::MacosAarch64,
        })
    }

    fn rollback(&self, _attempt_id: &str) -> Result<(), UpdatePlatformInstallError> {
        self.rollback_calls.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    fn handoff_after_drain(
        &self,
        attempt_id: &str,
        _parent_process_id: u32,
    ) -> Result<InstallHandoffEvidence, UpdatePlatformInstallError> {
        self.handoff_calls.fetch_add(1, Ordering::AcqRel);
        if self.fail_handoff.load(Ordering::Acquire) {
            return Err(UpdatePlatformInstallError::HelperSpawnFailed);
        }
        let request = self.prepared.lock().unwrap().clone().unwrap();
        Ok(InstallHandoffEvidence {
            attempt_id: attempt_id.to_owned(),
            target_version: request.attempt.target_version,
            platform: request.platform.to_string(),
            child_process_id: 42,
        })
    }

    fn finalize_applied(
        &self,
        _attempt: &InstallAttemptRecord,
        _user_data_dir: &Path,
    ) -> Result<(), UpdatePlatformInstallError> {
        self.finalize_calls.fetch_add(1, Ordering::AcqRel);
        if self.fail_finalize.load(Ordering::Acquire) {
            return Err(UpdatePlatformInstallError::StateUnavailable);
        }
        Ok(())
    }
}

#[test]
fn check_streams_verifies_persists_and_orders_revision_fenced_statuses() {
    let fixture = manager_fixture(b"test", b"test", None);
    let events = fixture.manager.subscribe().unwrap();
    let terminal = fixture.manager.check_for_updates().unwrap();
    assert_eq!(terminal.status.state, "downloaded");
    assert_eq!(fixture.transport.fetches.load(Ordering::Acquire), 1);
    assert_eq!(fixture.transport.downloads.load(Ordering::Acquire), 1);
    assert!(
        fixture
            .directory
            .path()
            .join("app-updates/pending/pending-update-receipt.json")
            .is_file()
    );

    let captured = events.try_iter().collect::<Vec<_>>();
    assert!(
        captured
            .windows(2)
            .all(|events| events[0].revision < events[1].revision)
    );
    let states = captured
        .iter()
        .map(|event| event.status.state.as_str())
        .collect::<Vec<_>>();
    assert!(is_ordered_subsequence(
        &states,
        &["idle", "checking", "available", "downloading", "downloaded"]
    ));
}

#[test]
fn subscribe_registers_the_initial_snapshot_before_a_new_status_can_publish() {
    let fixture = manager_fixture(b"test", b"test", None);
    let subscribers = fixture.manager.subscribers.lock().unwrap();
    let snapshot_captured = Arc::new(Barrier::new(2));
    let manager = Arc::clone(&fixture.manager);
    let snapshot_captured_by_subscriber = Arc::clone(&snapshot_captured);
    let subscription = std::thread::spawn(move || {
        manager
            .subscribe_with_snapshot_observer(|| {
                snapshot_captured_by_subscriber.wait();
            })
            .unwrap()
    });

    snapshot_captured.wait();
    assert!(matches!(
        fixture.manager.state.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    let manager = Arc::clone(&fixture.manager);
    let publication = std::thread::spawn(move || manager.set_auto_update_enabled(false).unwrap());

    drop(subscribers);
    let events = subscription.join().unwrap();
    let published = publication.join().unwrap();
    let captured = events.try_iter().collect::<Vec<_>>();

    assert_eq!(published.revision, 2);
    assert_eq!(
        captured
            .iter()
            .map(|event| event.revision)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(captured[0].status.auto_update_enabled);
    assert!(!captured[1].status.auto_update_enabled);
}

#[test]
fn poisoned_subscriber_registry_fails_closed_without_minting_a_revision() {
    let fixture = manager_fixture(b"test", b"test", None);
    let events = fixture.manager.subscribe().unwrap();
    let initial = events.recv().unwrap();
    assert_eq!(initial.revision, 1);

    poison_subscriber_registry(&fixture.manager);
    let mut state = fixture.manager.state.lock().unwrap();
    state.status.auto_update_enabled = false;
    let error = fixture.manager.publish_locked(&mut state).unwrap_err();
    assert_eq!(error.code(), "UPDATE_EVENT_STREAM_UNAVAILABLE");
    assert_eq!(state.revision, 1);
    assert!(!state.status.auto_update_enabled);
    drop(state);
    assert!(events.recv().is_err());

    assert!(matches!(
        fixture.manager.status(),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
    assert!(matches!(
        fixture.manager.subscribe(),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
    assert!(matches!(
        fixture.manager.set_auto_update_enabled(true),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
}

#[test]
fn poisoned_subscriber_registry_is_detected_before_public_mutation() {
    let fixture = manager_fixture(b"test", b"test", None);
    let events = fixture.manager.subscribe().unwrap();
    assert_eq!(events.recv().unwrap().revision, 1);
    poison_subscriber_registry(&fixture.manager);

    assert!(matches!(
        fixture.manager.set_auto_update_enabled(false),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
    assert!(events.recv().is_err());
    let state = fixture.manager.state.lock().unwrap();
    assert_eq!(state.revision, 1);
    assert!(state.status.auto_update_enabled);
    assert!(state.preferences.auto_update_enabled);
}

fn poison_subscriber_registry(manager: &Arc<ChromiumUpdateManager>) {
    let manager = Arc::clone(manager);
    let poison = std::thread::spawn(move || {
        let _subscribers = manager.subscribers.lock().unwrap();
        panic!("deterministically poison the updater subscriber registry");
    });
    assert!(poison.join().is_err());
}

#[test]
fn tampered_artifact_never_publishes_a_pending_receipt() {
    let fixture = manager_fixture(b"test", b"tampered", None);
    let terminal = fixture.manager.check_for_updates().unwrap();
    assert_eq!(terminal.status.state, "error");
    assert_eq!(
        terminal.status.error_code.as_deref(),
        Some("UPDATE_ARTIFACT_SHA256_MISMATCH")
    );
    assert!(
        !fixture
            .directory
            .path()
            .join("app-updates/pending/pending-update-receipt.json")
            .exists()
    );
    assert!(matches!(
        fixture.manager.accept_install(),
        Err(UpdateManagerError::NoPendingUpdate)
    ));
}

#[test]
fn duplicate_checks_wait_for_and_replay_one_authoritative_terminal_result() {
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let fixture = manager_fixture(
        b"test",
        b"test",
        Some((Arc::clone(&entered), Arc::clone(&release))),
    );
    let manager = Arc::clone(&fixture.manager);
    let first = std::thread::spawn(move || manager.check_for_updates().unwrap());
    entered.wait();
    let manager = Arc::clone(&fixture.manager);
    let duplicate = std::thread::spawn(move || manager.check_for_updates().unwrap());
    release.wait();
    let first = first.join().unwrap();
    let duplicate = duplicate.join().unwrap();
    assert_eq!(first, duplicate);
    assert_eq!(fixture.transport.fetches.load(Ordering::Acquire), 1);
    assert_eq!(fixture.transport.downloads.load(Ordering::Acquire), 1);
}

#[test]
fn duplicate_check_waiter_fails_when_the_authoritative_event_stream_terminalizes() {
    let transport_entered = Arc::new(Barrier::new(2));
    let transport_release = Arc::new(Barrier::new(2));
    let fixture = manager_fixture(
        b"test",
        b"test",
        Some((
            Arc::clone(&transport_entered),
            Arc::clone(&transport_release),
        )),
    );
    let events = fixture.manager.subscribe().unwrap();
    assert_eq!(events.recv().unwrap().revision, 1);

    let manager = Arc::clone(&fixture.manager);
    let first = std::thread::spawn(move || manager.check_for_updates());
    transport_entered.wait();

    let duplicate_waiting = Arc::new(Barrier::new(2));
    let manager = Arc::clone(&fixture.manager);
    let duplicate_waiting_in_thread = Arc::clone(&duplicate_waiting);
    let duplicate = std::thread::spawn(move || {
        manager.check_for_updates_with_wait_observer(|| {
            duplicate_waiting_in_thread.wait();
        })
    });
    duplicate_waiting.wait();

    poison_subscriber_registry(&fixture.manager);
    transport_release.wait();

    assert!(matches!(
        first.join().unwrap(),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
    assert!(matches!(
        duplicate.join().unwrap(),
        Err(UpdateManagerError::EventStreamUnavailable)
    ));
    assert_eq!(events.recv().unwrap().revision, 2);
    assert!(events.recv().is_err());
    let state = fixture.manager.state.lock().unwrap();
    assert_eq!(state.revision, 2);
}

#[test]
fn install_gate_deduplicates_and_preserves_prepare_drain_handoff_order() {
    let fixture = manager_fixture(b"test", b"test", None);
    fixture.manager.check_for_updates().unwrap();
    let accepted = fixture.manager.accept_install().unwrap();
    assert!(accepted.leader);
    let duplicate = fixture.manager.accept_install().unwrap();
    assert!(!duplicate.leader);
    assert_eq!(duplicate.attempt.attempt_id, accepted.attempt.attempt_id);

    let prepared = fixture
        .manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    let replay = fixture
        .manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    assert_eq!(prepared, replay);
    assert_eq!(fixture.installer.prepare_calls.load(Ordering::Acquire), 1);
    let drain = fixture
        .manager
        .begin_install_drain(&accepted.attempt.attempt_id)
        .unwrap();
    assert_eq!(drain.attempt.phase, InstallPhase::Draining);
    let handoff = fixture
        .manager
        .handoff_install_after_drain(&accepted.attempt.attempt_id, 100)
        .unwrap();
    assert_eq!(handoff.attempt.phase, InstallPhase::RestartPending);
    assert_eq!(handoff.evidence.child_process_id, 42);
    assert_eq!(fixture.installer.handoff_calls.load(Ordering::Acquire), 1);
}

#[test]
fn failures_before_and_after_drain_are_distinct_and_rollback_exactly_once() {
    let before = manager_fixture(b"test", b"test", None);
    before.manager.check_for_updates().unwrap();
    let accepted = before.manager.accept_install().unwrap();
    before.installer.fail_prepare.store(true, Ordering::Release);
    assert!(
        before
            .manager
            .prepare_install(&accepted.attempt.attempt_id)
            .is_err()
    );
    let status = before.manager.status().unwrap();
    assert_eq!(
        status.status.install_attempt.unwrap().phase,
        InstallPhase::FailedBeforeDrain
    );

    let after = manager_fixture(b"test", b"test", None);
    after.manager.check_for_updates().unwrap();
    let accepted = after.manager.accept_install().unwrap();
    after
        .manager
        .prepare_install(&accepted.attempt.attempt_id)
        .unwrap();
    after
        .manager
        .begin_install_drain(&accepted.attempt.attempt_id)
        .unwrap();
    let failure = after
        .manager
        .fail_install_after_drain(&accepted.attempt.attempt_id, "UPDATE_INSTALL_DRAIN_FAILED")
        .unwrap();
    assert_eq!(failure.attempt.phase, InstallPhase::FailedAfterDrain);
    assert_eq!(after.installer.rollback_calls.load(Ordering::Acquire), 1);
    assert_eq!(
        after.manager.status().unwrap().status.can_retry_install,
        Some(false)
    );
}

#[test]
fn first_boot_commits_terminal_evidence_only_after_platform_finalization() {
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join(INSTALL_JOURNAL_FILE);
    let source_attempt = InstallAttemptRecord {
        attempt_id: "update-install-1".to_owned(),
        target_version: "2.0.0".to_owned(),
        phase: InstallPhase::RestartPending,
        started_at: "2026-08-03T00:00:00Z".to_owned(),
        updated_at: "2026-08-03T00:01:00Z".to_owned(),
        failure_code: None,
    };
    crate::persistence::write_install_journal(&journal_path, &source_attempt).unwrap();
    let transport = Arc::new(FakeTransport {
        manifest: manifest(b"test"),
        artifact: b"test".to_vec(),
        fetches: AtomicUsize::new(0),
        downloads: AtomicUsize::new(0),
        entered: None,
        release: None,
    });
    let installer = Arc::new(FakeInstaller::default());
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().to_path_buf(),
            current_version: semver::Version::new(2, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: PUBLIC_KEY.to_owned(),
        },
        transport,
        installer.clone(),
    )
    .unwrap();

    assert_eq!(installer.finalize_calls.load(Ordering::Acquire), 1);
    assert!(!journal_path.exists());
    let status = manager.status().unwrap().status;
    assert_eq!(
        status.install_attempt.as_ref().unwrap().phase,
        InstallPhase::Applied
    );
    #[cfg(windows)]
    {
        assert_eq!(status.state, "idle");
        assert!(status.error_code.is_none());
    }
    #[cfg(not(windows))]
    {
        assert_eq!(status.state, "idle");
        assert!(status.error_code.is_none());
    }
    assert_eq!(
        fs::read_dir(
            directory
                .path()
                .join(crate::INSTALL_TERMINAL_RECEIPT_DIRECTORY)
        )
        .unwrap()
        .count(),
        1
    );
}

#[test]
fn failed_platform_finalization_retains_the_source_journal_and_writes_no_terminal_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join(INSTALL_JOURNAL_FILE);
    crate::persistence::write_install_journal(
        &journal_path,
        &InstallAttemptRecord {
            attempt_id: "update-install-1".to_owned(),
            target_version: "2.0.0".to_owned(),
            phase: InstallPhase::RestartPending,
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:01:00Z".to_owned(),
            failure_code: None,
        },
    )
    .unwrap();
    let installer = Arc::new(FakeInstaller::default());
    installer.fail_finalize.store(true, Ordering::Release);
    let result = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().to_path_buf(),
            current_version: semver::Version::new(2, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: PUBLIC_KEY.to_owned(),
        },
        Arc::new(FakeTransport {
            manifest: manifest(b"test"),
            artifact: b"test".to_vec(),
            fetches: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            entered: None,
            release: None,
        }),
        installer.clone(),
    );

    assert!(matches!(
        result,
        Err(UpdateManagerError::PlatformInstall(_))
    ));
    assert_eq!(installer.finalize_calls.load(Ordering::Acquire), 1);
    assert!(journal_path.exists());
    assert!(
        !directory
            .path()
            .join(crate::INSTALL_TERMINAL_RECEIPT_DIRECTORY)
            .exists()
    );
}

#[test]
fn first_boot_replay_uses_the_immutable_terminal_receipt_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join(INSTALL_JOURNAL_FILE);
    let source_attempt = InstallAttemptRecord {
        attempt_id: "update-install-1".to_owned(),
        target_version: "2.0.0".to_owned(),
        phase: InstallPhase::RestartPending,
        started_at: "2026-08-03T00:00:00Z".to_owned(),
        updated_at: "2026-08-03T00:01:00Z".to_owned(),
        failure_code: None,
    };
    crate::persistence::write_install_journal(&journal_path, &source_attempt).unwrap();
    let InstallJournalRecovery::Applied(first_applied) =
        reconcile_install_journal(&journal_path, "2.0.0")
    else {
        panic!("the matching journal must reconcile as applied");
    };
    let first_commit =
        crate::persistence::commit_applied_install_journal(&journal_path, &first_applied, "2.0.0")
            .unwrap();
    let expected_attempt = first_commit.receipt.attempt;

    crate::persistence::write_install_journal(&journal_path, &source_attempt).unwrap();
    let installer = Arc::new(FakeInstaller::default());
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().to_path_buf(),
            current_version: semver::Version::new(2, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: PUBLIC_KEY.to_owned(),
        },
        Arc::new(FakeTransport {
            manifest: manifest(b"test"),
            artifact: b"test".to_vec(),
            fetches: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            entered: None,
            release: None,
        }),
        installer,
    )
    .unwrap();

    assert_eq!(
        manager.status().unwrap().status.install_attempt,
        Some(expected_attempt)
    );
    assert!(!journal_path.exists());
    assert_eq!(
        fs::read_dir(
            directory
                .path()
                .join(crate::INSTALL_TERMINAL_RECEIPT_DIRECTORY)
        )
        .unwrap()
        .count(),
        1
    );
}

#[test]
fn applied_recovery_quarantines_only_source_changed_cleanup() {
    let applied = InstallAttemptRecord {
        attempt_id: "update-install-cleanup".to_owned(),
        target_version: "2.0.0".to_owned(),
        phase: InstallPhase::Applied,
        started_at: "2026-08-03T00:00:00Z".to_owned(),
        updated_at: "2026-08-03T00:02:00Z".to_owned(),
        failure_code: None,
    };
    let diagnostics = [
        InstallJournalCleanup::Retained,
        InstallJournalCleanup::DurabilityUncertain,
    ];

    for cleanup in diagnostics {
        let mut status = UpdateStatusRecord::idle(&semver::Version::new(2, 0, 0), true, true);
        apply_applied_recovery_status(&mut status, &applied, cleanup, false);

        assert_eq!(status.state, "idle");
        assert!(status.error_code.is_none());
        assert_eq!(status.install_attempt.as_ref(), Some(&applied));
    }

    let mut changed = UpdateStatusRecord::idle(&semver::Version::new(2, 0, 0), true, true);
    apply_applied_recovery_status(
        &mut changed,
        &applied,
        InstallJournalCleanup::SourceChanged,
        false,
    );
    assert_eq!(changed.state, "error");
    assert_eq!(
        changed.error_code.as_deref(),
        Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED")
    );
    assert_eq!(changed.can_retry_install, Some(false));

    let successful_cleanups = vec![
        InstallJournalCleanup::AlreadyAbsent,
        #[cfg(unix)]
        InstallJournalCleanup::Removed,
    ];
    for cleanup in successful_cleanups {
        let mut status = UpdateStatusRecord::idle(&semver::Version::new(2, 0, 0), true, true);
        apply_applied_recovery_status(&mut status, &applied, cleanup, false);
        assert_eq!(status.state, "idle");
        assert!(status.error_code.is_none());
        assert_eq!(status.install_attempt.as_ref(), Some(&applied));
    }
}

#[cfg(unix)]
#[test]
fn absent_journal_replay_rejects_a_symlinked_terminal_receipt_directory() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let external = directory.path().join("external-receipts");
    fs::create_dir(&external).unwrap();
    fs::set_permissions(&external, fs::Permissions::from_mode(0o700)).unwrap();
    let source_sha256 = hex_lower(&Sha256::digest(b"source-journal"));
    let applied = InstallAttemptRecord {
        attempt_id: "update-install-symlink-replay".to_owned(),
        target_version: "2.0.0".to_owned(),
        phase: InstallPhase::Applied,
        started_at: "2026-08-03T00:00:00Z".to_owned(),
        updated_at: "2026-08-03T00:02:00Z".to_owned(),
        failure_code: None,
    };
    let fabricated = crate::InstallTerminalReceiptRecord {
        schema_version: 1,
        kind: "rion-updater-install-terminal".to_owned(),
        authority: "target-first-boot-journal-reconciliation".to_owned(),
        source_journal_bytes: 14,
        source_journal_sha256: source_sha256.clone(),
        source_phase: InstallPhase::RestartPending,
        running_version: "2.0.0".to_owned(),
        terminal_outcome: InstallPhase::Applied,
        reconciled_at: applied.updated_at.clone(),
        attempt: applied.clone(),
    };
    fs::write(
        external.join(format!("{source_sha256}.json")),
        serde_json::to_vec(&fabricated).unwrap(),
    )
    .unwrap();
    symlink(
        &external,
        directory
            .path()
            .join(crate::INSTALL_TERMINAL_RECEIPT_DIRECTORY),
    )
    .unwrap();

    assert!(matches!(
        crate::persistence::commit_applied_install_journal(
            &directory.path().join(INSTALL_JOURNAL_FILE),
            &applied,
            "2.0.0"
        ),
        Err(crate::persistence::PersistenceError::UnsafePath)
    ));
}

#[test]
fn applied_recovery_never_masks_a_missing_packaged_signature_key() {
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join(INSTALL_JOURNAL_FILE);
    crate::persistence::write_install_journal(
        &journal_path,
        &InstallAttemptRecord {
            attempt_id: "update-install-missing-key".to_owned(),
            target_version: "2.0.0".to_owned(),
            phase: InstallPhase::RestartPending,
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:01:00Z".to_owned(),
            failure_code: None,
        },
    )
    .unwrap();
    let installer = Arc::new(FakeInstaller::default());
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().to_path_buf(),
            current_version: semver::Version::new(2, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: String::new(),
        },
        Arc::new(FakeTransport {
            manifest: manifest(b"test"),
            artifact: b"test".to_vec(),
            fetches: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            entered: None,
            release: None,
        }),
        installer,
    )
    .unwrap();

    let status = manager.status().unwrap().status;
    assert_eq!(status.state, "error");
    assert_eq!(
        status.error_code.as_deref(),
        Some("UPDATE_SIGNATURE_KEY_MISSING")
    );
    assert_eq!(
        status.install_attempt.as_ref().map(|attempt| attempt.phase),
        Some(InstallPhase::Applied)
    );
    assert!(!journal_path.exists());
}

#[test]
fn source_changed_recovery_gate_blocks_checks_and_install_journal_overwrite() {
    let fixture = manager_fixture(b"test", b"test", None);
    fixture.manager.check_for_updates().unwrap();
    let journal_path = fixture.directory.path().join(INSTALL_JOURNAL_FILE);
    let conflicting_journal = br#"{"schemaVersion":1,"attempt":{"attemptId":"other-install","targetVersion":"3.0.0","phase":"restartPending","startedAt":"2026-08-03T00:00:00Z","updatedAt":"2026-08-03T00:01:00Z"}}"#;
    fs::write(&journal_path, conflicting_journal).unwrap();
    {
        let mut state = fixture.manager.state.lock().unwrap();
        state.recovery_blocked = Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED");
        let applied = InstallAttemptRecord {
            attempt_id: "update-install-applied".to_owned(),
            target_version: "1.0.0".to_owned(),
            phase: InstallPhase::Applied,
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:02:00Z".to_owned(),
            failure_code: None,
        };
        apply_applied_recovery_status(
            &mut state.status,
            &applied,
            InstallJournalCleanup::SourceChanged,
            false,
        );
    }

    assert!(matches!(
        fixture.manager.check_for_updates(),
        Err(UpdateManagerError::Stable(
            "UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED"
        ))
    ));
    assert!(matches!(
        fixture.manager.accept_install(),
        Err(UpdateManagerError::Stable(
            "UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED"
        ))
    ));
    assert!(matches!(
        fixture
            .manager
            .fail_install_after_drain("update-install-applied", "UPDATE_INSTALL_DRAIN_FAILED"),
        Err(UpdateManagerError::Stable(
            "UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED"
        ))
    ));
    assert_eq!(fixture.installer.rollback_calls.load(Ordering::Acquire), 0);
    assert_eq!(fs::read(&journal_path).unwrap(), conflicting_journal);
    let status = fixture.manager.status().unwrap().status;
    assert_eq!(status.state, "error");
    assert_eq!(
        status.error_code.as_deref(),
        Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED")
    );
}

#[test]
fn source_changed_constructor_gate_takes_precedence_over_restored_pending_update() {
    let fixture = manager_fixture(b"test", b"test", None);
    fixture.manager.check_for_updates().unwrap();
    let staging = crate::persistence::staging_directory(fixture.directory.path());
    let backup = fixture.directory.path().join("pending-backup");
    fs::create_dir(&backup).unwrap();
    for entry in fs::read_dir(&staging).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), backup.join(entry.file_name())).unwrap();
    }

    let journal_path = fixture.directory.path().join(INSTALL_JOURNAL_FILE);
    crate::persistence::write_install_journal(
        &journal_path,
        &InstallAttemptRecord {
            attempt_id: "update-install-source-changed".to_owned(),
            target_version: "1.0.0".to_owned(),
            phase: InstallPhase::RestartPending,
            started_at: "2026-08-03T00:00:00Z".to_owned(),
            updated_at: "2026-08-03T00:01:00Z".to_owned(),
            failure_code: None,
        },
    )
    .unwrap();
    let hook_staging = staging.clone();
    crate::persistence::register_terminal_cleanup_test_hook(journal_path.clone(), move |path| {
        crate::persistence::write_private_bytes_atomic(path, b"replacement").unwrap();
        fs::create_dir_all(&hook_staging).unwrap();
        for entry in fs::read_dir(&backup).unwrap() {
            let entry = entry.unwrap();
            fs::copy(entry.path(), hook_staging.join(entry.file_name())).unwrap();
        }
    });

    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: fixture.directory.path().to_path_buf(),
            current_version: semver::Version::new(1, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: PUBLIC_KEY.to_owned(),
        },
        fixture.transport.clone(),
        Arc::new(FakeInstaller::default()),
    )
    .unwrap();

    let state = manager.state.lock().unwrap();
    assert_eq!(
        state.recovery_blocked,
        Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED")
    );
    assert!(state.pending.is_none());
    assert_eq!(state.status.state, "error");
    assert_eq!(
        state.status.error_code.as_deref(),
        Some("UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED")
    );
    assert!(staging.join(PENDING_UPDATE_RECEIPT_FILE).is_file());
    assert_eq!(fs::read(&journal_path).unwrap(), b"replacement");
}

struct ManagerFixture {
    directory: TempDir,
    manager: Arc<ChromiumUpdateManager>,
    transport: Arc<FakeTransport>,
    installer: Arc<FakeInstaller>,
}

fn manager_fixture(
    signed_content: &[u8],
    downloaded_content: &[u8],
    barriers: Option<(Arc<Barrier>, Arc<Barrier>)>,
) -> ManagerFixture {
    let directory = tempfile::tempdir().unwrap();
    let manifest = manifest(signed_content);
    let transport = Arc::new(FakeTransport {
        manifest,
        artifact: downloaded_content.to_vec(),
        fetches: AtomicUsize::new(0),
        downloads: AtomicUsize::new(0),
        entered: barriers.as_ref().map(|barriers| Arc::clone(&barriers.0)),
        release: barriers.map(|barriers| barriers.1),
    });
    let installer = Arc::new(FakeInstaller::default());
    let manager = ChromiumUpdateManager::new(
        ChromiumUpdateManagerConfig {
            user_data_dir: directory.path().to_path_buf(),
            current_version: semver::Version::new(1, 0, 0),
            platform: UpdatePlatform::MacosAarch64,
            packaged: true,
            endpoint: Url::parse("https://updates.example.test/latest.json").unwrap(),
            public_key_base64: PUBLIC_KEY.to_owned(),
        },
        transport.clone(),
        installer.clone(),
    )
    .unwrap();
    ManagerFixture {
        directory,
        manager: Arc::new(manager),
        transport,
        installer,
    }
}

fn manifest(content: &[u8]) -> Vec<u8> {
    let sha256 = hex_lower(&Sha256::digest(content));
    serde_json::to_vec(&serde_json::json!({
        "version": "2.0.0",
        "notes": "Verified",
        "pub_date": "2026-08-03T00:00:00Z",
        "platforms": {
            "darwin-aarch64": {
                "url": "https://updates.example.test/Rion-Studio-macos-aarch64.app.tar.gz",
                "signature": SIGNATURE,
                "sha256": sha256
            },
            "windows-x86_64": {
                "url": "https://updates.example.test/Rion-Studio-windows-x86_64-setup.exe",
                "signature": SIGNATURE,
                "sha256": sha256
            }
        }
    }))
    .unwrap()
}

fn is_ordered_subsequence(values: &[&str], expected: &[&str]) -> bool {
    let mut offset = 0_usize;
    for value in values {
        if expected.get(offset) == Some(value) {
            offset += 1;
        }
    }
    offset == expected.len()
}
