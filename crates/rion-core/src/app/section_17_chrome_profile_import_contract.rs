impl AppCore {
    /// Opens a process-local exclusive lease over one exact Chrome-import
    /// transaction. This privileged boundary is never reachable through
    /// `CoreCommand` or the renderer bridge.
    pub fn acquire_chrome_profile_import_transaction_internal(
        &self,
        input: crate::ChromeProfileImportTransactionAcquireInput,
    ) -> CoreResult<crate::ChromeProfileImportTransactionDescriptor> {
        let journal = self.chrome_profile_import_journal(&input.role_id, &input.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        crate::chrome_profile_import_contract::validate_acquire_assertions(&input, &identity)?;
        let mut runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        let lease_id = runtime.acquire(&identity)?;
        Ok(crate::chrome_profile_import_contract::descriptor(
            lease_id, &identity,
        ))
    }

    pub fn refresh_chrome_profile_import_transaction_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<crate::ChromeProfileImportTransactionDescriptor> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        Ok(crate::chrome_profile_import_contract::descriptor(
            fence.lease_id,
            &identity,
        ))
    }

    /// Decrypts a bounded source payload only after the lease, journal,
    /// destination path, and encrypted staging digest all match exactly.
    pub fn read_chrome_profile_import_payload_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<Vec<u8>> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        crate::chrome_profile_import_contract::read_staging_payload(
            &self.user_data_dir,
            self.platform,
            &identity,
        )
    }

    /// Consumes a plaintext rollback inventory from the privileged Chromium
    /// main-process adapter, validates
    /// its launch-origin scope, encrypts it with transaction-bound RSP2
    /// protection, and atomically publishes `backup.enc`.
    pub fn write_chrome_profile_import_backup_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
        mut plaintext: Vec<u8>,
    ) -> CoreResult<crate::ChromeProfileImportVaultEvidence> {
        let result = (|| {
            let journal =
                self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
            let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
                &self.user_data_dir,
                &journal,
            )?;
            let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
                CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
            })?;
            runtime.assert_fence(&fence, &identity)?;
            if identity.journal_phase != "prepared" {
                return Err(CoreError::Domain {
                    code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                    message:
                        "The rollback snapshot can only be written in the prepared phase."
                            .to_owned(),
                });
            }
            crate::chrome_profile_import_contract::write_backup(
                &self.user_data_dir,
                self.platform,
                &identity,
                &mut plaintext,
            )
        })();
        plaintext.fill(0);
        result
    }

    pub fn read_chrome_profile_import_backup_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<Vec<u8>> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        crate::chrome_profile_import_contract::read_backup(
            &self.user_data_dir,
            self.platform,
            &identity,
        )
    }

    /// Moves the Chrome-import journal to `awaitingFreshVerification` with a
    /// 256-bit OS-CSPRNG capability. Only its SHA-256 digest is persisted.
    pub fn prepare_chrome_profile_import_fresh_verification_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<Vec<u8>> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        if identity.journal_phase != "verified" {
            return Err(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                message: "Fresh-process verification cannot begin from this journal phase."
                    .to_owned(),
            });
        }
        let mut backup = crate::chrome_profile_import_contract::read_backup(
            &self.user_data_dir,
            self.platform,
            &identity,
        )?;
        backup.fill(0);
        let mut capability =
            crate::chrome_profile_import_contract::new_fresh_verification_capability()?;
        let capability_sha256 =
            crate::chrome_profile_import_contract::capability_sha256(&capability)?;
        let transition = self.with_runtime(|runtime| {
            runtime.state.transition_chrome_profile_import_journal(
                crate::chrome_profile_import_contract::ChromeProfileImportJournalTransitionInput {
                    operation_id: identity.operation_id.clone(),
                    role_id: identity.role_id.clone(),
                    transaction_id: identity.transaction_id.clone(),
                    expected_phase: identity.journal_phase.clone(),
                    expected_revision: identity.journal_revision,
                    transition: crate::chrome_profile_import_contract::ChromeProfileImportJournalTransition::AwaitFreshVerification {
                        capability_sha256,
                    },
                },
            )
        });
        if let Err(error) = transition {
            capability.fill(0);
            return Err(error);
        }
        Ok(capability)
    }

    /// Constant-time capability validation, capability consumption, revision
    /// CAS, and the `awaitingFreshVerification -> freshVerified` transition all
    /// occur inside one SQLite transaction.
    pub fn complete_chrome_profile_import_fresh_verification_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
        capability: Vec<u8>,
        receipt: crate::ChromeProfileImportFreshVerificationReceipt,
    ) -> CoreResult<crate::ChromeProfileImportTransactionDescriptor> {
        let capability = crate::chrome_profile_import_contract::SecretBytes::new(capability);
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        if identity.journal_phase != "awaitingFreshVerification" {
            return Err(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                message: "The transaction is not awaiting fresh-process verification."
                    .to_owned(),
            });
        }
        let mut staging = crate::chrome_profile_import_contract::read_staging_payload(
            &self.user_data_dir,
            self.platform,
            &identity,
        )?;
        let inventory_sha256 = crate::chrome_profile_import_contract::sha256_hex(&staging);
        staging.fill(0);
        crate::chrome_profile_import_contract::validate_fresh_receipt(
            &receipt,
            &identity,
            &inventory_sha256,
        )?;
        let next = self.with_runtime(|runtime| {
            runtime.state.transition_chrome_profile_import_journal(
                crate::chrome_profile_import_contract::ChromeProfileImportJournalTransitionInput {
                    operation_id: identity.operation_id.clone(),
                    role_id: identity.role_id.clone(),
                    transaction_id: identity.transaction_id.clone(),
                    expected_phase: identity.journal_phase.clone(),
                    expected_revision: identity.journal_revision,
                    transition: crate::chrome_profile_import_contract::ChromeProfileImportJournalTransition::CompleteFreshVerification {
                        capability,
                        receipt,
                    },
                },
            )
        })?;
        let next_identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &next,
        )?;
        Ok(crate::chrome_profile_import_contract::descriptor(
            fence.lease_id,
            &next_identity,
        ))
    }

    /// Fences the exact `metadataCommitted` revision, persists the intended marker
    /// digest in the journal, and only then atomically publishes an
    /// authenticated commit marker. A crash before publication remains a
    /// rollback candidate; elapsed time never becomes success.
    pub fn commit_chrome_profile_import_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<crate::ChromeProfileImportVaultEvidence> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        if identity.journal_phase != "metadataCommitted" {
            return Err(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_FENCE_MISMATCH",
                message: "The Chrome profile import metadata has not been committed.".to_owned(),
            });
        }
        let mut staging = crate::chrome_profile_import_contract::read_staging_payload(
            &self.user_data_dir,
            self.platform,
            &identity,
        )?;
        let inventory_sha256 = crate::chrome_profile_import_contract::sha256_hex(&staging);
        staging.fill(0);
        let (protected_marker, marker_sha256) =
            crate::chrome_profile_import_contract::prepare_commit_marker(
                self.platform,
                &identity,
                inventory_sha256,
            )?;
        let next = self.with_runtime(|runtime| {
            runtime.state.transition_chrome_profile_import_journal(
                crate::chrome_profile_import_contract::ChromeProfileImportJournalTransitionInput {
                    operation_id: identity.operation_id.clone(),
                    role_id: identity.role_id.clone(),
                    transaction_id: identity.transaction_id.clone(),
                    expected_phase: identity.journal_phase.clone(),
                    expected_revision: identity.journal_revision,
                    transition: crate::chrome_profile_import_contract::ChromeProfileImportJournalTransition::BeginCommit {
                        marker_sha256,
                    },
                },
            )
        })?;
        let next_identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &next,
        )?;
        crate::chrome_profile_import_contract::write_prepared_commit_marker(
            &self.user_data_dir,
            &next_identity,
            &protected_marker,
        )?;
        crate::chrome_profile_import_contract::verify_commit_marker(
            &self.user_data_dir,
            self.platform,
            &next_identity,
        )
    }

    pub fn verify_chrome_profile_import_commit_marker_internal(
        &self,
        fence: crate::ChromeProfileImportTransactionFence,
    ) -> CoreResult<crate::ChromeProfileImportVaultEvidence> {
        let journal = self.chrome_profile_import_journal(&fence.role_id, &fence.transaction_id)?;
        let identity = crate::chrome_profile_import_contract::resolve_transaction_identity(
            &self.user_data_dir,
            &journal,
        )?;
        let runtime = self.chrome_profile_import_contract.lock().map_err(|_| {
            CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
        })?;
        runtime.assert_fence(&fence, &identity)?;
        let evidence = crate::chrome_profile_import_contract::verify_commit_marker(
            &self.user_data_dir,
            self.platform,
            &identity,
        )?;
        if crate::chrome_profile_import_contract::journal_marker_sha256(&journal)?
            != evidence.protected_sha256
        {
            return Err(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_COMMIT_AUTHENTICATION_FAILED",
                message: "The commit marker does not match its exact journal revision."
                    .to_owned(),
            });
        }
        Ok(evidence)
    }

    pub fn release_chrome_profile_import_transaction_internal(
        &self,
        input: crate::ChromeProfileImportTransactionReleaseInput,
    ) -> CoreResult<()> {
        self.chrome_profile_import_contract
            .lock()
            .map_err(|_| {
                CoreError::Internal("Chrome profile import contract lock poisoned".to_owned())
            })?
            .release(&input)
    }

    fn chrome_profile_import_journal(
        &self,
        role_id: &str,
        transaction_id: &str,
    ) -> CoreResult<OperationJournalRecord> {
        let mut matches = self
            .with_runtime(|runtime| runtime.state.operation_journals())?
            .into_iter()
            .filter(|journal| {
                journal.kind == "chrome_profile_import_v2"
                    && journal.payload.get("roleId").and_then(Value::as_str) == Some(role_id)
                    && journal
                        .payload
                        .get("transactionId")
                        .and_then(Value::as_str)
                        == Some(transaction_id)
            });
        let journal = matches.next().ok_or_else(|| CoreError::Domain {
            code: "CHROME_PROFILE_IMPORT_JOURNAL_NOT_FOUND",
            message: "The Chrome profile import transaction journal is unavailable.".to_owned(),
        })?;
        if matches.next().is_some() {
            return Err(CoreError::Domain {
                code: "CHROME_PROFILE_IMPORT_JOURNAL_AMBIGUOUS",
                message: "More than one Chrome profile import journal claims this transaction."
                    .to_owned(),
            });
        }
        Ok(journal)
    }
}
