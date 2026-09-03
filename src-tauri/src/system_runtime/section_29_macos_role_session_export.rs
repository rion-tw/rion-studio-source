#[cfg(any(target_os = "macos", test))]
const WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE: &str =
    "ROLE_SESSION_TRANSFER_WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE";
#[cfg(any(target_os = "macos", test))]
const WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE: &str =
    "ROLE_SESSION_TRANSFER_WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE";
#[cfg(any(target_os = "macos", test))]
const WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE: &str =
    "ROLE_SESSION_TRANSFER_WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE";

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacosWkRoleSessionPublicObservation {
    pub cookie_count: u64,
    pub http_only_cookie_count: u64,
    pub local_storage_record_count: u64,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WkwebviewSourceExportPlan {
    ObservePublicCapabilities,
    ResumePublishedVault,
    VerifyExported,
    ReplayKnownFailure,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosV22RoleSessionExportRequest {
    pub role_id: String,
    pub transfer_id: String,
    pub transition_id: String,
    pub expected_source_revision: u64,
    pub expected_journal_revision: u64,
    pub occurred_at: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosV22RoleSessionExportReceipt {
    pub journal: rion_core::RoleSessionMigrationRecord,
    pub evidence: rion_core::RoleSessionTransferJournalEvidence,
    pub resumed_after_vault_publication: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosV22RoleSessionExportNonSuccessReceipt {
    pub journal: rion_core::RoleSessionMigrationRecord,
    pub blocking_codes: Vec<&'static str>,
    pub source_observation: Option<MacosWkRoleSessionPublicObservation>,
    pub replayed_from_durable_journal: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacosV22RoleSessionExportOutcome {
    Exported(MacosV22RoleSessionExportReceipt),
    NonSuccess(MacosV22RoleSessionExportNonSuccessReceipt),
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosV22RoleSessionExportFailure {
    pub code: &'static str,
    pub message: String,
}

#[cfg(target_os = "macos")]
impl From<RuntimeError> for MacosV22RoleSessionExportFailure {
    fn from(error: RuntimeError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn wkwebview_export_error(code: &'static str, message: &'static str) -> RuntimeError {
    RuntimeError::new(code, message)
}

#[cfg(any(target_os = "macos", test))]
fn validate_wkwebview_source_export_request(
    journal: &rion_core::RoleSessionMigrationRecord,
    request: &MacosV22RoleSessionExportRequest,
) -> RuntimeResult<()> {
    let canonical_uuid = |value: &str| {
        uuid::Uuid::parse_str(value)
            .ok()
            .is_some_and(|parsed| parsed.to_string() == value)
    };
    let canonical_occurred_at = chrono::DateTime::parse_from_rfc3339(&request.occurred_at)
        .ok()
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
    let replayable_terminal = matches!(
        journal.phase,
        rion_core::RoleSessionMigrationPhase::Exported
            | rion_core::RoleSessionMigrationPhase::Failed
    );
    let journal_revision_matches = request.expected_journal_revision == journal.journal_revision
        || (replayable_terminal
            && request
                .expected_journal_revision
                .checked_add(1)
                .is_some_and(|revision| revision == journal.journal_revision));
    if !canonical_uuid(&request.role_id)
        || !canonical_uuid(&request.transfer_id)
        || !canonical_uuid(&request.transition_id)
        || request.role_id != journal.role_id
        || request.transfer_id != journal.transfer_id
        || request.expected_source_revision != journal.source_revision
        || !journal_revision_matches
        || canonical_occurred_at.as_deref() != Some(request.occurred_at.as_str())
        || journal.platform != rion_core::RoleSessionMigrationPlatform::Macos
        || journal.source_engine != rion_core::RoleSessionMigrationEngine::Wkwebview
        || journal.target_engine != rion_core::RoleSessionMigrationEngine::Chromium
    {
        return Err(wkwebview_export_error(
            "ROLE_SESSION_TRANSFER_WKWEBVIEW_JOURNAL_STALE",
            "The WKWebView export request no longer matches the authoritative journal revision.",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn validate_wkwebview_export_evidence_identity(
    journal: &rion_core::RoleSessionMigrationRecord,
    evidence: &rion_core::RoleSessionTransferJournalEvidence,
) -> RuntimeResult<()> {
    if evidence.role_id != journal.role_id || evidence.transfer_id != journal.transfer_id {
        return Err(wkwebview_export_error(
            "ROLE_SESSION_TRANSFER_WKWEBVIEW_EVIDENCE_STALE",
            "The durable WKWebView export evidence does not match its authoritative journal.",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn known_wkwebview_failure_code(
    journal: &rion_core::RoleSessionMigrationRecord,
) -> Option<&'static str> {
    match journal.stable_error_code.as_deref() {
        Some(WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE) => {
            Some(WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE)
        }
        Some(WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE) => {
            Some(WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE)
        }
        Some(WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE) => {
            Some(WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE)
        }
        _ => None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn plan_wkwebview_source_export(
    journal: &rion_core::RoleSessionMigrationRecord,
    request: &MacosV22RoleSessionExportRequest,
    pending_evidence: Option<&rion_core::RoleSessionTransferJournalEvidence>,
) -> RuntimeResult<WkwebviewSourceExportPlan> {
    validate_wkwebview_source_export_request(journal, request)?;
    match journal.phase {
        rion_core::RoleSessionMigrationPhase::V22Ready => {
            if let Some(evidence) = pending_evidence {
                validate_wkwebview_export_evidence_identity(journal, evidence)?;
                Ok(WkwebviewSourceExportPlan::ResumePublishedVault)
            } else {
                Ok(WkwebviewSourceExportPlan::ObservePublicCapabilities)
            }
        }
        rion_core::RoleSessionMigrationPhase::Exported if pending_evidence.is_none() => {
            Ok(WkwebviewSourceExportPlan::VerifyExported)
        }
        rion_core::RoleSessionMigrationPhase::Failed
            if pending_evidence.is_none() && known_wkwebview_failure_code(journal).is_some() =>
        {
            Ok(WkwebviewSourceExportPlan::ReplayKnownFailure)
        }
        _ => Err(wkwebview_export_error(
            "ROLE_SESSION_TRANSFER_WKWEBVIEW_JOURNAL_STATE_INVALID",
            "The WKWebView export journal is not in an exact resumable source phase.",
        )),
    }
}

#[cfg(any(target_os = "macos", test))]
fn wkwebview_export_transition(
    request: &MacosV22RoleSessionExportRequest,
    evidence: &rion_core::RoleSessionTransferJournalEvidence,
) -> RuntimeResult<rion_core::RoleSessionMigrationTransitionInput> {
    let mut transition = rion_core::RoleSessionMigrationTransitionInput {
        role_id: request.role_id.clone(),
        transfer_id: request.transfer_id.clone(),
        transition_id: request.transition_id.clone(),
        expected_phase: rion_core::RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: request.expected_journal_revision,
        next_phase: rion_core::RoleSessionMigrationPhase::Exported,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: request.occurred_at.clone(),
    };
    evidence
        .apply_to_transition(&mut transition)
        .map_err(RuntimeError::core)?;
    Ok(transition)
}

#[cfg(any(target_os = "macos", test))]
fn wkwebview_failed_transition(
    request: &MacosV22RoleSessionExportRequest,
    stable_error_code: &str,
) -> rion_core::RoleSessionMigrationTransitionInput {
    rion_core::RoleSessionMigrationTransitionInput {
        role_id: request.role_id.clone(),
        transfer_id: request.transfer_id.clone(),
        transition_id: request.transition_id.clone(),
        expected_phase: rion_core::RoleSessionMigrationPhase::V22Ready,
        expected_journal_revision: request.expected_journal_revision,
        next_phase: rion_core::RoleSessionMigrationPhase::Failed,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: Some(stable_error_code.to_owned()),
        outcome: Some(rion_core::RoleSessionMigrationOutcome::Failed),
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: request.occurred_at.clone(),
    }
}

#[cfg(any(target_os = "macos", test))]
fn wkwebview_public_capability_blockers(
    observation: MacosWkRoleSessionPublicObservation,
) -> Vec<&'static str> {
    let mut blockers = Vec::with_capacity(3);
    if observation.cookie_count > 0 {
        blockers.push(WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE);
    }
    if observation.local_storage_record_count > 0 {
        blockers.push(WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE);
    }
    // getAllCookies and fetchDataRecordsOfTypes are independent callbacks;
    // WebKit publishes no transaction/revision proving one stable combined
    // source snapshot. Even two empty callbacks cannot authorize a vault.
    blockers.push(WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE);
    blockers
}

#[cfg(any(target_os = "macos", test))]
fn wkwebview_primary_capability_blocker(
    observation: MacosWkRoleSessionPublicObservation,
) -> &'static str {
    if observation.local_storage_record_count > 0 {
        WKWEBVIEW_LOCAL_STORAGE_VALUES_UNREADABLE
    } else if observation.cookie_count > 0 {
        WKWEBVIEW_COOKIE_ATTRIBUTES_INCOMPLETE
    } else {
        WKWEBVIEW_SNAPSHOT_STABILITY_UNPROVABLE
    }
}

#[cfg(target_os = "macos")]
impl SystemRuntimeExecutor {
    /// Schedules one startup-authoritative pass after Core has atomically
    /// prepared every missing v22 role journal. This coordinator never creates
    /// or rewrites journal identity and never treats startup as user consent.
    pub fn schedule_macos_v22_role_session_export_resume(
        self: &Arc<Self>,
    ) -> RuntimeResult<()> {
        let journals = self
            .core
            .role_session_migrations()
            .map_err(RuntimeError::core)?
            .into_iter()
            .filter(|journal| {
                journal.platform == rion_core::RoleSessionMigrationPlatform::Macos
                    && matches!(
                        journal.phase,
                        rion_core::RoleSessionMigrationPhase::V22Ready
                            | rion_core::RoleSessionMigrationPhase::Exported
                    )
            })
            .collect::<Vec<_>>();
        if journals.is_empty() {
            return Ok(());
        }
        for journal in journals {
            let runtime = Arc::clone(self);
            let _task = tauri::async_runtime::spawn(async move {
                let request = MacosV22RoleSessionExportRequest {
                    role_id: journal.role_id.clone(),
                    transfer_id: journal.transfer_id.clone(),
                    transition_id: uuid::Uuid::new_v4().to_string(),
                    expected_source_revision: journal.source_revision,
                    expected_journal_revision: journal.journal_revision,
                    occurred_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                };
                match runtime.export_macos_v22_role_session_internal(request).await {
                    Ok(MacosV22RoleSessionExportOutcome::Exported(receipt)) => {
                        eprintln!(
                            "WKWebView role-session export resumed: role={} revision={} cookies={} local-storage-origins={} local-storage-entries={} vault-resume={}",
                            receipt.journal.role_id,
                            receipt.journal.journal_revision,
                            receipt.evidence.cookie_count,
                            receipt.evidence.local_storage_origin_count,
                            receipt.evidence.local_storage_entry_count,
                            receipt.resumed_after_vault_publication,
                        );
                    }
                    Ok(MacosV22RoleSessionExportOutcome::NonSuccess(receipt)) => {
                        let (cookies, http_only, local_storage_records) = receipt
                            .source_observation
                            .map(|observation| {
                                (
                                    observation.cookie_count,
                                    observation.http_only_cookie_count,
                                    observation.local_storage_record_count,
                                )
                            })
                            .unwrap_or_default();
                        eprintln!(
                            "WKWebView role-session export remained on v22: role={} revision={} blockers={} cookies={} http-only-cookies={} local-storage-records={} durable-replay={}",
                            receipt.journal.role_id,
                            receipt.journal.journal_revision,
                            receipt.blocking_codes.join(","),
                            cookies,
                            http_only,
                            local_storage_records,
                            receipt.replayed_from_durable_journal,
                        );
                    }
                    Err(error) => {
                        eprintln!(
                            "WKWebView role-session export did not terminalize: role={} code={}",
                            journal.role_id, error.code,
                        );
                    }
                }
            });
        }
        Ok(())
    }

    /// Privileged v22 WKWebsiteDataStore export boundary. Public WebKit APIs
    /// currently produce only a classified non-success capability receipt;
    /// an authenticated vault already published by an exact future/test source
    /// may still resume without guessing or reading plaintext.
    pub async fn export_macos_v22_role_session_internal(
        &self,
        request: MacosV22RoleSessionExportRequest,
    ) -> Result<MacosV22RoleSessionExportOutcome, MacosV22RoleSessionExportFailure> {
        self.export_macos_v22_role_session_inner(request)
            .await
            .map_err(Into::into)
    }

    async fn export_macos_v22_role_session_inner(
        &self,
        request: MacosV22RoleSessionExportRequest,
    ) -> RuntimeResult<MacosV22RoleSessionExportOutcome> {
        let core = Arc::clone(&self.core);
        let role_id = request.role_id.clone();
        let lease = tokio::task::spawn_blocking(move || {
            core.acquire_browser_operation(rion_core::BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "recoverableMutation".to_owned(),
            })
        })
        .await
        .map_err(|_| {
            wkwebview_export_error(
                "ROLE_SESSION_TRANSFER_WKWEBVIEW_LEASE_CANCELLED",
                "The WKWebView export role-operation lease actor stopped.",
            )
        })?
        .map_err(RuntimeError::core)?;

        let result = self
            .export_macos_v22_role_session_under_lease(&request)
            .await;
        let completion = self
            .core
            .complete_browser_operation(&lease.id)
            .map_err(RuntimeError::core);
        match (result, completion) {
            (Ok(outcome), Ok(())) => Ok(outcome),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn export_macos_v22_role_session_under_lease(
        &self,
        request: &MacosV22RoleSessionExportRequest,
    ) -> RuntimeResult<MacosV22RoleSessionExportOutcome> {
        let journal = self
            .core
            .role_session_migration(request.role_id.clone())
            .map_err(RuntimeError::core)?
            .ok_or_else(|| {
                wkwebview_export_error(
                    "ROLE_SESSION_TRANSFER_WKWEBVIEW_JOURNAL_NOT_FOUND",
                    "The WKWebView source-export journal is unavailable.",
                )
            })?;
        validate_wkwebview_source_export_request(&journal, request)?;

        if journal.phase == rion_core::RoleSessionMigrationPhase::Exported {
            debug_assert_eq!(
                plan_wkwebview_source_export(&journal, request, None)?,
                WkwebviewSourceExportPlan::VerifyExported
            );
            let evidence = self
                .core
                .verified_role_session_transfer_vault_evidence_internal(
                    request.role_id.clone(),
                    request.transfer_id.clone(),
                )
                .map_err(RuntimeError::core)?;
            validate_wkwebview_export_evidence_identity(&journal, &evidence)?;
            return Ok(MacosV22RoleSessionExportOutcome::Exported(
                MacosV22RoleSessionExportReceipt {
                    journal,
                    evidence,
                    resumed_after_vault_publication: false,
                },
            ));
        }

        if journal.phase == rion_core::RoleSessionMigrationPhase::Failed {
            if plan_wkwebview_source_export(&journal, request, None)?
                != WkwebviewSourceExportPlan::ReplayKnownFailure
            {
                unreachable!();
            }
            let stable_error_code = known_wkwebview_failure_code(&journal)
                .expect("known failure replay retains its stable code");
            return Ok(MacosV22RoleSessionExportOutcome::NonSuccess(
                MacosV22RoleSessionExportNonSuccessReceipt {
                    journal,
                    blocking_codes: vec![stable_error_code],
                    source_observation: None,
                    replayed_from_durable_journal: true,
                },
            ));
        }

        let pending = self
            .core
            .pending_role_session_transfer_vault_evidence_internal(
                request.role_id.clone(),
                request.transfer_id.clone(),
            )
            .map_err(RuntimeError::core)?;
        match plan_wkwebview_source_export(&journal, request, pending.as_ref())? {
            WkwebviewSourceExportPlan::ResumePublishedVault => {
                self.require_wkwebview_export_role_stopped(&request.role_id)?;
                let evidence = pending.expect("resume plan requires authenticated evidence");
                let journal = self
                    .core
                    .transition_role_session_migration(wkwebview_export_transition(
                        request, &evidence,
                    )?)
                    .map_err(RuntimeError::core)?;
                Ok(MacosV22RoleSessionExportOutcome::Exported(
                    MacosV22RoleSessionExportReceipt {
                        journal,
                        evidence,
                        resumed_after_vault_publication: true,
                    },
                ))
            }
            WkwebviewSourceExportPlan::ObservePublicCapabilities => {
                let identifier = role_session_paths(&self.user_data_dir, &request.role_id)?
                    .webkit_identifier;
                let observation =
                    observe_macos_wk_role_session_public_evidence(&self.app, identifier).await?;
                let blocking_codes = wkwebview_public_capability_blockers(observation);
                let primary = wkwebview_primary_capability_blocker(observation);
                let journal = self
                    .core
                    .transition_role_session_migration(wkwebview_failed_transition(
                        request, primary,
                    ))
                    .map_err(RuntimeError::core)?;
                Ok(MacosV22RoleSessionExportOutcome::NonSuccess(
                    MacosV22RoleSessionExportNonSuccessReceipt {
                        journal,
                        blocking_codes,
                        source_observation: Some(observation),
                        replayed_from_durable_journal: false,
                    },
                ))
            }
            WkwebviewSourceExportPlan::VerifyExported
            | WkwebviewSourceExportPlan::ReplayKnownFailure => unreachable!(),
        }
    }

    fn require_wkwebview_export_role_stopped(&self, role_id: &str) -> RuntimeResult<()> {
        let state = self.state()?;
        let has_surface = state.has_native_role_surface(role_id)
            || state
                .native_resources
                .surface_registry
                .values()
                .chain(state.native_resources.retired_surface_registry.values())
                .any(|surface| surface.role_id.as_deref() == Some(role_id));
        if has_surface
            || state.close_coordinator.closing_roles.contains(role_id)
            || state.close_coordinator.quarantined_roles.contains(role_id)
        {
            return Err(wkwebview_export_error(
                "ROLE_SESSION_TRANSFER_WKWEBVIEW_RESUME_SOURCE_CHANGED",
                "A live or indeterminate role surface prevents crash-resuming the published vault.",
            ));
        }
        Ok(())
    }
}
