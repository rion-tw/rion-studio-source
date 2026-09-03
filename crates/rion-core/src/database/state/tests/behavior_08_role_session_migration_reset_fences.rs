#[test]
fn v23_explicit_reset_cross_binds_role_operation_journal_and_receipt() {
    struct BrokenFence {
        label: &'static str,
        mutation_role_id: &'static str,
        evidence_role_id: &'static str,
        mutation_operation_id: &'static str,
        journal_operation_id: &'static str,
        journal_kind: &'static str,
        journal_phase: &'static str,
        payload_role_id: &'static str,
        receipt_operation_id: &'static str,
    }

    for case in [
        BrokenFence {
            label: "role",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: SECOND_MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-role",
            journal_operation_id: "reset-fence-role",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "quarantined",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-role",
        },
        BrokenFence {
            label: "operation",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-operation-request",
            journal_operation_id: "reset-fence-operation-journal",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "quarantined",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-operation-request",
        },
        BrokenFence {
            label: "kind",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-kind",
            journal_operation_id: "reset-fence-kind",
            journal_kind: "role_delete_v1",
            journal_phase: "quarantined",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-kind",
        },
        BrokenFence {
            label: "phase",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-phase",
            journal_operation_id: "reset-fence-phase",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "prepared",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-phase",
        },
        BrokenFence {
            label: "payload-role",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-payload-role",
            journal_operation_id: "reset-fence-payload-role",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "quarantined",
            payload_role_id: SECOND_MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-payload-role",
        },
        BrokenFence {
            label: "receipt",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-receipt",
            journal_operation_id: "reset-fence-receipt",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "quarantined",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "another-operation",
        },
        BrokenFence {
            label: "clean-receipt",
            mutation_role_id: MIGRATION_ROLE_ID,
            evidence_role_id: MIGRATION_ROLE_ID,
            mutation_operation_id: "reset-fence-clean-receipt",
            journal_operation_id: "reset-fence-clean-receipt",
            journal_kind: "role_browser_data_clear_v1",
            journal_phase: "quarantined",
            payload_role_id: MIGRATION_ROLE_ID,
            receipt_operation_id: "reset-fence-clean-receipt",
        },
    ] {
        let directory = tempdir().unwrap();
        let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
        seed_migration_roles(&worker);
        let first_role_before = worker
            .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
            .unwrap();
        let second_role_before = worker
            .read_record("roles".to_owned(), SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap();
        worker
            .put_operation_journal(OperationJournalRecord {
                id: case.journal_operation_id.to_owned(),
                kind: case.journal_kind.to_owned(),
                phase: case.journal_phase.to_owned(),
                payload: json!({
                    "roleId": case.payload_role_id,
                    "deferredByWindowsLock": false
                }),
            })
            .unwrap();
        let mut evidence = crate::session_migration::new_v23_explicit_reset_evidence(
            case.evidence_role_id.to_owned(),
            rion_platform::Platform::Macos,
            None,
            format!("chromium-session-clear:{}", case.label),
            format!("role-browser-clear:{}", case.receipt_operation_id),
        )
        .unwrap();
        if case.label == "clean-receipt" {
            evidence.clean_flush_receipt_id = "unbound-clear-receipt".to_owned();
        }

        let error = worker
            .mutate(StateMutation::RoleBrowserDataReset {
                id: case.mutation_role_id.to_owned(),
                operation_id: case.mutation_operation_id.to_owned(),
                expected_platform: crate::RoleSessionMigrationPlatform::Macos,
                v23_explicit_reset: Some(evidence),
            })
            .unwrap_err();
        assert_eq!(
            error.code(),
            "ROLE_SESSION_MIGRATION_EXPLICIT_RESET_FENCE_MISMATCH",
            "{}",
            case.label
        );
        assert!(worker.role_session_migrations().unwrap().is_empty());
        assert_eq!(
            worker
                .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            first_role_before,
            "{}",
            case.label
        );
        assert_eq!(
            worker
                .read_record("roles".to_owned(), SECOND_MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            second_role_before,
            "{}",
            case.label
        );
        assert_eq!(
            worker.operation_journals().unwrap()[0].phase,
            case.journal_phase,
            "{}",
            case.label
        );
    }
}

#[test]
fn first_v23_explicit_reset_binds_no_journal_evidence_to_immutable_platform() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let role_before = worker
        .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
        .unwrap();
    let operation_id = "reset-fence-opposite-platform";
    worker
        .put_operation_journal(OperationJournalRecord {
            id: operation_id.to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId": MIGRATION_ROLE_ID, "deferredByWindowsLock": false}),
        })
        .unwrap();
    let evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Windows,
        None,
        "chromium-session-clear:opposite-platform".to_owned(),
        format!("role-browser-clear:{operation_id}"),
    )
    .unwrap();

    let error = worker
        .mutate(StateMutation::RoleBrowserDataReset {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: operation_id.to_owned(),
            expected_platform: crate::RoleSessionMigrationPlatform::Macos,
            v23_explicit_reset: Some(evidence),
        })
        .unwrap_err();
    assert_eq!(
        error.code(),
        "ROLE_SESSION_MIGRATION_EXPLICIT_RESET_FENCE_MISMATCH"
    );
    assert!(worker.role_session_migrations().unwrap().is_empty());
    assert_eq!(
        worker
            .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        role_before
    );
    assert_eq!(worker.operation_journals().unwrap()[0].phase, "quarantined");
}

#[test]
fn v23_explicit_reset_preserves_the_legal_windows_deferred_clear_phase() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let operation_id = "reset-fence-windows-deferred";
    worker
        .put_operation_journal(OperationJournalRecord {
            id: operation_id.to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "deferred".to_owned(),
            payload: json!({"roleId": MIGRATION_ROLE_ID, "deferredByWindowsLock": true}),
        })
        .unwrap();
    let evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Windows,
        None,
        "chromium-session-clear:windows-deferred".to_owned(),
        format!("role-browser-clear:{operation_id}"),
    )
    .unwrap();

    worker
        .mutate(StateMutation::RoleBrowserDataReset {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: operation_id.to_owned(),
            expected_platform: crate::RoleSessionMigrationPlatform::Windows,
            v23_explicit_reset: Some(evidence),
        })
        .unwrap();
    let committed = worker
        .role_session_migration(MIGRATION_ROLE_ID.to_owned())
        .unwrap()
        .unwrap();
    assert_eq!(committed.phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(
        committed.outcome,
        Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
    );
    assert_eq!(worker.operation_journals().unwrap()[0].phase, "committed");
}

#[test]
fn first_v23_explicit_reset_requires_target_revision_one_atomically() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let role_before = worker
        .read_record("roles".to_owned(), SECOND_MIGRATION_ROLE_ID.to_owned())
        .unwrap();
    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-browser-clear-forged-first-target".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":SECOND_MIGRATION_ROLE_ID}),
        })
        .unwrap();
    let mut evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        SECOND_MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        None,
        "chromium-session-clear:forged-first-target".to_owned(),
        "role-browser-clear:role-browser-clear-forged-first-target".to_owned(),
    )
    .unwrap();
    evidence.target_revision = 2;

    assert!(
        worker
            .mutate(StateMutation::RoleBrowserDataReset {
                id: SECOND_MIGRATION_ROLE_ID.to_owned(),
                operation_id: "role-browser-clear-forged-first-target".to_owned(),
                expected_platform: crate::RoleSessionMigrationPlatform::Macos,
                v23_explicit_reset: Some(evidence),
            })
            .is_err()
    );
    assert!(
        worker
            .role_session_migration(SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        worker
            .read_record("roles".to_owned(), SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        role_before
    );
    assert_eq!(worker.operation_journals().unwrap()[0].phase, "quarantined");
}
