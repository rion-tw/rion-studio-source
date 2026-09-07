impl AppCore {
    fn session_recovery_lock(
        &self,
    ) -> CoreResult<std::sync::MutexGuard<'_, crate::session_recovery::Runtime>> {
        self.session_recovery
            .lock()
            .map_err(|_| crate::session_recovery::error("RECOVERY_STATE_UNAVAILABLE"))
    }

    fn session_recovery_inspect(&self, role: &str) -> CoreResult<crate::RoleSessionRecoveryRecord> {
        self.ensure_role_exists(role)?;
        if let Some(active) = self.session_recovery_lock()?.active.get(role) {
            return Ok(active.record.clone());
        }
        let journal = self.role_session_migration(role.to_owned())?;
        if let Some(fresh) = self.fresh_session_evidence(role)? {
            return self.fresh_session_record_from_journal(&fresh);
        }
        let candidates = crate::session_recovery::source::inspect(
            &self.user_data_dir,
            self.platform,
            role,
            journal.as_ref(),
        )?;
        let mut blockers = Vec::new();
        if journal.as_ref().is_some_and(|j| {
            j.phase != crate::RoleSessionMigrationPhase::Failed
                || j.first_verified_launch_at.is_some()
        }) {
            blockers.push("RECOVERY_JOURNAL_NOT_ELIGIBLE".to_owned());
        }
        if candidates.is_empty() {
            blockers.push("RECOVERY_SOURCE_MISSING_UNPROVEN".to_owned());
        }
        if candidates.len() > 1 {
            blockers.push("RECOVERY_SOURCE_SELECTION_REQUIRED".to_owned());
        }
        if self
            .browser_statuses()?
            .iter()
            .any(|status| status.role_id == role)
        {
            blockers.push("RECOVERY_ROLE_IN_USE".to_owned());
        }
        if let Err(error) =
            crate::session_recovery::stage::ensure_target_empty(&self.user_data_dir, role)
        {
            blockers.push(error.code().to_owned());
        }
        Ok(crate::RoleSessionRecoveryRecord {
            role_id: role.to_owned(),
            attempt_id: None,
            revision: 0,
            journal_revision: journal.as_ref().map(|j| j.journal_revision),
            phase: "inspected".to_owned(),
            blockers,
            candidates: candidates
                .into_iter()
                .map(|candidate| candidate.view)
                .collect(),
            source_integrity: "unverified".to_owned(),
            target_equality: "notRun".to_owned(),
            persistence: "notRun".to_owned(),
            login: "notTested".to_owned(),
                upgrade_result: None,
        })
    }

    fn session_recovery_read_command(
        &self,
        command: crate::RoleSessionRecoveryCommand,
    ) -> CoreResult<Value> {
        use crate::RoleSessionRecoveryCommand;
        let record = match command {
            RoleSessionRecoveryCommand::Inspect { role_id } => {
                self.session_recovery_inspect(&role_id)?
            }
            RoleSessionRecoveryCommand::Cancel {
                role_id,
                attempt_id,
            } => {
                let mut runtime = self.session_recovery_lock()?;
                let active = runtime
                    .active
                    .get_mut(&role_id)
                    .ok_or_else(|| crate::session_recovery::error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?;
                if active.attempt_id != attempt_id {
                    return Err(crate::session_recovery::error(
                        "RECOVERY_ATTEMPT_IDENTITY_MISMATCH",
                    ));
                }
                // Cancel is a request. Only the owning pipeline terminalizes it;
                // no deletion or success is inferred from actor cancellation.
                active.cancelled.store(true, Ordering::SeqCst);
                if let Some(id) = &active.effect_id {
                    self.operation_actor.cancel(id)?;
                }
                active.record.clone()
            }
            RoleSessionRecoveryCommand::Recover { .. } | RoleSessionRecoveryCommand::Upgrade { .. } => {
                return Err(crate::session_recovery::error("RECOVERY_ASYNC_REQUIRED"));
            }
        };
        serde_json::to_value(record).map_err(|e| CoreError::Internal(e.to_string()))
    }

    async fn session_recovery_command(
        self: &Arc<Self>,
        command: crate::RoleSessionRecoveryCommand,
    ) -> CoreResult<Value> {
        let (role, attempt) = match &command {
            crate::RoleSessionRecoveryCommand::Inspect { role_id } => (role_id.clone(), None),
            crate::RoleSessionRecoveryCommand::Recover {
                role_id,
                attempt_id,
                ..
            }
            | crate::RoleSessionRecoveryCommand::Upgrade { role_id, attempt_id, .. }
            | crate::RoleSessionRecoveryCommand::Cancel {
                role_id,
                attempt_id,
            } => (role_id.clone(), Some(attempt_id.clone())),
        };
        let result = if let crate::RoleSessionRecoveryCommand::Recover {
            role_id,
            attempt_id,
            expected_journal_revision,
            source_token,
        } = command
        {
            self.recover_role_session(role_id, attempt_id, expected_journal_revision, source_token)
                .await
        } else if let crate::RoleSessionRecoveryCommand::Upgrade { role_id, attempt_id, expected_journal_revision } = command {
            self.start_fresh_role_session(role_id, attempt_id, expected_journal_revision).await
        } else {
            let core = Arc::clone(self);
            tokio::task::spawn_blocking(move || core.session_recovery_read_command(command))
                .await
                .map_err(|e| CoreError::Internal(e.to_string()))?
        };
        // Classified rejections are data: Error custom properties are not
        // preserved across Electron's contextBridge boundary.
        match result {
            Ok(value) => Ok(value),
            Err(error) => serde_json::to_value(crate::RoleSessionRecoveryRecord {
                role_id: role,
                attempt_id: attempt,
                revision: 0,
                journal_revision: None,
                phase: "failed".to_owned(),
                blockers: vec![error.code().to_owned()],
                candidates: Vec::new(),
                source_integrity: "unverified".to_owned(),
                target_equality: "notRun".to_owned(),
                persistence: "notRun".to_owned(),
                login: "notTested".to_owned(),
                upgrade_result: None,
            })
            .map_err(|e| CoreError::Internal(e.to_string())),
        }
    }

    fn recovery_progress(
        &self,
        role: &str,
        phase: &str,
        code: Option<&str>,
    ) -> CoreResult<crate::RoleSessionRecoveryRecord> {
        let journal_revision = self
            .role_session_migration(role.to_owned())?
            .map(|j| j.journal_revision);
        let record = {
            let mut runtime = self.session_recovery_lock()?;
            let active = runtime
                .active
                .get_mut(role)
                .ok_or_else(|| crate::session_recovery::error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?;
            active.record.revision += 1;
            active.record.phase = phase.to_owned();
            active.record.journal_revision = journal_revision;
            active.record.blockers = code.into_iter().map(str::to_owned).collect();
            if phase == "isolatedImport" {
                active.record.source_integrity = "verified".to_owned();
            }
            if phase == "formalImport" || phase == "complete" {
                active.record.target_equality = "isolatedVerified".to_owned();
                active.record.persistence = "isolatedVerified".to_owned();
            }
            if phase == "complete" {
                active.record.target_equality = "verified".to_owned();
                active.record.persistence = "verified".to_owned();
            }
            active.record.clone()
        };
        // Durable attempt history contains no source values or paths. Preserve
        // the original journal written at admission throughout later updates.
        self.with_runtime(|runtime| {
            let id = format!(
                "session-recovery-{}",
                record.attempt_id.as_deref().unwrap_or_default()
            );
            let mut journal = runtime
                .state
                .operation_journals()?
                .into_iter()
                .find(|j| j.id == id)
                .ok_or_else(|| {
                    crate::session_recovery::error("RECOVERY_ATTEMPT_HISTORY_MISSING")
                })?;
            journal.phase = phase.to_owned();
            journal.payload["result"] = json!(record);
            runtime.state.put_operation_journal(journal)
        })?;
        self.emit(vec![CoreEvent::RoleSessionRecoveryChanged {
            record: record.clone(),
        }]);
        Ok(record)
    }

    fn recovery_current(&self, role: &str, attempt: &str) -> CoreResult<()> {
        let runtime = self.session_recovery_lock()?;
        let active = runtime
            .active
            .get(role)
            .ok_or_else(|| crate::session_recovery::error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?;
        if active.attempt_id != attempt {
            return Err(crate::session_recovery::error(
                "RECOVERY_ATTEMPT_IDENTITY_MISMATCH",
            ));
        }
        if active.cancelled.load(Ordering::SeqCst) {
            return Err(crate::session_recovery::error("RECOVERY_CANCELLED"));
        }
        Ok(())
    }

    /// Privileged Node-API only. The renderer cannot supply target paths or
    /// source bytes; active Rust attempt identity selects both.
    pub fn read_role_session_recovery_internal(
        &self,
        role: String,
        attempt: String,
        transfer: String,
    ) -> CoreResult<Vec<u8>> {
        self.recovery_current(&role, &attempt)?;
        let stage_attempt = self.session_recovery_lock()?.active.get(&role)
            .and_then(|active|active.stage_attempt_id.clone()).unwrap_or_else(||attempt.clone());
        let stage = crate::session_recovery::stage::load(&self.user_data_dir, &stage_attempt, &role)?;
        if stage.journal.transfer_id != transfer {
            return Err(crate::session_recovery::error(
                "RECOVERY_TRANSFER_IDENTITY_MISMATCH",
            ));
        }
        let formal = self.role_session_migration(role.clone())?;
        let (root, journal, paths) =
            if let Some(journal) = formal.filter(|j| j.transfer_id == transfer) {
                (
                    self.user_data_dir.clone(),
                    journal,
                    crate::role_browser_data::paths(&self.user_data_dir, &role)?,
                )
            } else {
                (stage.root, stage.journal, stage.paths)
            };
        if journal.phase != crate::RoleSessionMigrationPhase::Importing {
            return Err(crate::session_recovery::error(
                "RECOVERY_IMPORT_PHASE_MISMATCH",
            ));
        }
        let envelope =
            crate::session_transfer::read_session_transfer_vault(&root, self.platform, &journal)?;
        serde_json::to_vec(&json!({"journal":journal,"rolePaths":paths,"envelopeJson":String::from_utf8(envelope.canonical_envelope_json()?).map_err(|_|crate::session_recovery::error("RECOVERY_ENVELOPE_ENCODING_FAILED"))?}))
            .map_err(|_|crate::session_recovery::error("RECOVERY_ENVELOPE_ENCODING_FAILED"))
    }
}
