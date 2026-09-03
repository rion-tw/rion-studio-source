#[test]
fn portable_snapshot_replacement_preserves_only_destination_migration_authority() {
    let directory = tempdir().unwrap();
    let mut worker = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
    worker
        .replace_snapshot(json!({
            "games": [{
                "id": "migration-game",
                "source": "custom",
                "name": "Migration Game",
                "defaultLaunchUrl": "https://example.test/play",
                "browserLaunchMode": "inherit",
                "createdAt": "2026-08-30T00:00:00Z",
                "updatedAt": "2026-08-30T00:00:00Z"
            }],
            "roles": [],
            "launchWorkspaces": [],
            "gameWindows": [],
            "macros": []
        }))
        .unwrap();
    worker
        .mutate(StateMutation::RoleCreateWithV23Ready {
            id: V23_CREATED_ROLE_ID.to_owned(),
            input: v23_role_input("Retained Role"),
            initialization: v23_initialization(V23_CREATED_ROLE_ID, V23_INITIALIZATION_TRANSFER_ID),
        })
        .unwrap();

    let ready = worker
        .role_session_migration(V23_CREATED_ROLE_ID.to_owned())
        .unwrap()
        .unwrap();
    let launch_fence = crate::RoleSessionMigrationTransitionInput {
        role_id: ready.role_id.clone(),
        transfer_id: ready.transfer_id.clone(),
        transition_id: "30000000-0000-4000-8000-000000000099".to_owned(),
        expected_phase: crate::RoleSessionMigrationPhase::V23Ready,
        expected_journal_revision: ready.journal_revision,
        next_phase: crate::RoleSessionMigrationPhase::V23Ready,
        target_revision: ready.target_revision,
        envelope_sha256: ready.envelope_sha256.clone(),
        inventory_sha256: ready.inventory_sha256.clone(),
        cookie_count: ready.cookie_count,
        local_storage_origin_count: ready.local_storage_origin_count,
        local_storage_entry_count: ready.local_storage_entry_count,
        stable_error_code: ready.stable_error_code.clone(),
        outcome: ready.outcome,
        clean_flush_receipt_id: ready.clean_flush_receipt_id.clone(),
        reset_receipt_id: ready.reset_receipt_id.clone(),
        mark_first_verified_launch: true,
        occurred_at: "2026-08-30T03:31:00.000Z".to_owned(),
    };
    let armed = worker
        .transition_role_session_migration(
            crate::session_migration::TransitionAuthority::TargetRuntime {
                expected_platform: crate::RoleSessionMigrationPlatform::Windows,
            },
            launch_fence.clone(),
        )
        .unwrap();

    let mut replacement = worker.snapshot().unwrap();
    let roles = replacement["roles"].as_array_mut().unwrap();
    roles[0]["notes"] = json!("portable metadata update");
    roles.push(json!({
        "id": SECOND_MIGRATION_ROLE_ID,
        "gameId": "migration-game",
        "name": "Imported Role",
        "launchUrl": "https://example.test/play",
        "notes": "",
        "browserSessionSource": "embedded",
        "createdAt": "2026-08-30T03:32:00.000Z",
        "updatedAt": "2026-08-30T03:32:00.000Z"
    }));

    let mut invalid_replacement = replacement.clone();
    let duplicate = invalid_replacement["roles"][0].clone();
    invalid_replacement["roles"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(worker.replace_snapshot(invalid_replacement).is_err());
    assert_eq!(
        worker
            .role_session_migration(V23_CREATED_ROLE_ID.to_owned())
            .unwrap(),
        Some(armed.clone())
    );

    worker.replace_snapshot(replacement).unwrap();

    assert_eq!(
        worker
            .role_session_migration(V23_CREATED_ROLE_ID.to_owned())
            .unwrap(),
        Some(armed.clone())
    );
    assert_eq!(
        worker
            .transition_role_session_migration(
                crate::session_migration::TransitionAuthority::TargetRuntime {
                    expected_platform: crate::RoleSessionMigrationPlatform::Windows,
                },
                launch_fence,
            )
            .unwrap(),
        armed
    );
    assert!(
        worker
            .role_session_migration(SECOND_MIGRATION_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );

    let mut without_retained_role = worker.snapshot().unwrap();
    without_retained_role["roles"]
        .as_array_mut()
        .unwrap()
        .retain(|role| role["id"] != V23_CREATED_ROLE_ID);
    worker.replace_snapshot(without_retained_role).unwrap();
    assert!(
        worker
            .role_session_migration(V23_CREATED_ROLE_ID.to_owned())
            .unwrap()
            .is_none()
    );
    worker.shutdown().unwrap();
}
