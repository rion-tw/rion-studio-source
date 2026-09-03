use std::sync::MutexGuard;

use super::{
    ChromiumUpdateManager, InstallAcceptance, InstallDrainReceipt, InstallHandoffReceipt,
    InstallPrepareReceipt, ManagerState, UpdateManagerError,
};
use crate::{InstallAttemptRecord, InstallPhase, UpdatePlatform};

impl ChromiumUpdateManager {
    pub fn accept_install(&self) -> Result<InstallAcceptance, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        self.ensure_event_stream_available()?;
        self.ensure_recovery_mutations_allowed(&state)?;
        if let Some(attempt) = state
            .install_attempt
            .as_ref()
            .filter(|attempt| attempt.phase.is_active())
        {
            return Ok(InstallAcceptance {
                attempt: attempt.clone(),
                leader: false,
            });
        }
        let pending = state
            .pending
            .as_ref()
            .ok_or(UpdateManagerError::NoPendingUpdate)?;
        let attempt = InstallAttemptRecord::accepted(&pending.candidate.version);
        crate::persistence::write_install_journal(
            &self.config.user_data_dir.join(crate::INSTALL_JOURNAL_FILE),
            &attempt,
        )
        .map_err(UpdateManagerError::Persistence)?;
        state.install_attempt = Some(attempt.clone());
        state.prepare_evidence = None;
        state.prepare_failure_code = None;
        state.handoff_evidence = None;
        state.handoff_failure_code = None;
        state.status.state = "preparing".to_owned();
        state.status.available_version = Some(attempt.target_version.clone());
        state.status.install_attempt = Some(attempt.clone());
        state.status.error = None;
        state.status.error_code = None;
        state.status.can_retry_install = Some(false);
        self.publish_locked(&mut state)?;
        Ok(InstallAcceptance {
            attempt,
            leader: true,
        })
    }

    pub fn prepare_install(
        &self,
        attempt_id: &str,
    ) -> Result<InstallPrepareReceipt, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let request = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| UpdateManagerError::StateUnavailable)?;
            if state.prepare_in_flight {
                state = wait_for_prepare_completion(self, state)?;
            }
            self.ensure_event_stream_available()?;
            if let Some(evidence) = state
                .prepare_evidence
                .as_ref()
                .filter(|evidence| evidence.attempt_id == attempt_id)
            {
                return Ok(InstallPrepareReceipt {
                    attempt: matching_attempt(&state, attempt_id)?,
                    evidence: evidence.clone(),
                });
            }
            if let Some(code) = state.prepare_failure_code {
                return Err(UpdateManagerError::Stable(code));
            }
            let request = self.install_request_locked(&state, attempt_id)?;
            if !matches!(
                request.attempt.phase,
                InstallPhase::Accepted | InstallPhase::Preparing
            ) {
                return Err(UpdateManagerError::InvalidInstallAttempt);
            }
            state.prepare_in_flight = true;
            state.prepare_failure_code = None;
            if let Err(error) = self.transition_install_locked(
                &mut state,
                InstallPhase::Preparing,
                "preparing",
                None,
                Some(false),
            ) {
                state.prepare_in_flight = false;
                self.completion.notify_all();
                return Err(error);
            }
            request
        };

        let prepared = self.installer.prepare(&request);
        match prepared {
            Ok(evidence) => match self.finish_prepare_success(attempt_id, evidence) {
                Ok(receipt) => Ok(receipt),
                Err(error) => {
                    let code = error.code();
                    let _ = self.installer.rollback(attempt_id);
                    let _ = self.finish_prepare_failure(attempt_id, code);
                    Err(error)
                }
            },
            Err(error) => {
                let code = error.code();
                let _ = self.installer.rollback(attempt_id);
                self.finish_prepare_failure(attempt_id, code)?;
                Err(UpdateManagerError::PlatformInstall(error))
            }
        }
    }

    pub fn begin_install_drain(
        &self,
        attempt_id: &str,
    ) -> Result<InstallDrainReceipt, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        self.ensure_event_stream_available()?;
        let attempt = matching_attempt(&state, attempt_id)?;
        if attempt.phase == InstallPhase::Draining {
            return Ok(InstallDrainReceipt { attempt });
        }
        if attempt.phase != InstallPhase::Installing
            || !state
                .prepare_evidence
                .as_ref()
                .is_some_and(|evidence| evidence.attempt_id == attempt_id)
        {
            return Err(UpdateManagerError::InvalidInstallAttempt);
        }
        let attempt = self.transition_install_locked(
            &mut state,
            InstallPhase::Draining,
            "draining",
            None,
            Some(false),
        )?;
        Ok(InstallDrainReceipt { attempt })
    }

    pub fn fail_install_after_drain(
        &self,
        attempt_id: &str,
        failure_code: &'static str,
    ) -> Result<InstallDrainReceipt, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        {
            let state = self
                .state
                .lock()
                .map_err(|_| UpdateManagerError::StateUnavailable)?;
            self.ensure_event_stream_available()?;
            self.ensure_recovery_mutations_allowed(&state)?;
        }
        let rollback = self.installer.rollback(attempt_id);
        let code = rollback
            .as_ref()
            .err()
            .map_or(failure_code, |_| "UPDATE_INSTALL_ROLLBACK_FAILED");
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        self.ensure_event_stream_available()?;
        let attempt = matching_attempt(&state, attempt_id)?;
        if !attempt.phase.has_started_draining() {
            return Err(UpdateManagerError::InvalidInstallAttempt);
        }
        let attempt = self.transition_install_locked(
            &mut state,
            InstallPhase::FailedAfterDrain,
            "install_failed",
            Some(code),
            Some(false),
        )?;
        Ok(InstallDrainReceipt { attempt })
    }

    pub fn handoff_install_after_drain(
        &self,
        attempt_id: &str,
        parent_process_id: u32,
    ) -> Result<InstallHandoffReceipt, UpdateManagerError> {
        self.ensure_event_stream_available()?;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| UpdateManagerError::StateUnavailable)?;
            if state.handoff_in_flight {
                state = wait_for_handoff_completion(self, state)?;
            }
            self.ensure_event_stream_available()?;
            if let Some(evidence) = state
                .handoff_evidence
                .as_ref()
                .filter(|evidence| evidence.attempt_id == attempt_id)
            {
                return Ok(InstallHandoffReceipt {
                    attempt: matching_attempt(&state, attempt_id)?,
                    evidence: evidence.clone(),
                });
            }
            if let Some(code) = state.handoff_failure_code {
                return Err(UpdateManagerError::Stable(code));
            }
            let attempt = matching_attempt(&state, attempt_id)?;
            if attempt.phase != InstallPhase::Draining {
                return Err(UpdateManagerError::InvalidInstallAttempt);
            }
            state.handoff_in_flight = true;
            let phase = match self.config.platform {
                UpdatePlatform::MacosAarch64 => InstallPhase::RestartPending,
                UpdatePlatform::WindowsX86_64 => InstallPhase::InstallerHandoff,
            };
            if let Err(error) = self.transition_install_locked(
                &mut state,
                phase,
                "restart_pending",
                None,
                Some(false),
            ) {
                state.handoff_in_flight = false;
                self.completion.notify_all();
                return Err(error);
            }
        }

        match self
            .installer
            .handoff_after_drain(attempt_id, parent_process_id)
        {
            Ok(evidence) => self.finish_handoff_success(attempt_id, evidence),
            Err(error) => {
                let mut code = error.code();
                if self.installer.rollback(attempt_id).is_err() {
                    code = "UPDATE_INSTALL_ROLLBACK_FAILED";
                }
                self.finish_handoff_failure(attempt_id, code)?;
                Err(UpdateManagerError::PlatformInstall(error))
            }
        }
    }

    fn finish_prepare_success(
        &self,
        attempt_id: &str,
        evidence: crate::InstallPrepareEvidence,
    ) -> Result<InstallPrepareReceipt, UpdateManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        let outcome: Result<InstallPrepareReceipt, UpdateManagerError> = (|| {
            matching_attempt(&state, attempt_id)?;
            state.prepare_evidence = Some(evidence.clone());
            let attempt = self.transition_install_locked(
                &mut state,
                InstallPhase::Installing,
                "installing",
                None,
                Some(false),
            )?;
            Ok(InstallPrepareReceipt { attempt, evidence })
        })();
        state.prepare_in_flight = false;
        if let Err(error) = &outcome {
            state.prepare_failure_code = Some(error.code());
        }
        self.completion.notify_all();
        outcome
    }

    fn finish_prepare_failure(
        &self,
        attempt_id: &str,
        failure_code: &'static str,
    ) -> Result<(), UpdateManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        matching_attempt(&state, attempt_id)?;
        state.prepare_in_flight = false;
        state.prepare_failure_code = Some(failure_code);
        let result = self.transition_install_locked(
            &mut state,
            InstallPhase::FailedBeforeDrain,
            "install_failed",
            Some(failure_code),
            Some(true),
        );
        self.completion.notify_all();
        result.map(|_| ())
    }

    fn finish_handoff_success(
        &self,
        attempt_id: &str,
        evidence: crate::InstallHandoffEvidence,
    ) -> Result<InstallHandoffReceipt, UpdateManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        let attempt = matching_attempt(&state, attempt_id)?;
        state.handoff_in_flight = false;
        state.handoff_evidence = Some(evidence.clone());
        self.completion.notify_all();
        Ok(InstallHandoffReceipt { attempt, evidence })
    }

    fn finish_handoff_failure(
        &self,
        attempt_id: &str,
        failure_code: &'static str,
    ) -> Result<(), UpdateManagerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
        matching_attempt(&state, attempt_id)?;
        state.handoff_in_flight = false;
        state.handoff_failure_code = Some(failure_code);
        let result = self.transition_install_locked(
            &mut state,
            InstallPhase::FailedAfterDrain,
            "install_failed",
            Some(failure_code),
            Some(false),
        );
        self.completion.notify_all();
        result.map(|_| ())
    }
}

fn matching_attempt(
    state: &ManagerState,
    attempt_id: &str,
) -> Result<InstallAttemptRecord, UpdateManagerError> {
    state
        .install_attempt
        .as_ref()
        .filter(|attempt| attempt.attempt_id == attempt_id)
        .cloned()
        .ok_or(UpdateManagerError::InvalidInstallAttempt)
}

fn wait_for_prepare_completion<'a>(
    manager: &ChromiumUpdateManager,
    mut state: MutexGuard<'a, ManagerState>,
) -> Result<MutexGuard<'a, ManagerState>, UpdateManagerError> {
    while state.prepare_in_flight {
        state = manager
            .completion
            .wait(state)
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
    }
    Ok(state)
}

fn wait_for_handoff_completion<'a>(
    manager: &ChromiumUpdateManager,
    mut state: MutexGuard<'a, ManagerState>,
) -> Result<MutexGuard<'a, ManagerState>, UpdateManagerError> {
    while state.handoff_in_flight {
        state = manager
            .completion
            .wait(state)
            .map_err(|_| UpdateManagerError::StateUnavailable)?;
    }
    Ok(state)
}
