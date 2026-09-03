#[derive(Debug, Default)]
struct TestSessionTransferProtector;

impl SessionTransferProtector for TestSessionTransferProtector {
    fn protect(
        &self,
        _platform: rion_platform::Platform,
        context: &[u8],
        plaintext: &[u8],
    ) -> CoreResult<Vec<u8>> {
        let key = Sha256::digest(context);
        let mut encrypted = plaintext
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ key[index % key.len()])
            .collect::<Vec<_>>();
        let mut authentication_input = context.to_vec();
        authentication_input.extend_from_slice(plaintext);
        let authentication = Sha256::digest(authentication_input);
        let mut envelope = b"TEST".to_vec();
        envelope.extend_from_slice(&authentication);
        envelope.append(&mut encrypted);
        Ok(envelope)
    }

    fn unprotect(
        &self,
        _platform: rion_platform::Platform,
        context: &[u8],
        protected: &[u8],
    ) -> CoreResult<Vec<u8>> {
        let Some(payload) = protected.strip_prefix(b"TEST") else {
            return Err(vault_authentication_error());
        };
        if payload.len() <= 32 {
            return Err(vault_authentication_error());
        }
        let (authentication, encrypted) = payload.split_at(32);
        let key = Sha256::digest(context);
        let plaintext = encrypted
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ key[index % key.len()])
            .collect::<Vec<_>>();
        let mut authentication_input = context.to_vec();
        authentication_input.extend_from_slice(&plaintext);
        if Sha256::digest(authentication_input).as_slice() != authentication {
            return Err(vault_authentication_error());
        }
        Ok(plaintext)
    }
}

fn test_vault_journal(envelope: &RoleSessionTransferEnvelopeRecord) -> RoleSessionMigrationRecord {
    RoleSessionMigrationRecord {
        role_id: envelope.metadata.role_id.clone(),
        transfer_id: envelope.metadata.transfer_id.clone(),
        phase: RoleSessionMigrationPhase::V22Ready,
        journal_revision: 1,
        platform: envelope.metadata.platform,
        source_engine: envelope.metadata.source_engine,
        target_engine: envelope.metadata.target_engine,
        source_revision: envelope.metadata.source_revision,
        target_revision: None,
        envelope_sha256: None,
        inventory_sha256: None,
        cookie_count: None,
        local_storage_origin_count: None,
        local_storage_entry_count: None,
        stable_error_code: None,
        outcome: None,
        started_at: "2026-08-30T01:02:03Z".to_owned(),
        phase_changed_at: "2026-08-30T01:02:03Z".to_owned(),
        updated_at: "2026-08-30T01:02:03Z".to_owned(),
        outcome_at: None,
        first_verified_launch_at: None,
        clean_flush_receipt_id: None,
        reset_receipt_id: None,
    }
}

fn commit_test_vault_evidence(
    journal: &mut RoleSessionMigrationRecord,
    evidence: &RoleSessionTransferJournalEvidence,
) {
    journal.phase = RoleSessionMigrationPhase::Exported;
    journal.journal_revision += 1;
    journal.envelope_sha256 = Some(evidence.envelope_sha256.clone());
    journal.inventory_sha256 = Some(evidence.inventory_sha256.clone());
    journal.cookie_count = Some(evidence.cookie_count);
    journal.local_storage_origin_count = Some(evidence.local_storage_origin_count);
    journal.local_storage_entry_count = Some(evidence.local_storage_entry_count);
}

#[test]
fn vault_writes_only_the_fixed_managed_path_and_reads_committed_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let mut journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;

    let evidence = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    let expected_path = directory
        .path()
        .join(".session-migrations")
        .join(&journal.role_id)
        .join(&journal.transfer_id)
        .join("inventory.enc");
    assert!(expected_path.is_file());
    let canonical_json = envelope.canonical_envelope_json().unwrap();
    let protected = std::fs::read(&expected_path).unwrap();
    assert_ne!(protected, canonical_json);
    assert!(!protected.windows(7).any(|window| window == b"secret-"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&expected_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        for path in [
            directory.path().join(".session-migrations"),
            directory
                .path()
                .join(".session-migrations")
                .join(&journal.role_id),
            expected_path.parent().unwrap().to_path_buf(),
        ] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    commit_test_vault_evidence(&mut journal, &evidence);
    let read = read_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        true,
        &protector,
    )
    .unwrap();
    assert_eq!(read, envelope.canonicalized().unwrap());
    assert!(expected_path.is_file());
}

#[test]
fn same_transfer_replay_is_idempotent_but_conflicting_plaintext_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    let paths =
        session_transfer_vault_paths(directory.path(), &journal.role_id, &journal.transfer_id)
            .unwrap();

    let first = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    let original_file = std::fs::read(&paths.inventory_file).unwrap();
    let replay = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    assert_eq!(replay, first);
    assert_eq!(std::fs::read(&paths.inventory_file).unwrap(), original_file);

    let mut conflicting = envelope.clone();
    conflicting.inventory.cookies[0].value =
        RoleSessionTransferBytesRecord::from_bytes(b"conflicting-secret-value");
    let message = expect_error(
        write_session_transfer_vault_with(
            directory.path(),
            rion_platform::Platform::Macos,
            &journal,
            &conflicting,
            &protector,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_CONFLICT",
    );
    assert!(!message.contains("conflicting-secret-value"));
    assert_eq!(std::fs::read(&paths.inventory_file).unwrap(), original_file);
}

#[test]
fn read_requires_every_committed_digest_and_count_to_match() {
    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let mut journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    let evidence = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();

    let message = expect_error(
        read_session_transfer_vault_with(
            directory.path(),
            rion_platform::Platform::Macos,
            &journal,
            true,
            &protector,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_EVIDENCE_MISSING",
    );
    assert!(!message.contains("secret-two"));

    commit_test_vault_evidence(&mut journal, &evidence);
    journal.inventory_sha256 = Some("0".repeat(64));
    let message = expect_error(
        read_session_transfer_vault_with(
            directory.path(),
            rion_platform::Platform::Macos,
            &journal,
            true,
            &protector,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_EVIDENCE_MISMATCH",
    );
    assert!(!message.contains("secret-two"));
}

#[test]
fn context_and_envelope_identity_bind_platform_role_transfer_and_format_version() {
    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let macos =
        session_transfer_protection_context(rion_platform::Platform::Macos, &journal).unwrap();
    let windows =
        session_transfer_protection_context(rion_platform::Platform::Windows, &journal).unwrap();
    let context = String::from_utf8(macos.clone()).unwrap();
    assert!(context.contains("format=rion-role-session-transfer"));
    assert!(context.contains("version=1"));
    assert!(context.contains("platform=macos"));
    assert!(context.contains(&format!("role={}", journal.role_id)));
    assert!(context.contains(&format!("transfer={}", journal.transfer_id)));
    assert_ne!(macos, windows);

    let mut wrong_revision = envelope.clone();
    wrong_revision.metadata.source_revision += 1;
    let message = expect_error(
        validate_envelope_journal_identity(
            rion_platform::Platform::Macos,
            &journal,
            &wrong_revision,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_JOURNAL_IDENTITY_MISMATCH",
    );
    assert!(!message.contains(&journal.role_id));
}

#[test]
fn stale_crash_temp_is_cleaned_without_replacing_the_durable_inventory() {
    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    let paths =
        session_transfer_vault_paths(directory.path(), &journal.role_id, &journal.transfer_id)
            .unwrap();
    ensure_vault_directories(directory.path(), &paths).unwrap();
    let stale = paths
        .transfer_directory
        .join(".inventory.enc.55555555-5555-4555-8555-555555555555.tmp");
    std::fs::write(&stale, b"incomplete-crash-temp").unwrap();

    write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    assert!(paths.inventory_file.is_file());
    assert!(!stale.exists());
    let durable = std::fs::read(&paths.inventory_file).unwrap();
    std::fs::write(&stale, b"later-incomplete-crash-temp").unwrap();
    write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    assert!(!stale.exists());
    assert_eq!(std::fs::read(&paths.inventory_file).unwrap(), durable);
}

#[cfg(unix)]
#[test]
fn read_repairs_drifted_directory_permissions_before_plaintext_access() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let mut journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    let evidence = write_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        &envelope,
        &protector,
    )
    .unwrap();
    commit_test_vault_evidence(&mut journal, &evidence);
    let paths =
        session_transfer_vault_paths(directory.path(), &journal.role_id, &journal.transfer_id)
            .unwrap();
    std::fs::set_permissions(
        &paths.role_directory,
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    read_session_transfer_vault_with(
        directory.path(),
        rion_platform::Platform::Macos,
        &journal,
        true,
        &protector,
    )
    .unwrap();
    assert_eq!(
        std::fs::metadata(paths.role_directory)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[cfg(unix)]
#[test]
fn symlinked_vault_components_and_inventory_are_rejected() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let protector = TestSessionTransferProtector;
    symlink(outside.path(), directory.path().join(".session-migrations")).unwrap();
    expect_error(
        write_session_transfer_vault_with(
            directory.path(),
            rion_platform::Platform::Macos,
            &journal,
            &envelope,
            &protector,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_PATH_INVALID",
    );

    std::fs::remove_file(directory.path().join(".session-migrations")).unwrap();
    let paths =
        session_transfer_vault_paths(directory.path(), &journal.role_id, &journal.transfer_id)
            .unwrap();
    ensure_vault_directories(directory.path(), &paths).unwrap();
    let outside_file = outside.path().join("outside.enc");
    std::fs::write(&outside_file, b"protected-placeholder").unwrap();
    symlink(&outside_file, &paths.inventory_file).unwrap();
    expect_error(
        write_session_transfer_vault_with(
            directory.path(),
            rion_platform::Platform::Macos,
            &journal,
            &envelope,
            &protector,
        ),
        "ROLE_SESSION_TRANSFER_VAULT_FILE_INVALID",
    );
    assert_eq!(
        std::fs::read(&outside_file).unwrap(),
        b"protected-placeholder"
    );
}

#[test]
fn noncanonical_ids_and_oversized_sparse_files_fail_before_decryption() {
    let directory = tempfile::tempdir().unwrap();
    expect_error(
        session_transfer_vault_paths(
            directory.path(),
            "../role",
            "11111111-1111-4111-8111-111111111111",
        ),
        "ROLE_SESSION_TRANSFER_VAULT_PATH_INVALID",
    );

    let envelope = test_envelope();
    let journal = test_vault_journal(&envelope);
    let paths =
        session_transfer_vault_paths(directory.path(), &journal.role_id, &journal.transfer_id)
            .unwrap();
    ensure_vault_directories(directory.path(), &paths).unwrap();
    let file = std::fs::File::create(&paths.inventory_file).unwrap();
    file.set_len((rion_platform::SESSION_TRANSFER_V2_MAX_ENVELOPE_BYTES + 1) as u64)
        .unwrap();
    drop(file);
    restrict_file_permissions(&paths.inventory_file).unwrap();
    expect_error(
        read_protected_file(&paths.inventory_file),
        "ROLE_SESSION_TRANSFER_VAULT_SIZE_INVALID",
    );
}
