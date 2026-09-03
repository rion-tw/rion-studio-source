#[test]
fn generic_transition_binds_runtime_authority_and_platform_before_exact_replay() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let ready = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    let export = migration_export_transition("30000000-0000-4000-8000-000000000034");

    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            export.clone(),
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            export.clone(),
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(ready)
    );

    let exported = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        export.clone(),
    )
    .unwrap();
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            export.clone(),
        )
        .unwrap(),
        exported
    );
    for (authority_is_target, platform, expected_code) in [
        (
            true,
            crate::RoleSessionMigrationPlatform::Windows,
            "ROLE_SESSION_MIGRATION_TRANSITION_INVALID",
        ),
        (
            false,
            crate::RoleSessionMigrationPlatform::Macos,
            "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
        ),
    ] {
        let result = if authority_is_target {
            target_transition(&worker, platform, export.clone())
        } else {
            source_transition(&worker, platform, export.clone())
        };
        assert_eq!(result.unwrap_err().code(), expected_code);
        assert_eq!(
            worker
                .role_session_migration(MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            Some(exported.clone())
        );
    }

    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();
    let mut verify = migration_export_transition("30000000-0000-4000-8000-000000000035");
    verify.expected_phase = crate::RoleSessionMigrationPhase::Importing;
    verify.expected_journal_revision = importing.journal_revision;
    verify.next_phase = crate::RoleSessionMigrationPhase::Verifying;
    verify.target_revision = importing.target_revision;
    verify.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());

    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            verify.clone(),
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            verify.clone(),
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(importing)
    );

    let verifying = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        verify.clone(),
    )
    .unwrap();
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            verify.clone(),
        )
        .unwrap(),
        verifying
    );
    for (authority_is_source, platform, expected_code) in [
        (
            true,
            crate::RoleSessionMigrationPlatform::Windows,
            "ROLE_SESSION_MIGRATION_TRANSITION_INVALID",
        ),
        (
            false,
            crate::RoleSessionMigrationPlatform::Macos,
            "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
        ),
    ] {
        let result = if authority_is_source {
            source_transition(&worker, platform, verify.clone())
        } else {
            target_transition(&worker, platform, verify.clone())
        };
        assert_eq!(result.unwrap_err().code(), expected_code);
        assert_eq!(
            worker
                .role_session_migration(MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            Some(verifying.clone())
        );
    }
}
