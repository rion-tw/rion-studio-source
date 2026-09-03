const MIGRATION_ROLE_ID: &str = "10000000-0000-4000-8000-000000000001";
const SECOND_MIGRATION_ROLE_ID: &str = "10000000-0000-4000-8000-000000000002";
const MIGRATION_TRANSFER_ID: &str = "20000000-0000-4000-8000-000000000001";
const SECOND_MIGRATION_TRANSFER_ID: &str = "20000000-0000-4000-8000-000000000002";
const V23_CREATED_ROLE_ID: &str = "10000000-0000-4000-8000-000000000003";
const V23_ROLLBACK_ROLE_ID: &str = "10000000-0000-4000-8000-000000000004";
const V23_INITIALIZATION_TRANSFER_ID: &str = "20000000-0000-4000-8000-000000000003";
const ENVELOPE_SHA256: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INVENTORY_SHA256: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FRESH_FLUSH_RECEIPT: &str = concat!(
    "chromium-session-fresh:",
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
);
const OTHER_FRESH_FLUSH_RECEIPT: &str = concat!(
    "chromium-session-fresh:",
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
);
const CHROMIUM_RUNTIME_CONTRACT_VERSION: u32 = 23;

fn migration_start_input(
    role_id: &str,
    transfer_id: &str,
    platform: crate::RoleSessionMigrationPlatform,
) -> crate::RoleSessionMigrationStartInput {
    crate::RoleSessionMigrationStartInput {
        role_id: role_id.to_owned(),
        transfer_id: transfer_id.to_owned(),
        platform,
        source_engine: match platform {
            crate::RoleSessionMigrationPlatform::Macos => {
                crate::RoleSessionMigrationEngine::Wkwebview
            }
            crate::RoleSessionMigrationPlatform::Windows => {
                crate::RoleSessionMigrationEngine::Webview2
            }
        },
        target_engine: crate::RoleSessionMigrationEngine::Chromium,
        source_revision: 41,
    }
}

fn migration_transition(
    transition_id: &str,
    expected_phase: crate::RoleSessionMigrationPhase,
    expected_journal_revision: u64,
    next_phase: crate::RoleSessionMigrationPhase,
    occurred_at: &str,
) -> crate::RoleSessionMigrationTransitionInput {
    crate::RoleSessionMigrationTransitionInput {
        role_id: MIGRATION_ROLE_ID.to_owned(),
        transfer_id: MIGRATION_TRANSFER_ID.to_owned(),
        transition_id: transition_id.to_owned(),
        expected_phase,
        expected_journal_revision,
        next_phase,
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
        occurred_at: occurred_at.to_owned(),
    }
}

fn migration_export_transition(transition_id: &str) -> crate::RoleSessionMigrationTransitionInput {
    let mut input = migration_transition(
        transition_id,
        crate::RoleSessionMigrationPhase::V22Ready,
        1,
        crate::RoleSessionMigrationPhase::Exported,
        "2026-08-30T02:00:01Z",
    );
    input.envelope_sha256 = Some(ENVELOPE_SHA256.to_owned());
    input.inventory_sha256 = Some(INVENTORY_SHA256.to_owned());
    input.cookie_count = Some(17);
    input.local_storage_origin_count = Some(3);
    input.local_storage_entry_count = Some(11);
    input
}

fn migration_import_begin_input() -> crate::RoleSessionMigrationImportBeginInput {
    crate::RoleSessionMigrationImportBeginInput {
        role_id: MIGRATION_ROLE_ID.to_owned(),
        transfer_id: MIGRATION_TRANSFER_ID.to_owned(),
        expected_journal_revision: 2,
    }
}

fn source_transition(
    worker: &StateDatabaseWorker,
    platform: crate::RoleSessionMigrationPlatform,
    input: crate::RoleSessionMigrationTransitionInput,
) -> crate::CoreResult<crate::RoleSessionMigrationRecord> {
    worker.transition_role_session_migration(
        crate::session_migration::TransitionAuthority::SourceRuntime {
            expected_platform: platform,
        },
        input,
    )
}

fn target_transition(
    worker: &StateDatabaseWorker,
    platform: crate::RoleSessionMigrationPlatform,
    input: crate::RoleSessionMigrationTransitionInput,
) -> crate::CoreResult<crate::RoleSessionMigrationRecord> {
    worker.transition_role_session_migration(
        crate::session_migration::TransitionAuthority::TargetRuntime {
            expected_platform: platform,
        },
        input,
    )
}

fn seed_migration_roles(worker: &StateDatabaseWorker) {
    worker
        .replace_snapshot(json!({
            "games": [{
                "id":"migration-game","source":"custom","name":"Migration Game",
                "defaultLaunchUrl":"https://example.test/play","browserLaunchMode":"inherit",
                "createdAt":"2026-08-30T00:00:00Z","updatedAt":"2026-08-30T00:00:00Z"
            }],
            "roles": [
                {
                    "id":MIGRATION_ROLE_ID,"gameId":"migration-game","name":"Role One",
                    "launchUrl":"https://example.test/play","notes":"",
                    "browserSessionSource":"embedded",
                    "createdAt":"2026-08-30T00:00:00Z","updatedAt":"2026-08-30T00:00:00Z"
                },
                {
                    "id":SECOND_MIGRATION_ROLE_ID,"gameId":"migration-game","name":"Role Two",
                    "launchUrl":"https://example.test/play","notes":"",
                    "browserSessionSource":"embedded",
                    "createdAt":"2026-08-30T00:00:00Z","updatedAt":"2026-08-30T00:00:00Z"
                }
            ],
            "launchWorkspaces": [],
            "gameWindows": [],
            "macros": []
        }))
        .unwrap();
}

fn v23_initialization(
    role_id: &str,
    transfer_id: &str,
) -> crate::session_migration::V23RoleInitializationEvidence {
    let transition_id = "30000000-0000-4000-8000-000000000010".to_owned();
    crate::session_migration::V23RoleInitializationEvidence {
        role_id: role_id.to_owned(),
        transfer_id: transfer_id.to_owned(),
        clean_flush_receipt_id: format!("v23-empty-store:{transition_id}"),
        reset_receipt_id: format!("v23-role-create:{transition_id}"),
        transition_id,
        platform: crate::RoleSessionMigrationPlatform::Windows,
        source_engine: crate::RoleSessionMigrationEngine::Webview2,
        target_engine: crate::RoleSessionMigrationEngine::Chromium,
        source_revision: 0,
        target_revision: 0,
        occurred_at: "2026-08-30T03:30:00.000Z".to_owned(),
    }
}

fn v23_role_input(name: &str) -> crate::model::RoleCreateInputRecord {
    crate::model::RoleCreateInputRecord {
        game_id: "migration-game".to_owned(),
        name: name.to_owned(),
        launch_url: Some("https://example.test/play".to_owned()),
        notes: None,
        cover_image_data_url: None,
        cover_image_dominant_color: None,
    }
}

#[test]
fn schema_twenty_eight_adds_the_typed_role_session_migration_table_atomically() {
    let connection = Connection::open_in_memory().unwrap();
    create_schema(&connection, false).unwrap();
    connection
        .execute_batch(
            "DROP TABLE role_session_migrations;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (28, 'current');",
        )
        .unwrap();

    create_schema(&connection, false).unwrap();

    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        29
    );
    let columns = connection
        .prepare("PRAGMA table_info(role_session_migrations)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.contains(&"journal_revision".to_owned()));
    assert!(columns.contains(&"envelope_sha256".to_owned()));
    assert!(columns.contains(&"inventory_sha256".to_owned()));
    assert!(!columns.iter().any(|column| column == "payload_json"));
    assert!(!columns.iter().any(|column| column.ends_with("_value")));

    let rollback = Connection::open_in_memory().unwrap();
    create_schema(&rollback, false).unwrap();
    rollback
        .execute_batch(
            "DROP TABLE role_session_migrations;
             DELETE FROM schema_migrations;
             INSERT INTO schema_migrations(version, applied_at) VALUES (28, 'current');
             CREATE TRIGGER reject_schema_twenty_nine BEFORE INSERT ON schema_migrations
             WHEN NEW.version=29 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();

    assert!(create_schema(&rollback, false).is_err());
    assert_eq!(
        rollback
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, u32>(0)
            })
            .unwrap(),
        28
    );
    assert_eq!(
        rollback
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='role_session_migrations'",
                [],
                |row| row.get::<_, u32>(0),
            )
            .unwrap(),
        0
    );
}

#[test]
fn migration_journal_progresses_monotonically_and_exact_replays_are_idempotent() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("state.sqlite3");
    let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
    seed_migration_roles(&worker);
    let start = migration_start_input(
        MIGRATION_ROLE_ID,
        MIGRATION_TRANSFER_ID,
        crate::RoleSessionMigrationPlatform::Macos,
    );

    let started = worker.start_role_session_migration(start.clone()).unwrap();
    assert_eq!(started.phase, crate::RoleSessionMigrationPhase::V22Ready);
    assert_eq!(started.journal_revision, 1);
    assert_eq!(worker.start_role_session_migration(start).unwrap(), started);
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(started)
    );
    assert_eq!(worker.role_session_migrations().unwrap().len(), 1);

    let mut exported_request = migration_export_transition("30000000-0000-4000-8000-000000000001");
    exported_request.envelope_sha256 = Some("A".repeat(64));
    let exported = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        exported_request.clone(),
    )
    .unwrap();
    assert_eq!(exported.phase, crate::RoleSessionMigrationPhase::Exported);
    assert_eq!(exported.journal_revision, 2);
    assert_eq!(exported.envelope_sha256.as_deref(), Some(ENVELOPE_SHA256));
    assert_eq!(exported.cookie_count, Some(17));
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            exported_request,
        )
        .unwrap(),
        exported
    );

    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Macos,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();
    assert_eq!(importing.journal_revision, 3);
    assert_eq!(importing.target_revision, Some(1));

    let mut verifying = migration_export_transition("30000000-0000-4000-8000-000000000003");
    verifying.expected_phase = crate::RoleSessionMigrationPhase::Importing;
    verifying.expected_journal_revision = 3;
    verifying.next_phase = crate::RoleSessionMigrationPhase::Verifying;
    verifying.target_revision = Some(1);
    verifying.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());
    verifying.occurred_at = "2026-08-30T02:00:03Z".to_owned();
    let verifying = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        verifying,
    )
    .unwrap();
    assert_eq!(verifying.journal_revision, 4);

    let mut ready = migration_export_transition("30000000-0000-4000-8000-000000000004");
    ready.expected_phase = crate::RoleSessionMigrationPhase::Verifying;
    ready.expected_journal_revision = 4;
    ready.next_phase = crate::RoleSessionMigrationPhase::V23Ready;
    ready.target_revision = Some(1);
    ready.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());
    ready.outcome = Some(crate::RoleSessionMigrationOutcome::Verified);
    ready.occurred_at = "2026-08-30T02:00:04Z".to_owned();
    let ready = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        ready,
    )
    .unwrap();
    assert_eq!(ready.journal_revision, 5);
    assert_eq!(
        ready.outcome_at.as_deref(),
        Some("2026-08-30T02:00:04.000Z")
    );

    let mut first_launch = migration_export_transition("30000000-0000-4000-8000-000000000005");
    first_launch.expected_phase = crate::RoleSessionMigrationPhase::V23Ready;
    first_launch.expected_journal_revision = 5;
    first_launch.next_phase = crate::RoleSessionMigrationPhase::V23Ready;
    first_launch.target_revision = Some(1);
    first_launch.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());
    first_launch.outcome = Some(crate::RoleSessionMigrationOutcome::Verified);
    first_launch.mark_first_verified_launch = true;
    first_launch.occurred_at = "2026-08-30T02:00:05Z".to_owned();
    let launched = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        first_launch.clone(),
    )
    .unwrap();
    assert_eq!(launched.journal_revision, 6);
    assert_eq!(
        launched.first_verified_launch_at.as_deref(),
        Some("2026-08-30T02:00:05.000Z")
    );
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            first_launch,
        )
        .unwrap(),
        launched
    );
    drop(worker);

    let restarted = StateDatabaseWorker::start(database_path).unwrap();
    assert_eq!(
        restarted
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(launched)
    );
}

#[test]
fn exported_migration_import_admission_is_atomic_rust_owned_and_restart_idempotent() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("state.sqlite3");
    let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    let exported = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000020"),
    )
    .unwrap();

    let mut bypass = migration_export_transition("30000000-0000-4000-8000-000000000023");
    bypass.expected_phase = crate::RoleSessionMigrationPhase::Exported;
    bypass.expected_journal_revision = exported.journal_revision;
    bypass.next_phase = crate::RoleSessionMigrationPhase::Importing;
    bypass.target_revision = Some(7);
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            bypass,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(exported.clone())
    );

    let input = migration_import_begin_input();
    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            input.clone(),
        )
        .unwrap();
    assert_eq!(importing.phase, crate::RoleSessionMigrationPhase::Importing);
    assert_eq!(importing.journal_revision, exported.journal_revision + 1);
    assert_eq!(importing.target_revision, Some(1));
    assert_eq!(importing.envelope_sha256, exported.envelope_sha256);
    assert_eq!(importing.inventory_sha256, exported.inventory_sha256);
    assert_eq!(importing.cookie_count, exported.cookie_count);
    assert_eq!(
        importing.local_storage_origin_count,
        exported.local_storage_origin_count
    );
    assert_eq!(
        importing.local_storage_entry_count,
        exported.local_storage_entry_count
    );
    assert_eq!(
        worker
            .begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                input.clone(),
            )
            .unwrap(),
        importing
    );
    drop(worker);

    let restarted = StateDatabaseWorker::start(database_path).unwrap();
    assert_eq!(
        restarted
            .begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                input,
            )
            .unwrap(),
        importing
    );
}

#[test]
fn import_admission_binds_runtime_contract_and_platform_before_mutation() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    let exported = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000024"),
    )
    .unwrap();

    let unavailable = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            22,
            migration_import_begin_input(),
        )
        .unwrap_err();
    assert_eq!(
        unavailable.code(),
        "ROLE_SESSION_MIGRATION_IMPORT_ADMISSION_UNAVAILABLE"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(exported.clone())
    );

    let wrong_platform = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Macos,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap_err();
    assert_eq!(
        wrong_platform.code(),
        "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(exported)
    );

    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();
    assert_eq!(importing.target_revision, Some(1));

    for (platform, contract_version, expected_code) in [
        (
            crate::RoleSessionMigrationPlatform::Macos,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
        ),
        (
            crate::RoleSessionMigrationPlatform::Windows,
            22,
            "ROLE_SESSION_MIGRATION_IMPORT_ADMISSION_UNAVAILABLE",
        ),
    ] {
        assert_eq!(
            worker
                .begin_role_session_migration_import(
                    platform,
                    contract_version,
                    migration_import_begin_input(),
                )
                .unwrap_err()
                .code(),
            expected_code
        );
        assert_eq!(
            worker
                .role_session_migration(MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            Some(importing.clone())
        );
    }
}

#[test]
fn importing_and_verifying_transitions_cannot_rewrite_rust_owned_evidence() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000025"),
    )
    .unwrap();
    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();

    let verifying_request = |transition_id: &str| {
        let mut input = migration_export_transition(transition_id);
        input.expected_phase = crate::RoleSessionMigrationPhase::Importing;
        input.expected_journal_revision = importing.journal_revision;
        input.next_phase = crate::RoleSessionMigrationPhase::Verifying;
        input.target_revision = importing.target_revision;
        input.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());
        input.occurred_at = "2026-08-30T02:10:00Z".to_owned();
        input
    };
    let mut rewrites = Vec::new();
    let mut target = verifying_request("30000000-0000-4000-8000-000000000026");
    target.target_revision = Some(2);
    rewrites.push(target);
    let mut envelope = verifying_request("30000000-0000-4000-8000-000000000027");
    envelope.envelope_sha256 = Some("c".repeat(64));
    rewrites.push(envelope);
    let mut inventory = verifying_request("30000000-0000-4000-8000-000000000028");
    inventory.inventory_sha256 = Some("d".repeat(64));
    rewrites.push(inventory);
    let mut cookies = verifying_request("30000000-0000-4000-8000-000000000029");
    cookies.cookie_count = Some(18);
    rewrites.push(cookies);
    let mut origins = verifying_request("30000000-0000-4000-8000-000000000030");
    origins.local_storage_origin_count = Some(4);
    rewrites.push(origins);
    let mut entries = verifying_request("30000000-0000-4000-8000-000000000031");
    entries.local_storage_entry_count = Some(12);
    rewrites.push(entries);

    for rewrite in rewrites {
        assert_eq!(
            target_transition(
                &worker,
                crate::RoleSessionMigrationPlatform::Windows,
                rewrite,
            )
            .unwrap_err()
            .code(),
            "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
        );
        assert_eq!(
            worker
                .role_session_migration(MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            Some(importing.clone())
        );
    }

    let verifying = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        verifying_request("30000000-0000-4000-8000-000000000032"),
    )
    .unwrap();
    let mut flush_rewrite = migration_export_transition(
        "30000000-0000-4000-8000-000000000033",
    );
    flush_rewrite.expected_phase = crate::RoleSessionMigrationPhase::Verifying;
    flush_rewrite.expected_journal_revision = verifying.journal_revision;
    flush_rewrite.next_phase = crate::RoleSessionMigrationPhase::V23Ready;
    flush_rewrite.target_revision = verifying.target_revision;
    flush_rewrite.clean_flush_receipt_id = Some(OTHER_FRESH_FLUSH_RECEIPT.to_owned());
    flush_rewrite.outcome = Some(crate::RoleSessionMigrationOutcome::Verified);
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            flush_rewrite,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(verifying)
    );
}

#[test]
fn indeterminate_target_retry_can_add_but_cannot_replace_a_flush_receipt() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000036"),
    )
    .unwrap();
    let importing = worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();

    let mut first_unknown = migration_export_transition(
        "30000000-0000-4000-8000-000000000037",
    );
    first_unknown.expected_phase = crate::RoleSessionMigrationPhase::Importing;
    first_unknown.expected_journal_revision = importing.journal_revision;
    first_unknown.next_phase = crate::RoleSessionMigrationPhase::Indeterminate;
    first_unknown.target_revision = importing.target_revision;
    first_unknown.stable_error_code = Some("TARGET_FLUSH_ACK_UNKNOWN".to_owned());
    first_unknown.outcome = Some(crate::RoleSessionMigrationOutcome::Indeterminate);
    let first_unknown = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        first_unknown,
    )
    .unwrap();
    assert!(first_unknown.clean_flush_receipt_id.is_none());

    let mut first_verify = migration_export_transition(
        "30000000-0000-4000-8000-000000000038",
    );
    first_verify.expected_phase = crate::RoleSessionMigrationPhase::Indeterminate;
    first_verify.expected_journal_revision = first_unknown.journal_revision;
    first_verify.next_phase = crate::RoleSessionMigrationPhase::Verifying;
    first_verify.target_revision = first_unknown.target_revision;
    first_verify.clean_flush_receipt_id = Some(FRESH_FLUSH_RECEIPT.to_owned());
    let verifying = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        first_verify,
    )
    .unwrap();
    assert_eq!(
        verifying.clean_flush_receipt_id.as_deref(),
        Some(FRESH_FLUSH_RECEIPT)
    );

    let mut second_unknown = migration_export_transition(
        "30000000-0000-4000-8000-000000000039",
    );
    second_unknown.expected_phase = crate::RoleSessionMigrationPhase::Verifying;
    second_unknown.expected_journal_revision = verifying.journal_revision;
    second_unknown.next_phase = crate::RoleSessionMigrationPhase::Indeterminate;
    second_unknown.target_revision = verifying.target_revision;
    second_unknown.clean_flush_receipt_id = verifying.clean_flush_receipt_id.clone();
    second_unknown.stable_error_code = Some("TARGET_VERIFY_ACK_UNKNOWN".to_owned());
    second_unknown.outcome = Some(crate::RoleSessionMigrationOutcome::Indeterminate);
    let second_unknown = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        second_unknown,
    )
    .unwrap();

    let retry = |transition_id: &str, flush_receipt: &str| {
        let mut input = migration_export_transition(transition_id);
        input.expected_phase = crate::RoleSessionMigrationPhase::Indeterminate;
        input.expected_journal_revision = second_unknown.journal_revision;
        input.next_phase = crate::RoleSessionMigrationPhase::Verifying;
        input.target_revision = second_unknown.target_revision;
        input.clean_flush_receipt_id = Some(flush_receipt.to_owned());
        input
    };
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            retry(
                "30000000-0000-4000-8000-000000000040",
                OTHER_FRESH_FLUSH_RECEIPT,
            ),
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(second_unknown.clone())
    );
    let retried = target_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        retry(
            "30000000-0000-4000-8000-000000000041",
            FRESH_FLUSH_RECEIPT,
        ),
    )
    .unwrap();
    assert_eq!(
        retried.clean_flush_receipt_id,
        second_unknown.clean_flush_receipt_id
    );
}

#[test]
fn exported_migration_import_admission_rejects_stale_identity_phase_and_revision() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000021"),
    )
    .unwrap();

    let mut wrong_transfer = migration_import_begin_input();
    wrong_transfer.transfer_id = SECOND_MIGRATION_TRANSFER_ID.to_owned();
    assert_eq!(
        worker
            .begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                wrong_transfer,
            )
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_TRANSFER_STALE"
    );
    let mut wrong_revision = migration_import_begin_input();
    wrong_revision.expected_journal_revision = 1;
    assert_eq!(
        worker
            .begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                wrong_revision,
            )
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_REVISION_STALE"
    );

    worker
        .begin_role_session_migration_import(
            crate::RoleSessionMigrationPlatform::Windows,
            CHROMIUM_RUNTIME_CONTRACT_VERSION,
            migration_import_begin_input(),
        )
        .unwrap();
    let mut wrong_phase = migration_import_begin_input();
    wrong_phase.expected_journal_revision = 3;
    assert_eq!(
        worker
            .begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                wrong_phase,
            )
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_PHASE_STALE"
    );
}

#[test]
fn concurrent_exported_import_admission_commits_one_revision_and_replays_it() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        migration_export_transition("30000000-0000-4000-8000-000000000022"),
    )
    .unwrap();

    let results = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            worker.begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                migration_import_begin_input(),
            )
        });
        let second = scope.spawn(|| {
            worker.begin_role_session_migration_import(
                crate::RoleSessionMigrationPlatform::Windows,
                CHROMIUM_RUNTIME_CONTRACT_VERSION,
                migration_import_begin_input(),
            )
        });
        vec![first.join().unwrap().unwrap(), second.join().unwrap().unwrap()]
    });
    assert_eq!(results[0], results[1]);
    assert_eq!(results[0].journal_revision, 3);
    assert_eq!(results[0].target_revision, Some(1));
}

#[test]
fn v23_role_and_empty_store_journal_commit_atomically_without_schema_defaults() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    assert!(worker.role_session_migrations().unwrap().is_empty());

    let initialization = v23_initialization(V23_CREATED_ROLE_ID, V23_INITIALIZATION_TRANSFER_ID);
    worker
        .mutate(StateMutation::RoleCreateWithV23Ready {
            id: V23_CREATED_ROLE_ID.to_owned(),
            input: v23_role_input("New v23 role"),
            initialization: initialization.clone(),
        })
        .unwrap();
    let committed = worker
        .role_session_migration(V23_CREATED_ROLE_ID.to_owned())
        .unwrap()
        .unwrap();
    assert_eq!(committed.phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(committed.journal_revision, 1);
    assert_eq!(committed.source_revision, 0);
    assert_eq!(committed.target_revision, Some(0));
    assert_eq!(
        committed.outcome,
        Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
    );
    assert_eq!(
        committed.reset_receipt_id.as_deref(),
        Some(initialization.reset_receipt_id.as_str())
    );

    let conflicting_transfer =
        v23_initialization(V23_ROLLBACK_ROLE_ID, V23_INITIALIZATION_TRANSFER_ID);
    assert!(
        worker
            .mutate(StateMutation::RoleCreateWithV23Ready {
                id: V23_ROLLBACK_ROLE_ID.to_owned(),
                input: v23_role_input("Rolled back v23 role"),
                initialization: conflicting_transfer,
            })
            .is_err()
    );
    assert!(
        worker
            .read_record("roles".to_owned(), V23_ROLLBACK_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );
    assert!(
        worker
            .role_session_migration(V23_ROLLBACK_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );
}

#[test]
fn migration_cas_rejects_stale_transfer_phase_revision_and_conflicting_replay() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();

    let mut wrong_transfer = migration_export_transition("40000000-0000-4000-8000-000000000001");
    wrong_transfer.transfer_id = SECOND_MIGRATION_TRANSFER_ID.to_owned();
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            wrong_transfer,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSFER_STALE"
    );

    let mut wrong_phase = migration_export_transition("40000000-0000-4000-8000-000000000002");
    wrong_phase.expected_phase = crate::RoleSessionMigrationPhase::Exported;
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            wrong_phase,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_PHASE_STALE"
    );

    let mut wrong_revision = migration_export_transition("40000000-0000-4000-8000-000000000003");
    wrong_revision.expected_journal_revision = 2;
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            wrong_revision,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_REVISION_STALE"
    );

    let mut skipped = migration_export_transition("40000000-0000-4000-8000-000000000004");
    skipped.next_phase = crate::RoleSessionMigrationPhase::Importing;
    skipped.target_revision = Some(1);
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            skipped,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );

    let committed_request = migration_export_transition("40000000-0000-4000-8000-000000000005");
    source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        committed_request.clone(),
    )
    .unwrap();
    let mut conflicting_replay = committed_request;
    conflicting_replay.cookie_count = Some(18);
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            conflicting_replay,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_REPLAY_CONFLICT"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .unwrap()
            .journal_revision,
        2
    );
}

#[test]
fn migration_validation_never_persists_or_echoes_session_values() {
    let directory = tempdir().unwrap();
    let database_path = directory.path().join("state.sqlite3");
    let worker = StateDatabaseWorker::start(database_path.clone()).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    let secret = "https://account.example.test/private-cookie-value";
    let mut invalid = migration_export_transition("50000000-0000-4000-8000-000000000001");
    invalid.envelope_sha256 = Some(secret.to_owned());

    let error = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        invalid,
    )
    .unwrap_err();
    assert_eq!(error.code(), "CORE_INPUT_INVALID");
    assert!(!error.to_string().contains(secret));
    assert!(!error.to_string().contains("example.test"));
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .unwrap()
            .journal_revision,
        1
    );
    drop(worker);

    let connection = Connection::open(database_path).unwrap();
    let stored = connection
        .prepare("SELECT * FROM role_session_migrations")
        .unwrap()
        .query_map([], |row| {
            let mut values = Vec::new();
            for index in 0..row.as_ref().column_count() {
                if let Ok(value) = row.get::<_, String>(index) {
                    values.push(value);
                }
            }
            Ok(values.join("\n"))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    assert!(!stored.contains(secret));
    assert!(!stored.contains("example.test"));
}

#[test]
fn export_evidence_is_complete_or_empty_and_partial_bundles_never_commit() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let ready = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();

    let mut partial = migration_export_transition("50000000-0000-4000-8000-000000000002");
    partial.inventory_sha256 = None;
    assert_eq!(
        source_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Macos,
            partial,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(ready)
    );
}

#[test]
fn generic_transition_cannot_forge_explicit_reset_receipts() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Windows,
        ))
        .unwrap();
    let mut indeterminate = migration_transition(
        "60000000-0000-4000-8000-000000000001",
        crate::RoleSessionMigrationPhase::V22Ready,
        1,
        crate::RoleSessionMigrationPhase::Indeterminate,
        "2026-08-30T03:00:01Z",
    );
    indeterminate.stable_error_code = Some("TARGET_COMMIT_UNKNOWN".to_owned());
    indeterminate.outcome = Some(crate::RoleSessionMigrationOutcome::Indeterminate);
    let indeterminate = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Windows,
        indeterminate,
    )
    .unwrap();
    assert_eq!(indeterminate.journal_revision, 2);

    let mut incomplete_reset = migration_transition(
        "60000000-0000-4000-8000-000000000002",
        crate::RoleSessionMigrationPhase::Indeterminate,
        2,
        crate::RoleSessionMigrationPhase::V23Ready,
        "2026-08-30T03:00:02Z",
    );
    incomplete_reset.target_revision = Some(8);
    incomplete_reset.outcome = Some(crate::RoleSessionMigrationOutcome::ExplicitReset);
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            incomplete_reset,
        )
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );

    let mut reset = migration_transition(
        "60000000-0000-4000-8000-000000000003",
        crate::RoleSessionMigrationPhase::Indeterminate,
        2,
        crate::RoleSessionMigrationPhase::V23Ready,
        "2026-08-30T03:00:03Z",
    );
    reset.target_revision = Some(9);
    reset.outcome = Some(crate::RoleSessionMigrationOutcome::ExplicitReset);
    reset.clean_flush_receipt_id = Some("flush:reset:9".to_owned());
    reset.reset_receipt_id = Some("reset:role:9".to_owned());
    assert_eq!(
        target_transition(
            &worker,
            crate::RoleSessionMigrationPlatform::Windows,
            reset,
        )
        .unwrap_err()
        .code(),
        "ROLE_SESSION_MIGRATION_TRANSITION_INVALID"
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(indeterminate)
    );
}

#[test]
fn role_reset_preserves_the_journal_and_role_delete_cascades_only_on_commit() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let first = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-browser-clear-test".to_owned(),
            kind: "role_browser_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":MIGRATION_ROLE_ID}),
        })
        .unwrap();
    worker
        .mutate(StateMutation::RoleBrowserDataReset {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: "role-browser-clear-test".to_owned(),
            expected_platform: crate::RoleSessionMigrationPlatform::Macos,
            v23_explicit_reset: None,
        })
        .unwrap();
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(first)
    );

    worker
        .start_role_session_migration(migration_start_input(
            SECOND_MIGRATION_ROLE_ID,
            SECOND_MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    assert!(
        worker
            .mutate(StateMutation::RoleDelete {
                id: SECOND_MIGRATION_ROLE_ID.to_owned(),
                operation_id: Some("missing-quarantine-journal".to_owned()),
            })
            .is_err()
    );
    assert!(
        worker
            .read_record("roles".to_owned(), SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .is_some()
    );
    assert!(
        worker
            .role_session_migration(SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .is_some()
    );

    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-delete-committed-test".to_owned(),
            kind: "role_delete_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":MIGRATION_ROLE_ID}),
        })
        .unwrap();
    worker
        .mutate(StateMutation::RoleDelete {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: Some("role-delete-committed-test".to_owned()),
        })
        .unwrap();
    assert!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );
}

#[test]
fn v23_explicit_reset_and_role_clear_journal_commit_in_one_sqlite_transaction() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let current = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-browser-clear-v23".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":MIGRATION_ROLE_ID}),
        })
        .unwrap();
    let evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        Some(&current),
        "chromium-session-clear:effect-1".to_owned(),
        "role-browser-clear:role-browser-clear-v23".to_owned(),
    )
    .unwrap();
    worker
        .mutate(StateMutation::RoleBrowserDataReset {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: "role-browser-clear-v23".to_owned(),
            expected_platform: crate::RoleSessionMigrationPlatform::Macos,
            v23_explicit_reset: Some(evidence),
        })
        .unwrap();

    let committed = worker
        .role_session_migration(MIGRATION_ROLE_ID.to_owned())
        .unwrap()
        .unwrap();
    assert_eq!(committed.phase, crate::RoleSessionMigrationPhase::V23Ready);
    assert_eq!(committed.journal_revision, current.journal_revision + 1);
    assert_eq!(
        committed.outcome,
        Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
    );
    assert_eq!(worker.operation_journals().unwrap()[0].phase, "committed");

    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-browser-clear-v23-second".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":MIGRATION_ROLE_ID}),
        })
        .unwrap();
    let repeated = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        Some(&committed),
        "chromium-session-clear:effect-2".to_owned(),
        "role-browser-clear:role-browser-clear-v23-second".to_owned(),
    )
    .unwrap();
    worker
        .mutate(StateMutation::RoleBrowserDataReset {
            id: MIGRATION_ROLE_ID.to_owned(),
            operation_id: "role-browser-clear-v23-second".to_owned(),
            expected_platform: crate::RoleSessionMigrationPlatform::Macos,
            v23_explicit_reset: Some(repeated),
        })
        .unwrap();
    let repeated = worker
        .role_session_migration(MIGRATION_ROLE_ID.to_owned())
        .unwrap()
        .unwrap();
    assert_eq!(repeated.journal_revision, committed.journal_revision + 1);
    assert_eq!(repeated.target_revision, Some(2));
    assert_eq!(
        repeated.reset_receipt_id.as_deref(),
        Some("role-browser-clear:role-browser-clear-v23-second")
    );
}

#[test]
fn v23_explicit_reset_rolls_back_when_role_clear_journal_commit_fails() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let current = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    let evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        Some(&current),
        "chromium-session-clear:effect-rollback".to_owned(),
        "role-browser-clear:missing-role-clear-journal".to_owned(),
    )
    .unwrap();
    assert!(
        worker
            .mutate(StateMutation::RoleBrowserDataReset {
                id: MIGRATION_ROLE_ID.to_owned(),
                operation_id: "missing-role-clear-journal".to_owned(),
                expected_platform: crate::RoleSessionMigrationPlatform::Macos,
                v23_explicit_reset: Some(evidence),
            })
            .is_err()
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(current)
    );
}

#[test]
fn v23_explicit_reset_rejects_a_stale_migration_revision_without_mutation() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let current = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    let stale_evidence = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        Some(&current),
        "chromium-session-clear:stale-effect".to_owned(),
        "role-browser-clear:role-browser-clear-stale".to_owned(),
    )
    .unwrap();
    let advanced = source_transition(
        &worker,
        crate::RoleSessionMigrationPlatform::Macos,
        migration_export_transition("30000000-0000-4000-8000-000000000099"),
    )
    .unwrap();
    worker
        .put_operation_journal(OperationJournalRecord {
            id: "role-browser-clear-stale".to_owned(),
            kind: "role_browser_data_clear_v1".to_owned(),
            phase: "quarantined".to_owned(),
            payload: json!({"roleId":MIGRATION_ROLE_ID}),
        })
        .unwrap();

    assert!(
        worker
            .mutate(StateMutation::RoleBrowserDataReset {
                id: MIGRATION_ROLE_ID.to_owned(),
                operation_id: "role-browser-clear-stale".to_owned(),
                expected_platform: crate::RoleSessionMigrationPlatform::Macos,
                v23_explicit_reset: Some(stale_evidence),
            })
            .is_err()
    );
    assert_eq!(
        worker
            .role_session_migration(MIGRATION_ROLE_ID.to_owned())
            .unwrap(),
        Some(advanced)
    );
    assert_eq!(worker.operation_journals().unwrap()[0].phase, "quarantined");
}

#[test]
fn v23_explicit_reset_rechecks_target_and_platform_inside_the_clear_transaction() {
    let directory = tempdir().unwrap();
    let worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    seed_migration_roles(&worker);
    let current = worker
        .start_role_session_migration(migration_start_input(
            MIGRATION_ROLE_ID,
            MIGRATION_TRANSFER_ID,
            crate::RoleSessionMigrationPlatform::Macos,
        ))
        .unwrap();
    let role_before = worker
        .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
        .unwrap();
    let base = crate::session_migration::new_v23_explicit_reset_evidence(
        MIGRATION_ROLE_ID.to_owned(),
        rion_platform::Platform::Macos,
        Some(&current),
        "chromium-session-clear:forged-evidence".to_owned(),
        "role-browser-clear:forged-evidence".to_owned(),
    )
    .unwrap();

    let mut wrong_target = base.clone();
    wrong_target.target_revision += 1;
    let mut wrong_platform = base;
    wrong_platform.platform = crate::RoleSessionMigrationPlatform::Windows;
    wrong_platform.source_engine = crate::RoleSessionMigrationEngine::Webview2;
    for (operation_id, mut evidence) in [
        ("role-browser-clear-forged-target", wrong_target),
        ("role-browser-clear-forged-platform", wrong_platform),
    ] {
        evidence.reset_receipt_id = format!("role-browser-clear:{operation_id}");
        worker
            .put_operation_journal(OperationJournalRecord {
                id: operation_id.to_owned(),
                kind: "role_browser_data_clear_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({"roleId":MIGRATION_ROLE_ID}),
            })
            .unwrap();
        assert!(
            worker
                .mutate(StateMutation::RoleBrowserDataReset {
                    id: MIGRATION_ROLE_ID.to_owned(),
                    operation_id: operation_id.to_owned(),
                    expected_platform: crate::RoleSessionMigrationPlatform::Macos,
                    v23_explicit_reset: Some(evidence),
                })
                .is_err()
        );
        assert_eq!(
            worker
                .role_session_migration(MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            Some(current.clone())
        );
        assert_eq!(
            worker
                .read_record("roles".to_owned(), MIGRATION_ROLE_ID.to_owned())
                .unwrap(),
            role_before
        );
        assert_eq!(
            worker
                .operation_journals()
                .unwrap()
                .into_iter()
                .find(|journal| journal.id == operation_id)
                .unwrap()
                .phase,
            "quarantined"
        );
    }
}
