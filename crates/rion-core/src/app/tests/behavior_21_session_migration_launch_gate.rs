fn migration_gate_options(
    directory: &std::path::Path,
    platform: &str,
    runtime_contract_version: u32,
) -> AppCoreOptions {
    AppCoreOptions {
        app_version: "2.1.0-test".to_owned(),
        build_commit: None,
        packaged: false,
        platform: platform.to_owned(),
        runtime_contract_version: Some(runtime_contract_version),
        user_data_dir: directory.to_string_lossy().into_owned(),
        performance_telemetry_path: None,
    }
}

fn assert_session_migration_blocks_launch(core: &Arc<AppCore>, role_id: &str) {
    core.invoke(CoreCommand::BrowserRuntimeRegister {
        registration: chromium_registration(
            if core.platform == rion_platform::Platform::Macos {
                "darwin"
            } else {
                "win32"
            },
            true,
        ),
    })
    .unwrap();
    let (launch, actions) = drive_command(
        Arc::clone(core),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    assert!(actions.is_empty());
    assert_eq!(
        launch.unwrap_err().code(),
        "BROWSER_RUNTIME_CAPABILITY_UNAVAILABLE"
    );

    let snapshot = core.read_typed_snapshot().unwrap();
    let role = snapshot
        .roles
        .iter()
        .find(|role| role.id == role_id)
        .unwrap();
    let game = snapshot
        .games
        .iter()
        .find(|game| game.id == role.game_id)
        .unwrap();
    let settings = snapshot.game_browser_settings.as_ref().unwrap();
    let resolution = core
        .resolve_role_browser_engine(role, game, settings)
        .unwrap();
    assert_eq!(
        resolution.issue_reason,
        Some(crate::model::BrowserRuntimeFailureReason::SessionMigrationRequired)
    );
}

#[cfg(any(target_os = "macos", windows))]
fn verified_migration_transition(
    role_id: &str,
    transfer_id: &str,
    evidence: &crate::RoleSessionTransferJournalEvidence,
    expected_phase: crate::RoleSessionMigrationPhase,
    expected_journal_revision: u64,
    next_phase: crate::RoleSessionMigrationPhase,
    occurred_at: &str,
) -> crate::RoleSessionMigrationTransitionInput {
    let exported_or_later = next_phase != crate::RoleSessionMigrationPhase::V22Ready;
    crate::RoleSessionMigrationTransitionInput {
        role_id: role_id.to_owned(),
        transfer_id: transfer_id.to_owned(),
        transition_id: uuid::Uuid::new_v4().to_string(),
        expected_phase,
        expected_journal_revision,
        next_phase,
        target_revision: matches!(
            next_phase,
            crate::RoleSessionMigrationPhase::Importing
                | crate::RoleSessionMigrationPhase::Verifying
                | crate::RoleSessionMigrationPhase::V23Ready
        )
        .then_some(1),
        envelope_sha256: exported_or_later.then(|| evidence.envelope_sha256.clone()),
        inventory_sha256: exported_or_later.then(|| evidence.inventory_sha256.clone()),
        cookie_count: exported_or_later.then_some(evidence.cookie_count),
        local_storage_origin_count: exported_or_later.then_some(0),
        local_storage_entry_count: exported_or_later.then_some(0),
        stable_error_code: None,
        outcome: (next_phase == crate::RoleSessionMigrationPhase::V23Ready)
            .then_some(crate::RoleSessionMigrationOutcome::Verified),
        clean_flush_receipt_id: matches!(
            next_phase,
            crate::RoleSessionMigrationPhase::Verifying
                | crate::RoleSessionMigrationPhase::V23Ready
        )
        .then(|| format!("chromium-cookie-flush:{transfer_id}:1")),
        reset_receipt_id: None,
        mark_first_verified_launch: false,
        occurred_at: occurred_at.to_owned(),
    }
}

#[cfg(any(target_os = "macos", windows))]
fn publish_empty_session_transfer_vault(
    core: &AppCore,
    role_id: &str,
    transfer_id: &str,
    platform: crate::RoleSessionMigrationPlatform,
    source_engine: crate::RoleSessionMigrationEngine,
) -> crate::RoleSessionTransferJournalEvidence {
    let envelope = empty_session_transfer_envelope(role_id, transfer_id, platform, source_engine);
    core.write_role_session_transfer_vault_internal(&envelope.canonical_envelope_json().unwrap())
        .unwrap()
}

#[cfg(any(target_os = "macos", windows))]
fn empty_session_transfer_envelope(
    role_id: &str,
    transfer_id: &str,
    platform: crate::RoleSessionMigrationPlatform,
    source_engine: crate::RoleSessionMigrationEngine,
) -> crate::RoleSessionTransferEnvelopeRecord {
    crate::RoleSessionTransferEnvelopeRecord {
        metadata: crate::RoleSessionTransferMetadataRecord {
            format: crate::RoleSessionTransferFormat::RionRoleSessionTransfer,
            version: crate::ROLE_SESSION_TRANSFER_VERSION,
            transfer_id: transfer_id.to_owned(),
            role_id: role_id.to_owned(),
            platform,
            source_engine,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
            source_evidence: None,
        },
        inventory: crate::RoleSessionTransferInventoryRecord {
            cookies: Vec::new(),
            local_storage: Vec::new(),
        },
    }
}

#[cfg(any(target_os = "macos", windows))]
fn target_migration_transition(
    role_id: &str,
    transfer_id: &str,
    expected_phase: crate::RoleSessionMigrationPhase,
    expected_journal_revision: u64,
    next_phase: crate::RoleSessionMigrationPhase,
    occurred_at: &str,
) -> crate::RoleSessionMigrationTargetTransitionInput {
    crate::RoleSessionMigrationTargetTransitionInput {
        role_id: role_id.to_owned(),
        transfer_id: transfer_id.to_owned(),
        transition_id: uuid::Uuid::new_v4().to_string(),
        expected_phase,
        expected_journal_revision,
        next_phase,
        stable_error_code: None,
        outcome: (next_phase == crate::RoleSessionMigrationPhase::V23Ready)
            .then_some(crate::RoleSessionMigrationOutcome::Verified),
        clean_flush_receipt_id: matches!(
            next_phase,
            crate::RoleSessionMigrationPhase::Verifying
                | crate::RoleSessionMigrationPhase::V23Ready
        )
        .then(|| format!("chromium-cookie-flush:{transfer_id}:1")),
        occurred_at: occurred_at.to_owned(),
    }
}

#[cfg(target_os = "macos")]
fn native_session_migration_test_runtime() -> (
    &'static str,
    crate::RoleSessionMigrationPlatform,
    crate::RoleSessionMigrationEngine,
) {
    (
        "darwin",
        crate::RoleSessionMigrationPlatform::Macos,
        crate::RoleSessionMigrationEngine::Wkwebview,
    )
}

#[cfg(windows)]
fn native_session_migration_test_runtime() -> (
    &'static str,
    crate::RoleSessionMigrationPlatform,
    crate::RoleSessionMigrationEngine,
) {
    (
        "win32",
        crate::RoleSessionMigrationPlatform::Windows,
        crate::RoleSessionMigrationEngine::Webview2,
    )
}

#[test]
fn v23_blocks_every_v22_role_without_a_ready_durable_journal() {
    for platform in ["darwin", "win32"] {
        for start_v22_journal in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let stable = Arc::new(
                AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
            );
            let role_id = create_role(&stable, &first_game_id(&stable), 1);
            assert!(
                stable
                    .role_session_migration(role_id.clone())
                    .unwrap()
                    .is_none()
            );
            if start_v22_journal {
                let migration_platform = if platform == "darwin" {
                    crate::RoleSessionMigrationPlatform::Macos
                } else {
                    crate::RoleSessionMigrationPlatform::Windows
                };
                stable
                    .start_role_session_migration(crate::RoleSessionMigrationStartInput {
                        role_id: role_id.clone(),
                        transfer_id: uuid::Uuid::new_v4().to_string(),
                        platform: migration_platform,
                        source_engine: if platform == "darwin" {
                            crate::RoleSessionMigrationEngine::Wkwebview
                        } else {
                            crate::RoleSessionMigrationEngine::Webview2
                        },
                        target_engine: crate::RoleSessionMigrationEngine::Chromium,
                        source_revision: 1,
                    })
                    .unwrap();
            }
            stable.shutdown();

            let chromium = Arc::new(
                AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
            );
            assert_session_migration_blocks_launch(&chromium, &role_id);
            chromium.shutdown();
        }
    }
}

#[test]
fn stable_v22_startup_atomically_prepares_every_retained_role_and_replays_without_replacement() {
    for platform in ["darwin", "win32"] {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
        );
        let game_id = first_game_id(&core);
        let existing_role_id = create_role(&core, &game_id, 1);
        let missing_role_id = create_role(&core, &game_id, 2);
        let migration_platform = if platform == "darwin" {
            crate::RoleSessionMigrationPlatform::Macos
        } else {
            crate::RoleSessionMigrationPlatform::Windows
        };
        let source_engine = if platform == "darwin" {
            crate::RoleSessionMigrationEngine::Wkwebview
        } else {
            crate::RoleSessionMigrationEngine::Webview2
        };
        let existing_transfer_id = uuid::Uuid::new_v4().to_string();
        let existing = core
            .start_role_session_migration(crate::RoleSessionMigrationStartInput {
                role_id: existing_role_id.clone(),
                transfer_id: existing_transfer_id.clone(),
                platform: migration_platform,
                source_engine,
                target_engine: crate::RoleSessionMigrationEngine::Chromium,
                source_revision: 9,
            })
            .unwrap();

        let prepared = core.prepare_v22_role_session_migrations_internal().unwrap();
        assert_eq!(prepared.len(), 2, "{platform}");
        assert_eq!(
            prepared
                .iter()
                .find(|journal| journal.role_id == existing_role_id)
                .unwrap(),
            &existing
        );
        let created = prepared
            .iter()
            .find(|journal| journal.role_id == missing_role_id)
            .unwrap();
        assert_eq!(created.phase, crate::RoleSessionMigrationPhase::V22Ready);
        assert_eq!(created.platform, migration_platform);
        assert_eq!(created.source_engine, source_engine);
        assert_eq!(created.source_revision, 0);
        assert_eq!(created.journal_revision, 1);
        assert_ne!(created.transfer_id, existing_transfer_id);
        assert_eq!(
            core.prepare_v22_role_session_migrations_internal().unwrap(),
            prepared,
            "{platform}: replay must not replace transfer identities or revisions"
        );
        core.shutdown();

        let restarted =
            AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap();
        assert_eq!(
            restarted.role_session_migrations().unwrap(),
            prepared,
            "{platform}: prepared journals must be durable before export scheduling"
        );
        restarted.shutdown();
    }
}

#[test]
fn stable_v22_startup_rejects_cross_platform_journals_and_rolls_back_every_prepared_role() {
    let directory = tempfile::tempdir().unwrap();
    let windows =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "win32", 22)).unwrap());
    let game_id = first_game_id(&windows);
    let missing_role_id = create_role(&windows, &game_id, 1);
    let conflicting_role_id = create_role(&windows, &game_id, 2);
    let conflicting = windows
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: conflicting_role_id.clone(),
            transfer_id: uuid::Uuid::new_v4().to_string(),
            platform: crate::RoleSessionMigrationPlatform::Windows,
            source_engine: crate::RoleSessionMigrationEngine::Webview2,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 3,
        })
        .unwrap();
    windows.shutdown();

    let core = AppCore::create(migration_gate_options(directory.path(), "darwin", 22)).unwrap();

    let error = core
        .prepare_v22_role_session_migrations_internal()
        .unwrap_err();
    assert_eq!(error.code(), "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH");
    assert!(
        core.role_session_migration(missing_role_id)
            .unwrap()
            .is_none(),
        "the journal inserted before the mismatch must roll back with the transaction"
    );
    assert_eq!(
        core.role_session_migration(conflicting_role_id)
            .unwrap()
            .unwrap(),
        conflicting,
        "the pre-existing conflicting journal must remain untouched"
    );
    core.shutdown();
}

#[test]
fn stable_source_start_rejects_an_opposite_platform_before_creating_a_journal() {
    let directory = tempfile::tempdir().unwrap();
    let core =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "darwin", 22)).unwrap());
    let role_id = create_role(&core, &first_game_id(&core), 1);
    let error = core
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: role_id.clone(),
            transfer_id: uuid::Uuid::new_v4().to_string(),
            platform: crate::RoleSessionMigrationPlatform::Windows,
            source_engine: crate::RoleSessionMigrationEngine::Webview2,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        })
        .unwrap_err();
    assert_eq!(error.code(), "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH");
    assert!(core.role_session_migration(role_id).unwrap().is_none());
    core.shutdown();
}

#[test]
fn a_new_v23_role_commits_empty_store_evidence_and_remains_launchable_after_restart() {
    for platform in ["darwin", "win32"] {
        let directory = tempfile::tempdir().unwrap();
        let core = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
        );
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let journal = core
            .role_session_migration(role_id.clone())
            .unwrap()
            .unwrap();
        assert_eq!(journal.phase, crate::RoleSessionMigrationPhase::V23Ready);
        assert_eq!(journal.journal_revision, 1);
        assert!(journal.first_verified_launch_at.is_none());
        assert_eq!(journal.source_revision, 0);
        assert_eq!(journal.target_revision, Some(0));
        assert_eq!(
            journal.outcome,
            Some(crate::RoleSessionMigrationOutcome::ExplicitReset)
        );
        assert!(
            journal
                .reset_receipt_id
                .as_deref()
                .unwrap()
                .starts_with("v23-role-create:")
        );
        assert!(
            journal
                .clean_flush_receipt_id
                .as_deref()
                .unwrap()
                .starts_with("v23-empty-store:")
        );
        assert!(crate::v23_role_initialization::marker_path(directory.path(), &role_id).is_file());
        core.shutdown();

        let restarted = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
        );
        restarted
            .invoke(CoreCommand::BrowserRuntimeRegister {
                registration: chromium_registration(platform, true),
            })
            .unwrap();
        let (launch, actions) = drive_command(
            Arc::clone(&restarted),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id.clone(),
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(launch.is_ok(), "{platform}: {launch:?}");
        assert!(!actions.is_empty(), "{platform}");
        let admitted = restarted
            .role_session_migration(role_id.clone())
            .unwrap()
            .unwrap();
        assert_eq!(admitted.journal_revision, 2, "{platform}");
        assert!(admitted.first_verified_launch_at.is_some(), "{platform}");

        let (focused, focus_actions) = drive_command(
            Arc::clone(&restarted),
            command(json!({
                "type": "embeddedRoleLaunch",
                "roleId": role_id.clone(),
                "target": {
                    "displayId": 1,
                    "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
                }
            })),
            None,
        );
        assert!(focused.is_ok(), "{platform}: {focused:?}");
        assert!(!focus_actions.is_empty(), "{platform}");
        assert_eq!(
            restarted
                .role_session_migration(role_id.clone())
                .unwrap()
                .unwrap(),
            admitted,
            "{platform}: focusing an already-running role must not advance the launch fence",
        );
        restarted.shutdown();

        let stable =
            AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap();
        let downgrade = stable
            .prepare_v22_role_session_migrations_internal()
            .unwrap_err();
        assert_eq!(
            downgrade.code(),
            "ROLE_SESSION_MIGRATION_DOWNGRADE_UNSAFE",
            "{platform}",
        );
        stable.shutdown();
    }
}

#[test]
fn moved_v23_database_cannot_use_ready_or_armed_journals_on_the_wrong_platform() {
    let directory = tempfile::tempdir().unwrap();
    let macos =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "darwin", 23)).unwrap());
    let game_id = first_game_id(&macos);
    let unarmed_role_id = create_role(&macos, &game_id, 1);
    let armed_role_id = create_role(&macos, &game_id, 2);
    macos
        .invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
    let (launch, actions) = drive_command(
        Arc::clone(&macos),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": armed_role_id.clone(),
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    assert!(launch.is_ok(), "{launch:?}");
    assert!(!actions.is_empty());
    let unarmed = macos
        .role_session_migration(unarmed_role_id.clone())
        .unwrap()
        .unwrap();
    let armed = macos
        .role_session_migration(armed_role_id.clone())
        .unwrap()
        .unwrap();
    assert!(unarmed.first_verified_launch_at.is_none());
    assert!(armed.first_verified_launch_at.is_some());
    macos.shutdown();

    let windows =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "win32", 23)).unwrap());
    for (role_id, before) in [(unarmed_role_id, unarmed), (armed_role_id, armed)] {
        let error = windows
            .mark_role_session_launch_admitted(std::slice::from_ref(&role_id))
            .unwrap_err();
        assert_eq!(error.code(), "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH");
        assert_eq!(
            windows.role_session_migration(role_id.clone()).unwrap(),
            Some(before.clone()),
            "a physical-platform rejection must not rewrite the journal",
        );
        assert_session_migration_blocks_launch(&windows, &role_id);
        assert_eq!(
            windows.role_session_migration(role_id).unwrap(),
            Some(before),
            "launch preflight must fail before any native effect or fence mutation",
        );
    }
    windows.shutdown();
}

#[test]
fn stable_v22_rearms_an_unlaunched_v23_journal_before_it_can_become_source_authority() {
    for platform in ["darwin", "win32"] {
        let directory = tempfile::tempdir().unwrap();
        let chromium = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
        );
        let role_id = create_role(&chromium, &first_game_id(&chromium), 1);
        let target_ready = chromium
            .role_session_migration(role_id.clone())
            .unwrap()
            .unwrap();
        assert_eq!(
            target_ready.phase,
            crate::RoleSessionMigrationPhase::V23Ready
        );
        assert!(target_ready.first_verified_launch_at.is_none());
        chromium.shutdown();

        let stable = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
        );
        let prepared = stable
            .prepare_v22_role_session_migrations_internal()
            .unwrap();
        let rearmed = prepared
            .iter()
            .find(|journal| journal.role_id == role_id)
            .unwrap();
        assert_eq!(rearmed.phase, crate::RoleSessionMigrationPhase::V22Ready);
        assert_eq!(rearmed.journal_revision, 1);
        assert_eq!(rearmed.source_revision, target_ready.source_revision + 1);
        assert_ne!(rearmed.transfer_id, target_ready.transfer_id);
        assert!(rearmed.target_revision.is_none());
        assert!(rearmed.outcome.is_none());
        assert!(rearmed.outcome_at.is_none());
        assert!(rearmed.first_verified_launch_at.is_none());
        assert!(rearmed.clean_flush_receipt_id.is_none());
        assert!(rearmed.reset_receipt_id.is_none());
        stable.shutdown();

        let chromium = Arc::new(
            AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
        );
        assert_session_migration_blocks_launch(&chromium, &role_id);
        chromium.shutdown();
    }
}

#[test]
fn failed_chromium_navigation_keeps_the_downgrade_fence_and_v22_rolls_back_its_batch() {
    let directory = tempfile::tempdir().unwrap();
    let chromium =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "darwin", 23)).unwrap());
    let game_id = first_game_id(&chromium);
    let untouched_role_id = create_role(&chromium, &game_id, 1);
    let admitted_role_id = create_role(&chromium, &game_id, 2);
    let untouched_before = chromium
        .role_session_migration(untouched_role_id.clone())
        .unwrap()
        .unwrap();
    chromium
        .invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration("darwin", true),
        })
        .unwrap();
    let (failed, actions) = drive_command(
        Arc::clone(&chromium),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": admitted_role_id.clone(),
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        Some("embeddedLoadRoles"),
    );
    assert_eq!(failed.unwrap_err().code(), "GAME_PAGE_LOAD_FAILED");
    assert!(actions.iter().any(|action| matches!(
        action,
        crate::model::CoreEffectAction::EmbeddedLoadRoles { .. }
    )));
    let admitted = chromium
        .role_session_migration(admitted_role_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(admitted.journal_revision, 2);
    assert!(admitted.first_verified_launch_at.is_some());
    chromium.shutdown();

    let stable = AppCore::create(migration_gate_options(directory.path(), "darwin", 22)).unwrap();
    let error = stable
        .prepare_v22_role_session_migrations_internal()
        .unwrap_err();
    assert_eq!(error.code(), "ROLE_SESSION_MIGRATION_DOWNGRADE_UNSAFE");
    assert_eq!(
        stable
            .role_session_migration(untouched_role_id)
            .unwrap()
            .unwrap(),
        untouched_before,
        "the earlier unlaunched-role rearm must roll back with the unsafe downgrade",
    );
    assert_eq!(
        stable
            .role_session_migration(admitted_role_id)
            .unwrap()
            .unwrap(),
        admitted,
    );
    stable.shutdown();
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn import_admission_rejects_v22_and_opposite_platform_without_advancing() {
    let (platform, migration_platform, source_engine) = native_session_migration_test_runtime();
    let directory = tempfile::tempdir().unwrap();
    let stable = Arc::new(
        AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
    );
    let role_id = create_role(&stable, &first_game_id(&stable), 1);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    stable
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: role_id.clone(),
            transfer_id: transfer_id.clone(),
            platform: migration_platform,
            source_engine,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        })
        .unwrap();
    let forged_evidence = crate::RoleSessionTransferJournalEvidence {
        role_id: role_id.clone(),
        transfer_id: transfer_id.clone(),
        envelope_sha256: "a".repeat(64),
        inventory_sha256: "b".repeat(64),
        cookie_count: 0,
        local_storage_origin_count: 0,
        local_storage_entry_count: 0,
    };
    let before_export = stable
        .role_session_migration(role_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(
        stable
            .transition_role_session_migration(verified_migration_transition(
                &role_id,
                &transfer_id,
                &forged_evidence,
                crate::RoleSessionMigrationPhase::V22Ready,
                1,
                crate::RoleSessionMigrationPhase::Exported,
                "2026-08-30T04:29:58Z",
            ))
            .unwrap_err()
            .code(),
        "ROLE_SESSION_TRANSFER_VAULT_EVIDENCE_MISSING"
    );
    assert_eq!(
        stable.role_session_migration(role_id.clone()).unwrap(),
        Some(before_export.clone())
    );
    let evidence = publish_empty_session_transfer_vault(
        &stable,
        &role_id,
        &transfer_id,
        migration_platform,
        source_engine,
    );
    assert_eq!(
        stable
            .transition_role_session_migration(verified_migration_transition(
                &role_id,
                &transfer_id,
                &forged_evidence,
                crate::RoleSessionMigrationPhase::V22Ready,
                1,
                crate::RoleSessionMigrationPhase::Exported,
                "2026-08-30T04:29:59Z",
            ))
            .unwrap_err()
            .code(),
        "ROLE_SESSION_TRANSFER_VAULT_EVIDENCE_MISMATCH"
    );
    assert_eq!(
        stable.role_session_migration(role_id.clone()).unwrap(),
        Some(before_export)
    );
    let exported = stable
        .transition_role_session_migration(verified_migration_transition(
            &role_id,
            &transfer_id,
            &evidence,
            crate::RoleSessionMigrationPhase::V22Ready,
            1,
            crate::RoleSessionMigrationPhase::Exported,
            "2026-08-30T04:30:00Z",
        ))
        .unwrap();
    let input = crate::RoleSessionMigrationImportBeginInput {
        role_id: role_id.clone(),
        transfer_id: transfer_id.clone(),
        expected_journal_revision: exported.journal_revision,
    };

    assert_eq!(
        stable
            .begin_role_session_migration_import_internal(input.clone())
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_IMPORT_ADMISSION_UNAVAILABLE"
    );
    assert_eq!(
        stable.role_session_migration(role_id.clone()).unwrap(),
        Some(exported.clone())
    );
    stable.shutdown();

    let opposite_platform = if platform == "darwin" {
        "win32"
    } else {
        "darwin"
    };
    let wrong_platform = Arc::new(
        AppCore::create(migration_gate_options(directory.path(), opposite_platform, 23)).unwrap(),
    );
    assert_eq!(
        wrong_platform
            .begin_role_session_migration_import_internal(input)
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH"
    );
    assert_eq!(
        wrong_platform.role_session_migration(role_id).unwrap(),
        Some(exported)
    );
    wrong_platform.shutdown();
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn source_privileged_boundaries_require_exact_v22_without_mutating_journal_or_vault() {
    let (platform, migration_platform, source_engine) = native_session_migration_test_runtime();
    for runtime_contract_version in [21, 23] {
        let directory = tempfile::tempdir().unwrap();
        let stable =
            Arc::new(AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap());
        let role_id = create_role(&stable, &first_game_id(&stable), 1);
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let start = crate::RoleSessionMigrationStartInput {
            role_id: role_id.clone(),
            transfer_id: transfer_id.clone(),
            platform: migration_platform,
            source_engine,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        };
        stable.start_role_session_migration(start.clone()).unwrap();
        let envelope = empty_session_transfer_envelope(
            &role_id,
            &transfer_id,
            migration_platform,
            source_engine,
        );
        let canonical_envelope = envelope.canonical_envelope_json().unwrap();
        let evidence = stable
            .write_role_session_transfer_vault_internal(&canonical_envelope)
            .unwrap();
        let export = verified_migration_transition(
            &role_id,
            &transfer_id,
            &evidence,
            crate::RoleSessionMigrationPhase::V22Ready,
            1,
            crate::RoleSessionMigrationPhase::Exported,
            "2026-08-30T04:45:00Z",
        );
        let exported = stable
            .transition_role_session_migration(export.clone())
            .unwrap();
        stable.shutdown();

        let unauthorized = AppCore::create(migration_gate_options(
            directory.path(),
            platform,
            runtime_contract_version,
        ))
        .unwrap();
        assert_eq!(
            unauthorized
                .read_role_session_transfer_vault_internal(role_id.clone(), transfer_id.clone(),)
                .unwrap(),
            canonical_envelope,
            "target vault reads must remain available at contract {runtime_contract_version}",
        );
        assert_eq!(
            unauthorized
                .prepare_v22_role_session_migrations_internal()
                .unwrap_err()
                .code(),
            "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        );
        assert_eq!(
            unauthorized
                .start_role_session_migration(start)
                .unwrap_err()
                .code(),
            "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        );
        assert_eq!(
            unauthorized
                .transition_role_session_migration(export)
                .unwrap_err()
                .code(),
            if runtime_contract_version >= 23 {
                "ROLE_SESSION_MIGRATION_TARGET_GENERIC_FORBIDDEN"
            } else {
                "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED"
            },
        );
        assert_eq!(
            unauthorized
                .write_role_session_transfer_vault_internal(&canonical_envelope)
                .unwrap_err()
                .code(),
            "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        );
        assert_eq!(
            unauthorized
                .pending_role_session_transfer_vault_evidence_internal(
                    role_id.clone(),
                    transfer_id.clone(),
                )
                .unwrap_err()
                .code(),
            "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        );
        assert_eq!(
            unauthorized
                .verified_role_session_transfer_vault_evidence_internal(
                    role_id.clone(),
                    transfer_id.clone(),
                )
                .unwrap_err()
                .code(),
            "ROLE_SESSION_MIGRATION_SOURCE_RUNTIME_REQUIRED",
        );
        assert_eq!(
            unauthorized
                .role_session_migration(role_id.clone())
                .unwrap(),
            Some(exported),
            "rejected source authority must not mutate the durable journal",
        );
        assert_eq!(
            unauthorized
                .read_role_session_transfer_vault_internal(role_id, transfer_id)
                .unwrap(),
            canonical_envelope,
            "rejected source authority must not replace the committed vault",
        );
        unauthorized.shutdown();
    }
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn exported_exact_replay_reauthenticates_a_deleted_or_replaced_committed_vault() {
    let (platform, migration_platform, source_engine) = native_session_migration_test_runtime();
    let directory = tempfile::tempdir().unwrap();
    let stable = Arc::new(
        AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
    );
    let role_id = create_role(&stable, &first_game_id(&stable), 1);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    stable
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: role_id.clone(),
            transfer_id: transfer_id.clone(),
            platform: migration_platform,
            source_engine,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        })
        .unwrap();
    let evidence = publish_empty_session_transfer_vault(
        &stable,
        &role_id,
        &transfer_id,
        migration_platform,
        source_engine,
    );
    let export = verified_migration_transition(
        &role_id,
        &transfer_id,
        &evidence,
        crate::RoleSessionMigrationPhase::V22Ready,
        1,
        crate::RoleSessionMigrationPhase::Exported,
        "2026-08-30T04:50:00Z",
    );
    let exported = stable
        .transition_role_session_migration(export.clone())
        .unwrap();
    let vault = directory
        .path()
        .join(".session-migrations")
        .join(&role_id)
        .join(&transfer_id)
        .join("inventory.enc");
    let backup = vault.with_extension("enc.backup");
    let original = std::fs::read(&vault).unwrap();

    std::fs::rename(&vault, &backup).unwrap();
    assert_eq!(
        stable
            .transition_role_session_migration(export.clone())
            .unwrap_err()
            .code(),
        "ROLE_SESSION_TRANSFER_VAULT_NOT_FOUND",
    );
    assert_eq!(
        stable.role_session_migration(role_id.clone()).unwrap(),
        Some(exported.clone()),
    );
    std::fs::rename(&backup, &vault).unwrap();

    let mut replaced = original.clone();
    let last = replaced.last_mut().unwrap();
    *last ^= 0x01;
    std::fs::write(&vault, replaced).unwrap();
    assert_eq!(
        stable
            .transition_role_session_migration(export.clone())
            .unwrap_err()
            .code(),
        "ROLE_SESSION_TRANSFER_VAULT_AUTHENTICATION_FAILED",
    );
    assert_eq!(
        stable.role_session_migration(role_id).unwrap(),
        Some(exported.clone()),
    );

    std::fs::write(&vault, original).unwrap();
    assert_eq!(
        stable.transition_role_session_migration(export).unwrap(),
        exported,
        "contract v22 must retain exact replay after vault authentication succeeds",
    );
    stable.shutdown();
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn a_fully_verified_import_journal_allows_launch_without_new_role_evidence() {
    let (platform, migration_platform, source_engine) = native_session_migration_test_runtime();
    let directory = tempfile::tempdir().unwrap();
    let stable = Arc::new(
        AppCore::create(migration_gate_options(directory.path(), platform, 22)).unwrap(),
    );
    let role_id = create_role(&stable, &first_game_id(&stable), 1);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    stable
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: role_id.clone(),
            transfer_id: transfer_id.clone(),
            platform: migration_platform,
            source_engine,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        })
        .unwrap();
    let evidence = publish_empty_session_transfer_vault(
        &stable,
        &role_id,
        &transfer_id,
        migration_platform,
        source_engine,
    );
    stable
        .transition_role_session_migration(verified_migration_transition(
            &role_id,
            &transfer_id,
            &evidence,
            crate::RoleSessionMigrationPhase::V22Ready,
            1,
            crate::RoleSessionMigrationPhase::Exported,
            "2026-08-30T05:00:01Z",
        ))
        .unwrap();
    stable.shutdown();

    let chromium = Arc::new(
        AppCore::create(migration_gate_options(directory.path(), platform, 23)).unwrap(),
    );
    let bypass = verified_migration_transition(
        &role_id,
        &transfer_id,
        &evidence,
        crate::RoleSessionMigrationPhase::Exported,
        2,
        crate::RoleSessionMigrationPhase::Importing,
        "2026-08-30T05:00:02Z",
    );
    assert_eq!(
        chromium
            .transition_role_session_migration(bypass)
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_TARGET_GENERIC_FORBIDDEN"
    );
    assert_eq!(
        chromium
            .role_session_migration(role_id.clone())
            .unwrap()
            .unwrap()
            .journal_revision,
        2
    );
    let importing = chromium
        .begin_role_session_migration_import_internal(crate::RoleSessionMigrationImportBeginInput {
            role_id: role_id.clone(),
            transfer_id: transfer_id.clone(),
            expected_journal_revision: 2,
        })
        .unwrap();
    assert_eq!(importing.phase, crate::RoleSessionMigrationPhase::Importing);
    assert_eq!(importing.target_revision, Some(1));

    let mut forged_verify = target_migration_transition(
        &role_id,
        &transfer_id,
        crate::RoleSessionMigrationPhase::Importing,
        3,
        crate::RoleSessionMigrationPhase::Verifying,
        "2026-08-30T05:00:02.500Z",
    );
    forged_verify.clean_flush_receipt_id = Some("flush:chromium:1".to_owned());
    assert_eq!(
        chromium
            .transition_role_session_migration_target_internal(forged_verify)
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_FLUSH_RECEIPT_INVALID"
    );
    assert_eq!(
        chromium
            .role_session_migration(role_id.clone())
            .unwrap()
            .unwrap(),
        importing
    );

    for (expected_phase, revision, next_phase, occurred_at) in [
        (
            crate::RoleSessionMigrationPhase::Importing,
            3,
            crate::RoleSessionMigrationPhase::Verifying,
            "2026-08-30T05:00:03Z",
        ),
        (
            crate::RoleSessionMigrationPhase::Verifying,
            4,
            crate::RoleSessionMigrationPhase::V23Ready,
            "2026-08-30T05:00:04Z",
        ),
    ] {
        chromium
            .transition_role_session_migration_target_internal(target_migration_transition(
                &role_id,
                &transfer_id,
                expected_phase,
                revision,
                next_phase,
                occurred_at,
            ))
            .unwrap();
    }
    let ready = chromium
        .role_session_migration(role_id.clone())
        .unwrap()
        .unwrap();
    let mut forged_launch_fence = verified_migration_transition(
        &role_id,
        &transfer_id,
        &evidence,
        crate::RoleSessionMigrationPhase::V23Ready,
        ready.journal_revision,
        crate::RoleSessionMigrationPhase::V23Ready,
        "2026-08-30T05:00:04.500Z",
    );
    forged_launch_fence.mark_first_verified_launch = true;
    assert_eq!(
        chromium
            .transition_role_session_migration(forged_launch_fence)
            .unwrap_err()
            .code(),
        "ROLE_SESSION_MIGRATION_TARGET_GENERIC_FORBIDDEN"
    );
    assert_eq!(
        chromium.role_session_migration(role_id.clone()).unwrap(),
        Some(ready)
    );
    chromium
        .invoke(CoreCommand::BrowserRuntimeRegister {
            registration: chromium_registration(platform, true),
        })
        .unwrap();
    let (launch, actions) = drive_command(
        Arc::clone(&chromium),
        command(json!({
            "type": "embeddedRoleLaunch",
            "roleId": role_id,
            "target": {
                "displayId": 1,
                "workArea": {"x": 0, "y": 0, "width": 1200, "height": 800}
            }
        })),
        None,
    );
    assert!(launch.is_ok(), "{launch:?}");
    assert!(!actions.is_empty());
    chromium.shutdown();
}

#[test]
fn changed_v23_creation_evidence_fails_closed_before_launch_effects() {
    let directory = tempfile::tempdir().unwrap();
    let core =
        Arc::new(AppCore::create(migration_gate_options(directory.path(), "darwin", 23)).unwrap());
    let role_id = create_role(&core, &first_game_id(&core), 1);
    std::fs::write(
        crate::v23_role_initialization::marker_path(directory.path(), &role_id),
        b"{}",
    )
    .unwrap();
    assert_session_migration_blocks_launch(&core, &role_id);
    core.shutdown();
}
