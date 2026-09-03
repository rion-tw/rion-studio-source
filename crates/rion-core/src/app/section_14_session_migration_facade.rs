impl AppCore {
    fn expected_role_session_migration_platform(&self) -> crate::RoleSessionMigrationPlatform {
        match self.platform {
            rion_platform::Platform::Macos => crate::RoleSessionMigrationPlatform::Macos,
            rion_platform::Platform::Windows => crate::RoleSessionMigrationPlatform::Windows,
        }
    }

    fn require_exact_v22_source_runtime(&self) -> CoreResult<crate::RoleSessionMigrationPlatform> {
        if self.runtime_contract_version != STABLE_SYSTEM_WEBVIEW_RUNTIME_CONTRACT_VERSION {
            return Err(role_session_source_runtime_required());
        }
        Ok(self.expected_role_session_migration_platform())
    }

    pub fn role_session_migration(
        &self,
        role_id: String,
    ) -> CoreResult<Option<crate::RoleSessionMigrationRecord>> {
        self.with_runtime(|runtime| runtime.state.role_session_migration(role_id))
    }

    pub fn role_session_migrations(&self) -> CoreResult<Vec<crate::RoleSessionMigrationRecord>> {
        self.with_runtime(|runtime| runtime.state.role_session_migrations())
    }

    fn role_session_launch_evidence_ready(&self, role_id: &str) -> CoreResult<bool> {
        let migration = self.role_session_migration(role_id.to_owned())?;
        let expected_platform = self.expected_role_session_migration_platform();
        Ok(migration.as_ref().is_some_and(|journal| {
            journal.phase == crate::RoleSessionMigrationPhase::V23Ready
                && journal.platform == expected_platform
                && journal.target_engine == crate::RoleSessionMigrationEngine::Chromium
                && crate::v23_role_initialization::launch_evidence_matches(
                    &self.user_data_dir,
                    journal,
                )
        }))
    }

    fn require_role_session_launch_evidence(&self, role_id: &str) -> CoreResult<()> {
        if self.role_session_launch_evidence_ready(role_id)? {
            Ok(())
        } else {
            Err(role_session_launch_fence_not_ready())
        }
    }

    /// Privileged stable-shell startup boundary. Renderer commands cannot
    /// manufacture source-authoritative migration journals.
    pub fn prepare_v22_role_session_migrations_internal(
        &self,
    ) -> CoreResult<Vec<crate::RoleSessionMigrationRecord>> {
        let platform = self.require_exact_v22_source_runtime()?;
        self.with_runtime(|runtime| runtime.state.prepare_v22_role_session_migrations(platform))
    }

    /// Privileged shell-only mutation. This is intentionally absent from
    /// `CoreCommand`; native migration adapters are the only callers allowed
    /// to establish a source-authoritative transfer identity.
    pub fn start_role_session_migration(
        &self,
        input: crate::RoleSessionMigrationStartInput,
    ) -> CoreResult<crate::RoleSessionMigrationRecord> {
        let expected_platform = self.require_exact_v22_source_runtime()?;
        let expected_source_engine = match expected_platform {
            crate::RoleSessionMigrationPlatform::Macos => {
                crate::RoleSessionMigrationEngine::Wkwebview
            }
            crate::RoleSessionMigrationPlatform::Windows => {
                crate::RoleSessionMigrationEngine::Webview2
            }
        };
        if input.platform != expected_platform || input.source_engine != expected_source_engine {
            return Err(role_session_source_identity_mismatch());
        }
        self.with_runtime(|runtime| runtime.state.start_role_session_migration(input))
    }

    /// Privileged shell-only journal CAS. Renderer commands may observe the
    /// durable record, but cannot advance, fail, or verify a migration.
    pub fn transition_role_session_migration(
        &self,
        input: crate::RoleSessionMigrationTransitionInput,
    ) -> CoreResult<crate::RoleSessionMigrationRecord> {
        if self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(role_session_target_generic_transition_forbidden());
        }
        let expected_platform = self.require_exact_v22_source_runtime()?;
        if input.mark_first_verified_launch {
            return Err(role_session_launch_fence_private());
        }
        let authority =
            crate::session_migration::TransitionAuthority::SourceRuntime { expected_platform };
        if input.expected_phase == crate::RoleSessionMigrationPhase::V22Ready
            && input.next_phase == crate::RoleSessionMigrationPhase::Exported
        {
            let _vault_guard = self.session_transfer_vault_guard.lock().map_err(|_| {
                crate::CoreError::Internal("session-transfer vault lock poisoned".to_owned())
            })?;
            if let Some(current) = self.role_session_migration(input.role_id.clone())?
                && matches!(
                    current.phase,
                    crate::RoleSessionMigrationPhase::V22Ready
                        | crate::RoleSessionMigrationPhase::Exported
                )
            {
                self.validate_source_export_vault_evidence(&current, &input)?;
            }
            return self.transition_role_session_migration_with_authority(authority, input);
        }
        self.transition_role_session_migration_with_authority(authority, input)
    }

    /// Narrow v23 target boundary. Rust supplies every durable inventory field
    /// from the current journal and accepts only canonical verify/error edges.
    /// The generic target CAS and first-launch fence are not public APIs.
    pub fn transition_role_session_migration_target_internal(
        &self,
        input: crate::RoleSessionMigrationTargetTransitionInput,
    ) -> CoreResult<crate::RoleSessionMigrationRecord> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(role_session_target_runtime_required());
        }
        let expected_platform = self.expected_role_session_migration_platform();
        let current = self
            .role_session_migration(input.role_id.clone())?
            .ok_or_else(role_session_migration_not_found)?;
        let transition = crate::session_migration::expand_target_transition(&current, input)?;
        self.transition_role_session_migration_with_authority(
            crate::session_migration::TransitionAuthority::TargetRuntime { expected_platform },
            transition,
        )
    }

    fn transition_role_session_migration_with_authority(
        &self,
        authority: crate::session_migration::TransitionAuthority,
        input: crate::RoleSessionMigrationTransitionInput,
    ) -> CoreResult<crate::RoleSessionMigrationRecord> {
        self.with_runtime(|runtime| {
            runtime
                .state
                .transition_role_session_migration(authority, input)
        })
    }

    /// Privileged v23 startup boundary. Rust atomically admits an exact
    /// `exported` transfer into its first Chromium target revision; the target
    /// shell cannot choose that revision or rewrite the source evidence.
    pub fn begin_role_session_migration_import_internal(
        &self,
        input: crate::RoleSessionMigrationImportBeginInput,
    ) -> CoreResult<crate::RoleSessionMigrationRecord> {
        let expected_platform = self.expected_role_session_migration_platform();
        let runtime_contract_version = self.runtime_contract_version;
        self.with_runtime(|runtime| {
            runtime.state.begin_role_session_migration_import(
                expected_platform,
                runtime_contract_version,
                input,
            )
        })
    }

    /// Arms the irreversible v23 downgrade fence after every role migration
    /// preflight has passed and before Core publishes any Chromium native
    /// effect. A later native failure deliberately leaves this fence in place:
    /// the shell cannot prove that an admitted navigation made no durable
    /// Chromium store mutation before failing or crashing.
    fn mark_role_session_launch_admitted(&self, role_ids: &[String]) -> CoreResult<()> {
        let expected_platform = self.expected_role_session_migration_platform();
        if self.runtime_contract_version >= CHROMIUM_RUNTIME_CONTRACT_VERSION {
            for role_id in role_ids {
                let current = self
                    .role_session_migration(role_id.clone())?
                    .ok_or_else(role_session_launch_fence_not_ready)?;
                if current.platform != expected_platform {
                    return Err(role_session_launch_fence_platform_mismatch());
                }
            }
        }
        for role_id in role_ids {
            self.ensure_role_session_recovery_complete(role_id)?;
        }
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Ok(());
        }
        let occurred_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        for role_id in role_ids {
            let current = self
                .role_session_migration(role_id.clone())?
                .ok_or_else(role_session_launch_fence_not_ready)?;
            if current.platform != expected_platform {
                return Err(role_session_launch_fence_platform_mismatch());
            }
            if current.first_verified_launch_at.is_some() {
                continue;
            }
            if current.phase != crate::RoleSessionMigrationPhase::V23Ready {
                return Err(role_session_launch_fence_not_ready());
            }
            let expected_revision = current.journal_revision;
            let expected_committed_revision =
                expected_revision.checked_add(1).ok_or_else(|| {
                    crate::CoreError::Internal(
                        "role session launch fence revision is exhausted".to_owned(),
                    )
                })?;
            let transfer_id = current.transfer_id.clone();
            let committed = self.transition_role_session_migration_with_authority(
                crate::session_migration::TransitionAuthority::TargetRuntime { expected_platform },
                crate::RoleSessionMigrationTransitionInput {
                    role_id: role_id.clone(),
                    transfer_id: transfer_id.clone(),
                    transition_id: uuid::Uuid::new_v4().to_string(),
                    expected_phase: crate::RoleSessionMigrationPhase::V23Ready,
                    expected_journal_revision: expected_revision,
                    next_phase: crate::RoleSessionMigrationPhase::V23Ready,
                    target_revision: current.target_revision,
                    envelope_sha256: current.envelope_sha256.clone(),
                    inventory_sha256: current.inventory_sha256.clone(),
                    cookie_count: current.cookie_count,
                    local_storage_origin_count: current.local_storage_origin_count,
                    local_storage_entry_count: current.local_storage_entry_count,
                    stable_error_code: current.stable_error_code.clone(),
                    outcome: current.outcome,
                    clean_flush_receipt_id: current.clean_flush_receipt_id.clone(),
                    reset_receipt_id: current.reset_receipt_id.clone(),
                    mark_first_verified_launch: true,
                    occurred_at: occurred_at.clone(),
                },
            )?;
            if committed.role_id != *role_id
                || committed.transfer_id != transfer_id
                || committed.phase != crate::RoleSessionMigrationPhase::V23Ready
                || committed.journal_revision != expected_committed_revision
                || committed.first_verified_launch_at.as_deref() != Some(occurred_at.as_str())
            {
                return Err(crate::CoreError::Internal(
                    "role session launch fence commit was not exact".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// Stores a canonical secret-bearing inventory in the managed encrypted
    /// vault. This privileged shell boundary is intentionally separate from
    /// `CoreCommand` and renderer-facing shared contracts.
    pub fn write_role_session_transfer_vault_internal(
        &self,
        envelope_json: &[u8],
    ) -> CoreResult<crate::RoleSessionTransferJournalEvidence> {
        self.require_exact_v22_source_runtime()?;
        let envelope = crate::RoleSessionTransferEnvelopeRecord::from_json(envelope_json)?;
        let _vault_guard = self.session_transfer_vault_guard.lock().map_err(|_| {
            crate::CoreError::Internal("session-transfer vault lock poisoned".to_owned())
        })?;
        let journal = self
            .role_session_migration(envelope.metadata.role_id.clone())?
            .ok_or_else(session_transfer_vault_journal_not_found)?;
        crate::session_transfer::write_session_transfer_vault(
            &self.user_data_dir,
            self.platform,
            &journal,
            &envelope,
        )
    }

    /// Returns canonical plaintext only to the privileged shell caller after
    /// every encrypted-file and durable-journal fence has been verified.
    pub fn read_role_session_transfer_vault_internal(
        &self,
        role_id: String,
        transfer_id: String,
    ) -> CoreResult<Vec<u8>> {
        let _vault_guard = self.session_transfer_vault_guard.lock().map_err(|_| {
            crate::CoreError::Internal("session-transfer vault lock poisoned".to_owned())
        })?;
        let journal = self
            .role_session_migration(role_id)?
            .ok_or_else(session_transfer_vault_journal_not_found)?;
        if journal.transfer_id != transfer_id {
            return Err(session_transfer_vault_journal_identity_mismatch());
        }
        crate::session_transfer::read_session_transfer_vault(
            &self.user_data_dir,
            self.platform,
            &journal,
        )?
        .canonical_envelope_json()
    }

    /// Returns only authenticated hashes and inventory counts for a vault file
    /// durably published before its exact `v22Ready -> exported` journal CAS.
    /// Plaintext inventory bytes never cross this crash-resume boundary.
    pub fn pending_role_session_transfer_vault_evidence_internal(
        &self,
        role_id: String,
        transfer_id: String,
    ) -> CoreResult<Option<crate::RoleSessionTransferJournalEvidence>> {
        self.require_exact_v22_source_runtime()?;
        let _vault_guard = self.session_transfer_vault_guard.lock().map_err(|_| {
            crate::CoreError::Internal("session-transfer vault lock poisoned".to_owned())
        })?;
        let journal = self
            .role_session_migration(role_id)?
            .ok_or_else(session_transfer_vault_journal_not_found)?;
        if journal.transfer_id != transfer_id {
            return Err(session_transfer_vault_journal_identity_mismatch());
        }
        crate::session_transfer::pending_session_transfer_vault_evidence(
            &self.user_data_dir,
            self.platform,
            &journal,
        )
    }

    /// Verifies a committed encrypted vault against its durable exported
    /// journal and returns only authenticated hashes/counts.
    pub fn verified_role_session_transfer_vault_evidence_internal(
        &self,
        role_id: String,
        transfer_id: String,
    ) -> CoreResult<crate::RoleSessionTransferJournalEvidence> {
        self.require_exact_v22_source_runtime()?;
        let _vault_guard = self.session_transfer_vault_guard.lock().map_err(|_| {
            crate::CoreError::Internal("session-transfer vault lock poisoned".to_owned())
        })?;
        let journal = self
            .role_session_migration(role_id)?
            .ok_or_else(session_transfer_vault_journal_not_found)?;
        if journal.transfer_id != transfer_id {
            return Err(session_transfer_vault_journal_identity_mismatch());
        }
        crate::session_transfer::read_session_transfer_vault(
            &self.user_data_dir,
            self.platform,
            &journal,
        )?
        .journal_evidence()
    }

    fn validate_source_export_vault_evidence(
        &self,
        current: &crate::RoleSessionMigrationRecord,
        input: &crate::RoleSessionMigrationTransitionInput,
    ) -> CoreResult<()> {
        if current.transfer_id != input.transfer_id {
            return Err(session_transfer_vault_journal_identity_mismatch());
        }
        let evidence = match current.phase {
            crate::RoleSessionMigrationPhase::V22Ready => {
                crate::session_transfer::pending_session_transfer_vault_evidence(
                    &self.user_data_dir,
                    self.platform,
                    current,
                )?
                .ok_or_else(session_transfer_vault_evidence_missing)?
            }
            crate::RoleSessionMigrationPhase::Exported => {
                crate::session_transfer::read_session_transfer_vault(
                    &self.user_data_dir,
                    self.platform,
                    current,
                )?
                .journal_evidence()?
            }
            _ => return Ok(()),
        };
        if evidence.role_id != input.role_id
            || evidence.transfer_id != input.transfer_id
            || input.envelope_sha256.as_deref() != Some(evidence.envelope_sha256.as_str())
            || input.inventory_sha256.as_deref() != Some(evidence.inventory_sha256.as_str())
            || input.cookie_count != Some(evidence.cookie_count)
            || input.local_storage_origin_count != Some(evidence.local_storage_origin_count)
            || input.local_storage_entry_count != Some(evidence.local_storage_entry_count)
        {
            return Err(session_transfer_vault_evidence_mismatch());
        }
        Ok(())
    }
}

fn session_transfer_vault_journal_not_found() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_NOT_FOUND",
        message: "Session-transfer vault migration journal is not available.".to_owned(),
    }
}

fn session_transfer_vault_journal_identity_mismatch() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_IDENTITY_MISMATCH",
        message: "Session-transfer vault identity does not match its migration journal.".to_owned(),
    }
}

fn role_session_launch_fence_not_ready() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_LAUNCH_FENCE_NOT_READY",
        message: "The role session migration is not ready to admit Chromium navigation.".to_owned(),
    }
}

fn role_session_launch_fence_platform_mismatch() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
        message: "The ready role session journal does not match the active Chromium platform."
            .to_owned(),
    }
}

fn role_session_source_runtime_required() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        message: "Source migration authority requires the exact stable runtime contract v22."
            .to_owned(),
    }
}

fn role_session_source_identity_mismatch() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
        message: "The source migration platform and engine must match the active stable shell."
            .to_owned(),
    }
}

fn role_session_target_generic_transition_forbidden() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_TARGET_GENERIC_FORBIDDEN",
        message: "Chromium target migration success must use the dedicated Rust-owned boundary."
            .to_owned(),
    }
}

fn role_session_launch_fence_private() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_LAUNCH_FENCE_PRIVATE",
        message: "The first Chromium launch fence is owned by Core launch admission.".to_owned(),
    }
}

fn role_session_target_runtime_required() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_TARGET_RUNTIME_REQUIRED",
        message: "The dedicated target migration boundary requires runtime contract v23."
            .to_owned(),
    }
}

fn role_session_migration_not_found() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_MIGRATION_NOT_FOUND",
        message: "The role session migration journal is not available.".to_owned(),
    }
}

fn session_transfer_vault_evidence_missing() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_TRANSFER_VAULT_EVIDENCE_MISSING",
        message: "An authenticated session-transfer vault is required before export can commit."
            .to_owned(),
    }
}

fn session_transfer_vault_evidence_mismatch() -> crate::CoreError {
    crate::CoreError::Domain {
        code: "ROLE_SESSION_TRANSFER_VAULT_EVIDENCE_MISMATCH",
        message: "The requested export does not match the authenticated session-transfer vault."
            .to_owned(),
    }
}
