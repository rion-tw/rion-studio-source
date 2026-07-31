#[test]
    fn role_creation_and_selected_browser_directory_reset_match_v1() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let first_id = create_role(&core, &game_id, 1);
        let second_id = create_role(&core, &game_id, 2);
        let first_browser = directory
            .path()
            .join("roles")
            .join(&first_id)
            .join("browser");
        let second_browser = directory
            .path()
            .join("roles")
            .join(&second_id)
            .join("browser");

        crate::v1_case!("state-migration-2847be74e6ef", {
            let role: StateRoleRecord = serde_json::from_value(
                core.invoke(CoreCommand::RoleGet {
                    id: first_id.clone(),
                })
                .unwrap(),
            )
            .unwrap();
            assert!(first_browser.is_dir());
            let value = serde_json::to_value(role).unwrap();
            assert!(value.get("windowWidth").is_none());
            assert!(value.get("windowHeight").is_none());
            assert!(value.get("launchPreset").is_none());
        });

        fs::write(first_browser.join("session"), b"first").unwrap();
        fs::write(second_browser.join("session"), b"second").unwrap();
        core.invoke(CoreCommand::RoleBrowserDirectoryReset {
            id: first_id.clone(),
        })
        .unwrap();

        crate::v1_case!("state-migration-022970179dc8", {
            assert!(first_browser.is_dir());
            assert!(!first_browser.join("session").exists());
            assert_eq!(fs::read(second_browser.join("session")).unwrap(), b"second");
            assert!(
                core.invoke(CoreCommand::RoleGet {
                    id: first_id.clone()
                })
                .is_ok()
            );
        });
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_role_deletions_do_not_restore_either_role() {
        let (directory, core) = core();
        let game_id = first_game_id(&core);
        let first_id = create_role(&core, &game_id, 1);
        let second_id = create_role(&core, &game_id, 2);
        let first_core = Arc::clone(&core);
        let second_core = Arc::clone(&core);
        let first = first_core.invoke_async(CoreCommand::RoleDelete {
            id: first_id.clone(),
        });
        let second = second_core.invoke_async(CoreCommand::RoleDelete {
            id: second_id.clone(),
        });
        let (first_result, second_result) = tokio::join!(first, second);

        crate::v1_case!("state-migration-badd3d9837fd", {
            first_result.unwrap();
            second_result.unwrap();
            assert!(
                core.invoke(CoreCommand::RolesList)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert!(!directory.path().join("roles").join(first_id).exists());
            assert!(!directory.path().join("roles").join(second_id).exists());
        });
        core.shutdown();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn runtime_aware_role_delete_restores_data_and_lease_when_sqlite_commit_fails() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let connection = rusqlite::Connection::open(&core.database_paths.state).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_role_delete
                 BEFORE DELETE ON roles
                 BEGIN
                   SELECT RAISE(ABORT, 'fixture rejects role deletion');
                 END;",
            )
            .unwrap();
        drop(connection);

        let error = core
            .clone()
            .invoke_async(CoreCommand::RoleDelete {
                id: role_id.clone(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), "CORE_STATE_DATABASE_FAILED");
        assert_eq!(
            fs::read(browser.join("session")).unwrap(),
            b"signed-in".to_vec()
        );
        assert_eq!(
            core.invoke(CoreCommand::RolesList)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );

        let lease = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&lease.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn game_browser_setting_patches_merge_non_font_sections_atomically() {
        let (_directory, core) = core();
        let initial = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
        let initial_fonts = initial["fonts"].clone();
        let workspace_core = Arc::clone(&core);
        let performance_core = Arc::clone(&core);

        let workspace = thread::spawn(move || {
            workspace_core.invoke(command(json!({
                "type": "gameBrowserSettingsPatch",
                "patch": { "workspace": { "background": "black", "gap": 12 } }
            })))
        });
        let performance = thread::spawn(move || {
            performance_core.invoke(command(json!({
                "type": "gameBrowserSettingsPatch",
                "patch": { "performance": { "macosHighRefreshRate": true } }
            })))
        });
        workspace.join().unwrap().unwrap();
        performance.join().unwrap().unwrap();
        core.invoke(command(json!({
            "type": "gameBrowserSettingsPatch",
            "patch": {
                "macroBadgePosition": {
                    "horizontalAlign": "right",
                    "horizontalMarginPx": 16,
                    "topPx": 240
                }
            }
        })))
        .unwrap();

        let settings = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
        assert_eq!(settings["fonts"], initial_fonts);
        assert_eq!(
            settings["workspace"],
            json!({ "background": "black", "gap": 12 })
        );
        assert_eq!(settings["performance"]["macosHighRefreshRate"], true);
        assert_eq!(settings["macroBadgePosition"]["horizontalAlign"], "right");
        core.shutdown();
    }

    #[test]
    fn overlay_requests_validate_and_return_rust_projected_view_models_and_ui_effects() {
        let (_directory, core) = core();
        let game_id = first_game_id(&core);
        let role_id = create_role(&core, &game_id, 1);
        let unassigned_role_id = create_role(&core, &game_id, 2);
        let macro_record = core
            .invoke(command(json!({
                "type": "macroCreate",
                "input": {
                    "name": "Overlay macro",
                    "roleIds": [role_id.clone()],
                    "steps": [{"type": "delay", "ms": 10}]
                }
            })))
            .unwrap();
        let macro_id = macro_record["id"].as_str().unwrap().to_owned();
        let mut settings = core.invoke(CoreCommand::GameBrowserSettingsGet).unwrap();
        settings["macroBadgePosition"] =
            json!({"horizontalAlign":"right","horizontalMarginPx":80,"topPx":280});
        core.invoke(command(json!({
            "type": "gameBrowserSettingsReplace",
            "settings": settings
        })))
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let view = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"list\"}",
                "language": "zh-TW"
            }))))
            .unwrap();
        assert_eq!(view["language"], "zh-TW");
        assert_eq!(view["resolvedTheme"], "light");
        assert_eq!(view["macros"][0]["id"], macro_id);
        assert_eq!(view["statuses"], json!([]));
        crate::v1_case!("overlay-ff7db98ddb5f", {
            assert_eq!(view["macroBadgePosition"]["horizontalAlign"], "right");
            assert!(view["macroBadgePosition"]["topPx"].is_number());
        });
        crate::v1_case!("overlay-368345bae2c9", {
            assert_eq!(view["statuses"], json!([]));
        });

        core.invoke(CoreCommand::RuntimeThemeSet {
            theme: "dark".to_owned(),
        })
        .unwrap();
        let themed_view = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"list\"}"
            }))))
            .unwrap();
        assert_eq!(themed_view["resolvedTheme"], "dark");

        let error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"start\",\"macroId\":\"not-assigned\"}"
            }))))
            .unwrap_err();
        assert_eq!(error.code(), "MACRO_ROLE_INVALID");

        let start_error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": unassigned_role_id.clone(),
                "requestJson": json!({"type": "start", "macroId": macro_id.clone()}).to_string()
            }))))
            .unwrap_err();
        let stop_error = runtime
            .block_on(core.invoke_async(command(json!({
                "type": "overlayRequest",
                "roleId": unassigned_role_id,
                "requestJson": json!({"type": "stop", "macroId": macro_id.clone()}).to_string()
            }))))
            .unwrap_err();
        crate::v1_case!("macro-7f0e0fdc25ad", {
            assert_eq!(start_error.code(), "MACRO_ROLE_INVALID");
            assert_eq!(stop_error.code(), "MACRO_ROLE_INVALID");
            assert!(core.macro_runtime.statuses().unwrap().is_empty());
        });

        let (opened, actions, _) = drive_async_command(
            Arc::clone(&core),
            command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"open\"}"
            })),
            None,
        );
        assert!(opened.is_ok());
        crate::v1_case!("overlay-af98ca2701ca", {
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::OverlayOpenMacroPage { role_id: current }
                    if current == &role_id
            )));
        });

        let (copied, actions, _) = drive_async_command(
            Arc::clone(&core),
            command(json!({
                "type": "overlayRequest",
                "roleId": role_id.clone(),
                "requestJson": "{\"type\":\"copy-coordinate\",\"xPercent\":12.5,\"xPx\":10,\"viewportHeightPx\":100,\"viewportWidthPx\":100,\"yPercent\":25,\"yPx\":20}"
            })),
            None,
        );
        assert!(copied.is_ok());
        crate::v1_case!("overlay-ff53e3a9a048", {
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::OverlayCopyCoordinate { coordinate }
                    if coordinate.x_px == 10 && coordinate.y_px == 20
            )));
        });
        core.shutdown();
    }

    #[test]
    fn startup_recovery_restores_or_discards_role_delete_quarantines_by_phase() {
        let directory = tempfile::tempdir().unwrap();
        let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();

        crate::role_browser_data::ensure(directory.path(), "restore-role").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "restore-role",
            "role-delete-restore",
        )
        .unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "role-delete-restore".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({ "roleId": "restore-role" }),
            })
            .unwrap();
        recover_operation_journals(&state, directory.path()).unwrap();
        assert!(directory.path().join("roles/restore-role/browser").exists());

        crate::role_browser_data::ensure(directory.path(), "discard-role").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "discard-role",
            "role-delete-discard",
        )
        .unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "role-delete-discard".to_owned(),
                kind: "role_delete_v1".to_owned(),
                phase: "committed".to_owned(),
                payload: json!({ "roleId": "discard-role" }),
            })
            .unwrap();
        recover_operation_journals(&state, directory.path()).unwrap();
        assert!(!directory.path().join("roles/discard-role").exists());
        assert!(state.operation_journals().unwrap().is_empty());
    }

    #[test]
    fn role_browser_data_clear_commits_only_after_the_native_session_is_cleared() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let (result, actions, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::RoleBrowserDataClear {
                role_id: role_id.clone(),
            },
            None,
        );

        crate::v1_case!("portable-profile-d7ae496f0b91", {
            let _: StateRoleRecord = serde_json::from_value(result.unwrap()).unwrap();
            assert!(browser.is_dir());
            assert!(!browser.join("session").exists());
            assert!(actions.iter().any(|action| matches!(
                action,
                CoreEffectAction::RoleBrowserDataClearSession {
                    role_id: effect_role_id,
                    ..
                } if effect_role_id == &role_id
            )));
            assert!(
                core.with_runtime(|runtime| runtime.state.operation_journals())
                    .unwrap()
                    .is_empty()
            );
        });
        core.shutdown();
    }

    #[test]
    fn role_browser_data_clear_rejects_unknown_roles_before_runtime_or_effect_work() {
        let (_directory, core) = core();
        let receiver = core.subscribe().unwrap();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(core.invoke_async(CoreCommand::RoleBrowserDataClear {
                role_id: "missing".to_owned(),
            }));

        crate::v1_case!("portable-profile-57a504e12e6a", {
            let error = result.unwrap_err();
            assert_eq!(error.code(), "ROLE_NOT_FOUND");
            assert_eq!(error.to_string(), "Role not found.");
            assert!(
                receiver
                    .try_iter()
                    .flatten()
                    .all(|event| { !matches!(event, CoreEvent::CoreEffects { .. }) })
            );
        });
        core.shutdown();
    }

    #[test]
    fn role_browser_data_clear_restores_the_login_directory_after_effect_failure() {
        let (directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let browser = directory
            .path()
            .join("roles")
            .join(&role_id)
            .join("browser");
        fs::write(browser.join("session"), b"signed-in").unwrap();

        let (result, _, _) = drive_async_command(
            Arc::clone(&core),
            CoreCommand::RoleBrowserDataClear {
                role_id: role_id.clone(),
            },
            Some("roleBrowserDataClearSession"),
        );

        assert_eq!(result.unwrap_err().code(), "DESKTOP_EFFECT_FAILED");
        assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
        assert!(
            core.with_runtime(|runtime| runtime.state.operation_journals())
                .unwrap()
                .is_empty()
        );
        let lease = core
            .browser_operations
            .acquire(BrowserOperationRequest {
                role_ids: vec![role_id],
                kind: "normal".to_owned(),
            })
            .unwrap();
        core.browser_operations.complete(&lease.id).unwrap();
        core.shutdown();
    }

    #[test]
    fn startup_recovery_restores_a_quarantined_browser_data_clear() {
        let directory = tempfile::tempdir().unwrap();
        let state = StateDatabaseWorker::start(directory.path().join("state.sqlite3")).unwrap();
        let browser = PathBuf::from(
            crate::role_browser_data::ensure(directory.path(), "recover-role")
                .unwrap()
                .browser_user_data_dir,
        );
        fs::write(browser.join("session"), b"signed-in").unwrap();
        crate::role_browser_data::quarantine(
            directory.path(),
            "recover-role",
            "browser-clear-recovery",
        )
        .unwrap();
        crate::role_browser_data::ensure(directory.path(), "recover-role").unwrap();
        fs::write(browser.join("new-session"), b"partial-clear").unwrap();
        state
            .put_operation_journal(OperationJournalRecord {
                id: "browser-clear-recovery".to_owned(),
                kind: "role_browser_data_clear_v1".to_owned(),
                phase: "quarantined".to_owned(),
                payload: json!({ "roleId": "recover-role", "hadDirectory": true }),
            })
            .unwrap();

        recover_operation_journals(&state, directory.path()).unwrap();

        assert_eq!(fs::read(browser.join("session")).unwrap(), b"signed-in");
        assert!(!browser.join("new-session").exists());
        assert!(state.operation_journals().unwrap().is_empty());
    }

    #[test]
    fn portable_apply_keeps_the_preview_when_an_affected_macro_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let macro_id = core
            .invoke(command(json!({
                "type":"macroCreate",
                "input":{
                    "name":"Auto heal",
                    "roleIds":[role_id],
                    "steps":[{"type":"delay","ms":1}]
                }
            })))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: true,
            game_windows: false,
            macros: true,
            preferences: false,
        };
        let mut portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        portable["macros"][0]["steps"][0]["ms"] = json!(2);
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/busy-portable.json".to_owned(),
            })
            .unwrap();
        let import_id = preview["importId"].as_str().unwrap().to_owned();
        core.macro_runtime
            .seed_running_status(&macro_id, &role_id)
            .unwrap();

        let busy = core.invoke(CoreCommand::PortableApply {
            import_id: import_id.clone(),
            selection: selection.clone(),
            resolutions: Vec::new(),
        });
        core.macro_runtime.stop_macro(&macro_id).unwrap();
        let retry = core.invoke(CoreCommand::PortableApply {
            import_id,
            selection,
            resolutions: Vec::new(),
        });

        crate::v1_case!("portable-profile-f3f377a06988", {
            assert_eq!(busy.unwrap_err().code(), "PORTABLE_IMPORT_BUSY");
            assert_eq!(retry.unwrap()["macroCount"], 1);
            assert_eq!(
                core.invoke(CoreCommand::MacroGet {
                    id: macro_id.clone()
                })
                .unwrap()["steps"][0]["ms"],
                2
            );
        });
        core.shutdown();
    }

    #[test]
    fn portable_game_window_import_is_blocked_while_a_role_is_running() {
        let (_directory, core) = core();
        let role_id = create_role(&core, &first_game_id(&core), 1);
        let game_window = core
            .invoke(command(json!({
                "type": "gameWindowCreate",
                "input": {
                    "name": "Import target",
                    "targetDisplay": { "id": 1 },
                    "placement": {
                        "normalBounds": { "x": 20, "y": 20, "width": 960, "height": 640 },
                        "savedWorkArea": { "x": 0, "y": 0, "width": 1440, "height": 900 },
                        "presentation": "normal"
                    }
                }
            })))
            .unwrap();
        let window_id = game_window["id"].as_str().unwrap().to_owned();
        let selection = crate::model::PortableDataSelectionRecord {
            games: true,
            roles: true,
            launch_workspaces: false,
            game_windows: true,
            macros: false,
            preferences: false,
        };
        let portable = core
            .invoke(CoreCommand::PortableExport {
                preferences: None,
                selection: selection.clone(),
            })
            .unwrap();
        let preview = core
            .invoke(CoreCommand::PortablePreview {
                raw_json: portable.to_string(),
                file_path: "/tmp/rion-game-window-running-import.json".to_owned(),
            })
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RegisterWindow {
            window_id: window_id.clone(),
        })
        .unwrap();
        let tab_id = core
            .invoke_browser_runtime(BrowserRuntimeCommand::CreateTab {
                tab_id: Some(uuid::Uuid::new_v4().to_string()),
                source_id: role_id.clone(),
                name: "Role 1".to_owned(),
                window_id,
                tab_type: "role".to_owned(),
                workspace_id: None,
                role_ids: vec![role_id.clone()],
            })
            .unwrap()
            .created_tab_id
            .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id: role_id.clone(),
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id.clone()),
            state: "launching".to_owned(),
            launched_at: None,
        })
        .unwrap();
        core.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
            role_id,
            runtime: "embedded".to_owned(),
            workspace_id: None,
            tab_id: Some(tab_id),
            state: "running".to_owned(),
            launched_at: Some(chrono::Utc::now().to_rfc3339()),
        })
        .unwrap();

        let error = core
            .invoke(CoreCommand::PortableApply {
                import_id: preview["importId"].as_str().unwrap().to_owned(),
                selection,
                resolutions: Vec::new(),
            })
            .unwrap_err();

        assert_eq!(error.code(), "PORTABLE_IMPORT_GAME_WINDOWS_RUNNING");
        core.shutdown();
    }
