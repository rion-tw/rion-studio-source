#[cfg(target_os = "macos")]
fn recovery_fixture() -> (
    TempDir,
    Arc<AppCore>,
    String,
    String,
    crate::RoleSessionMigrationRecord,
) {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let stable = AppCore::create(migration_gate_options(dir.path(), "darwin", 22)).unwrap();
    let role = create_role(&stable, &first_game_id(&stable), 1);
    let other = create_role(&stable, &first_game_id(&stable), 2);
    let transfer = uuid::Uuid::new_v4().to_string();
    let source = stable
        .start_role_session_migration(crate::RoleSessionMigrationStartInput {
            role_id: role.clone(),
            transfer_id: transfer.clone(),
            platform: crate::RoleSessionMigrationPlatform::Macos,
            source_engine: crate::RoleSessionMigrationEngine::Wkwebview,
            target_engine: crate::RoleSessionMigrationEngine::Chromium,
            source_revision: 1,
        })
        .unwrap();
    let evidence = publish_empty_session_transfer_vault(
        &stable,
        &role,
        &transfer,
        source.platform,
        source.source_engine,
    );
    let mut export = crate::session_recovery::stage::transition_input(
        &source,
        crate::RoleSessionMigrationPhase::Exported,
    );
    evidence.apply_to_transition(&mut export).unwrap();
    let exported = stable.transition_role_session_migration(export).unwrap();
    let importing = stable
        .with_runtime(|runtime| {
            runtime.state.begin_role_session_migration_import(
                source.platform,
                crate::CHROMIUM_RUNTIME_CONTRACT_VERSION,
                crate::RoleSessionMigrationImportBeginInput {
                    role_id: role.clone(),
                    transfer_id: transfer,
                    expected_journal_revision: exported.journal_revision,
                },
            )
        })
        .unwrap();
    let mut fail = crate::session_recovery::stage::transition_input(
        &importing,
        crate::RoleSessionMigrationPhase::Failed,
    );
    fail.outcome = Some(crate::RoleSessionMigrationOutcome::Failed);
    fail.stable_error_code = Some("RECOVERY_SYNTHETIC_FAILURE".to_owned());
    let failed = stable
        .with_runtime(|runtime| {
            runtime.state.transition_role_session_migration(
                crate::session_migration::TransitionAuthority::TargetRuntime {
                    expected_platform: source.platform,
                },
                fail,
            )
        })
        .unwrap();
    stable.shutdown();
    drop(stable);
    let core = Arc::new(
        AppCore::create(migration_gate_options(
            dir.path(),
            "darwin",
            crate::CHROMIUM_RUNTIME_CONTRACT_VERSION,
        ))
        .unwrap(),
    );
    (dir, core, role, other, failed)
}
#[cfg(target_os = "macos")]
#[test]
fn session_recovery_core_orders_two_isolated_and_formal_receipts_without_launch() {
    if !crate::session_recovery::source::native_support(rion_platform::Platform::Macos) {
        return;
    }
    for fail_at in [None, Some(1), Some(2)] {
        let (_dir, core, role, other, before) = recovery_fixture();
        let inspected = core.session_recovery_inspect(&role).unwrap();
        let candidate = inspected.candidates.iter().find(|c| c.supported).unwrap();
        let attempt = uuid::Uuid::new_v4().to_string();
        let mut calls = 0;
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::RoleSessionRecovery {
                command: crate::RoleSessionRecoveryCommand::Recover {
                    role_id: role.clone(),
                    attempt_id: attempt.clone(),
                    expected_journal_revision: Some(before.journal_revision),
                    source_token: candidate.token.clone(),
                },
            },
            |effect| {
                calls += 1;
                assert_eq!(
                    effect.completion_policy,
                    crate::model::OperationCompletionPolicy::EventBound
                );
                let CoreEffectAction::RoleSessionRecoveryImport {
                    ref role_id,
                    ref attempt_id,
                    ref transfer_id,
                    best_effort_cookies,
                } = effect.action
                else {
                    panic!("unexpected effect")
                };
                assert_eq!(role_id, &role);
                assert_eq!(attempt_id, &attempt);
                assert!(!best_effort_cookies);
                if calls == 1 {
                    assert_eq!(
                        core.role_session_migration(role.clone()).unwrap(),
                        Some(before.clone())
                    );
                }
                let bytes = core
                    .read_role_session_recovery_internal(
                        role.clone(),
                        attempt.clone(),
                        transfer_id.clone(),
                    )
                    .unwrap();
                let descriptor: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(descriptor["journal"]["transferId"], json!(transfer_id));
                CoreEffectResult {effect_id:effect.effect_id,operation_id:effect.operation_id,ok:fail_at!=Some(calls),
                value_json:(fail_at!=Some(calls)).then(||json!({"roleId":role,"attemptId":attempt,"transferId":transfer_id,"cleanFlushReceiptId":format!("chromium-cookie-flush:{transfer_id}:1"),"cookieCount":2,"cookieSkippedCount":0}).to_string()),
                error:(fail_at==Some(calls)).then(||CoreErrorPayload{code:"RECOVERY_SYNTHETIC_HELPER_FAILED".to_owned(),message:"Synthetic helper failed".to_owned()}),
            }
            },
        );
        let result = result.unwrap();
        assert_eq!(
            result["phase"],
            json!(if fail_at.is_none() {
                "complete"
            } else {
                "failed"
            })
        );
        assert_eq!(actions.len(), if fail_at == Some(1) { 1 } else { 2 });
        assert_eq!(core.role_session_migration(other).unwrap(), None);
        let current = core.role_session_migration(role.clone()).unwrap().unwrap();
        match fail_at {
            None => assert_eq!(current.phase, crate::RoleSessionMigrationPhase::V23Ready),
            Some(1) => assert_eq!(current, before),
            Some(2) => assert_eq!(
                current.phase,
                crate::RoleSessionMigrationPhase::Indeterminate
            ),
            _ => unreachable!(),
        }
        assert!(current.first_verified_launch_at.is_none());
        assert!(core.browser_statuses().unwrap().is_empty());
        assert!(
            core.read_role_session_recovery_internal(role, attempt, current.transfer_id)
                .is_err()
        );
        core.shutdown();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn session_recovery_cancel_and_replay_preserve_formal_source() {
    if !crate::session_recovery::source::native_support(rion_platform::Platform::Macos) {
        return;
    }
    let (_dir, core, role, other, before) = recovery_fixture();
    let inspected = core.session_recovery_inspect(&role).unwrap();
    let token = inspected.candidates[0].token.clone();
    let attempt = uuid::Uuid::new_v4().to_string();
    let command = CoreCommand::RoleSessionRecovery {
        command: crate::RoleSessionRecoveryCommand::Recover {
            role_id: role.clone(),
            attempt_id: attempt.clone(),
            expected_journal_revision: Some(before.journal_revision),
            source_token: token,
        },
    };
    let (result, actions, _) =
        drive_async_command_with(Arc::clone(&core), command.clone(), |effect| {
            let cancelled = core
                .invoke(CoreCommand::RoleSessionRecovery {
                    command: crate::RoleSessionRecoveryCommand::Cancel {
                        role_id: role.clone(),
                        attempt_id: attempt.clone(),
                    },
                })
                .unwrap();
            assert_eq!(cancelled["phase"], "isolatedImport");
            CoreEffectResult {
                effect_id: effect.effect_id,
                operation_id: effect.operation_id,
                ok: false,
                value_json: None,
                error: Some(CoreErrorPayload {
                    code: "CANCELLED_TEST".to_owned(),
                    message: "cancelled".to_owned(),
                }),
            }
        });
    assert_eq!(result.unwrap()["phase"], "cancelled");
    assert_eq!(actions.len(), 1);
    assert_eq!(
        core.role_session_migration(role.clone()).unwrap(),
        Some(before.clone())
    );
    assert_eq!(core.role_session_migration(other).unwrap(), None);
    let (replayed, effects, _) = drive_async_command(Arc::clone(&core), command, None);
    assert_eq!(
        replayed.unwrap()["blockers"],
        json!(["RECOVERY_ATTEMPT_EXISTS"])
    );
    assert!(effects.is_empty());
    assert_eq!(core.role_session_migration(role).unwrap(), Some(before));
    core.shutdown();
}

#[cfg(target_os = "macos")]
#[test]
fn session_recovery_reading_cancellation_never_admits_or_imports() {
    if !crate::session_recovery::source::native_support(rion_platform::Platform::Macos) {
        return;
    }
    let (_dir, core, role, other, before) = recovery_fixture();
    let token = core.session_recovery_inspect(&role).unwrap().candidates[0]
        .token
        .clone();
    let attempt = uuid::Uuid::new_v4().to_string();
    let receiver = core.subscribe().unwrap();
    let invocation_core = Arc::clone(&core);
    let command = CoreCommand::RoleSessionRecovery {
        command: crate::RoleSessionRecoveryCommand::Recover {
            role_id: role.clone(),
            attempt_id: attempt.clone(),
            expected_journal_revision: Some(before.journal_revision),
            source_token: token,
        },
    };
    let invocation = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(invocation_core.invoke_async(command))
    });
    loop {
        let events = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("missing recovery admission event");
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, CoreEvent::CoreEffects { .. }))
        );
        if events.iter().any(|event| matches!(event, CoreEvent::RoleSessionRecoveryChanged { record } if record.phase == "reading")) {
            core.invoke(CoreCommand::RoleSessionRecovery { command: crate::RoleSessionRecoveryCommand::Cancel { role_id: role.clone(), attempt_id: attempt.clone() } }).unwrap();
            break;
        }
    }
    assert_eq!(invocation.join().unwrap().unwrap()["phase"], "cancelled");
    assert_eq!(
        core.role_session_migration(role.clone()).unwrap(),
        Some(before)
    );
    assert_eq!(core.role_session_migration(other).unwrap(), None);
    assert!(
        !core
            .session_recovery_lock()
            .unwrap()
            .active
            .contains_key(&role)
    );
    let history = core
        .with_runtime(|runtime| runtime.state.operation_journals())
        .unwrap();
    assert!(history.iter().any(
        |journal| journal.id == format!("session-recovery-{attempt}")
            && journal.phase == "cancelled"
    ));
    core.shutdown();
}
