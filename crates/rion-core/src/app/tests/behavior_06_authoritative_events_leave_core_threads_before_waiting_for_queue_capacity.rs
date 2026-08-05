#[test]
    fn authoritative_events_leave_core_threads_before_waiting_for_queue_capacity() {
        let authoritative = [
            CoreEvent::CoreEffects {
                effects: Vec::new(),
            },
            CoreEvent::StateChanged {
                revision: 2,
                changed_collections: Vec::new(),
            },
            CoreEvent::BrowserStatuses {
                statuses: Vec::new(),
            },
            CoreEvent::MacroStatuses {
                reliable: true,
                statuses: Vec::new(),
            },
        ];

        for event in authoritative {
            let (sender, receiver) = bounded(1);
            let subscribers = Arc::new(Mutex::new(vec![sender]));
            broadcast_events(&subscribers, vec![CoreEvent::Ready { schema_version: 1 }]);
            let expected = std::mem::discriminant(&event);
            let dispatcher = start_event_dispatcher(Arc::clone(&subscribers)).unwrap();
            let (published_tx, published_rx) = std::sync::mpsc::channel();
            thread::spawn(move || {
                publish_events(&dispatcher, vec![event]);
                published_tx.send(()).unwrap();
            });

            published_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("event producers must not wait for subscriber capacity");

            assert!(matches!(
                receiver.recv_timeout(Duration::from_secs(1)).unwrap()[0],
                CoreEvent::Ready { .. }
            ));
            let delivered = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(std::mem::discriminant(&delivered[0]), expected);
        }
    }

    #[test]
    fn browser_actions_are_routed_to_the_worker_and_not_public_subscribers() {
        let (action_sender, action_receiver) = bounded(1);
        let (event_sender, event_receiver) = bounded(1);
        let subscribers = Mutex::new(vec![event_sender]);
        let action = crate::model::BrowserActionRequest {
            request_id: "health-1".to_owned(),
            role_id: "role-1".to_owned(),
            origin: "macro".to_owned(),
            input_epoch: 0,
            intent: "normal".to_owned(),
            scheduled_at_ms: 1,
            deadline_ms: 2,
            action: crate::model::BrowserAction::Focus,
        };

        route_browser_action_events(
            vec![
                CoreEvent::BrowserActions {
                    actions: vec![action.clone()],
                },
                CoreEvent::Ready { schema_version: 1 },
            ],
            &action_sender,
            &start_event_dispatcher(Arc::new(subscribers)).unwrap(),
        );

        let routed_actions = action_receiver.recv().unwrap();
        assert_eq!(routed_actions.len(), 1);
        assert_eq!(routed_actions[0].request_id, action.request_id);
        assert_eq!(routed_actions[0].role_id, action.role_id);
        assert_eq!(routed_actions[0].origin, action.origin);
        let public_events = event_receiver.recv().unwrap();
        assert!(
            public_events
                .iter()
                .all(|event| !matches!(event, CoreEvent::BrowserActions { .. }))
        );
        assert!(
            public_events
                .iter()
                .any(|event| matches!(event, CoreEvent::Ready { .. }))
        );
    }

    #[test]
    fn chrome_import_auth_outcomes_never_report_rejected_or_unknown_sessions_as_imported() {
        for (auth_state, expected) in [
            (
                ChromeProfileImportAuthStateRecord::Authenticated,
                "imported",
            ),
            (
                ChromeProfileImportAuthStateRecord::NotAuthenticated,
                "needsLogin",
            ),
            (
                ChromeProfileImportAuthStateRecord::Indeterminate,
                "needsLogin",
            ),
            (
                ChromeProfileImportAuthStateRecord::NotApplicable,
                "imported",
            ),
        ] {
            assert_eq!(chrome_import_status(auth_state), expected);
        }
    }

    #[test]
    fn chrome_import_effect_timeout_exceeds_the_native_navigation_bound() {
        assert!(
            CHROME_PROFILE_IMPORT_EFFECT_TIMEOUT > Duration::from_secs(40),
            "the core must not time out while the native System WebView is still within its navigation deadline"
        );
    }

    #[test]
    fn committed_chrome_import_reports_cleanup_as_warnings_without_losing_recovery_marker() {
        let staging_called = std::cell::Cell::new(false);
        let mut warnings = Vec::new();

        finalize_chrome_import_post_commit(
            &mut warnings,
            || Err(CoreError::Internal("journal cleanup failed".to_owned())),
            || {
                staging_called.set(true);
                Ok(())
            },
            || Err(CoreError::Internal("operation cleanup failed".to_owned())),
        );

        assert!(!staging_called.get());
        assert_eq!(
            warnings,
            [
                "SESSION_IMPORT_JOURNAL_CLEANUP_PENDING",
                "BROWSER_OPERATION_CLEANUP_PENDING"
            ]
        );

        let mut warnings = Vec::new();
        finalize_chrome_import_post_commit(
            &mut warnings,
            || Ok(()),
            || Err(std::io::Error::from(ErrorKind::PermissionDenied)),
            || Ok(()),
        );
        assert_eq!(warnings, ["SESSION_IMPORT_STAGING_CLEANUP_PENDING"]);
    }

    #[test]
    fn post_apply_chrome_import_auth_retries_a_transient_login_redirect_on_both_platforms() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let (auth_state, actions) = drive_post_apply_chrome_import_auth(
                Arc::clone(&core),
                vec![
                    ChromeProfileImportAuthStateRecord::NotAuthenticated,
                    ChromeProfileImportAuthStateRecord::Authenticated,
                ],
            );

            assert_eq!(
                auth_state,
                ChromeProfileImportAuthStateRecord::Authenticated,
                "{platform} must accept the rehydrated session during the same import"
            );
            assert_eq!(actions.len(), 2, "{platform} must retry exactly once");
            core.shutdown();
        }
    }

    #[test]
    fn post_apply_chrome_import_auth_retry_is_bounded_and_skips_indeterminate_results() {
        for platform in ["darwin", "win32"] {
            for (auth_state, expected_attempts) in [
                (ChromeProfileImportAuthStateRecord::NotAuthenticated, 3),
                (ChromeProfileImportAuthStateRecord::Indeterminate, 1),
            ] {
                let (_directory, core) = core_for_platform(platform);
                let (result, actions) =
                    drive_post_apply_chrome_import_auth(Arc::clone(&core), vec![auth_state]);

                assert_eq!(result, auth_state, "{platform} must preserve the result");
                assert_eq!(
                    actions.len(),
                    expected_attempts,
                    "{platform} must keep retries bounded"
                );
                core.shutdown();
            }
        }
    }

    #[test]
    fn flyff_chrome_import_preserves_an_already_authenticated_role() {
        for platform in ["darwin", "win32"] {
            let (directory, core) = core_for_platform(platform);
            let source = directory.path().join("chrome-source");
            create_chrome_import_fixture(&source);
            let game_id = flyff_game_id(&core);
            let role_id = core
                .invoke(command(json!({
                    "type": "roleCreate",
                    "input": {
                        "gameId": game_id,
                        "name": "Main",
                        "launchUrl": "https://universe.flyff.com/play"
                    }
                })))
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let (import_id, profile_id) = preview_chrome_import(&core, &source);
            let (result, actions, _) = drive_async_command_with(
                Arc::clone(&core),
                CoreCommand::ChromeProfileApply {
                    import_id,
                    game_id,
                    consent_accepted: true,
                    resolutions: vec![ChromeProfileImportResolutionRecord::Replace {
                        profile_id,
                        target_role_id: role_id,
                    }],
                },
                |effect| chrome_import_effect_result(effect, "authenticated"),
            );
            let result = result.unwrap();
            assert_eq!(result["items"][0]["status"], json!("alreadyAuthenticated"));
            assert_eq!(result["items"][0]["cookieCount"], json!(0));
            assert_eq!(actions.len(), 1, "{platform} must skip every mutation");
            assert!(matches!(
                actions[0],
                CoreEffectAction::ChromeProfileImportVerify { .. }
            ));
            core.shutdown();
        }
    }

    #[test]
    fn session_transfer_cleanup_preserves_only_journaled_transactions() {
        let (directory, core) = core();
        let active = uuid::Uuid::new_v4().to_string();
        let orphan = uuid::Uuid::new_v4().to_string();
        let root = directory.path().join(".session-transfers");
        fs::create_dir_all(root.join(&active)).unwrap();
        fs::create_dir_all(root.join(&orphan)).unwrap();
        fs::write(root.join(&active).join("backup.enc"), b"active").unwrap();
        fs::write(root.join(&orphan).join("backup.enc"), b"orphan").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-import-active".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "applying".to_owned(),
                payload: json!({ "transactionId": active.clone() }),
            })
        })
        .unwrap();

        core.cleanup_orphaned_session_transfer_directories()
            .unwrap();
        assert!(root.join(&active).is_dir());
        assert!(!root.join(&orphan).exists());
    }

    #[test]
    fn every_chrome_import_journal_phase_blocks_role_launch_until_recovery() {
        let (_directory, core) = core();
        for phase in [
            "prepared",
            "snapshotted",
            "applying",
            "verified",
            "metadataCommitted",
            "committing",
        ] {
            core.with_runtime(|runtime| {
                runtime.state.put_operation_journal(OperationJournalRecord {
                    id: format!("chrome-import-{phase}"),
                    kind: "chrome_profile_import_v2".to_owned(),
                    phase: phase.to_owned(),
                    payload: json!({
                        "roleId": "role-1",
                        "transactionId": uuid::Uuid::new_v4().to_string()
                    }),
                })
            })
            .unwrap();
            assert_eq!(
                core.ensure_role_session_recovery_complete("role-1")
                    .unwrap_err()
                    .code(),
                "ROLE_SESSION_RECOVERY_REQUIRED"
            );
            core.with_runtime(|runtime| {
                runtime
                    .state
                    .delete_operation_journal(format!("chrome-import-{phase}"))
            })
            .unwrap();
        }
    }

    #[test]
    fn every_uncommitted_chrome_import_phase_rolls_back_and_clears_its_journal() {
        for phase in [
            "prepared",
            "snapshotted",
            "applying",
            "verified",
            "metadataCommitted",
            "committing",
        ] {
            let (directory, core) = core();
            let role_id = create_role(&core, &first_game_id(&core), 1);
            let transaction_id = uuid::Uuid::new_v4().to_string();
            let transfer = directory
                .path()
                .join(".session-transfers")
                .join(&transaction_id);
            fs::create_dir_all(&transfer).unwrap();
            fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
            core.with_runtime(|runtime| {
                runtime.state.put_operation_journal(OperationJournalRecord {
                    id: format!("chrome-recovery-{phase}"),
                    kind: "chrome_profile_import_v2".to_owned(),
                    phase: phase.to_owned(),
                    payload: json!({
                        "roleId": role_id,
                        "transactionId": transaction_id,
                        "launchUrl": "https://example.com/play",
                        "createdRole": false
                    }),
                })
            })
            .unwrap();

            let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), false);
            assert_eq!(result.unwrap(), json!({ "recovered": 1, "pending": 0 }));
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::ChromeProfileImportRollback { role_id: current, .. }
                    if current == &role_id
            )));
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
            assert!(!transfer.exists());
            core.shutdown();
        }
    }

    #[test]
    fn committed_chrome_import_marker_finalizes_without_rollback() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let transfer = directory
            .path()
            .join(".session-transfers")
            .join(&transaction_id);
        fs::create_dir_all(&transfer).unwrap();
        fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
        fs::write(transfer.join("committed"), b"").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-recovery-committed".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "committing".to_owned(),
                payload: json!({
                    "roleId": role_id,
                    "transactionId": transaction_id,
                    "launchUrl": "https://example.com/play",
                    "createdRole": false
                }),
            })
        })
        .unwrap();

        let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), false);
        assert_eq!(result.unwrap(), json!({ "recovered": 1, "pending": 0 }));
        assert!(actions.is_empty());
        assert!(core.invoke(CoreCommand::RoleGet { id: role_id }).is_ok());
        assert!(!transfer.exists());
        core.shutdown();
    }

    #[test]
    fn failed_chrome_import_rollback_remains_pending_and_keeps_encrypted_recovery_data() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let transfer = directory
            .path()
            .join(".session-transfers")
            .join(&transaction_id);
        fs::create_dir_all(&transfer).unwrap();
        fs::write(transfer.join("backup.enc"), b"encrypted-backup-fixture").unwrap();
        core.with_runtime(|runtime| {
            runtime.state.put_operation_journal(OperationJournalRecord {
                id: "chrome-recovery-pending".to_owned(),
                kind: "chrome_profile_import_v2".to_owned(),
                phase: "applying".to_owned(),
                payload: json!({
                    "roleId": role_id,
                    "transactionId": transaction_id,
                    "launchUrl": "https://example.com/play",
                    "createdRole": false
                }),
            })
        })
        .unwrap();

        let (result, actions) = drive_chrome_import_recovery(Arc::clone(&core), true);
        assert_eq!(result.unwrap(), json!({ "recovered": 0, "pending": 1 }));
        assert!(
            actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::ChromeProfileImportRollback { .. }
            ))
        );
        assert_eq!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .len(),
            1
        );
        assert!(transfer.join("backup.enc").is_file());
        core.shutdown();
    }

    #[test]
    fn runtime_game_window_save_accepts_a_detached_live_window_without_a_core_shell() {
        for platform in ["darwin", "win32"] {
            let (_directory, core) = core_for_platform(platform);
            let game_id = first_game_id(&core);
            let role_id = create_role(&core, &game_id, 1);
            let window_id = uuid::Uuid::new_v4().to_string();
            let tab_id = uuid::Uuid::new_v4().to_string();
            let input: GameWindowSaveRuntimeInputRecord = serde_json::from_value(json!({
                "windowId": window_id,
                "name": format!("Detached Live Window {platform}"),
                "targetDisplay": { "id": 1 },
                "placement": {
                    "normalBounds": { "x": 0, "y": 0, "width": 960, "height": 640 },
                    "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                    "presentation": "normal"
                },
                "tabs": [{
                    "id": tab_id,
                    "tabType": "role",
                    "sourceId": role_id,
                    "name": "Detached Role",
                    "roleSlots": [{
                        "slotId": format!("role:{role_id}"),
                        "roleId": role_id,
                        "rect": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                        "browserZoomPercent": 100.0
                    }],
                    "hidden": false,
                    "audioMuted": true
                }],
                "activeTabId": tab_id
            }))
            .unwrap();

            let before = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert!(before["windows"].as_array().unwrap().is_empty(), "{platform}");

            let saved = core
                .invoke(CoreCommand::GameWindowSaveRuntime { input })
                .unwrap();
            assert_eq!(saved["id"], window_id, "{platform}");
            assert_eq!(saved["activeTabId"], tab_id, "{platform}");
            assert_eq!(saved["tabs"][0]["sourceId"], role_id, "{platform}");

            let after = core.invoke(CoreCommand::BrowserRuntimeSnapshot).unwrap();
            assert!(after["windows"].as_array().unwrap().is_empty(), "{platform}");
        }
    }
