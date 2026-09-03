use std::{fs, sync::MutexGuard};

use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    ChromiumUpdateManager, ManagerState, PendingUpdate, UpdateManagerError, UpdateStatusEnvelope,
    hex_lower,
};
use crate::{
    PENDING_UPDATE_RECEIPT_FILE, UpdateStatusRecord,
    persistence::{
        PENDING_UPDATE_MANIFEST_FILE, PENDING_UPDATE_SCHEMA_VERSION, PendingUpdateReceipt,
        ensure_private_directory, staging_directory, write_pending_receipt,
        write_private_bytes_atomic,
    },
};

impl ChromiumUpdateManager {
    pub fn check_for_updates(&self) -> Result<UpdateStatusEnvelope, UpdateManagerError> {
        self.check_for_updates_with_wait_observer(|| {})
    }

    pub(super) fn check_for_updates_with_wait_observer(
        &self,
        before_duplicate_wait: impl FnOnce(),
    ) -> Result<UpdateStatusEnvelope, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let (operation_id, checked_at) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| UpdateManagerError::StateUnavailable)?;
            self.ensure_event_stream_available()?;
            self.ensure_recovery_mutations_allowed(&state)?;
            if state.pending.is_some() {
                return Ok(super::envelope(&state));
            }
            if !self.config.packaged {
                state.status = UpdateStatusRecord::idle(
                    &self.config.current_version,
                    false,
                    state.preferences.auto_update_enabled,
                );
                return self.publish_locked(&mut state);
            }
            if self.config.public_key_base64.is_empty() {
                state.status.state = "error".to_owned();
                state.status.error = Some("UPDATE_SIGNATURE_KEY_MISSING".to_owned());
                state.status.error_code = Some("UPDATE_SIGNATURE_KEY_MISSING".to_owned());
                return self.publish_locked(&mut state);
            }
            if let Some(active) = state.check_in_flight {
                before_duplicate_wait();
                state = wait_for_check_completion(self, state, active)?;
                self.ensure_event_stream_available()?;
                return Ok(super::envelope(&state));
            }
            let operation_id = state.next_check_identity;
            state.next_check_identity = state.next_check_identity.saturating_add(1);
            state.check_in_flight = Some(operation_id);
            let checked_at = Utc::now().to_rfc3339();
            state.status = UpdateStatusRecord::idle(
                &self.config.current_version,
                true,
                state.preferences.auto_update_enabled,
            );
            state.status.state = "checking".to_owned();
            state.status.checked_at = Some(checked_at.clone());
            if let Err(error) = self.publish_locked(&mut state) {
                state.check_in_flight = None;
                self.completion.notify_all();
                return Err(error);
            }
            (operation_id, checked_at)
        };

        let outcome = self.run_check(operation_id, &checked_at);
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        if state.check_in_flight != Some(operation_id) {
            return Err(UpdateManagerError::Stable("UPDATE_CHECK_IDENTITY_STALE"));
        }
        state.check_in_flight = None;
        let terminal_result: Result<UpdateStatusEnvelope, UpdateManagerError> = (|| match outcome {
            Ok(Some(pending)) => {
                let available_version = pending.candidate.version.to_string();
                state.pending = Some(pending);
                state.preferences.pending_version = Some(available_version.clone());
                state.preferences.last_attempt_at = Some(Utc::now().to_rfc3339());
                state.preferences.consecutive_failures = 0;
                self.persist_preferences_locked(&state)?;
                state.status.state = "downloaded".to_owned();
                state.status.available_version = Some(available_version);
                state.status.download_progress = Some(100);
                state.status.error = None;
                state.status.error_code = None;
                self.publish_locked(&mut state)
            }
            Ok(None) => {
                state.preferences.pending_version = None;
                state.preferences.last_attempt_at = Some(Utc::now().to_rfc3339());
                state.preferences.consecutive_failures = 0;
                self.persist_preferences_locked(&state)?;
                state.status.state = "not_available".to_owned();
                state.status.available_version = None;
                state.status.download_progress = None;
                state.status.error = None;
                state.status.error_code = None;
                self.publish_locked(&mut state)
            }
            Err(error) => {
                state.preferences.last_attempt_at = Some(Utc::now().to_rfc3339());
                state.preferences.consecutive_failures =
                    state.preferences.consecutive_failures.saturating_add(1);
                let _ = self.persist_preferences_locked(&state);
                let code = error.code();
                state.status.state = "error".to_owned();
                state.status.error = Some(code.to_owned());
                state.status.error_code = Some(code.to_owned());
                state.status.download_progress = None;
                self.publish_locked(&mut state)
            }
        })();
        let terminal = match terminal_result {
            Ok(terminal) => Ok(terminal),
            Err(UpdateManagerError::EventStreamUnavailable) => {
                Err(UpdateManagerError::EventStreamUnavailable)
            }
            Err(error) => {
                let code = error.code();
                state.status.state = "error".to_owned();
                state.status.error = Some(code.to_owned());
                state.status.error_code = Some(code.to_owned());
                state.status.download_progress = None;
                self.publish_locked(&mut state)
            }
        };
        self.completion.notify_all();
        terminal
    }

    fn run_check(
        &self,
        operation_id: u64,
        checked_at: &str,
    ) -> Result<Option<PendingUpdate>, UpdateManagerError> {
        let manifest = self
            .transport
            .fetch_manifest(&self.config.endpoint)
            .map_err(UpdateManagerError::Transport)?;
        let Some(candidate) = crate::select_update_candidate(
            &manifest,
            &self.config.current_version.to_string(),
            self.config.platform,
        )
        .map_err(UpdateManagerError::Manifest)?
        else {
            return Ok(None);
        };
        self.publish_check_progress(
            operation_id,
            "available",
            &candidate.version.to_string(),
            None,
            checked_at,
        )?;
        self.publish_check_progress(
            operation_id,
            "downloading",
            &candidate.version.to_string(),
            Some(0),
            checked_at,
        )?;

        let staging = staging_directory(&self.config.user_data_dir);
        ensure_private_directory(&staging).map_err(UpdateManagerError::Persistence)?;
        let temporary = staging.join(format!(
            ".{}.{}.download",
            self.config.platform.staged_file_name(),
            Uuid::new_v4()
        ));
        let final_artifact = staging.join(self.config.platform.staged_file_name());
        let mut progress_failure = None;
        let download_result = self.transport.download_artifact(
            &candidate.url,
            &temporary,
            &mut |downloaded, expected| {
                if progress_failure.is_some() {
                    return;
                }
                let progress = expected
                    .filter(|expected| *expected > 0)
                    .map(|expected| ((downloaded.saturating_mul(100) / expected).min(99)) as u8)
                    .unwrap_or(0);
                if let Err(error) = self.publish_check_progress(
                    operation_id,
                    "downloading",
                    &candidate.version.to_string(),
                    Some(progress),
                    checked_at,
                ) {
                    progress_failure = Some(error);
                }
            },
        );
        if let Some(error) = progress_failure {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let downloaded = match download_result {
            Ok(downloaded) => downloaded,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(UpdateManagerError::Transport(error));
            }
        };
        let verification = match crate::verify_update_artifact(
            &temporary,
            &candidate,
            Some(downloaded),
            &self.config.public_key_base64,
        ) {
            Ok(verification) => verification,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(UpdateManagerError::Verification(error));
            }
        };
        if let Err(error) = rion_platform::atomic_replace_file(&temporary, &final_artifact) {
            let _ = fs::remove_file(&temporary);
            return Err(UpdateManagerError::Persistence(
                crate::persistence::PersistenceError::Io(std::io::Error::other(error.to_string())),
            ));
        }
        let manifest_sha256 = hex_lower(&Sha256::digest(&manifest));
        write_private_bytes_atomic(&staging.join(PENDING_UPDATE_MANIFEST_FILE), &manifest)
            .map_err(UpdateManagerError::Persistence)?;
        write_pending_receipt(
            &staging.join(PENDING_UPDATE_RECEIPT_FILE),
            &PendingUpdateReceipt {
                schema_version: PENDING_UPDATE_SCHEMA_VERSION,
                target_version: candidate.version.to_string(),
                platform: self.config.platform.to_string(),
                artifact_file_name: self.config.platform.staged_file_name().to_owned(),
                artifact_bytes: verification.bytes,
                artifact_sha256: verification.artifact_sha256,
                signature_sha256: verification.signature_sha256,
                manifest_sha256,
                staged_at: Utc::now().to_rfc3339(),
            },
        )
        .map_err(UpdateManagerError::Persistence)?;
        Ok(Some(PendingUpdate {
            candidate,
            artifact_path: final_artifact,
        }))
    }

    fn publish_check_progress(
        &self,
        operation_id: u64,
        status_name: &str,
        version: &str,
        progress: Option<u8>,
        checked_at: &str,
    ) -> Result<(), UpdateManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        if state.check_in_flight != Some(operation_id) {
            return Err(UpdateManagerError::Stable("UPDATE_CHECK_IDENTITY_STALE"));
        }
        state.status.state = status_name.to_owned();
        state.status.available_version = Some(version.to_owned());
        state.status.download_progress = progress;
        state.status.checked_at = Some(checked_at.to_owned());
        self.publish_locked(&mut state).map(|_| ())
    }
}

fn wait_for_check_completion<'a>(
    manager: &ChromiumUpdateManager,
    mut state: MutexGuard<'a, ManagerState>,
    operation_id: u64,
) -> Result<MutexGuard<'a, ManagerState>, UpdateManagerError> {
    while state.check_in_flight == Some(operation_id) {
        state = manager
            .completion
            .wait(state)
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
    }
    Ok(state)
}
