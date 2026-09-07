#[test]
fn initial_upgrade_preserves_role_links_legacy_data_and_admits_one_persistent_session() {
    for platform in ["darwin", "win32"] {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let stable = AppCore::create(migration_gate_options(dir.path(), platform, 22)).unwrap();
        let role = create_role(&stable, &first_game_id(&stable), 1);
        let other = create_role(&stable, &first_game_id(&stable), 2);
        stable.invoke(command(json!({"type":"workspaceCreate","input":{"name":"Retained links","template":"single","slots":[{"roleId":role,"rect":workspace_rect(0,1)}]}}))).unwrap();
        stable.invoke(command(json!({"type":"macroCreate","input":{"name":"Retained macro","executionMode":"selected_roles","roleIds":[role,other],"shortcutSourceScope":{"type":"all_execution_roles"},"trigger":{"code":"F1","ctrl":false,"alt":false,"shift":false,"meta":false},"steps":[{"type":"delay","ms":1000}]}}))).unwrap();
        let legacy = crate::role_browser_data::paths(dir.path(), &role).unwrap();
        std::fs::write(
            std::path::Path::new(&legacy.chromium_user_data_dir).join("unknown-retained-data"),
            b"preserve",
        )
        .unwrap();
        std::fs::write(
            std::path::Path::new(&legacy.webview2_user_data_dir).join("unknown-cookies"),
            b"old",
        )
        .unwrap();
        let before = stable.invoke(CoreCommand::StateSnapshot).unwrap();
        assert_eq!(before["roles"].as_array().unwrap().len(), 2);
        assert_eq!(before["launchWorkspaces"].as_array().unwrap().len(), 1);
        assert_eq!(before["macros"].as_array().unwrap().len(), 1);
        stable.shutdown();
        drop(stable);
        let core =
            Arc::new(AppCore::create(migration_gate_options(dir.path(), platform, 24)).unwrap());
        let attempt = uuid::Uuid::new_v4().to_string();
        let (result, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::RoleSessionRecovery {
                command: crate::RoleSessionRecoveryCommand::Upgrade {
                    role_id: role.clone(),
                    attempt_id: attempt.clone(),
                    expected_journal_revision: None,
                },
            },
            |_| panic!("Unavailable source must not import"),
        );
        assert!(actions.is_empty());
        let record = result.unwrap();
        assert_eq!(record["phase"], "freshReady");
        assert_eq!(record["login"], "notTested");
        assert_eq!(record["upgradeResult"]["cookies"], "unavailable");
        assert!(core.role_session_launch_evidence_ready(&role).unwrap());
        assert!(!core.role_session_launch_evidence_ready(&other).unwrap());
        assert!(core.role_session_migration(role.clone()).unwrap().is_none());
        let after = core.invoke(CoreCommand::StateSnapshot).unwrap();
        for key in ["roles", "launchWorkspaces", "macros"] {
            assert_eq!(before[key], after[key], "{key}");
        }
        let paths = core.resolve_role_paths(&role).unwrap();
        assert_ne!(paths.chromium_user_data_dir, legacy.chromium_user_data_dir);
        assert!(paths.chromium_user_data_dir.contains(&role));
        assert_eq!(
            std::fs::read(
                std::path::Path::new(&legacy.chromium_user_data_dir).join("unknown-retained-data")
            )
            .unwrap(),
            b"preserve"
        );
        assert_eq!(
            std::fs::read(
                std::path::Path::new(&legacy.webview2_user_data_dir).join("unknown-cookies")
            )
            .unwrap(),
            b"old"
        );
        let current = std::path::Path::new(&paths.chromium_user_data_dir).join("new-login");
        std::fs::write(&current, b"keep-current-session").unwrap();
        core.mark_role_session_launch_admitted(std::slice::from_ref(&role))
            .unwrap();
        let evidence = core.fresh_session_evidence(&role).unwrap().unwrap();
        assert!(evidence.payload["firstLaunchAdmittedAt"].is_string());
        core.shutdown();
        drop(core);
        let core =
            Arc::new(AppCore::create(migration_gate_options(dir.path(), platform, 24)).unwrap());
        let (again, actions, _) = drive_async_command_with(
            Arc::clone(&core),
            CoreCommand::RoleSessionRecovery {
                command: crate::RoleSessionRecoveryCommand::Upgrade {
                    role_id: role.clone(),
                    attempt_id: uuid::Uuid::new_v4().to_string(),
                    expected_journal_revision: None,
                },
            },
            |_| panic!("Completed upgrade cannot import again"),
        );
        assert!(actions.is_empty());
        assert_eq!(again.unwrap(), record);
        assert_eq!(
            core.fresh_session_evidence(&role).unwrap().unwrap().payload,
            evidence.payload
        );
        assert_eq!(json!(core.resolve_role_paths(&role).unwrap()), json!(paths));
        assert_eq!(std::fs::read(current).unwrap(), b"keep-current-session");
        assert!(core.role_session_migration(role).unwrap().is_none());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn failed_upgrade_import_is_classified_without_blocking_or_rewriting_original_journal() {
    let (_dir, core, role, other, before) = recovery_fixture();
    let (result, _, _) = drive_async_command_with(
        Arc::clone(&core),
        CoreCommand::RoleSessionRecovery {
            command: crate::RoleSessionRecoveryCommand::Upgrade {
                role_id: role.clone(),
                attempt_id: uuid::Uuid::new_v4().to_string(),
                expected_journal_revision: Some(before.journal_revision),
            },
        },
        |effect| CoreEffectResult {
            effect_id: effect.effect_id,
            operation_id: effect.operation_id,
            ok: false,
            value_json: None,
            error: Some(CoreErrorPayload {
                code: "SYNTHETIC_IMPORT_FAILED".to_owned(),
                message: "Synthetic failure".to_owned(),
            }),
        },
    );
    let result = result.unwrap();
    assert_eq!(result["phase"], "freshReady");
    assert!(core.role_session_launch_evidence_ready(&role).unwrap());
    assert!(!core.role_session_launch_evidence_ready(&other).unwrap());
    assert_eq!(core.role_session_migration(role).unwrap(), Some(before));
    assert_eq!(result["upgradeResult"]["cookieCount"], 0);
    assert_ne!(result["upgradeResult"]["cookies"], "transferred");
}

#[test]
fn upgrade_interruption_and_exact_publication_resume_do_not_reimport_or_reset() {
    for platform in ["darwin", "win32"] {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let stable = AppCore::create(migration_gate_options(dir.path(), platform, 22)).unwrap();
        let role = create_role(&stable, &first_game_id(&stable), 1);
        stable.shutdown();
        drop(stable);
        let core =
            Arc::new(AppCore::create(migration_gate_options(dir.path(), platform, 24)).unwrap());
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: format!("session-fresh-{}", uuid::Uuid::new_v4()),
                kind: crate::session_recovery::fresh::KIND.to_owned(),
                phase: "preparing".to_owned(),
                payload: json!({"evidence":{"roleId":role},"result":{"phase":"reading"}}),
            })
        })
        .unwrap();
        let run = |expected| {
            drive_async_command_with(
                Arc::clone(&core),
                CoreCommand::RoleSessionRecovery {
                    command: crate::RoleSessionRecoveryCommand::Upgrade {
                        role_id: role.clone(),
                        attempt_id: uuid::Uuid::new_v4().to_string(),
                        expected_journal_revision: expected,
                    },
                },
                |_| panic!("Interrupted source must not be replayed"),
            )
        };
        assert_eq!(
            run(Some(42)).0.unwrap()["blockers"][0],
            "RECOVERY_JOURNAL_STALE"
        );
        assert!(core.fresh_session_evidence(&role).unwrap().is_none());
        let result = run(None).0.unwrap();
        assert_eq!(result["phase"], "freshReady");
        assert_eq!(
            result["upgradeResult"]["reasons"],
            json!(["PREVIOUS_UPGRADE_INTERRUPTED"])
        );
        let paths = core.resolve_role_paths(&role).unwrap();
        let mut publication = core.fresh_session_evidence(&role).unwrap().unwrap();
        publication.phase = "preparing".to_owned();
        core.with_runtime(|runtime| runtime.state.put_operation_journal(publication))
            .unwrap();
        assert!(!core.role_session_launch_evidence_ready(&role).unwrap());
        assert_eq!(run(None).0.unwrap(), result);
        assert!(core.role_session_launch_evidence_ready(&role).unwrap());
        assert_eq!(
            core.resolve_role_paths(&role)
                .unwrap()
                .chromium_user_data_dir,
            paths.chromium_user_data_dir
        );
        assert!(core.role_session_migration(role).unwrap().is_none());
    }
}
