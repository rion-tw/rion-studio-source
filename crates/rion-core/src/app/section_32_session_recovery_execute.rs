impl AppCore {
    async fn recover_role_session(
        self: &Arc<Self>,
        role: String,
        attempt: String,
        expected: Option<u64>,
        token: String,
    ) -> CoreResult<Value> {
        use crate::session_recovery::{error, source, stage};
        crate::session_recovery::uuid(&attempt)?;
        self.ensure_role_exists(&role)?;
        let lease = self
            .acquire_browser_operation_async(BrowserOperationRequest {
                role_ids: vec![role.clone()],
                kind: "recoverableMutation".to_owned(),
            })
            .await?;
        let guard = BrowserOperationGuard::new(&self.browser_operations, lease.id);
        if self.fresh_session_evidence(&role)?.is_some() { return Err(error("RECOVERY_FRESH_SESSION_IN_USE")); }
        let previous = self.role_session_migration(role.clone())?;
        if previous.as_ref().map(|j| j.journal_revision) != expected {
            return Err(error("RECOVERY_JOURNAL_STALE"));
        }
        if previous.as_ref().is_some_and(|j| {
            j.phase != crate::RoleSessionMigrationPhase::Failed
                || j.first_verified_launch_at.is_some()
        }) {
            return Err(error("RECOVERY_JOURNAL_NOT_ELIGIBLE"));
        }
        if self.browser_statuses()?.iter().any(|s| s.role_id == role) {
            return Err(error("RECOVERY_ROLE_IN_USE"));
        }
        stage::ensure_target_empty(&self.user_data_dir, &role)?;
        let record = crate::RoleSessionRecoveryRecord {
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
        {
            let mut runtime = self.session_recovery_lock()?;
            if runtime.active.contains_key(&role) {
                return Err(error("RECOVERY_ALREADY_ACTIVE"));
            }
            self.with_runtime(|runtime| {
                let id = format!("session-recovery-{attempt}");
                if runtime.state.operation_journals()?.iter().any(|j|j.id==id) {return Err(error("RECOVERY_ATTEMPT_EXISTS"));}
                runtime.state.put_operation_journal(OperationJournalRecord {id,kind:"role_session_recovery_v1".to_owned(),phase:"reading".to_owned(),payload:json!({"roleId":role,"attemptId":attempt,"sourceToken":token,"sourceDigest":null,"originalJournal":previous,"result":record})})
            })?;
            runtime.active.insert(
                role.clone(),
                crate::session_recovery::Active {
                    attempt_id: attempt.clone(),
                    record: record.clone(),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    effect_id: None,
                    stage_attempt_id: None,
                },
            );
        }
        let _active_guard = crate::session_recovery::ActiveGuard {
            runtime: &self.session_recovery,
            role: &role,
            attempt: &attempt,
        };
        self.emit(vec![CoreEvent::RoleSessionRecoveryChanged { record }]);
        let result = async {
            self.recovery_current(&role, &attempt)?;
            let core = Arc::clone(self);
            let source_role = role.clone();
            let source_previous = previous.clone();
            let candidates = tokio::task::spawn_blocking(move || {
                source::inspect(
                    &core.user_data_dir,
                    core.platform,
                    &source_role,
                    source_previous.as_ref(),
                )
            })
            .await
            .map_err(|e| CoreError::Internal(e.to_string()))??;
            self.recovery_current(&role, &attempt)?;
            let selected = candidates
                .into_iter()
                .find(|c| c.view.token == token)
                .ok_or_else(|| error("RECOVERY_SOURCE_TOKEN_STALE"))?;
            if !selected.view.supported {
                return Err(error("RECOVERY_SOURCE_COMPLETENESS_UNPROVEN"));
            }
            let fingerprint = source::assert_current(&selected)?;
            let envelope = selected
                .envelope
                .ok_or_else(|| error("RECOVERY_SOURCE_COMPLETENESS_UNPROVEN"))?;
            self.recovery_current(&role, &attempt)?;
            self.session_recovery_lock()?
                .active
                .get_mut(&role)
                .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?
                .record
                .candidates = vec![selected.view];
            self.with_runtime(|runtime| {
                let id = format!("session-recovery-{attempt}");
                let mut journal = runtime
                    .state
                    .operation_journals()?
                    .into_iter()
                    .find(|journal| journal.id == id)
                    .ok_or_else(|| error("RECOVERY_ATTEMPT_HISTORY_MISSING"))?;
                journal.payload["sourceDigest"] = json!(fingerprint);
                runtime.state.put_operation_journal(journal)
            })?;
            self.recovery_pipeline(
                &role,
                &attempt,
                previous,
                envelope,
                &selected.path,
                &fingerprint,
            )
            .await
        }
        .await;
        if result.is_err() {
            // A failed/unknown formal helper cannot leave an active importing
            // journal that looks resumable without an explicit failure outcome.
            if let Some(current) = self.role_session_migration(role.clone())?
                && matches!(
                    current.phase,
                    crate::RoleSessionMigrationPhase::Importing
                        | crate::RoleSessionMigrationPhase::Verifying
                )
            {
                let mut input = stage::transition_input(
                    &current,
                    crate::RoleSessionMigrationPhase::Indeterminate,
                );
                input.stable_error_code = Some("RECOVERY_NATIVE_RESULT_UNCONFIRMED".to_owned());
                input.outcome = Some(crate::RoleSessionMigrationOutcome::Indeterminate);
                self.with_runtime(|runtime| {
                    runtime.state.transition_role_session_migration(
                        crate::session_migration::TransitionAuthority::TargetRuntime {
                            expected_platform: current.platform,
                        },
                        input,
                    )
                })?;
            }
        }
        let record = match result {
            Ok(()) => self.recovery_progress(&role, "complete", None),
            Err(e) => self.recovery_progress(
                &role,
                if e.code() == "RECOVERY_CANCELLED" {
                    "cancelled"
                } else {
                    "failed"
                },
                Some(e.code()),
            ),
        };
        self.session_recovery_lock()?.active.remove(&role);
        // The target is never cleared on failure. Unknown native termination
        // leaves a conflict for explicit diagnosis, not an automatic retry.
        guard.complete()?;
        serde_json::to_value(record?).map_err(|e| CoreError::Internal(e.to_string()))
    }

    async fn recovery_pipeline(
        &self,
        role: &str,
        attempt: &str,
        previous: Option<crate::RoleSessionMigrationRecord>,
        envelope: crate::RoleSessionTransferEnvelopeRecord,
        source_path: &std::path::Path,
        fingerprint: &str,
    ) -> CoreResult<()> {
        use crate::session_recovery::{error, source, stage};
        self.recovery_current(role, attempt)?;
        let stage = stage::prepare(&self.user_data_dir, attempt, self.platform, envelope)?;
        self.recovery_progress(role, "isolatedImport", None)?;
        let receipt = self
            .recovery_import_effect(role, attempt, &stage.journal.transfer_id, false)
            .await?;
        self.recovery_current(role, attempt)?;
        let verified = stage::mark_verified(&stage, &receipt.clean_flush_receipt_id)?;
        if source::digest(source_path)? != fingerprint {
            return Err(error("RECOVERY_SOURCE_TOKEN_STALE"));
        }
        stage::ensure_target_empty(&self.user_data_dir, role)?;
        self.recovery_current(role, attempt)?;
        // Only a fully acknowledged isolated profile may be removed. Protected
        // vault and attempt SQLite remain available for diagnosis.
        crate::session_source::paths::existing(std::path::Path::new(
            &stage.paths.chromium_user_data_dir,
        ))
        .map_err(error)?;
        std::fs::remove_dir_all(&stage.paths.chromium_user_data_dir)
            .map_err(|_| error("RECOVERY_ISOLATED_CLEANUP_FAILED"))?;
        let exported = stage::publish_vault(&self.user_data_dir, self.platform, &stage)?;
        let admitted = self.with_runtime(|runtime| {
            runtime
                .state
                .admit_role_session_recovery(crate::session_recovery::commit::Admission {
                    previous,
                    exported,
                    isolated: verified,
                })
        })?;
        let importing = self.with_runtime(|runtime| {
            runtime.state.begin_role_session_migration_import(
                admitted.platform,
                self.runtime_contract_version,
                crate::RoleSessionMigrationImportBeginInput {
                    role_id: role.to_owned(),
                    transfer_id: admitted.transfer_id,
                    expected_journal_revision: admitted.journal_revision,
                },
            )
        })?;
        self.recovery_progress(role, "formalImport", None)?;
        let receipt = self
            .recovery_import_effect(role, attempt, &importing.transfer_id, false)
            .await?;
        self.recovery_current(role, attempt)?;
        let mut input =
            stage::transition_input(&importing, crate::RoleSessionMigrationPhase::Verifying);
        input.clean_flush_receipt_id = Some(receipt.clean_flush_receipt_id);
        let verifying = self.with_runtime(|runtime| {
            runtime.state.transition_role_session_migration(
                crate::session_migration::TransitionAuthority::TargetRuntime {
                    expected_platform: importing.platform,
                },
                input,
            )
        })?;
        let mut input =
            stage::transition_input(&verifying, crate::RoleSessionMigrationPhase::V23Ready);
        input.outcome = Some(crate::RoleSessionMigrationOutcome::Verified);
        self.with_runtime(|runtime| {
            runtime.state.transition_role_session_migration(
                crate::session_migration::TransitionAuthority::TargetRuntime {
                    expected_platform: verifying.platform,
                },
                input,
            )
        })?;
        Ok(())
    }

    async fn recovery_import_effect(
        &self,
        role: &str,
        attempt: &str,
        transfer: &str,
        best_effort_cookies: bool,
    ) -> CoreResult<RecoveryImportReceipt> {
        use crate::session_recovery::error;
        self.recovery_current(role, attempt)?;
        let handle = self
            .operation_actor
            .start(crate::operation_actor::OperationPlan {
                steps: vec![effect_step(
                    "role-session-recovery",
                    CoreEffectAction::RoleSessionRecoveryImport {
                        role_id: role.to_owned(),
                        attempt_id: attempt.to_owned(),
                        transfer_id: transfer.to_owned(),
                        best_effort_cookies,
                    },
                    Duration::ZERO,
                    None,
                )],
            })?;
        {
            let mut runtime = self.session_recovery_lock()?;
            let active = runtime
                .active
                .get_mut(role)
                .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?;
            active.effect_id = Some(handle.operation_id.clone());
            if active.cancelled.load(Ordering::SeqCst) {
                self.operation_actor.cancel(&handle.operation_id)?;
            }
        }
        let outcome = handle
            .outcome
            .await
            .map_err(|_| error("RECOVERY_NATIVE_RESULT_UNKNOWN"))?;
        self.session_recovery_lock()?
            .active
            .get_mut(role)
            .ok_or_else(|| error("RECOVERY_ATTEMPT_NOT_ACTIVE"))?
            .effect_id = None;
        self.recovery_current(role, attempt)?;
        if let Some(e) = outcome.error {
            return Err(CoreError::Effect {
                code: e.code,
                message: e.message,
            });
        }
        let result = outcome
            .results
            .into_iter()
            .next()
            .ok_or_else(|| error("RECOVERY_NATIVE_RESULT_UNKNOWN"))?;
        if !result.ok {
            return Err(error("RECOVERY_NATIVE_IMPORT_FAILED"));
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Receipt {
            role_id: String,
            attempt_id: String,
            transfer_id: String,
            clean_flush_receipt_id: String,
            cookie_count: usize,
            cookie_skipped_count: usize,
        }
        let receipt: Receipt = serde_json::from_str(
            result
                .value_json
                .as_deref()
                .ok_or_else(|| error("RECOVERY_NATIVE_RESULT_UNKNOWN"))?,
        )
        .map_err(|_| error("RECOVERY_NATIVE_RECEIPT_INVALID"))?;
        if receipt.role_id != role
            || receipt.attempt_id != attempt
            || receipt.transfer_id != transfer
        {
            return Err(error("RECOVERY_NATIVE_RECEIPT_IDENTITY_MISMATCH"));
        }
        Ok(RecoveryImportReceipt {
            clean_flush_receipt_id: receipt.clean_flush_receipt_id,
            cookie_count: receipt.cookie_count,
            cookie_skipped_count: receipt.cookie_skipped_count,
        })
    }
}

struct RecoveryImportReceipt {
    clean_flush_receipt_id: String,
    cookie_count: usize,
    cookie_skipped_count: usize,
}
