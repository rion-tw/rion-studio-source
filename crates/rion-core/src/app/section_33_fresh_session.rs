impl AppCore {
    fn fresh_session_evidence(&self, role: &str) -> CoreResult<Option<OperationJournalRecord>> {
        let current = self.role_session_migration(role.to_owned())?;
        let platform = match self.platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        };
        let journals = self.with_runtime(|runtime| runtime.state.operation_journals())?;
        for journal in journals {
            if journal.kind != crate::session_recovery::fresh::KIND
                || journal.phase != "ready"
                || journal.payload["evidence"]["roleId"].as_str() != Some(role)
            {
                continue;
            }
            let evidence: crate::session_recovery::fresh::Evidence =
                serde_json::from_value(journal.payload["evidence"].clone()).map_err(|_| {
                    crate::session_recovery::error("RECOVERY_FRESH_EVIDENCE_INVALID")
                })?;
            if evidence.original_journal != current {
                continue;
            }
            if evidence.platform != platform || evidence.id() != journal.id {
                return Err(crate::session_recovery::error(
                    "RECOVERY_FRESH_EVIDENCE_INVALID",
                ));
            }
            evidence.verify(&self.user_data_dir)?;
            let expected = self
                .user_data_dir
                .join("roles")
                .join(role)
                .join("browser/sessions")
                .join(&evidence.attempt_id)
                .join("chromium");
            if crate::role_browser_data::chromium_directory(&self.user_data_dir, role)? != expected
            {
                return Err(crate::session_recovery::error(
                    "RECOVERY_FRESH_EVIDENCE_INVALID",
                ));
            }
            return Ok(Some(journal));
        }
        Ok(None)
    }

    fn fresh_session_record_from_journal(
        &self,
        journal: &OperationJournalRecord,
    ) -> CoreResult<crate::RoleSessionRecoveryRecord> {
        let invalid = || crate::session_recovery::error("RECOVERY_FRESH_EVIDENCE_INVALID");
        let record: crate::RoleSessionRecoveryRecord =
            serde_json::from_value(journal.payload["result"].clone()).map_err(|_| invalid())?;
        let evidence: crate::session_recovery::fresh::Evidence =
            serde_json::from_value(journal.payload["evidence"].clone()).map_err(|_| invalid())?;
        if evidence.id() != journal.id
            || record.role_id != evidence.role_id
            || record.attempt_id.as_deref() != Some(evidence.attempt_id.as_str())
            || record.phase != "freshReady"
            || record.upgrade_result.as_deref() != Some(&evidence.result)
        {
            return Err(invalid());
        }
        Ok(record)
    }

    fn resume_completed_upgrade_publication(&self, role: &str) -> CoreResult<Option<Value>> {
        let current = self.role_session_migration(role.to_owned())?;
        for mut journal in self.with_runtime(|runtime| runtime.state.operation_journals())? {
            if journal.kind != crate::session_recovery::fresh::KIND
                || journal.phase != "preparing"
                || journal.payload["evidence"]["roleId"].as_str() != Some(role)
                || journal.payload["result"]["phase"] != "freshReady"
            {
                continue;
            }
            let evidence: crate::session_recovery::fresh::Evidence =
                serde_json::from_value(journal.payload["evidence"].clone()).map_err(|_| {
                    crate::session_recovery::error("RECOVERY_FRESH_EVIDENCE_INVALID")
                })?;
            let expected_platform = match self.platform {
                rion_platform::Platform::Macos => "macos",
                rion_platform::Platform::Windows => "windows",
            };
            if evidence.platform != expected_platform || evidence.id() != journal.id {
                return Err(crate::session_recovery::error(
                    "RECOVERY_FRESH_EVIDENCE_INVALID",
                ));
            }
            if evidence.original_journal != current || evidence.verify(&self.user_data_dir).is_err()
            {
                continue;
            }
            let expected = self
                .user_data_dir
                .join("roles")
                .join(role)
                .join("browser/sessions")
                .join(&evidence.attempt_id)
                .join("chromium");
            if crate::role_browser_data::chromium_directory(&self.user_data_dir, role)? != expected
            {
                continue;
            }
            // Exact durable marker and choice publication survived. This commits
            // only session usability, never infers an import receipt from restart.
            journal.phase = "ready".to_owned();
            let record = self.fresh_session_record_from_journal(&journal)?;
            self.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
            self.emit(vec![CoreEvent::RoleSessionRecoveryChanged {
                record: record.clone(),
            }]);
            return Ok(Some(json!(record)));
        }
        Ok(None)
    }

    async fn ensure_initial_role_session_upgrade(self: &Arc<Self>, role: &str) -> CoreResult<()> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION
            || self.role_session_launch_evidence_ready(role)?
        {
            return Ok(());
        }
        let previous = self.role_session_migration(role.to_owned())?;
        let result = self
            .start_fresh_role_session(
                role.to_owned(),
                uuid::Uuid::new_v4().to_string(),
                previous.as_ref().map(|j| j.journal_revision),
            )
            .await?;
        if result["phase"] != "freshReady" {
            return Err(crate::session_recovery::error("RECOVERY_UPGRADE_NOT_READY"));
        }
        Ok(())
    }

    async fn start_fresh_role_session(
        self: &Arc<Self>,
        role: String,
        attempt: String,
        expected: Option<u64>,
    ) -> CoreResult<Value> {
        use crate::session_recovery::{error, fresh, upgrade};
        crate::session_recovery::uuid(&role)?;
        crate::session_recovery::uuid(&attempt)?;
        self.ensure_role_exists(&role)?;
        if self.runtime_contract_version < CHROMIUM_RUNTIME_MIN_CONTRACT_VERSION {
            return Err(error("RECOVERY_FRESH_RUNTIME_REQUIRED"));
        }
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let guard = BrowserOperationGuard::new(&self.browser_operations, lease.id);
        if let Some(existing) = self.fresh_session_evidence(&role)? {
            return Ok(json!(self.fresh_session_record_from_journal(&existing)?));
        }
        if let Some(record) = self.resume_completed_upgrade_publication(&role)? {
            return Ok(record);
        }
        let previous = self.role_session_migration(role.clone())?;
        if previous.as_ref().map(|j| j.journal_revision) != expected {
            return Err(error("RECOVERY_JOURNAL_STALE"));
        }
        if previous.as_ref().is_some_and(|j| {
            !matches!(
                j.phase,
                crate::RoleSessionMigrationPhase::Failed
                    | crate::RoleSessionMigrationPhase::Indeterminate
                    | crate::RoleSessionMigrationPhase::V22Ready
            ) || j.first_verified_launch_at.is_some()
                || j.platform != self.expected_role_session_migration_platform()
        }) {
            return Err(error("RECOVERY_JOURNAL_NOT_ELIGIBLE"));
        }
        if self.browser_statuses()?.iter().any(|s| s.role_id == role)
            || self.session_recovery_lock()?.active.contains_key(&role)
        {
            return Err(error("RECOVERY_ROLE_IN_USE"));
        }
        self.ensure_role_session_recovery_complete(&role)?;
        let mut evidence = fresh::Evidence {
            role_id: role.clone(),
            attempt_id: attempt.clone(),
            original_journal: previous.clone(),
            platform: match self.platform {
                rion_platform::Platform::Macos => "macos",
                rion_platform::Platform::Windows => "windows",
            }
            .to_owned(),
            result: upgrade::unavailable("UPGRADE_NOT_RUN"),
            clean_flush_receipt: None,
            source_application: None,
            source_policy: None,
            source_sha256: None,
        };
        let mut record = crate::RoleSessionRecoveryRecord {
            role_id: role.clone(),
            attempt_id: Some(attempt.clone()),
            revision: 1,
            journal_revision: expected,
            phase: "reading".to_owned(),
            blockers: Vec::new(),
            candidates: Vec::new(),
            source_integrity: "unverified".to_owned(),
            target_equality: "notRun".to_owned(),
            persistence: "notRun".to_owned(),
            login: "notTested".to_owned(),
            upgrade_result: None,
        };
        let mut operation = OperationJournalRecord {
            id: evidence.id(),
            kind: fresh::KIND.to_owned(),
            phase: "preparing".to_owned(),
            payload: json!({"evidence":evidence,"firstLaunchAdmittedAt":null,"result":record}),
        };
        let interrupted = self.with_runtime(|runtime| {
            let journals = runtime.state.operation_journals()?;
            if journals.iter().any(|j| j.id == operation.id) {
                return Err(error("RECOVERY_ATTEMPT_EXISTS"));
            }
            let interrupted = journals.iter().any(|j| {
                j.kind == fresh::KIND
                    && j.phase == "preparing"
                    && j.payload["evidence"]["roleId"] == role
            });
            runtime.state.put_operation_journal(operation.clone())?;
            Ok(interrupted)
        })?;
        self.session_recovery_lock()?.active.insert(
            role.clone(),
            crate::session_recovery::Active {
                attempt_id: attempt.clone(),
                record: record.clone(),
                cancelled: Arc::new(AtomicBool::new(false)),
                effect_id: None,
                stage_attempt_id: None,
            },
        );
        let _active_guard = crate::session_recovery::ActiveGuard {
            runtime: &self.session_recovery,
            role: &role,
            attempt: &attempt,
        };
        self.emit(vec![CoreEvent::RoleSessionRecoveryChanged {
            record: record.clone(),
        }]);
        let core = Arc::clone(self);
        let source_role = role.clone();
        let source_attempt = attempt.clone();
        let source = if interrupted {
            Ok(upgrade::ReadResult {
                envelope: None,
                result: upgrade::unavailable("PREVIOUS_UPGRADE_INTERRUPTED"),
                source: None,
            })
        } else {
            tokio::task::spawn_blocking(move || {
                upgrade::read(
                    &core.user_data_dir,
                    &source_role,
                    &source_attempt,
                    core.platform,
                    previous.as_ref(),
                )
            })
            .await
            .unwrap_or_else(|_| Err(error("RECOVERY_SOURCE_READ_INTERRUPTED")))
        };
        let source = source.unwrap_or_else(|e| upgrade::ReadResult {
            envelope: None,
            result: upgrade::unavailable(e.code()),
            source: None,
        });
        let envelope = source.envelope;
        evidence.result = source.result;
        if let Some(source) = source.source {
            evidence.source_application = Some(source.application);
            evidence.source_policy = Some(source.policy);
            evidence.source_sha256 = Some(source.sha256);
        }
        let mut imported = None;
        if let Some(envelope) = envelope {
            record.phase = "isolatedImport".to_owned();
            record.revision += 1;
            self.session_recovery_lock()?
                .active
                .get_mut(&role)
                .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?
                .record = record.clone();
            operation.payload["result"] = json!(record);
            self.with_runtime(|runtime| runtime.state.put_operation_journal(operation.clone()))?;
            self.emit(vec![CoreEvent::RoleSessionRecoveryChanged {
                record: record.clone(),
            }]);
            let best_effort_cookies = evidence
                .result
                .reasons
                .iter()
                .any(|reason| reason == "COOKIE_RAW_SOURCE_BEST_EFFORT");
            match self
                .verify_upgrade_subset(
                    &role,
                    &attempt,
                    &attempt,
                    envelope.clone(),
                    best_effort_cookies,
                )
                .await
            {
                Ok((path, receipt)) => {
                    upgrade::verified(&mut evidence.result, &envelope, receipt.cookie_count);
                    if receipt.cookie_skipped_count > 0 {
                        evidence
                            .result
                            .reasons
                            .push("COOKIE_CHROMIUM_REJECTED_RECORDS".to_owned());
                        evidence.result.reasons.sort();
                        evidence.result.reasons.dedup();
                    }
                    evidence.clean_flush_receipt = Some(receipt.clean_flush_receipt_id);
                    imported = Some(path);
                }
                Err(e) => {
                    let local_status = evidence.result.local_storage.clone();
                    upgrade::failed(&mut evidence.result, e.code());
                    // A cookie failure does not discard independently readable LocalStorage.
                    // Preserve an unconfirmed helper tree and retry in a new owned tree.
                    if !envelope.inventory.cookies.is_empty()
                        && !envelope.inventory.local_storage.is_empty()
                        && self.recovery_current(&role, &attempt).is_ok()
                    {
                        let mut storage_only = envelope;
                        storage_only.inventory.cookies.clear();
                        let storage_attempt = uuid::Uuid::new_v4().to_string();
                        match self
                            .verify_upgrade_subset(
                                &role,
                                &attempt,
                                &storage_attempt,
                                storage_only.clone(),
                                false,
                            )
                            .await
                        {
                            Ok((path, receipt)) => {
                                evidence.result.local_storage = local_status;
                                upgrade::verified(
                                    &mut evidence.result,
                                    &storage_only,
                                    receipt.cookie_count,
                                );
                                evidence.clean_flush_receipt =
                                    Some(receipt.clean_flush_receipt_id);
                                imported = Some(path);
                            }
                            Err(e) => upgrade::failed(&mut evidence.result, e.code()),
                        }
                    }
                }
            }
        }
        // Cancellation prevents subset installation, but still permits an empty
        // session. It cannot label unacknowledged imported data as transferred.
        if self.recovery_current(&role, &attempt).is_err() {
            evidence.result = upgrade::unavailable("RECOVERY_CANCELLED");
            evidence.clean_flush_receipt = None;
            imported = None;
        }
        record.phase = "freshReady".to_owned();
        record.revision += 1;
        // Storage transfer says nothing authoritative about remote login.
        record.login = "notTested".to_owned();
        record.upgrade_result = Some(Box::new(evidence.result.clone()));
        operation.payload["evidence"] = json!(evidence);
        operation.payload["result"] = json!(record);
        self.with_runtime(|runtime| runtime.state.put_operation_journal(operation.clone()))?;
        evidence.prepare(&self.user_data_dir, imported.as_deref())?;
        operation.phase = "ready".to_owned();
        self.with_runtime(|runtime| runtime.state.put_operation_journal(operation))?;
        self.session_recovery_lock()?
            .active
            .get_mut(&role)
            .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?
            .record = record.clone();
        self.emit(vec![CoreEvent::RoleSessionRecoveryChanged {
            record: record.clone(),
        }]);
        guard.complete()?;
        Ok(json!(record))
    }

    async fn verify_upgrade_subset(
        &self,
        role: &str,
        attempt: &str,
        stage_attempt: &str,
        envelope: crate::RoleSessionTransferEnvelopeRecord,
        best_effort_cookies: bool,
    ) -> CoreResult<(std::path::PathBuf, RecoveryImportReceipt)> {
        use crate::session_recovery::{error, stage};
        self.recovery_current(role, attempt)?;
        let stage = stage::prepare(&self.user_data_dir, stage_attempt, self.platform, envelope)?;
        self.session_recovery_lock()?
            .active
            .get_mut(role)
            .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?
            .stage_attempt_id = Some(stage_attempt.to_owned());
        let receipt = self
            .recovery_import_effect(
                role,
                attempt,
                &stage.journal.transfer_id,
                best_effort_cookies,
            )
            .await?;
        self.recovery_current(role, attempt)?;
        stage::mark_verified(&stage, &receipt.clean_flush_receipt_id)?;
        let path = std::path::PathBuf::from(&stage.paths.chromium_user_data_dir);
        crate::session_source::snapshot::released(&path, self.platform).map_err(error)?;
        Ok((path, receipt))
    }

    fn mark_fresh_session_launch_admitted(&self, role: &str) -> CoreResult<bool> {
        let Some(mut journal) = self.fresh_session_evidence(role)? else {
            return Ok(false);
        };
        if journal.payload["firstLaunchAdmittedAt"].is_null() {
            journal.payload["firstLaunchAdmittedAt"] =
                json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            self.with_runtime(|runtime| runtime.state.put_operation_journal(journal))?;
        }
        Ok(true)
    }
}
