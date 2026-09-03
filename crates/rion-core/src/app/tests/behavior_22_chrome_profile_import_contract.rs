fn install_chromium_import_contract_fixture(
    directory: &tempfile::TempDir,
    core: &std::sync::Arc<AppCore>,
) -> (String, String, Vec<u8>) {
    let role_id = uuid::Uuid::new_v4().to_string();
    let transaction_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "cookies": [{
            "name": "session",
            "value": "secret-cookie",
            "path": "/",
            "secure": true,
            "httpOnly": true,
            "sameSite": "lax"
        }],
        "localStorage": [{ "key": "auth", "value": "secret-storage" }]
    });
    let plaintext = serde_json::to_vec(&payload).unwrap();
    let protected =
        crate::chrome_profile_import_contract::protect_legacy_for_test(&plaintext);
    let staging = crate::chrome_profile_import::session_transfer_directory(
        directory.path(),
        &transaction_id,
    )
    .unwrap();
    crate::chrome_profile_import::persist_encrypted_staging(&staging, &protected).unwrap();
    core.with_runtime(|runtime| {
        runtime.state.put_operation_journal(OperationJournalRecord {
            id: format!("chrome-profile-import-{transaction_id}"),
            kind: "chrome_profile_import_v2".to_owned(),
            phase: "prepared".to_owned(),
            payload: serde_json::json!({
                "importId": uuid::Uuid::new_v4().to_string(),
                "profileId": "Default",
                "roleId": role_id,
                "createdRole": true,
                "transactionId": transaction_id,
                "launchUrl": "https://game.example/play",
                "launchOrigin": "https://game.example",
                "replaceExisting": false,
                "runtimeContractVersion": 23,
                "sourceFingerprint": "source-fixture",
                "chromiumJournalRevision": 1,
                "stagingSha256": crate::chrome_profile_import_contract::sha256_hex(&protected),
                "stagingBytes": protected.len(),
                "cookieCount": 1,
                "localStorageCount": 1,
                "unsupported": {
                    "partitionedCookieCount": 2,
                    "appBoundCookieCount": 3,
                    "decryptFailureCount": 4,
                    "storageReadFailureCount": 5
                },
                "warnings": ["COOKIE_PARTITIONED_UNSUPPORTED"]
            }),
        })
    })
    .unwrap();
    (role_id, transaction_id, plaintext)
}

fn restart_chromium_import_core(
    directory: &tempfile::TempDir,
    runtime_contract_version: u32,
) -> std::sync::Arc<AppCore> {
    let core = std::sync::Arc::new(
        AppCore::create(AppCoreOptions {
            app_version: "2.1.0-test".to_owned(),
            build_commit: None,
            packaged: false,
            platform: "darwin".to_owned(),
            runtime_contract_version: Some(runtime_contract_version),
            user_data_dir: directory.path().to_string_lossy().into_owned(),
            performance_telemetry_path: None,
        })
        .unwrap(),
    );
    install_test_system_runtime_for_platform(&core, "darwin", supported_system_capabilities());
    core
}

fn chrome_import_fence(
    descriptor: &crate::ChromeProfileImportTransactionDescriptor,
) -> crate::ChromeProfileImportTransactionFence {
    crate::ChromeProfileImportTransactionFence {
        lease_id: descriptor.lease_id.clone(),
        role_id: descriptor.role_id.clone(),
        transaction_id: descriptor.transaction_id.clone(),
        expected_journal_phase: descriptor.journal_phase.clone(),
        expected_journal_revision: descriptor.journal_revision,
    }
}

fn install_fresh_verified_metadata_journal(
    core: &std::sync::Arc<AppCore>,
    role_id: &str,
) -> (String, String, String, String) {
    let transaction_id = uuid::Uuid::new_v4().to_string();
    let operation_id = format!("chrome-profile-import-{transaction_id}");
    let staging_sha256 = "a".repeat(64);
    let inventory_sha256 = "b".repeat(64);
    core.with_runtime(|runtime| {
        runtime.state.put_operation_journal(OperationJournalRecord {
            id: operation_id.clone(),
            kind: "chrome_profile_import_v2".to_owned(),
            phase: "freshVerified".to_owned(),
            payload: serde_json::json!({
                "roleId": role_id,
                "transactionId": transaction_id,
                "chromiumJournalRevision": 6,
                "stagingSha256": staging_sha256,
                "freshVerificationReceipt": {
                    "verifierInstanceId": uuid::Uuid::new_v4().to_string(),
                    "parentExitEvidenceSha256": "c".repeat(64),
                    "surfaceDrainEvidenceSha256": "d".repeat(64),
                    "chromiumPathSha256": "e".repeat(64),
                    "inventorySha256": inventory_sha256,
                    "cookieCount": 1,
                    "localStorageCount": 1
                }
            }),
        })
    })
    .unwrap();
    (
        transaction_id,
        operation_id,
        staging_sha256,
        inventory_sha256,
    )
}

fn chrome_profile_ready_evidence(
    role_id: &str,
    transaction_id: &str,
    staging_sha256: String,
    inventory_sha256: String,
) -> crate::session_migration::V23ChromeProfileImportReadyEvidence {
    crate::session_migration::V23ChromeProfileImportReadyEvidence {
        role_id: role_id.to_owned(),
        transaction_id: transaction_id.to_owned(),
        transition_id: uuid::Uuid::new_v4().to_string(),
        platform: crate::RoleSessionMigrationPlatform::Macos,
        staging_sha256,
        inventory_sha256,
        cookie_count: 1,
        local_storage_count: 1,
        occurred_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn unused_chrome_profile_role_input(core: &AppCore) -> crate::model::RoleCreateInputRecord {
    crate::model::RoleCreateInputRecord {
        game_id: flyff_game_id(core),
        name: "Chrome profile replacement metadata".to_owned(),
        launch_url: Some("https://game.example/play".to_owned()),
        notes: None,
        cover_image_data_url: None,
        cover_image_dominant_color: None,
    }
}

#[test]
fn chromium_import_contract_fences_pending_role_path_vault_and_fresh_process_commit() {
    let (directory, core) = core();
    let (role_id, transaction_id, plaintext) =
        install_chromium_import_contract_fixture(&directory, &core);

    assert!(core.invoke(CoreCommand::RolePathsResolve { id: role_id.clone() }).is_err());
    let descriptor = core
        .acquire_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionAcquireInput {
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "prepared".to_owned(),
                expected_journal_revision: 1,
                expected_launch_url: Some("https://game.example/play".to_owned()),
                expected_replace_existing: Some(false),
            },
        )
        .unwrap();
    assert_eq!(descriptor.role_id, role_id);
    assert_eq!(descriptor.transaction_id, transaction_id);
    assert_eq!(descriptor.cookie_count, 1);
    assert_eq!(descriptor.local_storage_count, 1);
    assert_eq!(descriptor.unsupported.partitioned_cookie_count, 2);
    assert!(descriptor
        .role_paths
        .chromium_user_data_dir
        .ends_with(&format!("roles/{role_id}/browser/chromium")));
    assert!(core
        .acquire_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionAcquireInput {
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "prepared".to_owned(),
                expected_journal_revision: 1,
                expected_launch_url: Some("https://game.example/play".to_owned()),
                expected_replace_existing: Some(false),
            },
        )
        .is_err());

    let source = core
        .read_chrome_profile_import_payload_internal(chrome_import_fence(&descriptor))
        .unwrap();
    let source_value: serde_json::Value = serde_json::from_slice(&source).unwrap();
    assert_eq!(source_value["cookies"][0]["value"], "secret-cookie");
    assert_eq!(source_value["localStorage"][0]["value"], "secret-storage");

    let empty_backup = serde_json::to_vec(&serde_json::json!({
        "cookies": [],
        "localStorage": []
    }))
    .unwrap();
    let backup_evidence = core
        .write_chrome_profile_import_backup_internal(
            chrome_import_fence(&descriptor),
            empty_backup,
        )
        .unwrap();
    assert_eq!(backup_evidence.cookie_count, 0);
    assert_eq!(backup_evidence.local_storage_count, 0);
    let mut restored_backup = core
        .read_chrome_profile_import_backup_internal(chrome_import_fence(&descriptor))
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&restored_backup).unwrap(),
        serde_json::json!({ "cookies": [], "localStorage": [] })
    );
    restored_backup.fill(0);

    let mut verified_journal = core
        .chrome_profile_import_journal(&role_id, &transaction_id)
        .unwrap();
    for phase in ["snapshotted", "applying", "verified"] {
        crate::chrome_profile_import_contract::advance_journal(&mut verified_journal, phase)
            .unwrap();
    }
    core.with_runtime(|runtime| runtime.state.put_operation_journal(verified_journal))
        .unwrap();
    let verified_descriptor = core
        .refresh_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionFence {
                lease_id: descriptor.lease_id.clone(),
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "verified".to_owned(),
                expected_journal_revision: 4,
            },
        )
        .unwrap();
    let capability = core
        .prepare_chrome_profile_import_fresh_verification_internal(chrome_import_fence(
            &verified_descriptor,
        ))
        .unwrap();
    assert_eq!(capability.len(), 32);
    let capability_sha256 =
        crate::chrome_profile_import_contract::capability_sha256(&capability).unwrap();
    let awaiting_journal = core
        .chrome_profile_import_journal(&role_id, &transaction_id)
        .unwrap();
    assert_eq!(awaiting_journal.phase, "awaitingFreshVerification");
    assert_eq!(
        awaiting_journal.payload["freshVerificationCapabilitySha256"],
        capability_sha256
    );
    assert!(!serde_json::to_vec(&awaiting_journal.payload)
        .unwrap()
        .windows(capability.len())
        .any(|window| window == capability.as_slice()));

    let awaiting_descriptor = core
        .refresh_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionFence {
                lease_id: descriptor.lease_id.clone(),
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "awaitingFreshVerification".to_owned(),
                expected_journal_revision: 5,
            },
        )
        .unwrap();
    let receipt = crate::ChromeProfileImportFreshVerificationReceipt {
        verifier_instance_id: uuid::Uuid::new_v4().to_string(),
        parent_exit_evidence_sha256: "a".repeat(64),
        surface_drain_evidence_sha256: "b".repeat(64),
        chromium_path_sha256: awaiting_descriptor.chromium_path_sha256.clone(),
        inventory_sha256: crate::chrome_profile_import_contract::sha256_hex(&source),
        cookie_count: 1,
        local_storage_count: 1,
    };
    let mut wrong_capability = capability.clone();
    wrong_capability[0] ^= 1;
    let wrong = core.complete_chrome_profile_import_fresh_verification_internal(
        chrome_import_fence(&awaiting_descriptor),
        wrong_capability,
        receipt.clone(),
    );
    assert_eq!(wrong.unwrap_err().code(), "CHROME_PROFILE_IMPORT_CAPABILITY_MISMATCH");
    assert_eq!(
        core.chrome_profile_import_journal(&role_id, &transaction_id)
            .unwrap()
            .phase,
        "awaitingFreshVerification"
    );

    let fresh_descriptor = core
        .complete_chrome_profile_import_fresh_verification_internal(
            chrome_import_fence(&awaiting_descriptor),
            capability.clone(),
            receipt,
        )
        .unwrap();
    assert_eq!(fresh_descriptor.journal_phase, "freshVerified");
    assert_eq!(fresh_descriptor.journal_revision, 6);
    let consumed_journal = core
        .chrome_profile_import_journal(&role_id, &transaction_id)
        .unwrap();
    assert!(consumed_journal
        .payload
        .get("freshVerificationCapabilitySha256")
        .is_none());
    assert!(core
        .complete_chrome_profile_import_fresh_verification_internal(
            chrome_import_fence(&awaiting_descriptor),
            capability,
            crate::ChromeProfileImportFreshVerificationReceipt {
                verifier_instance_id: uuid::Uuid::new_v4().to_string(),
                parent_exit_evidence_sha256: "a".repeat(64),
                surface_drain_evidence_sha256: "b".repeat(64),
                chromium_path_sha256: fresh_descriptor.chromium_path_sha256.clone(),
                inventory_sha256: crate::chrome_profile_import_contract::sha256_hex(&source),
                cookie_count: 1,
                local_storage_count: 1,
            },
        )
        .is_err());

    core.mutate_state(StateMutation::ChromeProfileImportMetadataCommit {
        id: role_id.clone(),
        input: crate::model::RoleCreateInputRecord {
            game_id: flyff_game_id(&core),
            name: "Imported Chrome Role".to_owned(),
            launch_url: Some("https://game.example/play".to_owned()),
            notes: None,
            cover_image_data_url: None,
            cover_image_dominant_color: None,
        },
        create_role: true,
        ready: crate::session_migration::V23ChromeProfileImportReadyEvidence {
            role_id: role_id.clone(),
            transaction_id: transaction_id.clone(),
            transition_id: uuid::Uuid::new_v4().to_string(),
            platform: crate::RoleSessionMigrationPlatform::Macos,
            staging_sha256: fresh_descriptor.staging_sha256.clone(),
            inventory_sha256: crate::chrome_profile_import_contract::sha256_hex(&source),
            cookie_count: 1,
            local_storage_count: 1,
            occurred_at: chrono::Utc::now().to_rfc3339(),
        },
        operation_id: format!("chrome-profile-import-{transaction_id}"),
        expected_journal_revision: 6,
    })
        .unwrap();
    let ready = serde_json::from_value::<Vec<crate::RoleSessionMigrationRecord>>(
        core.invoke(CoreCommand::RoleSessionMigrationsList).unwrap(),
    )
    .unwrap();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(ready[0].outcome, Some(crate::RoleSessionMigrationOutcome::Verified));
    let metadata_descriptor = core
        .refresh_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionFence {
                lease_id: descriptor.lease_id.clone(),
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "metadataCommitted".to_owned(),
                expected_journal_revision: 7,
            },
        )
        .unwrap();
    let commit_evidence = core
        .commit_chrome_profile_import_internal(chrome_import_fence(&metadata_descriptor))
        .unwrap();
    assert_eq!(commit_evidence.journal_phase, "committing");
    assert_eq!(commit_evidence.journal_revision, 8);
    let marker = directory
        .path()
        .join(".session-transfers")
        .join(&transaction_id)
        .join("committed");
    assert!(!std::fs::read(&marker).unwrap().is_empty());
    let committing_descriptor = core
        .refresh_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionFence {
                lease_id: descriptor.lease_id.clone(),
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "committing".to_owned(),
                expected_journal_revision: 8,
            },
        )
        .unwrap();
    assert_eq!(
        core.verify_chrome_profile_import_commit_marker_internal(chrome_import_fence(
            &committing_descriptor,
        ))
        .unwrap()
        .protected_sha256,
        commit_evidence.protected_sha256
    );
    let marker_bytes = std::fs::read(&marker).unwrap();
    let mut tampered_marker = marker_bytes.clone();
    *tampered_marker.last_mut().unwrap() ^= 1;
    std::fs::write(&marker, tampered_marker).unwrap();
    assert!(core
        .verify_chrome_profile_import_commit_marker_internal(chrome_import_fence(
            &committing_descriptor,
        ))
        .is_err());
    std::fs::write(&marker, marker_bytes).unwrap();
    core.release_chrome_profile_import_transaction_internal(
        crate::ChromeProfileImportTransactionReleaseInput {
            lease_id: descriptor.lease_id,
            role_id: role_id.clone(),
            transaction_id: transaction_id.clone(),
        },
    )
    .unwrap();
    core.shutdown();
    drop(core);
    let core = restart_chromium_import_core(&directory, 22);
    let (recovery, actions) = drive_chrome_import_recovery(std::sync::Arc::clone(&core), false);
    assert_eq!(recovery.unwrap(), serde_json::json!({ "recovered": 1, "pending": 0 }));
    assert!(actions.is_empty());
    assert!(core.invoke(CoreCommand::RoleGet { id: role_id }).is_ok());
    core.shutdown();
    drop(plaintext);
}

#[test]
fn metadata_rollback_deletes_only_transaction_created_unarmed_v23_ready_evidence() {
    let (_directory, core) = core();
    let role_id = create_role(&core, &flyff_game_id(&core), 1);
    let (transaction_id, operation_id, staging_sha256, inventory_sha256) =
        install_fresh_verified_metadata_journal(&core, &role_id);
    core.mutate_state(StateMutation::ChromeProfileImportMetadataCommit {
        id: role_id.clone(),
        input: unused_chrome_profile_role_input(&core),
        create_role: false,
        ready: chrome_profile_ready_evidence(
            &role_id,
            &transaction_id,
            staging_sha256,
            inventory_sha256,
        ),
        operation_id: operation_id.clone(),
        expected_journal_revision: 6,
    })
    .unwrap();
    let journal = core
        .chrome_profile_import_journal(&role_id, &transaction_id)
        .unwrap();
    assert_eq!(journal.payload["migrationEvidenceCreated"], true);
    assert!(serde_json::from_value::<Option<crate::RoleSessionMigrationRecord>>(
        core.invoke(CoreCommand::RoleSessionMigrationGet {
            role_id: role_id.clone(),
        })
        .unwrap(),
    )
    .unwrap()
    .is_some());

    let stale = core
        .mutate_state(StateMutation::ChromeProfileImportMetadataRollback {
            role_id: role_id.clone(),
            transaction_id: transaction_id.clone(),
            operation_id: operation_id.clone(),
            expected_journal_revision: 6,
        })
        .unwrap_err();
    assert_eq!(stale.code(), "CHROME_PROFILE_IMPORT_FENCE_MISMATCH");
    core.mutate_state(StateMutation::ChromeProfileImportMetadataRollback {
        role_id: role_id.clone(),
        transaction_id,
        operation_id,
        expected_journal_revision: 7,
    })
    .unwrap();
    assert!(serde_json::from_value::<Option<crate::RoleSessionMigrationRecord>>(
        core.invoke(CoreCommand::RoleSessionMigrationGet {
            role_id: role_id.clone(),
        })
        .unwrap(),
    )
    .unwrap()
    .is_none());
    assert!(core.invoke(CoreCommand::RoleGet { id: role_id }).is_ok());
    core.shutdown();
}

#[test]
fn replacement_metadata_commit_and_rollback_preserve_existing_v23_ready_row_exactly() {
    for armed in [false, true] {
        let (_directory, core) = core_for_platform_contract("darwin", 23);
        let role_id = create_role(&core, &flyff_game_id(&core), 1);
        if armed {
            core.mark_role_session_launch_admitted(std::slice::from_ref(&role_id))
                .unwrap();
        }
        let before = core.role_session_migration(role_id.clone()).unwrap().unwrap();
        assert_eq!(before.first_verified_launch_at.is_some(), armed);
        let (transaction_id, operation_id, staging_sha256, inventory_sha256) =
            install_fresh_verified_metadata_journal(&core, &role_id);

        core.mutate_state(StateMutation::ChromeProfileImportMetadataCommit {
            id: role_id.clone(),
            input: unused_chrome_profile_role_input(&core),
            create_role: false,
            ready: chrome_profile_ready_evidence(
                &role_id,
                &transaction_id,
                staging_sha256,
                inventory_sha256,
            ),
            operation_id: operation_id.clone(),
            expected_journal_revision: 6,
        })
        .unwrap();
        assert_eq!(core.role_session_migration(role_id.clone()).unwrap(), Some(before.clone()));
        let journal = core
            .chrome_profile_import_journal(&role_id, &transaction_id)
            .unwrap();
        assert_eq!(journal.payload["migrationEvidenceCreated"], false);

        core.mutate_state(StateMutation::ChromeProfileImportMetadataRollback {
            role_id: role_id.clone(),
            transaction_id,
            operation_id,
            expected_journal_revision: 7,
        })
        .unwrap();
        assert_eq!(core.role_session_migration(role_id).unwrap(), Some(before));
        core.shutdown();
    }
}

#[test]
fn metadata_rollback_rejects_deleting_a_transaction_created_row_after_launch_arm() {
    let (_directory, core) = core_for_platform_contract("darwin", 23);
    let role_id = uuid::Uuid::new_v4().to_string();
    core.mutate_state(StateMutation::RoleCreateWithId {
        id: role_id.clone(),
        input: unused_chrome_profile_role_input(&core),
    })
    .unwrap();
    let (transaction_id, operation_id, staging_sha256, inventory_sha256) =
        install_fresh_verified_metadata_journal(&core, &role_id);
    core.mutate_state(StateMutation::ChromeProfileImportMetadataCommit {
        id: role_id.clone(),
        input: unused_chrome_profile_role_input(&core),
        create_role: false,
        ready: chrome_profile_ready_evidence(
            &role_id,
            &transaction_id,
            staging_sha256,
            inventory_sha256,
        ),
        operation_id: operation_id.clone(),
        expected_journal_revision: 6,
    })
    .unwrap();
    let before_arm = core.role_session_migration(role_id.clone()).unwrap().unwrap();
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let armed = core
        .transition_role_session_migration_with_authority(
            crate::session_migration::TransitionAuthority::TargetRuntime {
                expected_platform: crate::RoleSessionMigrationPlatform::Macos,
            },
            crate::RoleSessionMigrationTransitionInput {
                role_id: role_id.clone(),
                transfer_id: before_arm.transfer_id.clone(),
                transition_id: uuid::Uuid::new_v4().to_string(),
                expected_phase: crate::RoleSessionMigrationPhase::V23Ready,
                expected_journal_revision: before_arm.journal_revision,
                next_phase: crate::RoleSessionMigrationPhase::V23Ready,
                target_revision: before_arm.target_revision,
                envelope_sha256: before_arm.envelope_sha256.clone(),
                inventory_sha256: before_arm.inventory_sha256.clone(),
                cookie_count: before_arm.cookie_count,
                local_storage_origin_count: before_arm.local_storage_origin_count,
                local_storage_entry_count: before_arm.local_storage_entry_count,
                stable_error_code: before_arm.stable_error_code.clone(),
                outcome: before_arm.outcome,
                clean_flush_receipt_id: before_arm.clean_flush_receipt_id.clone(),
                reset_receipt_id: before_arm.reset_receipt_id.clone(),
                mark_first_verified_launch: true,
                occurred_at,
            },
        )
        .unwrap();
    assert!(armed.first_verified_launch_at.is_some());

    let error = core
        .mutate_state(StateMutation::ChromeProfileImportMetadataRollback {
            role_id: role_id.clone(),
            transaction_id,
            operation_id,
            expected_journal_revision: 7,
        })
        .unwrap_err();
    assert_eq!(error.code(), "CHROME_PROFILE_IMPORT_FENCE_MISMATCH");
    assert_eq!(core.role_session_migration(role_id).unwrap(), Some(armed));
    core.shutdown();
}

#[test]
fn replacement_fails_before_helper_or_journal_when_v23_initialization_marker_is_missing_or_tampered()
{
    for corruption in ["missing", "tampered"] {
        let (directory, core) = core_for_platform_contract("darwin", 23);
        let source = directory.path().join(format!("chrome-source-{corruption}"));
        create_chrome_import_fixture(&source);
        let game_id = flyff_game_id(&core);
        let role_id = create_role(&core, &game_id, 1);
        let before = core.role_session_migration(role_id.clone()).unwrap().unwrap();
        assert_eq!(before.phase, crate::RoleSessionMigrationPhase::V23Ready);
        assert_eq!(
            before.outcome,
            Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
        );
        let marker = crate::v23_role_initialization::marker_path(directory.path(), &role_id);
        match corruption {
            "missing" => std::fs::remove_file(&marker).unwrap(),
            "tampered" => std::fs::write(&marker, b"{\"tampered\":true}").unwrap(),
            _ => unreachable!(),
        }
        let (import_id, profile_id) = preview_chrome_import(&core, &source);

        let (result, actions, _) = drive_async_command(
            std::sync::Arc::clone(&core),
            CoreCommand::ChromeProfileApply {
                import_id,
                game_id,
                consent_accepted: true,
                resolutions: vec![ChromeProfileImportResolutionRecord::Replace {
                    profile_id,
                    target_role_id: role_id.clone(),
                }],
            },
            None,
        );
        let result = result.unwrap();
        assert_eq!(result["items"][0]["status"], "failed", "{corruption}");
        assert_eq!(
            result["items"][0]["errorCode"],
            "ROLE_SESSION_MIGRATION_LAUNCH_FENCE_NOT_READY",
            "{corruption}"
        );
        assert!(actions.is_empty(), "{corruption}");
        assert!(core
            .with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .is_empty());
        assert_eq!(
            core.role_session_migration(role_id).unwrap(),
            Some(before),
            "{corruption}"
        );
        core.shutdown();
    }
}

#[test]
fn v23_recovery_keeps_a_journal_pending_when_the_exact_backup_is_missing() {
    let (directory, core) = core();
    let (_role_id, transaction_id, mut plaintext) =
        install_chromium_import_contract_fixture(&directory, &core);
    core.shutdown();
    drop(core);
    let core = restart_chromium_import_core(&directory, 22);
    let (result, actions) = drive_chrome_import_recovery(std::sync::Arc::clone(&core), false);
    assert_eq!(result.unwrap(), serde_json::json!({ "recovered": 0, "pending": 1 }));
    assert!(actions.is_empty());
    assert_eq!(
        core.with_runtime(|runtime| runtime.state.operation_journals())
            .unwrap()
            .len(),
        1
    );
    assert!(directory
        .path()
        .join(".session-transfers")
        .join(transaction_id)
        .join("session-transfer.enc")
        .is_file());
    plaintext.fill(0);
    core.shutdown();
}

#[test]
fn v23_recovery_after_restart_applies_only_the_exact_encrypted_backup_fence() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    let (role_id, transaction_id, mut plaintext) =
        install_chromium_import_contract_fixture(&directory, &core);
    let descriptor = core
        .acquire_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionAcquireInput {
                role_id: role_id.clone(),
                transaction_id: transaction_id.clone(),
                expected_journal_phase: "prepared".to_owned(),
                expected_journal_revision: 1,
                expected_launch_url: Some("https://game.example/play".to_owned()),
                expected_replace_existing: Some(false),
            },
        )
        .unwrap();
    core.write_chrome_profile_import_backup_internal(
        chrome_import_fence(&descriptor),
        plaintext.clone(),
    )
    .unwrap();
    let mut journal = core
        .chrome_profile_import_journal(&role_id, &transaction_id)
        .unwrap();
    for phase in ["snapshotted", "applying"] {
        crate::chrome_profile_import_contract::advance_journal(&mut journal, phase).unwrap();
    }
    core.with_runtime(|runtime| runtime.state.put_operation_journal(journal))
        .unwrap();
    core.release_chrome_profile_import_transaction_internal(
        crate::ChromeProfileImportTransactionReleaseInput {
            lease_id: descriptor.lease_id,
            role_id: role_id.clone(),
            transaction_id: transaction_id.clone(),
        },
    )
    .unwrap();
    core.shutdown();
    drop(core);

    let core = restart_chromium_import_core(&directory, 23);
    let (result, actions) = drive_chrome_import_recovery(std::sync::Arc::clone(&core), false);
    assert_eq!(result.unwrap(), serde_json::json!({ "recovered": 1, "pending": 0 }));
    assert!(actions.iter().any(|action| matches!(
        action,
        CoreEffectAction::ChromeProfileImportRollback {
            role_id: current_role,
            transaction_id: current_transaction,
            journal_phase: Some(phase),
            journal_revision: Some(3),
            chromium_user_data_dir: Some(path),
            ..
        } if current_role == &role_id
            && current_transaction == &transaction_id
            && phase == "applying"
            && path.ends_with(&format!("roles/{role_id}/browser/chromium"))
    )));
    assert!(core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap()
        .is_empty());
    assert!(!directory
        .path()
        .join(".session-transfers")
        .join(transaction_id)
        .exists());
    plaintext.fill(0);
    core.shutdown();
}

#[cfg(unix)]
#[test]
fn chromium_import_contract_rejects_pending_role_path_aliases_before_leasing() {
    use std::os::unix::fs::symlink;

    let (directory, core) = core();
    let (role_id, transaction_id, _) =
        install_chromium_import_contract_fixture(&directory, &core);
    let alias_target = directory.path().join("alias-target");
    std::fs::create_dir_all(&alias_target).unwrap();
    std::fs::create_dir_all(directory.path().join("roles")).unwrap();
    symlink(&alias_target, directory.path().join("roles").join(&role_id)).unwrap();

    let error = core
        .acquire_chrome_profile_import_transaction_internal(
            crate::ChromeProfileImportTransactionAcquireInput {
                role_id,
                transaction_id,
                expected_journal_phase: "prepared".to_owned(),
                expected_journal_revision: 1,
                expected_launch_url: Some("https://game.example/play".to_owned()),
                expected_replace_existing: Some(false),
            },
        )
        .unwrap_err();
    assert_eq!(
        error.code(),
        "CHROME_PROFILE_IMPORT_PATH_IDENTITY_MISMATCH"
    );
    core.shutdown();
}

#[test]
fn v23_chrome_import_saga_emits_event_bound_fences_and_commits_verified_role_atomically() {
    let (directory, core) = core_for_platform_contract("darwin", 23);
    let source = directory.path().join("chrome-source");
    create_chrome_import_fixture(&source);
    let game_id = flyff_game_id(&core);
    let (import_id, profile_id) = preview_chrome_import(&core, &source);
    let lane = std::sync::Arc::new(std::sync::Mutex::new(
        None::<crate::ChromeProfileImportTransactionDescriptor>,
    ));
    let lane_for_effects = std::sync::Arc::clone(&lane);
    let core_for_effects = std::sync::Arc::clone(&core);
    let (result, actions, _) = drive_async_command_with(
        std::sync::Arc::clone(&core),
        CoreCommand::ChromeProfileApply {
            import_id,
            game_id,
            consent_accepted: true,
            resolutions: vec![ChromeProfileImportResolutionRecord::Create { profile_id }],
        },
        move |effect| {
            assert_eq!(effect.completion_policy, crate::model::OperationCompletionPolicy::EventBound);
            assert!(effect.deadline_ms.is_none());
            let value_json = match &effect.action {
                CoreEffectAction::ChromeProfileImportSnapshot {
                    transaction_id,
                    role_id,
                    launch_url,
                    replace_existing,
                    chromium_user_data_dir: Some(chromium_path),
                    journal_phase: Some(phase),
                    journal_revision: Some(revision),
                    ..
                } => {
                    assert_eq!(phase, "prepared");
                    assert_eq!(*revision, 1);
                    let descriptor = core_for_effects
                        .acquire_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionAcquireInput {
                                role_id: role_id.clone(),
                                transaction_id: transaction_id.clone(),
                                expected_journal_phase: phase.clone(),
                                expected_journal_revision: *revision,
                                expected_launch_url: Some(launch_url.clone()),
                                expected_replace_existing: Some(*replace_existing),
                            },
                        )
                        .unwrap();
                    assert_eq!(&descriptor.role_paths.chromium_user_data_dir, chromium_path);
                    core_for_effects
                        .write_chrome_profile_import_backup_internal(
                            chrome_import_fence(&descriptor),
                            serde_json::to_vec(&serde_json::json!({
                                "cookies": [], "localStorage": []
                            }))
                            .unwrap(),
                        )
                        .unwrap();
                    *lane_for_effects.lock().unwrap() = Some(descriptor);
                    None
                }
                CoreEffectAction::ChromeProfileImportApply {
                    journal_phase: Some(phase),
                    journal_revision: Some(revision),
                    ..
                } => {
                    assert_eq!(phase, "applying");
                    assert_eq!(*revision, 3);
                    let current = lane_for_effects.lock().unwrap().clone().unwrap();
                    let next = core_for_effects
                        .refresh_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionFence {
                                lease_id: current.lease_id,
                                role_id: current.role_id,
                                transaction_id: current.transaction_id,
                                expected_journal_phase: phase.clone(),
                                expected_journal_revision: *revision,
                            },
                        )
                        .unwrap();
                    *lane_for_effects.lock().unwrap() = Some(next);
                    None
                }
                CoreEffectAction::ChromeProfileImportVerify {
                    journal_phase: Some(phase),
                    journal_revision: Some(revision),
                    ..
                } => {
                    assert_eq!(phase, "verified");
                    assert_eq!(*revision, 4);
                    let current = lane_for_effects.lock().unwrap().clone().unwrap();
                    let verified = core_for_effects
                        .refresh_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionFence {
                                lease_id: current.lease_id,
                                role_id: current.role_id,
                                transaction_id: current.transaction_id,
                                expected_journal_phase: phase.clone(),
                                expected_journal_revision: *revision,
                            },
                        )
                        .unwrap();
                    let capability = core_for_effects
                        .prepare_chrome_profile_import_fresh_verification_internal(
                            chrome_import_fence(&verified),
                        )
                        .unwrap();
                    let awaiting = core_for_effects
                        .refresh_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionFence {
                                lease_id: verified.lease_id.clone(),
                                role_id: verified.role_id.clone(),
                                transaction_id: verified.transaction_id.clone(),
                                expected_journal_phase: "awaitingFreshVerification".to_owned(),
                                expected_journal_revision: 5,
                            },
                        )
                        .unwrap();
                    let mut source = core_for_effects
                        .read_chrome_profile_import_payload_internal(chrome_import_fence(&awaiting))
                        .unwrap();
                    let inventory_sha256 =
                        crate::chrome_profile_import_contract::sha256_hex(&source);
                    source.fill(0);
                    let fresh = core_for_effects
                        .complete_chrome_profile_import_fresh_verification_internal(
                            chrome_import_fence(&awaiting),
                            capability,
                            crate::ChromeProfileImportFreshVerificationReceipt {
                                verifier_instance_id: uuid::Uuid::new_v4().to_string(),
                                parent_exit_evidence_sha256: "a".repeat(64),
                                surface_drain_evidence_sha256: "b".repeat(64),
                                chromium_path_sha256: awaiting.chromium_path_sha256.clone(),
                                inventory_sha256,
                                cookie_count: awaiting.cookie_count,
                                local_storage_count: awaiting.local_storage_count,
                            },
                        )
                        .unwrap();
                    *lane_for_effects.lock().unwrap() = Some(fresh);
                    Some(serde_json::json!({ "authState": "notApplicable" }).to_string())
                }
                CoreEffectAction::ChromeProfileImportCommit {
                    journal_phase: Some(phase),
                    journal_revision: Some(revision),
                    ..
                } => {
                    assert_eq!(phase, "metadataCommitted");
                    assert_eq!(*revision, 7);
                    let current = lane_for_effects.lock().unwrap().clone().unwrap();
                    let metadata = core_for_effects
                        .refresh_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionFence {
                                lease_id: current.lease_id,
                                role_id: current.role_id,
                                transaction_id: current.transaction_id,
                                expected_journal_phase: phase.clone(),
                                expected_journal_revision: *revision,
                            },
                        )
                        .unwrap();
                    core_for_effects
                        .commit_chrome_profile_import_internal(chrome_import_fence(&metadata))
                        .unwrap();
                    let committing = core_for_effects
                        .refresh_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionFence {
                                lease_id: metadata.lease_id.clone(),
                                role_id: metadata.role_id.clone(),
                                transaction_id: metadata.transaction_id.clone(),
                                expected_journal_phase: "committing".to_owned(),
                                expected_journal_revision: 8,
                            },
                        )
                        .unwrap();
                    core_for_effects
                        .verify_chrome_profile_import_commit_marker_internal(
                            chrome_import_fence(&committing),
                        )
                        .unwrap();
                    core_for_effects
                        .release_chrome_profile_import_transaction_internal(
                            crate::ChromeProfileImportTransactionReleaseInput {
                                lease_id: committing.lease_id,
                                role_id: committing.role_id,
                                transaction_id: committing.transaction_id,
                            },
                        )
                        .unwrap();
                    None
                }
                action => panic!("unexpected v23 Chrome-import effect: {action:?}"),
            };
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: true,
                value_json,
                error: None,
            }
        },
    );
    let result = result.unwrap();
    assert_eq!(
        result["items"][0]["status"],
        "imported",
        "result={result:?}; actions={actions:?}"
    );
    assert_eq!(actions.len(), 4);
    let role_id = result["items"][0]["roleId"].as_str().unwrap();
    let migration = serde_json::from_value::<Option<crate::RoleSessionMigrationRecord>>(
        core.invoke(CoreCommand::RoleSessionMigrationGet {
            role_id: role_id.to_owned(),
        })
        .unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(migration.phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(migration.outcome, Some(crate::RoleSessionMigrationOutcome::Verified));
    core.shutdown();
}

#[test]
fn chrome_import_journal_rejects_phase_skips_backtracks_and_revision_reuse() {
    let mut journal = OperationJournalRecord {
        id: "chrome-profile-import-test".to_owned(),
        kind: "chrome_profile_import_v2".to_owned(),
        phase: "prepared".to_owned(),
        payload: serde_json::json!({ "chromiumJournalRevision": 1 }),
    };
    assert_eq!(
        crate::chrome_profile_import_contract::advance_journal(&mut journal, "applying")
            .unwrap_err()
            .code(),
        "CHROME_PROFILE_IMPORT_FENCE_MISMATCH"
    );
    assert_eq!(journal.phase, "prepared");
    assert_eq!(journal.payload["chromiumJournalRevision"], 1);
    crate::chrome_profile_import_contract::advance_journal(&mut journal, "snapshotted")
        .unwrap();
    assert!(crate::chrome_profile_import_contract::advance_journal(
        &mut journal,
        "prepared"
    )
    .is_err());
    assert!(crate::chrome_profile_import_contract::advance_journal(
        &mut journal,
        "metadataCommitted"
    )
    .is_err());
    assert_eq!(journal.phase, "snapshotted");
    assert_eq!(journal.payload["chromiumJournalRevision"], 2);
}
